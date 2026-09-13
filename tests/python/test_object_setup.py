"""Object baseline setup contracts: source evidence and explicit operator review."""

from copy import deepcopy
import base64
import json
from pathlib import Path
import numpy as np
import pytest
from fastapi.testclient import TestClient
from processor.models import MODEL_HASHES
from service.app import create_app
from test_service_inputs import (
    dependencies,
    make_camera,
    save_calibration,
    video_bytes,
    wait_job,
)


def object_dependencies(bundle):
    deps = dependencies(bundle)
    deps["models"] = lambda: {
        "detector": {"available": True, "sha256": MODEL_HASHES["tiny"]},
        "surface": {"available": True},
    }

    async def propose(rgb):
        assert rgb.shape[2] == 3 and rgb.dtype == np.uint8
        return {
            "detector_sha256": MODEL_HASHES["tiny"],
            "detections": [
                {"class_id": 41, "score": 0.9, "box": [0.1, 0.1, 0.3, 0.4]},
                {"class_id": 41, "score": 0.3, "box": [0.5, 0.1, 0.7, 0.4]},
                {"class_id": 60, "score": 0.9, "box": [0.0, 0.0, 1.0, 1.0]},
            ],
        }

    deps["propose_baseline"] = propose
    return deps


def proposal(client, source, table=None):
    table = table or source["tables"][0]
    return client.post(
        f"/api/sources/{source['id']}/baseline-proposal",
        json={
            "revision": source["revision"],
            "table_id": table["id"],
            "tabletop_polygon": table["tabletop_polygon"],
            "occupancy_regions": table["occupancy_regions"],
            "reference_t": 0,
        },
    )


def approved_table(source, proposed):
    table = deepcopy(source["tables"][0])
    table.update(
        reference_t=proposed["reference_t"],
        reference_approved=True,
        object_baseline={**proposed["baseline"], "approved": True},
        setup_review={"tabletop": True, "occupancy": True, "map": True},
    )
    return table


