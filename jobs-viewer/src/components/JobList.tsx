import { useState } from 'react'
import { useJobs } from '../hooks/useJobs'
import { JobCard } from './JobCard'

const statusFilters = [
  { value: 'all', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'processing', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
]

export function JobList() {
  const [statusFilter, setStatusFilter] = useState('all')
  const { jobs, total, isLoading, error, deleteJob } = useJobs(statusFilter)

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-white">Decensor Jobs</h1>
        <span className="text-sm text-gray-400">{total} jobs</span>
      </div>

      <div className="flex gap-2 mb-6">
        {statusFilters.map((filter) => (
          <button
            key={filter.value}
            onClick={() => setStatusFilter(filter.value)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${
              statusFilter === filter.value
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {isLoading && jobs.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          Loading jobs...
        </div>
      )}

      {error && (
        <div className="text-center py-12 text-red-400">
          Error loading jobs: {error.message}
        </div>
      )}

      {!isLoading && jobs.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          No jobs found
        </div>
      )}

      <div className="space-y-4">
        {jobs.map((job) => (
          <JobCard key={job.job_id} job={job} onDelete={deleteJob} />
        ))}
      </div>
    </div>
  )
}
