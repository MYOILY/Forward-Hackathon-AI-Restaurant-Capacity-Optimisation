"""Validate hand-authored labels without deriving truth from production code."""

from __future__ import annotations

from copy import deepcopy
import math
import re

STATUSES = {"unknown", "ready", "occupied", "needs_cleaning"}


def _number(value, name):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def _validate_structure(labels: dict, bundle: dict) -> None:
    expected_provenance = {
        "manual_real_video": "real_video",
        "manual_ai_video": "ai_generated_video",
        "synthetic_fixture": "synthetic_fixture",
    }
    if labels.get("provenance") not in expected_provenance:
        raise ValueError("Labels must declare independent provenance")
    sha = labels.get("video_sha256", "")
    if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise ValueError("Invalid label video SHA256")
    if sha != bundle["video"]["sha256"]:
        raise ValueError("Labels do not match the bundle video")
    if expected_provenance[labels["provenance"]] != bundle["provenance"]:
        raise ValueError(
            "Label provenance does not match source provenance; AI/synthetic evidence cannot certify real video"
        )
    duration = _number(bundle["video"]["duration_s"], "duration")
    table_ids = {table["id"] for table in bundle["tables"]}
    intervals = labels.get("intervals")
    if not isinstance(intervals, list) or not intervals:
        raise ValueError("Labels need nonempty intervals")
    grouped = {table_id: [] for table_id in table_ids}
    for interval in intervals:
        table_id = interval.get("table_id")
        if table_id not in table_ids:
            raise ValueError("Unknown label table")
        start = _number(interval.get("start"), "interval start")
        end = _number(interval.get("end"), "interval end")
        if not 0 <= start < end <= duration + 1e-6:
            raise ValueError("Label interval is out of range")
        if interval.get("occupancy") not in {"occupied", "vacant", "unobservable"}:
            raise ValueError("Invalid physical occupancy label")
        if interval.get("expected_status") not in STATUSES or not isinstance(
            interval.get("evaluable"), bool
        ):
            raise ValueError("Invalid expected service-state label")
        grouped[table_id].append(interval)
    for table_id, rows in grouped.items():
        cursor = 0.0
        for row in sorted(rows, key=lambda item: item["start"]):
            if abs(row["start"] - cursor) > 1e-6:
                raise ValueError(
                    f"Labels for {table_id} must cover the video without gaps or overlap"
                )
            cursor = row["end"]
        if abs(cursor - duration) > 1e-6:
            raise ValueError(f"Labels for {table_id} do not cover the full video")
    transitions = labels.get("transitions")
    if not isinstance(transitions, list):
        raise ValueError("Missing expected transitions")
    for transition in transitions:
        if (
            transition.get("table_id") not in table_ids
            or transition.get("status") not in STATUSES
        ):
            raise ValueError("Invalid expected transition")
        physical = _number(transition.get("physical_t"), "physical_t")
        expected = _number(transition.get("expected_t"), "expected_t")
        tolerance = _number(transition.get("tolerance_s"), "tolerance_s")
        if (
            not 0 <= physical <= expected <= duration
            or not 0 <= tolerance <= 0.2 + 1e-9
        ):
            raise ValueError(
                "Transition timing outside bounds; tolerance cannot exceed 0.2 seconds"
            )
    seen_ids = set()
    seen_order = set()
    if not isinstance(labels.get("staff_events"), list):
        raise ValueError("Missing label staff events")
    for event in labels["staff_events"]:
        key = (event.get("t"), event.get("seq"))
        if (
            not isinstance(event.get("id"), str)
            or not event["id"]
            or event["id"] in seen_ids
        ):
            raise ValueError("Staff event IDs must be unique")
        if (
            key in seen_order
            or not isinstance(event.get("seq"), int)
            or isinstance(event.get("seq"), bool)
        ):
            raise ValueError("Staff same-time ordering must be unique")
        valid_action = event.get("action") in {"confirm_cleaned", "needs_cleaning"}
        if event.get("source") == "staff":
            valid_action |= (
                event.get("action") == "force_cleaned"
                or event.get("action") == "force_status"
                and event.get("status") in STATUSES
                or event.get("action") == "clear_status_override"
                and "status" not in event
            )
        if event.get("action") != "force_status" and "status" in event:
            valid_action = False
        if event.get("table_id") not in table_ids or not valid_action:
            raise ValueError("Invalid staff event")
        if (
            event.get("source") not in {"setup", "staff"}
            or not 0 <= _number(event.get("t"), "staff time") <= duration
        ):
            raise ValueError("Invalid staff event time/source")
        seen_ids.add(event["id"])
        seen_order.add(key)


def evaluation_segments(bundle: dict, labels: dict) -> list[tuple[float, float]]:
    """Integrate over media time, including expected and possible reducer boundaries."""
    duration = bundle["video"]["duration_s"]
    points = {0.0, float(duration)}
    for interval in labels["intervals"]:
        points.update((float(interval["start"]), float(interval["end"])))
    for transition in labels["transitions"]:
        points.add(
            round(
                min(duration, transition["expected_t"] + transition["tolerance_s"]), 9
            )
        )
    rules = bundle["rules"]
    for obs in bundle["observations"]:
        for delay in (0, rules["entry_s"], rules["exit_s"], rules["gap_s"]):
            point = obs["t"] + delay
            if 0 <= point <= duration:
                points.add(round(point, 9))
    for event in bundle["staff_events"] + labels["staff_events"]:
        points.add(float(event["t"]))
    values = sorted(points)
    return [
        (left, right) for left, right in zip(values, values[1:]) if right - left > 1e-8
    ]


