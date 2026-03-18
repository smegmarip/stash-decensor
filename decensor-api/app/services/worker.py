import asyncio
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
            await queue_service.update_job_status(job_id, JobStatus.PROCESSING, progress=0.0)

            output_path = self._get_output_path(job.video_path, job.encoding_preset)

            success, error_message = await self._run_lada(
                job_id=job_id,
                input_path=job.video_path,
                output_path=output_path,
                encoding_preset=job.encoding_preset,
                max_clip_length=job.max_clip_length,
            )

            # Verify output file exists before marking as successful
            if success and not os.path.exists(output_path):
                success = False
                error_message = f"Output file was not created: {output_path}"

            if success:
                elapsed = (datetime.utcnow() - start_time).total_seconds()
                await queue_service.update_job_status(
                    job_id,
                    JobStatus.COMPLETED,
                    progress=1.0,
                    result={"output_path": output_path, "processing_time_seconds": elapsed},
                )
            else:
                await queue_service.update_job_status(
                    job_id, JobStatus.FAILED, error=error_message or "Lada processing failed"
                )

        except Exception as e:
            await queue_service.update_job_status(job_id, JobStatus.FAILED, error=str(e))
        finally:
            self._current_job_id = None

    def _get_output_path(self, input_path: str, encoding_preset: str) -> str:
        base, ext = os.path.splitext(input_path)
        # Force .mp4 extension for codecs that require an mp4 container
        if "hevc" in encoding_preset or "h264" in encoding_preset:
            ext = ".mp4"
        return f"{base}.restored{ext}"

    async def _run_lada(
        self,
        job_id: str,
        input_path: str,
        output_path: str,
        encoding_preset: str,
        max_clip_length: Optional[int],
    ) -> tuple[bool, Optional[str]]:
        """
        Run lada-cli to process the video.
        Returns: (success: bool, error_message: Optional[str])
        """
        # Check if input file exists (in the container's mounted path)
        if not os.path.exists(input_path):
            raise FileNotFoundError(f"Input file not found: {input_path}")

        cmd = [
            "/usr/local/bin/docker",
            "exec",
            settings.worker_container,
            "lada-cli",
            "--input",
            input_path,
            "--output",
            output_path,
            "--encoding-preset",
            encoding_preset,
        ]

        if max_clip_length is not None:
            cmd.extend(["--max-clip-length", str(max_clip_length)])

        if settings.fp16 is True:
            cmd.append("--fp16")

        print(f"[worker] Running command: {' '.join(cmd)}")

        try:
            # Use larger limit to handle tqdm output without newlines
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                limit=4 * 1024 * 1024,  # 4MB buffer limit
            )
        except FileNotFoundError as e:
            raise FileNotFoundError(
                f"Docker command not found. Ensure docker is installed and /var/run/docker.sock is mounted. Error: {e}"
            )

        error_lines = []
        last_progress = 0
        buffer = ""

        while True:
            try:
                # Read chunks instead of lines to handle tqdm carriage returns
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break

                buffer += chunk.decode("utf-8", errors="replace")

                # Process complete lines (split by newline or carriage return)
                while "\n" in buffer or "\r" in buffer:
                    # Find the first separator
                    newline_pos = buffer.find("\n")
                    cr_pos = buffer.find("\r")

                    if newline_pos == -1:
                        split_pos = cr_pos
                    elif cr_pos == -1:
                        split_pos = newline_pos
                    else:
                        split_pos = min(newline_pos, cr_pos)

                    line_str = buffer[:split_pos].strip()
                    buffer = buffer[split_pos + 1 :]

                    if not line_str:
                        continue

                    print(f"[lada] {line_str}")

                    # Capture error messages
                    line_lower = line_str.lower()
                    if any(keyword in line_lower for keyword in ["error", "exception", "failed", "traceback"]):
                        error_lines.append(line_str)

                    # Parse progress from lada output format: "Processing video: XX%|"
                    if match := re.search(r"Processing video:\s*(\d+)%", line_str):
                        progress = int(match.group(1)) / 100.0
                        if progress > last_progress:
                            last_progress = progress
                            await queue_service.update_job_status(
                                job_id, JobStatus.PROCESSING, progress=min(progress, 0.99)
                            )

                    # Also try frame-based progress patterns as fallback
                    elif match := re.search(r"(\d+)/(\d+)", line_str):
                        current_frame = int(match.group(1))
                        total_frames = int(match.group(2))
                        if total_frames > 0:
                            progress = current_frame / total_frames
                            if progress > last_progress:
                                last_progress = progress
                                await queue_service.update_job_status(
                                    job_id, JobStatus.PROCESSING, progress=min(progress, 0.99)
                                )

                # Check for cancellation periodically
                job = await queue_service.get_job(job_id)
                if job and job.status == JobStatus.CANCELLED:
                    process.terminate()
                    await process.wait()
                    return False, "Job cancelled"

            except Exception as e:
                print(f"[worker] Error reading output: {e}")
                break

        await process.wait()

        if process.returncode != 0:
            error_message = (
                "; ".join(error_lines[-5:]) if error_lines else f"Process exited with code {process.returncode}"
            )
            print(f"[worker] Lada failed with return code {process.returncode}: {error_message}")
            return False, error_message

        return True, None

    def is_processing(self, job_id: str) -> bool:
        return self._current_job_id == job_id


worker_service = WorkerService()
