"""Fresh-process, sequential inference trials. Performance never changes pass gates."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

import psutil

from .replay import PROJECT_ROOT


def stage_layout(bundle: dict, source_root: Path, staging: Path) -> Path:
    """Preserve calibration and reference provenance while staging safe relative media."""
    from processor.io import resolve_media

    staging.mkdir(parents=True, exist_ok=True)
    layout = json.loads(
        json.dumps(
            {
                key: bundle[key]
                for key in (
                    "schema_version",
                    "video",
                    "original_scene",
                    "tables",
                    "staff_events",
                    "rules",
                )
            }
        )
    )
    analysis = bundle.get("analysis", {})
    layout["calibration_confirmed"] = bundle.get(
        "calibration_confirmed", analysis.get("calibration_confirmed", False)
    )
    layout["provenance"] = bundle["provenance"]
    layout["policy"] = bundle["policy"]
    for key in ("setup_mode", "floor_plan_mode"):
        if key in bundle:
            layout[key] = bundle[key]
    layout["analysis"] = {
        "original_scene_source_t": analysis.get("original_scene_source_t")
    }

    def copy_asset(asset, name):
        from processor.io import validate_image_asset

        validate_image_asset(asset)
        original = resolve_media(source_root, asset["file"])
        if sha256_file(original) != asset["sha256"]:
            raise ValueError("Setup asset hash mismatch during evaluation staging")
        relative = f"setup-assets/{name}{original.suffix}"
        (staging / "setup-assets").mkdir(exist_ok=True)
        shutil.copy2(original, staging / relative)
        return {**asset, "file": relative}

    if bundle.get("floor_plan") is not None:
        layout["floor_plan"] = copy_asset(bundle["floor_plan"], "floor-plan")
    for index, table in enumerate(layout["tables"]):
        original = bundle["tables"][index].get("reference")
        if original:
            original_path = resolve_media(source_root, original["file"])
            # Use sequence indices rather than external IDs in generated paths.
            relative = f"references/table-{index + 1}{original_path.suffix}"
            (staging / "references").mkdir(exist_ok=True)
            shutil.copy2(original_path, staging / relative)
            table["reference"]["file"] = relative
            if original.get("source_kind") == "uploaded_image":
                table["reference"]["source_image"] = copy_asset(
                    original["source_image"], f"clean-reference-{index + 1}"
                )
    if layout["original_scene"]:
        original = resolve_media(source_root, layout["original_scene"])
        relative = "original" + original.suffix
        shutil.copy2(original, staging / relative)
        layout["original_scene"] = relative
    layout_path = staging / "layout.json"
    layout_path.write_text(json.dumps(layout, indent=2))
    return layout_path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


@contextmanager
def benchmark_lock():
    path = PROJECT_ROOT / ".benchmark.lock"
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise RuntimeError(
            "Another benchmark owns .benchmark.lock; do not benchmark concurrently"
        ) from error
    try:
        os.write(descriptor, str(os.getpid()).encode())
        os.close(descriptor)
        yield
    finally:
        path.unlink(missing_ok=True)


def machine_metadata() -> dict:
    from importlib.metadata import PackageNotFoundError, version

    packages = {}
    for name in ("numpy", "opencv-python", "onnxruntime", "psutil", "pytest"):
        try:
            packages[name] = version(name)
        except PackageNotFoundError:
            packages[name] = None
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "python": sys.version,
        "cpu_logical_count": psutil.cpu_count(),
        "physical_memory_bytes": psutil.virtual_memory().total,
        "packages": packages,
    }


def run_trial(
    video: Path,
    layout: Path,
    output: Path,
    model: str,
    model_dir: Path,
    duration_s: float,
    trial: int,
) -> dict:
    model_path = model_dir / f"yolox_{model}.onnx"
    if not model_path.is_file():
        return {
            "model": model,
            "trial": trial,
            "status": "not_run",
            "reason": f"Required ONNX weights are missing: {model_path}",
            "model_path": str(model_path),
        }
    output.mkdir(parents=True, exist_ok=True)
    layout_data = json.loads(layout.read_text())
    if (
        layout_data.get("schema_version") != 2
        or layout_data.get("policy") != "automatic_v2"
    ):
        return {
            "model": model,
            "trial": trial,
            "status": "not_run",
            "reason": "Unsupported layout. Reprocess the recording with the current application.",
        }
    sample_hz = 10
    command = [
        sys.executable,
        "-m",
        "processor",
        "analyze",
        "--video",
        str(video),
        "--layout",
        str(layout),
        "--out",
        str(output),
        "--model",
        model,
        "--model-dir",
        str(model_dir),
        "--sample-hz",
        str(sample_hz),
    ]
    from processor.object_baseline import validate_baseline

    try:
        for table in layout_data["tables"]:
            if table.get("monitoring_enabled", True):
                validate_baseline(
                    table.get("object_baseline"), table, require_approved=True
                )
    except (ValueError, TypeError, KeyError) as error:
        return {
            "model": model,
            "trial": trial,
            "status": "not_run",
            "reason": f"Approved object baseline is required before full surface evaluation: {error}",
        }
    try:
        from processor.models import verify_model

        verify_model(model_dir / "yolox_tiny.onnx", "tiny")
    except (OSError, ValueError) as error:
        return {
            "model": model,
            "trial": trial,
            "status": "not_run",
            "reason": f"Required CPU tabletop model is unavailable or invalid: {error}",
        }
    environment = {
        **os.environ,
        "OMP_NUM_THREADS": "4",
        "OPENBLAS_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "VECLIB_MAXIMUM_THREADS": "1",
    }
    peak, samples = 0, 0
    started = time.perf_counter()
    with (output / "process.log").open("w") as log:
        process = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT,
            stdout=log,
            stderr=subprocess.STDOUT,
            env=environment,
        )
        measured = psutil.Process(process.pid)
        while process.poll() is None:
            try:
                rss = measured.memory_info().rss
                for child in measured.children(recursive=True):
                    try:
                        rss += child.memory_info().rss
                    except psutil.Error:
                        pass
                peak = max(peak, rss)
                samples += 1
            except psutil.Error:
                pass
            time.sleep(0.02)
        elapsed = time.perf_counter() - started
    result = {
        "model": model,
        "trial": trial,
        "process_pid": process.pid,
        "status": "passed" if process.returncode == 0 else "failed",
        "returncode": process.returncode,
        "total_elapsed_s": elapsed,
        "processing_ratio": elapsed / duration_s,
        "sampled_peak_rss_bytes": peak,
        "memory_samples": samples,
        "memory_sampling_interval_s": 0.02,
        "memory_measurement": "sampled resident memory of child process tree; true instantaneous peak may be higher",
        "process_log": str(output / "process.log"),
        "bundle_path": str(output / "bundle.json"),
        "command": command,
    }
    telemetry_path = output / "telemetry.json"
    if process.returncode == 0 and telemetry_path.exists():
        telemetry = json.loads(telemetry_path.read_text())
        result["telemetry"] = telemetry
        count = telemetry.get("counts", {}).get("sampled_frames")
        result["analyzed_frames_per_second"] = (
            count / elapsed if isinstance(count, (int, float)) and elapsed else None
        )
        settings = telemetry.get("settings", {})
        valid_settings = (
            settings.get("provider") == "CPUExecutionProvider"
            and settings.get("intra_threads") == 4
            and settings.get("inter_threads") == 1
            and settings.get("sample_hz") == sample_hz
        )
        result["benchmark_configuration_valid"] = valid_settings
        if not valid_settings:
            result["status"] = "incomplete"
            result["reason"] = (
                f"Processor telemetry did not confirm the prescribed CPU/four-thread/{sample_hz}-Hz settings"
            )
        required_timing = {
            "startup",
            "first_inference",
            "decode",
            "preprocess",
            "inference",
            "postprocess",
            "output_write",
        }
        required_timing.update(
            (
                "tracking",
                "surface_monitor",
                "planner_ipc",
                "assessment_decode",
                "crop_encode",
                "surface_inference",
                "surface_startup",
            )
        )
        if telemetry.get("settings", {}).get("surface_skipped") is not False:
            result.update(
                status="incomplete",
                reason="Actual surface-model analysis was skipped or unreported",
            )
        telemetry_complete = (
            required_timing.issubset(telemetry.get("timing_s", {}))
            and telemetry.get("steady_state", {}).get("excluded_initial_samples") == 20
            and {"median", "p95"}.issubset(
                telemetry.get("steady_state", {}).get("inference_ms", {})
            )
        )
        if not telemetry_complete:
            result.update(
                status="incomplete",
                reason="Runtime telemetry omitted required timing or warmup-summary fields",
            )
    elif process.returncode == 0:
        result.update(
            status="incomplete", reason="Processor did not produce telemetry.json"
        )
    return result
