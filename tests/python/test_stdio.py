"""Real Python-to-TypeScript planner IPC, with explicit fixture surface results."""

from pathlib import Path
import pytest
from processor.coordinator import TSPlannerProcess


def approve_reference(bundle):
    from processor.object_baseline import build_baseline, SURFACE_METHOD
    from processor.models import MODEL_HASHES

    table = bundle["tables"][0]
    table["surface_method"] = SURFACE_METHOD
    table["object_baseline"] = build_baseline(
        [], table["reference"]["sha256"], table["geometry_sha256"], MODEL_HASHES["tiny"]
    )


def result_for(request):
    return {
        **request,
        "id": "assessment-" + request["id"],
        "request_id": request["id"],
        "crop_sha256": "c" * 64,
        "crop_file": f"surface/{request['frame_index']}.png",
        "outcome": "cleared_reset",
        "valid": True,
        "reason": "Independent synthetic IPC fixture",
        "model": "fixture",
        "object_evidence": {
            "detections": [],
            "reference": {
                "observable": True,
                "brightness_offset": 0,
                "changed_fraction": 0,
                "largest_change_fraction": 0,
                "edge_mismatch": None,
            },
        },
    }


def test_B01_B17_real_stdio_roundtrip_reconstructs_without_future_confirmation(bundle):
    approve_reference(bundle)
    with TSPlannerProcess(
        ["node", "--import", "tsx", "web/src/headless.ts", "--stdio"],
        cwd=Path(__file__).resolve().parents[2],
    ) as planner:
        assert (
            planner.send({"op": "init", "bundle": bundle})["snapshot"]["tables"]["T1"][
                "status"
            ]
            == "unknown"
        )
        early = planner.send({"op": "advance", "t": 1})
        planner.send(
            {"op": "assessment", "assessment": result_for(early["requests"][-1])}
        )
        first = planner.send({"op": "advance", "t": 5})
        assert first["requests"][-1]["t"] == 5
        planner.send(
            {"op": "assessment", "assessment": result_for(first["requests"][-1])}
        )
        second = planner.send({"op": "advance", "t": 7})
        assert second["requests"][-1]["t"] == 7
        ready = planner.send(
            {"op": "assessment", "assessment": result_for(second["requests"][-1])}
        )
        assert ready["snapshot"]["tables"]["T1"]["status"] == "ready"
        back = planner.send({"op": "advance", "t": 6})
        assert back["snapshot"]["tables"]["T1"]["status"] == "unknown"
        reset = planner.send({"op": "reset"})
        assert reset["snapshot"]["t"] == 0
        assert reset["snapshot"]["tables"]["T1"]["status"] == "unknown"


def test_B19_stdio_identity_error_does_not_poison_next_response(bundle):
    approve_reference(bundle)
    with TSPlannerProcess(
        ["node", "--import", "tsx", "web/src/headless.ts", "--stdio"],
        cwd=Path(__file__).resolve().parents[2],
    ) as planner:
        planner.send({"op": "init", "bundle": bundle})
        request = planner.send({"op": "advance", "t": 1})["requests"][-1]
        result = result_for(request)
        result["video_sha256"] = "f" * 64
        try:
            response = planner.send({"op": "assessment", "assessment": result})
        except ValueError:
            response = planner.send({"op": "advance", "t": 5})
        assert response["snapshot"]["tables"]["T1"]["status"] != "ready"
        assert planner.send({"op": "advance", "t": 5})["snapshot"]["t"] == 5
