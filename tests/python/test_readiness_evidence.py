"""Independent expected capture counts, policy boundaries, and alignment checks."""

from copy import deepcopy

import pytest

from evaluator.evidence import ready_evidence_errors
from processor.models import MODEL_HASHES
from processor.object_baseline import build_baseline, SURFACE_METHOD


def evidence_bundle(bundle, captures, *, modes=None):
    bundle = deepcopy(bundle)
    table = bundle["tables"][0]
    table["surface_method"] = SURFACE_METHOD
    table["object_baseline"] = baseline = build_baseline(
        [], table["reference"]["sha256"], table["geometry_sha256"], MODEL_HASHES["tiny"]
    )
    for index, capture in enumerate(captures):
        request = {
            "id": f"r{index}",
            "table_id": "T1",
            "t": capture,
            "frame_index": round(capture * 10),
            "generation": 0,
            "video_sha256": bundle["video"]["sha256"],
            "geometry_sha256": table["geometry_sha256"],
            "reference_sha256": table["reference"]["sha256"],
            "surface_method": SURFACE_METHOD,
            "baseline_sha256": baseline["baseline_sha256"],
            "config_sha256": baseline["config_sha256"],
        }
        bundle["assessment_requests"].append(request)
        reference = {
            "observable": True,
            "changed_fraction": 0.1,
            "brightness_offset": 0,
            "largest_change_fraction": 0,
        }
        if modes is not None:
            reference["alignment"] = {"applied": modes[index]}
        bundle["assessments"].append(
            {
                **request,
                "id": f"a{index}",
                "request_id": request["id"],
                "valid": True,
                "outcome": "cleared_reset",
                "object_evidence": {"reference": reference, "detections": []},
            }
        )
    return bundle


def audit(bundle, t, *, dirty=False):
    events = (
        [{"kind": "transition", "table_id": "T1", "status": "needs_cleaning", "t": 1}]
        if dirty
        else []
    )
    return ready_evidence_errors(
        bundle, "T1", t, {"people_state": "vacant", "generation": 0}, events
    )


@pytest.mark.parametrize(
    "captures,t,valid", [([5], 5, False), ([5, 6.9], 6.9, False), ([5, 7], 7, True)]
)
def test_initial_readiness_needs_two_captures_over_two_seconds(
    bundle, captures, t, valid
):
    assert (not audit(evidence_bundle(bundle, captures), t)) is valid


@pytest.mark.parametrize(
    "captures,valid", [([5, 7], False), ([5, 7, 9], False), ([5, 7, 10], True)]
)
def test_recovery_after_cleaning_alert_needs_three_captures_over_five_seconds(
    bundle, captures, valid
):
    assert (
        not audit(evidence_bundle(bundle, captures), captures[-1], dirty=True)
    ) is valid


def test_capture_at_expiry_cannot_renew_prior_readiness(bundle):
    bundle = evidence_bundle(bundle, [5, 7])
    assert not audit(bundle, 16.9)
    assert audit(bundle, 17)
    bundle = evidence_bundle(bundle, [5, 7, 17])
    assert audit(bundle, 17)


def test_alignment_change_restarts_confirmation_until_consistent_followup(bundle):
    bundle = evidence_bundle(bundle, [5, 7], modes=[False, True])
    assert audit(bundle, 7)
    bundle = evidence_bundle(bundle, [5, 7, 8, 10], modes=[False, True, True, True])
    assert not audit(bundle, 10)


def test_clean_threshold_inclusive_and_larger_difference_rejected(bundle):
    bundle = evidence_bundle(bundle, [5, 7])
    assert not audit(bundle, 7)
    bundle["assessments"][-1]["object_evidence"]["reference"][
        "changed_fraction"
    ] = 0.100001
    assert audit(bundle, 7)


def test_current_policy_and_config_drive_confirmation_and_ttl(bundle, monkeypatch):
    from evaluator import evidence

    policy = deepcopy(evidence.DECISION_POLICY)
    policy["stability"].update(clean_confirmation_captures=4, clean_confirmation_s=6)
    monkeypatch.setattr(evidence, "DECISION_POLICY", policy)
    monkeypatch.setattr(
        evidence, "OBJECT_CONFIG", {**evidence.OBJECT_CONFIG, "clearance_ttl_s": 4}
    )
    assert audit(evidence_bundle(bundle, [5, 7, 10]), 10, dirty=True)
    assert not audit(evidence_bundle(bundle, [5, 7, 9, 11]), 11, dirty=True)
    assert audit(evidence_bundle(bundle, [5, 7]), 11)


def test_obstructed_or_early_capture_cannot_count_as_clean_evidence(bundle):
    assert audit(evidence_bundle(bundle, [1, 5]), 5)
    bundle = evidence_bundle(bundle, [5, 7])
    bundle["observations"][70]["surface"]["T1"]["visible"] = False
    assert audit(bundle, 7)


