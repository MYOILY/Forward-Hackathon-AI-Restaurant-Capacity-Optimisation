"""Synthetic decoder streams test timing rules; these are not model evaluations."""

import cv2
import numpy as np
import pytest

from processor.video import VideoReader


def reader_with_frames(timestamps, shapes=None):
    reader = object.__new__(VideoReader)
    reader.width, reader.height = 40, 20
    reader.frame_count = len(timestamps)
    reader.decoded_frames, reader.decode_s, reader.last_t = 0, 0.0, -1.0

    class Capture:
        index = -1

        def read(self):
            self.index += 1
            if self.index >= len(timestamps):
                return False, None
            shape = shapes[self.index] if shapes else (20, 40, 3)
            return True, np.zeros(shape, dtype=np.uint8)

        def get(self, key):
            assert key == cv2.CAP_PROP_POS_MSEC
            return timestamps[self.index] * 1000

    reader.capture = Capture()
    return reader


def test_sampling_keeps_source_timestamps_and_never_duplicates_missing_frames():
    reader = reader_with_frames([0, 0.1, 0.25, 0.3, 0.4, 0.95])
    sampled = [(index, timestamp) for index, timestamp, _ in reader.sampled_frames(5)]
    assert sampled == [(0, 0), (2, 0.25), (4, 0.4), (5, 0.95)]


@pytest.mark.parametrize("timestamps", [[0, 0.1, 0.1], [0, -0.1], [0, float("nan")]])
def test_missing_or_nonmonotonic_source_clock_is_rejected(timestamps):
    with pytest.raises(ValueError, match="timestamps"):
        list(reader_with_frames(timestamps).frames())


def test_changed_source_dimensions_rejected():
    with pytest.raises(ValueError, match="dimensions"):
        list(reader_with_frames([0, 0.1], [(20, 40, 3), (20, 50, 3)]).frames())


@pytest.mark.parametrize("sample_hz", [0, -1, float("nan")])
def test_invalid_sampling_rate_rejected(sample_hz):
    with pytest.raises(ValueError):
        list(reader_with_frames([0, 0.1]).sampled_frames(sample_hz))
