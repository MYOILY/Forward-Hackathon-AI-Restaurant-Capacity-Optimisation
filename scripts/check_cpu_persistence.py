"""Verify saved synthetic integration sources after restarting the CPU service."""

from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import platform
import subprocess
import sys
import time
import urllib.error
import urllib.request

import onnxruntime
from cpu_check_client import check_base_url


def main(output_path, *integration_reports):
    base = check_base_url()
    deadline = time.monotonic() + 30
    while True:
        try:
            with urllib.request.urlopen(base + "/api/health", timeout=5) as response:
                health = json.load(response)
            break
        except urllib.error.URLError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)
    assert health["active"] is None
    assert health["models"]["surface"]["available"]
    with urllib.request.urlopen(base + "/", timeout=10) as response:
        assert (
            response.status == 200 and "text/html" in response.headers["Content-Type"]
        )
        assert b'<div id="root"' in response.read()
    # Both HTTP and WebSockets use the same exact-origin predicate.
    rejected = urllib.request.Request(
        base + "/api/health", headers={"Origin": "https://unlisted.invalid"}
    )
    try:
        urllib.request.urlopen(rejected, timeout=5)
    except urllib.error.HTTPError as error:
        assert error.code == 403
    else:
        raise AssertionError("Unexpected origin accepted")
    sources = []
    for report_path in integration_reports:
        previous = json.loads(Path(report_path).read_text())
        with urllib.request.urlopen(
            base + "/api/sources/" + previous["source_id"], timeout=10
        ) as response:
            saved = json.load(response)
        baseline = saved["tables"][0]["object_baseline"]
        assert (
            baseline["approved"]
            and baseline["baseline_sha256"] == previous["baseline_sha256"]
        )
        if saved["kind"] == "video":
            assert saved["status"] == "completed"
            with urllib.request.urlopen(
                base + saved["manifest_url"], timeout=10
            ) as response:
                bundle = json.load(response)
            assert len(bundle["assessments"]) >= 4
        sources.append(
            {
                "source_id": saved["id"],
                "kind": saved["kind"],
                "status": saved["status"],
                "baseline_sha256": baseline["baseline_sha256"],
            }
        )
    assert importlib.util.find_spec("mlx") is None
    assert importlib.util.find_spec("transformers") is None
    providers = onnxruntime.get_available_providers()
    assert (
        "CPUExecutionProvider" in providers and "CUDAExecutionProvider" not in providers
    )
    report = {
        "status": "passed",
        "evidence_kind": "synthetic_service_restart_integration",
        "checks": [
            "Frontend and API from one origin",
            "Unlisted origin rejected",
            "Healthy after restart",
            "Saved approved baselines survive restart",
            "Completed video manifest survives restart",
            "No MLX or Transformers; CPU provider available in check runtime",
        ],
        "sources": sources,
        "python": platform.python_version(),
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "onnxruntime": onnxruntime.__version__,
        "check_runtime": {"system": platform.system(), "machine": platform.machine()},
        "available_execution_providers": providers,
    }
    Path(output_path).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main(*sys.argv[1:])
