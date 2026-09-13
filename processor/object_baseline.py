"""Canonical, server-owned identities for explicitly reviewed tabletop inventories."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

SURFACE_METHOD = "objects_reference_v1"
CONFIG = json.loads(
    (
        Path(__file__).resolve().parents[1] / "shared/object-surface-config.json"
    ).read_text()
)


def canonical_sha256(value):
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
    ).hexdigest()


CONFIG_SHA256 = canonical_sha256(CONFIG)


def validate_inventory(expected):
    if not isinstance(expected, list) or len(expected) > 77:
        raise ValueError(
            "Expected objects must be a list of supported class/count pairs"
        )
    seen = set()
    for item in expected:
        if not isinstance(item, dict) or set(item) != {"class_id", "count"}:
            raise ValueError("Expected objects require exactly class_id and count")
        class_id, count = item["class_id"], item["count"]
        if (
            type(class_id) is not int
            or not 0 <= class_id < 80
            or class_id in (0, 56, 60)
            or class_id in seen
        ):
            raise ValueError("Duplicate or unsupported tabletop object category")
        if type(count) is not int or not 0 <= count <= 100:
            raise ValueError("Expected object count must be an integer in 0..100")
        seen.add(class_id)
    return sorted(
        ({"class_id": item["class_id"], "count": item["count"]} for item in expected),
        key=lambda item: item["class_id"],
    )


def validate_baseline(baseline, table=None, require_approved=False):
    if (
        not isinstance(baseline, dict)
        or type(baseline.get("version")) is not int
        or baseline["version"] != 1
    ):
        raise ValueError("Expected object baseline version 1")
    expected = validate_inventory(baseline.get("expected"))
    if type(baseline.get("approved")) is not bool or (
        require_approved and not baseline["approved"]
    ):
        raise ValueError("An explicitly approved object baseline is required")
    if (
        not isinstance(baseline.get("reviewed_by"), str)
        or not baseline["reviewed_by"].strip()
        or len(baseline["reviewed_by"]) > 200
    ):
        raise ValueError("Object baseline requires a review identity")
    keys = {
        "version",
        "approved",
        "expected",
        "reviewed_by",
        "reference_sha256",
        "geometry_sha256",
        "detector_sha256",
        "config_sha256",
        "baseline_sha256",
    }
    if set(baseline) != keys:
        raise ValueError("Object baseline contains missing or unknown fields")
    for key in (
        "reference_sha256",
        "geometry_sha256",
        "detector_sha256",
        "config_sha256",
        "baseline_sha256",
    ):
        if (
            not isinstance(baseline.get(key), str)
            or re.fullmatch(r"[a-f0-9]{64}", baseline[key]) is None
        ):
            raise ValueError(f"Invalid object baseline {key}")
    canonical = {
        key: value for key, value in baseline.items() if key != "baseline_sha256"
    }
    canonical["expected"] = expected
    if canonical_sha256(canonical) != baseline["baseline_sha256"]:
        raise ValueError("Object baseline hash mismatch")
    if table is not None:
        if not isinstance(table, dict) or not isinstance(table.get("reference"), dict):
            raise ValueError("Object baseline requires a valid table reference")
        if baseline["geometry_sha256"] != table.get("geometry_sha256") or baseline[
            "reference_sha256"
        ] != table["reference"].get("sha256"):
            raise ValueError(
                "Object baseline differs from the approved reference or geometry; approve it again"
            )
    if require_approved:
        from .models import MODEL_HASHES

        if (
            baseline["config_sha256"] != CONFIG_SHA256
            or baseline["detector_sha256"] != MODEL_HASHES[CONFIG["model"]]
        ):
            raise ValueError(
                "Object baseline detector or comparison configuration changed; approve it again"
            )


def build_baseline(
    expected,
    reference_sha256,
    geometry_sha256,
    detector_sha256,
    approved=True,
    reviewed_by="operator_setup_approval",
):
    result = {
        "version": 1,
        "approved": approved,
        "expected": validate_inventory(expected),
        "reference_sha256": reference_sha256,
        "geometry_sha256": geometry_sha256,
        "detector_sha256": detector_sha256,
        "config_sha256": CONFIG_SHA256,
        "reviewed_by": reviewed_by,
    }
    result["baseline_sha256"] = canonical_sha256(result)
    validate_baseline(result)
    return result
