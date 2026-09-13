"""Approval, canonical identities and geometry/reference invalidation."""

from copy import deepcopy
import hashlib
import json

import pytest

from processor.object_baseline import (
    CONFIG,
    CONFIG_SHA256,
    build_baseline,
    validate_baseline,
)
from processor.models import MODEL_HASHES


def baseline(expected=None, **overrides):
    args = {
        "expected": [] if expected is None else expected,
        "reference_sha256": "a" * 64,
        "geometry_sha256": "b" * 64,
        "detector_sha256": MODEL_HASHES["tiny"],
        **overrides,
    }
    return build_baseline(**args)


def test_config_identity_is_canonical_and_shared():
    assert (
        CONFIG_SHA256
        == hashlib.sha256(
            json.dumps(CONFIG, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    assert (
        CONFIG_SHA256
        == "3f71969710f1a0598b736500d5201d902a1e6dffab3fe1f4ba35a2cd872caa60"
    )


def test_inventory_order_does_not_change_identity_but_counts_do():
    a = baseline([{"class_id": 41, "count": 2}, {"class_id": 39, "count": 1}])
    b = baseline([{"class_id": 39, "count": 1}, {"class_id": 41, "count": 2}])
    assert a == b
    assert (
        a["baseline_sha256"]
        != baseline([{"class_id": 39, "count": 2}, {"class_id": 41, "count": 2}])[
            "baseline_sha256"
        ]
    )


@pytest.mark.parametrize(
    "expected",
    [
        [{"class_id": 0, "count": 1}],
        [{"class_id": 56, "count": 1}],
        [{"class_id": 60, "count": 1}],
        [{"class_id": 80, "count": 1}],
        [{"class_id": 41, "count": -1}],
        [{"class_id": 41, "count": True}],
        [{"class_id": 41, "count": 2.5}],
        [{"class_id": 41, "count": 1}, {"class_id": 41, "count": 2}],
        {},
    ],
)
def test_invalid_inventories_cannot_be_approved(expected):
    with pytest.raises(ValueError):
        baseline(expected)


def test_empty_approved_baseline_valid_and_unapproved_never_eligible():
    validate_baseline(baseline(), require_approved=True)
    pending = baseline(approved=False)
    validate_baseline(pending)
    with pytest.raises(ValueError, match="approved"):
        validate_baseline(pending, require_approved=True)


def test_label_and_map_are_not_baseline_inputs_but_reference_geometry_are():
    b = baseline()
    table = {
        "reference": {"sha256": "a" * 64},
        "geometry_sha256": "b" * 64,
        "label": "Renamed",
        "map": {"x": 0.9},
    }
    validate_baseline(b, table, require_approved=True)
    for key in ("reference", "geometry_sha256"):
        changed = deepcopy(table)
        changed[key] = {"sha256": "c" * 64} if key == "reference" else "c" * 64
        with pytest.raises(ValueError, match="differs"):
            validate_baseline(b, changed)


def test_tampered_hash_and_changed_detector_cannot_establish_readiness():
    changed = baseline()
    changed["expected"] = [{"class_id": 41, "count": 1}]
    with pytest.raises(ValueError, match="hash mismatch"):
        validate_baseline(changed)
    with pytest.raises(ValueError, match="detector"):
        validate_baseline(baseline(detector_sha256="c" * 64), require_approved=True)
