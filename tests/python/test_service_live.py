"""Actual HTTP/WebSocket/TS integration with fake frames, clock and inference only."""

import asyncio
from contextlib import contextmanager
import signal
import time
import hashlib
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from service.app import create_app
from test_service_inputs import dependencies, image_b64, make_camera, save_calibration


@contextmanager
def socket_deadline(seconds=3):
    """Bound missing terminal-message failures on the supported local POSIX host."""

    def timeout(*_):
        raise TimeoutError(
            "Expected WebSocket stop/close acknowledgement did not arrive"
        )

    previous = signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class Vision:
    def __init__(self, config, delay=0):
        self.tables = config["tables"]
        self.delay = delay
        self.processed = []
        self.closed = False
        self.present = False

    async def process_frame(self, frame, t, seq):
        self.processed.append(seq)
        await asyncio.sleep(self.delay)
        tracks = (
            [
                {
                    "track_id": "independent-person",
                    "box": [0.2, 0.1, 0.5, 0.8],
                    "score": 0.9,
                    "observed": True,
                    "table_id": "T1",
                    "candidate_table_ids": ["T1"],
                }
            ]
            if self.present
            else []
        )
        return {
            "observation": {
                "t": t,
                "frame_index": seq,
                "valid": True,
                "detections": [],
                "tracks": tracks,
                "tables": {
                    row["id"]: (
                        "present" if self.present and row["id"] == "T1" else "absent"
                    )
                    for row in self.tables
                },
                "surface": {
                    row["id"]: {"visible": True, "changed": False}
                    for row in self.tables
                },
            },
            "timing": {"inference": 0.001},
        }

    async def set_tables(self, tables):
        self.tables = tables

    async def close(self):
        self.closed = True


def receive_until(socket, predicate):
    for _ in range(100):
        value = socket.receive_json()
        if predicate(value):
            return value
    raise AssertionError("Expected WebSocket message was not delivered in 100 updates")


def make_app(tmp_path, bundle, delay=0):
    clock = Clock()
    workers = []
    deps = dependencies(bundle)

    def vision(config):
        worker = Vision(config, delay)
        workers.append(worker)
        return worker

    def forbidden_surface(*args, **kwargs):
        raise AssertionError("Detection-only must never construct a surface worker")

    deps.update(clock=clock, vision_worker=vision, surface_worker=forbidden_surface)
    return (
        create_app(tmp_path, dependencies=deps, limits={"disk_reserve_bytes": 0}),
        clock,
        workers,
    )


def start(client):
    source = save_calibration(client, make_camera(client))
    result = client.post(
        "/api/live", json={"source_id": source["id"], "detection_only": True}
    )
    assert result.status_code in {200, 201, 202}, result.text
    return source, result.json()


def frame(session, seq, t):
    return {
        "type": "frame",
        "session_id": session["session_id"],
        "epoch": session["epoch"],
        "seq": seq,
        "captured_t": t,
        "image_base64": image_b64(),
    }


def test_guided_live_gate_requires_reviews_and_full_mode_baselines_but_preserves_legacy(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        source = save_calibration(client, make_camera(client))
        rejected = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": False}
        )
        assert rejected.status_code == 400 and "baseline" in rejected.text.lower()
        started = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": True}
        )
        assert started.status_code == 201, started.text
        assert (
            client.delete("/api/live/" + started.json()["session_id"]).status_code
            == 200
        )
        persisted = app.state.manager.sources[source["id"]]
        persisted["tables"][0]["setup_review"]["map"] = False
        blocked = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": True}
        )
        assert blocked.status_code == 400 and "review" in blocked.text.lower()
        assert app.state.manager.active is None
        # Previously saved sources have no guided flag and retain their policy.
        persisted.pop("setup_mode")
        legacy = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": True}
        )
        assert legacy.status_code == 201, legacy.text
        assert (
            client.delete("/api/live/" + legacy.json()["session_id"]).status_code == 200
        )


