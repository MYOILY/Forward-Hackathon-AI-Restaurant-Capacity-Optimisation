"""Stateless boundary tests use actual tracker and camera/surface algorithms."""

import base64
import copy
import hashlib
import json
import threading
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cv2
import numpy as np
import pytest

from processor.frame_checkpoints import dump_checkpoint, restore_checkpoint
from processor.geometry import geometry_hash
from processor.live_vision import VisionSession
from processor.models import MODEL_HASHES
from processor.object_baseline import CONFIG_SHA256, SURFACE_METHOD, build_baseline
from service.stateless import FRAME_CONFIG_SHA256, LIMITS, StatelessProcessor, handle_event
from service.stateless_server import create_server


def table():
    result = {
        "id": "T1", "label": "Table 1",
        "video_region": [0.1, 0.1, 0.9, 0.9], "crop": [0.1, 0.1, 0.9, 0.9],
        "tabletop_polygon": [[0.4, 0.35], [0.8, 0.35], [0.8, 0.75], [0.4, 0.75]],
        "occupancy_regions": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
        "map": {"x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3, "shape": "rect"},
        "reference": None,
    }
    result["geometry_sha256"] = geometry_hash(result)
    return result


class Detector:
    sha256 = MODEL_HASHES["tiny"]
    last_timing = {}

    def __init__(self, mode="people"):
        self.mode = mode

    def detect(self, frame):
        marker = int(frame[0, 0, 0])
        if self.mode == "tables":
            return [{"class_id": 60, "score": 0.95, "box": [0.1, 0.2, 0.8, 0.7]}]
        if self.mode == "surface":
            return [{"class_id": 41, "score": 0.95, "box": [0.2, 0.2, 0.3, 0.3]}]
        if marker == 11:
            raise RuntimeError("Injected transient detector failure")
        if marker % 7 in (4, 5):
            return []
        return [{"class_id": 0, "score": 0.95, "box": [0.1 + (marker % 3) * 0.004, 0.1, 0.25, 0.7]}]


def processor():
    return StatelessProcessor(detector_factory=Detector, availability=lambda: (True, None), build_id="test-build")


def frame(index=0, t=None, image=None):
    if image is None:
        image = np.random.default_rng(42).integers(30, 225, (90, 160, 3), dtype=np.uint8)
        if index >= 18:
            image = np.roll(image, 12, axis=1)
        image[0, 0, 0] = index
    ok, data = cv2.imencode(".png", image)
    assert ok
    raw = data.tobytes()
    return {"sample_index": index, "t": index / 10 if t is None else t, "width": image.shape[1], "height": image.shape[0], "sha256": hashlib.sha256(raw).hexdigest(), "image_base64": base64.b64encode(raw).decode()}


def request(frames=None, *, run_id="recording-a", checkpoint=None):
    return {"request_id": "request-1", "run_id": run_id, "revision": 1, "model_sha256": MODEL_HASHES["tiny"], "config_sha256": FRAME_CONFIG_SHA256, "build_id": "test-build", "source": {"sha256": "a" * 64, "width": 1920, "height": 1080, "fps": 29.97, "duration_s": 30}, "tables": [table()], "frames": frames or [frame()], "checkpoint": checkpoint}


def api(payload=None, operation="observe-batch", *, worker=None):
    return handle_event({"rawPath": "/frames/" + operation, "requestContext": {"http": {"method": "GET" if operation == "capabilities" else "POST"}}, "headers": {"content-type": "application/json"}, "body": json.dumps(payload) if payload is not None else ""}, processor=worker or processor())


def decode(item):
    return cv2.imdecode(np.frombuffer(base64.b64decode(item["image_base64"]), np.uint8), cv2.IMREAD_COLOR)


@pytest.mark.parametrize("sample_hz", [8, 10])
def test_uninterrupted_and_fresh_request_processing_match_through_gaps_failures_and_camera_motion(sample_hz):
    frames = [frame(index, 37 + index / sample_hz + (index % 3) * 0.004 + (1.7 if index >= 14 else 0)) for index in range(26)]
    session = VisionSession([table()], 160, 90, "recording-a", fps=29.97, detector=Detector())
    expected = [session.process_frame(decode(item), item["t"], item["sample_index"])["observation"] for item in frames]
    actual, checkpoint = [], None
    for start in range(0, len(frames), 4):
        payload = request(frames[start:start + 4], checkpoint=checkpoint)
        # A new processor/session handles every batch, including exact retries.
        reply = processor().process("observe-batch", payload)
        assert processor().process("observe-batch", copy.deepcopy(payload)) == reply
        checkpoint = json.loads(json.dumps(reply["checkpoint"]))
        actual.extend({key: value for key, value in observation.items() if key != "capture"} for observation in reply["observations"])
    assert actual == expected
    assert any(item["tracks"] for item in actual)
    assert any(not item["valid"] for item in actual)
    assert any(item["scene_cut"] for item in actual)
    assert checkpoint["surface"]["camera_invalid"] is True
    assert len(json.dumps(checkpoint).encode()) < LIMITS["checkpoint_bytes"]


def test_warm_runtime_isolation_and_stale_setup_rejection():
    worker = processor()
    first = worker.process("observe-batch", request([frame(0), frame(1)]))
    other = request([frame(0), frame(1)], run_id="recording-b")
    separate = worker.process("observe-batch", other)
    assert all(track["track_id"].startswith("recording-b:") for item in separate["observations"] for track in item["tracks"])
    replay = worker.process("observe-batch", request([frame(0), frame(1)]))
    assert replay == first
    stale = request([frame(2)], checkpoint=first["checkpoint"])
    for field, value in (("run_id", "recording-b"), ("revision", 2)):
        changed = {**stale, field: value}
        assert api(changed, worker=worker)["statusCode"] == 400
    altered = copy.deepcopy(stale)
    altered["tables"][0]["monitoring_enabled"] = False
    assert api(altered, worker=worker)["statusCode"] == 400
    assert worker.process("observe-batch", stale)["observations"][0]["frame_index"] == 2


@pytest.mark.parametrize("field,value", [("model_sha256", "e" * 64), ("config_sha256", "f" * 64), ("build_id", "outdated-release")])
def test_first_batch_rejects_stale_model_config_or_build_before_inference(field, value):
    calls = []
    def factory(mode):
        calls.append(mode)
        return Detector(mode)
    worker = StatelessProcessor(detector_factory=factory, build_id="test-build")
    payload = request()
    payload[field] = value
    response = api(payload, worker=worker)
    assert response["statusCode"] == 409
    assert json.loads(response["body"])["code"] == "stale_identity"
    assert calls == []


def test_only_current_unnumbered_frame_contract_is_exposed():
    capabilities = json.loads(api(operation="capabilities")["body"])
    assert "protocol_version" not in capabilities
    assert "protocol_version" not in capabilities["limits"]
    reply = processor().process("observe-batch", request())
    assert "protocol_version" not in reply
    assert "version" not in reply["checkpoint"]
    assert reply["checkpoint"]["trackers_version"] == "2.6.0"

    numbered = request()
    numbered["protocol_version"] = 1
    rejected = api(numbered)
    assert rejected["statusCode"] == 400
    assert "protocol_version" not in json.loads(rejected["body"])
    old_route = {"rawPath": "/v1/capabilities", "requestContext": {"http": {"method": "GET"}}}
    assert handle_event(old_route, processor=processor())["statusCode"] == 404


@pytest.mark.parametrize("mutation", [
    lambda value: value.update(version=99),
    lambda value: value.update(trackers_version="unsupported-dependency"),
    lambda value: value.update(last_index=True),
    lambda value: value["people"].update(tracks=[{}] * 257),
    lambda value: value["people"]["tracks"][0]["state"][0].__setitem__(0, float("nan")),
    lambda value: value["people"]["tracks"][0]["state_covariance"][0].__setitem__(0, -1),
    lambda value: value["surface"].update(global_gray="AA=="),
    lambda value: value["surface"].update(camera_invalid="false"),
    lambda value: value["surface"]["quiet"].update(invented_table=0),
    lambda value: value.update(arbitrary_python_object={"__reduce__": "os.system"}),
])
def test_malformed_checkpoints_do_not_advance_request(mutation):
    original = processor().process("observe-batch", request([frame(0), frame(1)]))["checkpoint"]
    malformed = copy.deepcopy(original)
    mutation(malformed)
    assert api(request([frame(2)], checkpoint=malformed))["statusCode"] == 400
    resumed = processor().process("observe-batch", request([frame(2)], checkpoint=original))
    assert resumed["checkpoint"]["last_index"] == 2


@pytest.mark.parametrize("mutation,expected", [
    (lambda p: p["frames"][0].update(sha256="b" * 64), 400),
    (lambda p: p["frames"][0].update(image_base64="!"), 400),
    (lambda p: p["frames"][0].update(width=1281), 400),
    (lambda p: p["frames"][0].update(width=32), 400),
    (lambda p: p.update(frames=[frame(i) for i in range(9)]), 400),
    (lambda p: p.update(frames=[frame(1), frame(0)]), 400),
    (lambda p: p.update(tables=[table()] * 33), 400),
    (lambda p: p["source"].update(duration_s=601), 400),
    (lambda p: p.update(checkpoint={"padding": "a" * LIMITS["checkpoint_bytes"]}), 413),
    (lambda p: p.update(padding="a" * LIMITS["body_bytes"]), 413),
])
def test_input_limits_and_image_validation(mutation, expected):
    payload = request()
    mutation(payload)
    assert api(payload)["statusCode"] == expected


def test_zero_tracking_checkpoint_roundtrip():
    session = VisionSession([table()], 160, 90, "test", detector=Detector())
    identity = {"test": "identity"}
    saved = dump_checkpoint(session, identity)
    fresh = VisionSession([table()], 160, 90, "test", detector=Detector())
    restore_checkpoint(fresh, json.loads(json.dumps(saved)), identity)
    assert dump_checkpoint(fresh, identity) == saved


def test_proposals_and_reference_assessment_preserve_exact_png_identity():
    worker = processor()
    proposal_request = request()
    proposal_request["tables"] = []
    proposals = worker.process("propose-tables", proposal_request)
    assert len(proposals["tables"]) == 1
    assert proposals["tables"][0]["reference"] is None
    payload = request([frame(2)])
    proposed = worker.process("propose-reference", payload)
    assert proposed["baseline"]["approved"] is False
    assert proposed["baseline"]["expected"] == [{"class_id": 41, "count": 1}]
    reference = proposed["reference"]
    assert hashlib.sha256(base64.b64decode(reference["image_base64"])).hexdigest() == reference["sha256"]
    current_table = payload["tables"][0]
    current_table["reference"] = {"file": "blob:memory-only", "source_t": 0.2, "confirmed_clean": True, "sha256": reference["sha256"]}
    current_table["object_baseline"] = build_baseline(proposed["baseline"]["expected"], reference["sha256"], current_table["geometry_sha256"], MODEL_HASHES["tiny"])
    capture = {key: value for key, value in payload["frames"][0].items() if key != "image_base64"}
    assessment_request = {"id": "assessment-1", "table_id": "T1", "t": 0.2, "frame_index": 2, "generation": 0, "video_sha256": payload["source"]["sha256"], "geometry_sha256": current_table["geometry_sha256"], "reference_sha256": reference["sha256"], "baseline_sha256": current_table["object_baseline"]["baseline_sha256"], "surface_method": SURFACE_METHOD, "config_sha256": CONFIG_SHA256, "capture": capture}
    payload.update(requests=[assessment_request], references={"T1": reference})
    result = worker.process("assess-batch", payload)
    assert worker.process("assess-batch", copy.deepcopy(payload)) == result
    assessment = result["assessments"][0]
    assert assessment["crop_base64"] == reference["image_base64"]
    assert assessment["crop_sha256"] == reference["sha256"]
    assert assessment["object_evidence"]["reference"]["observable"] is True
    assert assessment["capture"] == capture
    assert assessment["request_id"] == "assessment-1"
    payload["requests"][0]["capture"]["sha256"] = "e" * 64
    assert api(payload, "assess-batch", worker=worker)["statusCode"] == 400


def test_http_adapter_handles_missing_model_invalid_json_and_base64_event():
    unavailable = StatelessProcessor(availability=lambda: (False, "model absent"))
    response = api(operation="capabilities", worker=unavailable)
    assert response["statusCode"] == 200
    assert json.loads(response["body"])["available"] is False
    assert response["headers"]["cache-control"] == "no-store"
    for body in ('{"a":1,"a":2}', '{"number":NaN}', "[" * 1100):
        event = {"rawPath": "/frames/observe-batch", "requestContext": {"http": {"method": "POST"}}, "headers": {"content-type": "application/json"}, "body": body}
        assert handle_event(event, processor=processor())["statusCode"] == 400
    event["body"] = base64.b64encode(json.dumps(request()).encode()).decode()
    event["isBase64Encoded"] = True
    assert handle_event(event, processor=processor())["statusCode"] == 200


def test_local_server_has_no_persistent_routes_and_throttles_burst():
    entered, release = threading.Event(), threading.Event()
    class WaitingProcessor:
        def capabilities(self):
            entered.set()
            release.wait(4)
            return {"available": True}
    server = create_server("127.0.0.1", 0, processor=WaitingProcessor(), concurrency=1)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    replies = []
    caller = threading.Thread(target=lambda: replies.append(urlopen(url + "/frames/capabilities", timeout=5).status))
    caller.start()
    try:
        assert entered.wait(2)
        with pytest.raises(HTTPError) as error:
            urlopen(url + "/frames/capabilities", timeout=2)
        assert error.value.code == 429
        release.set()
        caller.join(3)
        assert replies == [200]
        for path in ("/videos", "/sources", "/jobs"):
            with pytest.raises(HTTPError) as error:
                urlopen(url + path, timeout=2)
            assert error.value.code == 404
    finally:
        release.set()
        server.shutdown()
        server.server_close()
        thread.join(2)
