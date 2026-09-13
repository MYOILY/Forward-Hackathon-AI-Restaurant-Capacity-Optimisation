"""Automatic local pipeline: source tracking -> shared scheduler -> CPU object/reference evidence.

All service-state decisions remain in TypeScript. This module exports measured
image/track/model evidence and never manufactures a cleaning state.
"""

from __future__ import annotations

import copy
import hashlib
from importlib.metadata import version
import math
from pathlib import Path
import shutil
from time import perf_counter

import cv2
import numpy as np

from .coordinator import TSPlannerProcess, validate_assessment_identity
from .detector import YOLOXDetector
from .io import (
    atomic_copy,
    atomic_json,
    load_json,
    resolve_media,
    sha256_file,
    validate_bundle,
    validate_layout,
    validate_image_asset,
)
from .object_surface import ObjectSurfaceModel, MODEL_ID
from .object_baseline import CONFIG_SHA256, SURFACE_METHOD, validate_baseline
from .models import MODEL_HASHES
from .images import _save_image_bytes, _save_png, _source_filename
from .references import _original_scene_source_t, _reference_inputs
from .telemetry import _distribution, _hardware, _versions
from .geometry import _expanded, _polygon
from .surface import SurfaceMonitor
from .tracking import PeopleTracker
from .geometry import geometry_hash, rectify_tabletop
from .video import VideoReader, reference_frame

RECTIFY_MAX_SIDE = 512
SURFACE_DECISION_POLICY = load_json(
    Path(__file__).resolve().parents[1] / "shared/surface-decision-policy.json"
)
REFERENCE_ALIGNMENT_CONFIG = load_json(
    Path(__file__).resolve().parents[1] / "shared/reference-alignment-config.json"
)
DEFAULT_RULES = {
    "entry_s": 5.0,
    "exit_s": 5.0,
    "gap_s": 1.0,
    "track_grace_s": 1.0,
    "assessment_separation_s": 2.0,
    "assessment_retry_s": 5.0,
}


def _detector(args, *, preparation=False):
    confidence = (
        args.confidence
        if args.confidence is not None
        else (0.3 if preparation else 0.1)
    )
    if not preparation and abs(confidence - 0.1) > 1e-10:
        raise ValueError(
            "Tracking uses a .1 person detector floor for ByteTrack recovery"
        )
    return YOLOXDetector(
        model=args.model,
        model_dir=args.model_dir,
        score_threshold=confidence,
        nms_threshold=args.nms_threshold,
        intra_threads=args.intra_threads,
        class_ids=(60,) if preparation else (0,),
    )


def _image_asset(image, output, relative_prefix):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise ValueError("Could not encode rectified tabletop evidence")
    data = encoded.tobytes()
    digest = hashlib.sha256(data).hexdigest()
    relative = f"{relative_prefix}-{digest[:12]}.png"
    _save_image_bytes(Path(output) / relative, data)
    return relative, digest


def _copy_setup_asset(asset, layout_root, output, kind):
    """Verify actual setup pixels and copy them into the portable output bundle."""
    validate_image_asset(asset)
    original = resolve_media(layout_root, asset["file"])
    if sha256_file(original) != asset["sha256"]:
        raise ValueError(f"{kind} image hash mismatch")
    image = cv2.imread(str(original), cv2.IMREAD_COLOR)
    if image is None or image.shape[:2] != (asset["height"], asset["width"]):
        raise ValueError(f"{kind} image dimensions differ from the saved asset")
    if original.suffix.lower() not in (".png", ".jpg", ".jpeg"):
        raise ValueError("Setup assets must be PNG or JPEG images")
    relative = f"setup-assets/{kind}-{asset['sha256'][:16]}{original.suffix.lower()}"
    atomic_copy(original, Path(output) / relative)
    return {**asset, "file": relative}, image


