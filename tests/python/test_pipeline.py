"""Actual video decode and TS scheduler integration; model outputs are explicit mocks."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np
import pytest


@pytest.mark.parametrize("approved", [True, False])
@pytest.mark.parametrize("external_reference", [True, False])
def test_B01_B19_pipeline_submits_actual_source_capture_before_advancing(
    bundle, tmp_path, monkeypatch, approved, external_reference
):
    import processor.pipeline as pipeline

    video = tmp_path / "source.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    if not writer.isOpened():
        pytest.fail("Required deterministic video writer unavailable")
    for index in range(90):
        writer.write(np.full((48, 64, 3), 30 + index, np.uint8))
    writer.release()
    reference = tmp_path / "reference.png"
    cv2.imwrite(str(reference), np.full((48, 64, 3), 30, np.uint8))
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    layout = deepcopy(bundle)
    layout.update(calibration_confirmed=True, original_scene=None)
    layout["video"].update(
        file=video.name, sha256=digest(video), width=64, height=48, fps=10, duration_s=9
    )
    layout["tables"][0]["reference"].update(
        file=reference.name, sha256=digest(reference)
    )
    from processor.object_baseline import build_baseline, SURFACE_METHOD, CONFIG_SHA256
    from processor.models import MODEL_HASHES

    if external_reference:
        full_image = tmp_path / "clean-photo.png"
        cv2.imwrite(str(full_image), np.full((48, 64, 3), (30, 180, 90), np.uint8))
        table = layout["tables"][0]
        table["reference"].update(
            source_kind="uploaded_image",
            source_image={
                "file": full_image.name,
                "sha256": digest(full_image),
                "width": 64,
                "height": 48,
            },
            alignment_confirmed=True,
        )
        table["reference_source"] = "uploaded_image"
        table["reference_image_sha256"] = digest(full_image)
        table["alignment_confirmed"] = True
        floor = tmp_path / "floor-plan.png"
        cv2.imwrite(str(floor), np.full((100, 300, 3), 90, np.uint8))
        layout["floor_plan"] = {
            "file": floor.name,
            "sha256": digest(floor),
            "width": 300,
            "height": 100,
        }
    layout["tables"], _ = pipeline.refresh_references(
        video, layout["tables"], tmp_path, layout_root=tmp_path
    )
    table = layout["tables"][0]
    if approved:
        table["surface_method"] = SURFACE_METHOD
        table["object_baseline"] = build_baseline(
            [],
            table["reference"]["sha256"],
            table["geometry_sha256"],
            MODEL_HASHES["tiny"],
        )
    layout_path = tmp_path / "layout.json"
    layout_path.write_text(json.dumps(layout))
    calls = []

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
            pass

        def detect(self, frame):
            return []

    class Monitor:
        def __init__(self, tables):
            pass

        def update(self, frame, detections, valid=True):
            return {
                "scene_cut": False,
                "surface": {"T1": {"visible": True, "changed": False}},
            }

    class Model:
        metadata = {"model": "explicit_test_double", "provenance": "synthetic_fixture"}
        last_timing = {"detector_total": 0.001}
        startup_timing = {"session_load": 0.001}

        def __init__(self, *args, **kwargs):
            pass

        def assess(self, ref, current):
            calls.append(
                (Path(ref), Path(current), float(cv2.imread(str(current)).mean()))
            )
            return {
                "outcome": "unobservable",
                "valid": True,
                "reason": "Awaiting shared comparison",
                "surface_method": SURFACE_METHOD,
                "config_sha256": CONFIG_SHA256,
                "object_evidence": {
                    "detections": [],
                    "reference": {
                        "observable": True,
                        "brightness_offset": 0,
                        "changed_fraction": 0,
                        "largest_change_fraction": 0,
                        "edge_mismatch": None,
                    },
                },
            }

    monkeypatch.setattr(pipeline, "YOLOXDetector", Detector)
    monkeypatch.setattr(pipeline, "SurfaceMonitor", Monitor)
    monkeypatch.setattr(pipeline, "ObjectSurfaceModel", Model)
    out = tmp_path / "out"
    args = SimpleNamespace(
        video=video,
        layout=layout_path,
        out=out,
        model="tiny",
        model_dir=tmp_path,
        confidence=None,
        nms_threshold=0.45,
        intra_threads=4,
        accept_proposals=False,
        sample_hz=10,
        provenance=None,
        skip_surface=False,
    )
    pipeline.analyze(args)
    bundle = json.loads((out / "bundle.json").read_text())
    assert bundle["analysis"]["surface_decision_policy"] == json.loads(
        (
            Path(pipeline.__file__).resolve().parents[1]
            / "shared/surface-decision-policy.json"
        ).read_text()
    )
    assert (
        bundle["analysis"]["surface_decision_policy"]["version"]
        == "reference_difference_v3"
    )
    assert bundle["analysis"]["reference_alignment"]["method"] == "translation_ecc_v1"
    if external_reference:
        exported = bundle["tables"][0]["reference"]
        assert exported["source_kind"] == "uploaded_image"
        assert exported["sha256"] == table["reference"]["sha256"]
        assert digest(out / exported["source_image"]["file"]) == digest(full_image)
        assert cv2.imread(str(out / exported["file"]))[0, 0].tolist() == [30, 180, 90]
        assert digest(out / bundle["floor_plan"]["file"]) == digest(floor)
        assert bundle["floor_plan"]["width"] / bundle["floor_plan"]["height"] == 3
        assert bundle["analysis"]["uploaded_table_references_preserved"] == 1
        assert bundle["analysis"]["table_references_refreshed_from_source"] is False
    assert [item["t"] for item in bundle["snapshots"]] == [
        item["t"] for item in bundle["observations"]
    ] + [bundle["video"]["duration_s"]]
    assert [item["t"] for item in bundle["snapshots"]] == pytest.approx(
        [index / 10 for index in range(90)] + [9], abs=1e-8
    )
    if not approved:
        assert bundle["tables"][0]["surface_method"] == SURFACE_METHOD
        assert bundle["assessment_requests"] == bundle["assessments"] == calls == []
        assert all(
            item["tables"]["T1"]["status"] == "unknown" for item in bundle["snapshots"]
        )
        return
    by_time = {item["t"]: item for item in bundle["snapshots"]}
    assert by_time[5]["tables"]["T1"]["status"] == "unknown"
    assert by_time[7]["tables"]["T1"]["status"] == "ready"
    assert by_time[9]["tables"]["T1"]["status"] == "ready"
    assert all("events" not in item for item in bundle["snapshots"])
    assert [
        event["t"]
        for event in bundle["replay_events"]
        if event["kind"] == "transition" and event["status"] == "ready"
    ] == [7]
    assert [item["t"] for item in bundle["assessments"]] == [1, 5, 7]
    assert [item["frame_index"] for item in bundle["assessments"]] == [10, 50, 70]
    assert len(calls) == 3 and calls[0][2] < calls[1][2] < calls[2][2]
    for request, result, (_, current, _) in zip(
        bundle["assessment_requests"], bundle["assessments"], calls
    ):
        assert result["crop_sha256"] == digest(current)
        assert result["video_sha256"] == digest(video)
        assert result["generation"] == request["generation"] == 0
        assert result["reference_sha256"] == digest(
            out / bundle["tables"][0]["reference"]["file"]
        )
    # The actual TS reducer, not a Python reimplementation, confirms exported evidence.
    from evaluator.replay import run_replay

    snapshots = run_replay(bundle, [5, 6.9, 7], [])["snapshots"]
    assert [snapshot["tables"]["T1"]["status"] for snapshot in snapshots] == [
        "unknown",
        "unknown",
        "ready",
    ]