def test_L02_latest_pending_frame_replaces_old_work_and_exact_analyzed_frame_returns(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle, delay=0.15)
    with TestClient(app) as client:
        source, session = start(client)
        before = {
            path.relative_to(tmp_path) for path in tmp_path.rglob("*") if path.is_file()
        }
        with client.websocket_connect(session["ws_url"]) as socket:
            clock.value = 100.1
            socket.send_json(frame(session, 1, 0.1))
            time.sleep(0.04)
            clock.value = 100.2
            socket.send_json(frame(session, 2, 0.2))
            clock.value = 100.3
            socket.send_json(frame(session, 3, 0.3))
            value = receive_until(
                socket, lambda item: item.get("frame", {}).get("seq") == 3
            )
            assert workers[0].processed == [1, 3]
            assert (
                value["frame"]["image_base64"] == image_b64()
                and value["frame"]["captured_t"] == 0.3
            )
            assert (
                value["stats"]["processed_frames"] == 2
                and value["stats"]["dropped_frames"] == 1
            )
            assert value["snapshot"]["tables"]["T1"]["surface_state"] == "unverified"
            socket.send_json({"type": "stop"})
            receive_until(socket, lambda item: item["type"] == "stopped")
        assert workers[0].closed
        after = {
            path.relative_to(tmp_path) for path in tmp_path.rglob("*") if path.is_file()
        }
        assert not [
            path
            for path in after - before
            if path.suffix.lower()
            in {".mp4", ".avi", ".mjpeg", ".jpg", ".jpeg", ".png"}
        ]


