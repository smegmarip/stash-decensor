(function () {
  'use strict';

  let apiUrl = 'http://localhost:7030';

  function setApiUrl(url) {
    apiUrl = url.replace(/\/$/, '');
  }

  function getApiUrl() {
    return apiUrl;
  }

  async function submitJob(videoPath, sceneId, options = {}) {
    const response = await fetch(`${apiUrl}/decensor/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        video_path: videoPath,
        scene_id: sceneId,
        encoding_preset: options.encodingPreset,
        max_clip_length: options.maxClipLength,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to submit job: ${error}`);
    }

    return response.json();
  }

  async function getJobStatus(jobId) {
    const response = await fetch(`${apiUrl}/decensor/jobs/${jobId}/status`);

    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.status}`);
    }

    return response.json();
  }

  async function getJobResults(jobId) {
    const response = await fetch(`${apiUrl}/decensor/jobs/${jobId}/results`);

    if (!response.ok) {
      throw new Error(`Failed to get job results: ${response.status}`);
    }

    return response.json();
  }

  async function deleteJob(jobId) {
    const response = await fetch(`${apiUrl}/decensor/jobs/${jobId}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      throw new Error(`Failed to delete job: ${response.status}`);
    }

    return response.json();
  }

  async function pollJobUntilComplete(jobId, options = {}) {
    const pollInterval = options.pollInterval || 2000;
    const maxWaitMs = options.maxWaitMs || 7200000;
    const onProgress = options.onProgress || (() => {});

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const job = await getJobStatus(jobId);

      onProgress(job);

      if (job.status === 'completed') {
        return job;
      }

      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new Error(job.error || `Job ${job.status}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error('Job timed out');
  }

  window.StashDecensorApi = {
    setApiUrl,
    getApiUrl,
    submitJob,
    getJobStatus,
    getJobResults,
    deleteJob,
    pollJobUntilComplete,
  };
})();
