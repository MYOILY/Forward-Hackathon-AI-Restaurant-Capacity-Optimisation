from copy import deepcopy

import pytest

from processor.io import load_json, resolve_media, validate_bundle


def test_valid_bundle(bundle):
    validate_bundle(bundle)


def test_ai_generated_provenance_is_preserved_not_promoted_to_real(bundle):
    bundle["provenance"] = "ai_generated_video"
    validate_bundle(bundle)
    assert bundle["provenance"] == "ai_generated_video"


@pytest.mark.parametrize(
    "mutation",
    [
        lambda b: b.update(schema_version=1),
        lambda b: b["video"].update(file="../outside.mp4"),
        lambda b: b["video"].update(sha256="wrong"),
        lambda b: b["observations"].append(deepcopy(b["observations"][-1])),
        lambda b: b["observations"][0]["tables"].update(T99="present"),
        lambda b: b["observations"][0].update(valid=False),
        lambda b: b["tables"][0].update(crop=[0, 0, 2, 1]),
        lambda b: b["observations"][0].update(t=float("nan")),
    ],
)
def test_malformed_bundle_rejected(bundle, mutation):
    mutation(bundle)
    with pytest.raises(ValueError):
        validate_bundle(bundle)


def test_json_duplicate_keys_rejected(tmp_path):
    filename = tmp_path / "bad.json"
    filename.write_text('{"schema_version":1,"schema_version":2}')
    with pytest.raises(ValueError):
        load_json(filename)


def test_media_symlink_cannot_escape_bundle(tmp_path):
    root = tmp_path / "bundle"
    root.mkdir()
    target = tmp_path / "outside.mp4"
    target.write_bytes(b"outside")
    (root / "video.mp4").symlink_to(target)
    with pytest.raises(ValueError):
        resolve_media(root, "video.mp4")


def test_unsupported_saved_surface_evidence_is_rejected_without_mutation(bundle):
    original = deepcopy(bundle)
    bundle["assessment_requests"] = [{"id": "old-scalar-request"}]
    bundle["assessments"] = [{"id": "old-scalar-result", "outcome": "cleared_reset"}]
    before = deepcopy(bundle)
    with pytest.raises(ValueError, match="Reprocess"):
        validate_bundle(bundle)
    assert bundle == before
    assert bundle["tables"] == original["tables"]
