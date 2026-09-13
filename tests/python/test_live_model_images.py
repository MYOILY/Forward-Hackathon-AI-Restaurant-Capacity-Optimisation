"""Actual RGB transport, raw evidence and error handling for CPU surface inference."""

import numpy as np
import pytest

from processor.object_surface import ObjectSurfaceModel


class Detector:
    sha256 = "d" * 64
    last_timing = {"inference": 0.001}
    startup_timing = {}

    def __init__(self, detections=None):
        self.detections = [] if detections is None else detections
        self.frames = []

    def detect(self, image):
        self.frames.append(image.copy())
        return self.detections


def test_surface_images_remain_in_ram_and_detector_receives_bgr(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    detector = Detector([{"class_id": 41, "score": 0.9, "box": [0.1, 0.1, 0.5, 0.5]}])
    model = ObjectSurfaceModel(tmp_path, detector=detector)
    reference = np.full((32, 32, 3), (180, 130, 80), np.uint8)
    result = model.assess_images(reference, reference)
    assert result["valid"] and result["outcome"] == "unobservable"
    assert result["reason"] == "Awaiting shared comparison"
    assert result["object_evidence"]["detections"] == detector.detections
    np.testing.assert_array_equal(detector.frames[0], reference[:, :, ::-1])
    assert list(tmp_path.iterdir()) == []


def test_surface_detector_exception_cannot_assert_a_positive():
    detector = Detector()

    def broken(*args):
        raise RuntimeError("explicit inference failure")

    detector.detect = broken
    model = ObjectSurfaceModel(detector=detector)
    image = np.full((32, 32, 3), 150, np.uint8)
    result = model.assess_images(image, image)
    assert result["valid"] is False and result["outcome"] == "unobservable"
    assert "inference failure" in result["error"]
    assert result["object_evidence"]["reference"]["observable"] is False


@pytest.mark.parametrize(
    "detections",
    [
        None,
        {},
        [{"class_id": 81, "score": 0.9, "box": [0.1, 0.1, 0.5, 0.5]}],
        [{"class_id": 41, "score": float("nan"), "box": [0.1, 0.1, 0.5, 0.5]}],
        [{"class_id": 41, "score": 0.9, "box": [0.5, 0.1, 0.1, 0.5]}],
    ],
)
def test_malformed_model_output_is_invalid_evidence(detections):
    detector = Detector()
    detector.detections = detections
    model = ObjectSurfaceModel(detector=detector)
    image = np.full((32, 32, 3), 150, np.uint8)
    result = model.assess_images(image, image)
    assert result["valid"] is False and result["outcome"] == "unobservable"


def test_proposal_exposes_all_supported_detections_and_pinned_identity():
    detector = Detector([{"class_id": 41, "score": 0.2, "box": [0.1, 0.1, 0.5, 0.5]}])
    result = ObjectSurfaceModel(detector=detector).propose_images(
        np.full((32, 32, 3), 150, np.uint8)
    )
    assert result["detections"] == detector.detections
    assert result["detector_sha256"] == detector.sha256


def test_person_in_tabletop_crop_is_unobservable_even_at_the_score_floor():
    detector = Detector([{"class_id": 0, "score": 0.15, "box": [0.1, 0.1, 0.5, 0.5]}])
    model = ObjectSurfaceModel(detector=detector)
    image = np.full((32, 32, 3), 150, np.uint8)
    result = model.assess_images(image, image)
    assert result["valid"] and not result["object_evidence"]["reference"]["observable"]
    assert "person" in result["object_evidence"]["reference"]["reason"]
