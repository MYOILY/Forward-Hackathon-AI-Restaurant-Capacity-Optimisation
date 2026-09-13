"""Fixed-reference measurements: harmless brightness, unsupported extras and loss of visibility."""

import cv2
import numpy as np
import pytest

from processor.object_baseline import CONFIG
from processor.object_surface import (
    ALIGNMENT_CONFIG,
    ObjectSurfaceModel,
    compare_reference,
)


def image(value=120):
    return np.full((256, 256, 3), value, np.uint8)


def test_same_image_matches_and_textureless_images_omit_edge_criterion():
    result = compare_reference(image(), image())
    assert result == {
        "observable": True,
        "brightness_offset": 0.0,
        "changed_fraction": 0.0,
        "largest_change_fraction": 0.0,
        "edge_mismatch": None,
        "alignment": {
            "method": "translation_ecc_v1",
            "applied": False,
            "dx": 0.0,
            "dy": 0.0,
            "correlation": None,
        },
    }


def test_only_luminance_is_corrected_for_a_small_global_lighting_shift():
    result = compare_reference(image(100), image(110))
    assert result["observable"] and 0 < result["brightness_offset"] <= 24
    assert result["changed_fraction"] == 0
    assert not compare_reference(image(80), image(180))["observable"]


def test_stationary_unsupported_extra_remains_different_from_fixed_reference():
    current = image()
    current[80:160, 80:160] = (220, 20, 20)
    first, second = compare_reference(image(), current), compare_reference(
        image(), current
    )
    assert first == second
    assert first["observable"]
    assert first["changed_fraction"] > CONFIG["max_changed_fraction"]
    assert first["largest_change_fraction"] > CONFIG["max_largest_change_fraction"]
    assert first["edge_mismatch"] > CONFIG["max_edge_mismatch"]


def test_chroma_difference_not_hidden_by_matching_luminance():
    reference = image()
    lab = cv2.cvtColor(reference, cv2.COLOR_RGB2LAB)
    lab[40:120, 40:120, 1] = 180
    current = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    result = compare_reference(reference, current)
    assert result["changed_fraction"] > 0.05


@pytest.mark.parametrize("value", [0, 255])
def test_dark_or_saturated_reference_or_current_is_unobservable(value):
    for pair in ((image(value), image()), (image(), image(value))):
        result = compare_reference(*pair)
        assert result["observable"] is False and result["changed_fraction"] is None


def test_mismatched_dimensions_are_never_resized_to_match():
    assert compare_reference(image(), image()[:128])["observable"] is False


def test_two_pixel_edge_tolerance_keeps_small_edge_displacement_low():
    reference = image()
    reference[40:210, 80:160] = 220
    current = np.roll(reference, 2, axis=1)
    result = compare_reference(reference, current)
    assert result["edge_mismatch"] == 0


def textured_reference():
    # Broad irregular texture makes translation observable without periodic aliases.
    low = np.random.default_rng(18).integers(30, 225, (16, 16), dtype=np.uint8)
    gray = cv2.resize(low, (256, 256), interpolation=cv2.INTER_CUBIC)
    return np.repeat(gray[:, :, None], 3, axis=2)


def translated(reference, dx=4, dy=-3):
    return cv2.warpAffine(
        reference,
        np.array([[1.0, 0.0, dx], [0.0, 1.0, dy]], np.float32),
        (reference.shape[1], reference.shape[0]),
        borderMode=cv2.BORDER_REFLECT,
    )


def test_small_shift_of_clean_reference_registers_without_changing_images():
    reference = textured_reference()
    current = translated(reference)
    before = current.copy()
    raw = compare_reference(
        reference,
        current,
        alignment_config={**ALIGNMENT_CONFIG, "max_translation_fraction": 0},
    )
    result = compare_reference(reference, current)
    assert raw["changed_fraction"] > 0.1
    assert result["changed_fraction"] < 0.03
    assert result["alignment"]["applied"] is True
    assert result["alignment"]["dx"] == pytest.approx(4, abs=0.3)
    assert result["alignment"]["dy"] == pytest.approx(-3, abs=0.3)
    assert result["alignment"]["correlation"] >= ALIGNMENT_CONFIG["min_correlation"]
    np.testing.assert_array_equal(current, before)


