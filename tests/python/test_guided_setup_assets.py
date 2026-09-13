"""Independent setup asset ingress, approval, draft and persistence regressions."""

from copy import deepcopy
from io import BytesIO
import json

import cv2
from fastapi.testclient import TestClient
import numpy as np
from PIL import Image
import pytest

from service.app import create_app
from service.jobs import canonical_setup_image, ServiceError
from test_object_setup import object_dependencies
from test_service_inputs import make_camera, save_calibration, video_bytes, wait_job


def picture(size=(128, 96), color=(140, 180, 110), format="PNG"):
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format=format)
    return output.getvalue()


def upload_asset(client, source, kind, content=None):
    return client.put(
        f"/api/sources/{source['id']}/setup-assets/{kind}",
        data={"revision": str(source["revision"])},
        files={
            "file": (
                "photo.png",
                picture() if content is None else content,
                "image/png",
            )
        },
    )


def external_proposal(client, source, **overrides):
    table = source["tables"][0]
    return client.post(
        f"/api/sources/{source['id']}/baseline-proposal",
        json={
            "revision": source["revision"],
            "table_id": table["id"],
            "tabletop_polygon": table["tabletop_polygon"],
            "occupancy_regions": table["occupancy_regions"],
            "reference_source": "uploaded_image",
            "reference_image_sha256": source["setup_assets"]["clean_reference"][
                "sha256"
            ],
            "alignment_confirmed": True,
            "reference_t": None,
            **overrides,
        },
    )


def approve_external(client, source):
    response = external_proposal(client, source)
    assert response.status_code == 200, response.text
    proposed = response.json()
    assert proposed["baseline"]["approved"] is False
    table = deepcopy(source["tables"][0])
    table.update(
        reference_source="uploaded_image",
        reference_image_sha256=source["setup_assets"]["clean_reference"]["sha256"],
        alignment_confirmed=True,
        reference_t=None,
        reference_approved=True,
        object_baseline={**proposed["baseline"], "approved": True},
    )
    return save_calibration(client, source, [table])


