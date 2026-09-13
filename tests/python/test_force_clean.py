"""Independent schema and provenance checks for explicit v2-only staff override."""

from copy import deepcopy
import pytest
from processor.io import validate_layout
from evaluator.evidence import ready_evidence_errors
from evaluator.labels import validate_labels
from evaluator.scoring import score_predictions


def force(t=6, source="staff"):
    return {
        "id": f"override-{t}",
        "table_id": "T1",
        "t": t,
        "action": "force_cleaned",
        "source": source,
        "seq": 0,
    }


def override_state():
    return {
        "status": "ready",
        "people_state": "vacant",
        "surface_state": "cleared_reset",
        "presence": "absent",
        "generation": 1,
        "readiness_source": "staff_override",
        "surface_evidence_t": 6,
        "people_evidence_t": 7,
    }


def acceptance(event=None):
    event = event or force()
    return {
        "kind": "staff_accepted",
        "table_id": "T1",
        "t": event["t"],
        "event_id": event["id"],
        "status": "ready",
        "reason": "Explicit staff override of surface verification",
    }


def test_force_schema2_accepts_explicit_staff_action(bundle):
    bundle["staff_events"] = [force()]
    validate_layout(bundle)


@pytest.mark.parametrize("mode", ["v1", "setup"])
def test_force_cannot_reinterpret_v1_or_setup_actions(legacy_bundle, bundle, mode):
    selected = legacy_bundle if mode == "v1" else bundle
    selected["staff_events"] = [force(source="setup" if mode == "setup" else "staff")]
    with pytest.raises(ValueError):
        validate_layout(selected)


def test_force_label_validation_accepts_only_explicit_v2_staff_provenance(
    bundle, labels
):
    labels["staff_events"] = [force()]
    validate_labels(labels, bundle)
    labels["staff_events"][0]["source"] = "setup"
    with pytest.raises(ValueError):
        validate_labels(labels, bundle)


def test_evaluator_authorizes_recorded_staff_override_without_counting_automatic_model_success(
    bundle,
):
    bundle["staff_events"] = [force()]
    bundle["tables"][0]["reference"] = None
    assert (
        ready_evidence_errors(bundle, "T1", 7, override_state(), [acceptance()]) == []
    )
    # Even an accepted force action is not evidence for an automatic-readiness claim.
    state = override_state()
    state["readiness_source"] = "automatic"
    assert ready_evidence_errors(bundle, "T1", 7, state, [acceptance()])


@pytest.mark.parametrize(
    "mode", ["unaccepted", "wrong table", "wrong source", "occupied", "invalidated"]
)
def test_evaluator_rejects_unsupported_or_stale_force_provenance(bundle, mode):
    bundle["staff_events"] = [force()]
    state = override_state()
    events = [acceptance()]
    if mode == "unaccepted":
        events[0]["kind"] = "staff_rejected"
    if mode == "wrong table":
        events[0]["table_id"] = "T2"
    if mode == "wrong source":
        bundle["staff_events"][0]["source"] = "setup"
    if mode == "occupied":
        state["people_state"] = "occupied"
        state["presence"] = "present"
    if mode == "invalidated":
        events.append(
            {
                "kind": "transition",
                "table_id": "T1",
                "t": 6.5,
                "status": "unknown",
                "reason": "New arrival invalidated override",
            }
        )
    assert ready_evidence_errors(bundle, "T1", 7, state, events)


def test_label_only_force_event_is_audited_against_actual_accepted_replay_event(
    bundle, labels
):
    # Extra interactive actions are passed separately to production replay, not necessarily stored in its bundle.
    labels["staff_events"] = [force()]
    result = score_predictions(
        bundle,
        labels,
        [(7, 8)],
        [{"tables": {"T1": override_state()}}],
        {
            "events": [
                acceptance(),
                {
                    "kind": "transition",
                    "table_id": "T1",
                    "t": 6,
                    "status": "ready",
                    "reason": "Staff override",
                },
            ]
        },
    )
    assert result["gates"]["no_unauthorized_ready"]
    assert result["surface_classification"]["status"] == "not_run"
    assert result["ready_provenance_table_seconds"] == {"staff_override": 1}
