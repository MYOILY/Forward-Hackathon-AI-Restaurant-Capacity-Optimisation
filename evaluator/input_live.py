"""Mode-aware input/live validation reporting; does not execute service-state rules."""

from copy import deepcopy


def summarize_validation(software_layers, hardware_checks, *, detection_only):
    layers = deepcopy(software_layers)
    required = {"python", "typescript", "browser"}
    seen = {row["name"] for row in layers}
    failed = any(
        row.get("status") == "failed" or row.get("failed", 0) > 0 for row in layers
    )
    complete = required.issubset(seen) and all(
        row.get("status") == "passed" and row.get("passed", 0) > 0 for row in layers
    )
    software_status = "failed" if failed else "passed" if complete else "incomplete"
    supplied = {row["name"]: row for row in hardware_checks}
    hardware = []
    for name, kind in [
        ("laptop_camera", "actual_webcam"),
        ("usb_camera", "actual_webcam"),
        ("surface_model", "actual_local_model"),
    ]:
        row = deepcopy(
            supplied.get(
                name,
                {
                    "name": name,
                    "status": "not_run",
                    "reason": "No actual hardware/model evidence supplied",
                },
            )
        )
        row["required_for_selected_mode"] = (
            name != "surface_model" or not detection_only
        )
        if row.get("status") == "passed" and row.get("evidence_kind") != kind:
            row.update(
                status="not_run", reason=f"Simulated evidence cannot certify {kind}"
            )
        hardware.append(row)
    required_hardware = [row for row in hardware if row["required_for_selected_mode"]]
    hardware_failed = any(row["status"] == "failed" for row in required_hardware)
    hardware_status = (
        "failed"
        if hardware_failed
        else (
            "passed"
            if all(row["status"] == "passed" for row in required_hardware)
            else "incomplete"
        )
    )
    status = (
        "failed"
        if "failed" in (software_status, hardware_status)
        else (
            "passed" if software_status == hardware_status == "passed" else "incomplete"
        )
    )
    return {
        "status": status,
        "mode": "detection_only" if detection_only else "full_surface_analysis",
        "software_status": software_status,
        "software_passed": sum(row.get("passed", 0) for row in layers),
        "software_layers": layers,
        "hardware_status": hardware_status,
        "hardware_checks": hardware,
        "evidence_policy": "Fake camera and mocked model results establish software behavior only. This report does not replace independently labelled real/held-out restaurant validation.",
    }
