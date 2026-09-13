"""Run the exact Lambda frame contract locally, without the persistent service.

Usage: python -m service.stateless_server --host 127.0.0.1 --port 8001
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import threading

from .stateless import LIMITS, StatelessProcessor, handle_event


def create_server(host="127.0.0.1", port=8001, *, processor=None, concurrency=10):
    processor = processor or StatelessProcessor()
    slots = threading.BoundedSemaphore(concurrency)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            # BaseHTTPRequestHandler logs the entire path supplied by the
            # client. Aggregate inference logs are emitted by handle_event.
            return

        def _send(self, status, headers, body):
            raw = body.encode("utf-8")
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            origin = os.environ.get("TABLEWATCH_ALLOWED_ORIGIN", "http://localhost:5173")
            if self.headers.get("Origin") == origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_OPTIONS(self):
            self._send(204, {"Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600", "Cache-Control": "no-store"}, "")

        def _handle(self):
            self.connection.settimeout(65)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > LIMITS["body_bytes"]:
                    self._send(413, {"Content-Type": "application/json", "Cache-Control": "no-store"}, json.dumps({"code": "payload_too_large", "error": "Request body exceeds supported size"}))
                    return
                raw = self.rfile.read(length) if length else b""
                body = raw.decode("utf-8")
            except (UnicodeError, ValueError, TimeoutError):
                self._send(400, {"Content-Type": "application/json"}, json.dumps({"code": "invalid_request", "error": "Invalid request body"}))
                return
            if not slots.acquire(blocking=False):
                self._send(429, {"Content-Type": "application/json", "Retry-After": "1", "Cache-Control": "no-store"}, json.dumps({"code": "throttled", "error": "Worker concurrency limit reached; retry the same request"}))
                return
            try:
                result = handle_event({"rawPath": self.path.split("?", 1)[0], "requestContext": {"http": {"method": self.command}}, "headers": dict(self.headers), "body": body}, processor=processor)
                self._send(result["statusCode"], result["headers"], result["body"])
            finally:
                slots.release()

        do_GET = _handle
        do_POST = _handle

    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    parser.add_argument("--concurrency", type=int, default=10)
    options = parser.parse_args()
    if options.concurrency < 1:
        parser.error("--concurrency must be positive")
    server = create_server(options.host, options.port, concurrency=options.concurrency)
    print(f"Stateless frame API: http://{options.host}:{server.server_address[1]}/frames/capabilities", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
