"""Independent audit of recorded evidence supporting automatic readiness."""

from __future__ import annotations
import json
from pathlib import Path

SHARED = Path(__file__).resolve().parents[1] / "shared"
DECISION_POLICY = json.loads((SHARED / "surface-decision-policy.json").read_text())
OBJECT_CONFIG = json.loads((SHARED / "object-surface-config.json").read_text())


def ready_evidence_errors(bundle, table_id, t, state, events):
    """Audit exported identities supporting green; never calculate a service state."""
    table = next(item for item in bundle["tables"] if item["id"] == table_id)
    if state.get("people_state") != "vacant":
        return ["Ready snapshot is not stably vacant"]
    if state.get("readiness_source") == "staff_override":
        if bundle.get("schema_version") != 2 or state.get("presence") != "absent":
            return [
                "Staff override requires the current bundle format and reliable vacancy"
            ]
        person_t = state.get("people_evidence_t")
        if (
            type(person_t) not in (int, float)
            or t - person_t > bundle["rules"]["gap_s"] + 1e-6
        ):
            return ["Staff override lacks fresh person evidence"]
        declarations = {
            event["id"]: event
            for event in bundle["staff_events"]
            if event["table_id"] == table_id
            and event["action"] == "force_cleaned"
            and event["source"] == "staff"
        }
        for event in events:
            declared = declarations.get(event.get("event_id"))
            if (
                not declared
                or event["kind"] != "staff_accepted"
                or event["table_id"] != table_id
                or event["status"] != "ready"
            ):
                continue
            if (
                event["t"] != declared["t"]
                or event["t"] > t + 1e-6
                or state.get("surface_evidence_t") != event["t"]
            ):
                continue
            invalidated = any(
                later["table_id"] == table_id
                and later["kind"] == "transition"
                and later["status"] != "ready"
                and event["t"] <= later["t"] <= t
                for later in events
            )
            if not invalidated:
                return []
        return [
            "No current, actually accepted staff override supports this readiness claim"
        ]
    if state.get("readiness_source") == "staff":
        confirmations = {
            event["id"]: event
            for event in bundle["staff_events"]
            if event["table_id"] == table_id and event["action"] == "confirm_cleaned"
        }
        if any(
            event.get("event_id") in confirmations
            and event["kind"] == "staff_accepted"
            and event["t"] <= t
            for event in events
        ):
            return []
        return ["No accepted staff confirmation supports this ready snapshot"]
    generation = state.get("generation")
    reference = table.get("reference")
    if not reference or not reference.get("confirmed_clean"):
        return ["No confirmed reference supports automatic readiness"]
    requests = {
        request["id"]: request for request in bundle.get("assessment_requests", [])
    }
    rejected = {
        event.get("event_id")
        for event in events
        if event["kind"] == "assessment_rejected"
    }
    history = []
    identity_fields = (
        "table_id",
        "t",
        "frame_index",
        "generation",
        "video_sha256",
        "geometry_sha256",
        "reference_sha256",
    )
    object_mode = table.get("surface_method") == "objects_reference_v1"
    if object_mode:
        from processor.object_baseline import validate_baseline

        try:
            validate_baseline(
                table.get("object_baseline"), table, require_approved=True
            )
        except (ValueError, TypeError):
            return ["Automatic readiness lacks a current approved object baseline"]
        identity_fields += ("surface_method", "baseline_sha256", "config_sha256")
    for result in bundle.get("assessments", []):
        request = requests.get(result["request_id"])
        if (
            result["table_id"] != table_id
            or result["t"] > t + 1e-6
            or result["id"] in rejected
        ):
            continue
        if not request or any(
            result.get(key) != request.get(key) for key in identity_fields
        ):
            continue
        if (
            result["video_sha256"] != bundle["video"]["sha256"]
            or result["geometry_sha256"] != table["geometry_sha256"]
            or result["reference_sha256"] != reference.get("sha256")
        ):
            continue
        if object_mode and (
            result.get("surface_method") != "objects_reference_v1"
            or any(
                result.get(key) != table["object_baseline"][key]
                for key in ("baseline_sha256", "config_sha256")
            )
        ):
            continue
        history.append(result)
    history.sort(key=lambda result: result["t"])
    candidates = [result for result in history if result["generation"] == generation]
    scale = bundle["rules"].get("demo_timing_scale", 1)
    ttl = OBJECT_CONFIG["clearance_ttl_s"] / scale
    stability = DECISION_POLICY["stability"]
    separation = bundle["rules"]["assessment_separation_s"]
    dirty_times = [
        event["t"]
        for event in events
        if event.get("table_id") == table_id
        and event.get("kind") in ("transition", "staff_accepted")
        and event.get("status") == "needs_cleaning"
        and event["t"] <= t
    ]
    if object_mode:
        # A directly measured photo difference above the cleaning boundary is
        # independently sufficient to require recovery, even if an exported
        # transition log accidentally omitted the cleaning alert.
        dirty_times.extend(
            result["t"]
            for result in history
            if result["valid"]
            and result["outcome"] == "not_reset"
            and type(
                result.get("object_evidence", {})
                .get("reference", {})
                .get("changed_fraction")
            )
            in (int, float)
            and result["object_evidence"]["reference"]["changed_fraction"]
            > DECISION_POLICY["cleaning_changed_fraction"]
        )
    dirty_since = max(dirty_times, default=None) if object_mode else None
    if dirty_since is not None:
        # Decoder/clock failure and a camera reset discard the previous surface
        # episode; arrivals alone preserve a cleaning obligation.
        observations = [
            row for row in bundle["observations"] if dirty_since <= row["t"] <= t
        ]
        if any(
            not row["valid"]
            or row.get("tables", {}).get(table_id) == "uncertain"
            or row.get("scene_cut")
            or row.get("surface", {}).get(table_id, {}).get("camera_moved")
            for row in observations
        ):
            dirty_since = None
        if any(
            right["t"] - left["t"] > bundle["rules"]["gap_s"] + 1e-6
            for left, right in zip(observations, observations[1:])
        ):
            dirty_since = None
    qualifying_captures = (
        _qualifying_capture_times(bundle, table_id) if object_mode else set()
    )
    if dirty_since is not None:
        # A completed recovery belongs to its original surface episode. Later
        # obstruction or an unobservable result may invalidate clearance, but cannot reopen an obligation
        # that independently qualified clean captures already satisfied.
        prior_runs = _clean_capture_runs(
            history, bundle, object_mode, qualifying_captures, dirty_since
        )
        recovered = any(
            run
            and len(run) >= stability["clean_confirmation_captures"]
            and run[-1]["t"] - run[0]["t"]
            >= stability["clean_confirmation_s"] / scale - 1e-6
            for run in prior_runs
        )
        declarations = {
            event["id"]: event
            for event in bundle["staff_events"]
            if event.get("table_id") == table_id
            and event.get("action") in ("confirm_cleaned", "force_cleaned")
        }
        staff_cleared = any(
            event.get("kind") == "staff_accepted"
            and event.get("table_id") == table_id
            and event.get("event_id") in declarations
            and event["t"] == declarations[event["event_id"]]["t"]
            and dirty_since <= event["t"] <= t
            for event in events
        )
        if recovered or staff_cleared:
            dirty_since = None
    positives = _clean_capture_runs(
        candidates, bundle, object_mode, qualifying_captures, dirty_since
    )[-1]
    if object_mode and (not positives or t - positives[-1]["t"] >= ttl - 1e-6):
        return [
            "Automatic object readiness expired without a recent successful capture"
        ]
    if dirty_since is not None:
        required_count = stability["clean_confirmation_captures"]
        required_span = stability["clean_confirmation_s"] / scale
        if (
            len(positives) >= required_count
            and positives[-1]["t"] - positives[0]["t"] >= required_span - 1e-6
        ):
            return []
        return [
            f"Cleaning recovery requires {required_count} distinct qualifying captures spanning {required_span:g} seconds"
        ]
    if (
        len(positives) >= 2
        and positives[-1]["t"] - positives[0]["t"] >= separation - 1e-6
    ):
        return []
    return [
        "Initial readiness requires two distinct qualifying captures separated by the configured wait"
    ]


