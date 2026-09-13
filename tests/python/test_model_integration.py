"""Actual ONNX inference, separately labelled from restaurant-video validation."""

import os
from pathlib import Path

import cv2
import pytest

from processor.detector import YOLOXDetector


@pytest.mark.integration
@pytest.mark.parametrize("model", ["nano", "tiny", "s"])
def test_official_models_detect_people_in_genuine_bus_image(model):
    model_dir = os.environ.get("YOLOX_MODEL_DIR")
    image_path = os.environ.get("YOLOX_TEST_IMAGE")
    if not model_dir or not image_path:
        pytest.skip(
            "YOLOX_MODEL_DIR and YOLOX_TEST_IMAGE are required for real-model evidence"
        )
    if (
        not Path(model_dir, f"yolox_{model}.onnx").is_file()
        or not Path(image_path).is_file()
    ):
        pytest.skip("Official ONNX model or genuine person image is unavailable")
    frame = cv2.imread(image_path)
    assert frame is not None
    detector = YOLOXDetector(model=model, model_dir=model_dir)
    detections = detector.detect(frame)
    assert (
        sum(item["class_id"] == 0 for item in detections) >= 2
    ), "Genuine bus street image has multiple visible people; adapter must detect at least two"
    assert all(0 <= value <= 1 for item in detections for value in item["box"])
    assert detector.last_timing["inference"] > 0
