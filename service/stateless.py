"""Synchronous, RAM-only frame API for Lambda Function URLs.

The sole warm cache is a verified YOLOX inference session. Every request gets
fresh detector wrappers, trackers and surface monitors. Request payloads and
images are neither persisted nor logged.
"""

from __future__ import annotations

import base64
import binascii
from collections import Counter
import copy
from io import BytesIO
import json
import logging
import math
import os
from pathlib import Path
import re
import threading
from time import perf_counter

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

from processor.frame_checkpoints import dump_checkpoint, json_bytes, restore_checkpoint
from processor.geometry import geometry_hash, rectify_tabletop
from processor.live_vision import VisionSession, propose_tables
from processor.models import MODEL_HASHES, verify_model
from processor.object_baseline import CONFIG, CONFIG_SHA256, SURFACE_METHOD, build_baseline, canonical_sha256, validate_baseline, validate_inventory
from processor.object_surface import ALIGNMENT_CONFIG, ObjectSurfaceModel

ROOT = Path(__file__).resolve().parents[1]
LIMITS = json.loads((ROOT / "shared/frame-batch-limits.json").read_text())
CONFIGURATION = {
    "trackers_version": "2.6.0",
    "limits": LIMITS,
    "people": {"confidence": 0.1, "nms": 0.45, "lost_track_buffer": 30, "track_activation_threshold": 0.4, "minimum_consecutive_frames": 1, "minimum_iou_threshold": 0.1, "high_conf_det_threshold": 0.3},
    "surface": CONFIG,
    "alignment": ALIGNMENT_CONFIG,
}
FRAME_CONFIG_SHA256 = canonical_sha256(CONFIGURATION)
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_LOG = logging.getLogger("tablewatch.stateless")
_LOG.setLevel(logging.INFO)


class ProtocolError(ValueError):
    def __init__(self, message, status=400, code="invalid_request"):
        super().__init__(message)
        self.status, self.code = status, code


