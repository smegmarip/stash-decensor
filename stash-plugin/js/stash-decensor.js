(function () {
  'use strict';

  const PLUGIN_ID = 'stash-decensor';
  const { StashDecensorStash: Stash, StashDecensorApi: Api } = window;

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

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 4px;
      color: white;
      font-size: 14px;
      z-index: 10000;
      max-width: 400px;
      word-wrap: break-word;
      animation: slideIn 0.3s ease-out;
    `;

    const colors = {
      info: '#3498db',
      success: '#27ae60',
      error: '#e74c3c',
      warning: '#f39c12',
    };
    toast.style.backgroundColor = colors[type] || colors.info;

    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
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
      showToast('A decensor job is already running for this scene', 'warning');
      return;
    }

    try {
      const scene = await Stash.getScene(sceneId);
      if (!scene || !scene.files || scene.files.length === 0) {
        showToast('Scene has no video files', 'error');
        return;
      }

      const videoPath = scene.files[0].path;
      showToast(`Starting decensor job for: ${videoPath.split('/').pop()}`, 'info');

      const job = await Api.submitJob(videoPath, sceneId);
      activeJobs.set(sceneId, job.job_id);

      showToast(`Job queued: ${job.job_id.slice(0, 8)}...`, 'success');

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

      showToast('Decensoring completed. Scanning output file...', 'success');

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
      showToast('Scanning decensored file...', 'info');

      await Stash.waitForJob(scanJobId, 120000);

      await new Promise(resolve => setTimeout(resolve, 2000));

      const newScene = await Stash.findSceneByPath(outputPath);

      if (newScene && newScene.id !== sceneId) {
        showToast('Merging scenes...', 'info');

        await Stash.mergeScenes([newScene.id], sceneId);

        showToast('Scenes merged successfully', 'success');
      }

      if (config.decensoredTagId) {
        const currentTags = originalScene.tags.map(t => t.id);
        const newTags = currentTags.filter(id => id !== config.censoredTagId);

        if (!newTags.includes(config.decensoredTagId)) {
          newTags.push(config.decensoredTagId);
        }

        await Stash.updateSceneTags(sceneId, newTags);
        showToast('Tags updated', 'success');
      }

      showToast('Decensoring complete!', 'success');

    } catch (e) {
      console.error('[Decensor] Post-processing error:', e);
      showToast(`Post-processing error: ${e.message}`, 'warning');
    }
  }

  function updateButtonProgress(sceneId, percent) {
    const button = document.querySelector(`[data-decensor-scene="${sceneId}"]`);
    if (button) {
      button.textContent = `Decensoring... ${percent}%`;
      button.disabled = true;
    }
  }

  function resetButton(sceneId) {
    const button = document.querySelector(`[data-decensor-scene="${sceneId}"]`);
    if (button) {
      button.textContent = 'Decensor';
      button.disabled = false;
    }
  }

  function createDecensorButton(sceneId) {
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = 'Decensor';
    button.setAttribute('data-decensor-scene', sceneId);
    button.style.cssText = 'margin-left: 8px;';

    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleDecensorClick(sceneId);
    });

    return button;
  }

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

      const toolbar = document.querySelector('.scene-toolbar') ||
                      document.querySelector('.detail-header-buttons') ||
                      document.querySelector('.scene-tabs');

      if (toolbar) {
        const button = createDecensorButton(sceneId);
        toolbar.appendChild(button);
      }

    } catch (e) {
      console.error('[Decensor] Error injecting button:', e);
    }
  }

  function init() {
    loadConfig();

    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes fadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    document.head.appendChild(style);

    let lastUrl = '';
    const observer = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        setTimeout(injectButton, 500);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    setTimeout(injectButton, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
