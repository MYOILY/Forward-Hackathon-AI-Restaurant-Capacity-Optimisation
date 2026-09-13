"""Strict JSONL bridge to the production TypeScript source-time scheduler."""

from __future__ import annotations

import json
import selectors
import subprocess
import tempfile


def validate_assessment_identity(request, result):
    if (
        not isinstance(request, dict)
        or not isinstance(result, dict)
        or result.get("request_id") != request.get("id")
    ):
        raise ValueError("Assessment request identity mismatch")
    keys = [
        "table_id",
        "t",
        "frame_index",
        "generation",
        "video_sha256",
        "geometry_sha256",
        "reference_sha256",
    ]
    if (
        request.get("surface_method") is not None
        or result.get("surface_method") is not None
    ):
        keys.extend(("surface_method", "baseline_sha256", "config_sha256"))
    if (
        request.get("timing_profile") is not None
        or result.get("timing_profile") is not None
    ):
        keys.append("timing_profile")
    for key in keys:
        if (
            key not in request
            or key not in result
            or result[key] != request[key]
            or type(result[key]) is bool
        ):
            raise ValueError(f"Assessment {key} identity mismatch")


class TSPlannerProcess:
    def __init__(self, command, *, cwd=None, timeout_s=30):
        if (
            not isinstance(command, list)
            or not command
            or any(not isinstance(item, str) for item in command)
        ):
            raise ValueError("Planner command must be an argument list")
        self.timeout_s = timeout_s
        self.stderr = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.stderr,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _diagnostic(self):
        self.stderr.flush()
        self.stderr.seek(0)
        return self.stderr.read()[-2000:]

    def send(self, message):
        if self.process.poll() is not None:
            raise ValueError(f"TypeScript planner exited: {self._diagnostic()}")
        try:
            self.process.stdin.write(
                json.dumps(message, allow_nan=False, separators=(",", ":")) + "\n"
            )
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise ValueError(
                f"TypeScript planner pipe failed: {self._diagnostic()}"
            ) from exc
        if not self.selector.select(self.timeout_s):
            raise ValueError(
                f"TypeScript planner response timeout: {self._diagnostic()}"
            )
        line = self.process.stdout.readline()
        try:
            result = json.loads(line)
        except (ValueError, TypeError) as exc:
            raise ValueError(
                f"Invalid TypeScript planner protocol response: {line[:300]} {self._diagnostic()}"
            ) from exc
        if (
            not isinstance(result, dict)
            or "error" in result
            or not isinstance(result.get("snapshot"), dict)
            or not isinstance(result.get("requests"), list)
        ):
            raise ValueError(f"TypeScript planner rejected command: {result}")
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        self.selector.close()
        self.process.stdout.close()
        self.stderr.close()
