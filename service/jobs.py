"""Persistent uploaded jobs and explicitly saved camera calibration assets."""

from __future__ import annotations
import asyncio
import base64
from copy import deepcopy
import hashlib
import inspect
from io import BytesIO
import json
import math
from pathlib import Path
import shutil
import time
import uuid

import cv2
import numpy as np
from PIL import Image, ImageOps

from processor.io import atomic_json, resolve_media, validate_layout
from processor.images import _save_image_bytes
from processor.geometry import geometry_hash, rectify_tabletop
from processor.video import reference_frame
from . import media


class ServiceError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


async def invoke(function, *args, **kwargs):
    result = function(*args, **kwargs)
    return await result if inspect.isawaitable(result) else result


def decode_image(encoded, max_bytes=2 * 1024 * 1024):
    if not isinstance(encoded, str) or len(encoded) > math.ceil(max_bytes * 4 / 3) + 8:
        raise ServiceError("Camera frame exceeds the image size limit.", 413)
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as error:
        raise ServiceError("Camera frame must be valid base64 JPEG/PNG.") from error
    if len(raw) > max_bytes:
        raise ServiceError("Camera frame exceeds the image size limit.", 413)
    try:
        with Image.open(BytesIO(raw)) as header:
            if header.format not in ("JPEG", "PNG"):
                raise ServiceError("Camera frames must be JPEG or PNG images.")
            if header.width > 1920 or header.height > 1080:
                raise ServiceError("Camera capture must be at most 1920 × 1080.")
    except (OSError, Image.DecompressionBombError) as error:
        raise ServiceError("Camera frame is not a supported image.") from error
    frame = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ServiceError("Camera frame is not a decodable image.")
    if frame.shape[1] > 1920 or frame.shape[0] > 1080:
        raise ServiceError("Camera capture must be at most 1920 × 1080.")
    return frame, raw


def normalized_tables(tables, *, allow_empty=False):
    if not isinstance(tables, list) or (not tables and not allow_empty):
        raise ServiceError("Configure at least one table before saving.")
    values, ids, labels = [], set(), set()
    for item in tables:
        if not isinstance(item, dict):
            raise ServiceError("Each table must contain geometry and a label.")
        table = deepcopy(item)
        ident = table.get("id")
        if not isinstance(ident, str) or not ident or len(ident) > 100 or ident in ids:
            raise ServiceError("Table IDs must be nonempty and unique.")
        ids.add(ident)
        label = table.get("label")
        if not isinstance(label, str) or not 1 <= len(label.strip()) <= 40:
            raise ServiceError("Table labels must contain 1–40 characters.")
        label = label.strip()
        if label.casefold() in labels:
            raise ServiceError("Table labels must be unique, ignoring case.")
        labels.add(label.casefold())
        table["label"] = label
        if (
            "monitoring_enabled" in table
            and type(table["monitoring_enabled"]) is not bool
        ):
            raise ServiceError("Monitoring must be enabled or disabled explicitly.")
        try:
            table["geometry_sha256"] = geometry_hash(table)
        except (ValueError, KeyError, TypeError) as error:
            raise ServiceError(
                f"{ident}: invalid tabletop or occupancy polygon: {error}"
            ) from error
        xs, ys = zip(*table["tabletop_polygon"])
        table["video_region"] = table["crop"] = [min(xs), min(ys), max(xs), max(ys)]
        values.append(table)
    return values


def canonical_setup_image(raw, kind, width, height):
    """Bound before decoding, remove metadata, and return a canonical BGR PNG."""
    try:
        with Image.open(BytesIO(raw)) as header:
            if header.format not in ("JPEG", "PNG"):
                raise ServiceError("Setup images must be JPEG or PNG.")
            if min(header.size) < 2 or header.width * header.height > 16_000_000:
                raise ServiceError(
                    "Setup images must contain at most 16 megapixels.", 413
                )
            if getattr(header, "n_frames", 1) != 1:
                raise ServiceError("Use a single still setup image.")
            header.load()
            image = ImageOps.exif_transpose(header).convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        if isinstance(error, ServiceError):
            raise
        raise ServiceError("Setup image is malformed or unsupported.") from error
    if kind == "clean_reference":
        if type(width) is not int or type(height) is not int or min(width, height) < 2:
            raise ServiceError(
                "Wait for the recording dimensions before uploading its clean photo.",
                409,
            )
        if abs((image.width / image.height) / (width / height) - 1) > 0.01:
            raise ServiceError(
                "Clean photo must match the recording aspect ratio within 1%; use a photo from the same camera."
            )
        image = image.resize((width, height), Image.Resampling.LANCZOS)
    else:
        image.thumbnail((1920, 1080), Image.Resampling.LANCZOS)
    frame = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    ok, encoded = cv2.imencode(".png", frame)
    if not ok:
        raise ServiceError("Could not encode the setup image.")
    return frame, encoded.tobytes()


