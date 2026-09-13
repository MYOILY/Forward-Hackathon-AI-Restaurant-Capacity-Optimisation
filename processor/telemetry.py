"""Measured host, dependency, and timing metadata."""

from __future__ import annotations
from importlib.metadata import PackageNotFoundError, version
import platform
import subprocess
import sys
import numpy as np


def _versions():
    packages = {}
    for name in ("numpy", "opencv-python", "onnxruntime"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = "unavailable"
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": packages,
    }


def _hardware():
    import psutil

    processor = platform.processor() or "unavailable"
    processor_source = "platform.processor; detailed CPU identification unavailable"
    if sys.platform == "darwin":
        try:
            detailed = subprocess.check_output(
                ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"],
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=2,
            ).strip()
            if detailed:
                processor, processor_source = (
                    detailed,
                    "sysctl machdep.cpu.brand_string",
                )
        except (OSError, subprocess.SubprocessError):
            pass
    return {
        "cpu_model": processor,
        "cpu_model_source": processor_source,
        "architecture": platform.machine(),
        "logical_cores": psutil.cpu_count(logical=True),
        "physical_cores": psutil.cpu_count(logical=False),
        "memory_bytes": psutil.virtual_memory().total,
    }


def _distribution(seconds):
    if not seconds:
        return {"median": None, "p95": None}
    values = np.asarray(seconds, dtype=np.float64) * 1000
    return {"median": float(np.median(values)), "p95": float(np.percentile(values, 95))}
