"""Software simulation must never silently become physical-camera/model evidence."""

from evaluator.input_live import summarize_validation


def layers():
    return [
        {"name": name, "status": "passed", "passed": 1, "failed": 0}
        for name in ["python", "typescript", "browser"]
    ]


def test_detection_only_software_success_keeps_unchecked_hardware_explicit():
    report = summarize_validation(layers(), [], detection_only=True)
    assert report["software_status"] == "passed" and report["software_passed"] == 3
    assert (
        report["hardware_status"] == "incomplete" and report["status"] == "incomplete"
    )
    assert {row["name"] for row in report["hardware_checks"]} == {
        "laptop_camera",
        "usb_camera",
        "surface_model",
    }
    assert all(row["status"] == "not_run" for row in report["hardware_checks"])
    assert report["hardware_checks"][-1]["required_for_selected_mode"] is False


def test_fake_camera_or_mock_surface_result_cannot_certify_actual_hardware():
    hardware = [
        {"name": "laptop_camera", "status": "passed", "evidence_kind": "fake_camera"},
        {"name": "usb_camera", "status": "passed", "evidence_kind": "fake_camera"},
        {"name": "surface_model", "status": "passed", "evidence_kind": "mock_model"},
    ]
    report = summarize_validation(layers(), hardware, detection_only=False)
    assert report["status"] == "incomplete"
    assert all(row["status"] == "not_run" for row in report["hardware_checks"])


def test_missing_or_failed_software_layer_never_becomes_a_complete_software_pass():
    report = summarize_validation(layers()[:-1], [], detection_only=True)
    assert report["software_status"] == "incomplete"
    rows = layers()
    rows[0].update(status="failed", failed=1)
    assert (
        summarize_validation(rows, [], detection_only=True)["software_status"]
        == "failed"
    )
