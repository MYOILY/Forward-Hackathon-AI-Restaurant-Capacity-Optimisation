"""Evaluator assertions are independent of the production reducer and model."""

from copy import deepcopy
import importlib

import pytest


def subject():
    return importlib.import_module("evaluator.scoring")


def snapshot(status="ready", people="vacant", surface="cleared_reset", generation=0):
    return {
        "tables": {
            "T1": {
                "status": status,
                "people_state": people,
                "surface_state": surface,
                "presence": "absent",
                "generation": generation,
                "readiness_source": "automatic",
            }
        }
    }


def test_v2_label_schema_keeps_parallel_annotations_and_tenth_second_allowance(
    bundle, labels
):
    __import__("evaluator.labels", fromlist=["validate_labels"]).validate_labels(
        labels, bundle
    )
    labels["transitions"][0]["tolerance_s"] = 0.2
    with pytest.raises(ValueError):
        __import__("evaluator.labels", fromlist=["validate_labels"]).validate_labels(
            labels, bundle
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("expected_people_state", "ready"),
        ("expected_surface_state", "occupied"),
        ("surface_condition", "clean_sanitized"),
        ("expected_generation", -1),
    ],
)
def test_invalid_parallel_label_does_not_become_reference_truth(
    bundle, labels, field, value
):
    labels["intervals"][0][field] = value
    with pytest.raises(ValueError):
        __import__("evaluator.labels", fromlist=["validate_labels"]).validate_labels(
            labels, bundle
        )


def test_score_records_people_surface_and_service_separately(bundle, labels):
    result = subject().score_predictions(
        bundle,
        labels,
        [(7, 8), (8, 30)],
        [
            snapshot(),
            snapshot(people="uncertain", surface="unverified", status="unknown"),
        ],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7}
            ]
        },
    )
    assert result["state_agreement"] == pytest.approx(1 / 23)
    assert result["people_agreement"] == pytest.approx(1 / 23)
    assert result["surface_agreement"] == pytest.approx(1 / 23)
    assert result["prediction_coverage"] == pytest.approx(1 / 23)
    assert not result["passed"]


def test_B01_false_green_before_second_assessment_is_explicit_failure(bundle, labels):
    result = subject().score_predictions(
        bundle,
        labels,
        [(5, 7)],
        [snapshot()],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": 5}
            ]
        },
    )
    assert result["false_ready_table_seconds"] == 2
    assert not result["gates"]["no_false_ready"]


def test_B12_stale_generation_cannot_hide_behind_correct_green_colour(bundle, labels):
    labels["intervals"][2]["expected_generation"] = 2
    result = subject().score_predictions(
        bundle,
        labels,
        [(7, 30)],
        [snapshot(generation=1)],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7}
            ]
        },
    )
    assert result["stale_generation_table_seconds"] == 23
    assert not result["gates"]["no_stale_generation_ready"]


def test_B20_missing_track_labels_are_not_falsely_reported_as_tracking_pass(
    bundle, labels
):
    result = subject().score_predictions(
        bundle,
        labels,
        [(7, 30)],
        [snapshot()],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7}
            ]
        },
    )
    assert result["tracking"]["status"] == "not_run"


def test_B14_identity_switch_reported_against_independent_boxes(bundle, labels):
    for frame, track_id in [(70, "clip:A"), (71, "clip:B")]:
        bundle["observations"][frame]["tracks"] = [
            {
                "track_id": track_id,
                "box": [0.2, 0.2, 0.4, 0.8],
                "score": 0.9,
                "observed": True,
                "table_id": "T1",
                "candidate_table_ids": ["T1"],
            }
        ]
        labels["tracking_frames"].append(
            {
                "t": frame / 10,
                "frame_index": frame,
                "people": [
                    {
                        "identity": "independent-person-1",
                        "box": [0.2, 0.2, 0.4, 0.8],
                        "table_id": "T1",
                    }
                ],
            }
        )
    result = subject().score_predictions(
        bundle, labels, [(7, 30)], [snapshot()], {"events": []}
    )
    assert result["tracking"]["id_switches"] == 1
    assert result["tracking"]["status"] == "measured"


def test_B20_completion_requires_main_and_distinct_real_heldout_evidence():
    complete = {
        "main": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "a" * 64,
        },
        "held_out": {"status": "not_run"},
    }
    result = __import__(
        "evaluator.completion", fromlist=["completion_status"]
    ).completion_status(complete, [{"status": "passed"}], [])
    assert result["status"] == "incomplete"
    complete["held_out"] = {
        "status": "passed",
        "provenance": "manual_real_video",
        "video_sha256": "a" * 64,
    }
    assert (
        __import__(
            "evaluator.completion", fromlist=["completion_status"]
        ).completion_status(complete, [{"status": "passed"}], [])["status"]
        == "incomplete"
    )


