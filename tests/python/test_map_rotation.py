"""Map display edits remain independent of reviewed camera/object identities."""

from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from processor.io import validate_layout
from service.app import create_app
from test_object_setup import approved_table, object_dependencies, proposal
from test_service_inputs import make_camera, save_calibration


@pytest.mark.parametrize("rotation", [None, 0, 45, 90, 359.999])
def test_legacy_and_rotated_maps_validate(bundle, rotation):
    if rotation is not None:
        bundle["tables"][0]["map"]["rotation"] = rotation
    validate_layout(bundle)


@pytest.mark.parametrize(
    "rotation", ["45", True, False, float("nan"), float("inf"), -1, 360, None]
)
def test_invalid_map_rotation_is_rejected(bundle, rotation):
    bundle["tables"][0]["map"]["rotation"] = rotation
    with pytest.raises(ValueError, match="map rotation"):
        validate_layout(bundle)


def test_camera_map_rotation_preserves_approved_geometry_and_inventory(
    tmp_path, bundle
):
    deps = object_dependencies(bundle)
    with TestClient(create_app(tmp_path, dependencies=deps)) as client:
        source = make_camera(client)
        original = approved_table(source, proposal(client, source).json())
        saved = save_calibration(client, source, [original])
        table = deepcopy(saved["tables"][0])
        table["map"].update(shape="round", rotation=73, w=0.3, h=0.12)
        updated = save_calibration(client, saved, [table])
        for key in (
            "geometry_sha256",
            "tabletop_polygon",
            "occupancy_regions",
            "reference",
            "object_baseline",
        ):
            assert updated["tables"][0][key] == saved["tables"][0][key]
        assert updated["tables"][0]["map"] == table["map"]
        assert (
            client.get(f"/api/sources/{source['id']}").json()["tables"][0]["map"]
            == table["map"]
        )
        for invalid in ("45", True, -1, 360):
            bad = deepcopy(updated["tables"])
            bad[0]["map"]["rotation"] = invalid
            response = client.put(
                f"/api/sources/{source['id']}/calibration",
                json={
                    "revision": updated["revision"],
                    "tables": bad,
                    "confirmed": False,
                    "floor_plan_mode": "schematic",
                },
            )
            assert response.status_code == 400, response.text