def test_shifted_reference_with_added_object_still_exceeds_ten_percent_difference():
    reference = textured_reference()
    current = translated(reference)
    current[65:180, 65:180] = (220, 20, 20)
    result = compare_reference(reference, current)
    assert result["observable"] is True
    assert result["changed_fraction"] > 0.1
    assert result["largest_change_fraction"] > 0.1


@pytest.mark.parametrize("dx,dy", [(12, 0), (0, -12)])
def test_excessive_translation_keeps_raw_conservative_comparison(dx, dy):
    reference = textured_reference()
    current = translated(reference, dx, dy)
    raw = compare_reference(
        reference,
        current,
        alignment_config={**ALIGNMENT_CONFIG, "max_translation_fraction": 0},
    )
    result = compare_reference(reference, current)
    assert result["alignment"]["applied"] is False
    assert result["alignment"]["dx"] == result["alignment"]["dy"] == 0
    assert result["changed_fraction"] == raw["changed_fraction"] > 0.1


def test_registration_cannot_crop_an_added_object_away_at_the_image_edge():
    reference = textured_reference()
    current = translated(reference, 6, 0)
    current[:, :6] = (220, 20, 20)
    result = compare_reference(reference, current)
    assert result["alignment"]["applied"] is True
    assert result["changed_fraction"] >= 0.02
    assert result["largest_change_fraction"] >= 0.02


def test_brightness_normalization_after_registration_does_not_erase_coloured_objects():
    reference = textured_reference()
    current = translated(reference)
    current = np.clip(current.astype(int) + 8, 0, 255).astype(np.uint8)
    current[60:175, 60:175] = (220, 20, 20)
    result = compare_reference(reference, current)
    assert result["changed_fraction"] > 0.1


def test_localized_texture_alone_cannot_enable_reference_registration():
    reference = image()
    reference[100:145, 100:145] = textured_reference()[:45, :45]
    result = compare_reference(reference, translated(reference))
    assert result["alignment"]["applied"] is False


def test_unrelated_noisy_images_do_not_supply_reliable_registration():
    rng = np.random.default_rng(33)
    reference, current = [
        rng.integers(30, 225, (256, 256, 3), dtype=np.uint8) for _ in range(2)
    ]
    result = compare_reference(reference, current)
    assert result["alignment"]["applied"] is False
    assert result["changed_fraction"] > 0.1


def test_registration_failure_preserves_the_raw_difference(monkeypatch):
    reference = textured_reference()
    current = translated(reference)
    raw = compare_reference(
        reference,
        current,
        alignment_config={**ALIGNMENT_CONFIG, "max_translation_fraction": 0},
    )

    def fail(*args, **kwargs):
        raise cv2.error("Explicit failed registration fixture")

    monkeypatch.setattr(cv2, "findTransformECC", fail)
    result = compare_reference(reference, current)
    assert result["alignment"]["applied"] is False
    assert result["changed_fraction"] == raw["changed_fraction"]


def test_dark_images_skip_registration_and_remain_unobservable(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("Dark or saturated images must be rejected before alignment")

    monkeypatch.setattr(cv2, "findTransformECC", unexpected)
    assert compare_reference(textured_reference(), image(0))["observable"] is False


def test_object_detector_receives_the_raw_unregistered_crop():
    class Detector:
        sha256 = "a" * 64
        last_timing = {}

        def detect(self, frame):
            self.received = frame.copy()
            return []

    detector = Detector()
    model = ObjectSurfaceModel(detector=detector)
    reference, current = textured_reference(), translated(textured_reference())
    result = model.assess_images(reference, current)
    assert result["object_evidence"]["reference"]["alignment"]["applied"] is True
    np.testing.assert_array_equal(
        detector.received, cv2.cvtColor(current, cv2.COLOR_RGB2BGR)
    )
    assert model.metadata["reference_alignment"] == ALIGNMENT_CONFIG
