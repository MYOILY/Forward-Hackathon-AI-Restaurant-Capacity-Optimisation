"""Manual display choices never become independent automatic-quality evidence."""

from copy import deepcopy
import pytest
from evaluator.labels import validate_labels
from evaluator.scoring import score_predictions


def command(status="ready"):
    return {
        "id": "display-command",
        "table_id": "T1",
        "t": 7,
        "action": "force_status",
        "status": status,
        "source": "staff",
        "seq": 0,
    }


def state(status="occupied", manual=False):
    return {
        "status": status,
        "automatic_status": "occupied",
        "manual_override": (
            {"status": status, "t": 7, "event_id": "display-command"}
            if manual
            else None
        ),
        "monitoring_enabled": True,
        "people_state": "occupied",
        "surface_state": "unverified",
        "presence": "present",
        "generation": 0,
        "readiness_source": None,
    }


def occupied_labels(labels):
    labels["intervals"][2].update(
        occupancy="occupied",
        expected_people_state="occupied",
        expected_surface_state="unverified",
        expected_status="occupied",
    )
    labels["transitions"] = [
        {
            "table_id": "T1",
            "physical_t": 2,
            "expected_t": 7,
            "status": "occupied",
            "tolerance_s": 0.1,
        }
    ]
    labels["staff_events"] = [command()]


def displayed_events():
    return {
        "events": [
            {
                "kind": "staff_accepted",
                "table_id": "T1",
                "t": 7,
                "event_id": "display-command",
                "status": "ready",
                "reason": "Manual display override",
            },
            {
                "kind": "transition",
                "table_id": "T1",
                "t": 7,
                "status": "ready",
                "reason": "Manual display override",
            },
        ]
    }


def test_manual_green_while_occupied_is_authorized_display_but_not_automatic_accuracy(
    bundle, labels
):
    occupied_labels(labels)
    automatic = [{"tables": {"T1": state()}}]
    result = score_predictions(
        bundle,
        labels,
        [(7, 8)],
        [{"tables": {"T1": state("ready", True)}}],
        displayed_events(),
        automatic_snapshots=automatic,
        automatic_final_snapshot={
            "events": [
                {"kind": "transition", "table_id": "T1", "t": 7, "status": "occupied"}
            ]
        },
    )
    assert result["state_agreement"] == 1 and result["false_ready_table_seconds"] == 0
    assert result["manual_overrides"]["table_seconds"] == 1
    assert result["manual_overrides"]["forced_green_while_occupied_table_seconds"] == 1
    assert result["manual_overrides"]["unauthorized"] == []
    assert result["manual_overrides"]["displayed_state_agreement"] == 0


def test_missing_actual_automatic_replay_cannot_claim_model_quality_from_forced_colour(
    bundle, labels
):
    labels["staff_events"] = [command()]
    result = score_predictions(
        bundle,
        labels,
        [(7, 8)],
        [{"tables": {"T1": state("ready", True)}}],
        displayed_events(),
    )
    assert result["status"] == "incomplete" and not result["passed"]
    assert result["automatic_replay"]["status"] == "not_run"


def test_manual_status_labels_validate_required_status_and_staff_only(bundle, labels):
    labels["staff_events"] = [
        command(),
        {
            "id": "auto",
            "table_id": "T1",
            "t": 8,
            "action": "clear_status_override",
            "source": "staff",
            "seq": 1,
        },
    ]
    validate_labels(labels, bundle)
    labels["staff_events"][0]["status"] = "blue"
    with pytest.raises(ValueError):
        validate_labels(labels, bundle)


def two_tables(bundle, labels):
    second = deepcopy(bundle["tables"][0])
    second["id"] = "T2"
    second["monitoring_enabled"] = False
    bundle["tables"].append(second)
    labels["intervals"] += [
        {**deepcopy(row), "table_id": "T2"} for row in list(labels["intervals"])
    ]
    for obs in bundle["observations"]:
        obs["tables"]["T2"] = "uncertain"
        obs["surface"]["T2"] = {"visible": None, "changed": False}
    for t in (5, 7):
        request = {
            "id": f"r{t}",
            "table_id": "T1",
            "t": t,
            "frame_index": t * 10,
            "generation": 0,
            "video_sha256": bundle["video"]["sha256"],
            "geometry_sha256": bundle["tables"][0]["geometry_sha256"],
            "reference_sha256": bundle["tables"][0]["reference"]["sha256"],
        }
        bundle["assessment_requests"].append(request)
        bundle["assessments"].append(
            {
                **request,
                "id": f"a{t}",
                "request_id": request["id"],
                "crop_sha256": "c" * 64,
                "crop_file": "fixture.png",
                "outcome": "cleared_reset",
                "valid": True,
                "reason": "independent synthetic fixture",
                "model": "fixture",
                "prompt_version": "fixture",
            }
        )
    ready = {
        "status": "ready",
        "automatic_status": "ready",
        "monitoring_enabled": True,
        "people_state": "vacant",
        "surface_state": "cleared_reset",
        "presence": "absent",
        "generation": 0,
        "readiness_source": "automatic",
    }
    disabled = {
        "status": "unknown",
        "automatic_status": "unknown",
        "monitoring_enabled": False,
        "people_state": "uncertain",
        "surface_state": "unverified",
        "presence": "uncertain",
        "generation": 0,
    }
    return [{"tables": {"T1": ready, "T2": disabled}}], {
        "events": [{"kind": "transition", "table_id": "T1", "status": "ready", "t": 7}]
    }


