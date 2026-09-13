from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

from .benchmark import (
    benchmark_lock,
    machine_metadata,
    run_trial,
    sha256_file,
    stage_layout,
)
from .labels import evaluation_segments, validate_labels
from .scoring import score_predictions
from .replay import PROJECT_ROOT, run_replay
from .reporting import capture_failure_evidence, write_report
from .completion import completion_status, planned_trials


def required_test_layers():
    return [
        "python_unit",
        "real_model_integration",
        "object_surface_integration",
        "typescript_state",
        "browser",
    ]


def run_test_layers(output: Path) -> list[dict]:
    npm = os.environ.get("EVALUATOR_NPM", "npm")
    definitions = [
        (
            "python_unit",
            [
                sys.executable,
                "-m",
                "pytest",
                "tests/python",
                "-m",
                "not integration",
                "--junitxml",
                str(output / "python_unit.xml"),
            ],
        ),
        (
            "real_model_integration",
            [
                sys.executable,
                "-m",
                "pytest",
                "tests/python",
                "-m",
                "integration and not surface_integration",
                "--junitxml",
                str(output / "real_model_integration.xml"),
            ],
        ),
        (
            "object_surface_integration",
            [
                sys.executable,
                "-m",
                "pytest",
                "tests/python",
                "-m",
                "surface_integration",
                "--junitxml",
                str(output / "object_surface_integration.xml"),
            ],
        ),
        (
            "typescript_state",
            [
                npm,
                "test",
                "--",
                "--reporter=junit",
                "--outputFile=" + str(output / "typescript_state.xml"),
            ],
        ),
        ("browser", [npm, "run", "test:browser"]),
    ]
    results = []
    for name, command in definitions:
        if name not in required_test_layers():
            continue
        log_path = output / (name + ".log")
        result = {"name": name, "command": command, "log": str(log_path)}
        started = time.perf_counter()
        try:
            with log_path.open("w") as log:
                completed = subprocess.run(
                    command,
                    cwd=PROJECT_ROOT,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=900,
                )
            result["returncode"] = completed.returncode
            result["status"] = "passed" if completed.returncode == 0 else "failed"
            xml_path = output / (name + ".xml")
            if xml_path.exists():
                root = ET.parse(xml_path).getroot()
                cases = root.findall(".//testcase")
                skips = len(root.findall(".//testcase/skipped"))
                result.update(tests=len(cases), skipped=skips)
                if (not cases or skips) and completed.returncode == 0:
                    explanations = sorted(
                        {
                            element.get(
                                "message", element.text or "Required test was skipped"
                            )
                            for element in root.findall(".//testcase/skipped")
                        }
                    )
                    result.update(
                        status=(
                            "not_run"
                            if not cases or skips == len(cases)
                            else "incomplete"
                        ),
                        reason=f"{skips} skipped tests; {len(cases)} tests discovered. {'; '.join(explanations)}",
                    )
            elif name != "browser" and completed.returncode == 0:
                result.update(
                    status="incomplete",
                    reason="Test runner did not produce required results",
                )
            if name == "browser" and completed.returncode == 0:
                browser_xml = PROJECT_ROOT / "test-results" / "browser.xml"
                if browser_xml.exists():
                    tree = ET.parse(browser_xml).getroot()
                    cases = tree.findall(".//testcase")
                    skipped = tree.findall(".//testcase/skipped")
                    result.update(tests=len(cases), skipped=len(skipped))
                    if not cases or skipped:
                        result.update(
                            status="incomplete",
                            reason="Browser test runner reported skipped/missing tests",
                        )
                else:
                    result.update(
                        status="incomplete", reason="Browser JUnit result is missing"
                    )
                result["playback_timings"] = [
                    json.loads(filename.read_text())
                    for filename in (PROJECT_ROOT / "test-results").rglob(
                        "playback-timing.json"
                    )
                ]
        except (OSError, subprocess.TimeoutExpired) as error:
            result.update(status="not_run", reason=str(error))
        result["elapsed_s"] = time.perf_counter() - started
        results.append(result)
    return results


