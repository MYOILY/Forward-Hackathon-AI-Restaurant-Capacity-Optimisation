"""Actual source decode with explicit detector doubles; source callbacks are observable."""

import json
from types import SimpleNamespace
import cv2
import numpy as np


def test_prepare_and_detection_only_analysis_report_monotonic_progress_without_vlm(
    tmp_path, monkeypatch
):
    import processor.pipeline as pipeline

    path = tmp_path / "source.mp4"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    assert writer.isOpened()
    for index in range(20):
        writer.write(np.full((48, 64, 3), 100 + index, np.uint8))
    writer.release()

    class Detector:
        sha256 = "d" * 64
        input_size = (416, 416)
        last_timing = {"preprocess": 0.001, "inference": 0.002, "postprocess": 0.001}
        startup_timing = {
            "session_load": 0.01,
            "runtime_import": 0,
            "model_verify": 0,
            "detector_setup": 0.01,
        }

        def __init__(self, **kwargs):
            self.table = kwargs.get("class_ids") == (60,)

        def detect(self, frame):
            return (
                [{"class_id": 60, "score": 0.9, "box": [0.2, 0.2, 0.8, 0.8]}]
                if self.table
                else []
            )

    def forbidden(*args, **kwargs):
        raise AssertionError(
            "Explicit detection-only analysis invoked surface detector"
        )

    monkeypatch.setattr(pipeline, "YOLOXDetector", Detector)
    monkeypatch.setattr(pipeline, "ObjectSurfaceModel", forbidden)
    output = tmp_path / "out"
    args = SimpleNamespace(
        video=path,
        out=output,
        reference_time=0,
        model="tiny",
        model_dir=tmp_path,
        confidence=None,
        nms_threshold=0.45,
        intra_threads=4,
        confirmed_clean=False,
        provenance="synthetic_fixture",
    )
    preparation = []
    pipeline.prepare(
        args,
        progress=lambda phase, fraction, details: preparation.append(
            (phase, fraction, details)
        ),
    )
    layout = output / "layout.json"
    data = json.loads(layout.read_text())
    data["calibration_confirmed"] = True
    layout.write_text(json.dumps(data))
    args.layout = layout
    args.accept_proposals = False
    args.sample_hz = 10
    args.skip_surface = True
    analysis = []
    pipeline.analyze(
        args,
        progress=lambda phase, fraction, details: analysis.append(
            (phase, fraction, details)
        ),
    )
    for records in [preparation, analysis]:
        fractions = [item[1] for item in records]
        assert (
            fractions[0] == 0 and fractions[-1] == 1 and fractions == sorted(fractions)
        )
        assert all(
            isinstance(phase, str) and isinstance(details, dict)
            for phase, _, details in records
        )
    bundle = json.loads((output / "bundle.json").read_text())
    assert bundle["analysis"]["surface_analysis_complete"] is False
