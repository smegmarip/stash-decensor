import asyncio
import json
from fastapi import WebSocket, WebSocketDisconnect
from typing import Set

from app.services.queue import queue_service


class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._subscriber_task = None

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: str):
        disconnected = set()
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                disconnected.add(connection)
        for conn in disconnected:
            self.active_connections.discard(conn)

    async def start_redis_subscriber(self):
        if self._subscriber_task is not None:
            return
        self._subscriber_task = asyncio.create_task(self._subscribe_loop())

    async def stop_redis_subscriber(self):
        if self._subscriber_task:
            self._subscriber_task.cancel()
            try:
                await self._subscriber_task
            except asyncio.CancelledError:
                pass
            self._subscriber_task = None

    async def _subscribe_loop(self):
        try:
            pubsub = await queue_service.subscribe_updates()
            while True:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=1.0
                )
                if message and message["type"] == "message":
                    await self.broadcast(message["data"])
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"Redis subscriber error: {e}")


manager = ConnectionManager()


async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