def prepare(args, progress=None):
    """Propose table-only geometry and capture actual, unapproved references."""

    def report(phase, fraction, **details):
        if progress is not None:
            progress(phase, fraction, details)

    report("Opening source video", 0.0)
    cv2.setNumThreads(1)
    source, output = Path(args.video).resolve(), Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    frame, t, frame_index, metadata = reference_frame(source, args.reference_time)
    report("Loading table detector", 0.1, source_t=t, frame_index=frame_index)
    detector = _detector(args, preparation=True)
    report("Detecting table proposals", 0.25, model=args.model)
    detections = detector.detect(frame)
    boxes = sorted(
        (item["box"] for item in detections if item["class_id"] == 60),
        key=lambda box: (box[1], box[0]),
    )
    columns, tables = max(1, math.ceil(math.sqrt(len(boxes)))), []
    rows = max(1, math.ceil(len(boxes) / columns))
    report("Preparing source references", 0.45, proposed_tables=len(boxes))
    for index, box in enumerate(boxes):
        table = {
            "id": f"T{index + 1}",
            "label": f"Table {index + 1}",
            "video_region": box,
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
        }
        table["geometry_sha256"] = geometry_hash(table)
        table["surface_method"] = SURFACE_METHOD
        path, digest = _image_asset(
            rectify_tabletop(frame, table["tabletop_polygon"], RECTIFY_MAX_SIDE),
            output,
            f"references/table-{index + 1}",
        )
        table["reference"] = {
            "file": path,
            "sha256": digest,
            "source_t": t,
            "confirmed_clean": bool(args.confirmed_clean),
        }
        if args.confirmed_clean:
            table["reference"]["reviewed_by"] = "operator_cli_confirmed_clean"
        tables.append(table)
        report(
            "Preparing source references",
            0.45 + 0.35 * len(tables) / len(boxes),
            proposed_tables=len(boxes),
            references_prepared=len(tables),
        )
    report("Saving table setup", 0.85, proposed_tables=len(tables))
    source_file = _source_filename(source)
    atomic_copy(source, output / source_file)
    _save_png(output / "original_scene.png", frame)
    layout = {
        "policy": "automatic",
        "provenance": args.provenance or "real_video",
        "calibration_confirmed": False,
        "video": {"file": source_file, "source_kind": "processed_file", "sha256": sha256_file(source), **metadata},
        "original_scene": "original_scene.png",
        "tables": tables,
        "staff_events": [],
        "rules": copy.deepcopy(DEFAULT_RULES),
        "preparation": {
            "reference_t": t,
            "reference_frame_index": frame_index,
            "model": args.model,
            "model_sha256": detector.sha256,
            "detections": detections,
            "proposal_source": "model_inference",
            "detected_classes": [60],
            "instructions": "Review/add all configured tables. Set four ordered tabletop corners and body-centre occupancy polygons from the source image; no chairs required. After editing, use refresh-references to regenerate final geometry hashes and actual source references. Set calibration_confirmed only after review. confirmed_clean is an explicit reference approval, never an inferred opening state.",
            "warning": (
                "No tables detected: add source geometry manually before analysis."
                if not tables
                else "Table boxes are proposals, not perspective-correct tabletop boundaries."
            ),
        },
    }
    if tables:
        validate_layout(layout)
    atomic_json(output / "layout.json", layout)
    report(
        "Table setup ready for review",
        1.0,
        proposed_tables=len(tables),
        calibration_confirmed=False,
    )
    return {
        "layout": str(output / "layout.json"),
        "proposed_tables": len(tables),
        "calibration_confirmed": False,
        "warning": layout["preparation"]["warning"],
    }