def test_disabled_scope_is_explicit_and_cannot_silently_boost_full_layout_coverage(
    bundle, labels
):
    snapshots, final = two_tables(bundle, labels)
    result = score_predictions(bundle, labels, [(7, 30)], snapshots, final)
    assert result["monitoring_scope"]["excluded_table_ids"] == ["T2"]
    assert result["monitoring_scope"]["excluded_table_seconds"] == 23
    assert result["monitoring_scope"]["full_layout_prediction_coverage"] == 0.5
    assert result["monitoring_scope"]["monitored_prediction_coverage"] == 1
    assert result["status"] == "incomplete" and not result["passed"]


def test_independent_explicit_exclusion_allows_scoped_validation_without_hiding_excluded_table(
    bundle, labels
):
    snapshots, final = two_tables(bundle, labels)
    labels["scope"] = {
        "excluded_table_ids": ["T2"],
        "reason": "Independent evaluation scoped to nearer T1; T2 excluded before scoring",
    }
    validate_labels(labels, bundle)
    result = score_predictions(bundle, labels, [(7, 30)], snapshots, final)
    assert result["monitoring_scope"]["complete"] and result["passed"]
    assert result["monitoring_scope"]["excluded_table_seconds"] == 23
    assert result["monitoring_scope"]["full_layout_prediction_coverage"] == 0.5


def test_scope_cannot_hide_an_enabled_table(bundle, labels):
    labels["scope"] = {
        "excluded_table_ids": ["T1"],
        "reason": "Attempt to remove a monitored failure",
    }
    with pytest.raises(ValueError):
        validate_labels(labels, bundle)


def test_actual_ts_replay_is_run_again_without_display_commands_for_quality(
    bundle, tmp_path, monkeypatch
):
    import evaluator.__main__ as cli
    from evaluator.replay import run_replay

    for obs in bundle["observations"]:
        if obs["t"] >= 1:
            obs["tables"]["T1"] = "present"
            obs["tracks"] = [
                {
                    "track_id": "independent:one",
                    "box": [0.3, 0.1, 0.6, 0.8],
                    "score": 0.9,
                    "observed": True,
                    "table_id": "T1",
                    "candidate_table_ids": ["T1"],
                }
            ]
    labels = {
        "policy": "automatic",
        "provenance": "synthetic_fixture",
        "video_sha256": bundle["video"]["sha256"],
        "intervals": [
            {
                "table_id": "T1",
                "start": start,
                "end": end,
                "occupancy": presence,
                "surface_condition": "unobservable",
                "expected_people_state": people,
                "expected_surface_state": "unverified",
                "expected_status": status,
                "evaluable": True,
            }
            for start, end, presence, people, status in [
                (0, 1, "vacant", "uncertain", "unknown"),
                (1, 6, "occupied", "pending_arrival", "unknown"),
                (6, 30, "occupied", "occupied", "occupied"),
            ]
        ],
        "transitions": [
            {
                "table_id": "T1",
                "physical_t": 1,
                "expected_t": 6,
                "status": "occupied",
                "tolerance_s": 0.1,
            }
        ],
        "staff_events": [{**command(), "t": 8}],
        "tracking_frames": [],
    }
    calls = []

    def inspect_replay(bundle, times, events):
        calls.append([event["action"] for event in [*bundle["staff_events"], *events]])
        return run_replay(bundle, times, events)

    monkeypatch.setattr(cli, "run_replay", inspect_replay)
    monkeypatch.setattr(cli, "capture_failure_evidence", lambda *a, **k: None)
    result = cli.evaluate(bundle, labels, tmp_path / "unused-video.mp4", tmp_path)
    assert len(calls) == 2 and calls[0] == ["force_status"] and calls[1] == []
    assert result["state_agreement"] == 1 and result["passed"]
    assert result["manual_overrides"][
        "forced_green_while_occupied_table_seconds"
    ] == pytest.approx(22)


def test_explicit_scope_may_omit_excluded_labels_without_claiming_full_layout_coverage(
    bundle, labels
):
    snapshots, final = two_tables(bundle, labels)
    labels["scope"] = {
        "excluded_table_ids": ["T2"],
        "reason": "Independent near-table-only scope",
    }
    labels["intervals"] = [
        row for row in labels["intervals"] if row["table_id"] == "T1"
    ]
    validate_labels(labels, bundle)
    result = score_predictions(bundle, labels, [(7, 30)], snapshots, final)
    assert result["monitoring_scope"]["full_layout_prediction_coverage"] == 0.5


def test_scoped_disabled_history_is_reported_without_confusing_it_with_current_planner_requests(
    bundle, labels
):
    snapshots, final = two_tables(bundle, labels)
    labels["scope"] = {
        "excluded_table_ids": ["T2"],
        "reason": "Near table only, declared before scoring",
    }
    historical = {
        **bundle["assessment_requests"][0],
        "id": "historical-disabled-request",
        "table_id": "T2",
    }
    bundle["assessment_requests"].append(historical)
    result = score_predictions(bundle, labels, [(7, 30)], snapshots, final)
    assert result["passed"]
    assert result["monitoring_scope"]["excluded_recorded_assessment_requests"] == [
        "historical-disabled-request"
    ]


def test_markdown_report_exposes_manual_and_disabled_scope_separately(
    bundle, labels, tmp_path
):
    from evaluator.reporting import write_report

    snapshots, final = two_tables(bundle, labels)
    metrics = score_predictions(bundle, labels, [(7, 30)], snapshots, final)
    write_report(
        {
            "status": "incomplete",
            "provenance": "synthetic_fixture",
            "evaluations": [
                {"model": "fixture", "status": "incomplete", "metrics": metrics}
            ],
        },
        tmp_path,
    )
    markdown = (tmp_path / "report.md").read_text()
    assert "Manual display overrides" in markdown
    assert "Full-layout coverage: 50.0%" in markdown
    assert "Excluded table IDs: T2" in markdown
    assert "23.000 table-seconds" in markdown
    assert "full-layout validation remains incomplete" in markdown
