from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import jobs, health
from app.services.queue import queue_service
from app.services.worker import worker_service
from app.websocket import manager, websocket_endpoint


@asynccontextmanager
async def lifespan(app: FastAPI):
    await queue_service.connect()
    await worker_service.start()
    await manager.start_redis_subscriber()
    yield
    await manager.stop_redis_subscriber()
    await worker_service.stop()
    await queue_service.disconnect()


app = FastAPI(
    title="Decensor API",
    description="API for managing video decensoring jobs",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs.router)
app.include_router(health.router)
app.add_api_websocket_route("/decensor/ws", websocket_endpoint)


@app.get("/")
async def root():
    return {"service": "decensor-api", "version": "1.0.0"}
