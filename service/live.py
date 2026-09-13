"""Live evidence orchestration. All occupancy/readiness decisions run in TS."""

from __future__ import annotations
import asyncio
import base64
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import shutil
import uuid

import cv2
import numpy as np
import psutil

from processor.io import resolve_media
from processor.geometry import rectify_tabletop
from processor.pipeline import DEFAULT_RULES
from .jobs import ServiceError, decode_image


class LiveRun:
    def __init__(self, manager, source, detection_only):
        self.manager, self.jobs, self.source = manager, manager.jobs, source
        self.session_id = uuid.uuid4().hex
        self.epoch = 1
        self.origin = self.jobs.clock()
        tables = deepcopy(source["tables"])
        for table in tables:
            table["surface_method"] = "objects_reference_v1"
            if (table.get("object_baseline") or {}).get("approved"):
                from processor.object_baseline import validate_baseline

                validate_baseline(
                    table["object_baseline"], table, require_approved=True
                )
        fingerprint = [
            {
                "id": t["id"],
                "geometry": t["geometry_sha256"],
                "reference": (t.get("reference") or {}).get("sha256"),
                "baseline": (t.get("object_baseline") or {}).get("baseline_sha256"),
                "config": (t.get("object_baseline") or {}).get("config_sha256"),
            }
            for t in tables
        ]
        self.config = {
            "protocol_version": 1,
            "session_id": self.session_id,
            "epoch": self.epoch,
            "calibration_id": hashlib.sha256(
                json.dumps(fingerprint, sort_keys=True).encode()
            ).hexdigest(),
            "width": source["width"],
            "height": source["height"],
            "sample_hz": 10,
            "tables": tables,
            "rules": deepcopy(DEFAULT_RULES),
            "detection_only": detection_only,
            "evidence_max_age_s": 5,
        }
        self.engine = None
        self.engine_lock = asyncio.Lock()
        self.vision_lock = asyncio.Lock()
        self.vision = self.surface = None
        self.snapshot = None
        self.engine_t = 0.0
        self.closed = False
        self.connected = False
        self.pending = None
        self.frame_ready = asyncio.Event()
        self.in_flight_seq = None
        self.frame_progress = asyncio.Event()
        self.display_frame = None
        self.display_observation = None
        self.assessments = OrderedDict()
        self.surface_ready = asyncio.Event()
        # At most one accepted evidence image per table, kept out of the Node
        # JSONL protocol and never written to disk by a live camera session.
        self.assessment_images = {}
        self.output = asyncio.Queue(maxsize=2)
        self.tasks = []
        self.last_seq = -1
        self.last_capture = -1.0
        self.staff_seq = -1
        self.last_image_t = None
        self.config_revision = 0
        self.capture_floor = 0.0
        self.stats = {
            "processed_frames": 0,
            "dropped_frames": 0,
            "rejected_frames": 0,
            "inference_ms": 0.0,
            "frame_age_s": None,
            "analyzed_fps": 0.0,
            "sampled_peak_rss_bytes": 0,
            "assessment_requests": 0,
            "assessment_results": 0,
            "surface_ms": 0.0,
        }

    def now(self):
        return max(0.0, self.jobs.clock() - self.origin)

    async def start(self):
        command = shutil.which("node")
        if not command:
            raise ServiceError(
                "Node.js is required for the shared live state engine.", 503
            )
        self.engine = await asyncio.create_subprocess_exec(
            command,
            "--import",
            "tsx",
            "web/src/live-headless.ts",
            cwd=Path(__file__).resolve().parents[1],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=8 * 1024 * 1024,
        )
        await self.ask({"op": "init", "config": self.config})
        options = {
            key: self.config[key] for key in ("tables", "width", "height", "session_id")
        }
        options.update(
            model="tiny", model_dir=str(self.jobs.model_dir), intra_threads=4, fps=30
        )
        if "vision_worker" in self.jobs.dependencies:
            self.vision = self.jobs.dependencies["vision_worker"](options)
        else:
            from processor.live_workers import VisionWorker

            self.vision = VisionWorker(options)
        if not self.config["detection_only"]:
            self.surface = self.make_surface_worker()
        self.tasks = [
            asyncio.create_task(self.frames()),
            asyncio.create_task(self.watchdog()),
        ]
        if self.surface:
            self.tasks.append(asyncio.create_task(self.surfaces()))

    def make_surface_worker(self):
        if "surface_worker" in self.jobs.dependencies:
            return self.jobs.dependencies["surface_worker"](self.jobs.model_dir)
        from processor.live_workers import SurfaceWorker

        return SurfaceWorker(self.jobs.model_dir)

    async def assess_surface(self, request, reference, crop):
        if self.surface is None:
            self.surface = self.make_surface_worker()
        worker = self.surface
        remaining = max(
            0.001, self.config["evidence_max_age_s"] - (self.now() - request["t"])
        )
        try:
            return await asyncio.wait_for(worker.assess(reference, crop), remaining)
        except Exception as error:
            # A timed-out native call must release the single surface queue.
            # Cancelling the resident RPC kills its child; start a fresh child
            # on the next eligible request, preserving round-robin ordering.
            self.surface = None
            await worker.close()
            if isinstance(error, asyncio.TimeoutError):
                raise ServiceError(
                    "Tabletop processing timed out; a fresh worker will retry."
                ) from error
            raise

    async def ask(self, command):
        async with self.engine_lock:
            if not self.engine or self.engine.returncode is not None:
                raise ServiceError("Live state engine is unavailable.")
            command = deepcopy(command)
            now = max(self.engine_t, self.now())
            if command["op"] in ("observation", "assessment"):
                command["now"] = now
            elif command["op"] == "staff":
                command["event"]["t"] = now
            elif command["op"] != "init":
                command["t"] = now
            self.engine.stdin.write(
                (json.dumps(command, allow_nan=False) + "\n").encode()
            )
            await self.engine.stdin.drain()
            try:
                line = await asyncio.wait_for(self.engine.stdout.readline(), 5)
            except asyncio.TimeoutError as error:
                raise ServiceError("Live state engine timed out.") from error
            try:
                result = json.loads(line)
            except ValueError as error:
                raise ServiceError(
                    "Live state engine returned an invalid response."
                ) from error
            if "error" in result:
                raise ServiceError(result["error"])
            self.snapshot = result["snapshot"]
            self.engine_t = self.snapshot["t"]
            return result

    def publish(self, frame=None, observation=None, error=None):
        if error:
            value = {"type": "error", "message": str(error)}
        else:
            if frame is not None:
                self.display_frame, self.display_observation = frame, observation
            self.stats["frame_age_s"] = (
                None
                if self.last_image_t is None
                else max(0.0, self.now() - self.last_image_t)
            )
            self.stats["analyzed_fps"] = self.stats["processed_frames"] / max(
                0.001, self.now()
            )
            try:
                process = psutil.Process()
                memory = process.memory_info().rss + sum(
                    child.memory_info().rss
                    for child in process.children(recursive=True)
                    if child.is_running()
                )
                self.stats["sampled_peak_rss_bytes"] = max(
                    self.stats["sampled_peak_rss_bytes"], memory
                )
            except (psutil.Error, OSError):
                pass
            snapshot = deepcopy(self.snapshot)
            for ident, state in (snapshot or {}).get("tables", {}).items():
                assessment = state.get("last_assessment")
                image = self.assessment_images.get(ident)
                if assessment and image and assessment["id"] == image["id"]:
                    assessment["crop_base64"] = image["crop_base64"]
            value = {
                "type": "update",
                "session_id": self.session_id,
                "epoch": self.epoch,
                "t": self.now(),
                "snapshot": snapshot,
                "stats": dict(self.stats),
                "tables": self.jobs.public(self.source["id"])["tables"],
            }
            # Heartbeats can replace queued updates. Keep their image and boxes
            # together so the displayed capture still matches its reported age.
            if self.display_frame is not None:
                value["frame"] = self.display_frame
            if self.display_observation is not None:
                value["observation"] = self.display_observation
        if self.output.full():
            try:
                self.output.get_nowait()
            except asyncio.QueueEmpty:
                pass
        self.output.put_nowait(value)

    def enqueue(self, message):
        if self.closed:
            raise ServiceError("Camera session has stopped.")
        if (
            message.get("session_id") != self.session_id
            or message.get("epoch") != self.epoch
        ):
            raise ServiceError("Camera frame belongs to another session.")
        seq, captured = message.get("seq"), message.get("captured_t")
        if (
            type(seq) is not int
            or seq <= self.last_seq
            or type(captured) not in (int, float)
            or not math.isfinite(captured)
            or captured < 0
            or captured <= self.last_capture
        ):
            raise ServiceError("Camera frame sequence/timestamp is out of order.")
        if (
            captured > self.now() + 0.5
            or self.now() - captured > self.config["rules"]["gap_s"]
        ):
            self.stats["rejected_frames"] += 1
            raise ServiceError(
                "Camera frame is stale or its clock is not synchronized."
            )
        frame, raw = decode_image(
            message.get("image_base64"), self.jobs.limits["frame_bytes"]
        )
        if (frame.shape[1], frame.shape[0]) != (
            self.config["width"],
            self.config["height"],
        ):
            raise ServiceError(
                "Camera dimensions changed. Stop and review camera calibration."
            )
        self.last_seq, self.last_capture = seq, captured
        if self.pending is not None:
            self.stats["dropped_frames"] += 1
        self.pending = (frame, raw, message["image_base64"], seq, captured)
        self.frame_ready.set()

    async def frames(self):
        while not self.closed:
            await self.frame_ready.wait()
            item = self.pending
            self.pending = None
            self.frame_ready.clear()
            if item is None:
                continue
            frame, raw, encoded, seq, captured = item
            revision = self.config_revision
            self.in_flight_seq = seq
            if (
                captured < self.capture_floor
                or self.now() - captured > self.config["rules"]["gap_s"]
            ):
                self.stats["dropped_frames"] += 1
                self.in_flight_seq = None
                self.frame_progress.set()
                continue
            try:
                async with self.vision_lock:
                    result = await self.vision.process_frame(frame, captured, seq)
                if revision != self.config_revision or captured < self.capture_floor:
                    self.stats["dropped_frames"] += 1
                    continue
                observation = result["observation"]
                observation.update(
                    session_id=self.session_id,
                    epoch=self.epoch,
                    calibration_id=self.config["calibration_id"],
                    frame_sha256=hashlib.sha256(raw).hexdigest(),
                )
                self.stats["processed_frames"] += 1
                self.stats["inference_ms"] = (
                    float(result.get("timing", {}).get("inference", 0)) * 1000
                )
                if captured > self.now() + 1e-7:
                    await asyncio.sleep(min(0.5, captured - self.now()))
                    if captured > self.now() + 1e-7:
                        raise ServiceError(
                            "Camera capture remains ahead of the synchronized clock."
                        )
                if self.now() - captured > self.config["rules"]["gap_s"]:
                    self.stats["dropped_frames"] += 1
                    await self.ask({"op": "tick"})
                    self.publish()
                    continue
                if (
                    self.closed
                    or revision != self.config_revision
                    or captured < self.capture_floor
                ):
                    self.stats["dropped_frames"] += 1
                    continue
                reply = await self.ask(
                    {"op": "observation", "observation": observation}
                )
                self.last_image_t = captured
                self.publish(
                    frame={
                        "seq": seq,
                        "captured_t": captured,
                        "image_base64": encoded,
                        "width": frame.shape[1],
                        "height": frame.shape[0],
                    },
                    observation=observation,
                )
                for request in reply["requests"]:
                    table = next(
                        table
                        for table in self.source["tables"]
                        if table["id"] == request["table_id"]
                    )
                    baseline = table.get("object_baseline") or {}
                    if baseline.get("baseline_sha256") != request.get(
                        "baseline_sha256"
                    ) or baseline.get("config_sha256") != request.get("config_sha256"):
                        raise ServiceError(
                            "Expected table setup changed. Review and save its baseline."
                        )
                    crop = rectify_tabletop(frame, table["tabletop_polygon"], 512)
                    reference_bytes = resolve_media(
                        self.jobs.directory(self.source["id"]),
                        table["reference"]["file"],
                    ).read_bytes()
                    if (
                        hashlib.sha256(reference_bytes).hexdigest()
                        != request["reference_sha256"]
                    ):
                        raise ServiceError(
                            "Approved camera reference hash changed. Review and save a new reference."
                        )
                    reference = cv2.imdecode(
                        np.frombuffer(reference_bytes, np.uint8), cv2.IMREAD_COLOR
                    )
                    if reference is None:
                        raise ServiceError(
                            "Approved camera reference image is unavailable."
                        )
                    # A replacement belongs at the back of the queue; repeated
                    # requests from one table cannot starve the other tables.
                    self.assessments.pop(table["id"], None)
                    self.assessments[table["id"]] = (
                        request,
                        cv2.cvtColor(reference, cv2.COLOR_BGR2RGB),
                        cv2.cvtColor(crop, cv2.COLOR_BGR2RGB),
                    )
                    self.stats["assessment_requests"] += 1
                    self.surface_ready.set()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.stats["rejected_frames"] += 1
                self.publish(error=error)
            finally:
                self.in_flight_seq = None
                self.frame_progress.set()

    async def surfaces(self):
        while not self.closed:
            await self.surface_ready.wait()
            if not self.assessments:
                self.surface_ready.clear()
                continue
            _, (request, reference, crop) = self.assessments.popitem(last=False)
            if not self.assessments:
                self.surface_ready.clear()
            state = self.snapshot["tables"].get(request["table_id"], {})
            if (
                self.now() - request["t"] > self.config["evidence_max_age_s"]
                or state.get("generation") != request["generation"]
                or state.get("monitoring_enabled") is False
            ):
                continue
            try:
                result = await self.assess_surface(request, reference, crop)
                ok, data = cv2.imencode(".png", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
                if not ok:
                    raise ServiceError("Could not hash the analyzed tabletop crop.")
                assessment = {
                    **request,
                    **{key: result[key] for key in ("outcome", "valid", "reason")},
                    "id": uuid.uuid4().hex,
                    "request_id": request["id"],
                    "available_t": max(self.now(), request["t"]),
                    "crop_sha256": hashlib.sha256(data.tobytes()).hexdigest(),
                    "model": result.get("model", "yolox_tiny.onnx"),
                }
                if "object_evidence" in result:
                    assessment["object_evidence"] = result["object_evidence"]
                if result.get("config_sha256") and result[
                    "config_sha256"
                ] != request.get("config_sha256"):
                    raise ServiceError(
                        "Tabletop comparison configuration changed during inference."
                    )
                if result.get("error"):
                    assessment["error"] = result["error"]
                await self.ask({"op": "assessment", "result": assessment})
                accepted = (
                    self.snapshot["tables"]
                    .get(request["table_id"], {})
                    .get("last_assessment")
                )
                if accepted and accepted["id"] == assessment["id"]:
                    self.assessment_images[request["table_id"]] = {
                        "id": assessment["id"],
                        "crop_base64": "data:image/png;base64,"
                        + base64.b64encode(data.tobytes()).decode("ascii"),
                    }
                self.stats["assessment_results"] += 1
                self.stats["surface_ms"] = (
                    float(
                        result.get("timing", {}).get(
                            "total", result.get("timing", {}).get("inference", 0)
                        )
                    )
                    * 1000
                )
                self.publish()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self.publish(error=error)

    async def watchdog(self):
        try:
            while not self.closed:
                await asyncio.sleep(0.1)
                await self.ask({"op": "tick"})
                self.publish()
                # An abandoned HTTP-created session must not hold camera/model
                # resources indefinitely when its websocket never connects.
                if not self.connected and self.now() > 30:
                    asyncio.create_task(self.manager.stop(self.session_id))
                    return
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.publish(error=error)
            asyncio.create_task(self.manager.stop(self.session_id))

    async def action(self, message):
        kind = message.get("type")
        ident = message.get("table_id")
        if ident not in {table["id"] for table in self.source["tables"]}:
            raise ServiceError("Unknown table ID.")
        if kind == "staff":
            if message.get("action") in ("confirm_cleaned", "force_cleaned"):
                # Evidence already received must be considered before a guarded
                # clean command. Explicit force_status remains an immediate override.
                target = self.last_seq

                async def prior_frames_finished():
                    while True:
                        self.frame_progress.clear()
                        inflight = (
                            self.in_flight_seq is not None
                            and self.in_flight_seq <= target
                        )
                        pending = self.pending is not None and self.pending[3] <= target
                        if not inflight and not pending:
                            return
                        await self.frame_progress.wait()

                try:
                    await asyncio.wait_for(prior_frames_finished(), 1.0)
                except asyncio.TimeoutError as error:
                    raise ServiceError(
                        "A received camera frame is still being analyzed. Try cleaning confirmation again."
                    ) from error
            self.staff_seq += 1
            event = {
                "id": uuid.uuid4().hex,
                "table_id": ident,
                "action": message.get("action"),
                "t": self.now(),
                "seq": self.staff_seq,
                "source": "staff",
            }
            if "status" in message:
                event["status"] = message["status"]
            await self.ask({"op": "staff", "event": event})
        elif kind in ("monitoring", "rename"):
            command = {"op": kind, "table_id": ident}
            key = "enabled" if kind == "monitoring" else "label"
            command[key] = message.get(key)
            if kind == "monitoring":
                if type(message.get("enabled")) is not bool:
                    raise ServiceError(
                        "Monitoring must be enabled or disabled explicitly."
                    )
                self.config_revision += 1
                self.capture_floor = self.now()
                if self.pending is not None:
                    self.pending = None
                    self.stats["dropped_frames"] += 1
            await self.ask(command)
            table = next(
                table for table in self.source["tables"] if table["id"] == ident
            )
            if kind == "rename":
                table["label"] = message["label"].strip()
            else:
                table["monitoring_enabled"] = message["enabled"]
                self.assessments.pop(ident, None)
                self.assessment_images.pop(ident, None)
                async with self.vision_lock:
                    await self.vision.set_tables(self.source["tables"])
            self.source["revision"] += 1
            self.jobs.persist(self.source)
        else:
            raise ServiceError("Unknown live action.")
        self.publish()

    async def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            if self.engine and self.engine.returncode is None:
                await self.ask({"op": "stop"})
                self.publish()
        except Exception:
            pass
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for worker in (self.vision, self.surface):
            if worker is not None:
                try:
                    await worker.close()
                except Exception:
                    pass
        if self.engine:
            if self.engine.returncode is None:
                self.engine.stdin.close()
                try:
                    await asyncio.wait_for(self.engine.wait(), 2)
                except asyncio.TimeoutError:
                    self.engine.kill()
                    await self.engine.wait()
        self.pending = None
        self.assessments.clear()
        self.assessment_images.clear()
        self.display_frame = None
        self.display_observation = None
        while not self.output.empty():
            self.output.get_nowait()
        self.output.put_nowait({"type": "stopped", "snapshot": self.snapshot})


class LiveManager:
    def __init__(self, jobs):
        self.jobs, self.sessions, self.stopping = jobs, {}, {}

    async def start(self, source_id, detection_only):
        self.jobs.directory(source_id)
        source = self.jobs.sources[source_id]
        if type(detection_only) is not bool:
            raise ServiceError("Choose the analysis mode explicitly.")
        if source["kind"] != "camera" or not source["calibration_confirmed"]:
            raise ServiceError("Save reviewed camera calibration first.")
        self.jobs.require_guided_setup(source, detection_only)
        if self.jobs.active:
            raise ServiceError("Another analysis or camera session is active.", 409)
        await asyncio.to_thread(self.jobs.require_models, detection_only)
        self.jobs.require_guided_setup(source, detection_only)
        run = LiveRun(self, source, detection_only)
        owner = f"live:{run.session_id}"
        self.jobs.reserve(owner)
        self.sessions[run.session_id] = run
        try:
            await run.start()
        except BaseException:
            await run.close()
            self.sessions.pop(run.session_id, None)
            self.jobs.release(owner)
            raise
        return {
            "session_id": run.session_id,
            "epoch": run.epoch,
            "config": run.config,
            "ws_url": f"/api/live/{run.session_id}/stream",
        }

    async def stop(self, ident):
        if ident not in self.stopping:
            run = self.sessions.get(ident)
            if run is None:
                return

            async def cleanup():
                try:
                    await run.close()
                finally:
                    self.sessions.pop(ident, None)
                    self.jobs.release(f"live:{ident}")

            self.stopping[ident] = asyncio.create_task(cleanup())
        task = self.stopping[ident]
        try:
            await asyncio.shield(task)
        finally:
            if task.done():
                self.stopping.pop(ident, None)

    async def close(self):
        for ident in list(self.sessions):
            await self.stop(ident)
