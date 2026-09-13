"""Portable gateway contract: one origin for dashboard/API and explicit origin bounds."""

from fastapi.testclient import TestClient
from service.app import create_app, origin_allowed


def test_cpu_frontend_mount_keeps_api_routes_and_health_accessible(
    tmp_path, monkeypatch
):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text(
        "<html><body>CPU dashboard fixture</body></html>"
    )
    monkeypatch.setenv("TABLEWATCH_STATIC_DIR", str(frontend))
    app = create_app(
        tmp_path / "data",
        dependencies={
            "models": lambda: {
                "detector": {"available": True},
                "surface": {"available": True},
            }
        },
    )
    with TestClient(app) as client:
        assert "CPU dashboard fixture" in client.get("/").text
        assert (
            client.get("/api/health").json()["models"]["surface"]["available"] is True
        )
        assert client.get("/api/jobs").json() == []
        assert client.get("/api/does-not-exist").status_code == 404


def test_configured_http_and_websocket_origins_are_exact_not_hostname_prefixes(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(
        "TABLEWATCH_ALLOWED_ORIGINS",
        "https://dining.example.test,http://localhost:18000",
    )
    app = create_app(tmp_path, dependencies={"models": lambda: {}})
    with TestClient(app) as client:
        assert (
            client.get(
                "/api/health", headers={"Origin": "https://dining.example.test"}
            ).status_code
            == 200
        )
        for origin in (
            "https://dining.example.test.evil.test",
            "https://dining.example.test/path",
            "http://localhost:18001",
            "https://name@dining.example.test",
            "null",
        ):
            assert not origin_allowed(origin)
            assert (
                client.get("/api/health", headers={"Origin": origin}).status_code == 403
            )
        assert origin_allowed("http://localhost:18000")
        assert origin_allowed(
            None
        )  # local command-line tools do not send browser Origin


def test_liveness_and_manual_gateway_do_not_require_models(tmp_path):
    missing = {
        "detector": {"available": False, "reason": "Weights missing"},
        "surface": {"available": False, "reason": "Weights missing"},
    }
    with TestClient(
        create_app(tmp_path, dependencies={"models": lambda: missing})
    ) as client:
        assert client.get("/api/live").json() == {"available": True}
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/jobs").json() == []
        result = client.get("/api/ready")
        assert result.status_code == 503 and result.json() == {
            "ready": False,
            "models": missing,
        }


def test_readiness_requires_detector_and_surface_models(tmp_path):
    models = {"detector": {"available": True}, "surface": {"available": True}}
    with TestClient(
        create_app(tmp_path, dependencies={"models": lambda: models})
    ) as client:
        assert client.get("/api/ready").status_code == 200
        assert client.get("/api/ready").json()["ready"] is True


def test_transport_message_limit_tracks_application_frame_limit(monkeypatch):
    import service.__main__ as entry

    calls = []
    monkeypatch.setenv("TABLEWATCH_FRAME_BYTES", "1024")
    monkeypatch.setattr(
        entry.uvicorn, "run", lambda *args, **kwargs: calls.append(kwargs)
    )
    entry.main()
    assert calls[0]["workers"] == 1
    assert calls[0]["ws_max_size"] == 2 * 1024 + 65536
