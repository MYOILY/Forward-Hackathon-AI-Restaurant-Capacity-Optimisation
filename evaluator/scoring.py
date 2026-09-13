"""Compare independent annotations to exported production snapshots."""

from __future__ import annotations
from collections import defaultdict
from .labels import validate_monitoring_scope
from .metrics import _merge_failures, _with_observation_evidence
from .evidence import ready_evidence_errors


def _transition_metrics(labels, final_snapshot):
    actual = [
        event for event in final_snapshot["events"] if event["kind"] == "transition"
    ]
    if not any(row["status"] == "unknown" for row in labels["transitions"]):
        actual = [event for event in actual if event["status"] != "unknown"]
    used = set()
    results = []
    for expected in labels["transitions"]:
        candidates = [
            (i, event)
            for i, event in enumerate(actual)
            if i not in used
            and event["table_id"] == expected["table_id"]
            and event["status"] == expected["status"]
        ]
        if not candidates:
            results.append(
                {
                    **expected,
                    "result": "missed",
                    "actual_t": None,
                    "response_delay_s": None,
                }
            )
            continue
        index, event = min(
            candidates, key=lambda item: abs(item[1]["t"] - expected["expected_t"])
        )
        used.add(index)
        error = event["t"] - expected["expected_t"]
        results.append(
            {
                **expected,
                "actual_t": event["t"],
                "response_delay_s": event["t"] - expected["physical_t"],
                "timing_error_s": error,
                "result": (
                    "passed"
                    if -1e-6 <= error <= expected["tolerance_s"] + 1e-6
                    else "early" if error < 0 else "late"
                ),
            }
        )
    extra = [event for i, event in enumerate(actual) if i not in used]
    duplicates = []
    last = {}
    for event in actual:
        if last.get(event["table_id"]) == event["status"]:
            duplicates.append(event)
        last[event["table_id"]] = event["status"]
    return results, extra, duplicates


def _iou(a, b):
    overlap = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0, min(a[3], b[3]) - max(a[1], b[1])
    )
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap
    return overlap / union if union else 0.0


def tracking_metrics(bundle, labels):
    frames = labels.get("tracking_frames", [])
    if not frames:
        return {
            "status": "not_run",
            "reason": "Independent per-frame anonymous identity/box labels were not supplied",
        }
    from scipy.optimize import linear_sum_assignment
    import numpy as np

    observations = {row["frame_index"]: row for row in bundle["observations"]}
    last_id = {}
    previous_matched = {}
    ever_matched = set()
    switches = fragments = matched = expected_count = predicted_count = (
        correct_table
    ) = wrong_table = 0
    for annotation in sorted(frames, key=lambda row: row["frame_index"]):
        observation = observations.get(annotation["frame_index"])
        if observation is None:
            return {
                "status": "incomplete",
                "reason": f"No sampled observation matches labelled source frame {annotation['frame_index']}",
            }
        targets = annotation["people"]
        predictions = [row for row in observation.get("tracks", []) if row["observed"]]
        expected_count += len(targets)
        predicted_count += len(predictions)
        pairs = []
        if targets and predictions:
            overlaps = np.array(
                [
                    [_iou(truth["box"], guess["box"]) for guess in predictions]
                    for truth in targets
                ]
            )
            indices = linear_sum_assignment(1 - overlaps)
            pairs = [
                (int(i), int(j)) for i, j in zip(*indices) if overlaps[i, j] >= 0.5
            ]
        assigned = {i: j for i, j in pairs}
        for index, truth in enumerate(targets):
            identity = truth["identity"]
            if index not in assigned:
                previous_matched[identity] = False
                continue
            guess = predictions[assigned[index]]
            matched += 1
            if identity in last_id and last_id[identity] != guess["track_id"]:
                switches += 1
            if identity in ever_matched and not previous_matched.get(identity, False):
                fragments += 1
            correct_table += guess["table_id"] == truth["table_id"]
            wrong_table += guess["table_id"] != truth["table_id"]
            last_id[identity] = guess["track_id"]
            previous_matched[identity] = True
            ever_matched.add(identity)
    return {
        "status": "measured",
        "annotated_frames": len(frames),
        "matching": "one-to-one optimal IoU matching, IoU >= 0.5; anonymous labels independent of model IDs",
        "id_switches": switches,
        "fragmentations": fragments,
        "matched_detections": matched,
        "expected_detections": expected_count,
        "predicted_detections": predicted_count,
        "detection_precision": matched / predicted_count if predicted_count else None,
        "detection_recall": matched / expected_count if expected_count else None,
        "table_assignment_accuracy": correct_table / matched if matched else None,
        "wrong_table_assignments": wrong_table,
    }