EPISODE_REPLAY = r"""
import {createReplaySession} from './web/src/engine.ts';
import {objectBundle, objectAssessment, objectEvidence} from './tests/web/object-fixtures.ts';
const kind = process.argv[1];
const bundle = objectBundle(25, row => {
  if (kind === 'uncertainty' && row.t === 4) row.tables.T1 = 'uncertain';
  if (kind === 'recovered_then_obstructed' && row.t === 12) row.surface.T1.visible = false;
  if (kind === 'still_dirty_then_obstructed' && row.t === 4) row.surface.T1.visible = false;
  if (kind === 'partially_recovered_then_obstructed' && row.t === 10) row.surface.T1.visible = false;
  if (kind.startsWith('staff_') && row.t === 9) row.surface.T1.visible = false;
  if (kind === 'arrival' && row.t === 4) {
    row.tables.T1 = 'present';
    row.tracks = [{track_id:'independent-person', box:[.2,.2,.6,.8], score:.9,
      observed:true, table_id:'T1', candidate_table_ids:['T1']}];
  }
});
if (kind.startsWith('staff_')) bundle.staff_events = [{id:'clearance', t:8, seq:0,
  table_id:'T1', source:'staff', action:kind === 'staff_confirm' ? 'confirm_cleaned' : 'force_cleaned'}];
const session = createReplaySession(bundle), seen = new Set(), snapshots = [];
let snapshot;
for (const observation of bundle.observations) {
  snapshot = session.advanceTo(observation.t);
  for (const request of session.getAssessmentRequests().filter(item => item.t === observation.t && !seen.has(item.id))) {
    seen.add(request.id);
    const evidence = objectEvidence();
    evidence.reference.changed_fraction = request.t < 4 ? .2 : 0;
    if (kind === 'recovered_then_unobservable' && request.t === 13) evidence.reference.observable = false;
    session.submitAssessment(objectAssessment(request, evidence));
    snapshot = session.advanceTo(observation.t);
    bundle.assessment_requests.push(request);
    bundle.assessments.push(snapshot.tables.T1.last_assessment);
  }
  snapshots.push(snapshot);
  const minimum = kind === 'recovered_then_unobservable' ? 13 : kind === 'recovered_then_obstructed' ? 12 : kind.startsWith('staff_') ? 9 : 4;
  if (snapshot.tables.T1.status === 'ready' && observation.t > minimum) break;
}
console.log(JSON.stringify({bundle, snapshot, snapshots}));
"""


def replay_episode(kind):
    import json
    from pathlib import Path
    import subprocess

    result = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", EPISODE_REPLAY, kind],
        cwd=Path(__file__).resolve().parents[2],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


@pytest.mark.parametrize(
    "kind,expected_ready,expected_generation",
    [
        ("uncertainty", 11.1, 1),
        ("recovered_then_obstructed", 15.1, 1),
        ("recovered_then_unobservable", 16, 0),
        ("staff_confirm", 12.1, 1),
        ("staff_force", 12.1, 1),
    ],
)
def test_satisfied_or_reset_cleaning_obligation_does_not_leak_into_next_episode(
    kind, expected_ready, expected_generation
):
    result = replay_episode(kind)
    state = result["snapshot"]["tables"]["T1"]
    assert state["status"] == "ready"
    assert state["generation"] == expected_generation
    assert result["snapshot"]["t"] == pytest.approx(expected_ready)
    assert (
        ready_evidence_errors(
            result["bundle"], "T1", expected_ready, state, result["snapshot"]["events"]
        )
        == []
    )


@pytest.mark.parametrize(
    "kind",
    ["still_dirty_then_obstructed", "partially_recovered_then_obstructed", "arrival"],
)
def test_unsatisfied_cleaning_obligation_survives_obstruction_and_arrival(kind):
    result = replay_episode(kind)
    final = result["snapshot"]
    assert final["tables"]["T1"]["status"] == "ready"
    assert (
        ready_evidence_errors(
            result["bundle"], "T1", final["t"], final["tables"]["T1"], final["events"]
        )
        == []
    )
    current = [
        item
        for item in result["bundle"]["assessments"]
        if item["generation"] == 1 and item["t"] >= (9.1 if kind == "arrival" else 5.1)
    ]
    assert len(current) >= 3
    early = next(
        snapshot
        for snapshot in result["snapshots"]
        if abs(snapshot["t"] - current[1]["t"]) < 1e-6
    )
    assert early["tables"]["T1"]["status"] == "needs_cleaning"
    errors = ready_evidence_errors(
        result["bundle"], "T1", early["t"], early["tables"]["T1"], final["events"]
    )
    assert any("Cleaning recovery requires" in error for error in errors)