def test_L05_live_heartbeat_expires_absence_and_retains_explicit_manual_colour(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        source, session = start(client)
        with client.websocket_connect(session["ws_url"]) as socket:
            clock.value = 100.1
            socket.send_json(frame(session, 1, 0.1))
            receive_until(socket, lambda item: item.get("frame", {}).get("seq") == 1)
            socket.send_json(
                {
                    "type": "staff",
                    "action": "force_status",
                    "status": "ready",
                    "table_id": "T1",
                }
            )
            forced = receive_until(
                socket,
                lambda item: item.get("snapshot", {})
                .get("tables", {})
                .get("T1", {})
                .get("manual_override")
                is not None,
            )
            assert forced["snapshot"]["tables"]["T1"]["status"] == "ready"
            clock.value = 101.3
            stale = receive_until(socket, lambda item: item.get("t", 0) >= 1.3 - 1e-6)
            assert stale["snapshot"]["tables"]["T1"]["people_state"] == "uncertain"
            assert (
                stale["snapshot"]["tables"]["T1"]["status"] == "ready"
                and stale["snapshot"]["tables"]["T1"]["automatic_status"] == "unknown"
            )
        assert workers[0].closed


def test_L06_compute_slot_is_exclusive_and_disconnect_releases_session(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        source, session = start(client)
        assert (
            client.post(
                "/api/live", json={"source_id": source["id"], "detection_only": True}
            ).status_code
            == 409
        )
        with client.websocket_connect(session["ws_url"]) as socket:
            socket.send_json({"type": "sync", "client_t": 12.5})
            reply = receive_until(socket, lambda item: item["type"] == "clock")
            assert reply["client_t"] == 12.5 and reply["t"] >= 0
        assert workers[0].closed
        next_session = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": True}
        )
        assert next_session.status_code in {200, 201, 202}
        assert next_session.json()["session_id"] != session["session_id"]
        assert client.delete(
            "/api/live/" + next_session.json()["session_id"]
        ).status_code in {200, 204}


def test_L01_wrong_session_future_and_duplicate_frames_reject(tmp_path, bundle):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        _, session = start(client)
        with client.websocket_connect(session["ws_url"]) as socket:
            socket.send_json({**frame(session, 1, 0.1), "epoch": session["epoch"] + 1})
            assert receive_until(socket, lambda item: item["type"] == "error")[
                "message"
            ]
            socket.send_json(frame(session, 2, 2))
            assert receive_until(socket, lambda item: item["type"] == "error")[
                "message"
            ]
            clock.value = 100.1
            socket.send_json(frame(session, 3, 0.1))
            receive_until(socket, lambda item: item.get("frame", {}).get("seq") == 3)
            socket.send_json(frame(session, 3, 0.1))
            assert receive_until(socket, lambda item: item["type"] == "error")[
                "message"
            ]
            assert workers[0].processed == [3]


def test_L08_http_delete_stops_connected_socket_and_releases_worker(tmp_path, bundle):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        _, session = start(client)
        with client.websocket_connect(session["ws_url"]) as socket:
            socket.send_json({"type": "sync", "client_t": 0})
            receive_until(socket, lambda item: item["type"] == "clock")
            response = client.delete("/api/live/" + session["session_id"])
            assert response.status_code in {200, 204}
            with socket_deadline():
                receive_until(socket, lambda item: item["type"] == "stopped")
                from starlette.websockets import WebSocketDisconnect

                try:
                    socket.receive_json()
                except WebSocketDisconnect:
                    pass
                else:
                    raise AssertionError("HTTP stop left the camera socket open")
        assert workers[0].closed


class Surface:
    def __init__(self, *args, **kwargs):
        self.calls = 0
        self.closed = False

    async def assess(self, reference, current):
        self.calls += 1
        await asyncio.sleep(0.15)
        from processor.object_baseline import CONFIG_SHA256

        return {
            "valid": True,
            "outcome": "unobservable",
            "reason": "Raw delayed test evidence",
            "model": "test-double",
            "config_sha256": CONFIG_SHA256,
            "timing": {"total": 0.15},
            "object_evidence": {
                "detections": [],
                "reference": {
                    "observable": True,
                    "brightness_offset": 0.0,
                    "changed_fraction": 0.0,
                    "largest_change_fraction": 0.0,
                    "edge_mismatch": 0.0,
                },
            },
        }

    async def close(self):
        self.closed = True


def full_app(tmp_path, bundle):
    from processor.models import MODEL_HASHES

    clock = Clock()
    visions = []
    surfaces = []
    deps = dependencies(bundle)

    def vision(config):
        worker = Vision(config)
        visions.append(worker)
        return worker

    def surface(*args, **kwargs):
        worker = Surface()
        surfaces.append(worker)
        return worker

    deps.update(
        models=lambda: {
            "detector": {"available": True, "sha256": MODEL_HASHES["tiny"]},
            "surface": {"available": True, "sha256": MODEL_HASHES["tiny"]},
        },
        propose_baseline=lambda rgb: {
            "detections": [],
            "detector_sha256": MODEL_HASHES["tiny"],
        },
        clock=clock,
        vision_worker=vision,
        surface_worker=surface,
    )
    return (
        create_app(tmp_path, dependencies=deps, limits={"disk_reserve_bytes": 0}),
        clock,
        visions,
        surfaces,
    )


def calibrated_camera(client):
    source = make_camera(client)
    for table in source["tables"]:
        proposal = client.post(
            f"/api/sources/{source['id']}/baseline-proposal",
            json={
                "revision": source["revision"],
                "table_id": table["id"],
                "tabletop_polygon": table["tabletop_polygon"],
                "occupancy_regions": table["occupancy_regions"],
                "reference_t": 0,
            },
        )
        assert proposal.status_code == 200, proposal.text
        baseline = proposal.json()["baseline"]
        baseline["approved"] = True
        table.update(reference_t=0, reference_approved=True, object_baseline=baseline)
    return save_calibration(client, source)


def test_L03_actual_service_rejects_delayed_surface_result_after_new_arrival(
    tmp_path, bundle
):
    app, clock, visions, surfaces = full_app(tmp_path, bundle)
    with TestClient(app) as client:
        source = calibrated_camera(client)
        response = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": False}
        )
        assert response.status_code in {200, 201, 202}, response.text
        session = response.json()
        with client.websocket_connect(session["ws_url"]) as socket:
            for index in range(51):
                clock.value = 100 + index / 10
                socket.send_json(frame(session, index, index / 10))
                receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == index
                )
            visions[0].present = True
            clock.value = 105.1
            socket.send_json(frame(session, 51, 5.1))
            receive_until(socket, lambda item: item.get("frame", {}).get("seq") == 51)
            with socket_deadline():
                result = receive_until(
                    socket,
                    lambda item: any(
                        event["kind"] == "assessment_rejected"
                        for event in item.get("snapshot", {}).get("events", [])
                    ),
                )
            assert (
                surfaces[0].calls == 1
                and result["snapshot"]["tables"]["T1"]["status"] == "unknown"
            )
            assert (
                result["snapshot"]["tables"]["T1"]["people_state"] == "pending_arrival"
            )


