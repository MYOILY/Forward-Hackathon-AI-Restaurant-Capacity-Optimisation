"""Independent image-visibility and model preparation failure regressions."""

import numpy as np
import cv2
import pytest
from processor.surface import SurfaceMonitor
from processor.object_surface import ObjectSurfaceModel

TABLE = {
    "id": "T1",
    "tabletop_polygon": [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]],
}


def test_B15_blackout_is_not_observable_even_if_brightness_normalization_removes_change():
    monitor = SurfaceMonitor([TABLE])
    monitor.update(np.full((90, 160, 3), 150, np.uint8), [])
    result = monitor.update(np.zeros((90, 160, 3), np.uint8), [])
    assert result["surface"]["T1"]["visible"] is not True


@pytest.mark.parametrize("motion", ["translation", "rotation", "zoom"])
def test_B15_cumulative_camera_movement_invalidates_old_calibration(motion):
    frame = cv2.GaussianBlur(
        np.random.default_rng(17).integers(20, 235, (90, 160, 3), dtype=np.uint8),
        (3, 3),
        0,
    )
    monitor = SurfaceMonitor([TABLE])
    states = [monitor.update(frame, [])]
    for amount in range(1, 9):
        transform = (
            np.array([[1.0, 0.0, amount * 0.5], [0.0, 1.0, 0.0]])
            if motion == "translation"
            else cv2.getRotationMatrix2D(
                (80, 45),
                amount * 0.4 if motion == "rotation" else 0,
                1 + amount * 0.005 if motion == "zoom" else 1,
            )
        )
        moved = cv2.warpAffine(
            frame, transform, (160, 90), borderMode=cv2.BORDER_REFLECT
        )
        states.append(monitor.update(moved, []))
    assert states[1]["surface"]["T1"]["camera_moved"] is False
    assert any(row["surface"]["T1"]["camera_moved"] for row in states[1:])
    assert states[-1]["surface"]["T1"]["visible"] is False
    assert monitor.update(frame, [])["surface"]["T1"]["camera_moved"] is True


def test_B15_undecodable_reference_becomes_invalid_surface_evidence(tmp_path):
    image = tmp_path / "actual-fixture.png"
    image.write_bytes(b"explicit non-image fixture")
    model = ObjectSurfaceModel.__new__(ObjectSurfaceModel)
    result = model.assess(image, image)
    assert result["valid"] is False and result["outcome"] == "unobservable"
    assert "decode" in result["error"]
    assert model.last_timing
