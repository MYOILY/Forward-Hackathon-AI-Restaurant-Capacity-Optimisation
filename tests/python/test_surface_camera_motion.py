"""Image regressions distinguishing moving foreground from camera motion."""

import cv2
import numpy as np
import pytest

from processor.surface import SurfaceMonitor


TABLE = {
    "id": "T1",
    "tabletop_polygon": [[0.7, 0.75], [0.95, 0.75], [0.95, 0.95], [0.7, 0.95]],
}


def texture(seed=4):
    return cv2.GaussianBlur(
        np.random.default_rng(seed).integers(20, 235, (90, 160, 3), dtype=np.uint8),
        (3, 3),
        0,
    )


def person(box):
    return {"class_id": 0, "score": 0.95, "box": box}


@pytest.mark.parametrize("background_texture", [False, True])
def test_fixed_camera_moving_person_keeps_unobstructed_table_visible(
    background_texture,
):
    background = (
        texture() if background_texture else np.full((90, 160, 3), 150, np.uint8)
    )
    foreground = texture(6)[:50, :70]
    monitor = SurfaceMonitor([TABLE])
    for offset in list(range(0, 31, 2)) + list(range(30, -1, -2)):
        frame = background.copy()
        x = 10 + offset
        frame[10:60, x : x + 70] = foreground
        result = monitor.update(
            frame, [person([x / 160, 10 / 90, (x + 70) / 160, 60 / 90])]
        )
        assert result["scene_cut"] is False
        assert result["surface"]["T1"]["camera_moved"] is False
        assert result["surface"]["T1"]["visible"] is True
    assert monitor.update(background, [])["surface"]["T1"]["visible"] is True


@pytest.mark.parametrize("present_first", [True, False])
def test_foreground_exclusion_uses_both_frames_for_arrivals_and_departures(
    present_first,
):
    background = texture(9)
    covered = background.copy()
    # A near-camera person obscures enough pixels to resemble a scene cut.
    covered[:80, :145] = np.random.default_rng(10).choice(
        np.array([0, 255], np.uint8), (80, 145, 3)
    )
    detection = [person([0, 0, 145 / 160, 80 / 90])]
    monitor = SurfaceMonitor([TABLE])
    frames = (
        [(covered, detection), (background, [])]
        if present_first
        else [(background, []), (covered, detection)]
    )
    for frame, detections in frames + [(background, [])]:
        result = monitor.update(frame, detections)
        assert result["scene_cut"] is False
        assert result["surface"]["T1"]["camera_moved"] is False


def test_localized_unclassified_motion_is_not_enough_camera_evidence():
    foreground = texture(8)[:24, :30]
    monitor = SurfaceMonitor([TABLE])
    for offset in range(12):
        frame = np.full((90, 160, 3), 150, np.uint8)
        frame[10:34, 10 + offset : 40 + offset] = foreground
        result = monitor.update(frame, [])
        assert result["surface"]["T1"]["camera_moved"] is False


def test_fixed_camera_does_not_accumulate_small_registration_errors():
    background = texture(22)
    monitor = SurfaceMonitor([TABLE])
    rng = np.random.default_rng(11)
    for _ in range(160):
        # Repeated subpixel jitter has zero net movement from calibration.
        transform = np.array(
            [[1.0, 0.0, rng.uniform(-0.25, 0.25)], [0.0, 1.0, rng.uniform(-0.25, 0.25)]]
        )
        frame = cv2.warpAffine(
            background, transform, (160, 90), borderMode=cv2.BORDER_REFLECT
        )
        result = monitor.update(frame, [])
        assert result["surface"]["T1"]["camera_moved"] is False


def test_true_scene_cut_invalidates_calibration_and_stays_latched():
    rng = np.random.default_rng(27)
    pixels = np.tile(np.array([0, 255], np.uint8), 90 * 160 // 2)
    rng.shuffle(pixels)
    first = np.repeat(pixels.reshape(90, 160, 1), 3, axis=2)
    second = 255 - first
    monitor = SurfaceMonitor([TABLE])
    monitor.update(first, [])
    result = monitor.update(second, [])
    assert result["scene_cut"] is True
    assert result["surface"]["T1"]["camera_moved"] is True
    assert monitor.update(first, [])["surface"]["T1"]["visible"] is False
