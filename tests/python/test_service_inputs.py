"""HTTP contracts against actual ASGI routes; inference is explicitly injected."""

from pathlib import Path
from copy import deepcopy
import asyncio
import base64
import hashlib
import json
import time
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from service.app import create_app


def availability():
    return {
        "detector": {"available": True},
        "surface": {
            "available": False,
            "reason": "Independent fixture has no surface weights",
        },
    }


def image_b64():
    ok, data = cv2.imencode(".png", np.full((48, 64, 3), 150, np.uint8))
    assert ok
    return base64.b64encode(data).decode()


def wait_job(client, identity):
    for _ in range(100):
        response = client.get(f"/api/jobs/{identity}")
        assert response.status_code == 200
        source = response.json()
        if source["status"] not in {"uploading", "preparing", "analyzing"}:
            return source
        time.sleep(0.01)
    pytest.fail("Job never reached a terminal/setup state")


def test_U01_health_declares_actual_capabilities_and_configured_limits(tmp_path):
    app = create_app(
        tmp_path,
        dependencies={"models": availability},
        limits={"upload_bytes": 1234, "disk_reserve_bytes": 0},
    )
    with TestClient(app) as client:
        response = client.get("/api/health")
        assert response.status_code == 200
        assert response.json()["models"]["surface"]["available"] is False
        assert response.json()["limits"]["upload_bytes"] == 1234


def test_U02_oversized_upload_rejected_without_starting_preparation(tmp_path):
    calls = []

    async def prepare(*args):
        calls.append(args)
        raise AssertionError("Oversized upload must not prepare")

    app = create_app(
        tmp_path,
        dependencies={"models": availability, "prepare_video": prepare},
        limits={"upload_bytes": 8, "disk_reserve_bytes": 0},
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos", files={"file": ("big.mp4", b"x" * 9, "video/mp4")}
        )
        assert response.status_code == 413 and calls == []


def video_bytes(tmp_path):
    path = tmp_path / "fixture-source.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    assert writer.isOpened()
    for i in range(20):
        writer.write(np.full((48, 64, 3), 100 + i, np.uint8))
    writer.release()
    return path.read_bytes()


def dependencies(bundle):
    async def prepare(input_path, out_dir, report):
        layout = deepcopy(bundle)
        layout["tables"][0]["reference"] = None
        layout["video"].update(
            file=input_path.name,
            sha256=hashlib.sha256(input_path.read_bytes()).hexdigest(),
            width=64,
            height=48,
            fps=10,
            duration_s=2,
        )
        layout.update(calibration_confirmed=False, original_scene=None)
        report("preparing", 1, {})
        return layout

    async def propose(frame):
        tables = deepcopy(bundle["tables"])
        tables[0]["reference"] = None
        return tables

    async def analyze(layout_path, out_dir, detection_only, report):
        layout = json.loads(layout_path.read_text())
        layout.update(
            observations=[], staff_events=[], assessments=[], assessment_requests=[]
        )
        layout.setdefault("analysis", {}).update(
            surface_analysis_complete=not detection_only,
            surface_model_skipped=detection_only,
        )
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "bundle.json").write_text(json.dumps(layout))
        report("completed", 1, {})
        return layout

    return {
        "models": availability,
        "prepare_video": prepare,
        "propose_tables": propose,
        "analyze_video": analyze,
    }


def make_camera(client):
    response = client.post(
        "/api/cameras",
        json={
            "device_key": "fixture-camera",
            "label": "Fixture camera",
            "image_base64": image_b64(),
        },
    )
    assert response.status_code in {200, 202}
    return wait_job(client, response.json()["id"])


