"""Preserve source-image identity and capture timestamps."""

from __future__ import annotations
import math
import cv2
from .io import resolve_media, sha256_file


def _original_scene_source_t(layout):
    """Preserve supplied scene time; never infer an opening-frame timestamp."""
    if layout.get("original_scene") is None:
        return None
    for section, key in (
        ("preparation", "reference_t"),
        ("analysis", "original_scene_source_t"),
    ):
        metadata = layout.get(section)
        value = metadata.get(key) if isinstance(metadata, dict) else None
        if (
            type(value) in (int, float)
            and math.isfinite(value)
            and 0 <= value <= layout["video"]["duration_s"]
        ):
            return value
    return None


def _reference_inputs(layout, layout_root):
    """Resolve the untouched original scene; table references are refreshed."""
    records = []
    items = [
        (
            None,
            layout.get("original_scene"),
            _original_scene_source_t(layout),
            [0, 0, 1, 1],
        )
    ]
    for table_id, relative, source_t, crop in items:
        if relative is None:
            continue
        path = resolve_media(layout_root, relative)
        if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            raise ValueError("Reference media must be PNG, JPEG or WebP image files")
        decoded = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if decoded is None or decoded.size == 0:
            raise ValueError(f"Reference image cannot be decoded: {relative}")
        records.append(
            {
                "table_id": table_id,
                "source_file": relative,
                "sha256": sha256_file(path),
                "source_t": source_t,
                "crop": crop,
                "width": decoded.shape[1],
                "height": decoded.shape[0],
                "source_kind": "image_copy",
            }
        )
    return records
