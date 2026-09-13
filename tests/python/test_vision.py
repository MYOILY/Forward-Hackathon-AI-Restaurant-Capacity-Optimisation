"""Independent v2 geometry, identity and surface contracts; no model inference here."""

from copy import deepcopy
import hashlib
import importlib
import json

import numpy as np
import pytest


def api(name):
    return importlib.import_module(name)


def table(table_id="T1"):
    return {
        "id": table_id,
        "tabletop_polygon": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]],
        "occupancy_regions": [[[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]],
    }


def person(box=(0.3, 0.1, 0.6, 0.8)):
    return {"class_id": 0, "score": 0.9, "box": list(box)}


def test_B18_geometry_hash_pins_ordered_source_polygons_not_map_or_chairs():
    geometry = api("processor.geometry")
    item = table()
    expected = hashlib.sha256(
        json.dumps(
            {
                "occupancy_regions": item["occupancy_regions"],
                "tabletop_polygon": item["tabletop_polygon"],
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    assert (
        geometry.geometry_hash(item["tabletop_polygon"], item["occupancy_regions"])
        == expected
    )


@pytest.mark.parametrize(
    "polygon",
    [
        [[0, 0], [1, 1], [1, 0], [0, 1]],
        [[0.2, 0.2], [0.4, 0.4], [0.6, 0.6], [0.8, 0.8]],
        [[0, 0], [1, 0], [1, 2], [0, 1]],
        [[0, 0], [1, 0], [1, 1]],
    ],
)
def test_B18_invalid_tabletop_quadrilateral_rejected(polygon):
    with pytest.raises(ValueError):
        api("processor.geometry").validate_polygon(polygon, quadrilateral=True)


def test_B18_perspective_rectification_preserves_source_corner_orientation():
    geometry = api("processor.geometry")
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    frame[:50, :50] = [10, 20, 230]
    frame[:50, 50:] = [10, 220, 20]
    frame[50:, 50:] = [230, 20, 10]
    frame[50:, :50] = [190, 170, 20]
    result = geometry.rectify_tabletop(
        frame, [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], output_size=(80, 40)
    )
    assert result.shape == (40, 80, 3)
    np.testing.assert_array_equal(result[5, 5], [10, 20, 230])
    np.testing.assert_array_equal(result[5, -5], [10, 220, 20])
    np.testing.assert_array_equal(result[-5, -5], [230, 20, 10])
    np.testing.assert_array_equal(result[-5, 5], [190, 170, 20])


def test_B14_single_track_cannot_occupy_two_overlapping_tables():
    tracks, presence = api("processor.tracking").build_track_evidence(
        [person()], [7], [table(), table("T2")]
    )
    assert len(tracks) == 1 and isinstance(tracks[0]["track_id"], str)
    assert tracks[0]["table_id"] is None
    assert set(tracks[0]["candidate_table_ids"]) == {"T1", "T2"}
    assert presence == {"T1": "uncertain", "T2": "uncertain"}


def test_B14_definite_other_track_overrides_additional_ambiguity_per_table():
    second = table("T2")
    second["occupancy_regions"] = [[[0.5, 0.1], [0.95, 0.1], [0.95, 0.9], [0.5, 0.9]]]
    tracks, presence = api("processor.tracking").build_track_evidence(
        [person((0.15, 0.1, 0.35, 0.8)), person((0.5, 0.1, 0.7, 0.8))],
        [1, 2],
        [table(), second],
    )
    assert presence == {"T1": "present", "T2": "uncertain"}
    assert sum(item["table_id"] is not None for item in tracks) == 1


def test_B15_surface_obstruction_does_not_require_diner_assignment():
    module = api("processor.surface")
    item = table()
    item["occupancy_regions"] = [[[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]]]
    result = module.SurfaceMonitor([item]).update(
        np.full((100, 100, 3), 150, np.uint8),
        [person((0.05, 0.1, 0.45, 0.7))],
        valid=True,
    )
    assert result["surface"]["T1"]["visible"] is False


def test_B13_invalid_analysis_cannot_assert_visible_surface():
    result = (
        api("processor.surface")
        .SurfaceMonitor([table()])
        .update(np.zeros((100, 100, 3), np.uint8), [], valid=False)
    )
    assert result["surface"]["T1"]["visible"] is not True


@pytest.mark.parametrize(
    "field,value",
    [
        ("video_sha256", "f" * 64),
        ("geometry_sha256", "f" * 64),
        ("reference_sha256", "f" * 64),
        ("generation", 2),
        ("frame_index", 51),
        ("t", 5.1),
        ("table_id", "T2"),
        ("request_id", "wrong"),
    ],
)
def test_B12_B19_identity_mismatch_rejected(field, value):
    request = {
        "id": "r1",
        "table_id": "T1",
        "t": 5,
        "frame_index": 50,
        "generation": 1,
        "video_sha256": "a" * 64,
        "geometry_sha256": "b" * 64,
        "reference_sha256": "c" * 64,
    }
    result = {
        **deepcopy(request),
        "id": "a1",
        "request_id": "r1",
        "crop_sha256": "d" * 64,
        "crop_file": "surface/frame50.png",
        "outcome": "cleared_reset",
        "valid": True,
        "reason": "clear",
        "model": "fixture",
        "prompt_version": "test-v2",
    }
    result[field] = value
    with pytest.raises(ValueError):
        api("processor.coordinator").validate_assessment_identity(request, result)


def test_B18_table_count_is_not_artificially_capped_at_30(bundle):
    from processor.io import validate_layout

    bundle["tables"] = [
        {**deepcopy(bundle["tables"][0]), "id": f"T{index+1}"} for index in range(31)
    ]
    validate_layout(bundle)
