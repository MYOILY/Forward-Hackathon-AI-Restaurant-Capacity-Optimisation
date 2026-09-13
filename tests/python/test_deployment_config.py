"""Public deployment must fail closed before the authenticated proxy starts."""

from pathlib import Path
import subprocess
import sys

import pytest
import yaml

from scripts.validate_deployment import read_env_file, validate_public_settings
from scripts.cpu_check_client import check_base_url, websocket_base_url


ROOT = Path(__file__).resolve().parents[2]
# Structurally valid test hash only; it is never used as deployed credentials.
HASH = "$2a$14$" + "A" * 53
SETTINGS = {
    "DOMAIN": "tables.restaurant.org",
    "BASIC_AUTH_USER": "operator",
    "BASIC_AUTH_HASH": HASH,
}


def test_exact_public_origin_and_valid_settings():
    validate_public_settings(SETTINGS)
    validate_public_settings(
        {**SETTINGS, "TABLEWATCH_ALLOWED_ORIGINS": "https://tables.restaurant.org"}
    )


@pytest.mark.parametrize(
    "domain",
    [
        "",
        "localhost",
        "127.0.0.1",
        "example.com",
        "tables.example.com",
        "tablewatch.invalid",
        "your-domain.com",
        "https://tables.restaurant.org",
        "tables.restaurant.org:443",
        "tables.restaurant.org/path",
        "tables.restaurant.org\nrespond OK",
        "tables.restaurant.org.",
        "*.restaurant.org",
    ],
)
def test_domain_rejects_placeholders_and_caddy_injection(domain):
    with pytest.raises(ValueError, match="DOMAIN"):
        validate_public_settings({**SETTINGS, "DOMAIN": domain})


@pytest.mark.parametrize(
    "username", ["", "username", "changeme", "two words", "bad\n}", "user:password"]
)
def test_user_rejects_placeholders_and_config_injection(username):
    with pytest.raises(ValueError, match="BASIC_AUTH_USER"):
        validate_public_settings({**SETTINGS, "BASIC_AUTH_USER": username})


@pytest.mark.parametrize(
    "password_hash",
    ["", "password", "replace-me", "$2a$04$" + "A" * 53, HASH + "\n}", HASH[:-1]],
)
def test_rejects_plaintext_invalid_and_weak_hashes(password_hash):
    with pytest.raises(ValueError, match="BASIC_AUTH_HASH"):
        validate_public_settings({**SETTINGS, "BASIC_AUTH_HASH": password_hash})


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "http://tables.restaurant.org",
        "https://tables.restaurant.org/",
        "https://tables.restaurant.org,http://localhost:8000",
    ],
)
def test_public_origin_cannot_be_broadened(origin):
    with pytest.raises(ValueError, match="TABLEWATCH_ALLOWED_ORIGINS"):
        validate_public_settings({**SETTINGS, "TABLEWATCH_ALLOWED_ORIGINS": origin})


def test_env_preserves_bcrypt_dollar_signs(tmp_path):
    env = tmp_path / ".env"
    env.write_text(
        f"# generated locally\nDOMAIN=tables.restaurant.org\nBASIC_AUTH_USER=operator\nBASIC_AUTH_HASH='{HASH}'\n"
    )
    assert read_env_file(env) == SETTINGS


def test_startup_exits_before_service_and_does_not_print_hash():
    import os

    result = subprocess.run(
        [sys.executable, "scripts/start_service.py"],
        cwd=ROOT,
        env={
            **os.environ,
            **SETTINGS,
            "DOMAIN": "example.com",
            "TABLEWATCH_PUBLIC_DEPLOYMENT": "true",
        },
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode == 1
    assert "configuration rejected" in result.stderr
    assert HASH not in result.stdout + result.stderr
    assert "Uvicorn running" not in result.stdout + result.stderr


def test_public_proxy_is_the_only_published_service():
    config = yaml.safe_load((ROOT / "compose.yaml").read_text())
    app, proxy = config["services"]["tablewatch"], config["services"]["caddy"]
    assert "ports" not in app
    assert app["platform"] == "linux/amd64"
    assert app["deploy"]["replicas"] == 1
    assert app["environment"]["TABLEWATCH_PUBLIC_DEPLOYMENT"] == "true"
    assert proxy["depends_on"]["tablewatch"]["condition"] == "service_healthy"
    assert "tablewatch-data:/data" in app["volumes"]
    assert any(value.endswith(":/models:ro") for value in app["volumes"])
    assert "caddy-data:/data" in proxy["volumes"]


def test_local_is_independent_loopback_and_does_not_require_public_credentials():
    config = yaml.safe_load((ROOT / "compose.local.yaml").read_text())
    assert set(config["services"]) == {"tablewatch"}
    app = config["services"]["tablewatch"]
    assert app["ports"] == ["127.0.0.1:8000:8000"]
    assert "DOMAIN" not in app["environment"]
    assert "BASIC_AUTH_HASH" not in app["environment"]


def test_cpu_checks_support_an_isolated_port(monkeypatch):
    monkeypatch.setenv("TABLEWATCH_CHECK_BASE_URL", "http://127.0.0.1:18500/")
    assert check_base_url() == "http://127.0.0.1:18500"
    assert websocket_base_url(check_base_url()) == "ws://127.0.0.1:18500"
    monkeypatch.setenv("TABLEWATCH_CHECK_BASE_URL", "https://localhost:18443")
    assert websocket_base_url(check_base_url()) == "wss://localhost:18443"


@pytest.mark.parametrize("base", ["ftp://localhost", "http://user:password@localhost:18500", "http://localhost:18500/api", "http://localhost:18500?query", "http://localhost:18500#fragment"])
def test_cpu_checks_reject_ambiguous_connection_settings(monkeypatch, base):
    monkeypatch.setenv("TABLEWATCH_CHECK_BASE_URL", base)
    with pytest.raises(ValueError, match="TABLEWATCH_CHECK_BASE_URL"):
        check_base_url()
