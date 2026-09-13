"""Local HTTP/WebSocket gateway. No inference or service-colour rules in routes."""

from __future__ import annotations
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
from urllib.parse import urlparse
import anyio

from fastapi import (
    FastAPI,
    File,
    Form,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from processor.io import resolve_media
from .jobs import JobManager, ServiceError
from .live import LiveManager
from .body_limit import RequestBodyLimit, request_limit

ROOT = Path(__file__).resolve().parents[1]


def origin_allowed(origin):
    if origin is None:
        return True
    parsed = urlparse(origin)
    if (
        parsed.scheme not in ("http", "https")
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        return False
    configured = os.getenv("TABLEWATCH_ALLOWED_ORIGINS")
    allowed = (
        {item.strip() for item in configured.split(",") if item.strip()}
        if configured is not None
        else {
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:4173",
            "http://127.0.0.1:4173",
            "http://[::1]:8000",
        }
    )
    return origin in allowed


def create_app(data_root=None, *, model_dir=None, dependencies=None, limits=None):
    settings = {
        "upload_bytes": int(os.getenv("TABLEWATCH_UPLOAD_BYTES", "1000000000")),
        "duration_s": float(os.getenv("TABLEWATCH_DURATION_SECONDS", "600")),
        "frame_bytes": int(os.getenv("TABLEWATCH_FRAME_BYTES", str(2 * 1024 * 1024))),
        "setup_asset_bytes": 12 * 1024 * 1024,
        "disk_reserve_bytes": 128 * 1024 * 1024,
        **(limits or {}),
    }
    manager = JobManager(
        data_root or os.getenv("TABLEWATCH_DATA_DIR") or ROOT / "data" / "sources",
        model_dir or os.getenv("TABLEWATCH_MODEL_DIR") or ROOT / "models",
        dependencies or {},
        settings,
    )
    live = LiveManager(manager)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        await live.close()
        await manager.close()

    app = FastAPI(title="TurnTable CPU processing", lifespan=lifespan)
    app.add_middleware(RequestBodyLimit, limits=settings)
    app.state.manager, app.state.live_manager = manager, live

    @app.middleware("http")
    async def guard(request: Request, call_next):
        if not origin_allowed(request.headers.get("origin")):
            return JSONResponse(
                {"detail": "Dashboard origin is not in TABLEWATCH_ALLOWED_ORIGINS."},
                status_code=403,
            )
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return JSONResponse({"detail": "Invalid Content-Length."}, status_code=400)
        limit = request_limit(request.url.path, settings)
        if length > limit:
            return JSONResponse(
                {"detail": "Request exceeds the configured size limit."},
                status_code=413,
            )
        return await call_next(request)

    @app.exception_handler(ServiceError)
    async def service_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=error.status)

    @app.exception_handler(ValueError)
    async def validation_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.get("/api/health")
    async def health():
        return {
            "available": True,
            "models": await asyncio.to_thread(manager.models),
            "limits": settings,
            "active": manager.active,
        }

    @app.get("/api/live")
    async def liveness():
        return {"available": True}

    @app.get("/api/ready")
    async def readiness():
        models = await asyncio.to_thread(manager.models)
        ready = all(
            models.get(kind, {}).get("available") is True
            for kind in ("detector", "surface")
        )
        return JSONResponse(
            {"ready": ready, "models": models}, status_code=200 if ready else 503
        )

    @app.post("/api/videos", status_code=202)
    async def upload(file: UploadFile = File(...), manual_setup: bool = Form(False)):
        return await manager.upload(file, manual_setup=manual_setup)

    @app.get("/api/jobs")
    async def jobs():
        return [manager.public(ident) for ident in reversed(manager.sources)]

    @app.get("/api/jobs/{ident}")
    @app.get("/api/sources/{ident}")
    async def source(ident: str):
        return manager.public(ident)

    @app.post("/api/jobs/{ident}/cancel")
    async def cancel(ident: str):
        return await manager.cancel(ident)

    @app.get("/api/sources/{ident}/assets/{path:path}")
    async def asset(ident: str, path: str):
        root = manager.directory(ident)
        try:
            resolved = resolve_media(root, path)
        except (ValueError, OSError):
            raise ServiceError("Invalid source asset path.", 404)
        if not resolved.is_file() or path == "source.json":
            raise ServiceError("Source asset not found.", 404)
        return FileResponse(resolved)

    @app.put("/api/sources/{ident}/setup-assets/{kind}")
    async def setup_asset(
        ident: str, kind: str, file: UploadFile = File(...), revision: int = Form(...)
    ):
        return await manager.setup_asset(ident, kind, file, revision)

    @app.post("/api/sources/{ident}/frame")
    async def frame(ident: str, body: dict):
        manager.directory(ident)
        return await manager.frame(ident, body.get("t"))

    @app.put("/api/sources/{ident}/calibration")
    async def calibration(ident: str, body: dict):
        return await manager.calibration(ident, body)

    @app.post("/api/sources/{ident}/baseline-proposal")
    async def baseline_proposal(ident: str, body: dict):
        manager.directory(ident)
        return await manager.baseline_proposal(ident, body)

    @app.post("/api/sources/{ident}/analyze", status_code=202)
    async def analyze(ident: str, body: dict):
        manager.directory(ident)
        return await manager.analyze(ident, body.get("detection_only"))

    @app.get("/api/cameras")
    async def cameras():
        return [
            manager.public(ident)
            for ident, source in manager.sources.items()
            if source["kind"] == "camera" and source["calibration_confirmed"]
        ]

    @app.post("/api/cameras", status_code=202)
    async def camera(body: dict):
        return await manager.camera(body)

    @app.post("/api/live", status_code=201)
    async def start_live(body: dict):
        return await live.start(body.get("source_id"), body.get("detection_only"))

    @app.delete("/api/live/{ident}")
    async def stop_live(ident: str):
        await live.stop(ident)
        return {"status": "stopped"}

    @app.websocket("/api/live/{ident}/stream")
    async def stream(socket: WebSocket, ident: str):
        run = live.sessions.get(ident)
        if (
            not origin_allowed(socket.headers.get("origin"))
            or run is None
            or run.connected
        ):
            await socket.close(code=1008)
            return
        await socket.accept()
        run.connected = True
        lock = asyncio.Lock()

        async def send(value):
            async with lock:
                await socket.send_json(value)

        async def writer():
            while True:
                value = await run.output.get()
                await send(value)
                if value.get("type") == "stopped":
                    await socket.close(code=1000)
                    return

        sender = asyncio.create_task(writer())
        run.publish()
        try:
            while not run.closed:
                raw = await socket.receive_text()
                if len(raw) > settings["frame_bytes"] * 2 + 65536:
                    await send(
                        {
                            "type": "error",
                            "message": "Camera message exceeds size limit.",
                        }
                    )
                    continue
                try:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        raise ServiceError("Expected a live command object.")
                    kind = message.get("type")
                    if kind == "sync":
                        await send(
                            {
                                "type": "clock",
                                "client_t": message.get("client_t"),
                                "t": run.now(),
                            }
                        )
                    elif kind == "frame":
                        run.enqueue(message)
                    elif kind in ("staff", "monitoring", "rename"):
                        await run.action(message)
                    elif kind == "stop":
                        await live.stop(ident)
                        # The single writer sends the final stopped snapshot and
                        # closes the transport before request cleanup cancels it.
                        await sender
                        break
                    else:
                        raise ServiceError("Unknown live command.")
                except (ValueError, TypeError, KeyError) as error:
                    await send({"type": "error", "message": str(error)})
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            # ASGI disconnect cancels the request scope. Cleanup must finish
            # before that cancellation can abandon child inference processes.
            with anyio.CancelScope(shield=True):
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)
                await live.stop(ident)

    frontend = Path(os.getenv("TABLEWATCH_STATIC_DIR", str(ROOT / "dist")))
    if frontend.is_dir():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="dashboard")
    return app


app = create_app()
