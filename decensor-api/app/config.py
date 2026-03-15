from typing import Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    redis_url: str = "redis://redis:6379/0"
    stash_url: str = "http://host.docker.internal:9999"
    stash_api_key: str = ""
    media_path: str = "/data"

    censored_tag_id: str = ""
    decensored_tag_id: str = ""

    encoding_preset: str = "hevc-nvidia-gpu-hq"
    max_clip_length: Optional[int] = None
    fp16: Optional[bool] = None

    worker_concurrency: int = 1
    job_timeout: int = 7200
    cache_ttl: int = 86400

    worker_container: str = "decensor-worker"

    class Config:
        env_file = ".env"


settings = Settings()
