(function () {
  'use strict';

  const PLUGIN_ID = 'stash-decensor';
  const csLib = window.csLib;
  const { getPluginConfig, runPluginTask, getJobStatus, getScene } = window.stashFunctions;

  const api = window.PluginApi;
  const React = api.React;
  const { Button } = api.libraries.Bootstrap;

  /**
   * Waits for a Stash job to finish.
   * @param {string} jobId - The job ID.
   * @param {function} onProgress - Optional progress callback.
   * @returns {Promise<boolean>} - Resolves true on success, rejects on failure.
   */
  async function awaitJobFinished(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        const result = await getJobStatus(jobId);
        const status = result.findJob?.status;
        const progress = result.findJob?.progress;

        if (typeof progress === 'number' && progress >= 0 && onProgress) {
          onProgress(progress);
        }

        if (status === 'FINISHED') {
          clearInterval(interval);
          resolve(true);
        } else if (status === 'FAILED') {
          clearInterval(interval);
          reject(new Error('Job failed'));
        }
      }, 500);
    });
  }

  /**
   * Polls Stash logs for a message with the given prefix.
   * @param {string} prefix - The log message prefix to search for.
   * @param {number} delay - Time offset in ms (negative to look back).
   * @returns {Promise<string>} - The message content after the prefix.
   */
  async function pollLogsForMessage(prefix, delay = 0) {
    const reqTime = Date.now() + delay;
    const reqData = {
      variables: {},
      query: `query Logs {
        logs {
          time
          level
          message
        }
      }`,
    };
    await new Promise((r) => setTimeout(r, 500));
    let retries = 0;
    while (true) {
      const pollDelay = 2 ** retries * 100;
      await new Promise((r) => setTimeout(r, pollDelay));
      retries++;

      const logs = await csLib.callGQL(reqData);
      for (const log of logs.logs) {
        const logTime = Date.parse(log.time);
        if (logTime > reqTime && log.message.startsWith(prefix)) {
          return log.message.replace(prefix, '').trim();
        }
      }

      if (retries >= 10) {
        throw new Error(`Poll logs failed for message: ${prefix}`);
      }
    }
  }

  /**
   * Refreshes the page data using Apollo client.
   */
  function refreshPage() {
    try {
      window.__APOLLO_CLIENT__.reFetchObservableQueries();
    } catch (e) {
      console.warn('[Decensor] Apollo refresh failed, reloading page');
      window.location.reload();
    }
  }

  // Magic wand / restore icon
  const decensorIconSvg = `
<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 4V2M15 16V14M8 9H10M20 9H22M17.8 11.8L19 13M17.8 6.2L19 5M12.2 11.8L11 13M12.2 6.2L11 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M15 9C15 10.6569 13.6569 12 12 12C10.3431 12 9 10.6569 9 9C9 7.34315 10.3431 6 12 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M6 21L3 18L14 7L17 10L6 21Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

  let config = {
    decensorApiUrl: '',
    censoredTagId: '',
    decensoredTagId: '',
  };

  let activeJobs = new Map();

  const toastTemplate = {
    success: `<div class="toast fade show success" role="alert"><div class="d-flex"><div class="toast-body flex-grow-1">`,
    error: `<div class="toast fade show danger" role="alert"><div class="d-flex"><div class="toast-body flex-grow-1">`,
    bottom: `</div><button type="button" class="close ml-2 mb-1 mr-2" data-dismiss="toast" aria-label="Close"><span aria-hidden="true">&times;</span></button></div></div>`,
  };

  async function loadConfig() {
    try {
      const pluginConfig = await getPluginConfig(PLUGIN_ID);
      config.decensorApiUrl = pluginConfig?.decensorApiUrl || '';
      config.censoredTagId = pluginConfig?.censoredTagId || '';
      config.decensoredTagId = pluginConfig?.decensoredTagId || '';
    } catch (e) {
      console.warn('[Decensor] Failed to load plugin config:', e);
    }
  }

  function showToast(message, type = 'success') {
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
      const scene = await getScene(sceneId);
      if (!scene || !scene.files || scene.files.length === 0) {
        showToast('Scene has no video files', 'error');
        return;
      }

      const videoPath = scene.files[0].path;
      const sceneTitle = scene.title || `Scene ${sceneId}`;
      activeJobs.set(sceneId, true);

      showToast(`Starting decensor job for: ${sceneTitle}`);

      // Run decensor task via RPC
      // The RPC will: submit to decensor-api, poll, then queue scan and merge jobs
      const result = await runPluginTask(
        PLUGIN_ID,
        'Decensor Scene',
        [
          { key: 'mode', value: { str: 'decensor' } },
          { key: 'scene_id', value: { str: sceneId } },
          { key: 'video_path', value: { str: videoPath } },
          { key: 'service_url', value: { str: config.decensorApiUrl } },
          { key: 'censored_tag_id', value: { str: config.censoredTagId } },
          { key: 'decensored_tag_id', value: { str: config.decensoredTagId } },
        ]
      );

      if (!result || !result.runPluginTask) {
        showToast('Failed to start decensor task', 'error');
        activeJobs.delete(sceneId);
        resetButton(sceneId);
        return;
      }

      const jobId = result.runPluginTask;
      console.log(`[Decensor] Job started: ${jobId}`);

      // Wait for decensor job to complete
      try {
        await awaitJobFinished(jobId, (progress) => {
          updateButtonProgress(sceneId, Math.round(progress * 100));
        });
      } catch (e) {
        showToast(`Decensor failed: ${e.message}`, 'error');
        activeJobs.delete(sceneId);
        resetButton(sceneId);
        return;
      }

      // Decensor job queued scan and merge - poll for merge result
      showToast('Decensoring complete! Waiting for scan and merge...');
      updateButtonProgress(sceneId, 100);

      try {
        const mergePrefix = '[Plugin / Decensor] mergeResult=';
        const resultJson = await pollLogsForMessage(mergePrefix, -5000);
        const result = JSON.parse(resultJson);

        if (result.success) {
          showToast('Scene merged successfully!');
          refreshPage();
        }
      } catch (e) {
        console.warn('[Decensor] Failed to poll merge result:', e);
        // Still show success since the jobs were queued
        showToast('Decensoring queued. Refresh page when complete.');
      }

      activeJobs.delete(sceneId);
      resetButton(sceneId);

    } catch (e) {
      console.error('[Decensor] Error:', e);
      showToast(`Failed: ${e.message}`, 'error');
      activeJobs.delete(sceneId);
      resetButton(sceneId);
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
      const scene = await getScene(sceneId);
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
