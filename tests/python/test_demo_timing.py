"""Demo timing is explicit, source-clock based, and unavailable for real footage."""

from copy import deepcopy

import pytest

from processor.coordinator import validate_assessment_identity
from processor.io import validate_bundle, validate_layout


def demo(bundle):
    result = deepcopy(bundle)
    result["provenance"] = "ai_generated_video"
    result["rules"] = {
        "entry_s": 5 / 3,
        "exit_s": 5 / 3,
        "assessment_separation_s": 2 / 3,
        "assessment_retry_s": 5 / 3,
        "gap_s": 1,
        "track_grace_s": 1,
        "demo_timing_scale": 3,
    }
    result["analysis"]["timing_profile"] = "demo_fast_3x"
    for table in result["tables"]:
        table["surface_method"] = "objects_reference_v1"
    return result


def test_approved_demo_profile_validates_with_unchanged_video_and_freshness(bundle):
    value = demo(bundle)
    validate_layout(value)
    validate_bundle(value)
    assert value["video"] == bundle["video"]
    assert value["rules"]["gap_s"] == value["rules"]["track_grace_s"] == 1


@pytest.mark.parametrize(
    "mode", ["real", "scale", "gap", "profile", "unmarked", "legacy"]
)
def test_demo_profile_cannot_weaken_normal_or_real_validation(bundle, mode):
    value = demo(bundle)
    if mode == "real":
        value["provenance"] = "real_video"
    elif mode == "scale":
        value["rules"]["demo_timing_scale"] = 2
    elif mode == "gap":
        value["rules"]["gap_s"] = 1 / 3
    elif mode == "profile":
        value["analysis"].pop("timing_profile")
    elif mode == "unmarked":
        value["rules"].pop("demo_timing_scale")
        value["analysis"].pop("timing_profile")
    else:
        value["tables"][0].pop("surface_method")
    with pytest.raises(ValueError):
        validate_bundle(value)


def test_coordinator_requires_matching_demo_profile_in_addition_to_source_identity():
    request = {
        "id": "request",
        "table_id": "T1",
        "t": 1.7,
        "frame_index": 17,
        "generation": 0,
        "video_sha256": "a" * 64,
        "geometry_sha256": "b" * 64,
        "reference_sha256": "c" * 64,
        "surface_method": "objects_reference_v1",
        "baseline_sha256": "d" * 64,
        "config_sha256": "e" * 64,
        "timing_profile": "demo_fast_3x",
    }
    result = {**request, "request_id": request["id"], "id": "result"}
    validate_assessment_identity(request, result)
    result.pop("timing_profile")
    with pytest.raises(ValueError, match="timing_profile"):
        validate_assessment_identity(request, result)