def evaluate(bundle: dict, labels: dict, video: Path, output: Path) -> dict:
    validate_labels(labels, bundle)
    segments = evaluation_segments(bundle, labels)
    points = {point for pair in segments for point in pair}
    points.update(item["t"] for item in bundle.get("assessment_requests", []))
    points.update(item["t"] for item in bundle.get("assessments", []))
    boundaries = sorted(points)
    segments = list(zip(boundaries, boundaries[1:]))
    times = [(start + end) / 2 for start, end in segments] + [
        bundle["video"]["duration_s"]
    ]
    snapshots = run_replay(bundle, times, labels["staff_events"])["snapshots"]
    options = {}
    colour_actions = {"force_status", "clear_status_override"}
    if any(
        event["action"] in colour_actions
        for event in [*bundle["staff_events"], *labels["staff_events"]]
    ):
        automatic_bundle = {
            **bundle,
            "staff_events": [
                event
                for event in bundle["staff_events"]
                if event["action"] not in colour_actions
            ],
        }
        automatic_staff = [
            event
            for event in labels["staff_events"]
            if event["action"] not in colour_actions
        ]
        automatic = run_replay(automatic_bundle, times, automatic_staff)["snapshots"]
        options = {
            "automatic_snapshots": automatic[:-1],
            "automatic_final_snapshot": automatic[-1],
        }
    result = score_predictions(
        bundle, labels, segments, snapshots[:-1], snapshots[-1], **options
    )
    capture_failure_evidence(
        video, result["failures"] + result["challenge_failures"], output / "evidence"
    )
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate actual production code against independent labels. Speed is report-only."
    )
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True)
    parser.add_argument(
        "--held-out-bundle",
        "--heldout-bundle",
        dest="heldout_bundle",
        type=Path,
        help="Independent real recording required for complete validation",
    )
    parser.add_argument(
        "--held-out-labels",
        "--heldout-labels",
        dest="heldout_labels",
        type=Path,
        help="Independent labels for the distinct held-out recording",
    )
    parser.add_argument("--models", default="nano,tiny,s")
    parser.add_argument("--model-dir", type=Path, default=PROJECT_ROOT / "models")
    parser.add_argument(
        "--out", type=Path, default=PROJECT_ROOT / "artifacts" / "evaluation"
    )
    parser.add_argument(
        "--fixture-only",
        action="store_true",
        help="Replay supplied observations without inference or benchmarks; always reports incomplete real-video validation",
    )
    parser.add_argument(
        "--skip-tests",
        action="store_true",
        help="Diagnostic replay only; cannot produce an overall pass",
    )
    args = parser.parse_args(argv)
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {
        "schema_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "incomplete",
        "reasons": [],
        "machine": machine_metadata(),
        "test_layers": [],
        "evaluations": [],
        "performance_policy": "report_only",
        "held_out_recording_validation": {
            "status": "not_run",
            "reason": "This report evaluates one supplied recording. A second independently labelled real recording requires a separate evaluator run; synthetic evidence does not satisfy it.",
        },
    }
    required_layers = required_test_layers()
    report["test_layers"] = [
        {
            "name": name,
            "status": "not_run",
            "reason": "Required input/evidence prerequisites have not been validated",
        }
        for name in required_layers
    ]
    report["clips"] = {
        "main": {"status": "not_run"},
        "held_out": {
            "status": "not_run",
            "reason": "Held-out recording/labels were not supplied",
        },
    }
    try:
        from processor.io import validate_bundle

        models = list(dict.fromkeys(args.models.split(",")))
        if not models or any(model not in {"nano", "tiny", "s"} for model in models):
            raise ValueError(
                "Models must be a comma-separated selection of nano,tiny,s"
            )
        report["evaluations"] = planned_trials(models, ["main", "held_out"])
        if bool(args.heldout_bundle) != bool(args.heldout_labels):
            raise ValueError("Held-out bundle and labels must be supplied together")
        sources = [("main", args.bundle, args.labels)]
        if args.heldout_bundle:
            sources.append(("held_out", args.heldout_bundle, args.heldout_labels))
        datasets = []
        for role, bundle_path, label_path in sources:
            source = (
                bundle_path / "bundle.json" if bundle_path.is_dir() else bundle_path
            )
            bundle = json.loads(source.read_text())
            if role == "main":
                required_layers = required_test_layers()
                report["test_layers"] = [
                    {
                        "name": name,
                        "status": "not_run",
                        "reason": "Required input/evidence prerequisites have not been validated",
                    }
                    for name in required_layers
                ]
            validate_bundle(bundle)
            labels = json.loads(label_path.read_text())
            validate_labels(labels, bundle)
            video = (source.parent / bundle["video"]["file"]).resolve()
            if not video.is_relative_to(source.parent.resolve()):
                raise ValueError("Video path escapes bundle root")
            if sha256_file(video) != bundle["video"]["sha256"]:
                raise ValueError(
                    "Actual video SHA256 differs from bundle and label identity"
                )
            clip = {
                "status": "not_run",
                "provenance": labels["provenance"],
                "video_sha256": bundle["video"]["sha256"],
                "labels_sha256": sha256_file(label_path),
                "schema_version": bundle["schema_version"],
                "policy": bundle["policy"],
            }
            report["clips"][role] = clip
            datasets.append((role, source, bundle, labels, video))
            if role == "main":
                report.update(
                    provenance=labels["provenance"],
                    video_sha256=bundle["video"]["sha256"],
                    labels_sha256=clip["labels_sha256"],
                    requested_models=models,
                )
            if (
                labels["provenance"] != "manual_real_video"
                or bundle["provenance"] != "real_video"
            ):
                source_kind = (
                    "AI-generated video"
                    if bundle["provenance"] == "ai_generated_video"
                    else "Synthetic fixture"
                )
                report["reasons"].append(
                    f"{role}: {source_kind} evidence cannot certify restaurant accuracy; real footage and independent manual labels are still required."
                )
        if len(datasets) == 2:
            if datasets[0][2]["video"]["sha256"] == datasets[1][2]["video"]["sha256"]:
                raise ValueError("Held-out recording must be a different source video")
            if datasets[0][2]["schema_version"] != datasets[1][2]["schema_version"]:
                raise ValueError(
                    "Main and held-out recordings must use the same policy"
                )
        if args.skip_tests:
            report["test_layers"] = [
                {"name": name, "status": "not_run", "reason": "--skip-tests requested"}
                for name in required_layers
            ]
        else:
            report["test_layers"] = run_test_layers(output)
        if args.fixture_only:
            report["reasons"].append(
                "Fixture-only replay: requested detector evaluations and three-trial benchmarks were not run."
            )
            for role, source, bundle, labels, video in datasets:
                result = evaluate(bundle, labels, video, output / role / "fixture")
                status = result.get(
                    "status", "passed" if result["passed"] else "failed"
                )
                report["clips"][role]["status"] = status
                report["evaluations"].append(
                    {
                        "clip_role": role,
                        "model": "supplied_observations",
                        "status": status,
                        "metrics": result,
                    }
                )
        else:
            with benchmark_lock():
                for role, source, bundle, labels, video in datasets:
                    root = output if role == "main" else output / "held_out"
                    layout_path = stage_layout(
                        bundle, source.parent, root / "source_bundle"
                    )
                    relevant = [
                        item
                        for item in report["evaluations"]
                        if item["clip_role"] == role
                    ]
                    for item in relevant:
                        model, trial = item["model"], item["trial"]
                        trial_dir = root / model / f"trial-{trial}"
                        runtime = run_trial(
                            video,
                            layout_path,
                            trial_dir,
                            model,
                            args.model_dir.resolve(),
                            bundle["video"]["duration_s"],
                            trial,
                        )
                        item.update(status=runtime["status"], runtime=runtime)
                        item.pop("reason", None)
                        if runtime["status"] == "passed":
                            analyzed = json.loads(
                                (trial_dir / "bundle.json").read_text()
                            )
                            if analyzed["provenance"] != bundle["provenance"]:
                                raise ValueError("Processor changed source provenance")
                            item["metrics"] = evaluate(
                                analyzed, labels, video, trial_dir
                            )
                            item["status"] = item["metrics"].get(
                                "status",
                                "passed" if item["metrics"]["passed"] else "failed",
                            )
                        write_report(report, output)
                    statuses = [item["status"] for item in relevant]
                    report["clips"][role]["status"] = (
                        "failed"
                        if "failed" in statuses
                        else (
                            "passed"
                            if statuses and all(value == "passed" for value in statuses)
                            else "incomplete"
                        )
                    )
        completion = completion_status(
            report["clips"], report["test_layers"], report["evaluations"]
        )
        report["status"] = completion["status"]
        report["reasons"].extend(completion["reasons"])
        report["held_out_recording_validation"] = report["clips"]["held_out"]
        if report["status"] == "passed":
            for item in report["evaluations"]:
                metrics = item.get("metrics", {})
                if (
                    metrics.get("tracking", {}).get("status") != "measured"
                    or metrics.get("surface_classification", {}).get("status")
                    != "measured"
                ):
                    report["status"] = "incomplete"
                    report["reasons"].append(
                        "Independent tracking and surface classification evaluation is required for complete validation"
                    )
                    break
    except Exception as error:
        report["reasons"].append(
            f"Evaluation could not complete: {type(error).__name__}: {error}"
        )
        report["status"] = (
            "failed"
            if any(
                item.get("status") == "failed"
                for item in report["test_layers"] + report["evaluations"]
            )
            else "incomplete"
        )
    write_report(report, output)
    print(f'Evaluation {report["status"]}: {output / "report.md"}')
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