def _number(value, name, *, minimum=0, maximum=1e9, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ProtocolError(f"{name} is outside its supported numeric range")
    return value


def _text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 128 or any(ord(c) < 32 for c in value):
        raise ProtocolError(f"{name} must be a nonempty string of at most 128 characters")
    return value


def _hash(value, name):
    if not isinstance(value, str) or _HASH.fullmatch(value) is None:
        raise ProtocolError(f"{name} must be a SHA-256 digest")
    return value


def _object(value, name):
    if not isinstance(value, dict):
        raise ProtocolError(f"{name} must be an object")
    return value


def _list(value, name, maximum, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ProtocolError(f"{name} must contain {minimum}..{maximum} entries")
    return value


def _size(value, limit, name):
    try:
        size = len(json_bytes(value))
    except (ValueError, TypeError, OverflowError, RecursionError) as exc:
        raise ProtocolError(f"{name} must be finite JSON") from exc
    if size > limit:
        raise ProtocolError(f"{name} exceeds {limit} bytes", 413, "payload_too_large")


def _decode_image(value, *, reference=False):
    _object(value, "image")
    max_width = CONFIG["crop_longest_edge"] if reference else LIMITS["width"]
    max_height = CONFIG["crop_longest_edge"] if reference else LIMITS["height"]
    width = _number(value.get("width"), "image.width", minimum=2, maximum=max_width, integer=True)
    height = _number(value.get("height"), "image.height", minimum=2, maximum=max_height, integer=True)
    expected = _hash(value.get("sha256"), "image.sha256")
    encoded = value.get("image_base64")
    if not isinstance(encoded, str) or len(encoded) > 4 * math.ceil(LIMITS["image_bytes"] / 3):
        raise ProtocolError("Encoded image exceeds supported size", 413, "payload_too_large")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ProtocolError("Image must contain valid base64") from exc
    if len(raw) > LIMITS["image_bytes"]:
        raise ProtocolError("Decoded image exceeds supported size", 413, "payload_too_large")
    import hashlib
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ProtocolError("Transmitted image SHA-256 mismatch")
    try:
        # Read dimensions before decompression; an encoded image cannot bypass
        # pixel limits by lying in its JSON dimensions.
        with Image.open(BytesIO(raw)) as image:
            if image.format not in ("PNG", "JPEG", "WEBP") or image.size != (width, height) or getattr(image, "n_frames", 1) != 1:
                raise ProtocolError("Image format or dimensions differ from the frame metadata")
            image.load()
            return cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, ValueError) as exc:
        if isinstance(exc, ProtocolError):
            raise
        raise ProtocolError("Could not decode the bounded frame image") from exc


def _encoded_png(frame):
    import hashlib
    ok, data = cv2.imencode(".png", frame)
    if not ok:
        raise RuntimeError("Could not encode tabletop evidence")
    raw = data.tobytes()
    return {"image_base64": base64.b64encode(raw).decode("ascii"), "sha256": hashlib.sha256(raw).hexdigest(), "width": frame.shape[1], "height": frame.shape[0]}


def _capture(frame):
    return {key: frame[key] for key in ("sample_index", "t", "width", "height", "sha256")}


class _ModelCache:
    """Verified model session only; copies isolate per-call timing wrappers."""

    def __init__(self):
        self.lock, self.template, self.verified = threading.Lock(), None, False

    @property
    def model_dir(self):
        return Path(os.environ.get("TABLEWATCH_MODEL_DIR", str(ROOT / "models")))

    def available(self):
        try:
            with self.lock:
                if not self.verified:
                    verify_model(self.model_dir / "yolox_tiny.onnx", "tiny")
                    self.verified = True
            return True, None
        except (OSError, ValueError):
            return False, "The verified Tiny model is unavailable"

    def detector(self, mode):
        from processor.detector import YOLOXDetector
        with self.lock:
            if self.template is None:
                try:
                    self.template = YOLOXDetector(model="tiny", model_dir=self.model_dir, score_threshold=0.1, class_ids=tuple(range(80)), intra_threads=int(os.environ.get("TABLEWATCH_INTRA_THREADS", "4")))
                    self.verified = True
                except (OSError, ValueError, RuntimeError) as exc:
                    raise ProtocolError("The verified Tiny inference model is unavailable", 503, "model_unavailable") from exc
            detector = copy.copy(self.template)
        detector.last_timing = {}
        detector.class_ids = (0,) if mode == "people" else (60,) if mode == "tables" else tuple(range(80))
        detector.score_threshold = 0.1 if mode == "people" else 0.3 if mode == "tables" else CONFIG["score_floor"]
        return detector


_MODELS = _ModelCache()


class StatelessProcessor:
    """No session map: the supplied checkpoint is the entire processing state."""

    def __init__(self, *, detector_factory=None, availability=None, build_id=None):
        self.detector_factory = detector_factory or _MODELS.detector
        self.availability = availability or _MODELS.available
        self.build_id = build_id or os.environ.get("TABLEWATCH_BUILD_ID", "development")

    def capabilities(self):
        ready, reason = self.availability()
        result = {"available": ready, "model_sha256": MODEL_HASHES["tiny"] if ready else None, "config_sha256": FRAME_CONFIG_SHA256, "build_id": self.build_id, "limits": dict(LIMITS)}
        if reason:
            result["reason"] = reason
        return result

    def _validate(self, operation, payload):
        _size(payload, LIMITS["body_bytes"], "Request")
        _object(payload, "Request")
        if "protocol_version" in payload:
            raise ProtocolError("Unsupported request format; reload the current application")
        _text(payload.get("request_id"), "request_id")
        _text(payload.get("run_id"), "run_id")
        _number(payload.get("revision"), "revision", integer=True)
        _hash(payload.get("model_sha256"), "model_sha256")
        _hash(payload.get("config_sha256"), "config_sha256")
        _text(payload.get("build_id"), "build_id")
        if (payload["model_sha256"] != MODEL_HASHES["tiny"] or
            payload["config_sha256"] != FRAME_CONFIG_SHA256 or
            payload["build_id"] != self.build_id):
            raise ProtocolError("The processing model, configuration, or build changed; start a fresh analysis", 409, "stale_identity")
        source = _object(payload.get("source"), "source")
        _hash(source.get("sha256"), "source.sha256")
        for key in ("width", "height"):
            _number(source.get(key), f"source.{key}", minimum=2, maximum=32768, integer=True)
        _number(source.get("fps"), "source.fps", minimum=0.001, maximum=1000)
        _number(source.get("duration_s"), "source.duration_s", minimum=0.001, maximum=LIMITS["duration_s"])
        tables = copy.deepcopy(_list(payload.get("tables"), "tables", LIMITS["tables"], 0 if operation == "propose-tables" else 1))
        ids = set()
        for table in tables:
            _object(table, "table")
            ident = _text(table.get("id"), "table.id")
            if ident in ids:
                raise ProtocolError("Table IDs must be unique")
            ids.add(ident)
            _list(table.get("tabletop_polygon"), "tabletop_polygon", 4, 4)
            for region in _list(table.get("occupancy_regions"), "occupancy_regions", 16, 1):
                _list(region, "occupancy polygon", 16, 3)
            actual = geometry_hash(table)
            if table.get("geometry_sha256") not in (None, actual):
                raise ProtocolError("Table geometry SHA-256 mismatch")
            table["geometry_sha256"] = actual
            if "monitoring_enabled" in table and type(table["monitoring_enabled"]) is not bool:
                raise ProtocolError("monitoring_enabled must be boolean")
        frames = _list(payload.get("frames"), "frames", LIMITS["frames"], 1)
        prior_t, prior_index, shape = None, None, None
        decoded = []
        for frame in frames:
            _object(frame, "frame")
            t = _number(frame.get("t"), "frame.t")
            index = _number(frame.get("sample_index"), "frame.sample_index", integer=True)
            if (prior_t is not None and t <= prior_t) or (prior_index is not None and index <= prior_index):
                raise ProtocolError("Frames must have strictly increasing timestamps and sample indices")
            image = _decode_image(frame)
            if shape is not None and image.shape != shape:
                raise ProtocolError("All frames in a batch must share processing dimensions")
            prior_t, prior_index, shape = t, index, image.shape
            decoded.append(image)
        if operation in ("propose-tables", "propose-reference") and len(frames) != 1:
            raise ProtocolError("Proposal operations require one frame")
        if operation == "propose-reference" and len(tables) != 1:
            raise ProtocolError("Reference proposals require exactly one table")
        if payload.get("checkpoint") is not None:
            _size(payload["checkpoint"], LIMITS["checkpoint_bytes"], "Checkpoint")
            if operation != "observe-batch":
                raise ProtocolError("Only observation batches accept checkpoints")
        return tables, frames, decoded

    def process(self, operation, payload):
        if operation not in ("propose-tables", "propose-reference", "observe-batch", "assess-batch"):
            raise ProtocolError("Unknown frame operation", 404, "not_found")
        tables, frames, decoded = self._validate(operation, payload)
        common = {key: payload[key] for key in ("request_id", "run_id", "revision")}
        common.update(model_sha256=MODEL_HASHES["tiny"], config_sha256=FRAME_CONFIG_SHA256, build_id=self.build_id)
        if operation == "propose-tables":
            proposed = propose_tables(decoded[0], detector=self.detector_factory("tables"))
            if len(proposed) > LIMITS["tables"]:
                raise ProtocolError("Detected table count exceeds the supported setup limit", 422, "capacity_exceeded")
            result = {"tables": proposed}
        elif operation == "propose-reference":
            table = tables[0]
            crop = rectify_tabletop(decoded[0], table["tabletop_polygon"], CONFIG["crop_longest_edge"])
            reference = _encoded_png(crop)
            model = ObjectSurfaceModel(detector=self.detector_factory("surface"))
            detections = model.propose_images(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))["detections"]
            counts = Counter(item["class_id"] for item in detections if item["score"] >= CONFIG["confident_score"] and item["class_id"] not in (*CONFIG["ignored_classes"], CONFIG["obstruction_class"]))
            expected = table.get("expected_objects_draft", [{"class_id": key, "count": counts[key]} for key in sorted(counts)])
            expected = validate_inventory(expected)
            baseline = build_baseline(expected, reference["sha256"], table["geometry_sha256"], MODEL_HASHES["tiny"], approved=False, reviewed_by="stateless_reference_proposal")
            result = {"reference": reference, "baseline": baseline, "detections": detections, "geometry_sha256": table["geometry_sha256"]}
        elif operation == "observe-batch":
            result = self._observe(payload, tables, frames, decoded)
        else:
            result = self._assess(payload, tables, frames, decoded)
        result = {**common, **result}
        _size(result, LIMITS["body_bytes"], "Response")
        return result

    def _observe(self, payload, tables, frames, decoded):
        source = payload["source"]
        identity = {
            "run_id": payload["run_id"], "revision": payload["revision"],
            "source": source,
            "width": frames[0]["width"], "height": frames[0]["height"],
            "setup_sha256": canonical_sha256(tables),
            "model_sha256": MODEL_HASHES["tiny"], "config_sha256": FRAME_CONFIG_SHA256,
            "build_id": self.build_id,
        }
        # The tracker/monitor constructor does not retain the input checkpoint.
        # A failed request never replaces any previously returned client state.
        session = VisionSession(tables, frames[0]["width"], frames[0]["height"], payload["run_id"], fps=source["fps"], detector=self.detector_factory("people"))
        if payload.get("checkpoint") is not None:
            restore_checkpoint(session, payload["checkpoint"], identity)
        if session.last_t is not None and (frames[0]["t"] <= session.last_t or frames[0]["sample_index"] <= session.last_index):
            raise ProtocolError("Batch must advance beyond its checkpoint")
        observations = []
        for frame, image in zip(frames, decoded):
            observation = session.process_frame(image, frame["t"], frame["sample_index"])["observation"]
            observation["capture"] = _capture(frame)
            if len(session.tracker.tracker.tracks) > LIMITS["tracks"] or len(observation.get("tracks", [])) > LIMITS["tracks"] or len(observation["detections"]) > LIMITS["tracks"]:
                raise ProtocolError("Frame exceeds the supported person/track count", 422, "capacity_exceeded")
            observations.append(observation)
        checkpoint = dump_checkpoint(session, identity)
        session.close()
        return {"observations": observations, "checkpoint": checkpoint}

    def _assess(self, payload, tables, frames, decoded):
        requests = _list(payload.get("requests"), "requests", LIMITS["frames"], 1)
        references = _object(payload.get("references"), "references")
        if len(references) > LIMITS["tables"]:
            raise ProtocolError("Too many table references")
        by_table = {table["id"]: table for table in tables}
        by_index = {frame["sample_index"]: (frame, image) for frame, image in zip(frames, decoded)}
        prepared, request_ids = [], set()
        for request in requests:
            _object(request, "assessment request")
            ident = _text(request.get("id"), "assessment.id")
            if ident in request_ids:
                raise ProtocolError("Assessment request IDs must be unique")
            request_ids.add(ident)
            table_id = _text(request.get("table_id"), "assessment.table_id")
            table = by_table.get(table_id)
            if table is None or table.get("monitoring_enabled", True) is False:
                raise ProtocolError("Assessment table is missing or disabled")
            index = _number(request.get("frame_index"), "assessment.frame_index", integer=True)
            if index not in by_index:
                raise ProtocolError("Assessment frame is missing")
            frame, image = by_index[index]
            if request.get("t") != frame["t"] or request.get("capture") != _capture(frame):
                raise ProtocolError("Assessment must identify its exact transmitted capture")
            _number(request.get("generation"), "assessment.generation", integer=True)
            if request.get("video_sha256") != payload["source"]["sha256"] or request.get("geometry_sha256") != table["geometry_sha256"]:
                raise ProtocolError("Assessment recording or geometry identity mismatch")
            baseline = table.get("object_baseline")
            validate_baseline(baseline, table, require_approved=True)
            if request.get("baseline_sha256") != baseline["baseline_sha256"] or request.get("config_sha256") != CONFIG_SHA256 or request.get("surface_method") != SURFACE_METHOD:
                raise ProtocolError("Assessment baseline or configuration identity mismatch")
            reference = _object(references.get(table_id), "table reference")
            if reference.get("sha256") != baseline["reference_sha256"] or request.get("reference_sha256") != baseline["reference_sha256"]:
                raise ProtocolError("Assessment reference SHA-256 mismatch")
            reference_image = _decode_image(reference, reference=True)
            crop = rectify_tabletop(image, table["tabletop_polygon"], CONFIG["crop_longest_edge"])
            prepared.append((request, reference_image, crop))
        model = ObjectSurfaceModel(detector=self.detector_factory("surface"))
        assessments = []
        for request, reference, crop in prepared:
            result = model.assess_images(cv2.cvtColor(reference, cv2.COLOR_BGR2RGB), cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
            encoded = _encoded_png(crop)
            # IDs are deterministic so a retried request cannot produce a new
            # logically distinct assessment for the same immutable evidence.
            result_id = canonical_sha256({"request": request, "crop_sha256": encoded["sha256"], "config_sha256": FRAME_CONFIG_SHA256, "build_id": self.build_id})
            assessments.append({**request, **result, "id": result_id, "request_id": request["id"], "model": "yolox_tiny", "crop_file": "", "crop_sha256": encoded["sha256"], "crop_base64": encoded["image_base64"], "width": encoded["width"], "height": encoded["height"]})
        return {"assessments": assessments}


def _parse_body(event):
    body = event.get("body") or ""
    if not isinstance(body, str):
        raise ProtocolError("Request body must be JSON text")
    if len(body) > (4 * math.ceil(LIMITS["body_bytes"] / 3) if event.get("isBase64Encoded") else LIMITS["body_bytes"]):
        raise ProtocolError("Request exceeds the supported payload size", 413, "payload_too_large")
    try:
        raw = base64.b64decode(body, validate=True) if event.get("isBase64Encoded") else body.encode("utf-8")
        if len(raw) > LIMITS["body_bytes"]:
            raise ProtocolError("Request exceeds the supported payload size", 413, "payload_too_large")
        def unique_pairs(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ProtocolError("JSON contains duplicate keys")
                value[key] = item
            return value
        return json.loads(raw, object_pairs_hook=unique_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ProtocolError("JSON numbers must be finite")))
    except (UnicodeError, binascii.Error, json.JSONDecodeError, RecursionError) as exc:
        raise ProtocolError("Request body must be valid UTF-8 JSON") from exc


def handle_event(event, *, processor=None):
    """Function URL HTTP API v2 adapter; exposed for exact local contract tests."""
    started, status = perf_counter(), 200
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath", "/")
    operation = path.removeprefix("/frames/")
    try:
        processor = processor or StatelessProcessor()
        if method == "GET" and path == "/frames/capabilities":
            result = processor.capabilities()
        elif method == "POST" and path.startswith("/frames/"):
            headers = {key.lower(): value for key, value in event.get("headers", {}).items()}
            if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise ProtocolError("Content-Type must be application/json", 415, "unsupported_media_type")
            result = processor.process(operation, _parse_body(event))
        else:
            raise ProtocolError("Unknown frame API route", 404, "not_found")
    except ProtocolError as exc:
        status, result = exc.status, {"error": str(exc), "code": exc.code}
    except (ValueError, TypeError, KeyError) as exc:
        # Validation routines in reused geometry/checkpoint modules raise
        # ValueError. Their messages contain field names, never image content.
        status, result = 400, {"error": str(exc)[:400], "code": "invalid_request"}
    except Exception:
        status, result = 500, {"error": "Frame processing failed; retry the same batch", "code": "processing_failed"}
    # No request IDs, user content, exception tracebacks, or image data in logs.
    _LOG.info(json.dumps({"operation": operation if operation in ("capabilities", "propose-tables", "propose-reference", "observe-batch", "assess-batch") else "unknown", "status": status, "duration_ms": round((perf_counter() - started) * 1000)}))
    return {"statusCode": status, "headers": {"content-type": "application/json", "cache-control": "no-store"}, "body": json_bytes(result).decode("utf-8"), "isBase64Encoded": False}


def lambda_handler(event, context):
    return handle_event(event)
