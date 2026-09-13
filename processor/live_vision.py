"""Persistent frame evidence for live input; service decisions stay in TypeScript.

Frames are BGR uint8, timestamps are capture seconds in one live session, and
frame_index is the browser sequence number. Neither wall-clock delays nor a
failed inference are converted into fabricated empty observations.
"""

from __future__ import annotations

import copy
import math
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np

from .detector import YOLOXDetector
from .models import verify_model
from .surface import SurfaceMonitor
from .tracking import PeopleTracker
from .geometry import geometry_hash


def _frame(frame):
    if (
        not isinstance(frame, np.ndarray)
        or frame.dtype != np.uint8
        or frame.ndim != 3
        or frame.shape[2] != 3
        or min(frame.shape[:2]) < 2
    ):
        raise ValueError("Expected a nonempty uint8 BGR source frame")
    return frame


def _tables(tables):
    if not isinstance(tables, list) or not tables:
        raise ValueError("Configure at least one table")
    result, ids = copy.deepcopy(tables), set()
    for table in result:
        if (
            not isinstance(table, dict)
            or not isinstance(table.get("id"), str)
            or not table["id"].strip()
            or table["id"] in ids
        ):
            raise ValueError("Table IDs must be nonempty and unique")
        ids.add(table["id"])
        if (
            "monitoring_enabled" in table
            and type(table["monitoring_enabled"]) is not bool
        ):
            raise ValueError("monitoring_enabled must be boolean")
        actual = geometry_hash(table)
        if (
            table.get("geometry_sha256") is not None
            and table["geometry_sha256"] != actual
        ):
            raise ValueError(f"Geometry hash mismatch for {table['id']}")
        table["geometry_sha256"] = actual
    return result


class VisionSession:
    """One resident detector, anonymous tracker, and surface monitor per source."""

    def __init__(
        self,
        tables,
        width,
        height,
        session_id,
        model="tiny",
        model_dir="models",
        intra_threads=4,
        fps=30,
        *,
        detector=None,
        tracker=None,
        surface_monitor=None,
    ):
        if type(width) is not int or type(height) is not int or min(width, height) < 2:
            raise ValueError(
                "Source dimensions must be positive integer pixel dimensions"
            )
        if type(fps) not in (int, float) or not math.isfinite(fps) or fps <= 0:
            raise ValueError("Source FPS must be finite and positive")
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("A live session identity is required")
        self.tables = _tables(tables)
        self.width, self.height, self.session_id = width, height, session_id
        self.closed, self.last_t, self.last_index = False, None, None
        cv2.setNumThreads(1)
        self.detector = (
            detector
            if detector is not None
            else YOLOXDetector(
                model=model,
                model_dir=model_dir,
                score_threshold=0.1,
                nms_threshold=0.45,
                intra_threads=intra_threads,
                class_ids=(0,),
            )
        )
        tracker_started = perf_counter()
        self.tracker = (
            tracker
            if tracker is not None
            else PeopleTracker(width, height, fps, clip_id=session_id)
        )
        tracker_startup = perf_counter() - tracker_started
        self.monitor = (
            surface_monitor
            if surface_monitor is not None
            else SurfaceMonitor(self.tables)
        )
        self.metadata = {
            "session_id": session_id,
            "model": model if detector is None else "injected_detector",
            "model_sha256": getattr(self.detector, "sha256", None),
            "provider": "CPUExecutionProvider" if detector is None else "injected",
            "width": width,
            "height": height,
            "fps": fps,
            "intra_threads": intra_threads,
            "inter_threads": 1,
            "opencv_threads": 1,
            "confidence": 0.1,
            "nms_threshold": 0.45,
            "startup_timing_s": {
                **getattr(self.detector, "startup_timing", {}),
                "tracker_startup": tracker_startup,
            },
            "tracking": getattr(self.tracker, "settings", {}),
            "timestamp_source": "live session capture seconds",
        }

    def _open(self):
        if self.closed:
            raise RuntimeError("Vision session is closed")

    def set_tables(self, tables):
        self._open()
        updated = _tables(tables)
        if {table["id"] for table in updated} != {table["id"] for table in self.tables}:
            raise ValueError(
                "Live table IDs are fixed; disable an existing table instead of removing it"
            )
        if hasattr(self.monitor, "set_tables"):
            self.monitor.set_tables(updated)
        else:
            self.monitor.tables = updated
        if hasattr(self.tracker, "set_tables"):
            self.tracker.set_tables(updated)
        self.tables = updated

    def process_frame(self, frame, t, frame_index):
        self._open()
        _frame(frame)
        if frame.shape[:2] != (self.height, self.width):
            raise ValueError(
                "Frame resolution changed; create and calibrate a new source"
            )
        if (
            type(t) not in (int, float)
            or not math.isfinite(t)
            or t < 0
            or (self.last_t is not None and t <= self.last_t)
        ):
            raise ValueError(
                "Capture timestamps must strictly increase within a live session"
            )
        if (
            type(frame_index) is not int
            or frame_index < 0
            or (self.last_index is not None and frame_index <= self.last_index)
        ):
            raise ValueError(
                "Frame sequence numbers must strictly increase within a live session"
            )
        self.last_t, self.last_index = float(t), frame_index
        started = perf_counter()
        detections, valid, errors = [], True, []
        detected = perf_counter()
        try:
            detections = self.detector.detect(frame)
        except Exception as exc:
            valid = False
            errors.append(f"Detection: {type(exc).__name__}: {exc}"[:600])
        detector_s = perf_counter() - detected
        # A failed call may leave the detector's previous successful timing.
        timing = {
            key: (
                float(getattr(self.detector, "last_timing", {}).get(key, 0.0))
                if valid
                else 0.0
            )
            for key in ("preprocess", "inference", "postprocess")
        }
        timing["detector_total"] = detector_s
        observed_surface = perf_counter()
        try:
            surface = self.monitor.update(frame, detections, valid=valid)
        except Exception as exc:
            errors.append(f"Surface analysis: {type(exc).__name__}: {exc}"[:600])
            surface = {
                "scene_cut": False,
                "surface": {
                    table["id"]: {"visible": None, "changed": False}
                    for table in self.tables
                },
            }
        timing["surface_monitor"] = perf_counter() - observed_surface
        tracked = perf_counter()
        try:
            evidence = self.tracker.update(
                detections,
                self.tables,
                float(t),
                frame_index,
                valid=valid,
                scene_cut=surface["scene_cut"],
            )
        except Exception as exc:
            valid = False
            errors.append(f"Tracking: {type(exc).__name__}: {exc}"[:600])
            evidence = {
                "tracks": [],
                "tables": {table["id"]: "uncertain" for table in self.tables},
            }
        timing["tracking"] = perf_counter() - tracked
        # Disabled IDs stay explicit and unknown, even with injected adapters.
        for table in self.tables:
            if not valid or table.get("monitoring_enabled", True) is False:
                evidence["tables"][table["id"]] = "uncertain"
                surface["surface"][table["id"]] = {"visible": None, "changed": False}
        observation = {
            "t": float(t),
            "frame_index": frame_index,
            "valid": valid,
            "detections": detections,
            **evidence,
            **surface,
        }
        if errors:
            observation["error"] = "; ".join(errors)[:1200]
        timing["total"] = perf_counter() - started
        return {"observation": observation, "timing": timing}

    def close(self):
        if self.closed:
            return
        self.closed = True
        for component in (self.detector, self.tracker, self.monitor):
            if hasattr(component, "close"):
                component.close()
        self.detector = self.tracker = self.monitor = None


