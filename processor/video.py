"""Streaming OpenCV decode with source-media timestamps, never wall time."""

from __future__ import annotations

import math
from pathlib import Path
from time import perf_counter

import cv2


class VideoReader:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        if not self.path.is_file():
            raise FileNotFoundError(f"Video not found: {self.path}")
        self.capture = cv2.VideoCapture(str(self.path))
        if not self.capture.isOpened():
            raise ValueError(
                "OpenCV could not open the video. Supply a locally decodable video file."
            )
        self.width = int(self.capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.fps = float(self.capture.get(cv2.CAP_PROP_FPS))
        self.frame_count = int(self.capture.get(cv2.CAP_PROP_FRAME_COUNT))
        if (
            min(self.width, self.height, self.frame_count) < 1
            or not math.isfinite(self.fps)
            or self.fps <= 0
        ):
            self.close()
            raise ValueError(
                "Video needs valid dimensions, duration and frame-rate metadata"
            )
        self.duration_s = self.frame_count / self.fps
        self.decoded_frames = 0
        self.decode_s = 0.0
        self.last_t = -1.0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        self.capture.release()

    def frames(self):
        """Yield (frame_index, source_seconds, BGR image), sequentially."""
        while True:
            started = perf_counter()
            success, frame = self.capture.read()
            self.decode_s += perf_counter() - started
            if not success:
                if self.decoded_frames == 0:
                    raise ValueError("Video contains no decodable frames")
                if self.decoded_frames + 1 < self.frame_count:
                    raise ValueError(
                        "Video decoding ended before its declared final frame; re-encode or repair the source"
                    )
                break
            timestamp = float(self.capture.get(cv2.CAP_PROP_POS_MSEC)) / 1000.0
            if (
                not math.isfinite(timestamp)
                or timestamp < 0
                or timestamp <= self.last_t
            ):
                raise ValueError(
                    "Video backend returned missing/nonmonotonic source timestamps. Re-encode this clip to a constant-frame-rate MP4; no wall-clock or guessed timestamp fallback is used."
                )
            if frame.shape[:2] != (self.height, self.width):
                raise ValueError(
                    "Frame dimensions changed inside the clip; use a fixed-camera, fixed-resolution recording"
                )
            index = self.decoded_frames
            self.decoded_frames += 1
            self.last_t = timestamp
            yield index, timestamp, frame

    def sampled_frames(self, sample_hz: float = 5.0):
        if not math.isfinite(sample_hz) or sample_hz <= 0:
            raise ValueError("sample_hz must be positive")
        next_sample = 0.0
        interval = 1.0 / sample_hz
        for index, timestamp, frame in self.frames():
            if timestamp + 1e-8 >= next_sample:
                yield index, timestamp, frame
                # Never duplicate a decoded frame to fill missing timestamps.
                next_sample = (math.floor((timestamp + 1e-8) / interval) + 1) * interval


def reference_frame(path: str | Path, source_t: float = 0.0):
    if not math.isfinite(source_t) or source_t < 0:
        raise ValueError("Reference source time must be finite and nonnegative")
    with VideoReader(path) as reader:
        metadata = {
            "width": reader.width,
            "height": reader.height,
            "fps": reader.fps,
            "duration_s": reader.duration_s,
        }
        for index, timestamp, frame in reader.frames():
            if timestamp + 1e-8 >= source_t:
                return frame, timestamp, index, metadata
    raise ValueError("Reference time is beyond the final decoded video frame")
