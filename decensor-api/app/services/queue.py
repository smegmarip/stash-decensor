import json
from typing import Optional
import redis.asyncio as redis

from app.config import settings
from app.models import Job, JobStatus


class QueueService:
    QUEUE_KEY = "decensor:queue"
    JOBS_KEY = "decensor:jobs"
    CHANNEL_KEY = "decensor:updates"

    def __init__(self):
        self._redis: Optional[redis.Redis] = None

    async def connect(self):
        if self._redis is None:
            self._redis = redis.from_url(settings.redis_url, decode_responses=True)

    async def disconnect(self):
        if self._redis:
            await self._redis.close()
            self._redis = None

    @property
    def redis(self) -> redis.Redis:
        if self._redis is None:
            raise RuntimeError("Redis not connected")
        return self._redis

    async def enqueue_job(self, job: Job) -> None:
        await self.save_job(job)
        await self.redis.rpush(self.QUEUE_KEY, job.job_id)
        await self.publish_update(job)

    async def dequeue_job(self) -> Optional[str]:
        result = await self.redis.blpop(self.QUEUE_KEY, timeout=1)
        if result:
            return result[1]
        return None

    async def save_job(self, job: Job) -> None:
        await self.redis.hset(
            self.JOBS_KEY,
            job.job_id,
            json.dumps(job.to_dict())
        )
        await self.redis.expire(self.JOBS_KEY, settings.cache_ttl)

    async def get_job(self, job_id: str) -> Optional[Job]:
        data = await self.redis.hget(self.JOBS_KEY, job_id)
        if data:
            return Job.from_dict(json.loads(data))
        return None

    async def get_all_jobs(self) -> list[Job]:
        data = await self.redis.hgetall(self.JOBS_KEY)
        jobs = []
        for job_data in data.values():
            jobs.append(Job.from_dict(json.loads(job_data)))
        jobs.sort(key=lambda j: j.created_at, reverse=True)
        return jobs

    async def delete_job(self, job_id: str) -> bool:
        job = await self.get_job(job_id)
        if job:
            if job.status == JobStatus.PROCESSING:
                job.status = JobStatus.CANCELLED
                await self.save_job(job)
                await self.publish_update(job)
            else:
                await self.redis.hdel(self.JOBS_KEY, job_id)
                await self.redis.lrem(self.QUEUE_KEY, 0, job_id)
            return True
        return False

    async def update_job_status(
        self,
        job_id: str,
        status: JobStatus,
        progress: float = None,
        error: str = None,
        result: dict = None,
    ) -> Optional[Job]:
        job = await self.get_job(job_id)
        if not job:
            return None

        job.status = status
        if progress is not None:
            job.progress = progress
        if error is not None:
            job.error = error
        if result is not None:
            from app.models import JobResult
            job.result = JobResult(**result)

        from datetime import datetime
        if status == JobStatus.PROCESSING and job.started_at is None:
            job.started_at = datetime.utcnow()
        elif status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED):
            job.completed_at = datetime.utcnow()

        await self.save_job(job)
        await self.publish_update(job)
        return job

    async def publish_update(self, job: Job) -> None:
        await self.redis.publish(
            self.CHANNEL_KEY,
            json.dumps(job.to_dict())
        )

    async def subscribe_updates(self):
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(self.CHANNEL_KEY)
        return pubsub

    async def get_queue_length(self) -> int:
        return await self.redis.llen(self.QUEUE_KEY)


queue_service = QueueService()
