"""Atomic encoding of source images and safe video asset names."""

from __future__ import annotations
import os
from pathlib import Path
import tempfile
import cv2
import numpy as np


def _save_png(path: Path, frame: np.ndarray):
    ok, encoded = cv2.imencode(".png", frame)
    if not ok:
        raise ValueError("Could not encode a source reference image")
    _save_image_bytes(path, encoded.tobytes())


def _save_image_bytes(path: Path, encoded: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _source_filename(path: Path):
    suffix = path.suffix.lower()
    if suffix not in (".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"):
        raise ValueError(
            "Use an MP4/M4V/MOV/WebM/MKV/AVI video; H.264 MP4 is recommended for browser playback"
        )
    return f"media/source{suffix}"