def refresh_references(source, tables, output, *, layout_root=None):
    """Regenerate final perspective references at exact recorded source times.

    Preserve reference approvals and times. Geometry hash reflects reviewed
    polygons; enabled-table pixels are re-derived from the verified video.
    Disabled tables retain existing hash-verified reference images without a
    source decode; their non-null references require an explicit layout_root.
    """
    updated, targets, records = copy.deepcopy(tables), {}, []
    for index, table in enumerate(updated):
        table["geometry_sha256"] = geometry_hash(table)
        reference = table.get("reference")
        if reference is not None:
            if reference.get("source_kind") == "uploaded_image":
                if layout_root is None:
                    raise ValueError(
                        "Uploaded clean references require their layout_root"
                    )
                if (
                    reference.get("alignment_confirmed") is not True
                    or reference.get("source_t") != 0
                ):
                    raise ValueError(
                        "Uploaded clean references require approved alignment and time-zero availability"
                    )
                asset, full_image = _copy_setup_asset(
                    reference.get("source_image"),
                    layout_root,
                    output,
                    "clean_reference",
                )
                previous_file, previous_hash = reference["file"], reference.get(
                    "sha256"
                )
                image = rectify_tabletop(
                    full_image, table["tabletop_polygon"], RECTIFY_MAX_SIDE
                )
                relative, digest = _image_asset(
                    image, output, f"references/table-{index + 1}"
                )
                reference.update(file=relative, sha256=digest, source_image=asset)
                table["reference_source"] = "uploaded_image"
                table["reference_image_sha256"] = asset["sha256"]
                records.append(
                    {
                        "table_id": table["id"],
                        "source_kind": "uploaded_image",
                        "source_frame_verified": False,
                        "source_image": asset,
                        "source_t": 0,
                        "alignment_confirmed": True,
                        "geometry_sha256": table["geometry_sha256"],
                        "tabletop_polygon": table["tabletop_polygon"],
                        "previous_reference_file": previous_file,
                        "previous_reference_sha256": previous_hash,
                        "output_file": relative,
                        "sha256": digest,
                        "width": image.shape[1],
                        "height": image.shape[0],
                        "confirmed_clean": reference["confirmed_clean"],
                        "reviewed_by": reference.get("reviewed_by"),
                    }
                )
                continue
            if table.get("monitoring_enabled", True) is False:
                if layout_root is None:
                    raise ValueError(
                        "Copying a disabled table reference requires its layout_root"
                    )
                original = resolve_media(layout_root, reference["file"])
                digest = sha256_file(original)
                if digest != reference.get("sha256"):
                    raise ValueError(
                        f"Reference image hash mismatch for disabled table {table['id']}"
                    )
                if original.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                    raise ValueError(
                        "Reference media must be PNG, JPEG or WebP image files"
                    )
                decoded = cv2.imread(str(original), cv2.IMREAD_COLOR)
                if decoded is None or not decoded.size:
                    raise ValueError(
                        f"Disabled table reference cannot be decoded: {reference['file']}"
                    )
                previous_file = reference["file"]
                relative = f"references/table-{index + 1}-disabled-{digest[:12]}{original.suffix.lower()}"
                atomic_copy(original, Path(output) / relative)
                reference["file"] = relative
                records.append(
                    {
                        "table_id": table["id"],
                        "source_kind": "disabled_reference_copy",
                        "source_frame_verified": False,
                        "monitoring_enabled": False,
                        "source_file": previous_file,
                        "output_file": relative,
                        "sha256": digest,
                        "source_t": reference["source_t"],
                        "geometry_sha256": table["geometry_sha256"],
                        "width": decoded.shape[1],
                        "height": decoded.shape[0],
                        "confirmed_clean": reference["confirmed_clean"],
                        "reviewed_by": reference.get("reviewed_by"),
                    }
                )
                continue
            t = reference.get("source_t")
            if type(t) not in (int, float) or not math.isfinite(t) or t < 0:
                raise ValueError(
                    "Reference source_t must identify an actual source frame"
                )
            targets.setdefault(t, []).append(index)
    pending = sorted(targets)
    if pending:
        with VideoReader(source) as reader:
            for frame_index, t, frame in reader.frames():
                if not pending:
                    break
                target = pending[0]
                if t + 1e-8 < target:
                    continue
                if abs(t - target) > 1e-6:
                    raise ValueError(
                        f"Reference time {target} does not match an exact source frame; next frame is {t}"
                    )
                for index in targets[target]:
                    table, reference = updated[index], updated[index]["reference"]
                    previous_file, previous_hash = reference["file"], reference.get(
                        "sha256"
                    )
                    image = rectify_tabletop(
                        frame, table["tabletop_polygon"], RECTIFY_MAX_SIDE
                    )
                    relative, digest = _image_asset(
                        image, output, f"references/table-{index + 1}"
                    )
                    reference.update(file=relative, sha256=digest)
                    records.append(
                        {
                            "table_id": table["id"],
                            "source_kind": "video_frame_rectified",
                            "source_t": target,
                            "frame_index": frame_index,
                            "geometry_sha256": table["geometry_sha256"],
                            "tabletop_polygon": table["tabletop_polygon"],
                            "previous_reference_file": previous_file,
                            "previous_reference_sha256": previous_hash,
                            "output_file": relative,
                            "sha256": digest,
                            "width": image.shape[1],
                            "height": image.shape[0],
                            "confirmed_clean": reference["confirmed_clean"],
                            "reviewed_by": reference.get("reviewed_by"),
                        }
                    )
                pending.pop(0)
    if pending:
        raise ValueError("Reference time is beyond the last decoded source frame")
    for table in updated:
        if table.get("object_baseline") is not None:
            try:
                validate_baseline(table["object_baseline"], table)
            except ValueError:
                table.pop("object_baseline", None)
    return updated, records


def refresh_layout(args):
    source, layout_path, output = (
        Path(args.video).resolve(),
        Path(args.layout).resolve(),
        Path(args.out).resolve(),
    )
    layout = load_json(layout_path)
    if "schema_version" in layout or layout.get("policy") != "automatic":
        raise ValueError(
            "Unsupported layout. Reprocess the recording before refreshing references."
        )
    if sha256_file(source) != layout["video"]["sha256"]:
        raise ValueError("Source video differs from the calibration")
    layout["tables"], records = refresh_references(
        source, layout["tables"], output, layout_root=layout_path.parent
    )
    if layout.get("floor_plan") is not None:
        layout["floor_plan"], _ = _copy_setup_asset(
            layout["floor_plan"], layout_path.parent, output, "floor_plan"
        )
    for kind, asset in list(layout.get("setup_assets", {}).items()):
        if kind not in ("clean_reference", "floor_plan"):
            raise ValueError("Unsupported setup asset kind")
        layout["setup_assets"][kind], _ = _copy_setup_asset(
            asset, layout_path.parent, output, kind
        )
    source_file = _source_filename(source)
    atomic_copy(source, output / source_file)
    layout["video"]["file"] = source_file
    if layout.get("original_scene"):
        original = resolve_media(layout_path.parent, layout["original_scene"])
        atomic_copy(original, output / "original_scene.png")
        layout["original_scene"] = "original_scene.png"
    layout.setdefault("preparation", {})["reference_refresh"] = records
    validate_layout(layout)
    atomic_json(output / "layout.json", layout)
    return {"layout": str(output / "layout.json"), "references_refreshed": len(records)}


