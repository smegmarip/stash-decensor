from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models import (
    Job,
    JobCreateRequest,
    JobResponse,
    JobListResponse,
    JobStatus,
)
from app.services.queue import queue_service

router = APIRouter(prefix="/decensor/jobs", tags=["jobs"])


def job_to_response(job: Job) -> JobResponse:
    return JobResponse(
        job_id=job.job_id,
        status=job.status,
        progress=job.progress,
        created_at=job.created_at,
        started_at=job.started_at,
        completed_at=job.completed_at,
        error=job.error,
        result=job.result,
    )


@router.post("", response_model=JobResponse)
async def create_job(request: JobCreateRequest):
    """Submit a new decensor job."""
    job = Job(
        video_path=request.video_path,
        scene_id=request.scene_id,
        encoding_preset=request.encoding_preset or settings.encoding_preset,
        max_clip_length=request.max_clip_length if request.max_clip_length is not None else settings.max_clip_length,
    )

    await queue_service.enqueue_job(job)

    return job_to_response(job)


@router.get("", response_model=JobListResponse)
async def list_jobs(
    status: JobStatus = None,
    limit: int = 100,
    offset: int = 0,
):
    """List all jobs."""
    jobs = await queue_service.get_all_jobs()

    if status:
        jobs = [j for j in jobs if j.status == status]

    total = len(jobs)
    jobs = jobs[offset:offset + limit]

    return JobListResponse(
        jobs=[job_to_response(j) for j in jobs],
        total=total,
    )


@router.get("/{job_id}/status", response_model=JobResponse)
async def get_job_status(job_id: str):
    """Get job status."""
    job = await queue_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_response(job)


@router.get("/{job_id}/results", response_model=JobResponse)
async def get_job_results(job_id: str):
    """Get job results."""
    job = await queue_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in (JobStatus.COMPLETED, JobStatus.FAILED):
        raise HTTPException(status_code=400, detail="Job not finished")
    return job_to_response(job)


@router.delete("/{job_id}")
async def delete_job(job_id: str):
    """Cancel or delete a job."""
    success = await queue_service.delete_job(job_id)
    if not success:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"status": "deleted", "job_id": job_id}
