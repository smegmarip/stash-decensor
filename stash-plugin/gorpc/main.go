package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	graphql "github.com/hasura/go-graphql-client"
	"github.com/stashapp/stash/pkg/plugin/common"
	"github.com/stashapp/stash/pkg/plugin/common/log"
	"github.com/stashapp/stash/pkg/plugin/util"
)

func main() {
	err := common.ServePlugin(&decensorAPI{})
	if err != nil {
		panic(err)
	}
}

type decensorAPI struct {
	stopping         bool
	serverConnection common.StashServerConnection
	graphqlClient    *graphql.Client
}

// JobRequest represents the request to submit a decensor job
type JobRequest struct {
	VideoPath      string `json:"video_path"`
	SceneID        string `json:"scene_id"`
	EncodingPreset string `json:"encoding_preset,omitempty"`
	MaxClipLength  int    `json:"max_clip_length,omitempty"`
}

// JobResponse represents the response from submitting a job
type JobResponse struct {
	JobID    string  `json:"job_id"`
	Status   string  `json:"status"`
	Progress float64 `json:"progress"`
	Error    *string `json:"error"`
	Result   *Result `json:"result"`
}

// Result represents the job result
type Result struct {
	OutputPath            string  `json:"output_path"`
	ProcessingTimeSeconds float64 `json:"processing_time_seconds"`
}

// resolveServiceURL resolves the service URL with proper DNS lookup
func resolveServiceURL(configuredURL string) string {
	const defaultContainerName = "decensor-api"
	const defaultPort = "5030"
	const defaultScheme = "http"
	var hardcodedFallback = fmt.Sprintf("%s://%s:%s", defaultScheme, defaultContainerName, defaultPort)

	if configuredURL == "" {
		configuredURL = hardcodedFallback
	}

	parsedURL, err := url.Parse(configuredURL)
	if err != nil {
		log.Warnf("Failed to parse service URL '%s': %v, using fallback", configuredURL, err)
		return hardcodedFallback
	}

	hostname := parsedURL.Hostname()
	port := parsedURL.Port()
	scheme := parsedURL.Scheme

	if scheme == "" {
		scheme = defaultScheme
	}

	if port == "" {
		port = defaultPort
	}

	if hostname == "localhost" || hostname == "127.0.0.1" {
		resolvedURL := fmt.Sprintf("%s://%s:%s", scheme, hostname, port)
		log.Infof("Using localhost service URL: %s", resolvedURL)
		return resolvedURL
	}

	if net.ParseIP(hostname) != nil {
		resolvedURL := fmt.Sprintf("%s://%s:%s", scheme, hostname, port)
		log.Infof("Using IP-based service URL: %s", resolvedURL)
		return resolvedURL
	}

	log.Infof("Resolving hostname via DNS: %s", hostname)
	addrs, err := net.LookupIP(hostname)
	if err != nil {
		log.Warnf("DNS lookup failed for '%s': %v, using hostname as-is", hostname, err)
		resolvedURL := fmt.Sprintf("%s://%s:%s", scheme, hostname, port)
		return resolvedURL
	}

	if len(addrs) == 0 {
		log.Warnf("No IP addresses found for hostname '%s', using hostname as-is", hostname)
		resolvedURL := fmt.Sprintf("%s://%s:%s", scheme, hostname, port)
		return resolvedURL
	}

	resolvedIP := addrs[0].String()
	resolvedURL := fmt.Sprintf("%s://%s:%s", scheme, resolvedIP, port)
	log.Infof("Resolved '%s' to %s", hostname, resolvedURL)
	return resolvedURL
}

func (a *decensorAPI) Stop(input struct{}, output *bool) error {
	log.Info("Stopping decensor plugin...")
	a.stopping = true
	*output = true
	return nil
}

// Run handles the RPC task execution
func (a *decensorAPI) Run(input common.PluginInput, output *common.PluginOutput) error {
	a.serverConnection = input.ServerConnection
	a.graphqlClient = util.NewClient(input.ServerConnection)

	mode := input.Args.String("mode")

	var err error
	var outputStr string = "Unknown mode. Plugin did not run."

	switch mode {
	case "decensor":
		outputStr, err = a.decensorScene(input)
	case "merge":
		err = a.mergeDecensoredScene(input)
		outputStr = "Scenes merged successfully"
	default:
		err = fmt.Errorf("unknown mode: %s", mode)
	}

	if err != nil {
		errStr := err.Error()
		*output = common.PluginOutput{
			Error: &errStr,
		}
		return nil
	}

	*output = common.PluginOutput{
		Output: &outputStr,
	}

	return nil
}

