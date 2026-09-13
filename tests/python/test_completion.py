"""Completion orchestration tests use mocks, never claim to run inference."""

from copy import deepcopy
import hashlib
import json

import pytest


def test_B20_real_main_clip_alone_cannot_report_complete_without_heldout(
    bundle, labels, tmp_path, monkeypatch
):
    from evaluator import __main__ as cli

    source = tmp_path / "source"
    source.mkdir()
    video = source / "video.mp4"
    video.write_bytes(b"mock prerequisite bytes; not actual video evidence")
    bundle["provenance"] = "real_video"
    bundle["video"]["sha256"] = hashlib.sha256(video.read_bytes()).hexdigest()
    labels["provenance"] = "manual_real_video"
    labels["video_sha256"] = bundle["video"]["sha256"]
    (source / "bundle.json").write_text(json.dumps(bundle))
    label_path = tmp_path / "labels.json"
    label_path.write_text(json.dumps(labels))
    reports = []
    monkeypatch.setattr(
        cli, "write_report", lambda report, out: reports.append(deepcopy(report))
    )
    monkeypatch.setattr(
        cli,
        "run_test_layers",
        lambda out: [
            {"name": name, "status": "passed"}
            for name in (
                "python_unit",
                "real_model_integration",
                "typescript_state",
                "browser",
                "object_surface_integration",
            )
        ],
    )
    monkeypatch.setattr(cli, "evaluate", lambda *args, **kwargs: {"passed": True})
    monkeypatch.setattr(cli, "stage_layout", lambda *args: tmp_path / "layout.json")

    def simulated_trial(video, layout, output, model, model_dir, duration, trial):
        output.mkdir(parents=True, exist_ok=True)
        (output / "bundle.json").write_text(json.dumps(bundle))
        return {"model": model, "trial": trial, "status": "passed"}

    monkeypatch.setattr(cli, "run_trial", simulated_trial)
    status = cli.main(
        [
            "--bundle",
            str(source),
            "--labels",
            str(label_path),
            "--models",
            "tiny",
            "--out",
            str(tmp_path / "report"),
        ]
    )
    assert (
        status != 0
    ), "Main-clip correctness must not certify missing held-out evaluation"
    assert reports[-1]["status"] == "incomplete"