def test_proposal_is_readonly_supports_unsaved_geometry_and_never_approves(
    tmp_path, bundle
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        before = deepcopy(app.state.manager.sources[source["id"]])
        files = {str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()}
        table = deepcopy(source["tables"][0])
        table["id"] = "NEW"
        table["tabletop_polygon"][0][0] += 0.01
        response = proposal(client, source, table)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["baseline"]["approved"] is False
        assert result["baseline"]["expected"] == [{"class_id": 41, "count": 1}]
        assert result["geometry_sha256"] != source["tables"][0]["geometry_sha256"]
        assert base64.b64decode(result["frame_base64"].split(",")[1]).startswith(
            b"\x89PNG"
        )
        assert app.state.manager.sources[source["id"]] == before
        assert {
            str(p): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
        } == files
        assert app.state.manager.active is None


def test_edited_inventory_rehashed_persists_and_label_map_preserve_identity(
    tmp_path, bundle
):
    deps = object_dependencies(bundle)
    app = create_app(tmp_path, dependencies=deps)
    with TestClient(app) as client:
        source = make_camera(client)
        proposed = proposal(client, source).json()
        table = approved_table(source, proposed)
        table["object_baseline"]["expected"][0]["count"] = 2
        table["object_baseline"]["baseline_sha256"] = "0" * 64
        saved = save_calibration(client, source, [table])
        baseline = saved["tables"][0]["object_baseline"]
        assert baseline["approved"] and baseline["expected"] == [
            {"class_id": 41, "count": 2}
        ]
        assert baseline["baseline_sha256"] not in (
            "0" * 64,
            proposed["baseline"]["baseline_sha256"],
        )
        assert saved["tables"][0]["baseline_sha256"] == baseline["baseline_sha256"]
        updated = deepcopy(saved["tables"])
        updated[0]["label"] = "Window"
        updated[0]["map"]["x"] = 0.8
        renamed = save_calibration(client, saved, updated)
        assert renamed["tables"][0]["object_baseline"] == baseline
        assert proposal(client, source).status_code == 409
    with TestClient(create_app(tmp_path, dependencies=deps)) as client:
        reopened = client.get(f"/api/sources/{source['id']}").json()
        assert reopened["tables"][0]["object_baseline"] == baseline
        assert client.get(reopened["tables"][0]["reference_url"]).status_code == 200


@pytest.mark.parametrize("change", ["geometry", "config", "reference", "detector"])
def test_stale_baseline_cannot_be_blessed_by_calibration_save(tmp_path, bundle, change):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        table = approved_table(source, proposal(client, source).json())
        if change == "geometry":
            table["tabletop_polygon"][0][0] += 0.01
        else:
            table["object_baseline"][
                {
                    "config": "config_sha256",
                    "reference": "reference_sha256",
                    "detector": "detector_sha256",
                }[change]
            ] = (
                "0" * 64
            )
        saved = save_calibration(client, source, [table])
        assert not saved["tables"][0].get("object_baseline", {}).get("approved")
        assert saved["tables"][0]["surface_method"] == "objects_reference_v1"


@pytest.mark.parametrize(
    "expected",
    [
        [{"class_id": 0, "count": 1}],
        [{"class_id": 56, "count": 1}],
        [{"class_id": 60, "count": 1}],
        [{"class_id": 41, "count": 1.5}],
        [{"class_id": 41, "count": -1}],
    ],
)
def test_unsupported_or_invalid_expected_objects_reject(tmp_path, bundle, expected):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        table = approved_table(source, proposal(client, source).json())
        table["object_baseline"]["expected"] = expected
        response = client.put(
            f"/api/sources/{source['id']}/calibration",
            json={
                "revision": source["revision"],
                "tables": [table],
                "confirmed": True,
                "floor_plan_mode": "schematic",
            },
        )
        assert response.status_code == 400
        assert app.state.manager.sources[source["id"]]["revision"] == source["revision"]
        assert app.state.manager.active is None


def test_empty_approved_baseline_is_valid_and_changed_counts_invalidate_completed_analysis(
    tmp_path, bundle
):
    app = create_app(
        tmp_path / "data",
        dependencies=object_dependencies(bundle),
        limits={"disk_reserve_bytes": 0},
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            files={"file": ("source.mp4", video_bytes(tmp_path), "video/mp4")},
        )
        source = wait_job(client, response.json()["id"])
        table = approved_table(source, proposal(client, source).json())
        table["object_baseline"]["expected"] = []
        saved = save_calibration(client, source, [table])
        assert saved["tables"][0]["object_baseline"]["approved"]
        client.post(
            f"/api/sources/{source['id']}/analyze", json={"detection_only": False}
        )
        completed = wait_job(client, source["id"])
        assert completed["status"] == "completed"
        tables = deepcopy(completed["tables"])
        tables[0]["label"] = "Renamed"
        tables[0]["map"]["x"] = 0.7
        renamed = save_calibration(client, completed, tables)
        assert renamed["status"] == "completed"
        tables = deepcopy(renamed["tables"])
        tables[0]["object_baseline"]["expected"] = [{"class_id": 41, "count": 1}]
        changed = save_calibration(client, renamed, tables)
        assert changed["status"] == "needs_setup" and "manifest_url" not in changed
        # Prior exported evidence remains on disk, but is no longer offered as current analysis.
        assert (tmp_path / "data" / source["id"] / "bundle.json").is_file()


def test_malformed_proposal_releases_compute_reservation(tmp_path, bundle):
    deps = object_dependencies(bundle)
    deps["propose_baseline"] = lambda rgb: {
        "detector_sha256": MODEL_HASHES["tiny"],
        "detections": [{"class_id": 41, "score": 0.8, "box": [1, 0, 0, 1]}],
    }
    app = create_app(tmp_path, dependencies=deps)
    with TestClient(app) as client:
        source = make_camera(client)
        response = proposal(client, source)
        assert response.status_code == 503 and app.state.manager.active is None
        assert not client.get(f"/api/sources/{source['id']}").json()[
            "calibration_confirmed"
        ]


def test_changed_source_bytes_reject_proposal_approval(tmp_path, bundle):
    app = create_app(
        tmp_path / "data",
        dependencies=object_dependencies(bundle),
        limits={"disk_reserve_bytes": 0},
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            files={"file": ("source.mp4", video_bytes(tmp_path), "video/mp4")},
        )
        source = wait_job(client, response.json()["id"])
        table = approved_table(source, proposal(client, source).json())
        path = tmp_path / "data" / source["id"] / "upload.mp4"
        path.write_bytes(path.read_bytes() + b"changed")
        response = client.put(
            f"/api/sources/{source['id']}/calibration",
            json={
                "revision": source["revision"],
                "tables": [table],
                "confirmed": True,
                "floor_plan_mode": "schematic",
            },
        )
        assert (
            response.status_code == 409
            and app.state.manager.sources[source["id"]]["revision"] == 0
        )