// decensorScene submits a decensor job, polls for completion, then queues scan and merge jobs
func (a *decensorAPI) decensorScene(input common.PluginInput) (string, error) {
	sceneID := input.Args.String("scene_id")
	videoPath := input.Args.String("video_path")
	serviceURL := input.Args.String("service_url")
	censoredTagID := input.Args.String("censored_tag_id")
	decensoredTagID := input.Args.String("decensored_tag_id")

	if sceneID == "" {
		return "", fmt.Errorf("scene_id is required")
	}
	if videoPath == "" {
		return "", fmt.Errorf("video_path is required")
	}

	serviceURL = resolveServiceURL(serviceURL)

	log.Infof("Starting decensor job for scene %s: %s", sceneID, videoPath)

	// Submit job to decensor API
	jobID, err := a.submitJob(serviceURL, videoPath, sceneID)
	if err != nil {
		return "", fmt.Errorf("failed to submit job: %w", err)
	}

	log.Infof("Decensor job submitted: %s", jobID)

	// Poll for completion
	result, err := a.pollJobStatus(serviceURL, jobID)
	if err != nil {
		return "", err
	}

	log.Infof("Decensor job completed, output: %s", result.OutputPath)

	// Download captions from Stash API and save for new file (before scan so they get picked up)
	if _, err := a.copyCaptions(sceneID, result.OutputPath); err != nil {
		log.Warnf("Failed to copy captions: %v", err)
	}

	// Queue metadata scan on directory to pick up video and caption files
	scanDir := filepath.Dir(result.OutputPath)
	scanJobID, err := a.triggerMetadataScan(scanDir)
	if err != nil {
		return "", fmt.Errorf("failed to trigger scan: %w", err)
	}
	log.Infof("Queued metadata scan job: %s", scanJobID)

	// Queue merge task (runs after scan completes due to single worker queue)
	mergeJobID, err := a.triggerMergeTask(sceneID, result.OutputPath, censoredTagID, decensoredTagID)
	if err != nil {
		return "", fmt.Errorf("failed to trigger merge: %w", err)
	}
	log.Infof("Queued merge job: %s", mergeJobID)

	return result.OutputPath, nil
}

// mergeDecensoredScene finds the new scene by path and merges it into the original
func (a *decensorAPI) mergeDecensoredScene(input common.PluginInput) error {
	sceneID := input.Args.String("scene_id")
	outputPath := input.Args.String("output_path")
	censoredTagID := input.Args.String("censored_tag_id")
	decensoredTagID := input.Args.String("decensored_tag_id")

	if sceneID == "" {
		return fmt.Errorf("scene_id is required")
	}
	if outputPath == "" {
		return fmt.Errorf("output_path is required")
	}

	log.Infof("Merging decensored scene for original %s, path: %s", sceneID, outputPath)

	// Find the new scene and its file ID
	newSceneID, newFileID, err := a.findSceneAndFileByPath(outputPath)
	if err != nil {
		return fmt.Errorf("failed to find new scene: %w", err)
	}

	if newSceneID == "" {
		return fmt.Errorf("no scene found for path: %s", outputPath)
	}

	if newSceneID == sceneID {
		log.Infof("Scene already has the decensored file, skipping merge")
	} else {
		// Merge scenes
		log.Infof("Merging scene %s into %s", newSceneID, sceneID)
		if err := a.mergeScenes([]string{newSceneID}, sceneID); err != nil {
			return fmt.Errorf("failed to merge scenes: %w", err)
		}
		log.Infof("Scenes merged successfully")

		// Set the decensored file as primary
		if newFileID != "" {
			if err := a.setPrimaryFile(sceneID, newFileID); err != nil {
				log.Warnf("Failed to set primary file: %v", err)
			} else {
				log.Infof("Set decensored file as primary: %s", newFileID)
			}
		}

		// Re-scan the directory to associate caption with merged scene
		scanDir := filepath.Dir(outputPath)
		if _, err := a.triggerMetadataScan(scanDir); err != nil {
			log.Warnf("Failed to trigger post-merge scan: %v", err)
		} else {
			log.Infof("Triggered post-merge scan for caption association")
		}

		// Generate metadata for the new file (sprites, previews, etc.)
		if err := a.triggerMetadataGenerate(sceneID); err != nil {
			log.Warnf("Failed to trigger metadata generation: %v", err)
		} else {
			log.Infof("Triggered metadata generation for scene: %s", sceneID)
		}
	}

	// Update tags
	if decensoredTagID != "" {
		if err := a.updateSceneTags(sceneID, censoredTagID, decensoredTagID); err != nil {
			log.Warnf("Failed to update tags: %v", err)
		}
	}

	// Log result for JS to poll
	resultJSON := fmt.Sprintf(`{"success":true,"scene_id":"%s","output_path":"%s"}`, sceneID, outputPath)
	log.Infof("mergeResult=%s", resultJSON)

	return nil
}

