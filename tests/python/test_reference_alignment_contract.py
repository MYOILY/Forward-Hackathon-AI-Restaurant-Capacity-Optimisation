"""Optional registration diagnostics must not bypass evidence validation."""

from copy import deepcopy
import pytest
from processor.io import _validate_object_evidence


def evidence():
    return {
        "detections": [],
        "reference": {
            "observable": True,
            "brightness_offset": 0,
            "changed_fraction": 0.02,
            "largest_change_fraction": 0.01,
            "edge_mismatch": 0.1,
        },
    }


def test_saved_measurements_without_alignment_remain_compatible():
    _validate_object_evidence(evidence())


@pytest.mark.parametrize(
    "applied,dx,correlation", [(True, 8.1, 0.95), (False, 0, None), (False, 0, -0.1)]
)
def test_registration_diagnostics_accept_trusted_or_explicitly_unused_results(
    applied, dx, correlation
):
    value = evidence()
    value["reference"]["alignment"] = {
        "method": "translation_ecc_v1",
        "applied": applied,
        "dx": dx,
        "dy": 0,
        "correlation": correlation,
    }
    _validate_object_evidence(value)


@pytest.mark.parametrize(
    "change",
    [
        {"method": "affine"},
        {"applied": 1},
        {"dx": float("nan")},
        {"dy": "0"},
        {"correlation": 1.1},
        {"correlation": None},
        {"correlation": 0.5},
        {"applied": False},
    ],
)
def test_malformed_or_untrusted_registration_is_rejected(change):
    value = evidence()
    alignment = {
        "method": "translation_ecc_v1",
        "applied": True,
        "dx": 8.1,
        "dy": 0,
        "correlation": 0.95,
    }
    alignment.update(deepcopy(change))
    value["reference"]["alignment"] = alignment
    with pytest.raises(ValueError, match="alignment"):
        _validate_object_evidence(value)
