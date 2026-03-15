export interface JobResult {
  output_path: string | null
  processing_time_seconds: number | null
}

export interface Job {
  job_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'
  progress: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
  result: JobResult | null
}

export interface JobListResponse {
  jobs: Job[]
  total: number
}

const API_BASE = '/decensor'

export async function fetchJobs(status?: string): Promise<JobListResponse> {
  const params = new URLSearchParams()
  if (status && status !== 'all') {
    params.set('status', status)
  }
  const url = `${API_BASE}/jobs${params.toString() ? '?' + params : ''}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error('Failed to fetch jobs')
  }
  return response.json()
}

export async function deleteJob(jobId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/jobs/${jobId}`, {
    method: 'DELETE',
  })
  if (!response.ok) {
    throw new Error('Failed to delete job')
  }
}

export function createWebSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${protocol}//${window.location.host}${API_BASE}/ws`
  return new WebSocket(wsUrl)
}
