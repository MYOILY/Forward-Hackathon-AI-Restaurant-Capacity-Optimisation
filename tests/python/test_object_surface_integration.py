"""Real Tiny CPU inference on preserved independently labelled AI-source fixtures.

These are fixture integration checks, never evidence of real restaurant accuracy.
The original fixture directory and manifest are retained as historical assets.
"""

import hashlib
import json
import os
from pathlib import Path

import pytest

from processor.object_baseline import CONFIG, CONFIG_SHA256
from processor.object_surface import ObjectSurfaceModel

ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = ROOT / "tests/fixtures/surface"


@pytest.fixture(scope="module")
def surface_model():
    model_dir = Path(os.environ.get("YOLOX_MODEL_DIR", ROOT / "models"))
    if not (model_dir / "yolox_tiny.onnx").is_file():
        pytest.skip(
            "Verified yolox_tiny.onnx missing; actual surface integration not run"
        )
    model = ObjectSurfaceModel(model_dir)
    yield model
    model.close()


@pytest.mark.integration
@pytest.mark.surface_integration
@pytest.mark.parametrize("case_id", ["ai-reset", "ai-used"])
def test_actual_object_reference_assessment_on_reviewed_image_pairs(
    surface_model, case_id
):
    manifest = json.loads((FIXTURE_ROOT / "manifest.json").read_text())
    case = next(item for item in manifest["cases"] if item["id"] == case_id)
    reference, current = (
        FIXTURE_ROOT / manifest["reference_file"],
        FIXTURE_ROOT / case["current_file"],
    )
    assert (
        hashlib.sha256(reference.read_bytes()).hexdigest()
        == manifest["reference_sha256"]
    )
    assert hashlib.sha256(current.read_bytes()).hexdigest() == case["sha256"]
    result = surface_model.assess(reference, current)
    assert result["valid"] is True, result
    assert result["config_sha256"] == CONFIG_SHA256
    assert surface_model.detector.class_ids == tuple(range(80))
    assert surface_model.detector.session.get_providers() == ["CPUExecutionProvider"]
    assert surface_model.metadata["intra_threads"] == 1
    assert surface_model.last_timing["inference"] > 0
    evidence = result["object_evidence"]
    if case_id == "ai-reset":
        assert evidence["reference"]["changed_fraction"] == 0
        assert evidence["reference"]["edge_mismatch"] == 0
    else:
        assert (
            evidence["reference"]["changed_fraction"] > CONFIG["max_changed_fraction"]
        )
        assert any(
            item["class_id"] not in (0, 56, 60)
            and item["score"] >= CONFIG["confident_score"]
            for item in evidence["detections"]
        )