class JobManager:
    def __init__(self, root, model_dir, dependencies, limits):
        self.root, self.model_dir = Path(root), Path(model_dir)
        self.root.mkdir(parents=True, exist_ok=True)
        self.dependencies, self.limits = dependencies, limits
        self.sources, self.tasks, self.camera_frames = {}, {}, {}
        self._model_fingerprint = None
        self._model_availability = None
        self.active = None
        self.clock = dependencies.get("clock", time.perf_counter)
        for item in self.root.glob("*/source.json"):
            try:
                source = json.loads(item.read_text())
                if source["id"] != item.parent.name:
                    continue
                if source["status"] in ("uploading", "preparing", "analyzing"):
                    source.update(
                        status="failed",
                        error="Service stopped during processing. Retry this source.",
                        phase="interrupted",
                    )
                self.sources[source["id"]] = source
            except (ValueError, KeyError, OSError):
                pass

    def models(self):
        if "models" in self.dependencies:
            return self.dependencies["models"]()
        from processor.live_vision import model_availability

        fingerprint = []
        for name in ("nano", "tiny", "s"):
            path = self.model_dir / f"yolox_{name}.onnx"
            try:
                info = path.stat()
                fingerprint.append(
                    (name, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                )
            except FileNotFoundError:
                fingerprint.append((name, None))
        if fingerprint != self._model_fingerprint:
            result = model_availability(self.model_dir)
            self._model_availability = result
            self._model_fingerprint = fingerprint
        return deepcopy(self._model_availability)

    def require_models(self, detection_only=True):
        models = self.models()
        if not models["detector"]["available"]:
            raise ServiceError(
                models["detector"].get("reason", "YOLOX detector is unavailable."), 503
            )
        if not detection_only and not models["surface"]["available"]:
            raise ServiceError(
                models["surface"].get(
                    "reason",
                    "CPU tabletop detector is unavailable. Select Detection only or install verified YOLOX weights.",
                ),
                503,
            )

    def reserve(self, owner):
        if self.active is not None:
            raise ServiceError(
                "Another analysis or camera session is active. Stop or cancel it first.",
                409,
            )
        self.active = owner

    def release(self, owner):
        if self.active == owner:
            self.active = None

    def directory(self, ident):
        if ident not in self.sources:
            raise ServiceError("Source not found.", 404)
        return self.root / ident

    def persist(self, source):
        atomic_json(self.root / source["id"] / "source.json", source)

    def public(self, ident):
        self.directory(ident)
        source = deepcopy(self.sources[ident])
        source.pop("layout", None)
        for table in source.get("tables", []):
            reference = table.get("reference")
            if reference:
                table["reference_url"] = (
                    f'/api/sources/{ident}/assets/{reference["file"]}'
                )
        if ident in self.camera_frames and not source.get("frame_url"):
            source["frame_base64"] = base64.b64encode(
                self.camera_frames[ident][1]
            ).decode()
        return source

    def new(self, kind, label, **extra):
        ident = uuid.uuid4().hex
        source = {
            "id": ident,
            "kind": kind,
            "label": label,
            "status": "preparing",
            "progress": 0,
            "phase": "preparing",
            "revision": 0,
            "calibration_confirmed": False,
            "setup_mode": "guided_v1",
            "width": 0,
            "height": 0,
            "fps": 30,
            "duration_s": 0,
            "tables": [],
            **extra,
        }
        (self.root / ident).mkdir()
        self.sources[ident] = source
        self.persist(source)
        return source

    def report(self, source):
        def update(phase, fraction, details=None):
            source.update(
                phase=str(phase),
                progress=max(0.0, min(1.0, float(fraction))),
                detail=details or {},
            )
            self.persist(source)

        return update

    def schedule(self, source, action):
        async def run():
            try:
                await action()
            except asyncio.CancelledError:
                source.update(status="cancelled", phase="cancelled", progress=0)
                self._remove_transient(source)
                raise
            except Exception as error:
                source.update(status="failed", phase="failed", error=str(error)[:2000])
                if not source.get("calibration_confirmed"):
                    self._remove_transient(source)
            finally:
                self.release(source["id"])
                self.persist(source)

        self.tasks[source["id"]] = asyncio.create_task(run())

    def _remove_transient(self, source):
        self.camera_frames.pop(source["id"], None)
        directory = self.directory(source["id"])
        # Saved camera calibration is deliberate persistent data, unlike captures.
        if source["kind"] == "camera" and source["calibration_confirmed"]:
            return
        for path in directory.iterdir():
            if path.name == "source.json":
                continue
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink(missing_ok=True)

    async def upload(self, upload, manual_setup=False):
        suffix = Path(upload.filename or "").suffix.lower()
        if suffix not in (".mp4", ".mov", ".webm"):
            raise ServiceError("Choose an MP4, MOV or WebM video.")
        if self.active:
            raise ServiceError("Another analysis or camera is active.", 409)
        if not manual_setup:
            await asyncio.to_thread(self.require_models)
        if self.active:
            raise ServiceError("Another analysis or camera is active.", 409)
        source = self.new("video", Path(upload.filename or "Video").name)
        self.reserve(source["id"])
        source["status"] = "uploading"
        path = self.directory(source["id"]) / f"upload{suffix}"
        total = 0
        try:
            with path.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    total += len(chunk)
                    if total > self.limits["upload_bytes"]:
                        raise ServiceError("Video exceeds the upload size limit.", 413)
                    if (
                        shutil.disk_usage(self.root).free
                        < len(chunk) + self.limits["disk_reserve_bytes"]
                    ):
                        raise ServiceError(
                            "Not enough free disk space for this upload.", 507
                        )
                    output.write(chunk)
            if not total:
                raise ServiceError("Uploaded video is empty.")
            # Media validation belongs to ingress, ahead of any injected or real
            # inference preparation. An extension/MIME type is not evidence.
            metadata = await media.probe(path)
            if metadata["duration_s"] > self.limits["duration_s"]:
                raise ServiceError("Video exceeds the configured duration limit.")
            source.update(status="preparing", uploaded_bytes=total)
        except BaseException:
            source.update(
                status="failed", phase="failed", error="Upload did not complete."
            )
            self.release(source["id"])
            self._remove_transient(source)
            self.persist(source)
            raise
        finally:
            await upload.close()

        async def prepare():
            report = self.report(source)
            if manual_setup:
                layout = await media.prepare_video(
                    path,
                    self.directory(source["id"]),
                    report,
                    model_dir=self.model_dir,
                    duration_limit=self.limits["duration_s"],
                    manual_setup=True,
                )
            elif "prepare_video" in self.dependencies:
                layout = await invoke(
                    self.dependencies["prepare_video"],
                    path,
                    self.directory(source["id"]),
                    report,
                )
            else:
                layout = await media.prepare_video(
                    path,
                    self.directory(source["id"]),
                    report,
                    model_dir=self.model_dir,
                    duration_limit=self.limits["duration_s"],
                )
            if layout["video"]["duration_s"] > self.limits["duration_s"]:
                raise ServiceError("Video exceeds the configured duration limit.")
            source.update(
                layout=layout,
                tables=layout["tables"],
                width=layout["video"]["width"],
                height=layout["video"]["height"],
                fps=layout["video"]["fps"],
                duration_s=layout["video"]["duration_s"],
                status="needs_setup",
                phase="Draw tables manually" if manual_setup else "Review table setup",
                progress=1,
                media_url=f'/api/sources/{source["id"]}/assets/{layout["video"]["file"]}',
                frame_url=f'/api/sources/{source["id"]}/assets/{layout["original_scene"]}',
            )
            atomic_json(self.directory(source["id"]) / "layout.json", layout)

        self.schedule(source, prepare)
        return self.public(source["id"])

    async def camera(self, payload):
        if self.active:
            raise ServiceError("Another analysis or camera is active.", 409)
        await asyncio.to_thread(self.require_models)
        if self.active:
            raise ServiceError("Another analysis or camera is active.", 409)
        frame, raw = decode_image(
            payload.get("image_base64"), self.limits["frame_bytes"]
        )
        # Only the currently reviewed, unsaved setup needs a full capture in RAM.
        for previous_id in list(self.camera_frames):
            previous = self.sources[previous_id]
            if not previous["calibration_confirmed"]:
                previous.update(
                    status="cancelled", phase="Superseded by a new camera setup"
                )
                self._remove_transient(previous)
                self.persist(previous)
        source = self.new(
            "camera",
            str(payload.get("label", "Camera"))[:100],
            device_key=str(payload.get("device_key", ""))[:300],
            width=frame.shape[1],
            height=frame.shape[0],
        )
        self.camera_frames[source["id"]] = (frame, raw)
        self.reserve(source["id"])

        async def prepare():
            if "propose_tables" in self.dependencies:
                tables = await invoke(self.dependencies["propose_tables"], frame)
            else:
                from processor.live_workers import ProposalWorker

                worker = ProposalWorker(self.model_dir)
                try:
                    tables = await worker.propose(frame)
                finally:
                    await asyncio.shield(worker.close())
            source.update(
                tables=tables,
                status="needs_setup",
                phase="Review table setup",
                progress=1,
            )

        self.schedule(source, prepare)
        return self.public(source["id"])

    async def frame(self, ident, t):
        source, directory = self.sources[ident], self.directory(ident)
        if source["kind"] != "video":
            raise ServiceError("Camera setup uses its captured frame.")
        if (
            not isinstance(t, (float, int))
            or isinstance(t, bool)
            or not math.isfinite(t)
            or not 0 <= t < source["duration_s"]
        ):
            raise ServiceError("Reference timestamp must lie inside the video.")
        value, captured, _, _ = await asyncio.to_thread(
            reference_frame,
            resolve_media(directory, source["layout"]["video"]["file"]),
            t,
        )
        ok, data = cv2.imencode(".png", value)
        if not ok:
            raise ServiceError("Could not encode the selected frame.")
        digest = hashlib.sha256(data.tobytes()).hexdigest()
        relative = f"setup/frame-{digest[:16]}.png"
        (directory / "setup").mkdir(exist_ok=True)
        (directory / relative).write_bytes(data.tobytes())
        return {
            "url": f"/api/sources/{ident}/assets/{relative}",
            "t": captured,
            "sha256": digest,
            "width": value.shape[1],
            "height": value.shape[0],
        }

    async def setup_asset(self, ident, kind, upload, revision):
        """Persist an unapproved setup image without acquiring inference authority."""
        owner = f"setup-asset:{ident}"
        reserved = False
        try:
            directory = self.directory(ident)
            if kind not in ("clean_reference", "floor_plan"):
                raise ServiceError("Choose clean_reference or floor_plan.")
            self.reserve(owner)
            reserved = True
            source = self.sources[ident]
            if type(revision) is not int or revision != source["revision"]:
                raise ServiceError(
                    "Calibration changed. Reload the latest revision.", 409
                )
            if source["status"] in ("uploading", "preparing", "analyzing", "cancelled"):
                raise ServiceError(
                    "Wait for source preparation before uploading setup images.", 409
                )
            maximum = self.limits.get("setup_asset_bytes", 12 * 1024 * 1024)
            chunks, total = [], 0
            while chunk := await upload.read(min(1024 * 1024, maximum + 1)):
                total += len(chunk)
                if total > maximum:
                    raise ServiceError(
                        "Setup image exceeds the 12 MB input limit.", 413
                    )
                chunks.append(chunk)
            if not total:
                raise ServiceError("Setup image is empty.")
            frame, encoded = await asyncio.to_thread(
                canonical_setup_image,
                b"".join(chunks),
                kind,
                source["width"],
                source["height"],
            )
            if revision != source["revision"] or source["status"] == "cancelled":
                raise ServiceError(
                    "Source setup changed while the image was being decoded. Upload it again.",
                    409,
                )
            if (
                shutil.disk_usage(self.root).free
                < len(encoded) + self.limits["disk_reserve_bytes"]
            ):
                raise ServiceError(
                    "Not enough free disk space for the setup image.", 507
                )
            digest = hashlib.sha256(encoded).hexdigest()
            relative = f"setup-assets/{kind}-{digest[:16]}.png"
            image = {
                "file": relative,
                "sha256": digest,
                "width": frame.shape[1],
                "height": frame.shape[0],
            }
            assets = deepcopy(source.get("setup_assets", {}))
            changed = (assets.get(kind) or {}).get("sha256") != digest
            assets[kind] = image
            tables, invalidated = deepcopy(source["tables"]), False
            if kind == "clean_reference" and changed:
                for table in tables:
                    if (
                        table.get("reference_source") == "uploaded_image"
                        or (table.get("reference") or {}).get("source_kind")
                        == "uploaded_image"
                    ):
                        table.update(
                            reference=None,
                            reference_source="uploaded_image",
                            reference_image_sha256=digest,
                            alignment_confirmed=False,
                            reference_approved=False,
                        )
                        for key in (
                            "object_baseline",
                            "baseline_sha256",
                            "config_sha256",
                            "expected_objects_draft",
                        ):
                            table.pop(key, None)
                        invalidated = True
                if (source.get("setup_reference") or {}).get(
                    "reference_source"
                ) == "uploaded_image":
                    source["setup_reference"] = {
                        **source["setup_reference"],
                        "reference_t": None,
                        "reference_image_sha256": digest,
                        "alignment_confirmed": False,
                    }
            if (
                kind == "floor_plan"
                and changed
                and source.get("setup_mode") == "guided_v1"
                and source.get("floor_plan_mode") == "uploaded"
            ):
                for table in tables:
                    table["setup_review"] = {
                        **table.get(
                            "setup_review",
                            {"tabletop": False, "occupancy": False, "map": False},
                        ),
                        "map": False,
                    }
                invalidated = True
            _save_image_bytes(directory / relative, encoded)
            source.update(setup_assets=assets, tables=tables, revision=revision + 1)
            if invalidated:
                source.update(
                    calibration_confirmed=False,
                    status="needs_setup",
                    phase=(
                        "Align and approve the replacement clean photo"
                        if kind == "clean_reference"
                        else "Review table positions on the replacement floor plan"
                    ),
                )
                source.pop("manifest_url", None)
            if source.get("layout") is not None:
                layout = deepcopy(source["layout"])
                layout.update(
                    tables=tables,
                    setup_assets=deepcopy(assets),
                    calibration_confirmed=source["calibration_confirmed"],
                )
                if "setup_reference" in source:
                    layout["setup_reference"] = deepcopy(source["setup_reference"])
                if kind == "floor_plan" and source.get("floor_plan_mode") == "uploaded":
                    layout["floor_plan"] = deepcopy(image)
                source["layout"] = layout
                atomic_json(directory / "layout.json", layout)
            if (
                kind == "floor_plan"
                and source.get("floor_plan_mode") == "uploaded"
                and source["status"] == "completed"
            ):
                # The floor plan is presentation metadata. Keep existing evidence
                # and approved inventories while updating the current display.
                bundle = json.loads((directory / "bundle.json").read_text())
                bundle["floor_plan"] = deepcopy(image)
                atomic_json(directory / "bundle.json", bundle)
            self.persist(source)
            return self.public(ident)
        finally:
            await upload.close()
            if reserved:
                self.release(owner)

    def _external_reference_image(self, ident, table):
        source, directory = self.sources[ident], self.directory(ident)
        asset = (source.get("setup_assets") or {}).get("clean_reference")
        if not isinstance(asset, dict):
            raise ServiceError(
                "Upload a clean camera photo before selecting it as the reference."
            )
        if table.get("alignment_confirmed") is not True:
            raise ServiceError(
                "Confirm that the clean photo aligns with this recording before approving its reference."
            )
        if table.get("reference_image_sha256") != asset["sha256"]:
            raise ServiceError(
                "The clean photo changed. Review its alignment and generate a new object proposal.",
                409,
            )
        path = resolve_media(directory, asset["file"])
        if hashlib.sha256(path.read_bytes()).hexdigest() != asset["sha256"]:
            raise ServiceError(
                "Saved clean photo changed. Upload and review a new photo.", 409
            )
        current = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if current is None or current.shape[:2] != (source["height"], source["width"]):
            raise ServiceError(
                "Saved clean photo does not match the calibrated recording dimensions.",
                409,
            )
        return current, deepcopy(asset)

    async def _setup_crop(self, ident, table, target):
        """Read exactly the selected source frame without persisting a proposal."""
        source, directory = self.sources[ident], self.directory(ident)
        reference_source = table.get("reference_source", "video_frame")
        if reference_source not in ("video_frame", "uploaded_image"):
            raise ServiceError("Unknown reference source.")
        if reference_source == "uploaded_image":
            if target is None:
                target = 0
            if type(target) not in (int, float) or target != 0:
                raise ServiceError(
                    "Uploaded clean photos are available from the start; their reference timestamp must be zero."
                )
            current, _ = self._external_reference_image(ident, table)
            captured = 0.0
        elif source["kind"] == "camera":
            if type(target) not in (int, float) or target != 0:
                raise ServiceError("Camera reference timestamp must be zero.")
            current = (
                self.camera_frames[ident][0]
                if ident in self.camera_frames
                else cv2.imread(str(directory / "original_scene.png"))
            )
            if current is None:
                raise ServiceError(
                    "Camera setup frame is unavailable. Capture a new setup."
                )
            captured = 0.0
        else:
            if (
                type(target) not in (int, float)
                or not math.isfinite(target)
                or not 0 <= target < source["duration_s"]
            ):
                raise ServiceError("Reference timestamp must lie inside the video.")
            path = resolve_media(directory, source["layout"]["video"]["file"])

            def verify_source():
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if digest != source["layout"]["video"]["sha256"]:
                    raise ServiceError(
                        "Source recording changed. Upload the recording again.", 409
                    )

            await asyncio.to_thread(verify_source)
            current, captured, _, _ = await asyncio.to_thread(
                reference_frame, path, target
            )
        crop = rectify_tabletop(current, table["tabletop_polygon"], 512)
        ok, data = cv2.imencode(".png", crop)
        if not ok:
            raise ServiceError("Could not capture reset reference.")
        encoded = data.tobytes()
        return crop, encoded, hashlib.sha256(encoded).hexdigest(), captured

    async def baseline_proposal(self, ident, payload):
        """Return inspectable, unapproved evidence; never save or alter a source."""
        from processor.object_baseline import build_baseline

        self.directory(ident)
        source = self.sources[ident]
        revision = payload.get("revision")
        if type(revision) is not int or revision != source["revision"]:
            raise ServiceError("Calibration changed. Reload the latest revision.", 409)
        if source["status"] in ("preparing", "analyzing", "uploading", "cancelled"):
            raise ServiceError("Wait for source preparation to finish.", 409)
        table_id = payload.get("table_id")
        if not isinstance(table_id, str) or not 1 <= len(table_id) <= 100:
            raise ServiceError("A valid table ID is required.")
        previous = next(
            (table for table in source["tables"] if table["id"] == table_id), {}
        )
        table = {
            "tabletop_polygon": payload.get("tabletop_polygon"),
            "occupancy_regions": payload.get(
                "occupancy_regions", previous.get("occupancy_regions")
            ),
            "reference_source": payload.get("reference_source", "video_frame"),
            "reference_image_sha256": payload.get("reference_image_sha256"),
            "alignment_confirmed": payload.get("alignment_confirmed"),
        }
        try:
            geometry = geometry_hash(table)
        except (ValueError, TypeError, KeyError) as error:
            raise ServiceError(f"Invalid table geometry: {error}") from error
        target = payload.get("reference_t", 0)
        await asyncio.to_thread(self.require_models, False)
        owner = f"baseline:{ident}"
        self.reserve(owner)
        try:
            if revision != source["revision"]:
                raise ServiceError(
                    "Calibration changed. Reload the latest revision.", 409
                )
            crop, encoded, reference_sha, captured = await self._setup_crop(
                ident, table, target
            )
            rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
            if "propose_baseline" in self.dependencies:
                result = await asyncio.wait_for(
                    invoke(self.dependencies["propose_baseline"], rgb), 30
                )
            else:
                from processor.live_workers import SurfaceWorker

                worker = SurfaceWorker(self.model_dir)
                try:
                    result = await asyncio.wait_for(worker.propose(rgb), 30)
                finally:
                    await asyncio.shield(worker.close())
            if revision != source["revision"] or source["status"] == "cancelled":
                raise ServiceError(
                    "Calibration changed while the proposal was running. Review a new proposal.",
                    409,
                )
            from processor.object_surface import validate_detections

            try:
                if not isinstance(result, dict):
                    raise ValueError("Expected detector evidence object")
                detections = validate_detections(result.get("detections"))
                if not isinstance(result.get("detector_sha256"), str) or result[
                    "detector_sha256"
                ] != self.models()["detector"].get("sha256"):
                    raise ValueError("Detector identity changed during proposal")
            except ValueError as error:
                raise ServiceError(
                    f"Detector returned malformed object evidence: {error}", 503
                ) from error
            counts = {}
            for detection in detections:
                if (
                    detection["class_id"] not in (0, 56, 60)
                    and detection["score"] >= 0.5
                ):
                    counts[detection["class_id"]] = (
                        counts.get(detection["class_id"], 0) + 1
                    )
            baseline = build_baseline(
                [
                    {"class_id": key, "count": value}
                    for key, value in sorted(counts.items())
                ],
                reference_sha,
                geometry,
                result["detector_sha256"],
                approved=False,
            )
            return {
                "baseline": baseline,
                "detections": detections,
                "frame_base64": "data:image/png;base64,"
                + base64.b64encode(encoded).decode(),
                "reference_t": captured,
                "geometry_sha256": geometry,
                "reference_sha256": reference_sha,
                "revision": revision,
                "reference_source": table["reference_source"],
                "reference_image_sha256": table.get("reference_image_sha256"),
                "alignment_confirmed": table.get("alignment_confirmed") is True,
            }
        except asyncio.TimeoutError as error:
            raise ServiceError(
                "Tabletop proposal timed out. Try again.", 503
            ) from error
        finally:
            self.release(owner)

    async def calibration(self, ident, payload):
        self.directory(ident)
        owner = f"calibration:{ident}"
        self.reserve(owner)
        try:
            return await self._save_calibration(ident, payload)
        finally:
            self.release(owner)

    def _setup_reference_selection(self, source, value, *, confirmed=False):
        if not isinstance(value, dict) or set(value) - {
            "reference_source",
            "reference_t",
            "reference_image_sha256",
            "alignment_confirmed",
        }:
            raise ServiceError("Invalid setup reference selection.")
        kind, target = value.get("reference_source"), value.get("reference_t")
        if (
            kind not in ("video_frame", "uploaded_image")
            or "reference_t" not in value
            or type(value.get("alignment_confirmed")) is not bool
        ):
            raise ServiceError(
                "Choose a reference source, timestamp and explicit alignment state."
            )
        if kind == "uploaded_image":
            if (
                value.get("reference_image_sha256") is None
                and value["alignment_confirmed"] is False
                and target is None
                and not confirmed
            ):
                return {
                    "reference_source": "uploaded_image",
                    "reference_t": None,
                    "alignment_confirmed": False,
                }
            asset = (source.get("setup_assets") or {}).get("clean_reference")
            if not asset or value.get("reference_image_sha256") != asset["sha256"]:
                raise ServiceError(
                    "The selected clean photo changed. Select the current photo again.",
                    409,
                )
            if target is not None and (type(target) not in (int, float) or target != 0):
                raise ServiceError("Uploaded photos do not have a recording timestamp.")
            return {**value, "reference_t": None}
        if value.get("reference_image_sha256") is not None:
            raise ServiceError(
                "Recording reference selections cannot carry an uploaded photo identity."
            )
        if target is not None:
            valid = type(target) in (int, float) and math.isfinite(target)
            valid = valid and (
                target == 0
                if source["kind"] == "camera"
                else 0 <= target < source["duration_s"]
            )
            if not valid:
                raise ServiceError(
                    "Reference timestamp must lie inside the recording, or be unselected."
                )
        return {
            "reference_source": "video_frame",
            "reference_t": target,
            "alignment_confirmed": False,
        }

    async def _save_calibration(self, ident, payload):
        directory = self.directory(ident)
        source = self.sources[ident]
        if (
            type(payload.get("revision")) is not int
            or payload.get("revision") != source["revision"]
        ):
            raise ServiceError("Calibration changed. Reload the latest revision.", 409)
        setup_mode = payload.get("setup_mode", source.get("setup_mode"))
        if setup_mode not in (None, "guided_v1") or (
            source.get("setup_mode") == "guided_v1" and setup_mode != "guided_v1"
        ):
            raise ServiceError("Unsupported setup mode.")
        guided = setup_mode == "guided_v1"
        if type(payload.get("confirmed")) is not bool or (
            not guided and not payload["confirmed"]
        ):
            raise ServiceError("Review and confirm the table setup before saving.")
        confirmed = payload["confirmed"]
        if source["status"] in ("preparing", "analyzing", "uploading", "cancelled"):
            raise ServiceError(
                "Wait for current processing to finish or start a new source.", 409
            )
        tables = normalized_tables(
            payload.get("tables"), allow_empty=guided and not confirmed
        )
        floor_plan_mode = payload.get("floor_plan_mode", source.get("floor_plan_mode"))
        selection = deepcopy(source.get("setup_reference"))
        if "setup_reference" in payload:
            selection = payload["setup_reference"]
        if selection is not None:
            selection = self._setup_reference_selection(
                source, selection, confirmed=confirmed
            )
        if floor_plan_mode not in (None, "uploaded", "schematic"):
            raise ServiceError(
                "Choose an uploaded floor plan or an explicit schematic map."
            )
        if guided:
            if confirmed and floor_plan_mode is None:
                raise ServiceError(
                    "Choose an uploaded floor plan or confirm the schematic map before finishing setup."
                )
            if floor_plan_mode == "uploaded" and not (
                source.get("setup_assets") or {}
            ).get("floor_plan"):
                raise ServiceError("Upload the floor plan before selecting it.")
            for table in tables:
                review = table.get(
                    "setup_review",
                    {"tabletop": False, "occupancy": False, "map": False},
                )
                if (
                    not isinstance(review, dict)
                    or set(review) != {"tabletop", "occupancy", "map"}
                    or any(type(value) is not bool for value in review.values())
                ):
                    raise ServiceError(
                        "Table review requires explicit tabletop, occupancy and map confirmations."
                    )
                if (
                    confirmed
                    and table.get("monitoring_enabled", True)
                    and not all(review.values())
                ):
                    raise ServiceError(
                        "Review each enabled table boundary, occupancy region and floor-plan position before finishing setup."
                    )
                table["setup_review"] = review
        old = {table["id"]: table for table in source["tables"]}
        if (
            source.get("calibration_saved_once") or source.get("calibration_confirmed")
        ) and not set(old).issubset(table["id"] for table in tables):
            raise ServiceError(
                "Saved table IDs cannot be removed. Disable the table to preserve history."
            )
        camera = source["kind"] == "camera"
        references = directory / "references"
        references.mkdir(exist_ok=True)
        setup_frame = None
        if camera:
            if ident in self.camera_frames:
                setup_frame, raw = self.camera_frames[ident]
            else:
                setup_frame = cv2.imread(str(directory / "original_scene.png"))
                raw = (
                    (directory / "original_scene.png").read_bytes()
                    if setup_frame is not None
                    else None
                )
            if setup_frame is None:
                raise ServiceError(
                    "Camera setup frame is unavailable. Capture a new setup."
                )
        geometry_changed = set(old) != {table["id"] for table in tables} or any(
            old.get(t["id"], {}).get("geometry_sha256") != t["geometry_sha256"]
            for t in tables
        )
        for index, table in enumerate(tables):
            previous = old.get(table["id"], {})
            prior_reference = previous.get("reference")
            reference_source = table.get(
                "reference_source",
                previous.get(
                    "reference_source",
                    (prior_reference or {}).get(
                        "source_kind",
                        (selection or {}).get("reference_source", "video_frame"),
                    ),
                ),
            )
            if reference_source not in ("video_frame", "uploaded_image"):
                raise ServiceError("Unknown reference source.")
            table["reference_source"] = reference_source
            if reference_source == "uploaded_image":
                table.setdefault(
                    "reference_image_sha256",
                    previous.get(
                        "reference_image_sha256",
                        ((prior_reference or {}).get("source_image") or {}).get(
                            "sha256", (selection or {}).get("reference_image_sha256")
                        ),
                    ),
                )
                table.setdefault(
                    "alignment_confirmed",
                    previous.get(
                        "alignment_confirmed",
                        (prior_reference or {}).get(
                            "alignment_confirmed",
                            (selection or {}).get("alignment_confirmed", False),
                        ),
                    ),
                )
            approved = table.get(
                "reference_approved",
                (
                    previous.get("reference", {}).get("confirmed_clean", False)
                    if previous.get("reference")
                    else False
                ),
            )
            if type(approved) is not bool:
                raise ServiceError("Reference approval must be explicit.")
            target = table.get(
                "reference_t",
                previous.get(
                    "reference_t",
                    (prior_reference or {}).get(
                        "source_t", (selection or {}).get("reference_t", 0)
                    ),
                ),
            )
            if reference_source == "uploaded_image" and target is None:
                target = 0
            from processor.object_baseline import validate_inventory, CONFIG_SHA256
            from processor.models import MODEL_HASHES

            draft_expected = table.get(
                "expected_objects_draft", previous.get("expected_objects_draft")
            )
            incoming_baseline = table.get("object_baseline")
            if (
                not confirmed
                and isinstance(incoming_baseline, dict)
                and incoming_baseline.get("approved") is False
            ):
                draft_expected = incoming_baseline.get("expected")
                # Validate even when changed geometry would otherwise discard it.
                validate_inventory(draft_expected)
            old_source = previous.get(
                "reference_source",
                (prior_reference or {}).get("source_kind", "video_frame"),
            )
            old_target = previous.get(
                "reference_t", (prior_reference or {}).get("source_t", 0)
            )
            if old_source == "uploaded_image" and old_target is None:
                old_target = 0
            changed_selection = bool(previous) and (
                previous.get("geometry_sha256") != table["geometry_sha256"]
                or old_source != reference_source
                or old_target != target
                or (
                    reference_source == "uploaded_image"
                    and previous.get(
                        "reference_image_sha256",
                        ((prior_reference or {}).get("source_image") or {}).get(
                            "sha256"
                        ),
                    )
                    != table.get("reference_image_sha256")
                )
            )
            if draft_expected is not None:
                draft_expected = validate_inventory(draft_expected)
            if (
                not confirmed
                and isinstance(incoming_baseline, dict)
                and incoming_baseline.get("approved") is False
            ):
                # A newly generated proposal can accompany a newly drawn table.
                # Retain those edits only if its pixels and geometry identify the
                # current selection; old quantities otherwise lose their scope.
                can_check = target is not None and (
                    reference_source != "uploaded_image"
                    or table.get("alignment_confirmed") is True
                )
                candidate_current = False
                if (
                    can_check
                    and incoming_baseline.get("geometry_sha256")
                    == table["geometry_sha256"]
                    and incoming_baseline.get("config_sha256") == CONFIG_SHA256
                    and incoming_baseline.get("detector_sha256") == MODEL_HASHES["tiny"]
                ):
                    _, _, candidate_sha, _ = await self._setup_crop(
                        ident, table, target
                    )
                    if candidate_sha == incoming_baseline.get("reference_sha256"):
                        candidate_current = True
                if candidate_current:
                    changed_selection = False
                else:
                    draft_expected = None
            if changed_selection or draft_expected is None:
                table.pop("expected_objects_draft", None)
            else:
                table["expected_objects_draft"] = draft_expected
            table["reference_t"] = (
                None if reference_source == "uploaded_image" else target
            )
            if target is None or not approved:
                table["reference"] = None
                table["reference_approved"] = False
                table.pop("object_baseline", None)
                table.pop("baseline_sha256", None)
                table.pop("config_sha256", None)
                table["surface_method"] = "objects_reference_v1"
                continue
            external_asset = None
            if reference_source == "uploaded_image":
                _, external_asset = self._external_reference_image(ident, table)
            same_reference = (
                prior_reference
                and prior_reference.get("confirmed_clean")
                and table["geometry_sha256"] == previous.get("geometry_sha256")
                and target == prior_reference["source_t"]
                and prior_reference.get("source_kind", "video_frame")
                == reference_source
                and (
                    reference_source != "uploaded_image"
                    or (prior_reference.get("source_image") or {}).get("sha256")
                    == external_asset["sha256"]
                )
            )
            if same_reference:
                table.update(
                    reference=deepcopy(prior_reference),
                    reference_t=target,
                    reference_approved=True,
                )
                digest = prior_reference["sha256"]
                reference_path = resolve_media(directory, prior_reference["file"])
                if (
                    not reference_path.is_file()
                    or hashlib.sha256(reference_path.read_bytes()).hexdigest() != digest
                ):
                    raise ServiceError(
                        "Saved reference changed. Select and approve a new reset frame.",
                        409,
                    )
                if table.get("object_baseline") is not None:
                    _, _, current_sha, _ = await self._setup_crop(ident, table, target)
                    if current_sha != digest:
                        raise ServiceError(
                            "Source frame changed. Generate and approve a new object proposal.",
                            409,
                        )
            else:
                _, encoded, digest, captured = await self._setup_crop(
                    ident, table, target
                )
                relative = f"references/table-{index + 1}-{digest[:16]}.png"
                (directory / relative).write_bytes(encoded)
                table.update(
                    reference={
                        "file": relative,
                        "source_t": captured,
                        "confirmed_clean": True,
                        "sha256": digest,
                        "reviewed_by": "operator_setup_approval",
                        "source_kind": reference_source,
                    },
                    reference_t=captured,
                    reference_approved=True,
                )
                if external_asset is not None:
                    table["reference"].update(
                        source_image=external_asset, alignment_confirmed=True
                    )
            proposal = table.get("object_baseline")
            if proposal is not None:
                from processor.object_baseline import build_baseline, CONFIG_SHA256

                if (
                    not isinstance(proposal, dict)
                    or type(proposal.get("approved")) is not bool
                ):
                    raise ServiceError("Expected objects require explicit approval.")
                # Recompute identity on the server after operator quantity edits. Geometry,
                # source frame, detector or threshold changes never approve stale evidence.
                models = await asyncio.to_thread(self.models)
                detector_sha = models["detector"].get("sha256")
                matching = (
                    proposal.get("reference_sha256") == digest
                    and proposal.get("geometry_sha256") == table["geometry_sha256"]
                    and proposal.get("config_sha256") == CONFIG_SHA256
                    and proposal.get("detector_sha256") == detector_sha
                    and bool(detector_sha)
                )
                if matching:
                    table["object_baseline"] = build_baseline(
                        proposal.get("expected"),
                        digest,
                        table["geometry_sha256"],
                        detector_sha,
                        approved=proposal["approved"],
                    )
                    table["baseline_sha256"] = table["object_baseline"][
                        "baseline_sha256"
                    ]
                    table["config_sha256"] = table["object_baseline"]["config_sha256"]
                else:
                    # Never reuse proposal authority across changed source identities.
                    table.pop("object_baseline", None)
                    table.pop("baseline_sha256", None)
                    table.pop("config_sha256", None)
            if proposal is None:
                table.pop("baseline_sha256", None)
                table.pop("config_sha256", None)
            if (table.get("object_baseline") or {}).get("approved") is True:
                table.pop("expected_objects_draft", None)
            table["surface_method"] = "objects_reference_v1"
        if (
            payload.get("revision") != source["revision"]
            or source["status"] == "cancelled"
        ):
            raise ServiceError("Calibration changed. Reload the latest revision.", 409)
        geometry_changed = geometry_changed or any(
            (old.get(table["id"], {}).get("reference") or {}).get("sha256")
            != (table.get("reference") or {}).get("sha256")
            for table in tables
        )
        geometry_changed = geometry_changed or any(
            (old.get(table["id"], {}).get("object_baseline") or {}).get(
                "baseline_sha256"
            )
            != (table.get("object_baseline") or {}).get("baseline_sha256")
            or old.get(table["id"], {}).get("surface_method")
            != table.get("surface_method")
            for table in tables
        )
        # Validate map geometry and full table contract without inventing a live
        # video identity. Camera tables use the same geometric validator below.
        if camera:
            for table in tables:
                position = table.get("map", {})
                if (
                    any(
                        type(position.get(k)) not in (int, float)
                        or not math.isfinite(position[k])
                        or not 0 <= position[k] <= 1
                        for k in ("x", "y", "w", "h")
                    )
                    or position["w"] <= 0
                    or position["h"] <= 0
                    or position.get("shape") not in ("rect", "round")
                ):
                    raise ServiceError(
                        "Map positions and sizes must use normalized coordinates."
                    )
                rotation = position.get("rotation", 0)
                if (
                    type(rotation) not in (int, float)
                    or not math.isfinite(rotation)
                    or not 0 <= rotation < 360
                ):
                    raise ServiceError(
                        "Map rotation must use degrees from 0 to less than 360."
                    )
            if not cv2.imwrite(str(directory / "original_scene.png"), setup_frame):
                raise ServiceError(
                    "Could not save the approved camera setup frame.", 507
                )
            source["frame_url"] = f"/api/sources/{ident}/assets/original_scene.png"
        else:
            layout = deepcopy(source["layout"])
            layout.update(tables=tables, calibration_confirmed=confirmed)
            if guided:
                layout["setup_mode"] = setup_mode
            if selection is not None:
                layout["setup_reference"] = deepcopy(selection)
            if floor_plan_mode is not None:
                layout["floor_plan_mode"] = floor_plan_mode
            if floor_plan_mode == "uploaded":
                layout["floor_plan"] = deepcopy(source["setup_assets"]["floor_plan"])
            elif floor_plan_mode == "schematic":
                layout.pop("floor_plan", None)
            if tables:
                validate_layout(layout)
            source["layout"] = layout
            atomic_json(directory / "layout.json", layout)
            if source["status"] == "completed" and not geometry_changed:
                bundle = json.loads((directory / "bundle.json").read_text())
                bundle["tables"] = tables
                if layout.get("floor_plan") is not None:
                    bundle["floor_plan"] = deepcopy(layout["floor_plan"])
                else:
                    bundle.pop("floor_plan", None)
                for key in ("setup_mode", "floor_plan_mode"):
                    if key in layout:
                        bundle[key] = layout[key]
                atomic_json(directory / "bundle.json", bundle)
        source.update(
            tables=tables,
            revision=source["revision"] + 1,
            calibration_confirmed=confirmed,
        )
        if confirmed:
            source["calibration_saved_once"] = True
        if guided:
            source["setup_mode"] = setup_mode
        if selection is not None:
            source["setup_reference"] = selection
        if floor_plan_mode is not None:
            source["floor_plan_mode"] = floor_plan_mode
        if source["status"] != "completed" or geometry_changed or not confirmed:
            source.update(
                status="needs_setup",
                phase=(
                    "Continue table setup"
                    if not confirmed
                    else (
                        "Ready to analyze"
                        if all(
                            t.get("object_baseline", {}).get("approved")
                            for t in tables
                            if t.get("monitoring_enabled", True)
                        )
                        else "Review expected objects for automatic readiness"
                    )
                ),
            )
            source.pop("manifest_url", None)
        self.persist(source)
        if camera:
            self.camera_frames.pop(ident, None)
        return self.public(ident)

    def require_guided_setup(self, source, detection_only):
        """Use the same reviewed setup gate for recording and camera starts."""
        if source.get("setup_mode") == "guided_v1":
            if not source.get("calibration_confirmed") or not source.get("tables"):
                raise ServiceError("Complete the guided table setup before analysis.")
            if source.get("floor_plan_mode") not in ("uploaded", "schematic") or any(
                not all(
                    table.get("setup_review", {}).get(key) is True
                    for key in ("tabletop", "occupancy", "map")
                )
                for table in source["tables"]
                if table.get("monitoring_enabled", True)
            ):
                raise ServiceError(
                    "Complete the guided geometry and floor-plan review before analysis."
                )
            if source.get("floor_plan_mode") == "uploaded" and not (
                source.get("setup_assets") or {}
            ).get("floor_plan"):
                raise ServiceError(
                    "Upload and review the selected floor plan before analysis."
                )
            if not detection_only:
                from processor.object_baseline import validate_baseline

                for table in source["tables"]:
                    if table.get("monitoring_enabled", True):
                        validate_baseline(
                            table.get("object_baseline"), table, require_approved=True
                        )

    async def analyze(self, ident, detection_only):
        source = self.sources[ident]
        directory = self.directory(ident)
        if type(detection_only) is not bool:
            raise ServiceError("Select full analysis or Detection only explicitly.")
        if source["kind"] != "video" or not source["calibration_confirmed"]:
            raise ServiceError("Review the uploaded video table setup first.")
        if not source["tables"]:
            raise ServiceError("Configure at least one table before analysis.")
        self.require_guided_setup(source, detection_only)
        if self.active:
            raise ServiceError("Another analysis or camera is active.", 409)
        await asyncio.to_thread(self.require_models, detection_only)
        self.require_guided_setup(source, detection_only)
        self.reserve(ident)
        source.update(
            status="analyzing",
            progress=0,
            phase="Starting analysis",
            detection_only=detection_only,
        )
        source.pop("error", None)
        self.persist(source)

        async def run():
            if "analyze_video" in self.dependencies:
                await invoke(
                    self.dependencies["analyze_video"],
                    directory / "layout.json",
                    directory,
                    detection_only,
                    self.report(source),
                )
            else:
                await media.analyze_video(
                    directory / "layout.json",
                    directory,
                    detection_only,
                    self.report(source),
                    model_dir=self.model_dir,
                )
            if not (directory / "bundle.json").is_file():
                raise ServiceError("Analysis did not export a bundle.")
            source.update(
                status="completed",
                phase="Analysis complete",
                progress=1,
                manifest_url=f"/api/sources/{ident}/assets/bundle.json",
            )

        self.schedule(source, run)
        return self.public(ident)

    async def cancel(self, ident):
        self.directory(ident)
        source = self.sources[ident]
        if source["status"] == "completed":
            raise ServiceError(
                "Completed bundles are retained; there is no active job to cancel.", 409
            )
        task = self.tasks.get(ident)
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        else:
            source.update(status="cancelled", phase="cancelled")
            self._remove_transient(source)
            self.persist(source)
        self.release(ident)
        return self.public(ident)

    async def close(self):
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.camera_frames.clear()
