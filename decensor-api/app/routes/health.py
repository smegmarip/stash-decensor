import subprocess
from fastapi import APIRouter

from app.config import settings
from app.models import HealthResponse
from app.services.queue import queue_service

router = APIRouter(prefix="/decensor", tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    redis_ok = False
    worker_ok = False

    try:
        await queue_service.redis.ping()
        redis_ok = True
    except Exception:
        pass

    try:
        result = subprocess.run(
            ["docker", "inspect", settings.worker_container],
            capture_output=True,
            timeout=5,
        )
        worker_ok = result.returncode == 0
    except Exception:
        pass

    status = "healthy" if redis_ok and worker_ok else "degraded"

    return HealthResponse(
        status=status,
        redis=redis_ok,
        worker=worker_ok,
    )