def _score_predictions(bundle, labels, segments, snapshots, final_snapshot):
    if len(segments) != len(snapshots):
        raise ValueError("Every source-time segment requires a production snapshot")
    audit_bundle = {
        **bundle,
        "staff_events": list(
            {
                event["id"]: event
                for event in [*bundle["staff_events"], *labels["staff_events"]]
            }.values()
        ),
    }
    rows = defaultdict(list)
    for row in labels["intervals"]:
        rows[row["table_id"]].append(row)
    total = service_ok = people_ok = surface_ok = covered = unknown = all_unknown = (
        challenge
    ) = false_ready = stale_ready = occupied_green = beyond_green = dirty_green = (
        longest
    ) = tp = fp = fn = occupancy_time = 0.0
    false_reset_seconds = 0.0
    occupied_starts = {}
    for table_id, intervals in rows.items():
        active = None
        for row in sorted(intervals, key=lambda item: item["start"]):
            if row["occupancy"] == "occupied":
                if active is None:
                    active = row["start"]
                occupied_starts[(table_id, row["start"])] = active
            else:
                active = None
    unauthorized = []
    ready_sources = defaultdict(float)
    confusion = defaultdict(lambda: defaultdict(float))
    runs = defaultdict(float)
    failures = []
    challenge_failures = []
    for (start, end), snapshot in zip(segments, snapshots):
        midpoint = (start + end) / 2
        weight = end - start
        for table_id, intervals in rows.items():
            row = next(
                item for item in intervals if item["start"] <= midpoint < item["end"]
            )
            state = snapshot["tables"][table_id]
            actual = state["status"]
            expected = row["expected_status"]
            all_unknown += weight * (actual == "unknown")
            false_reset_seconds += weight * (
                actual == "needs_cleaning"
                and row["surface_condition"] == "cleared_reset"
                and row["occupancy"] == "vacant"
            )
            if row["evaluable"]:
                total += weight
                service_ok += weight * (actual == expected)
                people_ok += weight * (
                    state.get("people_state") == row["expected_people_state"]
                )
                surface_ok += weight * (
                    state.get("surface_state") == row["expected_surface_state"]
                )
                # Verifying can be the independently expected result; do not penalize legitimate scheduled checks.
                supported = (
                    state.get("people_state") != "uncertain"
                    or row["expected_people_state"] == "uncertain"
                ) and (
                    state.get("people_state") in {"occupied", "pending_departure"}
                    or state.get("surface_state") != "unverified"
                    or row["expected_surface_state"] == "unverified"
                )
                covered += weight * supported
                unknown += weight * (not supported)
                confusion[expected][actual] += weight
                if (
                    actual != expected
                    or state.get("people_state") != row["expected_people_state"]
                    or state.get("surface_state") != row["expected_surface_state"]
                ):
                    failures.append(
                        {
                            "table_id": table_id,
                            "start": start,
                            "end": end,
                            "expected": expected,
                            "actual": actual,
                            "expected_people": row["expected_people_state"],
                            "actual_people": state.get("people_state"),
                            "expected_surface": row["expected_surface_state"],
                            "actual_surface": state.get("surface_state"),
                        }
                    )
            else:
                challenge += weight
                if actual != expected:
                    challenge_failures.append(
                        {
                            "table_id": table_id,
                            "start": start,
                            "end": end,
                            "expected": expected,
                            "actual": actual,
                        }
                    )
            if row["evaluable"] and row["occupancy"] != "unobservable":
                physical = row["occupancy"] == "occupied"
                prediction = state["presence"] == "present"
                occupancy_time += weight
                tp += weight * (physical and prediction)
                fp += weight * (not physical and prediction)
                fn += weight * (physical and not prediction)
            if actual == "ready":
                ready_sources[state.get("readiness_source") or "unattributed"] += weight
                false_ready += weight * (expected != "ready")
                stale_ready += weight * (
                    "expected_generation" in row
                    and state.get("generation") != row["expected_generation"]
                )
                dirty_green += weight * (row["surface_condition"] == "needs_reset")
                if row["occupancy"] == "occupied":
                    beyond_green += max(
                        0,
                        end
                        - max(start, occupied_starts[(table_id, row["start"])] + 0.1),
                    )
                reasons = ready_evidence_errors(
                    audit_bundle,
                    table_id,
                    start,
                    state,
                    final_snapshot.get("events", []),
                )
                if reasons:
                    unauthorized.append(
                        {
                            "table_id": table_id,
                            "t": start,
                            "end": end,
                            "generation": state.get("generation"),
                            "reasons": reasons,
                            "responsible_subsystem": "readiness_evidence_audit",
                        }
                    )
                if row["occupancy"] == "occupied":
                    occupied_green += weight
                    runs[table_id] += weight
                    longest = max(longest, runs[table_id])
                else:
                    runs[table_id] = 0.0
            else:
                runs[table_id] = 0.0
    transitions, extra, duplicates = _transition_metrics(labels, final_snapshot)
    ratio = lambda numerator: numerator / total if total else None
    gates = {
        "state_agreement_at_least_95_percent": total > 0
        and service_ok / total >= 0.95 - 1e-9,
        "prediction_coverage_at_least_95_percent": total > 0
        and covered / total >= 0.95 - 1e-9,
        "required_transitions_within_tolerance": all(
            row["result"] == "passed" for row in transitions
        ),
        "no_extra_transitions": not extra,
        "no_duplicate_transitions": not duplicates,
        "no_unauthorized_ready": not unauthorized,
        "no_false_ready": false_ready <= 1e-6,
        "no_stale_generation_ready": stale_ready <= 1e-6,
    }
    tracking = tracking_metrics(bundle, labels)
    surface_results = []
    for result in bundle.get("assessments", []):
        reference = next(
            (
                row
                for row in rows[result["table_id"]]
                if row["start"] <= result["t"] < row["end"]
            ),
            None,
        )
        if reference:
            surface_results.append(
                {
                    "id": result["id"],
                    "t": result["t"],
                    "table_id": result["table_id"],
                    "expected": reference["surface_condition"],
                    "actual": result["outcome"],
                    "valid": result["valid"],
                }
            )
    false_positive = sum(
        row["valid"]
        and row["actual"] == "cleared_reset"
        and row["expected"] != "cleared_reset"
        for row in surface_results
    )
    positive = sum(
        row["valid"] and row["actual"] == "cleared_reset" for row in surface_results
    )
    reset_results = sum(
        row["valid"] and row["actual"] == "not_reset" for row in surface_results
    )
    false_reset_results = sum(
        row["valid"]
        and row["actual"] == "not_reset"
        and row["expected"] == "cleared_reset"
        for row in surface_results
    )
    surface_metrics = {
        "status": "measured" if surface_results else "not_run",
        "assessments": len(surface_results),
        "false_cleared_results": false_positive,
        "cleared_precision": (
            (positive - false_positive) / positive if positive else None
        ),
        "cleared_recall": (
            sum(
                row["valid"]
                and row["actual"] == "cleared_reset"
                and row["expected"] == "cleared_reset"
                for row in surface_results
            )
            / sum(row["expected"] == "cleared_reset" for row in surface_results)
            if any(row["expected"] == "cleared_reset" for row in surface_results)
            else None
        ),
        "results": surface_results,
    }
    surface_metrics.update(
        false_reset_results=false_reset_results,
        reset_results=reset_results,
        false_reset_table_seconds=false_reset_seconds,
        reset_precision=(
            (reset_results - false_reset_results) / reset_results
            if reset_results
            else None
        ),
    )
    return {
        "policy": "automatic_v2",
        "passed": all(gates.values()),
        "gates": gates,
        "state_agreement": ratio(service_ok),
        "people_agreement": ratio(people_ok),
        "surface_agreement": ratio(surface_ok),
        "prediction_coverage": ratio(covered),
        "evaluated_table_seconds": total,
        "unknown_table_seconds": unknown,
        "total_unknown_table_seconds": all_unknown,
        "challenge_table_seconds": challenge,
        "confusion_table_seconds": {
            key: dict(value) for key, value in confusion.items()
        },
        "occupancy": {
            "precision": tp / (tp + fp) if tp + fp else None,
            "recall": tp / (tp + fn) if tp + fn else None,
            "evaluated_table_seconds": occupancy_time,
        },
        "ready_provenance_table_seconds": dict(ready_sources),
        "false_ready_table_seconds": false_ready,
        "stale_generation_table_seconds": stale_ready,
        "green_exposure": {
            "occupied_table_seconds": occupied_green,
            "longest_episode_s": longest,
            "beyond_arrival_allowance_table_seconds": beyond_green,
            "arrival_allowance_s": 0.1,
            "dirty_table_seconds": dirty_green,
            "unauthorized_transitions": unauthorized,
        },
        "transitions": transitions,
        "extra_transitions": extra,
        "duplicated_transitions": duplicates,
        "tracking": tracking,
        "surface_classification": surface_metrics,
        "failures": _with_observation_evidence(_merge_failures(failures), bundle),
        "challenge_failures": _with_observation_evidence(
            _merge_failures(challenge_failures), bundle
        ),
    }


