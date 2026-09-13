"""Validated local media jobs; subprocesses and their children die on cancellation."""

from __future__ import annotations
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import signal
import sys

from processor.io import load_json, sha256_file
from processor.images import _save_png
from processor.pipeline import DEFAULT_RULES
from processor.video import reference_frame

ROOT = Path(__file__).resolve().parents[1]


async def run_process(arguments, on_line=None):
    process = await asyncio.create_subprocess_exec(
        *map(str, arguments),
        cwd=ROOT,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )

    async def stderr_tail():
        tail = b""
        while block := await process.stderr.read(8192):
            tail = (tail + block)[-8192:]
        return tail

    errors = asyncio.create_task(stderr_tail())
    output = []
    try:
        while line := await process.stdout.readline():
            if on_line:
                on_line(line.decode(errors="replace"))
            else:
                output.append(line)
        code = await process.wait()
        diagnostic = (await errors).decode(errors="replace")
        if code:
            raise ValueError(f"Processing failed ({code}): {diagnostic[-1800:]}")
        return b"".join(output).decode()
    finally:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), 2)
            except asyncio.TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
        if not errors.done():
            errors.cancel()
        await asyncio.gather(errors, return_exceptions=True)


async def probe(path):
    executable = shutil.which("ffprobe")
    if not executable:
        raise ValueError(
            "FFmpeg/ffprobe is required for video upload. Install FFmpeg and retry."
        )
    data = json.loads(
        await run_process(
            [
                executable,
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                path,
            ]
        )
    )
    stream = next(
        (item for item in data.get("streams", []) if item.get("codec_type") == "video"),
        None,
    )
    if stream is None:
        raise ValueError("Upload contains no decodable video stream.")
    duration = float(
        data.get("format", {}).get("duration") or stream.get("duration") or 0
    )
    width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
    if not 0 < duration < 86400 or not 0 < width <= 8192 or not 0 < height <= 8192:
        raise ValueError("Video duration or dimensions are unavailable or unsupported.")
    return {**stream, "duration_s": duration, "width": width, "height": height}


def processor_report(report):
    def consume(line):
        try:
            value = json.loads(line)
            if value.get("type") == "progress":
                report(value["phase"], value["fraction"], value.get("details", {}))
        except (ValueError, AttributeError, KeyError):
            pass

    return consume


def manual_layout(canonical, out_dir):
    """Prepare source pixels for drawing, without inferred geometry or approvals."""
    frame, timestamp, frame_index, metadata = reference_frame(canonical, 0)
    _save_png(out_dir / "original_scene.png", frame)
    return {
        "policy": "automatic",
        "provenance": "real_video",
        "setup_mode": "guided_v1",
        "calibration_confirmed": False,
        "video": {
            "source_kind": "processed_file",
            "file": canonical.relative_to(out_dir).as_posix(),
            "sha256": sha256_file(canonical),
            **metadata,
        },
        "original_scene": "original_scene.png",
        "tables": [],
        "staff_events": [],
        "rules": deepcopy(DEFAULT_RULES),
        "preparation": {
            "reference_t": timestamp,
            "reference_frame_index": frame_index,
            "proposal_source": "manual",
            "instructions": "Draw tabletop corners and people zones, then place each table on the floor plan. Review table identities, geometry and references before confirming setup.",
        },
    }


async def prepare_video(
    input_path, out_dir, report, *, model_dir, duration_limit=600, manual_setup=False
):
    metadata = await probe(input_path)
    if metadata["duration_s"] > duration_limit:
        raise ValueError(f"Video exceeds the {duration_limit:g}-second duration limit.")
    original_hash = await asyncio.to_thread(sha256_file, input_path)
    report("normalizing", 0.1, {"duration_s": metadata["duration_s"]})
    executable = shutil.which("ffmpeg")
    if not executable:
        raise ValueError("FFmpeg is required to prepare uploaded videos.")
    canonical = out_dir / "media" / "source.mp4"
    canonical.parent.mkdir(parents=True, exist_ok=True)
    # All newly uploaded media uses a canonical zero-origin 30fps clock. This
    # avoids interpreting VFR frame indexes as source timestamps downstream.
    await run_process(
        [
            executable,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            input_path,
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,setpts=PTS-STARTPTS",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            canonical,
        ]
    )
    await probe(canonical)
    if input_path != canonical:
        input_path.unlink(missing_ok=True)
    if manual_setup:
        report("preparing_manual_setup", 0.55, {})
        layout = await asyncio.to_thread(manual_layout, canonical, out_dir)
    else:
        report("proposing_tables", 0.55, {})
        await run_process(
            [
                sys.executable,
                "-m",
                "service.job_runner",
                "prepare",
                "--video",
                canonical,
                "--out",
                out_dir,
                "--model-dir",
                model_dir,
            ],
            processor_report(report),
        )
        layout = load_json(out_dir / "layout.json")
    layout["source_provenance"] = {
        "original_sha256": original_hash,
        "original_metadata": metadata,
        "canonical_sha256": layout["video"]["sha256"],
        "normalization": "H264 MP4, 30fps, zero-origin, max1920x1080, no audio",
    }
    return layout


async def analyze_video(layout_path, out_dir, detection_only, report, *, model_dir):
    layout = load_json(layout_path)
    source = out_dir / layout["video"]["file"]
    args = [
        sys.executable,
        "-m",
        "service.job_runner",
        "analyze",
        "--video",
        source,
        "--layout",
        layout_path,
        "--out",
        out_dir,
        "--model-dir",
        model_dir,
    ]
    if detection_only:
        args.append("--skip-surface")
    await run_process(args, processor_report(report))
    return load_json(out_dir / "bundle.json")
