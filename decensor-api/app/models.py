from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field
import uuid


class JobStatus(str, Enum):
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class JobCreateRequest(BaseModel):
    video_path: str
    scene_id: str
    encoding_preset: Optional[str] = None
    max_clip_length: Optional[int] = None


class JobResult(BaseModel):
    output_path: Optional[str] = None
    processing_time_seconds: Optional[float] = None


class Job(BaseModel):
    job_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    video_path: str
    scene_id: str
    encoding_preset: str
    max_clip_length: Optional[int] = None
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0
    created_at: datetime = Field(default_factory=datetime.utcnow)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    error: Optional[str] = None
    result: Optional[JobResult] = None

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "video_path": self.video_path,
            "scene_id": self.scene_id,
            "encoding_preset": self.encoding_preset,
            "max_clip_length": self.max_clip_length,
            "status": self.status.value,
            "progress": self.progress,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "error": self.error,
            "result": self.result.model_dump() if self.result else None,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Job":
        return cls(
            job_id=data["job_id"],
            video_path=data["video_path"],
            scene_id=data["scene_id"],
            encoding_preset=data["encoding_preset"],
            max_clip_length=data.get("max_clip_length"),
            status=JobStatus(data["status"]),
            progress=data["progress"],
            created_at=datetime.fromisoformat(data["created_at"]),
            started_at=datetime.fromisoformat(data["started_at"]) if data.get("started_at") else None,
            completed_at=datetime.fromisoformat(data["completed_at"]) if data.get("completed_at") else None,
            error=data.get("error"),
            result=JobResult(**data["result"]) if data.get("result") else None,
        )


class JobResponse(BaseModel):
    job_id: str
    status: JobStatus
    progress: float
    created_at: datetime
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    error: Optional[str] = None
    result: Optional[JobResult] = None


class JobListResponse(BaseModel):
    jobs: list[JobResponse]
    total: int


class HealthResponse(BaseModel):
    status: str
    redis: bool
    worker: bool