def test_assets_resize_preserve_aspect_stale_revision_and_persist_without_approval(
    tmp_path, bundle
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        response = upload_asset(
            client, source, "clean_reference", picture(format="JPEG")
        )
        assert response.status_code == 200, response.text
        saved = response.json()
        asset = saved["setup_assets"]["clean_reference"]
        assert (asset["width"], asset["height"]) == (64, 48)
        assert not saved["calibration_confirmed"] and not saved["tables"][0].get(
            "object_baseline"
        )
        assert client.get(
            f"/api/sources/{source['id']}/assets/{asset['file']}"
        ).content.startswith(b"\x89PNG")
        assert upload_asset(client, source, "floor_plan").status_code == 409
        response = upload_asset(client, saved, "floor_plan", picture((4000, 1000)))
        assert response.status_code == 200, response.text
        saved = response.json()
        floor = saved["setup_assets"]["floor_plan"]
        assert (floor["width"], floor["height"]) == (1920, 480)
        assert saved["revision"] == source["revision"] + 2
        assert saved.get("floor_plan_mode") is None
    with TestClient(
        create_app(tmp_path, dependencies=object_dependencies(bundle))
    ) as client:
        assert (
            client.get("/api/sources/" + saved["id"]).json()["setup_assets"]
            == saved["setup_assets"]
        )


@pytest.mark.parametrize(
    "content,status",
    [
        (b"", 400),
        (b"not an image", 400),
        (picture((100, 100)), 400),
        (picture(format="GIF"), 400),
    ],
)
def test_invalid_clean_assets_leave_revision_and_calibration_unchanged(
    tmp_path, bundle, content, status
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        response = upload_asset(client, source, "clean_reference", content)
        assert response.status_code == status, response.text
        assert (
            client.get("/api/sources/" + source["id"]).json()["revision"]
            == source["revision"]
        )
        assert app.state.manager.active is None


def test_asset_size_and_pixel_bounds_apply_before_save_and_decode(
    tmp_path, bundle, monkeypatch
):
    app = create_app(
        tmp_path,
        dependencies=object_dependencies(bundle),
        limits={"setup_asset_bytes": 32},
    )
    with TestClient(app) as client:
        source = make_camera(client)
        assert upload_asset(client, source, "floor_plan", b"x" * 33).status_code == 413
    image = picture((4001, 4000))

    def forbidden(*args, **kwargs):
        raise AssertionError("Oversized image reached pixel decode")

    monkeypatch.setattr(Image.Image, "load", forbidden)
    with pytest.raises(ServiceError, match="16 megapixels"):
        canonical_setup_image(image, "floor_plan", 64, 48)


def test_external_alignment_is_explicit_and_replacement_revokes_old_authority(
    tmp_path, bundle
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = upload_asset(client, make_camera(client), "clean_reference").json()
        assert (
            external_proposal(client, source, alignment_confirmed=False).status_code
            == 400
        )
        assert (
            external_proposal(
                client, source, reference_image_sha256="0" * 64
            ).status_code
            == 409
        )
        saved = approve_external(client, source)
        reference = saved["tables"][0]["reference"]
        assert (
            reference["source_kind"] == "uploaded_image" and reference["source_t"] == 0
        )
        assert reference["alignment_confirmed"] is True
        assert reference["source_image"] == saved["setup_assets"]["clean_reference"]
        assert saved["tables"][0]["object_baseline"]["approved"]
        replaced = upload_asset(
            client, saved, "clean_reference", picture(color=(210, 140, 110))
        ).json()
        table = replaced["tables"][0]
        assert not replaced["calibration_confirmed"] and table["reference"] is None
        assert not table["alignment_confirmed"] and not table["reference_approved"]
        assert not table.get("object_baseline")
        assert external_proposal(client, saved).status_code == 409


def test_floor_replacement_revokes_map_review_but_preserves_baseline(tmp_path, bundle):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = upload_asset(client, make_camera(client), "clean_reference").json()
        source = upload_asset(client, source, "floor_plan").json()
        source["floor_plan_mode"] = "uploaded"
        saved = approve_external(client, source)
        before = saved["tables"][0]["object_baseline"]
        replaced = upload_asset(client, saved, "floor_plan", picture((200, 100))).json()
        assert replaced["tables"][0]["object_baseline"] == before
        assert replaced["tables"][0]["setup_review"]["map"] is False
        assert not replaced["calibration_confirmed"]


def test_guided_empty_draft_manual_tables_and_explicit_review_gate(tmp_path, bundle):
    deps = object_dependencies(bundle)
    original = deps["prepare_video"]

    async def no_proposals(*args):
        layout = await original(*args)
        layout["tables"] = []
        return layout

    deps["prepare_video"] = no_proposals
    app = create_app(
        tmp_path / "data", dependencies=deps, limits={"disk_reserve_bytes": 0}
    )
    with TestClient(app) as client:
        response = client.post(
            "/api/videos",
            files={"file": ("source.mp4", video_bytes(tmp_path), "video/mp4")},
        )
        source = wait_job(client, response.json()["id"])
        assert source["status"] == "needs_setup" and source["tables"] == []
        path = "/api/sources/" + source["id"]
        draft = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [],
                "confirmed": False,
                "setup_mode": "guided_v1",
            },
        )
        assert draft.status_code == 200, draft.text
        source = draft.json()
        assert not source["calibration_confirmed"]
        assert (
            client.post(path + "/analyze", json={"detection_only": True}).status_code
            == 400
        )
        table = deepcopy(bundle["tables"][0])
        table["reference"] = None
        payload = {
            "revision": source["revision"],
            "tables": [table],
            "confirmed": True,
            "floor_plan_mode": "schematic",
        }
        assert client.put(path + "/calibration", json=payload).status_code == 400
        table["setup_review"] = {"tabletop": True, "occupancy": True, "map": True}
        saved = client.put(path + "/calibration", json=payload)
        assert saved.status_code == 200, saved.text
        assert (
            client.post(path + "/analyze", json={"detection_only": False}).status_code
            == 400
        )
        assert (
            client.post(path + "/analyze", json={"detection_only": True}).status_code
            == 202
        )
        assert wait_job(client, source["id"])["status"] == "completed"


def test_zero_table_draft_keeps_reference_choice_and_photo_replacement_clears_alignment(
    tmp_path, bundle
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        path = "/api/sources/" + source["id"]
        pending = {
            "reference_source": "uploaded_image",
            "reference_t": None,
            "alignment_confirmed": False,
        }
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [],
                "confirmed": False,
                "setup_reference": pending,
            },
        )
        assert response.status_code == 200, response.text
        source = response.json()
        assert (
            source["setup_reference"] == pending and not source["calibration_confirmed"]
        )
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [],
                "confirmed": False,
                "setup_reference": {**pending, "alignment_confirmed": True},
            },
        )
        assert response.status_code == 409
        source = upload_asset(client, source, "clean_reference").json()
        asset = source["setup_assets"]["clean_reference"]
        selected = {
            **pending,
            "reference_image_sha256": asset["sha256"],
            "alignment_confirmed": True,
        }
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [],
                "confirmed": False,
                "setup_reference": selected,
            },
        )
        assert response.status_code == 200, response.text
        source = response.json()
        assert (
            source["setup_reference"] == selected
            and not source["calibration_confirmed"]
        )
        assert client.get(path).json()["setup_reference"] == selected
        replaced = upload_asset(
            client, source, "clean_reference", picture(color=(200, 100, 150))
        ).json()
        assert replaced["setup_reference"]["reference_image_sha256"] != asset["sha256"]
        assert replaced["setup_reference"]["alignment_confirmed"] is False
    with TestClient(
        create_app(tmp_path, dependencies=object_dependencies(bundle))
    ) as client:
        assert client.get(path).json()["setup_reference"] == replaced["setup_reference"]