def test_large_live_crop_stays_in_memory_and_out_of_rules_protocol(
    tmp_path, bundle, monkeypatch
):
    import base64
    import service.live

    crop = np.random.default_rng(73).integers(0, 256, (512, 512, 3), dtype=np.uint8)
    monkeypatch.setattr(service.live, "rectify_tabletop", lambda *args: crop)
    app, clock, visions, surfaces = full_app(tmp_path, bundle)
    with TestClient(app) as client:
        source = calibrated_camera(client)
        response = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": False}
        )
        assert response.status_code in {200, 201, 202}, response.text
        session = response.json()
        run = app.state.live_manager.sessions[session["session_id"]]
        before = {
            path.relative_to(tmp_path) for path in tmp_path.rglob("*") if path.is_file()
        }
        with client.websocket_connect(session["ws_url"]) as socket:
            for index in range(51):
                clock.value = 100 + index / 10
                socket.send_json(frame(session, index, index / 10))
                receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == index
                )
            with socket_deadline():
                try:
                    result = receive_until(
                        socket,
                        lambda item: bool(
                            item.get("snapshot", {})
                            .get("tables", {})
                            .get("T1", {})
                            .get("last_assessment")
                        ),
                    )
                except TimeoutError:
                    pytest.fail(
                        str(
                            {
                                "workers": len(surfaces),
                                "calls": [w.calls for w in surfaces],
                                "stats": run.stats,
                                "snapshot": run.snapshot,
                            }
                        )
                    )
            assessment = result["snapshot"]["tables"]["T1"]["last_assessment"]
            raw = base64.b64decode(assessment["crop_base64"].split(",", 1)[1])
            assert (
                len(raw) > 65536
                and hashlib.sha256(raw).hexdigest() == assessment["crop_sha256"]
            )
            assert np.array_equal(
                cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR), crop
            )
            assert "crop_base64" not in run.snapshot["tables"]["T1"]["last_assessment"]
            assert len(run.assessment_images) == 1
            socket.send_json({"type": "stop"})
            receive_until(socket, lambda item: item["type"] == "stopped")
        assert surfaces[0].closed and visions[0].closed and not run.assessment_images
        after = {
            path.relative_to(tmp_path) for path in tmp_path.rglob("*") if path.is_file()
        }
        assert after == before


def test_timed_out_surface_worker_releases_queue_and_next_check_recovers(
    tmp_path, bundle
):
    app, clock, visions, surfaces = full_app(tmp_path, bundle)
    with TestClient(app) as client:
        source = calibrated_camera(client)
        response = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": False}
        )
        assert response.status_code in {200, 201, 202}, response.text
        session = response.json()
        run = app.state.live_manager.sessions[session["session_id"]]
        first = surfaces[0]

        async def hung(reference, current):
            first.calls += 1
            await asyncio.sleep(60)

        first.assess = hung
        # Shorten only the transport deadline; the actual rules engine retains
        # its configured five-second request lifetime and decides when to retry.
        run.config["evidence_max_age_s"] = 0.25
        with client.websocket_connect(session["ws_url"]) as socket:
            for index in range(51):
                clock.value = 100 + index / 10
                socket.send_json(frame(session, index, index / 10))
                receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == index
                )
            with socket_deadline():
                error = receive_until(socket, lambda item: item.get("type") == "error")
            assert "timed out" in error["message"] and first.closed
            for index in range(51, 102):
                clock.value = 100 + index / 10
                socket.send_json(frame(session, index, index / 10))
                receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == index
                )
            with socket_deadline():
                try:
                    result = receive_until(
                        socket,
                        lambda item: bool(
                            item.get("snapshot", {})
                            .get("tables", {})
                            .get("T1", {})
                            .get("last_assessment")
                        ),
                    )
                except TimeoutError:
                    pytest.fail(
                        str(
                            {
                                "workers": len(surfaces),
                                "calls": [w.calls for w in surfaces],
                                "stats": run.stats,
                                "snapshot": run.snapshot,
                            }
                        )
                    )
            assert len(surfaces) == 2 and surfaces[1].calls == 1
            assert (
                result["snapshot"]["tables"]["T1"]["last_assessment"]["outcome"]
                == "cleared_reset"
            )
            assert result["snapshot"]["tables"]["T1"]["status"] != "ready"
        assert all(worker.closed for worker in surfaces)


def test_L03_live_reference_byte_tampering_cannot_reach_surface_model(tmp_path, bundle):
    app, clock, visions, surfaces = full_app(tmp_path, bundle)
    with TestClient(app) as client:
        source = calibrated_camera(client)
        digest = source["tables"][0]["reference"]["sha256"]
        matches = [
            path
            for path in tmp_path.rglob("*.png")
            if hashlib.sha256(path.read_bytes()).hexdigest() == digest
        ]
        assert matches
        for path in matches:
            assert cv2.imwrite(str(path), np.full((32, 32, 3), 151, np.uint8))
        response = client.post(
            "/api/live", json={"source_id": source["id"], "detection_only": False}
        )
        if response.status_code >= 400:
            assert not surfaces or surfaces[0].calls == 0
            return
        session = response.json()
        with client.websocket_connect(session["ws_url"]) as socket:
            for index in range(52):
                clock.value = 100 + index / 10
                socket.send_json(frame(session, index, index / 10))
                result = receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == index
                )
            time.sleep(0.2)
            assert (
                surfaces[0].calls == 0
                and result["snapshot"]["tables"]["T1"]["surface_state"] == "unverified"
            )


