"""Payload caps apply while receiving bytes and before decoded-pixel allocation."""

import asyncio
import base64
from io import BytesIO
import cv2
import pytest
from PIL import Image
from service.app import create_app
from service.jobs import decode_image, ServiceError
from test_service_inputs import availability


def test_chunked_multipart_stops_receiving_after_bounded_allowance(tmp_path):
    prefix = b'--BOUND\r\nContent-Disposition: form-data; name="file"; filename="large.mp4"\r\nContent-Type: video/mp4\r\n\r\n'
    body = prefix + b"x" * 100_000 + b"\r\n--BOUND--\r\n"
    chunks = [body[index : index + 4096] for index in range(0, len(body), 4096)]
    received = []
    responses = []
    app = create_app(
        tmp_path,
        dependencies={"models": availability},
        limits={"upload_bytes": 32, "disk_reserve_bytes": 0},
    )
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/videos",
        "raw_path": b"/api/videos",
        "query_string": b"",
        "root_path": "",
        "server": ("testserver", 80),
        "client": ("127.0.0.1", 123),
        "headers": [
            (b"content-type", b"multipart/form-data; boundary=BOUND"),
            (b"transfer-encoding", b"chunked"),
        ],
    }

    async def receive():
        index = len(received)
        if index >= len(chunks):
            return {"type": "http.disconnect"}
        received.append(chunks[index])
        return {
            "type": "http.request",
            "body": chunks[index],
            "more_body": index < len(chunks) - 1,
        }

    async def send(message):
        responses.append(message)

    async def run():
        async with app.router.lifespan_context(app):
            await app(scope, receive, send)

    asyncio.run(run())
    assert (
        next(
            message["status"]
            for message in responses
            if message["type"] == "http.response.start"
        )
        == 413
    )
    assert sum(map(len, received)) <= 32 + 65536 + 4096
    assert len(received) < len(chunks)


def test_large_png_header_rejects_before_opencv_pixel_decode(monkeypatch):
    stream = BytesIO()
    Image.new("RGB", (2000, 10), (150, 150, 150)).save(stream, format="PNG")
    encoded = base64.b64encode(stream.getvalue()).decode()

    def forbidden(*args, **kwargs):
        raise AssertionError("Oversized image reached OpenCV pixel allocation")

    monkeypatch.setattr(cv2, "imdecode", forbidden)
    with pytest.raises(ServiceError):
        decode_image(encoded)
