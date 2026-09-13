"""Real media ingress for manual drawing without model or proposal execution."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import time

import cv2
from fastapi.testclient import TestClient
import numpy as np
import pytest

from processor.detector import YOLOXDetector
from processor.io import validate_layout
from processor.object_surface import ObjectSurfaceModel
from processor.pipeline import DEFAULT_RULES
from service.app import create_app
from service import media
from test_guided_setup_assets import picture, upload_asset
from test_service_inputs import video_bytes


def unavailable_models():
    return {
        "detector": {"available": False, "reason": "Fixture models unavailable"},
        "surface": {"available": False, "reason": "Fixture models unavailable"},
    }


def wait_for_setup(client, ident):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get("/api/jobs/" + ident)
        assert response.status_code == 200
        source = response.json()
        if source["status"] not in ("uploading", "preparing"):
            assert source["status"] == "needs_setup", source
            return source
        time.sleep(0.02)
    pytest.fail("Manual import did not finish")


def test_manual_video_normalizes_and_saves_unapproved_drawing_without_models(
    tmp_path, bundle, monkeypatch
):
    model_calls, process_names = [], []

    def models():
        model_calls.append(True)
        return unavailable_models()

    def forbidden(*args, **kwargs):
        raise AssertionError(
            "Manual drawing must not load models or invoke inference/proposals"
        )

    original_process = media.run_process

    async def media_process_only(arguments, on_line=None):
        executable = Path(arguments[0]).name
        assert executable in ("ffmpeg", "ffprobe"), arguments
        process_names.append(executable)
        return await original_process(arguments, on_line)

    monkeypatch.setattr(media, "run_process", media_process_only)
    monkeypatch.setattr(YOLOXDetector, "__init__", forbidden)
    monkeypatch.setattr(ObjectSurfaceModel, "__init__", forbidden)
    deps = {
        "models": models,
        "prepare_video": forbidden,
        "propose_tables": forbidden,
        "analyze_video": forbidden,
    }
    data_root = tmp_path / "sources"
    app = create_app(
        data_root,
        model_dir=tmp_path / "absent-models",
        dependencies=deps,
        limits={"disk_reserve_bytes": 0},
    )
    original = video_bytes(tmp_path)
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            data={"manual_setup": "true"},
            files={"file": ("manual.mp4", original, "video/mp4")},
        )
        assert response.status_code == 202, response.text
        source = wait_for_setup(client, response.json()["id"])
        assert source["setup_mode"] == "guided_v1" and source["tables"] == []
        assert source["revision"] == 0 and source["calibration_confirmed"] is False
        assert (
            source["width"],
            source["height"],
            source["fps"],
            source["duration_s"],
        ) == (64, 48, 30, 2)
        source_path = "/api/sources/" + source["id"]
        directory = data_root / source["id"]
        layout = json.loads((directory / "layout.json").read_text())
        assert layout["schema_version"] == 2 and layout["policy"] == "automatic_v2"
        assert (
            layout["provenance"] == "real_video" and layout["setup_mode"] == "guided_v1"
        )
        assert layout["calibration_confirmed"] is False and layout["tables"] == []
        assert layout["staff_events"] == [] and layout["rules"] == DEFAULT_RULES
        assert layout["preparation"]["proposal_source"] == "manual"
        assert (
            layout["preparation"]["reference_t"] == 0
            and layout["preparation"]["reference_frame_index"] == 0
        )
        assert (
            "detections" not in layout["preparation"]
            and "model_sha256" not in layout["preparation"]
        )
        canonical = client.get(source["media_url"])
        assert canonical.status_code == 200
        digest = hashlib.sha256(canonical.content).hexdigest()
        assert (
            layout["video"]["file"] == "media/source.mp4"
            and layout["video"]["sha256"] == digest
        )
        provenance = layout["source_provenance"]
        assert provenance["original_sha256"] == hashlib.sha256(original).hexdigest()
        assert (
            provenance["canonical_sha256"] == digest
            and provenance["original_metadata"]["duration_s"] == 2
        )
        scene = client.get(source["frame_url"])
        assert scene.status_code == 200
        assert cv2.imdecode(
            np.frombuffer(scene.content, np.uint8), cv2.IMREAD_COLOR
        ).shape == (48, 64, 3)
        extracted = client.post(source_path + "/frame", json={"t": 1})
        assert extracted.status_code == 200 and extracted.json()["t"] == pytest.approx(
            1
        )

        for kind in ("clean_reference", "floor_plan"):
            response = upload_asset(client, source, kind, picture())
            assert response.status_code == 200, response.text
            source = response.json()
        reference_choice = {
            "reference_source": "uploaded_image",
            "reference_t": None,
            "reference_image_sha256": source["setup_assets"]["clean_reference"][
                "sha256"
            ],
            "alignment_confirmed": False,
        }
        response = client.put(
            source_path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [],
                "confirmed": False,
                "floor_plan_mode": "uploaded",
                "setup_reference": reference_choice,
            },
        )
        assert response.status_code == 200, response.text
        source = response.json()
        assert source["tables"] == [] and source["setup_reference"] == reference_choice
        table = deepcopy(bundle["tables"][0])
        table.update(
            reference=None,
            reference_approved=False,
            setup_review={"tabletop": False, "occupancy": False, "map": False},
        )
        response = client.put(
            source_path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [table],
                "confirmed": False,
            },
        )
        assert response.status_code == 200, response.text
        source = response.json()
        assert source["calibration_confirmed"] is False
        assert source["tables"][0]["reference"] is None and not source["tables"][0].get(
            "object_baseline"
        )
        assert source["tables"][0]["setup_review"] == table["setup_review"]
        validate_layout(json.loads((directory / "layout.json").read_text()))
        assert not (directory / "bundle.json").exists()
        assert not (directory / "upload.mp4").exists()
        assert app.state.manager.active is None
    with TestClient(create_app(data_root, dependencies=deps)) as client:
        restored = client.get(source_path).json()
        assert (
            restored["tables"] == source["tables"]
            and restored["setup_reference"] == reference_choice
        )
        assert restored["calibration_confirmed"] is False
    assert (
        model_calls == [] and "ffmpeg" in process_names and "ffprobe" in process_names
    )


@pytest.mark.parametrize("form", [{}, {"manual_setup": "false"}])
def test_automatic_upload_still_rejects_unavailable_models(tmp_path, form):
    def forbidden(*args, **kwargs):
        raise AssertionError("Unavailable models must reject before preparation")

    app = create_app(
        tmp_path / "sources",
        dependencies={"models": unavailable_models, "prepare_video": forbidden},
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            data=form,
            files={"file": ("source.mp4", video_bytes(tmp_path), "video/mp4")},
        )
        assert (
            response.status_code == 503
            and "Fixture models unavailable" in response.text
        )
        assert client.get("/api/jobs").json() == [] and app.state.manager.active is None


@pytest.mark.parametrize(
    "case,expected_status", [("corrupt", 400), ("duration", 400), ("size", 413)]
)
def test_manual_upload_preserves_video_validation_and_limits(
    tmp_path, monkeypatch, case, expected_status
):
    def forbidden(*args, **kwargs):
        raise AssertionError("Invalid ingress must not prepare media or inspect models")

    monkeypatch.setattr(media, "prepare_video", forbidden)
    limits = {"disk_reserve_bytes": 0}
    content = b"not a video" if case == "corrupt" else video_bytes(tmp_path)
    if case == "duration":
        limits["duration_s"] = 1
    if case == "size":
        limits["upload_bytes"] = len(content) - 1
    app = create_app(
        tmp_path / "sources", dependencies={"models": forbidden}, limits=limits
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            data={"manual_setup": "true"},
            files={"file": ("source.mp4", content, "video/mp4")},
        )
        assert response.status_code == expected_status, response.text
        assert app.state.manager.active is None
        assert not list((tmp_path / "sources").glob("*/layout.json"))
