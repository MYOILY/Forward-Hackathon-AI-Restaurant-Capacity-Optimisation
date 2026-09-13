"""Persistent spawned inference workers with cancellable async RPC.

Only one call is in flight per worker. The service owns latest-frame replacement
and freshness checks. Arrays travel through an anonymous process pipe; live
frames and current tabletop images are never written to disk here.
"""

from __future__ import annotations

import asyncio
from contextlib import redirect_stdout
import importlib
import multiprocessing
import os
import sys
from time import perf_counter


def _factory(path):
    module, separator, name = path.partition(":")
    if not separator or not module or not name:
        raise ValueError("Worker factory must be an importable module:callable")
    value = getattr(importlib.import_module(module), name)
    if not callable(value):
        raise ValueError("Worker factory is not callable")
    return value


class _ProposalSession:
    """A setup-only detector, resident solely inside the proposal child."""

    def __init__(self, model_dir, model="tiny", intra_threads=4):
        import cv2
        from .detector import YOLOXDetector

        cv2.setNumThreads(1)
        self.detector = YOLOXDetector(
            model=model,
            model_dir=model_dir,
            score_threshold=0.3,
            nms_threshold=0.45,
            intra_threads=intra_threads,
            class_ids=(60,),
        )
        self.metadata = {
            "model": model,
            "model_sha256": self.detector.sha256,
            "provider": "CPUExecutionProvider",
            "detected_classes": [60],
            "confidence": 0.3,
            "nms_threshold": 0.45,
            "intra_threads": intra_threads,
            "inter_threads": 1,
            "opencv_threads": 1,
            "startup_timing_s": dict(self.detector.startup_timing),
        }

    def propose(self, frame):
        from .live_vision import propose_tables

        if self.detector is None:
            raise RuntimeError("Proposal session is closed")
        return propose_tables(frame, detector=self.detector)

    def close(self):
        self.detector = None


def _child(connection, kind, config, factory):
    instance = None
    try:
        started = perf_counter()
        with redirect_stdout(sys.stderr):
            if factory is not None:
                constructor = _factory(factory)
            elif kind == "vision":
                from .live_vision import VisionSession

                constructor = VisionSession
            elif kind == "proposal":
                constructor = _ProposalSession
            else:
                from .object_surface import ObjectSurfaceModel

                constructor = ObjectSurfaceModel
            instance = constructor(**config)
        metadata = {
            **getattr(instance, "metadata", {}),
            "worker_pid": os.getpid(),
            "worker_startup_s": perf_counter() - started,
            "start_method": "spawn",
        }
        if factory is not None:
            metadata["injected_factory"] = factory
        connection.send({"ready": True, "metadata": metadata})
        while True:
            command = connection.recv()
            op, args = command["op"], command.get("args", ())
            started = perf_counter()
            try:
                with redirect_stdout(sys.stderr):
                    if kind == "vision" and op == "process_frame":
                        result = instance.process_frame(*args)
                    elif kind == "vision" and op == "set_tables":
                        result = instance.set_tables(*args)
                    elif kind == "proposal" and op == "propose":
                        result = instance.propose(*args)
                    elif kind == "surface" and op == "propose":
                        result = instance.propose_images(*args)
                    elif kind == "surface" and op == "assess":
                        assess = (
                            getattr(instance, "assess_images", None) or instance.assess
                        )
                        result = assess(*args)
                        result = {
                            **result,
                            "model": metadata.get("model"),
                            "surface_method": metadata.get(
                                "surface_method", result.get("surface_method")
                            ),
                            "timing": {
                                **getattr(instance, "last_timing", {}),
                                "total": perf_counter() - started,
                            },
                            "metadata": metadata,
                        }
                    else:
                        raise ValueError(f"Unsupported {kind} worker operation: {op}")
                connection.send({"id": command["id"], "result": result})
            except Exception as exc:
                connection.send(
                    {
                        "id": command["id"],
                        "error": f"{type(exc).__name__}: {exc}"[:1200],
                    }
                )
            finally:
                # Drop the pipe payload and image arguments before blocking.
                args = command = None
    except (EOFError, BrokenPipeError, OSError):
        pass
    except Exception as exc:
        try:
            connection.send(
                {"ready": False, "error": f"{type(exc).__name__}: {exc}"[:1200]}
            )
        except (EOFError, BrokenPipeError, OSError):
            pass
    finally:
        if instance is not None and hasattr(instance, "close"):
            with redirect_stdout(sys.stderr):
                instance.close()
        connection.close()


