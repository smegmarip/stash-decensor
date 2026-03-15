import asyncio
import subprocess
import re
import os
from datetime import datetime
from typing import Optional

from app.config import settings
from app.models import JobStatus, JobResult
from app.services.queue import queue_service


class WorkerService:
    def __init__(self):
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._current_job_id: Optional[str] = None

    async def start(self):
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._worker_loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _worker_loop(self):
        while self._running:
            try:
                job_id = await queue_service.dequeue_job()
                if job_id:
                    await self._process_job(job_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"Worker error: {e}")
                await asyncio.sleep(1)

    async def _process_job(self, job_id: str):
        job = await queue_service.get_job(job_id)
        if not job:
            return

        if job.status == JobStatus.CANCELLED:
            return

        self._current_job_id = job_id
        start_time = datetime.utcnow()

        try:
            await queue_service.update_job_status(
                job_id,
                JobStatus.PROCESSING,
                progress=0.0
            )

            output_path = self._get_output_path(job.video_path)

            success = await self._run_lada(
                job_id=job_id,
                input_path=job.video_path,
                output_path=output_path,
                encoding_preset=job.encoding_preset,
                max_clip_length=job.max_clip_length,
            )

            if success:
                elapsed = (datetime.utcnow() - start_time).total_seconds()
                await queue_service.update_job_status(
                    job_id,
                    JobStatus.COMPLETED,
                    progress=1.0,
                    result={
                        "output_path": output_path,
                        "processing_time_seconds": elapsed
                    }
                )
            else:
                await queue_service.update_job_status(
                    job_id,
                    JobStatus.FAILED,
                    error="Lada processing failed"
                )

        except Exception as e:
            await queue_service.update_job_status(
                job_id,
                JobStatus.FAILED,
                error=str(e)
            )
        finally:
            self._current_job_id = None

    def _get_output_path(self, input_path: str) -> str:
        base, ext = os.path.splitext(input_path)
        return f"{base}.restored{ext}"

    async def _run_lada(
        self,
        job_id: str,
        input_path: str,
        output_path: str,
        encoding_preset: str,
        max_clip_length: int,
    ) -> bool:
        cmd = [
            "docker", "exec", settings.worker_container,
            "lada-cli",
            "--input", input_path,
            "--output", output_path,
            "--encoding-preset", encoding_preset,
            "--max-clip-length", str(max_clip_length),
        ]

        if settings.fp16:
            cmd.append("--fp16")

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        total_frames = None
        current_frame = 0

        while True:
            line = await process.stdout.readline()
            if not line:
                break

            line_str = line.decode("utf-8", errors="replace").strip()
            print(f"[lada] {line_str}")

            job = await queue_service.get_job(job_id)
            if job and job.status == JobStatus.CANCELLED:
                process.terminate()
                await process.wait()
                return False

            if match := re.search(r"Total frames:\s*(\d+)", line_str):
                total_frames = int(match.group(1))

            if match := re.search(r"Processing frame\s*(\d+)", line_str):
                current_frame = int(match.group(1))

            if match := re.search(r"(\d+)/(\d+)", line_str):
                current_frame = int(match.group(1))
                total_frames = int(match.group(2))

            if total_frames and total_frames > 0:
                progress = min(current_frame / total_frames, 0.99)
                await queue_service.update_job_status(
                    job_id,
                    JobStatus.PROCESSING,
                    progress=progress
                )

        await process.wait()
        return process.returncode == 0

    def is_processing(self, job_id: str) -> bool:
        return self._current_job_id == job_id


worker_service = WorkerService()
