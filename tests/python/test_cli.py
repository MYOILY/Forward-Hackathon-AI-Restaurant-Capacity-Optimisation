"""CLI completeness and current processing entry-point contracts."""

import json
import pytest
from evaluator import __main__ as cli


def test_B20_v2_declares_surface_layer_even_when_independent_labels_missing(
    bundle, tmp_path
):
    source = tmp_path / "bundle.json"
    source.write_text(json.dumps(bundle))
    assert (
        cli.main(
            [
                "--bundle",
                str(source),
                "--labels",
                str(tmp_path / "missing.json"),
                "--out",
                str(tmp_path / "report"),
            ]
        )
        == 1
    )
    report = json.loads((tmp_path / "report/report.json").read_text())
    assert {row["name"] for row in report["test_layers"]} == {
        "python_unit",
        "real_model_integration",
        "object_surface_integration",
        "typescript_state",
        "browser",
    }
    assert all(row["status"] == "not_run" for row in report["test_layers"])


@pytest.mark.parametrize("spelling", ["--held-out", "--heldout"])
def test_B20_public_held_out_flags_and_original_aliases_are_accepted(
    spelling, tmp_path
):
    result = cli.main(
        [
            "--bundle",
            str(tmp_path / "missing-main"),
            "--labels",
            str(tmp_path / "missing-labels"),
            spelling + "-bundle",
            str(tmp_path / "heldout"),
            spelling + "-labels",
            str(tmp_path / "heldout-labels"),
            "--out",
            str(tmp_path / "report"),
        ]
    )
    assert result == 1
    assert (tmp_path / "report/report.json").is_file()


def test_B20_required_layers_are_policy_aware():
    assert "object_surface_integration" in cli.required_test_layers()


def test_B20_all_skipped_real_surface_checks_report_not_run(tmp_path, monkeypatch):
    from pathlib import Path
    from types import SimpleNamespace

    def fake_run(command, **kwargs):
        if "--junitxml" in command:
            destination = Path(command[command.index("--junitxml") + 1])
            if destination.name == "object_surface_integration.xml":
                destination.write_text(
                    '<testsuites><testsuite><testcase name="positive"><skipped message="Required CPU weights missing"/></testcase><testcase name="negative"><skipped message="Required CPU weights missing"/></testcase></testsuite></testsuites>'
                )
            else:
                destination.write_text(
                    '<testsuites><testsuite><testcase name="one"/></testsuite></testsuites>'
                )
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    layers = cli.run_test_layers(tmp_path)
    layer = next(
        item for item in layers if item["name"] == "object_surface_integration"
    )
    assert layer["status"] == "not_run" and layer["tests"] == layer["skipped"] == 2
    assert "weights missing" in layer["reason"]


@pytest.mark.parametrize(
    "obsolete", ["--skip-vlm", "--vlm-model-dir", "--vlm-max-tokens", "--policy"]
)
def test_obsolete_processor_options_are_not_accepted(obsolete):
    from processor.__main__ import parser

    with pytest.raises(SystemExit) as error:
        parser().parse_args(
            [
                "analyze",
                "--video",
                "input.mp4",
                "--layout",
                "layout.json",
                "--out",
                "out",
                obsolete,
            ]
        )
    assert error.value.code == 2


def test_detection_only_cli_uses_current_pipeline(monkeypatch):
    from processor.__main__ import main
    import processor.pipeline as pipeline

    received = []

    def analyze(args):
        received.append((args.skip_surface, args.sample_hz, args.confidence))
        return {"valid_samples": 1}

    monkeypatch.setattr(pipeline, "analyze", analyze)
    assert (
        main(
            [
                "analyze",
                "--video",
                "unused.mp4",
                "--layout",
                "unused.json",
                "--out",
                "unused",
                "--skip-surface",
            ]
        )
        == 0
    )
    assert received == [(True, 10.0, None)]


def test_unsupported_input_does_not_create_or_modify_output(tmp_path):
    from processor.__main__ import main

    source = tmp_path / "old-layout.json"
    source.write_text('{"schema_version": 1}')
    before = source.read_bytes()
    output = tmp_path / "output"
    assert (
        main(
            [
                "analyze",
                "--video",
                str(tmp_path / "source.mp4"),
                "--layout",
                str(source),
                "--out",
                str(output),
            ]
        )
        == 2
    )
    assert not output.exists() and source.read_bytes() == before