def score_predictions(
    bundle,
    labels,
    segments,
    snapshots,
    final_snapshot,
    *,
    automatic_snapshots=None,
    automatic_final_snapshot=None,
):
    """Score actual automatic replay; audit displayed colour choices independently."""
    disabled = {
        table["id"]
        for table in bundle["tables"]
        if table.get("monitoring_enabled", True) is False
    }
    enabled = {table["id"] for table in bundle["tables"]} - disabled
    declared = validate_monitoring_scope(labels, bundle)
    staff = {
        event["id"]: event
        for event in [*bundle["staff_events"], *labels["staff_events"]]
    }
    has_manual = any(
        event["action"] in {"force_status", "clear_status_override"}
        for event in staff.values()
    ) or any(
        state.get("manual_override")
        for snapshot in snapshots
        for state in snapshot["tables"].values()
    )
    replay_available = (
        not has_manual
        or automatic_snapshots is not None
        and automatic_final_snapshot is not None
    )
    if automatic_snapshots is not None:
        quality_snapshots = automatic_snapshots
        quality_final = automatic_final_snapshot
    elif has_manual:
        quality_snapshots = [
            {
                **snapshot,
                "tables": {
                    key: {
                        **state,
                        "status": state.get("automatic_status", "unknown"),
                        "manual_override": None,
                    }
                    for key, state in snapshot["tables"].items()
                },
            }
            for snapshot in snapshots
        ]
        quality_final = {
            "events": []
        }  # Missing automatic event history is incomplete, never manufactured.
    else:
        quality_snapshots = snapshots
        quality_final = final_snapshot
    quality_bundle = {
        **bundle,
        "tables": [table for table in bundle["tables"] if table["id"] in enabled],
        "assessments": [
            item
            for item in bundle.get("assessments", [])
            if item["table_id"] in enabled
        ],
    }
    quality_labels = {
        **labels,
        "intervals": [row for row in labels["intervals"] if row["table_id"] in enabled],
        "transitions": [
            row for row in labels["transitions"] if row["table_id"] in enabled
        ],
    }
    quality_final = {
        **quality_final,
        "events": [
            event for event in quality_final["events"] if event["table_id"] in enabled
        ],
    }
    result = _score_predictions(
        quality_bundle, quality_labels, segments, quality_snapshots, quality_final
    )
    display_total = display_correct = manual_time = conflict_time = (
        manual_green_occupied
    ) = 0.0
    by_status = defaultdict(float)
    unauthorized = []
    intervals = defaultdict(list)
    for row in labels["intervals"]:
        intervals[row["table_id"]].append(row)
    for (start, end), display, automatic in zip(segments, snapshots, quality_snapshots):
        weight = end - start
        midpoint = (start + end) / 2
        for table_id in enabled:
            state = display["tables"][table_id]
            row = next(
                item
                for item in intervals[table_id]
                if item["start"] <= midpoint < item["end"]
            )
            if row["evaluable"]:
                display_total += weight
                display_correct += weight * (state["status"] == row["expected_status"])
            override = state.get("manual_override")
            if not override:
                continue
            manual_time += weight
            by_status[state["status"]] += weight
            conflict_time += weight * (
                state["status"] != automatic["tables"][table_id]["status"]
            )
            manual_green_occupied += weight * (
                state["status"] == "ready" and row["occupancy"] == "occupied"
            )
            event = staff.get(override.get("event_id"))
            accepted = (
                event is not None
                and event["action"] == "force_status"
                and event["source"] == "staff"
                and event["table_id"] == table_id
                and event.get("status") == override.get("status") == state["status"]
                and event["t"] == override.get("t")
                and event["t"] <= start + 1e-6
                and any(
                    log["kind"] == "staff_accepted"
                    and log.get("event_id") == event["id"]
                    and log["table_id"] == table_id
                    and log["t"] == event["t"]
                    for log in final_snapshot["events"]
                )
            )
            if accepted:
                intervening = [
                    item
                    for item in staff.values()
                    if item["table_id"] == table_id
                    and item["action"] in {"force_status", "clear_status_override"}
                    and (item["t"], item["seq"]) > (event["t"], event["seq"])
                    and item["t"] <= start + 1e-6
                ]
                accepted = not any(
                    any(
                        log["kind"] == "staff_accepted"
                        and log.get("event_id") == item["id"]
                        for log in final_snapshot["events"]
                    )
                    for item in intervening
                )
            if not accepted:
                unauthorized.append(
                    {
                        "table_id": table_id,
                        "start": start,
                        "end": end,
                        "manual_override": override,
                        "reason": "No current matching accepted staff colour command",
                    }
                )
    duration = sum(end - start for start, end in segments)
    excluded_seconds = duration * len(disabled)
    monitored_covered = (result["prediction_coverage"] or 0) * result[
        "evaluated_table_seconds"
    ]
    result["automatic_replay"] = {
        "status": "measured" if replay_available else "not_run",
        "method": (
            "Actual TypeScript replay with force_status/clear_status_override removed"
            if has_manual and replay_available
            else (
                "No service-colour override actions present"
                if not has_manual
                else "Required actual automatic replay was not supplied"
            )
        ),
    }
    result["manual_overrides"] = {
        "table_seconds": manual_time,
        "by_status_table_seconds": dict(by_status),
        "conflicts_with_automatic_table_seconds": conflict_time,
        "forced_green_while_occupied_table_seconds": manual_green_occupied,
        "displayed_state_agreement": (
            display_correct / display_total if display_total else None
        ),
        "unauthorized": unauthorized,
        "quality_policy": "Displayed manual colours never count as automatic classification success",
    }
    result["monitoring_scope"] = {
        "enabled_table_ids": sorted(enabled),
        "excluded_table_ids": sorted(disabled),
        "excluded_table_seconds": excluded_seconds,
        "configured_excluded_video_table_seconds": bundle["video"]["duration_s"]
        * len(disabled),
        "monitored_prediction_coverage": result["prediction_coverage"],
        "full_layout_prediction_coverage": (
            monitored_covered / (result["evaluated_table_seconds"] + excluded_seconds)
            if result["evaluated_table_seconds"] + excluded_seconds
            else None
        ),
        "independently_declared_exclusions": sorted(declared),
        "reason": labels.get("scope", {}).get("reason"),
        "complete": bool(enabled) and disabled == declared,
    }
    # Retained bundle requests are historical source evidence, not requests emitted
    # by this replay after a monitoring preference changes.
    result["monitoring_scope"]["excluded_recorded_assessment_requests"] = [
        item["id"]
        for item in bundle.get("assessment_requests", [])
        if item["table_id"] in disabled
    ]
    result["gates"]["manual_colour_commands_authorized"] = not unauthorized
    result["quality_passed"] = all(result["gates"].values())
    complete = replay_available and result["monitoring_scope"]["complete"]
    result["passed"] = result["quality_passed"] and complete
    result["status"] = (
        "incomplete" if not complete else "passed" if result["passed"] else "failed"
    )
    return result
