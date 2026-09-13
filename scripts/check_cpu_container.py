"""Run inside the container against an isolated data volume, using an AI/synthetic image.

Exercises actual HTTP, worker inference, shared Node rules and WebSocket cleanup.
This is integration evidence, never physical-camera or restaurant-quality evidence.
"""

from __future__ import annotations
import base64
import importlib.util
import json
from pathlib import Path
import sys
import time
import urllib.request
import urllib.error
from websockets.sync.client import connect
from cpu_check_client import check_base_url, websocket_base_url


def main(image_path, output_path):
    base = check_base_url()

    def request(method, path, data=None):
        raw = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(
            base + path,
            data=raw,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)

    assert importlib.util.find_spec("mlx") is None
    assert importlib.util.find_spec("transformers") is None
    startup_deadline = time.monotonic() + 30
    while True:
        try:
            health = request("GET", "/api/health")
            break
        except urllib.error.URLError:
            if time.monotonic() >= startup_deadline:
                raise
            time.sleep(0.2)
    assert health["models"]["surface"]["available"]
    encoded = base64.b64encode(Path(image_path).read_bytes()).decode()
    source = request(
        "POST",
        "/api/cameras",
        {
            "device_key": "synthetic-container-check",
            "label": "Synthetic CPU validation",
            "image_base64": encoded,
        },
    )
    deadline = time.monotonic() + 45
    while source["status"] == "preparing" and time.monotonic() < deadline:
        time.sleep(0.1)
        source = request("GET", "/api/sources/" + source["id"])
    assert source["status"] == "needs_setup", source
    polygon = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]
    table = {
        "id": "CPU-T1",
        "label": "Synthetic validation table",
        "video_region": [0.0, 0.0, 1.0, 1.0],
        "crop": [0.0, 0.0, 1.0, 1.0],
        "tabletop_polygon": polygon,
        "occupancy_regions": [polygon],
        "map": {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5, "shape": "rect"},
        "reference": None,
        "setup_review": {"tabletop": True, "occupancy": True, "map": True},
    }
    path = "/api/sources/" + source["id"]
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
    # Explicit test approval for this synthetic source; never real operator evidence.
    baseline = proposal["baseline"]
    baseline["approved"] = True
    table.update(object_baseline=baseline, reference_approved=True, reference_t=0)
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
    assert saved["tables"][0]["object_baseline"]["approved"] is True
    session = request(
        "POST", "/api/live", {"source_id": source["id"], "detection_only": False}
    )
    ready = False
    assessments = []
    last = None
    with connect(
        websocket_base_url(base) + session["ws_url"],
        open_timeout=15,
        max_size=16 * 1024 * 1024,
    ) as socket:
        socket.send(json.dumps({"type": "sync", "client_t": 0}))
        while True:
            message = json.loads(socket.recv(timeout=15))
            if message.get("type") == "clock":
                break
        source_origin = message["t"]
        clock_origin = time.monotonic()
        for seq in range(95):
            due = clock_origin + seq * 0.1
            if time.monotonic() < due:
                time.sleep(due - time.monotonic())
            captured = source_origin + time.monotonic() - clock_origin
            socket.send(
                json.dumps(
                    {
                        "type": "frame",
                        "session_id": session["session_id"],
                        "epoch": session["epoch"],
                        "seq": seq,
                        "captured_t": captured,
                        "image_base64": encoded,
                    }
                )
            )
            while True:
                message = json.loads(socket.recv(timeout=15))
                assert message.get("type") != "error", message
                if message.get("type") == "update":
                    last = message
                    state = message["snapshot"]["tables"]["CPU-T1"]
                    ready = ready or state["status"] == "ready"
                    if state.get("last_assessment"):
                        assessment = state["last_assessment"]
                        if not assessments or assessments[-1]["id"] != assessment["id"]:
                            assessments.append(assessment)
                    if message.get("frame", {}).get("seq") == seq:
                        break
        socket.send(json.dumps({"type": "stop"}))
        while json.loads(socket.recv(timeout=10)).get("type") != "stopped":
            pass
    assert ready, {"reason": "No automatic Ready after real CPU checks", "last": last}
    assert len(assessments) >= 2 and all(
        row.get("object_evidence") for row in assessments
    )
    assert all(
        row.get("crop_base64", "").startswith("data:image/png;base64,")
        for row in assessments
    )
    assert request("GET", "/api/health")["active"] is None
    reopened = request("GET", path)
    assert (
        reopened["tables"][0]["object_baseline"]
        == saved["tables"][0]["object_baseline"]
    )
    report = {
        "status": "passed",
        "evidence_kind": "synthetic_api_integration",
        "physical_camera_test": False,
        "restaurant_accuracy": None,
        "source_id": source["id"],
        "baseline_sha256": saved["tables"][0]["object_baseline"]["baseline_sha256"],
        "checks": [
            "No MLX/Transformers",
            "HTTP setup proposal remains unapproved",
            "Explicit baseline save",
            "Real CPU detection and reference comparison",
            "WebSocket frames and TypeScript automatic Ready",
            "Stop releases compute slot",
            "Saved baseline reopens",
        ],
        "assessment_captures": [row["t"] for row in assessments],
        "last_stats": last["stats"],
    }
    Path(output_path).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main(*sys.argv[1:])