def test_fresh_proposal_quantity_edits_survive_draft_save_after_geometry_change(
    tmp_path, bundle
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        path = "/api/sources/" + source["id"]
        table = deepcopy(source["tables"][0])
        table["tabletop_polygon"][0][0] += 0.03
        proposed = client.post(
            path + "/baseline-proposal",
            json={
                "revision": source["revision"],
                "table_id": table["id"],
                "tabletop_polygon": table["tabletop_polygon"],
                "occupancy_regions": table["occupancy_regions"],
                "reference_t": 0,
            },
        ).json()
        table.update(
            reference_t=0,
            reference_approved=False,
            object_baseline={
                **proposed["baseline"],
                "expected": [{"class_id": 41, "count": 3}],
            },
        )
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [table],
                "confirmed": False,
            },
        )
        assert response.status_code == 200, response.text
        source = response.json()
        draft_table = source["tables"][0]
        assert draft_table["expected_objects_draft"] == [{"class_id": 41, "count": 3}]
        assert draft_table["reference"] is None and not draft_table.get(
            "object_baseline"
        )
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [draft_table],
                "confirmed": False,
            },
        )
        assert response.status_code == 200, response.text
        source = response.json()
        assert source["tables"][0]["expected_objects_draft"] == [
            {"class_id": 41, "count": 3}
        ]
        changed = deepcopy(source["tables"][0])
        changed["tabletop_polygon"][0][0] += 0.03
        changed["object_baseline"] = proposed["baseline"]
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [changed],
                "confirmed": False,
            },
        )
        assert response.status_code == 200, response.text
        assert not response.json()["tables"][0].get("expected_objects_draft")


@pytest.mark.parametrize(
    "field", ["reference_sha256", "config_sha256", "detector_sha256"]
)
def test_stale_incoming_proposal_cannot_restore_draft_inventory(
    tmp_path, bundle, field
):
    app = create_app(tmp_path, dependencies=object_dependencies(bundle))
    with TestClient(app) as client:
        source = make_camera(client)
        path = "/api/sources/" + source["id"]
        table = deepcopy(source["tables"][0])
        proposed = client.post(
            path + "/baseline-proposal",
            json={
                "revision": source["revision"],
                "table_id": table["id"],
                "tabletop_polygon": table["tabletop_polygon"],
                "occupancy_regions": table["occupancy_regions"],
                "reference_t": 0,
            },
        ).json()
        table.update(
            reference_t=0,
            reference_approved=False,
            object_baseline={**proposed["baseline"], field: "0" * 64},
        )
        response = client.put(
            path + "/calibration",
            json={
                "revision": source["revision"],
                "tables": [table],
                "confirmed": False,
            },
        )
        assert response.status_code == 200, response.text
        assert not response.json()["tables"][0].get("expected_objects_draft")
