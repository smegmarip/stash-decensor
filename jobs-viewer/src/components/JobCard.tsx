import { Job } from '../api/client'
import { ProgressBar } from './ProgressBar'

interface JobCardProps {
  job: Job
  onDelete: (jobId: string) => void
}

const statusColors: Record<string, string> = {
  queued: 'bg-yellow-600',
  processing: 'bg-blue-600',
  completed: 'bg-green-600',
  failed: 'bg-red-600',
  cancelled: 'bg-gray-600',
}

const statusLabels: Record<string, string> = {
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString()
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '-'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}m ${secs}s`
}

function getFileName(path: string): string {
  return path.split('/').pop() || path
}

export function JobCard({ job, onDelete }: JobCardProps) {
  const canDelete = job.status !== 'processing'

  return (
    <div className="bg-gray-800 rounded-lg p-4 shadow-lg">
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-gray-200 truncate" title={job.job_id}>
            {job.job_id.slice(0, 8)}...
          </h3>
          <p className="text-xs text-gray-400 mt-1">
            Created: {formatDate(job.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-2 py-1 text-xs font-medium rounded ${statusColors[job.status]}`}
          >
            {statusLabels[job.status]}
          </span>
          {canDelete && (
            <button
              onClick={() => onDelete(job.job_id)}
              className="text-gray-400 hover:text-red-400 transition-colors"
              title="Delete job"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {job.status === 'processing' && (
        <div className="mb-3">
          <ProgressBar progress={job.progress} />
        </div>
      )}

      {job.error && (
        <div className="mb-3 p-2 bg-red-900/30 rounded text-xs text-red-300">
          {job.error}
        </div>
      )}

      {job.result && (
        <div className="mb-3 space-y-1">
          <p className="text-xs text-gray-400">
            Output: <span className="text-gray-300">{getFileName(job.result.output_path || '')}</span>
          </p>
          <p className="text-xs text-gray-400">
            Processing time: <span className="text-gray-300">{formatDuration(job.result.processing_time_seconds)}</span>
          </p>
        </div>
      )}

      <div className="flex gap-4 text-xs text-gray-500">
        {job.started_at && (
          <span>Started: {formatDate(job.started_at)}</span>
        )}
        {job.completed_at && (
          <span>Completed: {formatDate(job.completed_at)}</span>
        )}
      </div>
    </div>
  )
}
