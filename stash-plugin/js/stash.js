(function () {
  'use strict';

  const gqlEndpoint = '/graphql';

  async function gqlQuery(query, variables = {}) {
    const response = await fetch(gqlEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.status}`);
    }

    const result = await response.json();
    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data;
  }

  async function getScene(sceneId) {
    const query = `
      query FindScene($id: ID) {
        findScene(id: $id) {
          id
          title
          files {
            path
          }
          tags {
            id
            name
          }
        }
      }
    `;
    const data = await gqlQuery(query, { id: sceneId });
    return data.findScene;
  }

  async function scanPath(path) {
    const query = `
      mutation MetadataScan($input: ScanMetadataInput!) {
        metadataScan(input: $input)
      }
    `;
    const data = await gqlQuery(query, { input: { paths: [path] } });
    return data.metadataScan;
  }

  async function findJob(jobId) {
    const query = `
      query FindJob($input: FindJobInput!) {
        findJob(input: $input) {
          id
          status
          progress
          description
          error
        }
      }
    `;
    const data = await gqlQuery(query, { input: { id: jobId } });
    return data.findJob;
  }

  async function findSceneByPath(path) {
    const query = `
      query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          scenes {
            id
            title
            files {
              path
            }
            tags {
              id
              name
            }
          }
        }
      }
    `;
    const data = await gqlQuery(query, {
      filter: { per_page: 1 },
      scene_filter: {
        path: { value: path, modifier: 'EQUALS' }
      }
    });
    const scenes = data.findScenes?.scenes || [];
    return scenes[0] || null;
  }

  async function mergeScenes(sourceIds, destinationId) {
    const query = `
      mutation SceneMerge($input: SceneMergeInput!) {
        sceneMerge(input: $input) {
          id
        }
      }
    `;
    const data = await gqlQuery(query, {
      input: {
        source: sourceIds,
        destination: destinationId,
        values: {
          play_history: true,
          o_history: true
        }
      }
    });
    return data.sceneMerge;
  }

  async function updateSceneTags(sceneId, tagIds) {
    const query = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
          tags {
            id
            name
          }
        }
      }
    `;
    const data = await gqlQuery(query, {
      input: {
        id: sceneId,
        tag_ids: tagIds
      }
    });
    return data.sceneUpdate;
  }

  async function getPluginConfig(pluginId) {
    const query = `
      query Configuration {
        configuration {
          plugins
        }
      }
    `;
    const data = await gqlQuery(query);
    const plugins = data.configuration?.plugins || {};
    return plugins[pluginId] || {};
  }

  async function waitForJob(jobId, maxWaitMs = 300000, pollInterval = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const job = await findJob(jobId);
      if (!job) {
        throw new Error('Job not found');
      }
      if (job.status === 'FINISHED') {
        return job;
      }
      if (job.status === 'FAILED' || job.status === 'CANCELLED') {
        throw new Error(`Job ${job.status}: ${job.error || 'Unknown error'}`);
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
    throw new Error('Job timed out');
  }

  window.StashDecensorStash = {
    gqlQuery,
    getScene,
    scanPath,
    findJob,
    findSceneByPath,
    mergeScenes,
    updateSceneTags,
    getPluginConfig,
    waitForJob,
  };
})();