class _Worker:
    def __init__(self, kind, config, *, factory=None):
        if factory is not None and not isinstance(factory, str):
            raise ValueError(
                "Injected worker factories must be importable module:callable strings"
            )
        context = multiprocessing.get_context("spawn")
        self._connection, child = context.Pipe(duplex=True)
        self._process = context.Process(
            target=_child,
            args=(child, kind, dict(config), factory),
            name=f"restaurant-{kind}",
            daemon=True,
        )
        self.closed, self.metadata, self._ready = False, {}, False
        self._lock, self._next_id, self._close_task = asyncio.Lock(), 0, None
        try:
            self._process.start()
        except BaseException:
            self._connection.close()
            raise
        finally:
            child.close()

    @property
    def pid(self):
        return self._process.pid

    def _exchange(self, op, args):
        if self.closed:
            raise RuntimeError("Inference worker is closed")
        try:
            if not self._ready:
                hello = self._connection.recv()
                if hello.get("ready") is not True:
                    raise RuntimeError(
                        f"Inference worker startup failed: {hello.get('error', 'invalid startup response')}"
                    )
                self.metadata = hello["metadata"]
                self._ready = True
            if self.closed:
                raise RuntimeError("Inference worker is closed")
            self._next_id += 1
            request_id = self._next_id
            self._connection.send({"id": request_id, "op": op, "args": args})
            response = self._connection.recv()
            if response.get("id") != request_id:
                raise RuntimeError("Inference worker response identity mismatch")
            if "error" in response:
                raise RuntimeError(response["error"])
            return response["result"]
        except (EOFError, BrokenPipeError, OSError, TypeError) as exc:
            raise RuntimeError(
                "Inference worker closed or exited during a request"
            ) from exc

    async def _call(self, op, *args):
        if self.closed:
            raise RuntimeError("Inference worker is closed")
        try:
            async with self._lock:
                return await asyncio.to_thread(self._exchange, op, args)
        except asyncio.CancelledError:
            # Cancelling to_thread alone would leave the model running. Kill the
            # child first so its blocked reply reader also releases promptly.
            await asyncio.shield(self.close())
            raise

    async def _finish_close(self):
        if self._process.is_alive():
            self._process.terminate()
        await asyncio.to_thread(self._process.join, 1.0)
        if self._process.is_alive():
            self._process.kill()
            await asyncio.to_thread(self._process.join, 1.0)
        self._connection.close()
        if self._process.is_alive():
            raise RuntimeError("Inference worker failed to terminate")

    async def close(self):
        # Never wait for the RPC lock: the child may be inside a long inference.
        if self._close_task is None:
            self.closed = True
            self._close_task = asyncio.create_task(self._finish_close())
        await asyncio.shield(self._close_task)


class VisionWorker(_Worker):
    def __init__(self, config, *, factory=None):
        super().__init__("vision", config, factory=factory)

    async def process_frame(self, frame, t, seq):
        result = await self._call("process_frame", frame, t, seq)
        return {**result, "metadata": self.metadata}

    async def set_tables(self, tables):
        return await self._call("set_tables", tables)


class SurfaceWorker(_Worker):
    def __init__(self, model_dir, *, factory=None):
        super().__init__("surface", {"model_dir": model_dir}, factory=factory)

    async def assess(self, reference_rgb, current_rgb):
        return await self._call("assess", reference_rgb, current_rgb)

    async def propose(self, current_rgb):
        return await self._call("propose", current_rgb)


class ProposalWorker(_Worker):
    """RAM-only table proposal inference with a killable native-model lifetime."""

    def __init__(self, model_dir, model="tiny", intra_threads=4, *, factory=None):
        super().__init__(
            "proposal",
            {"model_dir": model_dir, "model": model, "intra_threads": intra_threads},
            factory=factory,
        )

    async def propose(self, frame):
        return await self._call("propose", frame)
