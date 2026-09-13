"""Common measured failure intervals and source evidence attachments."""

from __future__ import annotations


def _with_observation_evidence(failures: list[dict], bundle: dict) -> list[dict]:
    for failure in failures:
        failure["responsible_subsystem"] = "end_to_end_state_comparison"
        failure["diagnosis"] = (
            "Unisolated mismatch; inspect detector, association and production reducer evidence before assigning root cause."
        )
        relevant = [
            item
            for item in bundle["observations"]
            if item["t"] <= failure["start"] + 1e-8
        ]
        last = relevant[-1] if relevant else None
        failure["observation"] = (
            {
                "t": last["t"],
                "frame_index": last["frame_index"],
                "valid": last["valid"],
                "presence": last["tables"][failure["table_id"]],
                "error": last.get("error"),
            }
            if last
            else None
        )
    return failures


def _merge_failures(items: list[dict]) -> list[dict]:
    merged = []
    for item in sorted(items, key=lambda item: (item["table_id"], item["start"])):
        if (
            merged
            and all(
                merged[-1][key] == item[key]
                for key in ("table_id", "expected", "actual")
            )
            and abs(merged[-1]["end"] - item["start"]) < 1e-6
        ):
            merged[-1]["end"] = item["end"]
        else:
            merged.append(dict(item))
    return merged
