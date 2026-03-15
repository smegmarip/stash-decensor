import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { fetchJobs, deleteJob, createWebSocket, Job } from '../api/client'

export function useJobs(statusFilter?: string) {
  const queryClient = useQueryClient()
  const wsRef = useRef<WebSocket | null>(null)

  const query = useQuery({
    queryKey: ['jobs', statusFilter],
    queryFn: () => fetchJobs(statusFilter),
  })

  useEffect(() => {
    const ws = createWebSocket()
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const updatedJob: Job = JSON.parse(event.data)
        queryClient.setQueryData(['jobs', statusFilter], (old: { jobs: Job[]; total: number } | undefined) => {
          if (!old) return old
          const jobs = old.jobs.map((job) =>
            job.job_id === updatedJob.job_id ? updatedJob : job
          )
          const exists = old.jobs.some((job) => job.job_id === updatedJob.job_id)
          if (!exists) {
            jobs.unshift(updatedJob)
          }
          return { ...old, jobs }
        })
      } catch {
        // Ignore parse errors
      }
    }

    ws.onclose = () => {
      setTimeout(() => {
        if (wsRef.current === ws) {
          wsRef.current = createWebSocket()
        }
      }, 3000)
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [queryClient, statusFilter])

  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })

  return {
    jobs: query.data?.jobs ?? [],
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    error: query.error,
    deleteJob: deleteMutation.mutate,
    isDeleting: deleteMutation.isPending,
  }
}
