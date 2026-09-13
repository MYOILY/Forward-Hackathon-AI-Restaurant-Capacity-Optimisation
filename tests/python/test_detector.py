import numpy as np
import pytest

from processor.detector import decode_outputs, nms, postprocess, preprocess


def test_official_preprocess_is_top_left_bgr_114_padding_and_no_normalization():
    frame = np.zeros((100, 200, 3), dtype=np.uint8)
    frame[:] = [17, 31, 47]
    tensor, ratio = preprocess(frame, (416, 416))
    assert tensor.shape == (3, 416, 416)
    assert tensor.dtype == np.float32
    assert ratio == 2.08
    np.testing.assert_array_equal(tensor[:, 0, 0], [17, 31, 47])
    np.testing.assert_array_equal(tensor[:, 300, 200], [114, 114, 114])


@pytest.mark.parametrize(
    "frame",
    [
        np.zeros((0, 5, 3), np.uint8),
        np.zeros((4, 5), np.uint8),
        np.zeros((4, 5, 3), np.float32),
    ],
)
def test_invalid_frame_is_error_not_empty_prediction(frame):
    with pytest.raises(ValueError):
        preprocess(frame, (416, 416))


def test_hand_computed_raw_head_decoding_is_nonmutating():
    raw = np.zeros((1, 21, 85), dtype=np.float32)  # 32x32: 16+4+1 anchor cells
    before = raw.copy()
    decoded = decode_outputs(raw, (32, 32))
    np.testing.assert_array_equal(decoded[0, 0, :4], [0, 0, 8, 8])
    np.testing.assert_array_equal(decoded[0, 1, :4], [8, 0, 8, 8])
    np.testing.assert_array_equal(decoded[0, 16, :4], [0, 0, 16, 16])
    np.testing.assert_array_equal(decoded[0, 20, :4], [0, 0, 32, 32])
    np.testing.assert_array_equal(raw, before)


def test_source_coordinates_reverse_top_left_resize_and_clip_padding():
    decoded = np.zeros((1, 1, 85), dtype=np.float32)
    decoded[0, 0, :5] = [208, 104, 208, 104, 0.8]
    decoded[0, 0, 5] = 0.9
    result = postprocess(decoded, (100, 200), (416, 416), already_decoded=True)
    assert len(result) == 1 and result[0]["class_id"] == 0
    np.testing.assert_allclose(result[0]["box"], [0.25, 0.25, 0.75, 0.75], atol=1e-6)
    assert result[0]["score"] == pytest.approx(0.72)


def test_nonfinite_output_cannot_mean_vacant():
    raw = np.zeros((1, 1, 85), dtype=np.float32)
    raw[0, 0, 4] = np.nan
    with pytest.raises(ValueError):
        postprocess(raw, (100, 100), (416, 416), already_decoded=True)


def test_irrelevant_best_class_does_not_become_person():
    raw = np.zeros((1, 1, 85), dtype=np.float32)
    raw[0, 0, :5] = [100, 100, 40, 40, 1]
    raw[0, 0, 5] = 0.5
    raw[0, 0, 7] = 0.9
    assert postprocess(raw, (416, 416), (416, 416), already_decoded=True) == []


def test_nms_removes_duplicate_person_but_retains_separate_person():
    boxes = np.array(
        [[0, 0, 100, 100], [5, 5, 95, 95], [200, 200, 300, 300]], dtype=np.float32
    )
    assert nms(boxes, np.array([0.9, 0.8, 0.7])) == [0, 2]


def test_wrong_export_shape_rejected():
    with pytest.raises(ValueError):
        decode_outputs(np.zeros((1, 12, 85), np.float32), (416, 416))
