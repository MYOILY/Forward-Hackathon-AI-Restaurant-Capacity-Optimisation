"""Atomic downloads of the fixed official YOLOX ONNX release assets.

The hashes below were observed from the official HTTPS release URLs.
They pin repeatable content; they are not upstream signatures.
"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .io import atomic_json, sha256_file

MODEL_HASHES = {
    "nano": "c789161ed43c8269fcd4e67c67eeeb4e80c622da2eb296a20bc6007bd18a0b7d",
    "tiny": "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7",
    "s": "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063",
}
BASE_URL = "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0"


def verify_model(path: str | Path, model: str) -> str:
    if model not in MODEL_HASHES:
        raise ValueError("Choose nano, tiny, or s")
    actual = sha256_file(path)
    if actual != MODEL_HASHES[model]:
        raise ValueError(
            f"Model SHA-256 mismatch for {model}; expected the pinned official raw-head ONNX asset. Remove or move the incorrect file, then download-model again."
        )
    return actual


def download_model(model: str, model_dir: str | Path = "models") -> dict:
    """Validate before replacing the destination; reuse verified existing files."""
    if model not in MODEL_HASHES:
        raise ValueError("Choose nano, tiny, or s")
    from .detector import YOLOXDetector

    model_dir = Path(model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    destination = model_dir / f"yolox_{model}.onnx"
    source = f"{BASE_URL}/{destination.name}"
    existed = destination.exists()
    if existed:
        actual = verify_model(destination, model)
        detector = YOLOXDetector(model=model, model_path=destination)
    else:
        descriptor, temporary = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".download", dir=model_dir
        )
        try:
            request = Request(source, headers={"User-Agent": "TableWatch"})
            with os.fdopen(descriptor, "wb") as stream, urlopen(
                request, timeout=60
            ) as response:
                final = urlparse(response.geturl())
                trusted = final.hostname == "github.com" or (
                    final.hostname or ""
                ).endswith(".githubusercontent.com")
                if final.scheme != "https" or not trusted:
                    raise ValueError(
                        "Model download redirected outside GitHub HTTPS assets"
                    )
                length = 0
                for chunk in iter(lambda: response.read(1024 * 1024), b""):
                    length += len(chunk)
                    if length > 200 * 1024 * 1024:
                        raise ValueError("Model asset exceeds expected maximum size")
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
            actual = verify_model(temporary, model)
            detector = YOLOXDetector(model=model, model_path=temporary)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    manifest = {
        "model": model,
        "file": destination.name,
        "source": source,
        "sha256": actual,
        "hash_provenance": "project-pinned observed official HTTPS asset, not an upstream signature",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "input_size": list(detector.input_size),
        "provider": "CPUExecutionProvider",
        "reused_existing": existed,
    }
    atomic_json(destination.with_suffix(".manifest.json"), manifest)
    return manifest