func (a *decensorAPI) triggerMetadataScan(path string) (string, error) {
	ctx := context.Background()

	var mutation struct {
		MetadataScan graphql.String `graphql:"metadataScan(input: $input)"`
	}

	type ScanMetadataInput struct {
		Paths []string `json:"paths"`
	}

	variables := map[string]interface{}{
		"input": ScanMetadataInput{Paths: []string{path}},
	}

	err := a.graphqlClient.Mutate(ctx, &mutation, variables)
	if err != nil {
		return "", fmt.Errorf("metadata scan mutation failed: %w", err)
	}

	return string(mutation.MetadataScan), nil
}

func (a *decensorAPI) triggerMetadataGenerate(sceneID string) error {
	ctx := context.Background()

	var mutation struct {
		MetadataGenerate graphql.String `graphql:"metadataGenerate(input: $input)"`
	}

	type GenerateMetadataInput struct {
		SceneIDs      []string `json:"sceneIDs"`
		Sprites       bool     `json:"sprites"`
		Previews      bool     `json:"previews"`
		ImagePreviews bool     `json:"imagePreviews"`
		Markers       bool     `json:"markers"`
		Transcodes    bool     `json:"transcodes"`
		Covers        bool     `json:"covers"`
		Overwrite     bool     `json:"overwrite"`
	}

	variables := map[string]interface{}{
		"input": GenerateMetadataInput{
			SceneIDs:      []string{sceneID},
			Sprites:       true,
			Previews:      true,
			ImagePreviews: true,
			Markers:       false,
			Transcodes:    true,
			Covers:        true,
			Overwrite:     false,
		},
	}

	err := a.graphqlClient.Mutate(ctx, &mutation, variables)
	if err != nil {
		return fmt.Errorf("metadata generate mutation failed: %w", err)
	}

	log.Infof("Metadata generation queued: %s", mutation.MetadataGenerate)
	return nil
}

// Map represents a GraphQL Map scalar
type Map map[string]interface{}

func (a *decensorAPI) triggerMergeTask(sceneID, outputPath, censoredTagID, decensoredTagID string) (string, error) {
	ctx := context.Background()

	// Use args_map (newer approach) instead of deprecated args parameter
	var mutation struct {
		RunPluginTask graphql.ID `graphql:"runPluginTask(plugin_id: $pid, task_name: $tn, args_map: $am)"`
	}

	argsMap := &Map{
		"mode":              "merge",
		"scene_id":          sceneID,
		"output_path":       outputPath,
		"censored_tag_id":   censoredTagID,
		"decensored_tag_id": decensoredTagID,
	}

	variables := map[string]interface{}{
		"pid": graphql.ID("stash-decensor"),
		"tn":  graphql.String("Merge Decensored Scene"),
		"am":  argsMap,
	}

	err := a.graphqlClient.Mutate(ctx, &mutation, variables)
	if err != nil {
		return "", fmt.Errorf("run plugin task mutation failed: %w", err)
	}

	return string(mutation.RunPluginTask), nil
}

func (a *decensorAPI) submitJob(serviceURL, videoPath, sceneID string) (string, error) {
	url := fmt.Sprintf("%s/decensor/jobs", serviceURL)

	req := JobRequest{
		VideoPath: videoPath,
		SceneID:   sceneID,
	}

	reqBody, err := json.Marshal(req)
	if err != nil {
		return "", err
	}

	resp, err := http.Post(url, "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var jobResp JobResponse
	if err := json.NewDecoder(resp.Body).Decode(&jobResp); err != nil {
		return "", err
	}

	return jobResp.JobID, nil
}

func (a *decensorAPI) pollJobStatus(serviceURL, jobID string) (*Result, error) {
	url := fmt.Sprintf("%s/decensor/jobs/%s/status", serviceURL, jobID)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		if a.stopping {
			return nil, fmt.Errorf("task interrupted")
		}

		select {
		case <-ticker.C:
			resp, err := http.Get(url)
			if err != nil {
				return nil, fmt.Errorf("failed to get job status: %w", err)
			}

			var status JobResponse
			if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
				resp.Body.Close()
				return nil, fmt.Errorf("failed to decode status: %w", err)
			}
			resp.Body.Close()

			log.Progress(status.Progress)
			log.Tracef("Job status: %s (%.0f%%)", status.Status, status.Progress*100)

			switch status.Status {
			case "completed":
				if status.Result == nil {
					return nil, fmt.Errorf("job completed but no result")
				}
				return status.Result, nil

			case "failed", "cancelled":
				if status.Error != nil {
					return nil, fmt.Errorf("job %s: %s", status.Status, *status.Error)
				}
				return nil, fmt.Errorf("job %s", status.Status)

			case "queued", "processing":
				continue

			default:
				return nil, fmt.Errorf("unknown job status: %s", status.Status)
			}
		}
	}
}