def _clean_capture_runs(
    candidates, bundle, object_mode, qualifying_captures, dirty_since
):
    """Group independent clean captures; invalidity ends a run, never restores dirt."""
    scale = bundle["rules"].get("demo_timing_scale", 1)
    ttl = OBJECT_CONFIG["clearance_ttl_s"] / scale
    stability = DECISION_POLICY["stability"]
    positives = []
    runs = [positives]
    prior_generation = None
    alignment_mode = None
    pending_alignment = None
    seen_frames, seen_requests, seen_results = set(), set(), set()
    for result in candidates:
        if result["generation"] != prior_generation:
            positives = []
            runs.append(positives)
            alignment_mode = pending_alignment = None
            prior_generation = result["generation"]
        if (
            result["frame_index"] in seen_frames
            or result["request_id"] in seen_requests
            or result["id"] in seen_results
        ):
            continue
        seen_frames.add(result["frame_index"])
        seen_requests.add(result["request_id"])
        seen_results.add(result["id"])
        if positives and object_mode and result["t"] - positives[-1]["t"] >= ttl - 1e-6:
            positives = []
            runs.append(positives)
        if not result["valid"] or result["outcome"] != "cleared_reset":
            positives = []
            runs.append(positives)
            pending_alignment = None
            continue
        if object_mode:
            if result["t"] not in qualifying_captures:
                positives = []
                runs.append(positives)
                continue
            reference_evidence = result.get("object_evidence", {}).get("reference", {})
            if reference_evidence.get("observable") is not True:
                positives = []
                runs.append(positives)
                continue
            difference = reference_evidence.get("changed_fraction")
            if (
                type(difference) not in (float, int)
                or difference > DECISION_POLICY["cleaning_changed_fraction"]
            ):
                positives = []
                runs.append(positives)
                continue
            mode = reference_evidence.get("alignment", {}).get("applied")
            if mode is not None:
                if alignment_mode is None:
                    alignment_mode = mode
                if mode != alignment_mode:
                    if (
                        pending_alignment is None
                        or pending_alignment[0] != mode
                        or result["t"] - pending_alignment[1] >= ttl - 1e-6
                    ):
                        pending_alignment = (mode, result["t"])
                    if (
                        result["t"] - pending_alignment[1]
                        < stability["alignment_mode_confirmation_s"] / scale - 1e-6
                    ):
                        positives = []
                        runs.append(positives)
                        continue
                    alignment_mode = mode
                pending_alignment = None
            else:
                pending_alignment = None
        if dirty_since is None or result["t"] >= dirty_since:
            positives.append(result)
    return runs


def _qualifying_capture_times(bundle, table_id):
    """Audit source capture eligibility in one pass; never emit service states."""
    vacant_since = None
    previous = None
    eligible = set()
    for sample in bundle["observations"]:
        surface = sample.get("surface", {}).get(table_id, {})
        if (
            previous is not None
            and sample["t"] - previous > bundle["rules"]["gap_s"] + 1e-6
        ):
            vacant_since = None
        if not sample["valid"] or sample["tables"].get(table_id) != "absent":
            vacant_since = None
        elif vacant_since is None:
            vacant_since = sample["t"]
        previous = sample["t"]
        if (
            vacant_since is not None
            and sample["t"] - vacant_since >= bundle["rules"]["exit_s"] - 1e-6
            and surface.get("visible") is True
            and not surface.get("camera_moved")
            and not sample.get("scene_cut")
        ):
            eligible.add(sample["t"])
    return eligible
