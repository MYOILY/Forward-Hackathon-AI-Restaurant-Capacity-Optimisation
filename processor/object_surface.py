"""CPU tabletop detections and reference measurements, without service decisions.

The shared TypeScript comparator owns the interpretation of this evidence.
Images enter in RGB and remain in memory unless the caller requests file IO.
"""

from __future__ import annotations

from pathlib import Path
from time import perf_counter
import json

import cv2
import numpy as np

from .detector import YOLOXDetector
from .object_baseline import CONFIG, CONFIG_SHA256, SURFACE_METHOD

MODEL_ID = "yolox_tiny"
ALIGNMENT_CONFIG = json.loads(
    (
        Path(__file__).resolve().parents[1] / "shared/reference-alignment-config.json"
    ).read_text()
)


def _rgb(image):
    if (
        not isinstance(image, np.ndarray)
        or image.dtype != np.uint8
        or image.ndim != 3
        or image.shape[2] != 3
        or min(image.shape[:2]) < 2
    ):
        raise ValueError("Expected a nonempty uint8 RGB tabletop image")
    if image.shape[0] * image.shape[1] > 4096 * 4096:
        raise ValueError("Tabletop image exceeds supported pixel count")
    return image


def unavailable_reference(reason):
    return {
        "observable": False,
        "reason": reason,
        "brightness_offset": None,
        "changed_fraction": None,
        "largest_change_fraction": None,
        "edge_mismatch": None,
    }


def _registration_features(gray, configuration):
    points = cv2.goodFeaturesToTrack(gray, 100, 0.01, 5)
    if points is None or len(points) < configuration["min_features"]:
        return False
    points = points.reshape(-1, 2)
    height, width = gray.shape
    span = np.ptp(points, axis=0) / (width, height)
    return (
        np.all(span >= configuration["min_feature_span_fraction"])
        and cv2.contourArea(cv2.convexHull(points))
        >= gray.size * configuration["min_feature_area_fraction"]
    )


def _align_reference_pair(reference, current, gray, configuration):
    diagnostic = {
        "method": configuration["method"],
        "applied": False,
        "dx": 0.0,
        "dy": 0.0,
        "correlation": None,
    }
    try:
        if not all(_registration_features(patch, configuration) for patch in gray):
            return current, diagnostic
        correlation, transform = cv2.findTransformECC(
            gray[0],
            gray[1],
            np.eye(2, 3, dtype=np.float32),
            cv2.MOTION_TRANSLATION,
            (
                cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                configuration["max_iterations"],
                configuration["epsilon"],
            ),
            None,
            5,
        )
        if not np.isfinite(correlation) or not np.isfinite(transform).all():
            return current, diagnostic
        correlation = float(np.clip(correlation, -1.0, 1.0))
        diagnostic["correlation"] = correlation
        height, width = reference.shape[:2]
        dx, dy = float(transform[0, 2]), float(transform[1, 2])
        if (
            correlation < configuration["min_correlation"]
            or abs(dx) > width * configuration["max_translation_fraction"]
            or abs(dy) > height * configuration["max_translation_fraction"]
            or not np.allclose(transform[:, :2], np.eye(2), atol=1e-7)
        ):
            return current, diagnostic
        aligned = cv2.warpAffine(
            current,
            transform,
            (width, height),
            flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REPLICATE,
        )
        # Keep raw evidence at both edges. Every pixel a translation could drop
        # remains measurable; padding cannot erase an object near the crop edge.
        margin_x, margin_y = int(np.ceil(abs(dx))), int(np.ceil(abs(dy)))
        if margin_x:
            aligned[:, :margin_x] = current[:, :margin_x]
            aligned[:, -margin_x:] = current[:, -margin_x:]
        if margin_y:
            aligned[:margin_y] = current[:margin_y]
            aligned[-margin_y:] = current[-margin_y:]
        diagnostic.update(applied=True, dx=dx, dy=dy)
        return aligned, diagnostic
    except (cv2.error, FloatingPointError):
        # Failure to register never substitutes an empty or supposedly clean crop.
        return current, diagnostic