def analyze(args, progress=None):
    started = perf_counter()
    skip_surface = bool(getattr(args, "skip_surface", False))

    def report(phase, fraction, **details):
        if progress is not None:
            progress(phase, fraction, details)

    report("Validating source and calibration", 0.0)
    cv2.setNumThreads(1)
    source, layout_path, output = (
        Path(args.video).resolve(),
        Path(args.layout).resolve(),
        Path(args.out).resolve(),
    )
    layout = load_json(layout_path)
    validate_layout(layout)
    output.mkdir(parents=True, exist_ok=True)
    if layout["rules"].get("demo_timing_scale") is not None and args.provenance not in (
        None,
        "ai_generated_video",
        "synthetic_fixture",
    ):
        raise ValueError("Accelerated decision waits cannot be applied to real video")
    if getattr(args, "entry_seconds", None) is not None:
        layout["rules"]["entry_s"] = args.entry_seconds
        validate_layout(layout)
    confirmed = layout.get("calibration_confirmed") is True
    if not confirmed and not args.accept_proposals:
        raise ValueError(
            "Review source polygons and set calibration_confirmed:true, or explicitly --accept-proposals for an unvalidated demo"
        )
    video_hash, layout_hash = sha256_file(source), sha256_file(layout_path)
    if video_hash != layout["video"]["sha256"]:
        raise ValueError("Source video SHA-256 differs from calibration")
    reference_assets = _reference_inputs(layout, layout_path.parent)
    for table in layout["tables"]:
        reference = table.get("reference")
        if (
            reference
            and sha256_file(resolve_media(layout_path.parent, reference["file"]))
            != reference["sha256"]
        ):
            raise ValueError(f"Reference image hash mismatch for {table['id']}")
    preflight_s = perf_counter() - started
    report(
        "Refreshing reviewed source references", 0.05, table_count=len(layout["tables"])
    )
    reference_started = perf_counter()
    tables, refreshed = refresh_references(
        source, layout["tables"], output, layout_root=layout_path.parent
    )
    reference_assets.extend(refreshed)
    for table in tables:
        table["surface_method"] = SURFACE_METHOD
    monitoring_scope = {
        "enabled_table_ids": [
            table["id"]
            for table in tables
            if table.get("monitoring_enabled", True) is not False
        ],
        "disabled_table_ids": [
            table["id"]
            for table in tables
            if table.get("monitoring_enabled", True) is False
        ],
        "detector_scope": "One shared full-frame person detection pass; disabling tables does not reduce detector input or cadence.",
    }
    stages = {
        "reference_refresh": perf_counter() - reference_started,
        "decode": 0.0,
        "preprocess": 0.0,
        "inference": 0.0,
        "postprocess": 0.0,
        "tracking": 0.0,
        "surface_monitor": 0.0,
        "asset_copy": 0.0,
        "assessment_decode": 0.0,
        "crop_encode": 0.0,
        "planner_ipc": 0.0,
        "surface_inference": 0.0,
        "reference_compare": 0.0,
        "output_write": 0.0,
    }
    report(
        "Loading person detector and tracker",
        0.1,
        model=args.model,
        table_count=len(tables),
    )
    detector = _detector(args)
    tracker_started = perf_counter()
    tracker = PeopleTracker(
        layout["video"]["width"],
        layout["video"]["height"],
        layout["video"]["fps"],
        clip_id=video_hash[:12],
    )
    tracker_startup_s = perf_counter() - tracker_started
    monitor = SurfaceMonitor(tables)
    samples, timings, valid_so_far = [], [], 0
    with VideoReader(source) as reader:
        if (reader.width, reader.height) != (
            layout["video"]["width"],
            layout["video"]["height"],
        ) or abs(reader.fps - layout["video"]["fps"]) > max(0.01, reader.fps * 0.001):
            raise ValueError("Source dimensions/frame rate disagree with calibration")
        for frame_index, t, frame in reader.sampled_frames(args.sample_hz):
            valid, error, detections = True, None, []
            try:
                detections = detector.detect(frame)
            except Exception as exc:
                valid, error = False, f"{type(exc).__name__}: {exc}"[:600]
            for key in ("preprocess", "inference", "postprocess"):
                stages[key] += detector.last_timing[key]
            timing = {**detector.last_timing, "valid": valid}
            surface_started = perf_counter()
            try:
                surface = monitor.update(frame, detections, valid=valid)
            except Exception as exc:
                # Preserve reliable people data if tabletop extraction alone fails.
                surface = {
                    "scene_cut": False,
                    "surface": {
                        table["id"]: {"visible": None, "changed": False}
                        for table in tables
                    },
                }
                error = f"Surface analysis: {type(exc).__name__}: {exc}"[:600]
            stages["surface_monitor"] += perf_counter() - surface_started
            track_started = perf_counter()
            try:
                evidence = tracker.update(
                    detections,
                    tables,
                    t,
                    frame_index,
                    valid=valid,
                    scene_cut=surface["scene_cut"],
                )
            except Exception as exc:
                valid, error = False, f"Tracking: {type(exc).__name__}: {exc}"[:600]
                evidence = {
                    "tracks": [],
                    "tables": {table["id"]: "uncertain" for table in tables},
                }
                surface = {
                    "scene_cut": surface["scene_cut"],
                    "surface": {
                        table["id"]: {"visible": None, "changed": False}
                        for table in tables
                    },
                }
            stages["tracking"] += perf_counter() - track_started
            timing["valid"] = valid
            timings.append(timing)
            sample = {
                "t": float(t),
                "frame_index": frame_index,
                "valid": valid,
                "detections": detections,
                **evidence,
                **surface,
            }
            if error:
                sample["error"] = error
            samples.append(sample)
            valid_so_far += int(valid)
            if progress is not None and (len(samples) == 1 or len(samples) % 10 == 0):
                report(
                    "Analyzing people and tabletop visibility",
                    0.15 + 0.5 * min(1.0, t / reader.duration_s),
                    source_t=t,
                    duration_s=reader.duration_s,
                    sampled_frames=len(samples),
                    valid_samples=valid_so_far,
                    table_count=len(tables),
                )
        decoded_frames, stages["decode"] = reader.decoded_frames, reader.decode_s
        duration = max(reader.duration_s, reader.last_t + 1 / reader.fps)
    if not samples:
        raise ValueError("No source frames sampled")
    report(
        "Saving source evidence",
        0.65,
        sampled_frames=len(samples),
        table_count=len(tables),
    )
    assets_started = perf_counter()
    source_file = _source_filename(source)
    atomic_copy(source, output / source_file)
    original_scene = None
    if layout.get("original_scene"):
        identity = next(item for item in reference_assets if item["table_id"] is None)
        actual = resolve_media(layout_path.parent, layout["original_scene"])
        original_scene = f"references/original_scene-{identity['sha256'][:12]}{actual.suffix.lower()}"
        atomic_copy(actual, output / original_scene)
        identity["output_file"] = original_scene
    stages["asset_copy"] = perf_counter() - assets_started
    bundle = {
        "policy": "automatic",
        "provenance": args.provenance or layout.get("provenance", "real_video"),
        "video": {
            **layout["video"],
            "file": source_file,
            "sha256": video_hash,
            "duration_s": duration,
        },
        "original_scene": original_scene,
        "tables": tables,
        "observations": samples,
        "staff_events": copy.deepcopy(layout["staff_events"]),
        "assessment_requests": [],
        "assessments": [],
        "rules": copy.deepcopy(layout["rules"]),
        "analysis": {
            "observation_source": "model_inference",
            "precomputed": True,
            "model": args.model,
            "model_sha256": detector.sha256,
            "provider": "CPUExecutionProvider",
            "sample_hz": args.sample_hz,
            "confidence": 0.1,
            "tracker": "trackers.ByteTrackTracker",
            "tracking_parameters": tracker.settings,
            "calibration_confirmed": confirmed,
            "accepted_unconfirmed_proposals": not confirmed
            and bool(args.accept_proposals),
            "original_scene_source_t": _original_scene_source_t(layout),
            "table_references_refreshed_from_source": all(
                item["source_kind"] == "video_frame_rectified" for item in refreshed
            ),
            "enabled_table_references_refreshed_from_source": all(
                item["source_kind"] == "video_frame_rectified"
                for item in refreshed
                if item.get("monitoring_enabled", True)
            ),
            "uploaded_table_references_preserved": sum(
                item["source_kind"] == "uploaded_image" for item in refreshed
            ),
            "disabled_reference_policy": "Existing valid images copied unchanged; null permitted; no disabled source extraction or asset-integrity bypass.",
            "monitoring_scope": monitoring_scope,
            "surface_model_requested": {
                "model": MODEL_ID,
                "detector_sha256": MODEL_HASHES["tiny"],
                "surface_method": SURFACE_METHOD,
                "config_sha256": CONFIG_SHA256,
            },
            "surface_decision_policy": copy.deepcopy(SURFACE_DECISION_POLICY),
            "reference_alignment": copy.deepcopy(REFERENCE_ALIGNMENT_CONFIG),
            "surface_analysis_complete": not skip_surface,
            "surface_model_skipped": bool(skip_surface),
            "association": "Observed person body-box centre inside a unique occupancy polygon; prediction never creates presence",
            "timestamp_source": "OpenCV source CAP_PROP_POS_MSEC",
            "rectification_max_side": RECTIFY_MAX_SIDE,
            "limitations": [
                "Dwell counts any person including staff; tracking is anonymous and may switch IDs.",
                "Local image comparison assesses visible reset, not sanitation; accuracy needs independent real recordings.",
                "Camera movement invalidates tabletop visibility for the remainder of this calibration.",
            ],
        },
    }
    if layout.get("floor_plan") is not None:
        bundle["floor_plan"], _ = _copy_setup_asset(
            layout["floor_plan"], layout_path.parent, output, "floor_plan"
        )
    for key in ("setup_mode", "floor_plan_mode"):
        if key in layout:
            bundle[key] = layout[key]
    if layout["rules"].get("demo_timing_scale") == 3:
        bundle["analysis"].update(
            timing_profile="demo_fast_3x",
            playback_rate=1,
            timing_description="AI/synthetic demo only: decision waits divided by three; video plays at normal speed.",
            effective_surface_timing={
                "recheck_s": SURFACE_DECISION_POLICY["stability"]["recheck_s"] / 3,
                "clearance_ttl_s": 10 / 3,
            },
        )
    validate_bundle(bundle)
    model, assessment_timings, planner_startup_s = None, [], 0.0
    audit_snapshots, replay_events = [], []
    if not skip_surface:
        node = shutil.which("node")
        if node is None:
            raise ValueError(
                "Node.js is required for the shared TypeScript status scheduler"
            )
        root = Path(__file__).resolve().parents[1]
        bridge_started = perf_counter()
        with TSPlannerProcess(
            [node, "--import", "tsx", str(root / "web/src/headless.ts"), "--stdio"],
            cwd=root,
        ) as planner:
            response = planner.send({"op": "init", "bundle": bundle})
            planner_startup_s = perf_counter() - bridge_started
            handled, requests, results = set(), [], []
            sample_by_index = {sample["frame_index"]: sample for sample in samples}
            table_by_id = {table["id"]: table for table in tables}
            with VideoReader(source) as reader:
                for frame_index, t, frame in reader.frames():
                    sample = sample_by_index.get(frame_index)
                    if sample is None:
                        continue
                    if abs(sample["t"] - t) > 1e-6:
                        raise ValueError(
                            "Assessment decode disagrees with original source timestamp"
                        )
                    fraction = 0.65 + 0.3 * min(1.0, t / duration)
                    if len(audit_snapshots) % 10 == 0:
                        report(
                            "Checking eligible tabletop references",
                            fraction,
                            source_t=t,
                            duration_s=duration,
                            assessments=len(results),
                            table_count=len(tables),
                        )
                    ipc_started = perf_counter()
                    response = planner.send({"op": "advance", "t": t})
                    stages["planner_ipc"] += perf_counter() - ipc_started
                    for request in response["requests"]:
                        if request["id"] in handled:
                            continue
                        if (
                            request["frame_index"] != frame_index
                            or abs(request["t"] - t) > 1e-6
                        ):
                            raise ValueError(
                                "Planner requested a non-current source capture; refusing future/stale assessment"
                            )
                        handled.add(request["id"])
                        table = table_by_id[request["table_id"]]
                        crop_started = perf_counter()
                        image = rectify_tabletop(
                            frame, table["tabletop_polygon"], RECTIFY_MAX_SIDE
                        )
                        relative, digest = _image_asset(
                            image,
                            output,
                            f"surface/table-{tables.index(table) + 1}-frame-{frame_index}",
                        )
                        stages["crop_encode"] += perf_counter() - crop_started
                        if model is None:
                            report(
                                "Loading tabletop CPU detector",
                                fraction,
                                table_id=table["id"],
                                assessments=len(results),
                            )
                            model = ObjectSurfaceModel(args.model_dir)
                        report(
                            "Comparing current tabletop with reference",
                            fraction,
                            table_id=table["id"],
                            source_t=t,
                            assessments=len(results),
                        )
                        assessed = model.assess(
                            resolve_media(output, table["reference"]["file"]),
                            output / relative,
                        )
                        stages["surface_inference"] += model.last_timing.get(
                            "detector_total", model.last_timing.get("inference", 0.0)
                        )
                        stages["reference_compare"] += model.last_timing.get(
                            "reference_comparison", 0.0
                        )
                        assessment_timings.append(
                            {
                                "request_id": request["id"],
                                "table_id": table["id"],
                                "t": t,
                                "frame_index": frame_index,
                                **model.last_timing,
                            }
                        )
                        result = {
                            **{
                                key: value
                                for key, value in request.items()
                                if key != "id"
                            },
                            "id": f"assessment-{len(results) + 1}",
                            "request_id": request["id"],
                            "crop_sha256": digest,
                            "crop_file": relative,
                            "model": MODEL_ID,
                            **assessed,
                        }
                        validate_assessment_identity(request, result)
                        ipc_started = perf_counter()
                        response = planner.send(
                            {"op": "assessment", "assessment": result}
                        )
                        stages["planner_ipc"] += perf_counter() - ipc_started
                        # Outcome and reason are produced by the shared TS comparator.
                        result = response.get("assessment", result)
                        if result.get("reason") == "Awaiting shared comparison":
                            raise ValueError(
                                "TypeScript planner did not return the normalized object assessment"
                            )
                        requests.append(request)
                        results.append(result)
                    # Capture once after ALL same-time assessments. The engine's
                    # cumulative event log is exported once, never per frame.
                    snapshot = response["snapshot"]
                    audit_snapshots.append(
                        {"t": snapshot["t"], "tables": snapshot["tables"]}
                    )
                stages["assessment_decode"] = reader.decode_s
            ipc_started = perf_counter()
            response = planner.send({"op": "advance", "t": duration})
            stages["planner_ipc"] += perf_counter() - ipc_started
            snapshot = response["snapshot"]
            if (
                not audit_snapshots
                or abs(audit_snapshots[-1]["t"] - snapshot["t"]) > 1e-8
            ):
                audit_snapshots.append(
                    {"t": snapshot["t"], "tables": snapshot["tables"]}
                )
            replay_events = snapshot["events"]
            bundle["assessment_requests"], bundle["assessments"] = requests, results
            bundle["snapshots"], bundle["replay_events"] = (
                audit_snapshots,
                replay_events,
            )
    bundle["analysis"]["surface_model"] = (
        model.metadata
        if model
        else {
            "model": MODEL_ID,
            "surface_method": SURFACE_METHOD,
            "config_sha256": CONFIG_SHA256,
            "loaded": False,
            "reason": (
                "explicit diagnostic skip"
                if skip_surface
                else "no eligible assessment requests"
            ),
        }
    )
    results = bundle["assessments"]
    coverage = {
        "requested": len(bundle["assessment_requests"]),
        "attempted": len(results),
        "valid": sum(item["valid"] for item in results),
        "conclusive": sum(
            item["valid"] and item["outcome"] != "unobservable" for item in results
        ),
        "valid_unobservable": sum(
            item["valid"] and item["outcome"] == "unobservable" for item in results
        ),
        "failed_or_malformed": sum(not item["valid"] for item in results),
        "tables_with_any_assessment": len({item["table_id"] for item in results}),
        "table_count": len(tables),
        "monitored_table_count": len(monitoring_scope["enabled_table_ids"]),
        "disabled_table_count": len(monitoring_scope["disabled_table_ids"]),
    }
    request_groups = {
        (item["table_id"], item["generation"]) for item in bundle["assessment_requests"]
    }
    result_counts = {
        "assessment_accepted": sum(
            item["kind"] == "assessment_accepted" for item in replay_events
        ),
        "assessment_rejected": sum(
            item["kind"] == "assessment_rejected" for item in replay_events
        ),
        "repeat_requests": len(bundle["assessment_requests"]) - len(request_groups),
    }
    bundle["analysis"].update(
        surface_pipeline_completed=not skip_surface,
        surface_model_ran=model is not None,
        evidence_coverage=coverage,
        assessment_event_counts=result_counts,
        surface_analysis_complete_definition="Processing-complete alias only; not an assertion of valid evidence, table readiness, coverage or accuracy.",
        audit_snapshot_source=(
            "production TypeScript planner after all same-time assessment submissions"
            if not skip_surface
            else "omitted in incomplete tracking-only diagnostic"
        ),
        audit_snapshot_timebase="source-media seconds at every actual sampled frame, plus final duration boundary; final boundary is not a captured frame",
        audit_snapshots_authoritative=False,
    )
    validate_bundle(bundle)
    report(
        "Writing analyzed bundle and measured telemetry",
        0.98,
        sampled_frames=len(samples),
        assessments=len(bundle["assessments"]),
        detection_only=bool(skip_surface),
    )
    write_started = perf_counter()
    atomic_json(output / "bundle.json", bundle)
    stages["output_write"] = perf_counter() - write_started
    total = perf_counter() - started
    valid_samples = sum(sample["valid"] for sample in samples)
    steady = [item for item in timings[20:] if item["valid"]]
    sample_gaps = np.diff([sample["t"] for sample in samples]).tolist()
    sample_gap_ms = {
        **_distribution(sample_gaps),
        "min": min(sample_gaps) * 1000 if sample_gaps else None,
        "max": max(sample_gaps) * 1000 if sample_gaps else None,
    }
    environment = _versions()
    environment["packages"].update(
        {name: version(name) for name in ("trackers", "supervision")}
    )
    telemetry = {
        "policy": "automatic",
        "provenance": bundle["provenance"],
        "video_sha256": video_hash,
        "layout_sha256": layout_hash,
        "model": {
            "name": args.model,
            "sha256": detector.sha256,
            "input_size": list(detector.input_size),
        },
        "surface_model": bundle["analysis"]["surface_model"],
        "surface_decision_policy": copy.deepcopy(SURFACE_DECISION_POLICY),
        "reference_alignment": copy.deepcopy(REFERENCE_ALIGNMENT_CONFIG),
        "environment": environment,
        "hardware": _hardware(),
        "reference_assets": reference_assets,
        "settings": {
            "provider": "CPUExecutionProvider",
            "intra_threads": args.intra_threads,
            "inter_threads": 1,
            "opencv_threads": 1,
            "sample_hz": args.sample_hz,
            "confidence": 0.1,
            "nms_threshold": args.nms_threshold,
            "batch_size": 1,
            "detector_cache_used": False,
            "tracking": tracker.settings,
            "surface_workers": 1,
            "surface_intra_threads": 1,
            "surface_skipped": bool(skip_surface),
            "rules": bundle["rules"],
            "monitoring_scope": monitoring_scope,
        },
        "counts": {
            "decoded_frames": decoded_frames,
            "sampled_frames": len(samples),
            "valid_samples": valid_samples,
            "failed_samples": len(samples) - valid_samples,
            "scene_cuts": sum(item["scene_cut"] for item in samples),
            "assessment_requests": len(bundle["assessment_requests"]),
            "assessments": len(bundle["assessments"]),
            "valid_assessments": sum(item["valid"] for item in bundle["assessments"]),
            **result_counts,
        },
        "evidence_coverage": coverage,
        "sampling": {
            "target_hz": args.sample_hz,
            "source_fps": layout["video"]["fps"],
            "actual_sample_gap_ms": sample_gap_ms,
            "note": "Source frames retain exact PTS. A 10Hz target on 24fps footage can produce 125ms gaps; independent timing gates are unchanged.",
        },
        "timing_s": {
            "total": total,
            "preflight": preflight_s,
            "startup": detector.startup_timing["session_load"],
            "runtime_import": detector.startup_timing["runtime_import"],
            "model_verify": detector.startup_timing["model_verify"],
            "detector_setup": detector.startup_timing["detector_setup"],
            "tracker_startup": tracker_startup_s,
            "planner_startup": planner_startup_s,
            "first_inference": timings[0]["inference"],
            "surface_startup": (
                model.startup_timing.get("session_load", 0.0) if model else None
            ),
            **stages,
        },
        "steady_state": {
            "excluded_initial_samples": 20,
            "samples": len(steady),
            "inference_ms": _distribution([item["inference"] for item in steady]),
            "detector_ms": _distribution(
                [
                    sum(item[key] for key in ("preprocess", "inference", "postprocess"))
                    for item in steady
                ]
            ),
        },
        "assessment_timings": assessment_timings,
        "video_duration_s": duration,
        "throughput": {
            "analyzed_fps": len(samples) / total,
            "video_seconds_per_wall_second": duration / total,
        },
        "notes": [
            "Source-time replay is offline; people and tabletop detector wall time are measured separately from browser playback.",
            "startup measures ONNX session load only; surface_startup measures the separate CPU ONNX session load. Hashes/imports are separate; total includes overlapping stage fields.",
            "Benchmark runner must sample full process-tree RSS and command wall time.",
            "Reference regeneration and assessment each decode source in separate passes; decoded_frames describes the detector pass.",
            "repeat_requests counts requests after the first per table/generation, including required positive confirmation; it is not exclusively a failed-model retry count.",
            "surface_pipeline_completed (and legacy-named surface_analysis_complete alias) describes processing only; evidence_coverage and independent labels assess what was observed.",
            "Skip-surface is explicitly incomplete diagnostic evidence, never an automatic cleaning evaluation.",
        ],
    }
    atomic_json(output / "telemetry.json", telemetry)
    report(
        "Analysis complete",
        1.0,
        sampled_frames=len(samples),
        valid_samples=valid_samples,
        failed_samples=len(samples) - valid_samples,
        assessments=len(bundle["assessments"]),
        detection_only=bool(skip_surface),
    )
    return {
        "bundle": str(output / "bundle.json"),
        "telemetry": str(output / "telemetry.json"),
        "samples": len(samples),
        "valid_samples": valid_samples,
        "failed_samples": len(samples) - valid_samples,
        "assessments": len(bundle["assessments"]),
        "surface_analysis_complete": not skip_surface,
        "elapsed_s": total,
    }