func (a *decensorAPI) findSceneAndFileByPath(path string) (string, string, error) {
	ctx := context.Background()

	var query struct {
		FindScenes struct {
			Scenes []struct {
				ID    graphql.ID `graphql:"id"`
				Files []struct {
					ID   graphql.ID     `graphql:"id"`
					Path graphql.String `graphql:"path"`
				} `graphql:"files"`
			} `graphql:"scenes"`
		} `graphql:"findScenes(filter: $filter, scene_filter: $scene_filter)"`
	}

	type FindFilterType struct {
		PerPage *graphql.Int `json:"per_page"`
	}

	type StringCriterionInput struct {
		Value    graphql.String `json:"value"`
		Modifier graphql.String `json:"modifier"`
	}

	type SceneFilterType struct {
		Path *StringCriterionInput `json:"path"`
	}

	// Use EQUALS for exact path matching
	perPage := graphql.Int(1)
	variables := map[string]interface{}{
		"filter": &FindFilterType{PerPage: &perPage},
		"scene_filter": &SceneFilterType{
			Path: &StringCriterionInput{
				Value:    graphql.String(path),
				Modifier: "EQUALS",
			},
		},
	}

	err := a.graphqlClient.Query(ctx, &query, variables)
	if err != nil {
		return "", "", fmt.Errorf("find scenes query failed: %w", err)
	}

	// Return exact match if found
	if len(query.FindScenes.Scenes) > 0 {
		scene := query.FindScenes.Scenes[0]
		for _, file := range scene.Files {
			if string(file.Path) == path {
				log.Infof("Found scene %s with file %s for path: %s", scene.ID, file.ID, path)
				return string(scene.ID), string(file.ID), nil
			}
		}
		// Scene matched but file path doesn't - shouldn't happen with EQUALS
		log.Warnf("Scene %s matched but no file has exact path: %s", scene.ID, path)
	}

	log.Warnf("No scene found for path: %s", path)
	return "", "", nil
}

func (a *decensorAPI) setPrimaryFile(sceneID, fileID string) error {
	ctx := context.Background()

	var mutation struct {
		SceneUpdate struct {
			ID graphql.ID `graphql:"id"`
		} `graphql:"sceneUpdate(input: $input)"`
	}

	type SceneUpdateInput struct {
		ID            graphql.ID `json:"id"`
		PrimaryFileID graphql.ID `json:"primary_file_id"`
	}

	variables := map[string]interface{}{
		"input": SceneUpdateInput{
			ID:            graphql.ID(sceneID),
			PrimaryFileID: graphql.ID(fileID),
		},
	}

	err := a.graphqlClient.Mutate(ctx, &mutation, variables)
	if err != nil {
		return fmt.Errorf("set primary file mutation failed: %w", err)
	}

	return nil
}

func (a *decensorAPI) mergeScenes(sourceIDs []string, destID string) error {
	ctx := context.Background()

	var mutation struct {
		SceneMerge struct {
			ID graphql.ID `graphql:"id"`
		} `graphql:"sceneMerge(input: $input)"`
	}

	sourceGraphqlIDs := make([]graphql.ID, len(sourceIDs))
	for i, id := range sourceIDs {
		sourceGraphqlIDs[i] = graphql.ID(id)
	}

	type SceneMergeInput struct {
		Source      []graphql.ID `json:"source"`
		Destination graphql.ID   `json:"destination"`
	}

	variables := map[string]interface{}{
		"input": SceneMergeInput{
			Source:      sourceGraphqlIDs,
			Destination: graphql.ID(destID),
		},
	}

	err := a.graphqlClient.Mutate(ctx, &mutation, variables)
	if err != nil {
		return fmt.Errorf("scene merge mutation failed: %w", err)
	}

	log.Infof("Scenes merged successfully")
	return nil
}