def propose_tables(
    frame, *, detector=None, model="tiny", model_dir="models", intra_threads=4
):
    """Unapproved table boxes from actual inference; source corners need review."""
    _frame(frame)
    from .geometry import _expanded, _polygon

    detector = (
        detector
        if detector is not None
        else YOLOXDetector(
            model=model,
            model_dir=model_dir,
            score_threshold=0.3,
            nms_threshold=0.45,
            intra_threads=intra_threads,
            class_ids=(60,),
        )
    )
    boxes = sorted(
        (item["box"] for item in detector.detect(frame) if item["class_id"] == 60),
        key=lambda box: (box[1], box[0]),
    )
    columns = max(1, math.ceil(math.sqrt(len(boxes))))
    rows = max(1, math.ceil(len(boxes) / columns))
    tables = []
    for index, box in enumerate(boxes):
        table = {
            "id": f"T{index + 1}",
            "label": f"Table {index + 1}",
            "video_region": list(box),
            "crop": _expanded(box),
            "tabletop_polygon": _polygon(box),
            "occupancy_regions": [_polygon(_expanded(box, 0.06, 0.1))],
            "map": {
                "x": (index % columns + 0.5) / columns,
                "y": (index // columns + 0.5) / rows,
                "w": 0.55 / columns,
                "h": 0.5 / rows,
                "shape": "rect",
            },
            "reference": None,
        }
        table["geometry_sha256"] = geometry_hash(table)
        tables.append(table)
    return tables


def model_availability(model_dir="models", *, model="tiny", surface_model_dir=None):
    """Verify pinned CPU assets without constructing ONNX sessions."""
    from .object_baseline import CONFIG, CONFIG_SHA256, SURFACE_METHOD
    from .object_surface import MODEL_ID

    result = {
        "detector": {"available": False, "model": model},
        "surface": {
            "available": False,
            "model": MODEL_ID,
            "provider": "CPUExecutionProvider",
            "surface_method": SURFACE_METHOD,
            "config_sha256": CONFIG_SHA256,
        },
    }
    try:
        result["detector"].update(
            available=True,
            sha256=verify_model(Path(model_dir) / f"yolox_{model}.onnx", model),
        )
    except (OSError, ValueError, TypeError) as exc:
        result["detector"]["reason"] = str(exc)[:600]
    try:
        path = (
            Path(surface_model_dir)
            if surface_model_dir is not None
            else Path(model_dir)
        )
        digest = verify_model(path / f"yolox_{CONFIG['model']}.onnx", CONFIG["model"])
        result["surface"].update(available=True, sha256=digest, detector_sha256=digest)
    except (OSError, ValueError, TypeError) as exc:
        result["surface"]["reason"] = str(exc)[:600]
    return result