def compare_reference(reference_rgb, current_rgb, *, alignment_config=None):
    """Measure calibrated images in 8-bit Lab, preserving all chroma changes.

    Brightness offset is reported in Lab luminance units (0..255 scale).
    Symmetric edge mismatch measures unmatched edge pixels in both images.
    """
    reference, current = _rgb(reference_rgb), _rgb(current_rgb)
    if reference.shape != current.shape:
        return unavailable_reference("Reference and current tabletop dimensions differ")
    gray = [cv2.cvtColor(image, cv2.COLOR_RGB2GRAY) for image in (reference, current)]
    for patch in gray:
        if (
            np.percentile(patch, 95) < CONFIG["dark_p95"]
            or np.percentile(patch, 5) > CONFIG["saturated_p5"]
        ):
            return unavailable_reference(
                "Tabletop reference or current image is dark or saturated"
            )
    current, alignment = _align_reference_pair(
        reference,
        current,
        gray,
        ALIGNMENT_CONFIG if alignment_config is None else alignment_config,
    )
    gray[1] = cv2.cvtColor(current, cv2.COLOR_RGB2GRAY)
    blur = (CONFIG["blur_size"], CONFIG["blur_size"])
    labs = [
        cv2.GaussianBlur(
            cv2.cvtColor(image, cv2.COLOR_RGB2LAB), blur, CONFIG["blur_sigma"]
        ).astype(np.float32)
        for image in (reference, current)
    ]
    delta = labs[1] - labs[0]
    offset = float(np.median(delta[:, :, 0]))
    changed = (np.abs(delta[:, :, 0] - offset) > CONFIG["luminance_residual"]) | (
        np.linalg.norm(delta[:, :, 1:], axis=2) > CONFIG["chroma_residual"]
    )
    area = changed.size
    minimum = max(
        CONFIG["component_min_pixels"], round(CONFIG["component_area_fraction"] * area)
    )
    _, _, stats, _ = cv2.connectedComponentsWithStats(
        changed.astype(np.uint8), connectivity=8
    )
    sizes = stats[1:, cv2.CC_STAT_AREA]
    retained = sizes[sizes >= minimum]
    edges = [
        cv2.Canny(
            cv2.GaussianBlur(patch, blur, CONFIG["blur_sigma"]),
            CONFIG["canny_low"],
            CONFIG["canny_high"],
        )
        > 0
        for patch in gray
    ]
    edge_count = sum(int(np.count_nonzero(edge)) for edge in edges)
    edge_minimum = max(
        CONFIG["edge_min_pixels"], round(CONFIG["edge_area_fraction"] * area)
    )
    mismatch = None
    if edge_count >= edge_minimum:
        side = 2 * CONFIG["edge_tolerance_pixels"] + 1
        kernel = np.ones((side, side), np.uint8)
        dilated = [cv2.dilate(edge.astype(np.uint8), kernel) > 0 for edge in edges]
        unmatched = np.count_nonzero(edges[0] & ~dilated[1]) + np.count_nonzero(
            edges[1] & ~dilated[0]
        )
        mismatch = float(unmatched / edge_count)
    result = {
        "observable": abs(offset) <= CONFIG["max_brightness_offset"],
        "brightness_offset": offset,
        "changed_fraction": float(retained.sum() / area),
        "largest_change_fraction": (
            float(retained.max() / area) if len(retained) else 0.0
        ),
        "edge_mismatch": mismatch,
        "alignment": alignment,
    }
    if not result["observable"]:
        result["reason"] = (
            "Tabletop illumination differs too much from the approved setup"
        )
    return result


def validate_detections(detections):
    if not isinstance(detections, list) or len(detections) > 5000:
        raise ValueError("Object detector returned an invalid detection list")
    for item in detections:
        if (
            not isinstance(item, dict)
            or type(item.get("class_id")) is not int
            or not 0 <= item["class_id"] < 80
        ):
            raise ValueError("Object detector returned an invalid class")
        score, box = item.get("score"), item.get("box")
        if (
            type(score) not in (int, float)
            or not np.isfinite(score)
            or not CONFIG["score_floor"] <= score <= 1
        ):
            raise ValueError("Object detector returned an invalid confidence")
        if (
            not isinstance(box, list)
            or len(box) != 4
            or any(
                type(value) not in (int, float)
                or not np.isfinite(value)
                or not 0 <= value <= 1
                for value in box
            )
            or box[0] >= box[2]
            or box[1] >= box[3]
        ):
            raise ValueError("Object detector returned an invalid bounding box")
    return detections