def test_L03_known_queued_person_frame_precedes_guarded_clean_without_transient_network_green(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        _, session = start(client)
        with client.websocket_connect(session["ws_url"]) as socket:
            for index in range(51):
                clock.value = 100 + index / 10
                socket.send_json(frame(session, index, index / 10))
                receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == index
                )
            workers[0].present = True
            workers[0].delay = 0.15
            clock.value = 105.1
            socket.send_json(frame(session, 51, 5.1))
            time.sleep(0.04)
            clock.value = 105.2
            socket.send_json(
                {"type": "staff", "action": "force_cleaned", "table_id": "T1"}
            )
            updates = []
            with socket_deadline():
                while True:
                    value = socket.receive_json()
                    if value["type"] != "update":
                        continue
                    updates.append(value)
                    if any(
                        event["kind"] in {"staff_accepted", "staff_rejected"}
                        for event in value["snapshot"]["events"]
                    ):
                        break
            assert all(
                value["snapshot"]["tables"]["T1"]["status"] != "ready"
                for value in updates
            )
            assert any(
                event["kind"] == "staff_rejected"
                for event in updates[-1]["snapshot"]["events"]
            )


def test_L07_monitoring_configuration_change_drops_inflight_evidence_from_old_configuration(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle, delay=0.15)
    with TestClient(app) as client:
        _, session = start(client)
        with client.websocket_connect(session["ws_url"]) as socket:
            clock.value = 100.1
            socket.send_json(frame(session, 1, 0.1))
            time.sleep(0.04)
            clock.value = 100.3
            socket.send_json({"type": "monitoring", "table_id": "T1", "enabled": False})
            socket.send_json({"type": "monitoring", "table_id": "T1", "enabled": True})
            disabled = receive_until(
                socket,
                lambda item: item.get("snapshot", {})
                .get("tables", {})
                .get("T1", {})
                .get("monitoring_enabled")
                is False,
            )
            enabled = receive_until(
                socket,
                lambda item: item.get("snapshot", {})
                .get("tables", {})
                .get("T1", {})
                .get("monitoring_enabled")
                is True,
            )
            assert enabled["snapshot"]["tables"]["T1"]["people_state"] == "uncertain"
            assert enabled["snapshot"]["tables"]["T1"]["people_evidence_t"] is None
            assert enabled["stats"]["dropped_frames"] >= 1


def test_L02_output_coalescing_preserves_latest_unsent_analyzed_frame_and_its_age(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        _, session = start(client)
        run = app.state.live_manager.sessions[session["session_id"]]
        analyzed = {
            "seq": 1,
            "captured_t": 0.1,
            "image_base64": image_b64(),
            "width": 64,
            "height": 48,
        }
        observation = {
            "t": 0.1,
            "frame_index": 1,
            "valid": True,
            "tables": {"T1": "absent"},
        }

        def publish_backlog():
            while not run.output.empty():
                run.output.get_nowait()
            clock.value = 100.1
            run.last_image_t = 0.1
            run.publish(frame=analyzed, observation=observation)
            clock.value = 100.4
            run.publish()
            run.publish()
            rows = []
            while not run.output.empty():
                rows.append(run.output.get_nowait())
            return rows

        rows = client.portal.call(publish_backlog)
        assert len(rows) <= 2
        assert (
            rows[-1].get("frame") == analyzed
            and rows[-1].get("observation") == observation
        )
        assert rows[-1]["stats"]["frame_age_s"] == pytest.approx(0.3)


def test_L01_small_clock_lead_is_deferred_and_never_advances_engine_into_future(
    tmp_path, bundle
):
    app, clock, workers = make_app(tmp_path, bundle)
    with TestClient(app) as client:
        _, session = start(client)
        with client.websocket_connect(session["ws_url"]) as socket:
            clock.value = 100.1
            socket.send_json(frame(session, 1, 0.3))
            value = receive_until(
                socket,
                lambda item: item.get("type") == "update"
                and item.get("t", 0) >= 0.1 - 1e-6,
            )
            assert value["snapshot"]["t"] <= 0.1 + 1e-6 and value.get("frame") is None
            clock.value = 100.3
            with socket_deadline():
                result = receive_until(
                    socket, lambda item: item.get("frame", {}).get("seq") == 1
                )
            assert (
                result["snapshot"]["t"] <= 0.3 + 1e-6
                and result["frame"]["captured_t"] == 0.3
            )
