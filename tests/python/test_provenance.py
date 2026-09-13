from copy import deepcopy
import json

import cv2
import numpy as np
import pytest

from evaluator.benchmark import stage_layout
from processor.references import _original_scene_source_t, _reference_inputs


@pytest.mark.parametrize("timestamp", [0, 1.25, None])
def test_evaluation_staging_preserves_original_source_time_without_inventing_zero(
    bundle, tmp_path, timestamp
):
    bundle["tables"][0]["reference"] = None
    source = tmp_path / "source"
    source.mkdir()
    image = np.full((20, 40, 3), 100, dtype=np.uint8)
    cv2.imwrite(str(source / "scene.png"), image)
    bundle["original_scene"] = "scene.png"
    bundle["analysis"].update(
        original_scene_source_t=timestamp, calibration_confirmed=True
    )
    before = deepcopy(bundle)
    filename = stage_layout(bundle, source, tmp_path / "staging")
    layout = json.loads(filename.read_text())
    assert layout["analysis"]["original_scene_source_t"] == timestamp
    assert _original_scene_source_t(layout) == timestamp
    assert layout["calibration_confirmed"] is True
    assert layout["provenance"] == "synthetic_fixture"
    records = _reference_inputs(layout, filename.parent)
    assert records[0]["source_t"] == timestamp
    assert records[0]["crop"] == [0, 0, 1, 1]
    assert records[0]["width"] == 40 and records[0]["height"] == 20
    assert bundle == before


def test_staging_missing_timestamp_remains_null(bundle, tmp_path):
    bundle["tables"][0]["reference"] = None
    filename = stage_layout(bundle, tmp_path, tmp_path / "staging")
    assert (
        json.loads(filename.read_text())["analysis"]["original_scene_source_t"] is None
    )


@pytest.mark.parametrize("timestamp", [True, -1, 31, float("nan")])
def test_processor_does_not_invent_original_scene_provenance(bundle, timestamp):
    bundle["original_scene"] = "scene.png"
    bundle["analysis"]["original_scene_source_t"] = timestamp
    assert _original_scene_source_t(bundle) is None


def test_staging_rejects_reference_path_escape(bundle, tmp_path):
    bundle["original_scene"] = "../outside.png"
    with pytest.raises(ValueError):
        stage_layout(bundle, tmp_path, tmp_path / "staging")


def test_staging_preserves_uploaded_reference_and_floor_plan_assets(bundle, tmp_path):
    from processor.io import sha256_file

    source = tmp_path / "source"
    source.mkdir()
    assets = {}
    for name, size in [
        ("reference", (20, 40)),
        ("clean", (360, 640)),
        ("floor", (60, 120)),
    ]:
        path = source / f"{name}.png"
        cv2.imwrite(str(path), np.full((*size, 3), 100, dtype=np.uint8))
        assets[name] = {
            "file": path.name,
            "sha256": sha256_file(path),
            "width": size[1],
            "height": size[0],
        }
    bundle["tables"][0]["reference"].update(
        file=assets["reference"]["file"],
        sha256=assets["reference"]["sha256"],
        source_kind="uploaded_image",
        source_image=assets["clean"],
        alignment_confirmed=True,
    )
    bundle.update(
        floor_plan=assets["floor"], floor_plan_mode="uploaded", setup_mode="guided_v1"
    )
    original = deepcopy(bundle)
    path = stage_layout(bundle, source, tmp_path / "staged")
    staged = json.loads(path.read_text())
    for asset in (
        staged["floor_plan"],
        staged["tables"][0]["reference"]["source_image"],
    ):
        assert sha256_file(path.parent / asset["file"]) == asset["sha256"]
    assert (
        staged["floor_plan_mode"] == "uploaded" and staged["setup_mode"] == "guided_v1"
    )
    assert staged["tables"][0]["reference"]["alignment_confirmed"] is True
    assert bundle == original
