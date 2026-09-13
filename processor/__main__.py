"""Command-line entry point for current CPU video processing."""

from __future__ import annotations

import argparse
import json
import sys


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Prepare or analyze restaurant recordings with verified YOLOX CPU models"
    )
    commands = result.add_subparsers(dest="command", required=True)
    download = commands.add_parser(
        "download-model", help="Download and verify an official model asset"
    )
    download.add_argument("--model", choices=("nano", "tiny", "s"), default="tiny")
    download.add_argument("--model-dir", default="models")
    refresh = commands.add_parser(
        "refresh-references",
        help="Refresh reviewed geometry hashes and perspective reference images",
    )
    for flag in ("video", "layout", "out"):
        refresh.add_argument(f"--{flag}", required=True)
    for command in ("prepare", "analyze"):
        item = commands.add_parser(command)
        item.add_argument("--video", required=True, help="Source video file")
        item.add_argument("--out", required=True, help="Output bundle directory")
        item.add_argument("--model", choices=("nano", "tiny", "s"), default="tiny")
        item.add_argument("--model-dir", default="models")
        item.add_argument(
            "--confidence",
            type=float,
            default=None,
            help="Default .3 for preparation; tracking requires .1",
        )
        item.add_argument("--nms-threshold", type=float, default=0.45)
        item.add_argument("--intra-threads", type=int, default=4)
        item.add_argument(
            "--provenance",
            choices=("real_video", "synthetic_fixture", "ai_generated_video"),
            default=None,
            help="Source evidence provenance; defaults to real_video or preserved layout provenance",
        )
        if command == "prepare":
            item.add_argument(
                "--reference-time",
                type=float,
                default=0.0,
                help="First source frame at or after these media seconds",
            )
            item.add_argument(
                "--confirmed-clean",
                action="store_true",
                help="Explicit operator reference approval; never bypasses actual tabletop checks",
            )
        else:
            item.add_argument(
                "--layout", required=True, help="Manually reviewed layout.json"
            )
            item.add_argument("--sample-hz", type=float, default=10.0)
            item.add_argument(
                "--accept-proposals",
                action="store_true",
                help="Diagnostic acceptance of unreviewed geometry; output records it as unvalidated",
            )
            item.add_argument(
                "--entry-seconds",
                type=float,
                default=None,
                help="Same-person dwell override, 5..10 source seconds",
            )
            item.add_argument(
                "--skip-surface",
                action="store_true",
                help="Detection-only diagnostic; marks surface analysis incomplete",
            )
    return result


def main(argv=None) -> int:
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "download-model":
            from .models import download_model

            output = download_model(arguments.model, arguments.model_dir)
        elif arguments.command == "refresh-references":
            from .pipeline import refresh_layout

            output = refresh_layout(arguments)
        else:
            from .pipeline import analyze, prepare

            output = (
                prepare(arguments)
                if arguments.command == "prepare"
                else analyze(arguments)
            )
        print(json.dumps(output, indent=2, allow_nan=False))
        if arguments.command == "analyze" and output["valid_samples"] == 0:
            print(
                "All sampled inferences failed; bundle contains uncertain observations only.",
                file=sys.stderr,
            )
            return 2
        return 0
    except (ValueError, FileNotFoundError, OSError) as exc:
        print(f"processor: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
