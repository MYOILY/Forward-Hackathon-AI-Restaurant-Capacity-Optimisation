"""Independent live adapter checks; fake detections never certify real model accuracy."""

from copy import deepcopy
import numpy as np
import pytest
from processor.live_vision import VisionSession, propose_tables


class Detector:
    last_timing = {"preprocess": 0.001, "inference": 0.002, "postprocess": 0.001}

    def __init__(self, detections=None):
        self.detections = detections or []
        self.calls = 0

    def detect(self, frame):
        self.calls += 1
        return deepcopy(self.detections)


class Tracker:
    def __init__(self):
        self.calls = []

    def update(self, detections, tables, t, frame_index, **kwargs):
        self.calls.append((deepcopy(tables), t, frame_index, kwargs))
        return {
            "tracks": [],
            "tables": {
                table["id"]: (
                    "uncertain"
                    if kwargs.get("valid") is False
                    or table.get("monitoring_enabled") is False
                    else "absent"
                )
                for table in tables
            },
        }


class Monitor:
    def update(self, frame, detections, valid=True):
        return {
            "scene_cut": False,
            "surface": {"T1": {"visible": True if valid else None, "changed": False}},
        }


def test_live_vision_preserves_capture_identity_and_emits_no_service_colours(bundle):
    detector = Detector()
    tracker = Tracker()
    session = VisionSession(
        bundle["tables"],
        64,
        48,
        "camera-session",
        detector=detector,
        tracker=tracker,
        surface_monitor=Monitor(),
    )
    result = session.process_frame(np.full((48, 64, 3), 150, np.uint8), 1.25, 37)
    observation = result["observation"]
    assert observation["t"] == 1.25 and observation["frame_index"] == 37
    assert observation["tables"] == {"T1": "absent"} and "status" not in observation
    assert tracker.calls[0][1:3] == (1.25, 37) and detector.calls == 1
    assert result["timing"]["inference"] >= 0
    session.close()


def test_rename_and_map_change_keep_existing_tracker_identity(bundle):
    tracker = Tracker()
    session = VisionSession(
        bundle["tables"],
        64,
        48,
        "session",
        detector=Detector(),
        tracker=tracker,
        surface_monitor=Monitor(),
    )
    tables = deepcopy(bundle["tables"])
    tables[0]["label"] = "Near window"
    tables[0]["map"]["x"] = 0.7
    session.set_tables(tables)
    session.process_frame(np.full((48, 64, 3), 150, np.uint8), 0, 0)
    assert tracker.calls[-1][0][0]["label"] == "Near window"
    tables[0]["monitoring_enabled"] = False
    session.set_tables(tables)
    assert (
        session.process_frame(np.full((48, 64, 3), 150, np.uint8), 0.1, 1)[
            "observation"
        ]["tables"]["T1"]
        == "uncertain"
    )
    session.close()


def test_detector_error_is_failed_observation_never_valid_empty(bundle):
    class Broken(Detector):
        def detect(self, frame):
            raise RuntimeError("independent inference failure")

    session = VisionSession(
        bundle["tables"],
        64,
        48,
        "session",
        detector=Broken(),
        tracker=Tracker(),
        surface_monitor=Monitor(),
    )
    result = session.process_frame(np.full((48, 64, 3), 150, np.uint8), 0, 0)[
        "observation"
    ]
    assert result["valid"] is False and result["tables"]["T1"] == "uncertain"
    session.close()


def test_proposals_use_only_actual_table_detections_and_never_approve_references():
    detector = Detector(
        [
            {"class_id": 60, "score": 0.9, "box": [0.1, 0.2, 0.6, 0.8]},
            {"class_id": 56, "score": 0.9, "box": [0.6, 0.2, 0.9, 0.8]},
        ]
    )
    tables = propose_tables(np.full((48, 64, 3), 150, np.uint8), detector=detector)
    assert (
        len(tables) == 1
        and tables[0]["label"] == "Table 1"
        and tables[0]["reference"] is None
    )
    assert (
        len(tables[0]["tabletop_polygon"]) == 4
        and len(tables[0]["geometry_sha256"]) == 64
    )


def test_live_vision_rejects_resolution_change_instead_of_reusing_wrong_calibration(
    bundle,
):
    session = VisionSession(
        bundle["tables"],
        64,
        48,
        "session",
        detector=Detector(),
        tracker=Tracker(),
        surface_monitor=Monitor(),
    )
    with pytest.raises(ValueError):
        session.process_frame(np.zeros((96, 128, 3), np.uint8), 0, 0)
    session.close()


def test_partial_model_directory_is_unavailable_not_a_ready_runtime(tmp_path):
    from processor.live_vision import model_availability

    surface = tmp_path / "partial"
    surface.mkdir()
    (surface / "config.json").write_text("{}")
    result = model_availability(model_dir=tmp_path, surface_model_dir=surface)
    assert (
        result["detector"]["available"] is False
        and result["surface"]["available"] is False
    )
    assert result["surface"]["reason"]
