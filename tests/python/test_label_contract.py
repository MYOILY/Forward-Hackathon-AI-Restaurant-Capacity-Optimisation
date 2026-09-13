"""Independent annotations retain provenance, coverage, timing, and weighting guarantees."""

from copy import deepcopy

import pytest

from evaluator.labels import evaluation_segments, validate_labels
from evaluator.scoring import score_predictions


def state(status="ready", people="vacant", surface="cleared_reset"):
    return {
        "tables": {
            "T1": {
                "status": status,
                "people_state": people,
                "surface_state": surface,
                "presence": "absent" if people == "vacant" else "uncertain",
                "generation": 0,
            }
        }
    }


def test_handwritten_reference_is_valid(bundle, labels):
    validate_labels(labels, bundle)


def test_manual_ai_labels_validate_only_against_ai_generated_source(bundle, labels):
    labels["provenance"] = "manual_ai_video"
    bundle["provenance"] = "ai_generated_video"
    validate_labels(labels, bundle)
    for mismatch in ("manual_real_video", "synthetic_fixture"):
        labels["provenance"] = mismatch
        with pytest.raises(ValueError, match="provenance"):
            validate_labels(labels, bundle)


def test_ai_label_cannot_be_promoted_to_real_video_evidence(bundle, labels):
    labels["provenance"] = "manual_ai_video"
    bundle["provenance"] = "real_video"
    with pytest.raises(ValueError, match="provenance"):
        validate_labels(labels, bundle)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda value: value.update(video_sha256="b" * 64),
        lambda value: value["intervals"][1].update(start=4.9),
        lambda value: value["intervals"][1].update(start=5.1),
        lambda value: value["intervals"][1].update(end=31),
        lambda value: value["intervals"][1].update(table_id="T99"),
        lambda value: value["transitions"][0].update(tolerance_s=0.2),
        lambda value: value.update(provenance="manual_real_video"),
    ],
)
def test_invalid_independent_reference_is_rejected(bundle, labels, mutation):
    mutation(labels)
    with pytest.raises(ValueError):
        validate_labels(labels, bundle)


def test_duplicate_staff_reference_is_rejected(bundle, labels):
    event = {
        "id": "staff-1",
        "table_id": "T1",
        "t": 8,
        "seq": 0,
        "source": "staff",
        "action": "needs_cleaning",
    }
    labels["staff_events"] = [event, deepcopy(event)]
    with pytest.raises(ValueError):
        validate_labels(labels, bundle)


def test_unknown_predictions_reduce_agreement_and_coverage(bundle, labels):
    result = score_predictions(
        bundle,
        labels,
        [(7, 18.5), (18.5, 30)],
        [state(), state("unknown", "uncertain", "unverified")],
        {"events": []},
    )
    assert result["state_agreement"] == result["prediction_coverage"] == 0.5
    assert result["unknown_table_seconds"] == 11.5
    assert result["confusion_table_seconds"]["ready"]["unknown"] == 11.5
    assert not result["passed"]


def test_weighting_uses_source_time_not_sample_count(bundle, labels):
    result = score_predictions(
        bundle,
        labels,
        [(7, 8), (8, 30)],
        [state("unknown", "uncertain", "unverified"), state()],
        {"events": []},
    )
    assert result["state_agreement"] == pytest.approx(22 / 23)


@pytest.mark.parametrize(
    "actual,result", [(6.9, "early"), (7, "passed"), (7.1, "passed"), (7.11, "late")]
)
def test_transition_tolerance_cannot_hide_early_states(bundle, labels, actual, result):
    scored = score_predictions(
        bundle,
        labels,
        [(7, 30)],
        [state()],
        {
            "events": [
                {"kind": "transition", "table_id": "T1", "status": "ready", "t": actual}
            ]
        },
    )
    assert scored["transitions"][0]["result"] == result


def test_grid_includes_fractional_annotation_and_grace_boundaries(bundle, labels):
    labels["transitions"][0].update(expected_t=7.07, physical_t=7.07)
    points = {
        point for segment in evaluation_segments(bundle, labels) for point in segment
    }
    assert 7.17 in points


def test_missing_weights_cannot_spawn_an_inference_trial(tmp_path, monkeypatch):
    from evaluator.benchmark import run_trial

    monkeypatch.setattr(
        "evaluator.benchmark.subprocess.Popen",
        lambda *args, **kwargs: pytest.fail("Missing weights cannot start inference"),
    )
    result = run_trial(
        tmp_path / "source.mp4",
        tmp_path / "layout.json",
        tmp_path / "out",
        "tiny",
        tmp_path / "models",
        30,
        1,
    )
    assert result["status"] == "not_run" and "missing" in result["reason"]