func (a *decensorAPI) updateSceneTags(sceneID, censoredTagID, decensoredTagID string) error {
	ctx := context.Background()

	// First get current tags
	var query struct {
		FindScene struct {
			Tags []struct {
				ID graphql.ID `graphql:"id"`
			} `graphql:"tags"`
		} `graphql:"findScene(id: $id)"`
	}

	queryVars := map[string]interface{}{
		"id": graphql.ID(sceneID),
	}

	err := a.graphqlClient.Query(ctx, &query, queryVars)
	if err != nil {
		return fmt.Errorf("failed to get scene tags: %w", err)
	}

	// Build new tag list
	newTagIDs := []graphql.ID{}
	for _, tag := range query.FindScene.Tags {
		if string(tag.ID) != censoredTagID {
			newTagIDs = append(newTagIDs, tag.ID)
		}
	}

	// Add decensored tag if not already present
	hasDecensoredTag := false
	for _, id := range newTagIDs {
		if string(id) == decensoredTagID {
			hasDecensoredTag = true
			break
		}
	}
	if !hasDecensoredTag {
		newTagIDs = append(newTagIDs, graphql.ID(decensoredTagID))
	}

	// Update scene
	var mutation struct {
		SceneUpdate struct {
			ID graphql.ID `graphql:"id"`
		} `graphql:"sceneUpdate(input: $input)"`
	}

	type SceneUpdateInput struct {
		ID     graphql.ID   `json:"id"`
		TagIDs []graphql.ID `json:"tag_ids"`
	}

	mutationVars := map[string]interface{}{
		"input": SceneUpdateInput{
			ID:     graphql.ID(sceneID),
			TagIDs: newTagIDs,
		},
	}

	err = a.graphqlClient.Mutate(ctx, &mutation, mutationVars)
	if err != nil {
		return fmt.Errorf("scene update mutation failed: %w", err)
	}

	log.Infof("Scene tags updated")
	return nil
}

// copyCaptions downloads captions from the Stash API and saves them for the new video file
// Returns the list of caption file paths that were created
func (a *decensorAPI) copyCaptions(sceneID, newVideoPath string) ([]string, error) {
	ctx := context.Background()

	var query struct {
		FindScene struct {
			Captions []struct {
				LanguageCode graphql.String `graphql:"language_code"`
				CaptionType  graphql.String `graphql:"caption_type"`
			} `graphql:"captions"`
			Paths struct {
				Caption graphql.String `graphql:"caption"`
			} `graphql:"paths"`
		} `graphql:"findScene(id: $id)"`
	}

	variables := map[string]interface{}{
		"id": graphql.ID(sceneID),
	}

	err := a.graphqlClient.Query(ctx, &query, variables)
	if err != nil {
		return nil, fmt.Errorf("find scene query failed: %w", err)
	}

	if len(query.FindScene.Captions) == 0 {
		log.Infof("No captions found for scene %s", sceneID)
		return nil, nil
	}

	captionBaseURL := string(query.FindScene.Paths.Caption)
	if captionBaseURL == "" {
		log.Infof("No caption URL for scene %s", sceneID)
		return nil, nil
	}

	newExt := filepath.Ext(newVideoPath)
	newBase := strings.TrimSuffix(newVideoPath, newExt)

	var captionFiles []string

	for _, caption := range query.FindScene.Captions {
		langCode := string(caption.LanguageCode)
		captionType := string(caption.CaptionType)

		// Download from Stash API: paths.caption?lang=XX&type=srt
		downloadURL := fmt.Sprintf("%s?lang=%s&type=%s", captionBaseURL, langCode, captionType)

		// Build destination filename
		var dstPath string
		if langCode == "" || langCode == "00" {
			dstPath = newBase + "." + captionType
		} else {
			dstPath = fmt.Sprintf("%s.%s.%s", newBase, langCode, captionType)
		}

		// Download and save
		if err := downloadFile(downloadURL, dstPath); err != nil {
			log.Warnf("Failed to download caption %s: %v", downloadURL, err)
			continue
		}

		log.Infof("Downloaded caption: %s -> %s", downloadURL, dstPath)
		captionFiles = append(captionFiles, dstPath)
	}

	return captionFiles, nil
}

// downloadFile downloads a file from a URL and saves it to disk
func downloadFile(fileURL, destPath string) error {
	resp, err := http.Get(fileURL)
	if err != nil {
		return fmt.Errorf("failed to download: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	outFile, err := os.Create(destPath)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	defer outFile.Close()

	_, err = io.Copy(outFile, resp.Body)
	return err
}
