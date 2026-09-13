#!/usr/bin/env python3
"""Inside-container upload integration with an explicitly synthetic static fixture.

The uploaded asset and test-only baseline are not real restaurant accuracy evidence.
Use scripts/make_cpu_fixture.py to prepare the supplied 20-second test input.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid
from cpu_check_client import check_base_url


def main(video_path, output_path):
    base = check_base_url()
    started = time.monotonic()

    def request(method, path, data=None, *, content_type="application/json"):
        raw = (
            data
            if isinstance(data, bytes)
            else None if data is None else json.dumps(data).encode()
        )
        req = urllib.request.Request(
            base + path, data=raw, method=method, headers={"Content-Type": content_type}
        )
        try:
            with urllib.request.urlopen(req, timeout=45) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(
                f"{method} {path} returned {error.code}: {error.read().decode()}"
            ) from error

    def wait_source(source, expected, timeout=90):
        deadline = time.monotonic() + timeout
        while source["status"] in ("uploading", "preparing", "analyzing"):
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Job did not finish: {source}")
            time.sleep(0.2)
            source = request("GET", "/api/sources/" + source["id"])
        assert source["status"] == expected, source
        return source

    assert importlib.util.find_spec("mlx") is None
    assert importlib.util.find_spec("transformers") is None
    health = request("GET", "/api/health")
    assert (
        health["active"] is None
    ), "Another container job is active; run after it completes"
    assert (
        health["models"]["detector"]["available"]
        and health["models"]["surface"]["available"]
    )
    video = Path(video_path).read_bytes()
    boundary = "fixture-upload-" + uuid.uuid4().hex
    body = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic-cpu-upload-validation.mp4"\r\n'
            "Content-Type: video/mp4\r\n\r\n"
        ).encode()
        + video
        + f"\r\n--{boundary}--\r\n".encode()
    )
    source = request(
        "POST",
        "/api/videos",
        body,
        content_type="multipart/form-data; boundary=" + boundary,
    )
    source = wait_source(source, "needs_setup")
    assert source["kind"] == "video" and source["calibration_confirmed"] is False
    path = "/api/sources/" + source["id"]
    polygon = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
    table = {
        "id": "T1",
        "label": "Synthetic upload test only",
        "video_region": [0.0, 0.0, 1.0, 1.0],
        "crop": [0.0, 0.0, 1.0, 1.0],
        "tabletop_polygon": polygon,
        "occupancy_regions": [polygon],
        "map": {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5, "shape": "rect"},
        "reference": None,
        "setup_review": {"tabletop": True, "occupancy": True, "map": True},
    }
    proposal = request(
        "POST",
        path + "/baseline-proposal",
        {
            "revision": source["revision"],
            "table_id": table["id"],
            "tabletop_polygon": polygon,
            "occupancy_regions": [polygon],
            "reference_t": 0,
        },
    )
    assert proposal["baseline"]["approved"] is False
    # A test-only assertion about a synthetic fixture; never an actual restaurant approval.
    table.update(
        object_baseline={**proposal["baseline"], "approved": True},
        reference_approved=True,
        reference_t=proposal["reference_t"],
    )
    saved = request(
        "PUT",
        path + "/calibration",
        {
            "revision": source["revision"],
            "tables": [table],
            "confirmed": True,
            "floor_plan_mode": "schematic",
            "setup_mode": "guided_v1",
        },
    )
    baseline = saved["tables"][0]["object_baseline"]
    assert (
        baseline["approved"]
        and saved["tables"][0]["surface_method"] == "objects_reference_v1"
    )
    analysis_started = time.monotonic()
    analyzing = request("POST", path + "/analyze", {"detection_only": False})
    completed = wait_source(analyzing, "completed")
    analysis_wall = time.monotonic() - analysis_started
    bundle = request("GET", completed["manifest_url"])
    assert (
        bundle["tables"][0]["object_baseline"]["baseline_sha256"]
        == baseline["baseline_sha256"]
    )
    assessments = bundle["assessments"]
    # Independent expectation: the early clean check cannot establish Ready;
    # two qualifying captures at 5 and 7 seconds precede two-second renewals.
    # Recovery from a cleaning alert has a separate rule.
    assert [row["t"] for row in assessments] == [
        1,
        5,
        7,
        9,
        11,
        13,
        15,
        17,
        19,
    ], assessments
    for row in assessments:
        assert row["valid"] and row["outcome"] == "cleared_reset", row
        assert row["surface_method"] == "objects_reference_v1" and row.get(
            "object_evidence"
        ), row
        assert row["baseline_sha256"] == baseline["baseline_sha256"]
        assert row["config_sha256"] == baseline["config_sha256"]
        assert row["reason"] != "Awaiting shared comparison"
    transitions = [
        (row["t"], row["status"])
        for row in bundle["replay_events"]
        if row["kind"] == "transition"
    ]
    assert transitions == [(7, "ready")], transitions
    assert all(
        row["tables"]["T1"]["status"] == "ready"
        for row in bundle["snapshots"]
        if row["t"] >= 7
    )
    assert bundle["analysis"]["surface_pipeline_completed"] is True
    assert bundle["analysis"]["surface_model"]["provider"] == "CPUExecutionProvider"
    assert request("GET", "/api/health")["active"] is None
    assert request("GET", path)["manifest_url"] == completed["manifest_url"]
    report = {
        "status": "passed",
        "evidence_kind": "synthetic_http_upload_integration",
        "restaurant_accuracy": None,
        "source_description": "20-second static clip constructed from the included AI-generated tabletop test fixture",
        "source_id": source["id"],
        "manifest_url": completed["manifest_url"],
        "source_video_sha256": bundle["video"]["sha256"],
        "api_recorded_provenance": bundle["provenance"],
        "provenance_note": "The upload API defaults file metadata to real_video; this supplied test clip is explicitly synthetic and does not validate restaurant accuracy.",
        "baseline_sha256": baseline["baseline_sha256"],
        "assessment_captures": [row["t"] for row in assessments],
        "ready_transitions": transitions,
        "analysis_http_wall_s": analysis_wall,
        "total_http_wall_s": time.monotonic() - started,
        "observations": len(bundle["observations"]),
        "valid_observations": sum(row["valid"] for row in bundle["observations"]),
        "checks": [
            "No MLX/Transformers",
            "Actual multipart HTTP upload and video preparation",
            "Proposal remains unapproved",
            "Explicit test-only baseline approval through calibration API",
            "Full CPU analysis through HTTP",
            "Manifest fetch with shared TypeScript normalized assessments",
            "Initial Ready at 7 seconds, renewals every 2 seconds and no flicker",
            "Compute slot released and result remains accessible",
        ],
    }
    Path(output_path).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main(*sys.argv[1:])