PEOPLE = {"vacant", "pending_arrival", "occupied", "pending_departure", "uncertain"}
SURFACE = {"cleared_reset", "needs_reset", "unverified"}


def validate_monitoring_scope(labels, bundle):
    scope = labels.get("scope")
    if scope is None:
        return set()
    if (
        not isinstance(scope, dict)
        or not isinstance(scope.get("excluded_table_ids"), list)
        or not isinstance(scope.get("reason"), str)
        or not scope["reason"].strip()
    ):
        raise ValueError(
            "Explicit monitoring scope needs excluded_table_ids and independent reason"
        )
    ids = scope["excluded_table_ids"]
    if any(not isinstance(value, str) for value in ids) or len(ids) != len(set(ids)):
        raise ValueError("Excluded table IDs must be unique strings")
    disabled = {
        table["id"]
        for table in bundle["tables"]
        if table.get("monitoring_enabled", True) is False
    }
    if not set(ids).issubset(disabled):
        raise ValueError("Independent scope cannot exclude an enabled or unknown table")
    return set(ids)


def validate_labels(labels: dict, bundle: dict) -> None:
    if (
        labels.get("schema_version") != 2
        or labels.get("policy") != "automatic_v2"
        or bundle.get("schema_version") != 2
        or bundle.get("policy") != "automatic_v2"
    ):
        raise ValueError(
            "Unsupported labels or bundle format; reprocess the recording and label the current output."
        )
    excluded = validate_monitoring_scope(labels, bundle)
    structural = deepcopy(labels)
    structural["intervals"] = [
        row for row in structural["intervals"] if row["table_id"] not in excluded
    ]
    structural["transitions"] = [
        row for row in structural["transitions"] if row["table_id"] not in excluded
    ]
    structural["staff_events"] = [
        event
        for event in structural["staff_events"]
        if event["table_id"] not in excluded
    ]
    structural_bundle = {
        **bundle,
        "tables": [table for table in bundle["tables"] if table["id"] not in excluded],
    }
    if structural_bundle["tables"]:
        _validate_structure(structural, structural_bundle)
    else:
        _validate_structure(
            {
                **structural,
                "intervals": deepcopy(labels["intervals"]),
                "transitions": deepcopy(labels["transitions"]),
                "staff_events": deepcopy(labels["staff_events"]),
            },
            bundle,
        )
    for transition in labels["transitions"]:
        if transition["tolerance_s"] > 0.1 + 1e-9:
            raise ValueError("Transition allowance cannot exceed 0.1 seconds")
    for interval in labels["intervals"]:
        if interval.get("expected_people_state") not in PEOPLE:
            raise ValueError("Invalid expected people state")
        if interval.get("expected_surface_state") not in SURFACE:
            raise ValueError("Invalid expected surface state")
        if interval.get("surface_condition") not in {
            "cleared_reset",
            "needs_reset",
            "unobservable",
        }:
            raise ValueError("Invalid independently observed surface condition")
        generation = interval.get("expected_generation")
        if "expected_generation" in interval and (
            type(generation) is not int or generation < 0
        ):
            raise ValueError("Expected generation must be a nonnegative integer")
    frames = labels.get("tracking_frames", [])
    if not isinstance(frames, list):
        raise ValueError("tracking_frames must be an array")
    seen = set()
    table_ids = {table["id"] for table in bundle["tables"]}
    for frame in frames:
        if (
            type(frame.get("frame_index")) is not int
            or frame["frame_index"] < 0
            or frame["frame_index"] in seen
        ):
            raise ValueError(
                "Tracking reference frames need unique nonnegative frame indices"
            )
        seen.add(frame["frame_index"])
        if (
            not isinstance(frame.get("t"), (int, float))
            or not math.isfinite(frame["t"])
            or not 0 <= frame["t"] <= bundle["video"]["duration_s"]
        ):
            raise ValueError("Invalid tracking reference time")
        identities = set()
        for person in frame.get("people", []):
            identity = person.get("identity")
            box = person.get("box")
            if not isinstance(identity, str) or not identity or identity in identities:
                raise ValueError(
                    "Tracking reference identities must be unique per frame"
                )
            identities.add(identity)
            if (
                person.get("table_id") is not None
                and person["table_id"] not in table_ids
            ):
                raise ValueError("Unknown table in tracking reference")
            if (
                not isinstance(box, list)
                or len(box) != 4
                or any(
                    type(x) not in (int, float)
                    or not math.isfinite(x)
                    or not 0 <= x <= 1
                    for x in box
                )
                or box[0] >= box[2]
                or box[1] >= box[3]
            ):
                raise ValueError("Invalid tracking reference box")