class ObjectSurfaceModel:
    """One resident Tiny CPU session, with sequential per-table calls."""

    def __init__(self, model_dir="models", *, detector=None):
        self.path = Path(model_dir).resolve()
        self.detector = (
            detector
            if detector is not None
            else YOLOXDetector(
                model=CONFIG["model"],
                model_dir=self.path,
                score_threshold=CONFIG["score_floor"],
                nms_threshold=CONFIG["nms_threshold"],
                intra_threads=1,
                class_ids=tuple(range(80)),
            )
        )
        self.metadata = {
            "model": MODEL_ID,
            "model_sha256": getattr(self.detector, "sha256", None),
            "provider": "CPUExecutionProvider" if detector is None else "injected",
            "surface_method": SURFACE_METHOD,
            "config_sha256": CONFIG_SHA256,
            "comparison_config": dict(CONFIG),
            "reference_alignment": dict(ALIGNMENT_CONFIG),
            "input_size": [416, 416],
            "detected_classes": list(range(80)),
            "intra_threads": 1,
            "inter_threads": 1,
            "opencv_threads": 1,
        }
        self.startup_timing = dict(getattr(self.detector, "startup_timing", {}))
        self.last_timing = {}

    def propose_images(self, current_rgb):
        if self.detector is None:
            raise RuntimeError("Surface model is closed")
        current = _rgb(current_rgb)
        detected = self.detector.detect(cv2.cvtColor(current, cv2.COLOR_RGB2BGR))
        return {
            "detections": validate_detections(detected),
            "metadata": dict(self.metadata),
            "detector_sha256": self.metadata["model_sha256"],
        }

    def assess(self, reference_path, current_path):
        started = perf_counter()
        try:
            images = [
                cv2.imread(str(path), cv2.IMREAD_COLOR)
                for path in (reference_path, current_path)
            ]
            if any(image is None for image in images):
                raise ValueError("Could not decode tabletop reference/current image")
            result = self.assess_images(
                *(cv2.cvtColor(image, cv2.COLOR_BGR2RGB) for image in images)
            )
            self.last_timing["total"] = perf_counter() - started
            return result
        except Exception as exc:
            self.last_timing = {"total": perf_counter() - started}
            return self._failure(exc)

    @staticmethod
    def _failure(exc):
        reason = f"Surface processing failed: {type(exc).__name__}: {exc}"[:600]
        return {
            "object_evidence": {
                "detections": [],
                "reference": unavailable_reference(reason),
            },
            "valid": False,
            "outcome": "unobservable",
            "reason": reason,
            "error": reason,
            "surface_method": SURFACE_METHOD,
            "config_sha256": CONFIG_SHA256,
        }

    def assess_images(self, reference_rgb, current_rgb):
        started = perf_counter()
        self.last_timing = {}
        try:
            measured = perf_counter()
            reference = compare_reference(reference_rgb, current_rgb)
            self.last_timing["reference_comparison"] = perf_counter() - measured
            measured = perf_counter()
            detections = self.propose_images(current_rgb)["detections"]
            self.last_timing.update(getattr(self.detector, "last_timing", {}))
            self.last_timing["detector_total"] = perf_counter() - measured
            if any(
                item["class_id"] == CONFIG["obstruction_class"] for item in detections
            ):
                reference.update(
                    observable=False, reason="A person obscures the tabletop"
                )
            return {
                "object_evidence": {"detections": detections, "reference": reference},
                "valid": True,
                "outcome": "unobservable",
                "reason": "Awaiting shared comparison",
                "surface_method": SURFACE_METHOD,
                "config_sha256": CONFIG_SHA256,
            }
        except Exception as exc:
            return self._failure(exc)
        finally:
            self.last_timing["total"] = perf_counter() - started

    def close(self):
        self.detector = None
