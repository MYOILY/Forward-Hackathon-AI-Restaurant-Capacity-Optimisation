"""Test the submitted Caddy rules using isolated loopback ports and a temporary CA.

Requires a native Caddy executable and an already-running isolated TableWatch
service whose allowed origins include https://localhost:18443. Never installs a
root certificate into the operating system. Never starts cloud infrastructure.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caddy", type=Path, required=True)
    parser.add_argument(
        "--upstream",
        required=True,
        help="Isolated HTTP loopback origin; port 8000 is deliberately refused",
    )
    parser.add_argument("--video-source-id", required=True)
    parser.add_argument("--camera-source-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    upstream = urllib.parse.urlsplit(args.upstream)
    if (
        upstream.scheme != "http"
        or upstream.hostname not in {"127.0.0.1", "localhost"}
        or not upstream.port
        or upstream.port in {80, 443, 8000, 18080, 18443}
        or upstream.username
        or upstream.password
        or upstream.path
        or upstream.query
        or upstream.fragment
    ):
        parser.error(
            "--upstream must identify an isolated HTTP loopback port, excluding 8000"
        )
    root = Path(__file__).resolve().parents[1]
    caddy = args.caddy.resolve()
    password = secrets.token_urlsafe(32)
    hashed = subprocess.run(
        [str(caddy), "hash-password"],
        input=password + "\n",
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    ).stdout.strip()
    with tempfile.TemporaryDirectory(prefix="tablewatch-proxy-") as temporary:
        directory = Path(temporary)
        config = (root / "deploy/Caddyfile").read_text()
        if config.count("reverse_proxy tablewatch:8000") != 1:
            raise ValueError(
                "Expected exactly one submitted upstream; review the proxy harness after configuration changes"
            )
        config = config.replace(
            "reverse_proxy tablewatch:8000", "reverse_proxy " + upstream.netloc
        )
        config = config.replace("{$DOMAIN} {", "{$DOMAIN} {\n    tls internal")
        global_options = """{
    admin off
    persist_config off
    skip_install_trust
    http_port 18080
    https_port 18443
    default_bind 127.0.0.1
}

"""
        config_path = directory / "Caddyfile"
        config_path.write_text(global_options + config)
        environment = {
            **os.environ,
            "DOMAIN": "localhost",
            "BASIC_AUTH_USER": "proxy-test",
            "BASIC_AUTH_HASH": hashed,
            "XDG_DATA_HOME": str(directory / "data"),
            "XDG_CONFIG_HOME": str(directory / "config"),
        }
        log_path = directory / "caddy.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [str(caddy), "run", "--config", str(config_path)],
                env=environment,
                cwd=directory,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                certificate = directory / "data/caddy/pki/authorities/local/root.crt"
                deadline = time.monotonic() + 20
                while not certificate.exists():
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError(
                            "Local Caddy did not initialize; "
                            + log_path.read_text()[-4000:]
                        )
                    time.sleep(0.1)
                context = ssl.create_default_context(cafile=str(certificate))
                while True:
                    try:
                        urllib.request.urlopen(
                            "https://localhost:18443/api/live",
                            context=context,
                            timeout=2,
                        )
                    except urllib.error.HTTPError as error:
                        assert error.code == 401
                        break
                    except urllib.error.URLError:
                        if time.monotonic() > deadline:
                            raise
                        time.sleep(0.1)

                class NoRedirect(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, req, fp, code, msg, headers, newurl):
                        return None

                http_request = urllib.request.Request(
                    "http://127.0.0.1:18080/api/health", headers={"Host": "localhost"}
                )
                try:
                    urllib.request.build_opener(NoRedirect).open(
                        http_request, timeout=5
                    )
                    raise AssertionError("HTTP did not redirect to HTTPS")
                except urllib.error.HTTPError as error:
                    assert error.code == 308
                    # Caddy's global HTTPS port changes its internal listener;
                    # the production redirect still advertises external 443.
                    redirect = urllib.parse.urlsplit(error.headers.get("Location", ""))
                    assert (redirect.scheme, redirect.hostname, redirect.path) == (
                        "https",
                        "localhost",
                        "/api/health",
                    )
                result = subprocess.run(
                    [
                        sys.executable,
                        "scripts/check_proxy.py",
                        "--url",
                        "https://localhost:18443",
                        "--user",
                        "proxy-test",
                        "--ca-file",
                        str(certificate),
                        "--video-source-id",
                        args.video_source_id,
                        "--camera-source-id",
                        args.camera_source_id,
                        "--output",
                        str(args.output.resolve()),
                    ],
                    cwd=root,
                    env={**os.environ, "TABLEWATCH_CHECK_PASSWORD": password},
                    capture_output=True,
                    text=True,
                    timeout=90,
                )
                if result.returncode:
                    raise RuntimeError(
                        "Local proxy acceptance failed: "
                        + result.stdout
                        + result.stderr
                    )
                report = json.loads(result.stdout)
                report["checks"].append(
                    "Plain HTTP redirects to HTTPS before serving the API"
                )
                report.update(
                    tls_scope="Temporary local CA; certificate verification enabled; system trust unchanged",
                    configuration_scope="Submitted Caddy auth/proxy rules with loopback upstream, ports and internal TLS",
                    public_domain_validation=False,
                )
                args.output.write_text(json.dumps(report, indent=2) + "\n")
                print(json.dumps(report, indent=2))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
