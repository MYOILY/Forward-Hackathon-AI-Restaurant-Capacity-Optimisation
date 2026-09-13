"""Strict JSON, media-path and shared-contract validation, plus atomic IO."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import tempfile
from pathlib import Path


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: str | Path) -> dict:
    def reject_constant(value):
        raise ValueError(f"Nonfinite JSON number: {value}")

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result

    with Path(path).open(encoding="utf-8") as stream:
        result = json.load(
            stream, parse_constant=reject_constant, object_pairs_hook=unique_object
        )
    if not isinstance(result, dict):
        raise ValueError("JSON document must be an object")
    return result


def atomic_json(path: str | Path, value: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_copy(source: str | Path, destination: str | Path) -> None:
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    os.close(descriptor)
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def is_safe_media_path(value) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and re.search(r"[\\?#:\x00-\x1f]", value) is None
        and not value.startswith("/")
        and all(
            part not in ("", ".", "..")
            and re.search(r"%2e|%2f|%5c", part, re.I) is None
            for part in value.split("/")
        )
    )


def resolve_media(root: str | Path, relative: str) -> Path:
    if not is_safe_media_path(relative):
        raise ValueError(f"Unsafe relative media path: {relative!r}")
    root = Path(root).resolve()
    resolved = (root / relative).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("Media symlink escapes its bundle directory")
    if not resolved.is_file():
        raise ValueError(f"Missing media file: {relative}")
    return resolved


def _number(value, positive=False, unit=False) -> bool:
    return (
        type(value) in (int, float)
        and math.isfinite(value)
        and (not positive or value > 0)
        and (not unit or 0 <= value <= 1)
    )


def _integer(value, minimum=0) -> bool:
    return type(value) is int and minimum <= value <= 9007199254740991


def _box(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 4
        and all(_number(item, unit=True) for item in value)
        and value[0] < value[2]
        and value[1] < value[3]
    )


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_image_asset(asset):
    _require(
        isinstance(asset, dict) and set(asset) == {"file", "sha256", "width", "height"},
        "Invalid setup image asset fields",
    )
    _require(is_safe_media_path(asset.get("file")), "Invalid setup image asset path")
    _require(
        isinstance(asset.get("sha256"), str)
        and re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]),
        "Invalid setup image hash",
    )
    _require(
        all(
            _integer(asset.get(key), 1) and asset[key] <= 8192
            for key in ("width", "height")
        )
        and asset["width"] * asset["height"] <= 16_000_000,
        "Invalid setup image dimensions",
    )


def validate_layout(layout: dict) -> None:
    """Validate the common layout/bundle fields; no filesystem is accessed."""
    _require(
        isinstance(layout, dict)
        and "schema_version" not in layout,
        "Unsupported bundle format. Reprocess the recording with the current application.",
    )
    _require(
        layout.get("policy") == "automatic",
        "Unsupported processing policy. Reprocess the recording with the current application.",
    )
    if layout.get("floor_plan") is not None:
        validate_image_asset(layout["floor_plan"])
    if "setup_mode" in layout:
        _require(layout["setup_mode"] == "guided_v1", "Invalid setup mode")
    if "floor_plan_mode" in layout:
        _require(
            layout["floor_plan_mode"] in ("uploaded", "schematic"),
            "Invalid floor plan mode",
        )
    if "provenance" in layout:
        _require(
            layout["provenance"]
            in ("real_video", "synthetic_fixture", "ai_generated_video"),
            "Invalid layout provenance",
        )
    video = layout.get("video")
    _require(isinstance(video, dict), "Missing video metadata")
    _require(video.get("source_kind") == "processed_file", "Unsupported video source kind")
    _require(is_safe_media_path(video.get("file")), "Invalid video media path")
    _require(
        isinstance(video.get("sha256"), str)
        and re.fullmatch(r"[a-fA-F0-9]{64}", video["sha256"]),
        "Invalid video SHA-256",
    )
    for key in ("width", "height"):
        _require(_integer(video.get(key), 1), f"Invalid video {key}")
    for key in ("fps", "duration_s"):
        _require(_number(video.get(key), positive=True), f"Invalid video {key}")
    duration = video["duration_s"]
    original = layout.get("original_scene")
    _require(
        original is None or is_safe_media_path(original), "Invalid original scene path"
    )
    rules = layout.get("rules")
    _require(isinstance(rules, dict), "Missing rules")
    for key in ("entry_s", "exit_s", "gap_s"):
        _require(_number(rules.get(key), positive=True), f"Invalid rule {key}")
    demo_timing = "demo_timing_scale" in rules
    if demo_timing:
        _require(
            type(rules["demo_timing_scale"]) is int
            and rules["demo_timing_scale"] == 3
            and layout.get("provenance") in ("ai_generated_video", "synthetic_fixture"),
            "Accelerated timing is limited to explicitly labelled AI or synthetic demos",
        )
        expected = {
            "entry_s": 5 / 3,
            "exit_s": 5 / 3,
            "assessment_separation_s": 2 / 3,
            "assessment_retry_s": 5 / 3,
            "gap_s": 1,
            "track_grace_s": 1,
        }
        _require(
            all(
                _number(rules.get(key)) and abs(rules[key] - seconds) <= 1e-9
                for key, seconds in expected.items()
            ),
            "demo_fast_3x requires its exact decision waits and unchanged frame freshness",
        )
    _require(
        demo_timing or 5 <= rules["entry_s"] <= 10,
        "Automatic dwell must be 5..10 source seconds",
    )
    for key in ("assessment_separation_s", "assessment_retry_s", "track_grace_s"):
        _require(
            _number(rules.get(key), positive=True),
            f"Missing or invalid automatic rule {key}",
        )
    _require(
        demo_timing
        or rules["assessment_separation_s"] >= 2
        and rules["assessment_retry_s"] <= 5,
        "Automatic assessment separation/retry must be >=2s and <=5s",
    )
    tables = layout.get("tables")
    _require(
        isinstance(tables, list) and len(tables) > 0,
        "Layout needs at least one confirmed table; edit layout.json before analysis",
    )
    table_ids = set()
    for table in tables:
        _require(isinstance(table, dict), "Table must be an object")
        table_id = table.get("id")
        _require(
            isinstance(table_id, str) and bool(table_id) and table_id not in table_ids,
            "Table IDs must be nonempty and unique",
        )
        table_ids.add(table_id)
        if "monitoring_enabled" in table:
            _require(
                type(table["monitoring_enabled"]) is bool,
                "monitoring_enabled requires an explicit boolean",
            )
        if "setup_review" in table:
            review = table["setup_review"]
            _require(
                isinstance(review, dict)
                and set(review) == {"tabletop", "occupancy", "map"}
                and all(type(value) is bool for value in review.values()),
                "Invalid guided table review",
            )
        if "expected_objects_draft" in table:
            from .object_baseline import validate_inventory

            validate_inventory(table["expected_objects_draft"])
        _require(isinstance(table.get("label"), str), f"Invalid label for {table_id}")
        _require(
            _box(table.get("video_region")) and _box(table.get("crop")),
            f"Invalid image geometry for {table_id}",
        )
        position = table.get("map")
        _require(
            isinstance(position, dict)
            and all(
                _number(position.get(key), unit=True) for key in ("x", "y", "w", "h")
            ),
            f"Invalid map coordinates for {table_id}",
        )
        _require(
            position["w"] > 0
            and position["h"] > 0
            and position.get("shape") in ("rect", "round"),
            f"Invalid map shape for {table_id}",
        )
        rotation = position.get("rotation", 0)
        _require(
            _number(rotation) and 0 <= rotation < 360,
            f"Invalid map rotation for {table_id}; use degrees from 0 to less than 360",
        )
        from .geometry import geometry_hash

        _require(
            table.get("geometry_sha256")
            == geometry_hash(
                table.get("tabletop_polygon"), table.get("occupancy_regions")
            ),
            f"Geometry hash mismatch for {table_id}; refresh reviewed layout references",
        )
        method = table.get("surface_method")
        _require(
            not demo_timing or method == "objects_reference_v1",
            "Accelerated demo timing requires object/reference assessment tables",
        )
        if method is not None:
            from .object_baseline import SURFACE_METHOD, validate_baseline

            _require(
                method == SURFACE_METHOD,
                "Unsupported surface comparison method",
            )
            if table.get("object_baseline") is not None:
                validate_baseline(table["object_baseline"], table)
        elif table.get("object_baseline") is not None:
            raise ValueError("Object baseline requires an explicit surface_method")
        reference = table.get("reference")
        if reference is not None:
            _require(
                isinstance(reference, dict)
                and is_safe_media_path(reference.get("file")),
                f"Invalid reference for {table_id}",
            )
            _require(
                _number(reference.get("source_t"))
                and 0 <= reference["source_t"] <= duration
                and type(reference.get("confirmed_clean")) is bool,
                f"Invalid reference metadata for {table_id}",
            )
            _require(
                isinstance(reference.get("sha256"), str)
                and re.fullmatch(r"[a-f0-9]{64}", reference["sha256"]),
                f"Missing/invalid reference hash for {table_id}",
            )
            _require(
                "reviewed_by" not in reference
                or isinstance(reference["reviewed_by"], str),
                "Reference review identity must be text",
            )
            if "source_kind" in reference:
                _require(
                    reference["source_kind"] in ("video_frame", "uploaded_image"),
                    "Invalid reference source kind",
                )
            if reference.get("source_kind") == "uploaded_image":
                validate_image_asset(reference.get("source_image"))
                _require(
                    reference.get("alignment_confirmed") is True
                    and reference["source_t"] == 0,
                    "Uploaded references require confirmed alignment and availability from time zero",
                )
                _require(
                    (
                        reference["source_image"]["width"],
                        reference["source_image"]["height"],
                    )
                    == (video["width"], video["height"]),
                    "Uploaded clean reference dimensions must match the recording",
                )
            else:
                _require(
                    "source_image" not in reference
                    and "alignment_confirmed" not in reference,
                    "Uploaded reference metadata requires explicit uploaded_image source kind",
                )
    events = layout.get("staff_events")
    _require(isinstance(events, list), "staff_events must be an array")
    ids = set()
    for event in events:
        _require(isinstance(event, dict), "Invalid staff event")
        event_id = event.get("id")
        _require(
            isinstance(event_id, str) and bool(event_id) and event_id not in ids,
            "Staff event IDs must be nonempty and unique",
        )
        ids.add(event_id)
        _require(
            isinstance(event.get("table_id"), str) and event["table_id"] in table_ids,
            "Unknown table in staff event",
        )
        _require(
            _number(event.get("t"))
            and 0 <= event["t"] <= duration
            and _integer(event.get("seq")),
            "Invalid staff event time/sequence",
        )
        _require(
            "status" not in event or event.get("action") == "force_status",
            "Only force_status may carry a service status",
        )
        if event.get("action") == "force_cleaned":
            _require(
                event.get("source") == "staff",
                "Force clean requires an explicit staff event",
            )
        elif event.get("action") == "force_status":
            _require(
                event.get("source") == "staff",
                "Force status requires an explicit staff event",
            )
            _require(
                event.get("status")
                in ("unknown", "occupied", "needs_cleaning", "ready"),
                "Force status requires a valid service status",
            )
        elif event.get("action") == "clear_status_override":
            _require(
                event.get("source") == "staff" and "status" not in event,
                "Clearing a status override requires a schema 2 staff event without status",
            )
        else:
            _require(
                event.get("action") in ("confirm_cleaned", "needs_cleaning")
                and event.get("source") in ("setup", "staff"),
                "Invalid staff action/source",
            )


def validate_bundle(bundle: dict) -> None:
    validate_layout(bundle)
    _require(
        bundle.get("provenance")
        in ("real_video", "synthetic_fixture", "ai_generated_video"),
        "Invalid bundle provenance",
    )
    _require(isinstance(bundle.get("analysis"), dict), "Missing analysis metadata")
    timing_profile = (
        "demo_fast_3x" if bundle["rules"].get("demo_timing_scale") == 3 else None
    )
    _require(
        bundle["analysis"].get("timing_profile") == timing_profile,
        "Demo timing metadata must match the explicit timing rules",
    )
    samples = bundle.get("observations")
    _require(isinstance(samples, list), "observations must be an array")
    ids = {table["id"] for table in bundle["tables"]}
    previous = -1.0
    duration = bundle["video"]["duration_s"]
    for sample in samples:
        _require(isinstance(sample, dict), "Invalid observation")
        _require(
            _number(sample.get("t"))
            and 0 <= sample["t"] <= duration
            and sample["t"] > previous,
            "Observation timestamps must increase without duplicates within the video",
        )
        previous = sample["t"]
        _require(
            _integer(sample.get("frame_index")) and type(sample.get("valid")) is bool,
            "Invalid observation metadata",
        )
        presence = sample.get("tables")
        _require(
            isinstance(presence, dict)
            and set(presence) == ids
            and all(
                value in ("present", "absent", "uncertain")
                for value in presence.values()
            ),
            "Missing, unknown, or invalid table observations",
        )
        _require(
            sample["valid"] or all(value == "uncertain" for value in presence.values()),
            "Failed inference must make all tables uncertain",
        )
        detections = sample.get("detections")
        _require(isinstance(detections, list), "Detections must be an array")
        for detection in detections:
            _require(
                isinstance(detection, dict)
                and _integer(detection.get("class_id"))
                and detection["class_id"] < 80
                and _number(detection.get("score"), unit=True)
                and _box(detection.get("box")),
                "Invalid detection class, score or geometry",
            )
        if "error" in sample:
            _require(isinstance(sample["error"], str), "Observation error must be text")
        tracks, surface = sample.get("tracks"), sample.get("surface")
        _require(
            isinstance(tracks, list)
            and isinstance(surface, dict)
            and set(surface) == ids,
            "Automatic observations require tracks and per-table surface evidence",
        )
        track_ids = set()
        for track in tracks:
            _require(
                isinstance(track, dict)
                and isinstance(track.get("track_id"), str)
                and track["track_id"]
                and track["track_id"] not in track_ids,
                "Track IDs must be unique nonempty strings per observation",
            )
            track_ids.add(track["track_id"])
            _require(
                _box(track.get("box"))
                and _number(track.get("score"), unit=True)
                and type(track.get("observed")) is bool,
                "Invalid track evidence",
            )
            candidates = track.get("candidate_table_ids")
            _require(
                isinstance(candidates, list)
                and all(isinstance(item, str) and item in ids for item in candidates)
                and len(set(candidates)) == len(candidates),
                "Invalid candidate table IDs",
            )
            _require(
                track.get("table_id")
                == (candidates[0] if len(candidates) == 1 else None),
                "Track assignment must be unique or ambiguous/unassigned",
            )
            _require(
                sample["valid"] or not track["observed"],
                "Failed observations cannot contain observed tracks",
            )
        for item in surface.values():
            _require(
                isinstance(item, dict)
                and (item.get("visible") is None or type(item.get("visible")) is bool)
                and type(item.get("changed")) is bool,
                "Invalid surface visibility/change evidence",
            )
            _require(
                "camera_moved" not in item or type(item["camera_moved"]) is bool,
                "Invalid camera movement evidence",
            )
            _require(
                sample["valid"] or item["visible"] is not True,
                "Failed analysis cannot assert visible surface",
            )
        _require(
            "scene_cut" not in sample or type(sample["scene_cut"]) is bool,
            "Invalid scene cut evidence",
        )
    _validate_assessments(bundle)


def _validate_assessments(bundle):
    from .coordinator import validate_assessment_identity

    requests, results = bundle.get("assessment_requests"), bundle.get("assessments")
    _require(
        isinstance(requests, list) and isinstance(results, list),
        "Automatic bundle requires assessment request/result arrays",
    )
    _require(
        all(
            item.get("surface_method") == "objects_reference_v1"
            for item in [*requests, *results]
            if isinstance(item, dict)
        ),
        "Unsupported surface evidence. Reprocess the recording with approved object references.",
    )
    tables = {table["id"]: table for table in bundle["tables"]}
    samples = {
        (sample["frame_index"], sample["t"]) for sample in bundle["observations"]
    }
    by_id = {}
    for request in requests:
        _require(
            isinstance(request, dict)
            and isinstance(request.get("id"), str)
            and request["id"]
            and request["id"] not in by_id,
            "Duplicate/invalid assessment request ID",
        )
        table = tables.get(request.get("table_id"))
        _require(
            table is not None and table.get("reference") is not None,
            "Assessment requires a table reference",
        )
        _require(
            _integer(request.get("frame_index"))
            and _number(request.get("t"))
            and (request["frame_index"], request["t"]) in samples
            and _integer(request.get("generation")),
            "Assessment must use an actual sampled capture",
        )
        _require(
            request.get("video_sha256") == bundle["video"]["sha256"]
            and request.get("geometry_sha256") == table["geometry_sha256"]
            and request.get("reference_sha256") == table["reference"]["sha256"],
            "Assessment request source identity mismatch",
        )
        _require(
            request.get("timing_profile") == bundle["analysis"].get("timing_profile"),
            "Assessment request timing profile differs from its bundle",
        )
        if table.get("surface_method") is not None:
            from .object_baseline import SURFACE_METHOD, validate_baseline

            validate_baseline(
                table.get("object_baseline"), table, require_approved=True
            )
            _require(
                request.get("surface_method") == SURFACE_METHOD
                and request.get("baseline_sha256")
                == table["object_baseline"]["baseline_sha256"]
                and request.get("config_sha256")
                == table["object_baseline"]["config_sha256"],
                "Object assessment request baseline identity mismatch",
            )
        elif request.get("surface_method") is not None:
            raise ValueError("Object assessment requires an object baseline table")
        by_id[request["id"]] = request
    result_ids, used_requests = set(), set()
    for result in results:
        _require(
            isinstance(result, dict)
            and isinstance(result.get("id"), str)
            and result["id"]
            and result["id"] not in result_ids,
            "Duplicate/invalid assessment result ID",
        )
        result_ids.add(result["id"])
        request_id = result.get("request_id")
        _require(
            isinstance(request_id, str)
            and request_id in by_id
            and request_id not in used_requests,
            "Unknown/reused assessment request",
        )
        used_requests.add(request_id)
        validate_assessment_identity(by_id[request_id], result)
        _require(
            is_safe_media_path(result.get("crop_file"))
            and isinstance(result.get("crop_sha256"), str)
            and re.fullmatch(r"[a-f0-9]{64}", result["crop_sha256"]),
            "Invalid assessment crop identity",
        )
        _require(
            result.get("outcome") in ("cleared_reset", "not_reset", "unobservable")
            and type(result.get("valid")) is bool,
            "Invalid surface result",
        )
        for key in (
            ("reason", "model")
            if result.get("surface_method") is not None
            else ("reason", "model", "prompt_version")
        ):
            _require(
                isinstance(result.get(key), str) and result[key],
                f"Missing assessment {key}",
            )
        _require(
            result["valid"] or result["outcome"] == "unobservable",
            "Invalid assessment cannot assert clearance or reset need",
        )

        if result.get("surface_method") is not None:
            _validate_object_evidence(result.get("object_evidence"))


def _validate_object_evidence(evidence):
    from .object_surface import ALIGNMENT_CONFIG, validate_detections

    _require(isinstance(evidence, dict), "Missing raw object evidence")
    validate_detections(evidence.get("detections"))
    reference = evidence.get("reference")
    _require(
        isinstance(reference, dict) and type(reference.get("observable")) is bool,
        "Missing reference observability",
    )
    _require(
        "reason" not in reference or isinstance(reference["reason"], str),
        "Invalid reference explanation",
    )
    if "alignment" in reference:
        alignment = reference["alignment"]
        _require(
            isinstance(alignment, dict)
            and alignment.get("method") == ALIGNMENT_CONFIG["method"]
            and type(alignment.get("applied")) is bool,
            "Invalid reference alignment method",
        )
        _require(
            all(_number(alignment.get(key)) for key in ("dx", "dy")),
            "Invalid reference alignment displacement",
        )
        correlation = alignment.get("correlation")
        _require(
            "correlation" in alignment
            and (
                correlation is None or _number(correlation) and -1 <= correlation <= 1
            ),
            "Invalid reference alignment correlation",
        )
        _require(
            (
                (
                    correlation is not None
                    and correlation >= ALIGNMENT_CONFIG["min_correlation"]
                )
                if alignment["applied"]
                else alignment["dx"] == 0 and alignment["dy"] == 0
            ),
            "Untrusted reference alignment",
        )
    _require(
        "brightness_offset" in reference
        and (
            reference["brightness_offset"] is None
            or (
                _number(reference["brightness_offset"])
                and abs(reference["brightness_offset"]) <= 255
            )
        ),
        "Invalid reference brightness offset",
    )
    for key in ("changed_fraction", "largest_change_fraction", "edge_mismatch"):
        _require(
            key in reference
            and (reference[key] is None or _number(reference[key], unit=True)),
            f"Invalid reference {key}",
        )
    if reference["observable"]:
        _require(
            all(
                reference[key] is not None
                for key in (
                    "brightness_offset",
                    "changed_fraction",
                    "largest_change_fraction",
                )
            ),
            "Observable reference lacks measured comparison",
        )
    if (
        reference["changed_fraction"] is not None
        and reference["largest_change_fraction"] is not None
    ):
        _require(
            reference["largest_change_fraction"] <= reference["changed_fraction"],
            "Largest changed region exceeds total changed area",
        )