def test_B20_all_requested_trials_are_predeclared():
    rows = __import__(
        "evaluator.completion", fromlist=["planned_trials"]
    ).planned_trials(["nano", "tiny"], ["main", "held_out"])
    assert len(rows) == 8
    assert len({(row["clip_role"], row["model"], row["trial"]) for row in rows}) == 8
    assert all(row["status"] == "not_run" for row in rows)
    assert sum(row["clip_role"] == "main" for row in rows) == 6
    assert sum(row["clip_role"] == "held_out" for row in rows) == 2


from copy import deepcopy


def add_ready_evidence(bundle, generation=0):
    table = bundle["tables"][0]
    for frame in (50, 70):
        request = {
            "id": f"r{frame}",
            "table_id": "T1",
            "t": frame / 10,
            "frame_index": frame,
            "generation": generation,
            "video_sha256": bundle["video"]["sha256"],
            "geometry_sha256": table["geometry_sha256"],
            "reference_sha256": table["reference"]["sha256"],
        }
        bundle["assessment_requests"].append(request)
        bundle["assessments"].append(
            {
                **request,
                "id": f"a{frame}",
                "request_id": request["id"],
                "crop_sha256": "c" * 64,
                "crop_file": f"c{frame}.png",
                "outcome": "cleared_reset",
                "valid": True,
                "reason": "independent synthetic fixture",
                "model": "fixture",
                "prompt_version": "test",
            }
        )


def test_B19_human_labels_need_not_predict_internal_generation(bundle, labels):
    for row in labels["intervals"]:
        row.pop("expected_generation")
    __import__("evaluator.labels", fromlist=["validate_labels"]).validate_labels(
        labels, bundle
    )
    add_ready_evidence(bundle)
    result = subject().score_predictions(
        bundle,
        labels,
        [(7, 30)],
        [snapshot()],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7}
            ]
        },
    )
    assert result["gates"]["no_stale_generation_ready"]


def test_B06_parallel_metrics_do_not_add_unapproved_acceptance_gates(bundle, labels):
    row = labels["intervals"][2]
    row.update(
        expected_status="occupied",
        expected_people_state="occupied",
        expected_surface_state="cleared_reset",
        occupancy="occupied",
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
    result = subject().score_predictions(
        bundle,
        labels,
        [(7, 30)],
        [snapshot("occupied", "occupied", "unverified")],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "occupied", "t": 7}
            ]
        },
    )
    assert result["surface_agreement"] == 0
    assert "surface_agreement_at_least_95_percent" not in result["gates"]
    assert result["state_agreement"] == 1
    assert result["prediction_coverage"] == 1
    assert result["passed"]


def test_B11_duplicate_transitions_are_measured_not_empty_placeholder(bundle, labels):
    events = [
        {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7},
        {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7.1},
    ]
    result = subject().score_predictions(
        bundle, labels, [(7, 30)], [snapshot()], {"events": events}
    )
    assert len(result["duplicated_transitions"]) == 1


def test_B19_ready_requires_current_generation_matching_request_hash_evidence(
    bundle, labels
):
    add_ready_evidence(bundle)
    bundle["assessments"][1]["reference_sha256"] = "f" * 64
    result = subject().score_predictions(
        bundle,
        labels,
        [(7, 30)],
        [snapshot()],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": 7}
            ]
        },
    )
    assert result["green_exposure"]["unauthorized_transitions"]
    assert not result["gates"]["no_unauthorized_ready"]


def test_B02_green_exposure_reports_sampling_grace_separately(bundle, labels):
    row = labels["intervals"][2]
    row.update(
        start=7,
        occupancy="occupied",
        expected_status="unknown",
        expected_people_state="pending_arrival",
    )
    result = subject().score_predictions(
        bundle, labels, [(7, 7.1), (7.1, 7.2)], [snapshot(), snapshot()], {"events": []}
    )
    assert result["green_exposure"]["occupied_table_seconds"] == pytest.approx(0.2)
    assert result["green_exposure"][
        "beyond_arrival_allowance_table_seconds"
    ] == pytest.approx(0.1)


