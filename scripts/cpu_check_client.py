"""Connection settings shared by checks run against an isolated CPU service."""

import os
from urllib.parse import urlsplit


def check_base_url() -> str:
    base = os.getenv("TABLEWATCH_CHECK_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "TABLEWATCH_CHECK_BASE_URL must be an HTTP(S) origin without credentials or a path"
        )
    return base


def websocket_base_url(base: str) -> str:
    parsed = urlsplit(base)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}"
