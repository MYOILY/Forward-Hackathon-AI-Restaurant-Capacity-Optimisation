"""Invoke the production TypeScript reducer, never a Python implementation."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def run_replay(bundle: dict, times: list[float], staff_events: list[dict]) -> dict:
    bundled = {event["id"]: event for event in bundle["staff_events"]}
    additional = []
    for event in staff_events:
        if event["id"] in bundled:
            if event != bundled[event["id"]]:
                raise ValueError("Ground-truth and bundle staff events conflict")
        else:
            additional.append(event)
    with tempfile.TemporaryDirectory(prefix="occupancy-replay-") as temp:
        source = Path(temp) / "input.json"
        destination = Path(temp) / "output.json"
        source.write_text(
            json.dumps({"bundle": bundle, "times": times, "staff_events": additional})
        )
        npm = os.environ.get("EVALUATOR_NPM", "npm")
        completed = subprocess.run(
            [
                npm,
                "run",
                "replay",
                "--",
                "--input",
                str(source),
                "--output",
                str(destination),
            ],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=240,
        )
        if completed.returncode:
            raise RuntimeError(
                f"Production replay failed: {completed.stderr[-4000:]} {completed.stdout[-1000:]}"
            )
        result = json.loads(destination.read_text())
        if len(result.get("snapshots", [])) != len(times):
            raise ValueError("Production replay returned an incomplete snapshot set")
        return result
