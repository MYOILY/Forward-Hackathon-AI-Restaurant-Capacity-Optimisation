"""Exercise the actual live TypeScript JSONL entry point without Python state logic."""

import json
import subprocess
from pathlib import Path


def test_actual_live_jsonl_preserves_capture_dwell_and_tick_expiry(bundle):
    config = {
        "protocol_version": 1,
        "session_id": "stdio-live",
        "epoch": 2,
        "calibration_id": "reviewed-calibration",
        "width": 640,
        "height": 360,
        "sample_hz": 10,
        "tables": bundle["tables"],
        "rules": bundle["rules"],
        "detection_only": True,
        "evidence_max_age_s": 5,
    }
    commands = [{"op": "init", "config": config}]
    for index in range(51):
        t = index / 10
        observation = {
            "session_id": "stdio-live",
            "epoch": 2,
            "calibration_id": "reviewed-calibration",
            "frame_sha256": f"{index:064x}",
            "t": t,
            "frame_index": index,
            "valid": True,
            "detections": [],
            "tables": {"T1": "present"},
            "tracks": [
                {
                    "track_id": "anonymous-1",
                    "box": [0.2, 0.1, 0.5, 0.8],
                    "score": 0.9,
                    "observed": True,
                    "table_id": "T1",
                    "candidate_table_ids": ["T1"],
                }
            ],
            "surface": {"T1": {"visible": True, "changed": False}},
        }
        commands.append(
            {"op": "observation", "observation": observation, "now": t + 0.2}
        )
    commands += [{"op": "tick", "t": 6.1}, {"op": "stop", "t": 6.2}]
    result = subprocess.run(
        ["node", "--import", "tsx", "web/src/live-headless.ts"],
        cwd=Path(__file__).resolve().parents[2],
        input="\n".join(json.dumps(row) for row in commands) + "\n",
        text=True,
        capture_output=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(replies) == len(commands)
    assert all("error" not in row for row in replies), replies
    assert replies[50]["snapshot"]["tables"]["T1"]["people_state"] == "pending_arrival"
    assert replies[51]["snapshot"]["tables"]["T1"]["people_state"] == "occupied"
    assert replies[52]["snapshot"]["tables"]["T1"]["people_state"] == "uncertain"
    assert replies[-1]["snapshot"]["stopped"] is True and all(
        row["requests"] == [] for row in replies
    )
