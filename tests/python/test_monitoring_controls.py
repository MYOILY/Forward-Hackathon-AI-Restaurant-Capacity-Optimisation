"""Independent disabled-table scope and staff colour-override schema tests."""

from copy import deepcopy
import numpy as np
import pytest
from processor.io import validate_layout
from processor.tracking import build_track_evidence
from processor.surface import SurfaceMonitor


def table(table_id="T1", enabled=True):
    return {
        "id": table_id,
        "monitoring_enabled": enabled,
        "tabletop_polygon": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]],
        "occupancy_regions": [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]],
    }


def test_disabled_table_does_not_create_overlap_ambiguity_for_enabled_table():
    person = {"class_id": 0, "score": 0.9, "box": [0.3, 0.1, 0.6, 0.8]}
    tracks, presence = build_track_evidence(
        [person], ["independent:A"], [table("T1"), table("T2", False)]
    )
    assert tracks[0]["table_id"] == "T1" and tracks[0]["candidate_table_ids"] == ["T1"]
    assert presence == {"T1": "present", "T2": "uncertain"}


def test_disabled_surface_is_unobserved_and_not_rectified(monkeypatch):
    import processor.surface as module

    monkeypatch.setattr(
        module,
        "rectify_tabletop",
        lambda *a, **k: pytest.fail("Disabled tabletop must not be analyzed"),
    )
    result = SurfaceMonitor([table(enabled=False)]).update(
        np.full((100, 100, 3), 150, np.uint8), []
    )
    assert result["surface"]["T1"]["visible"] is None
    assert result["surface"]["T1"]["changed"] is False


@pytest.mark.parametrize("enabled", [True, False])
def test_schema2_accepts_explicit_boolean_monitoring_switch(bundle, enabled):
    bundle["tables"][0]["monitoring_enabled"] = enabled
    validate_layout(bundle)


@pytest.mark.parametrize("value", ["false", 0, None])
def test_monitoring_switch_cannot_accept_ambiguous_non_boolean_values(bundle, value):
    bundle["tables"][0]["monitoring_enabled"] = value
    with pytest.raises(ValueError):
        validate_layout(bundle)


@pytest.mark.parametrize("status", ["unknown", "occupied", "needs_cleaning", "ready"])
def test_staff_can_override_any_service_colour_in_schema2(bundle, status):
    bundle["staff_events"] = [
        {
            "id": "manual",
            "t": 6,
            "table_id": "T1",
            "action": "force_status",
            "status": status,
            "source": "staff",
            "seq": 0,
        }
    ]
    validate_layout(bundle)


@pytest.mark.parametrize(
    "mode", ["missing status", "invalid status", "setup", "v1", "clear carries status"]
)
def test_colour_actions_reject_invalid_status_setup_and_legacy_schema(
    legacy_bundle, bundle, mode
):
    selected = legacy_bundle if mode == "v1" else bundle
    event = {
        "id": "manual",
        "t": 6,
        "table_id": "T1",
        "action": "force_status",
        "status": "ready",
        "source": "staff",
        "seq": 0,
    }
    if mode == "missing status":
        event.pop("status")
    if mode == "invalid status":
        event["status"] = "blue"
    if mode == "setup":
        event["source"] = "setup"
    if mode == "clear carries status":
        event["action"] = "clear_status_override"
    selected["staff_events"] = [event]
    with pytest.raises(ValueError):
        validate_layout(selected)


def test_schema2_accepts_explicit_return_to_automatic(bundle):
    bundle["staff_events"] = [
        {
            "id": "auto",
            "t": 6,
            "table_id": "T1",
            "action": "clear_status_override",
            "source": "staff",
            "seq": 0,
        }
    ]
    validate_layout(bundle)


def test_disabled_reference_is_copied_exactly_without_reading_video(
    bundle, tmp_path, monkeypatch
):
    import cv2, hashlib
    import processor.pipeline as module

    root = tmp_path / "source"
    root.mkdir()
    reference = root / "ref.png"
    cv2.imwrite(str(reference), np.full((12, 16, 3), 180, np.uint8))
    digest = hashlib.sha256(reference.read_bytes()).hexdigest()
    item = deepcopy(bundle["tables"][0])
    item["monitoring_enabled"] = False
    item["reference"].update(
        file="ref.png",
        sha256=digest,
        source_t=0,
        confirmed_clean=True,
        reviewed_by="independent fixture",
    )
    monkeypatch.setattr(
        module,
        "VideoReader",
        lambda *a, **k: pytest.fail("Disabled reference must not decode source video"),
    )
    updated, records = module.refresh_references(
        tmp_path / "unavailable.mp4", [item], tmp_path / "output", layout_root=root
    )
    copied = updated[0]["reference"]
    assert (tmp_path / "output" / copied["file"]).read_bytes() == reference.read_bytes()
    for field in ("sha256", "source_t", "confirmed_clean", "reviewed_by"):
        assert copied[field] == item["reference"][field]


def test_disabled_reference_keeps_hash_integrity_requirement(
    bundle, tmp_path, monkeypatch
):
    import cv2
    import processor.pipeline as module

    root = tmp_path / "source"
    root.mkdir()
    cv2.imwrite(str(root / "ref.png"), np.full((12, 16, 3), 180, np.uint8))
    item = deepcopy(bundle["tables"][0])
    item["monitoring_enabled"] = False
    item["reference"].update(file="ref.png", sha256="f" * 64)
    monkeypatch.setattr(
        module,
        "VideoReader",
        lambda *a, **k: pytest.fail("Disabled reference must not decode source video"),
    )
    with pytest.raises(ValueError):
        module.refresh_references(
            tmp_path / "unavailable.mp4", [item], tmp_path / "output", layout_root=root
        )
