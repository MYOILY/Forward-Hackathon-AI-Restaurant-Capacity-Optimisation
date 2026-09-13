from __future__ import annotations

import json
from pathlib import Path


def capture_failure_evidence(video: Path, failures: list[dict], output: Path) -> None:
    import cv2

    output.mkdir(parents=True, exist_ok=True)
    capture = cv2.VideoCapture(str(video))
    try:
        for index, failure in enumerate(failures):
            capture.set(cv2.CAP_PROP_POS_MSEC, failure["start"] * 1000)
            ok, frame = capture.read()
            if not ok:
                failure["evidence_error"] = "Source frame could not be decoded"
                continue
            caption = f'{failure["table_id"]} {failure["start"]:.2f}s expected={failure["expected"]} actual={failure["actual"]}'
            cv2.rectangle(frame, (0, 0), (frame.shape[1], 38), (25, 25, 25), -1)
            cv2.putText(
                frame,
                caption,
                (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (255, 255, 255),
                1,
                cv2.LINE_AA,
            )
            filename = (
                output / f'{index:04d}-{failure["table_id"]}-{failure["start"]:.2f}.jpg'
            )
            if cv2.imwrite(str(filename), frame):
                failure["evidence_image"] = str(filename)
    finally:
        capture.release()


def write_report(report: dict, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    (output / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    lines = [
        "# Restaurant occupancy evaluator",
        "",
        f'**Overall: {report["status"].upper()}**',
        "",
        f'Provenance: {report.get("provenance", "unavailable")}. Runtime is report-only; correctness gates are enforced.',
        "",
    ]
    for reason in report.get("reasons", []):
        lines.append(f"- {reason}")
    held_out = report.get("held_out_recording_validation")
    if held_out:
        lines += [
            "",
            f'Second recording validation: **{held_out["status"]}**. {held_out.get("reason", "Distinct source and independent annotations are required for complete validation.")}',
        ]
    lines += ["", "## Test layers", "", "| Layer | Result | Details |", "|---|---|---|"]
    for layer in report.get("test_layers", []):
        detail = layer.get("reason") or (
            f'[log](<{layer["log"]}>)' if layer.get("log") else ""
        )
        lines.append(f'| {layer["name"]} | {layer["status"]} | {detail} |')
    playback = [
        timing
        for layer in report.get("test_layers", [])
        for timing in layer.get("playback_timings", [])
    ]
    if playback:
        lines += [
            "",
            "### Browser playback timing",
            "",
            "This measures prerecorded playback, including test-control overhead. It is separate from detector speed.",
            "",
            "| Playback rate | Video advanced (s) | Wall elapsed (s) |",
            "|---:|---:|---:|",
        ]
        for timing in playback:
            lines.append(
                f'| {timing["playback_rate"]}× | {timing["video_advance_s"]:.3f} | {timing["wall_elapsed_s"]:.3f} |'
            )
    percentage = lambda value: f"{value:.1%}" if value is not None else "not run"
    number = lambda value: f"{value:.3f}" if value is not None else "not run"
    lines += [
        "",
        "## Model comparison",
        "",
        "| Model/trial | State agreement | Coverage | Correctness | Wall seconds | Processing ratio | Sampled peak MiB |",
        "|---|---:|---:|---|---:|---:|---:|",
    ]
    for item in report.get("evaluations", []):
        metrics = item.get("metrics", {})
        runtime = item.get("runtime", {})
        rss = runtime.get("sampled_peak_rss_bytes")
        label = f'{item.get("clip_role", "main")}/{item["model"]}/{item.get("trial", "fixture")}'
        lines.append(
            f'| {label} | {percentage(metrics.get("state_agreement"))} | {percentage(metrics.get("prediction_coverage"))} | {"passed" if metrics.get("passed") else item.get("status", "failed")} | {number(runtime.get("total_elapsed_s"))} | {number(runtime.get("processing_ratio"))} | {number(rss / 1024**2 if rss is not None else None)} |'
        )
    lines += [
        "",
        "### Detector latency",
        "",
        "First 20 sampled frames remain in total runtime and correctness; only steady-state summaries exclude them.",
        "",
        "| Model/trial | Startup (s) | First inference (ms) | Steady median (ms) | Steady p95 (ms) | Analyzed frames/s |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for item in report.get("evaluations", []):
        runtime = item.get("runtime", {})
        telemetry = runtime.get("telemetry", {})
        timing = telemetry.get("timing_s", {})
        latency = telemetry.get("steady_state", {}).get("inference_ms", {})
        first = timing.get("first_inference")
        lines.append(
            f'| {item["model"]}/{item.get("trial", "fixture")} | {number(timing.get("startup"))} | {number(first * 1000 if first is not None else None)} | {number(latency.get("median"))} | {number(latency.get("p95"))} | {number(runtime.get("analyzed_frames_per_second"))} |'
        )
    for item in report.get("evaluations", []):
        metrics = item.get("metrics", {})
        runtime = item.get("runtime", {})
        if not metrics and item.get("status") != "passed":
            reason = item.get(
                "reason",
                runtime.get(
                    "reason",
                    "Inference process did not complete successfully; inspect the process log.",
                ),
            )
            lines += [
                "",
                f'### {item["model"]} trial {item.get("trial", "fixture")}',
                "",
                f'{item.get("status", "incomplete")}: {reason}',
                "",
            ]
            if runtime.get("process_log"):
                lines.append(f'[Process log](<{runtime["process_log"]}>)')
        if metrics:
            if metrics.get("policy") == "automatic_v2":
                lines += [
                    "",
                    f'Parallel state agreement: people {percentage(metrics.get("people_agreement"))}; surface {percentage(metrics.get("surface_agreement"))}.',
                    "",
                    f'False-ready exposure: {metrics["false_ready_table_seconds"]:.3f} table-seconds; stale-generation ready exposure: {metrics["stale_generation_table_seconds"]:.3f} table-seconds.',
                    "",
                    f'Tracking: {metrics.get("tracking",{}).get("status","not_run")}; surface classification: {metrics.get("surface_classification",{}).get("status","not_run")}.',
                    "",
                    f'Surface cleared precision: {percentage(metrics.get("surface_classification",{}).get("cleared_precision"))}; recall: {percentage(metrics.get("surface_classification",{}).get("cleared_recall"))}. Dirty-green exposure: {metrics["green_exposure"].get("dirty_table_seconds",0):.3f} table-seconds.',
                    "",
                ]
            if metrics.get("ready_provenance_table_seconds"):
                lines += [
                    "Ready provenance (table-seconds): "
                    + "; ".join(
                        f"{source}: {seconds:.3f}"
                        for source, seconds in metrics[
                            "ready_provenance_table_seconds"
                        ].items()
                    )
                    + ". Staff override is manual evidence, not automatic model success.",
                    "",
                ]
            if metrics.get("manual_overrides") is not None:
                manual = metrics["manual_overrides"]
                automatic = metrics.get("automatic_replay", {})
                lines += [
                    "Manual display overrides",
                    "",
                    f'Automatic quality replay: **{automatic.get("status","not_run")}**. {automatic.get("method", "Required actual replay was not supplied")}.',
                    "",
                    f'Manually forced colours: {manual["table_seconds"]:.3f} table-seconds; conflicts with automatic state: {manual["conflicts_with_automatic_table_seconds"]:.3f}; forced green while physically occupied: {manual["forced_green_while_occupied_table_seconds"]:.3f}. Displayed-state agreement: {percentage(manual["displayed_state_agreement"])}. These manual colours never count as automatic model success.',
                    "",
                ]
            if metrics.get("monitoring_scope") is not None:
                scope = metrics["monitoring_scope"]
                lines += [
                    f'Excluded table IDs: {", ".join(scope["excluded_table_ids"]) or "none"}; excluded duration: {scope["excluded_table_seconds"]:.3f} table-seconds.',
                    "",
                    f'Monitored coverage: {percentage(scope["monitored_prediction_coverage"])}. Full-layout coverage: {percentage(scope["full_layout_prediction_coverage"])}.',
                    "",
                ]
                if not scope["complete"]:
                    lines += [
                        "Independent scope exclusions are missing or no monitored tables remain; full-layout validation remains incomplete.",
                        "",
                    ]
                elif scope["excluded_table_ids"]:
                    lines += [
                        f'Independent scope declaration: {scope["reason"]}. Reported success applies only to this declared monitored scope.',
                        "",
                    ]
                if scope.get("excluded_recorded_assessment_requests"):
                    lines += [
                        f'Retained historical requests for excluded tables: {len(scope["excluded_recorded_assessment_requests"])}. These are source records, not newly emitted planner requests.',
                        "",
                    ]
            precision = (
                percentage(metrics["occupancy"]["precision"])
                if metrics["occupancy"]["precision"] is not None
                else "undefined (no positive predictions)"
            )
            recall = (
                percentage(metrics["occupancy"]["recall"])
                if metrics["occupancy"]["recall"] is not None
                else "undefined (no labelled occupied time)"
            )
            lines += [
                "",
                f'### {item["model"]} trial {item.get("trial", "fixture")}',
                "",
                f"Occupancy precision: {precision}; recall: {recall}.",
                "",
                f'Unknown on known-reference intervals: {metrics["unknown_table_seconds"]:.3f} table-seconds; total unknown including setup/challenge: {metrics["total_unknown_table_seconds"]:.3f}; challenge intervals: {metrics["challenge_table_seconds"]:.3f} table-seconds.',
                "",
                f'Green during occupation: {metrics["green_exposure"]["occupied_table_seconds"]:.3f} table-seconds; longest episode: {metrics["green_exposure"]["longest_episode_s"]:.3f}s; beyond arrival allowance: {metrics["green_exposure"]["beyond_arrival_allowance_table_seconds"]:.3f} table-seconds.',
                "",
            ]
            lines += [
                f'- {name}: {"passed" if value else "FAILED"}'
                for name, value in metrics["gates"].items()
            ]
            lines += [
                "",
                "| Table | Transition | Expected | Actual | Response delay | Result |",
                "|---|---|---:|---:|---:|---|",
            ]
            for transition in metrics["transitions"]:
                lines.append(
                    f'| {transition["table_id"]} | {transition["status"]} | {transition["expected_t"]:.3f} | {number(transition["actual_t"])} | {number(transition["response_delay_s"])} | {transition["result"]} |'
                )
            for failure in metrics["failures"] + metrics["challenge_failures"]:
                evidence = (
                    f' [frame](<{failure["evidence_image"]}>)'
                    if failure.get("evidence_image")
                    else ""
                )
                lines.append(
                    f'- {failure["table_id"]} {failure["start"]:.2f}–{failure["end"]:.2f}s: expected {failure["expected"]}, actual {failure["actual"]}.{evidence}'
                )
            lines.append("")
        if runtime.get("telemetry"):
            telemetry = runtime["telemetry"]
            if telemetry.get("schema_version") == 2:
                counts = telemetry.get("counts", {})
                lines += [
                    "",
                    f'Assessment requests: {counts.get("assessment_requests", "not run")}; results: {counts.get("assessments", "not run")}; accepted: {counts.get("assessment_accepted", "not run")}; rejected: {counts.get("assessment_rejected", "not run")}; repeat requests: {counts.get("repeat_requests", "not run")}. Repeat requests include required positive confirmations, not only retries.',
                    "",
                ]
                if not telemetry.get("assessment_timings"):
                    lines += [
                        "CPU tabletop assessment latency: **not_run** — no actual assessment timings were recorded. Detector latency does not establish surface-model latency.",
                        "",
                    ]
            if metrics.get("surface_classification"):
                surface = metrics["surface_classification"]
                lines += [
                    f'False reset results: {surface.get("false_reset_results", "not measured")}; false reset exposure: {number(surface.get("false_reset_table_seconds"))} table-seconds.',
                    "",
                ]
            timings = telemetry.get("assessment_timings", [])
            elapsed = telemetry.get("timing_s", {}).get("total")
            duration = telemetry.get("video_duration_s")
            if timings:
                samples = sorted(
                    row["total"]
                    for row in timings
                    if isinstance(row.get("total"), (float, int))
                )
                if samples:
                    import math

                    lines += [
                        f"CPU tabletop latency: median {number(samples[len(samples)//2]*1000)} ms; p95 {number(samples[max(0, math.ceil(.95*len(samples))-1)]*1000)} ms. Assessment checks per camera-hour of source footage: {number(len(timings)*3600/duration if duration else None)}.",
                        "",
                    ]
            lines += ["Runtime breakdown:", "", "| Stage | Seconds |", "|---|---:|"]
            for stage in (
                "decode",
                "preprocess",
                "inference",
                "postprocess",
                "association",
                "tracking",
                "surface_monitor",
                "planner_ipc",
                "surface_startup",
                "surface_inference",
                "reference_compare",
                "assessment_decode",
                "crop_encode",
                "reference_refresh",
                "asset_copy",
                "output_write",
            ):
                lines.append(
                    f'| {stage} | {number(telemetry.get("timing_s", {}).get(stage))} |'
                )
            lines += [
                "",
                f'Model SHA-256: `{telemetry.get("model", {}).get("sha256", "unavailable")}`. Fresh process PID: {runtime.get("process_pid", "unavailable")}. Full telemetry is retained in report.json.',
                "",
            ]
    lines += [
        "",
        "## Reproducibility",
        "",
        "```json",
        json.dumps(report.get("machine", {}), indent=2),
        "```",
        "",
        "Complete confusion matrices, per-trial settings, hashes and failures are available in report.json.",
        "",
    ]
    (output / "report.md").write_text("\n".join(lines))
