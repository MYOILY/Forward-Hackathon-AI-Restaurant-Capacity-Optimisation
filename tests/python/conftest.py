from copy import deepcopy

import pytest


@pytest.fixture
def table():
    return {
        "id": "T1",
        "label": "Table 1",
        "capacity": 4,
        "video_region": [0.1, 0.1, 0.7, 0.7],
        "crop": [0.1, 0.1, 0.7, 0.7],
        "seat_regions": [[[0.1, 0.1], [0.7, 0.1], [0.7, 0.7], [0.1, 0.7]]],
        "map": {"x": 0.4, "y": 0.4, "w": 0.2, "h": 0.2, "shape": "rect"},
        "chairs": [[0.2, 0.2]],
        "reference": None,
    }


@pytest.fixture
def legacy_bundle(table):
    return {
        "schema_version": 1,
        "provenance": "synthetic_fixture",
        "video": {
            "file": "video.mp4",
            "sha256": "a" * 64,
            "width": 640,
            "height": 360,
            "fps": 10,
            "duration_s": 30,
        },
        "original_scene": None,
        "tables": [deepcopy(table)],
        "observations": [
            {
                "t": index / 5,
                "frame_index": index * 2,
                "valid": True,
                "detections": [],
                "tables": {"T1": "absent"},
            }
            for index in range(151)
        ],
        "staff_events": [
            {
                "id": "setup-T1",
                "t": 6,
                "table_id": "T1",
                "action": "confirm_cleaned",
                "source": "setup",
                "seq": 0,
            }
        ],
        "rules": {"entry_s": 2, "exit_s": 5, "gap_s": 1},
        "analysis": {"fixture": True},
    }


@pytest.fixture
def bundle(legacy_bundle):
    bundle = legacy_bundle
    import hashlib
    import json

    result = deepcopy(bundle)
    result.update(
        schema_version=2,
        policy="automatic_v2",
        staff_events=[],
        assessment_requests=[],
        assessments=[],
    )
    result["rules"] = {
        "entry_s": 5,
        "exit_s": 5,
        "gap_s": 1,
        "assessment_separation_s": 2,
        "assessment_retry_s": 5,
        "track_grace_s": 1,
    }
    item = result["tables"][0]
    item["tabletop_polygon"] = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
    item["occupancy_regions"] = [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]]
    item["geometry_sha256"] = hashlib.sha256(
        json.dumps(
            {key: item[key] for key in ("occupancy_regions", "tabletop_polygon")},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    item["reference"] = {
        "file": "ref.png",
        "source_t": 0,
        "confirmed_clean": True,
        "sha256": "b" * 64,
    }
    for key in ("capacity", "chairs", "seat_regions"):
        item.pop(key, None)
    result["observations"] = [
        {
            "t": index / 10,
            "frame_index": index,
            "valid": True,
            "detections": [],
            "tables": {"T1": "absent"},
            "tracks": [],
            "surface": {"T1": {"visible": True, "changed": False}},
        }
        for index in range(301)
    ]
    result["analysis"]["sample_hz"] = 10
    return result


@pytest.fixture
def labels(bundle):
    v2_bundle = bundle
    return {
        "schema_version": 2,
        "policy": "automatic_v2",
        "video_sha256": v2_bundle["video"]["sha256"],
        "provenance": "synthetic_fixture",
        "intervals": [
            {
                "table_id": "T1",
                "start": 0,
                "end": 5,
                "occupancy": "vacant",
                "surface_condition": "cleared_reset",
                "expected_people_state": "uncertain",
                "expected_surface_state": "unverified",
                "expected_status": "unknown",
                "expected_generation": 0,
                "evaluable": True,
            },
            {
                "table_id": "T1",
                "start": 5,
                "end": 7,
                "occupancy": "vacant",
                "surface_condition": "cleared_reset",
                "expected_people_state": "vacant",
                "expected_surface_state": "unverified",
                "expected_status": "unknown",
                "expected_generation": 0,
                "evaluable": True,
            },
            {
                "table_id": "T1",
                "start": 7,
                "end": 30,
                "occupancy": "vacant",
                "surface_condition": "cleared_reset",
                "expected_people_state": "vacant",
                "expected_surface_state": "cleared_reset",
                "expected_status": "ready",
                "expected_generation": 0,
                "evaluable": True,
            },
        ],
        "transitions": [
            {
                "table_id": "T1",
                "physical_t": 0,
                "expected_t": 7,
                "status": "ready",
                "tolerance_s": 0.1,
            }
        ],
        "staff_events": [],
        "tracking_frames": [],
    }
