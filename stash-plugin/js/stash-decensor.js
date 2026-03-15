(function () {
  'use strict';

  const PLUGIN_ID = 'stash-decensor';
  const { StashDecensorStash: Stash, StashDecensorApi: Api } = window;

  const api = window.PluginApi;
  const React = api.React;
  const { Button } = api.libraries.Bootstrap;
  const csLib = window.csLib;

  // Magic wand / restore icon
  const decensorIconSvg = `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 4V2M15 16V14M8 9H10M20 9H22M17.8 11.8L19 13M17.8 6.2L19 5M12.2 11.8L11 13M12.2 6.2L11 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15 9C15 10.6569 13.6569 12 12 12C10.3431 12 9 10.6569 9 9C9 7.34315 10.3431 6 12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M6 21L3 18L14 7L17 10L6 21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

  let config = {
    decensorApiUrl: 'http://localhost:7030',
    censoredTagId: '',
    decensoredTagId: '',
  };

  let activeJobs = new Map();

  async function loadConfig() {
    try {
      const pluginConfig = await Stash.getPluginConfig(PLUGIN_ID);
      if (pluginConfig.decensorApiUrl) {
        config.decensorApiUrl = pluginConfig.decensorApiUrl;
        Api.setApiUrl(config.decensorApiUrl);
      }
      if (pluginConfig.censoredTagId) {
        config.censoredTagId = pluginConfig.censoredTagId;
      }
      if (pluginConfig.decensoredTagId) {
        config.decensoredTagId = pluginConfig.decensoredTagId;
      }
    } catch (e) {
      console.warn('[Decensor] Failed to load plugin config:', e);
    }
  }

  function showToast(message, type = 'success') {
    const toastTemplate = {
      success: `<div class="toast fade show success" role="alert"><div class="d-flex"><div class="toast-body flex-grow-1">`,
      error: `<div class="toast fade show danger" role="alert"><div class="d-flex"><div class="toast-body flex-grow-1">`,
      bottom: `</div><button type="button" class="close ml-2 mb-1 mr-2" data-dismiss="toast" aria-label="Close"><span aria-hidden="true">&times;</span></button></div></div>`,
    };

    const template = type === 'error' ? toastTemplate.error : toastTemplate.success;
    const $toast = $(template + message + toastTemplate.bottom);
    const rmToast = () => {
      const hasSiblings = $toast.siblings().length > 0;
      $toast.remove();
      if (!hasSiblings) {
        $('.toast-container').addClass('hidden');
      }
    };

    $toast.find('button.close').click(rmToast);
    $('.toast-container').append($toast).removeClass('hidden');
    setTimeout(rmToast, 5000);
  }

  function getSceneIdFromUrl() {
    const match = window.location.pathname.match(/\/scenes\/(\d+)/);
    return match ? match[1] : null;
  }

  function sceneHasCensoredTag(scene) {
    if (!config.censoredTagId || !scene.tags) {
      return false;
    }
    return scene.tags.some(tag => tag.id === config.censoredTagId);
  }

  async function handleDecensorClick(sceneId) {
    if (activeJobs.has(sceneId)) {
      showToast('A decensor job is already running for this scene', 'error');
      return;
    }

    try {
      const scene = await Stash.getScene(sceneId);
      if (!scene || !scene.files || scene.files.length === 0) {
        showToast('Scene has no video files', 'error');
        return;
      }

      const videoPath = scene.files[0].path;
      showToast(`Starting decensor job for: ${videoPath.split('/').pop()}`);

      const job = await Api.submitJob(videoPath, sceneId);
      activeJobs.set(sceneId, job.job_id);

      showToast(`Job queued: ${job.job_id.slice(0, 8)}...`);

      processJob(sceneId, job.job_id, scene);

    } catch (e) {
      console.error('[Decensor] Error starting job:', e);
      showToast(`Failed to start job: ${e.message}`, 'error');
    }
  }

  async function processJob(sceneId, jobId, originalScene) {
    try {
      const completedJob = await Api.pollJobUntilComplete(jobId, {
        pollInterval: 2000,
        maxWaitMs: 7200000,
        onProgress: (job) => {
          if (job.status === 'processing') {
            const percent = Math.round(job.progress * 100);
            updateButtonProgress(sceneId, percent);
          }
        },
      });

      showToast('Decensoring completed. Scanning output file...');

      if (completedJob.result && completedJob.result.output_path) {
        await handleJobCompletion(sceneId, originalScene, completedJob.result.output_path);
      }

    } catch (e) {
      console.error('[Decensor] Job failed:', e);
      showToast(`Decensor job failed: ${e.message}`, 'error');
    } finally {
      activeJobs.delete(sceneId);
      resetButton(sceneId);
    }
  }

  async function handleJobCompletion(sceneId, originalScene, outputPath) {
    try {
      const scanJobId = await Stash.scanPath(outputPath);
      showToast('Scanning decensored file...');

      await Stash.waitForJob(scanJobId, 120000);

      await new Promise(resolve => setTimeout(resolve, 2000));

      const newScene = await Stash.findSceneByPath(outputPath);

      if (newScene && newScene.id !== sceneId) {
        showToast('Merging scenes...');

        await Stash.mergeScenes([newScene.id], sceneId);

        showToast('Scenes merged successfully');
      }

      if (config.decensoredTagId) {
        const currentTags = originalScene.tags.map(t => t.id);
        const newTags = currentTags.filter(id => id !== config.censoredTagId);

        if (!newTags.includes(config.decensoredTagId)) {
          newTags.push(config.decensoredTagId);
        }

        await Stash.updateSceneTags(sceneId, newTags);
        showToast('Tags updated');
      }

      showToast('Decensoring complete!');

    } catch (e) {
      console.error('[Decensor] Post-processing error:', e);
      showToast(`Post-processing error: ${e.message}`, 'error');
    }
  }

  function updateButtonProgress(sceneId, percent) {
    const button = document.querySelector(`[data-decensor-scene="${sceneId}"]`);
    if (button) {
      button.title = `Decensoring... ${percent}%`;
      button.style.opacity = '0.6';
      button.style.pointerEvents = 'none';
    }
  }

  function resetButton(sceneId) {
    const button = document.querySelector(`[data-decensor-scene="${sceneId}"]`);
    if (button) {
      button.title = 'Decensor';
      button.style.opacity = '1';
      button.style.pointerEvents = 'auto';
    }
  }

  const DecensorButton = ({ sceneId }) => {
    return React.createElement(Button, {
      className: 'minimal btn btn-secondary',
      id: 'decensor-btn',
      title: 'Decensor',
      'data-decensor-scene': sceneId,
      onClick: () => handleDecensorClick(sceneId),
      dangerouslySetInnerHTML: { __html: decensorIconSvg },
    });
  };

  async function injectButton() {
    const sceneId = getSceneIdFromUrl();
    if (!sceneId) return;

    if (document.querySelector(`[data-decensor-scene="${sceneId}"]`)) {
      return;
    }

    try {
      const scene = await Stash.getScene(sceneId);
      if (!scene) return;

      const showButton = !config.censoredTagId || sceneHasCensoredTag(scene);
      if (!showButton) return;

      const toolbar = document.querySelector('.scene-toolbar .btn-group');
      if (toolbar) {
        const container = document.createElement('span');
        container.className = 'decensor-button';
        toolbar.appendChild(container);

        api.ReactDOM.render(
          React.createElement(DecensorButton, { sceneId }),
          container
        );
      }

    } catch (e) {
      console.error('[Decensor] Error injecting button:', e);
    }
  }

  function cleanUI() {
    const existingButtons = document.querySelectorAll('.decensor-button');
    existingButtons.forEach((button) => button.remove());
  }

  loadConfig();

  let debounceTimer = null;
  csLib.PathElementListener('/scenes/', '.scene-toolbar', function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      cleanUI();
      injectButton();
    }, 300);
  });
})();
