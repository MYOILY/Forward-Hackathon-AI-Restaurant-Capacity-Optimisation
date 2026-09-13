"""Exercise an HTTPS deployment; password is prompted, never accepted on the command line.

Optional saved video/camera sources add actual Range and WSS round-trip checks.
The camera check briefly acquires and then releases the single processing slot.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--url", required=True, help="HTTPS origin with a valid certificate"
    )
    parser.add_argument("--user", required=True)
    parser.add_argument(
        "--ca-file",
        type=Path,
        help="Optional trusted CA PEM for a local proxy integration harness",
    )
    parser.add_argument(
        "--video-source-id", help="Existing test video for a byte-range request"
    )
    parser.add_argument(
        "--camera-source-id",
        help="Approved test camera for an authenticated WSS session",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    base = args.url.rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.username
    ):
        parser.error(
            "--url must be an HTTPS origin without credentials, path, query or fragment"
        )
    password = os.getenv("TABLEWATCH_CHECK_PASSWORD") or getpass.getpass(
        "Deployment password: "
    )
    auth = "Basic " + base64.b64encode(f"{args.user}:{password}".encode()).decode()
    context = ssl.create_default_context(
        cafile=str(args.ca_file) if args.ca_file else None
    )
    results = []
    skipped = []

    def request(path, *, method="GET", authorized=True, headers=None, body=None):
        headers = {**({"Authorization": auth} if authorized else {}), **(headers or {})}
        if body is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        req = urllib.request.Request(
            base + path, data=body, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, context=context, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    for path in ("/", "/api/health", "/api/sources/proxy-check/assets/video.mp4"):
        status, headers, _ = request(path, authorized=False)
        assert status == 401 and "Basic" in headers.get("WWW-Authenticate", ""), (
            path,
            status,
        )
    assert (
        request("/api/health", headers={"Authorization": "Basic aW52YWxpZDppbnZhbGlk"})[
            0
        ]
        == 401
    )
    results.append("UI, API and media reject missing/incorrect credentials")
    status, headers, body = request("/")
    assert (
        status == 200
        and "text/html" in headers.get("Content-Type", "")
        and b'id="root"' in body
    )
    status, _, body = request("/api/health", headers={"Origin": base})
    assert status == 200
    health = json.loads(body)
    assert health["available"] is True
    assert (
        request("/api/health", headers={"Origin": "https://unlisted.invalid"})[0] == 403
    )
    results.append("Authenticated UI/API and exact-origin enforcement over HTTPS")

    from websockets.exceptions import InvalidStatus
    from websockets.sync.client import connect

    ws_base = "wss://" + parsed.netloc
    denied_url = ws_base + "/api/live/proxy-check/stream"
    try:
        with connect(denied_url, ssl=context, origin=base, open_timeout=10):
            raise AssertionError("Unauthenticated WebSocket was accepted")
    except InvalidStatus as error:
        assert error.response.status_code == 401
    results.append("WebSocket upgrade requires proxy authentication")

    if args.video_source_id:
        status, _, body = request(
            "/api/sources/" + urllib.parse.quote(args.video_source_id, safe="")
        )
        assert status == 200
        source = json.loads(body)
        assert source["kind"] == "video" and source["media_url"].startswith(
            "/api/sources/"
        )
        status, headers, body = request(
            source["media_url"], headers={"Range": "bytes=0-31", "Origin": base}
        )
        assert (
            status == 206
            and headers.get("Content-Range", "").startswith("bytes 0-31/")
            and len(body) == 32
        )
        results.append(
            "Authenticated video byte-range response passes through the proxy"
        )
    else:
        skipped.append("Video byte-range: provide --video-source-id")

    if args.camera_source_id:
        assert (
            health.get("active") is None
        ), "A processing job is active; use a dedicated test deployment"
        status, _, body = request(
            "/api/live",
            method="POST",
            headers={"Origin": base},
            body={"source_id": args.camera_source_id, "detection_only": True},
        )
        assert status == 201, (status, body.decode())
        session = json.loads(body)
        session_path = "/api/live/" + session["session_id"]
        try:
            try:
                with connect(
                    ws_base + session["ws_url"],
                    ssl=context,
                    origin="https://unlisted.invalid",
                    additional_headers={"Authorization": auth},
                    open_timeout=10,
                ):
                    raise AssertionError("Unlisted WebSocket origin was accepted")
            except InvalidStatus as error:
                assert error.response.status_code == 403
            with connect(
                ws_base + session["ws_url"],
                ssl=context,
                origin=base,
                additional_headers={"Authorization": auth},
                open_timeout=10,
            ) as socket:
                socket.send(json.dumps({"type": "sync", "client_t": 0}))
                deadline = time.monotonic() + 15
                while True:
                    message = json.loads(
                        socket.recv(timeout=max(0.1, deadline - time.monotonic()))
                    )
                    if message.get("type") == "clock":
                        assert isinstance(message["t"], (int, float))
                        break
                    assert time.monotonic() < deadline, "No WSS clock reply"
                socket.send(json.dumps({"type": "stop"}))
                while True:
                    message = json.loads(socket.recv(timeout=15))
                    if message.get("type") == "stopped":
                        break
            results.append(
                "Authenticated WSS clock/stop exchange; unlisted WSS origin rejected"
            )
        finally:
            request(session_path, method="DELETE", headers={"Origin": base})
    else:
        skipped.append(
            "Authenticated WSS exchange and blocked WSS origin: provide --camera-source-id"
        )

    report = {
        "status": "passed",
        "evidence_kind": "https_proxy_integration",
        "checks": results,
        "skipped": skipped,
        "physical_camera_test": False,
        "restaurant_accuracy": None,
    }
    text = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text)
    print(text, end="")


if __name__ == "__main__":
    main()