def test_B09_surface_precision_recall_and_dirty_green_are_distinct(bundle, labels):
    add_ready_evidence(bundle)
    bundle["assessments"][0]["outcome"] = "not_reset"
    labels["intervals"][2]["surface_condition"] = "needs_reset"
    result = subject().score_predictions(
        bundle, labels, [(7, 8)], [snapshot()], {"events": []}
    )
    assert result["surface_classification"]["cleared_precision"] == 0
    assert result["surface_classification"]["cleared_recall"] == 0
    assert result["green_exposure"]["dirty_table_seconds"] == 1


def test_B20_missing_approved_object_baseline_does_not_spawn(
    bundle, tmp_path, monkeypatch
):
    import json
    from evaluator.benchmark import run_trial

    (tmp_path / "yolox_tiny.onnx").write_bytes(b"placeholder, never loaded")
    layout = tmp_path / "layout.json"
    layout.write_text(json.dumps(bundle))
    monkeypatch.setattr(
        "evaluator.benchmark.subprocess.Popen",
        lambda *a, **k: pytest.fail("Missing approved baseline must not spawn a trial"),
    )
    result = run_trial(
        tmp_path / "video.mp4", layout, tmp_path / "out", "tiny", tmp_path, 30, 1
    )
    assert result["status"] == "not_run" and "baseline" in result["reason"]


def test_B20_incomplete_requested_trial_count_cannot_pass_completion():
    clips = {
        "main": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "a" * 64,
        },
        "held_out": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "b" * 64,
        },
    }
    trials = [
        {"clip_role": role, "model": "tiny", "trial": 1, "status": "passed"}
        for role in clips
    ]
    layers = [
        {"name": name, "status": "passed"}
        for name in (
            "python_unit",
            "real_model_integration",
            "object_surface_integration",
            "typescript_state",
            "browser",
        )
    ]
    assert (
        __import__(
            "evaluator.completion", fromlist=["completion_status"]
        ).completion_status(clips, layers, trials)["status"]
        == "incomplete"
    )


def test_B20_corrupt_cpu_model_never_spawns(bundle, tmp_path, monkeypatch):
    import json
    from evaluator.benchmark import run_trial

    (tmp_path / "yolox_tiny.onnx").write_bytes(b"incomplete ONNX model")
    layout = tmp_path / "layout.json"
    layout.write_text(json.dumps(bundle))
    monkeypatch.setattr(
        "processor.object_baseline.validate_baseline", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        "evaluator.benchmark.subprocess.Popen",
        lambda *a, **k: pytest.fail("Invalid model cannot start a trial"),
    )
    result = run_trial(
        tmp_path / "video.mp4", layout, tmp_path / "out", "tiny", tmp_path, 30, 1
    )
    assert result["status"] == "not_run" and "CPU tabletop model" in result["reason"]


@pytest.mark.parametrize("heldout_count", [1, 3])
def test_B20_three_main_trials_and_one_heldout_evaluation_satisfy_requested_counts(
    heldout_count,
):
    # Root-approved specification correction: held-out evaluation was never a three-trial benchmark requirement.
    clips = {
        "main": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "a" * 64,
        },
        "held_out": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "b" * 64,
        },
    }
    trials = [
        {"clip_role": role, "model": model, "trial": trial, "status": "passed"}
        for model in ("nano", "tiny", "s")
        for role, count in [("main", 3), ("held_out", heldout_count)]
        for trial in range(1, count + 1)
    ]
    layers = [
        {"name": name, "status": "passed"}
        for name in (
            "python_unit",
            "real_model_integration",
            "object_surface_integration",
            "typescript_state",
            "browser",
        )
    ]
    assert (
        __import__(
            "evaluator.completion", fromlist=["completion_status"]
        ).completion_status(clips, layers, trials)["status"]
        == "passed"
    )


def test_B20_duplicate_main_trial_numbers_cannot_replace_distinct_trials():
    clips = {
        "main": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "a" * 64,
        },
        "held_out": {
            "status": "passed",
            "provenance": "manual_real_video",
            "video_sha256": "b" * 64,
        },
    }
    trials = [
        {"clip_role": "main", "model": "tiny", "trial": 1, "status": "passed"}
        for _ in range(3)
    ] + [{"clip_role": "held_out", "model": "tiny", "trial": 1, "status": "passed"}]
    layers = [
        {"name": name, "status": "passed"}
        for name in (
            "python_unit",
            "real_model_integration",
            "typescript_state",
            "browser",
        )
    ]
    assert (
        __import__(
            "evaluator.completion", fromlist=["completion_status"]
        ).completion_status(clips, layers, trials)["status"]
        == "incomplete"
    )