def save_calibration(client, source, tables=None):
    values = tables if tables is not None else source["tables"]
    if source.get("setup_mode") == "guided_v1":
        for table in values:
            table.setdefault(
                "setup_review", {"tabletop": True, "occupancy": True, "map": True}
            )
    response = client.put(
        f"/api/sources/{source['id']}/calibration",
        json={
            "revision": source["revision"],
            "tables": values,
            "confirmed": True,
            "floor_plan_mode": source.get("floor_plan_mode", "schematic"),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_U01_upload_setup_analyze_progress_and_completed_job_remain_accessible(
    tmp_path, bundle
):
    content = video_bytes(tmp_path)
    calls = []
    deps = dependencies(bundle)
    original = deps["analyze_video"]

    async def analyze(*args):
        calls.append(args[2])
        return await original(*args)

    deps["analyze_video"] = analyze
    app = create_app(
        tmp_path / "data", dependencies=deps, limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        uploaded = client.post(
            "/api/videos", files={"file": ("source.mp4", content, "video/mp4")}
        )
        assert uploaded.status_code == 202
        source = wait_job(client, uploaded.json()["id"])
        assert source["status"] == "needs_setup" and not source["calibration_confirmed"]
        assert (
            client.post(
                f"/api/sources/{source['id']}/analyze", json={"detection_only": True}
            ).status_code
            >= 400
        )
        source = save_calibration(client, source)
        assert (
            client.post(
                f"/api/sources/{source['id']}/analyze", json={"detection_only": False}
            ).status_code
            >= 400
            and calls == []
        )
        response = client.post(
            f"/api/sources/{source['id']}/analyze", json={"detection_only": True}
        )
        assert response.status_code in {200, 202}
        completed = wait_job(client, source["id"])
        assert (
            completed["status"] == "completed"
            and completed["detection_only"] is True
            and calls == [True]
        )
        assert client.get(completed["manifest_url"]).status_code == 200
        assert source["id"] in json.dumps(client.get("/api/jobs").json())


def test_U03_calibration_trimmed_labels_hashes_and_stale_revision(tmp_path, bundle):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        source = make_camera(client)
        tables = deepcopy(source["tables"])
        tables[0].update(
            label="  窗边 1  ",
            geometry_sha256="0" * 64,
            reference_t=0,
            reference_approved=True,
        )
        saved = save_calibration(client, source, tables)
        assert saved["tables"][0]["label"] == "窗边 1"
        table = saved["tables"][0]
        assert (
            table["geometry_sha256"] != "0" * 64
            and table["reference"]["confirmed_clean"] is True
        )
        response = client.put(
            f"/api/sources/{source['id']}/calibration",
            json={"revision": source["revision"], "tables": tables, "confirmed": True},
        )
        assert response.status_code == 409
        before = table["geometry_sha256"]
        reference = deepcopy(table["reference"])
        table["label"] = "Dining 1"
        table["map"]["x"] = 0.8
        again = save_calibration(client, saved, [table])
        assert again["tables"][0]["geometry_sha256"] == before
        assert again["tables"][0]["reference"]["sha256"] == reference["sha256"]


@pytest.mark.parametrize("label", ["", "   ", "x" * 41])
def test_T01_new_labels_reject_empty_or_more_than_40_characters(
    tmp_path, bundle, label
):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        source = make_camera(client)
        source["tables"][0]["label"] = label
        assert (
            client.put(
                f"/api/sources/{source['id']}/calibration",
                json={
                    "revision": source["revision"],
                    "tables": source["tables"],
                    "confirmed": True,
                },
            ).status_code
            >= 400
        )


def test_T02_duplicate_labels_and_removing_saved_ids_reject(tmp_path, bundle):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        source = make_camera(client)
        first = deepcopy(source["tables"][0])
        second = deepcopy(first)
        second.update(id="T2", label=first["label"].upper())
        response = client.put(
            f"/api/sources/{source['id']}/calibration",
            json={
                "revision": source["revision"],
                "tables": [first, second],
                "confirmed": True,
            },
        )
        assert response.status_code >= 400
        second["label"] = "Patio"
        saved = save_calibration(client, source, [first, second])
        assert (
            client.put(
                f"/api/sources/{source['id']}/calibration",
                json={
                    "revision": saved["revision"],
                    "tables": [first],
                    "confirmed": True,
                },
            ).status_code
            >= 400
        )
        saved["tables"][1]["monitoring_enabled"] = False
        assert (
            save_calibration(client, saved)["tables"][1]["monitoring_enabled"] is False
        )


def test_U03_unapproved_camera_reference_is_not_implicitly_clean(tmp_path, bundle):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        source = make_camera(client)
        source["tables"][0].update(reference_approved=False, reference_t=0)
        assert save_calibration(client, source)["tables"][0]["reference"] is None


def test_U04_cancel_preparation_finishes_task_and_retains_cancelled_job_status(
    tmp_path, bundle
):
    cancelled = []
    deps = dependencies(bundle)

    async def prepare(*args):
        try:
            await asyncio.sleep(30)
        finally:
            cancelled.append(True)

    deps["prepare_video"] = prepare
    app = create_app(
        tmp_path / "data", dependencies=deps, limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            files={"file": ("source.mp4", video_bytes(tmp_path), "video/mp4")},
        )
        assert response.status_code == 202
        identity = response.json()["id"]
        time.sleep(0.03)
        assert client.post(f"/api/jobs/{identity}/cancel").status_code == 200
        assert wait_job(client, identity)["status"] == "cancelled" and cancelled


def test_U02_asset_path_traversal_cannot_escape_source_directory(tmp_path, bundle):
    secret = tmp_path / "private.txt"
    secret.write_text("outside source")
    app = create_app(
        tmp_path / "data",
        dependencies=dependencies(bundle),
        limits={"disk_reserve_bytes": 0},
    )
    with TestClient(app) as client:
        source = make_camera(client)
        response = client.get(
            f"/api/sources/{source['id']}/assets/%2E%2E/%2E%2E/private.txt"
        )
        assert (
            response.status_code in {400, 403, 404, 422}
            and "outside source" not in response.text
        )


def test_U02_corrupt_mp4_extension_is_rejected_by_actual_video_decode(tmp_path, bundle):
    deps = dependencies(bundle)
    calls = []

    async def prepare(*args):
        calls.append(True)
        raise AssertionError("Corrupt media reached inference preparation")

    deps["prepare_video"] = prepare
    app = create_app(tmp_path, dependencies=deps, limits={"disk_reserve_bytes": 0})
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            files={"file": ("looks-valid.mp4", b"this is not a video", "video/mp4")},
        )
        if response.status_code == 202:
            assert wait_job(client, response.json()["id"])["status"] == "failed"
        else:
            assert response.status_code >= 400
        assert calls == []


def test_U01_source_video_range_and_requested_source_frame_are_real_bytes(
    tmp_path, bundle
):
    content = video_bytes(tmp_path)
    app = create_app(
        tmp_path / "data",
        dependencies=dependencies(bundle),
        limits={"disk_reserve_bytes": 0},
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos", files={"file": ("source.mp4", content, "video/mp4")}
        )
        source = wait_job(client, response.json()["id"])
        ranged = client.get(source["media_url"], headers={"Range": "bytes=1-4"})
        assert ranged.status_code == 206 and ranged.content == content[1:5]
        frame = client.post(f"/api/sources/{source['id']}/frame", json={"t": 1})
        assert frame.status_code == 200
        extracted = frame.json()
        assert (
            abs(extracted["t"] - 1) < 0.101
            and extracted["width"] == 64
            and extracted["height"] == 48
        )
        image = client.get(extracted["url"])
        assert hashlib.sha256(image.content).hexdigest() == extracted["sha256"]
        assert (
            client.get(f"/api/sources/{source['id']}").json()["calibration_confirmed"]
            is False
        )


def test_U04_cancelling_camera_proposals_releases_async_work(tmp_path, bundle):
    deps = dependencies(bundle)
    released = []

    async def propose(frame):
        try:
            await asyncio.sleep(30)
        finally:
            released.append(True)

    deps["propose_tables"] = propose
    app = create_app(tmp_path, dependencies=deps, limits={"disk_reserve_bytes": 0})
    with TestClient(app) as client:
        response = client.post(
            "/api/cameras",
            json={
                "device_key": "fixture-camera",
                "label": "Camera",
                "image_base64": image_b64(),
            },
        )
        assert response.status_code in {200, 202}
        identity = response.json()["id"]
        time.sleep(0.03)
        assert client.post(f"/api/jobs/{identity}/cancel").status_code == 200
        assert wait_job(client, identity)["status"] == "cancelled" and released
        assert identity not in app.state.manager.camera_frames


def test_U03_saved_camera_releases_transient_setup_frame_but_keeps_explicit_calibration_assets(
    tmp_path, bundle
):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        source = make_camera(client)
        assert source["id"] in app.state.manager.camera_frames
        source["tables"][0].update(reference_t=0, reference_approved=True)
        saved = save_calibration(client, source)
        assert source["id"] not in app.state.manager.camera_frames
        assert client.get(saved["frame_url"]).status_code == 200
        reference = saved["tables"][0]["reference"]
        assert reference and reference["confirmed_clean"]


def test_U04_new_unsaved_camera_supersedes_previous_transient_setup(tmp_path, bundle):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        first = make_camera(client)
        second = make_camera(client)
        previous = client.get("/api/sources/" + first["id"]).json()
        assert previous["status"] == "cancelled"
        assert set(app.state.manager.camera_frames) == {second["id"]}


def test_T04_source_polygon_change_gets_new_identity_while_schematic_map_does_not(
    tmp_path, bundle
):
    app = create_app(
        tmp_path, dependencies=dependencies(bundle), limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        source = make_camera(client)
        saved = save_calibration(client, source)
        original = deepcopy(saved["tables"][0])
        tables = deepcopy(saved["tables"])
        tables[0]["map"]["x"] = 0.75
        moved = save_calibration(client, saved, tables)
        assert moved["tables"][0]["geometry_sha256"] == original["geometry_sha256"]
        assert moved["tables"][0]["tabletop_polygon"] == original["tabletop_polygon"]
        assert moved["tables"][0]["occupancy_regions"] == original["occupancy_regions"]
        tables = deepcopy(moved["tables"])
        tables[0]["tabletop_polygon"][0][0] += 0.01
        recalibrated = save_calibration(client, moved, tables)
        assert (
            recalibrated["tables"][0]["geometry_sha256"] != original["geometry_sha256"]
        )
        assert recalibrated["tables"][0]["id"] == original["id"]
