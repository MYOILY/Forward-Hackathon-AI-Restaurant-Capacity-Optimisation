"""Exercise isolated frame/checkpoint chains without storing or logging media.

Defaults to ten concurrent synthetic sessions. This is a transport and CPU load
check, not restaurant-accuracy evidence. --request-file accepts an observe-batch
JSON body; its frame sequence is repeated at increasing sample timestamps.
"""

from __future__ import annotations

import argparse
import base64
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import struct
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
LIMITS = json.loads((ROOT / "shared" / "frame-batch-limits.json").read_text())


class LoadFailure(ValueError):
    pass


def json_bytes(value):
    return json.dumps(value, allow_nan=False, separators=(",", ":")).encode()


def synthetic_request(capabilities=None):
    """A small generated PNG, never written to disk or presented as real footage."""
    width, height = 160, 90
    def chunk(kind, raw):
        return struct.pack(">I", len(raw)) + kind + raw + struct.pack(">I", zlib.crc32(kind + raw))
    pixels = b"".join(b"\0" + bytes([110, 140, 160]) * width for _ in range(height))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")
    digest = hashlib.sha256(png).hexdigest()
    image = {"width": width, "height": height, "sha256": digest, "image_base64": base64.b64encode(png).decode()}
    polygon = [[.1, .1], [.9, .1], [.9, .9], [.1, .9]]
    request = {
        "request_id": "synthetic", "run_id": "synthetic", "revision": 0,
        "source": {"sha256": hashlib.sha256(b"stateless-load-synthetic-recording").hexdigest(), "width": width, "height": height, "fps": 30, "duration_s": 600},
        "tables": [{"id": "T1", "label": "Synthetic table", "tabletop_polygon": polygon, "occupancy_regions": [polygon], "map": {"x": .5, "y": .5, "w": .5, "h": .5, "shape": "rect"}}],
        "frames": [{**image, "t": i / 10, "sample_index": i} for i in range(2)],
        "checkpoint": None,
    }
    if capabilities is not None:
        request.update({key: capabilities[key] for key in ("model_sha256", "config_sha256", "build_id")})
    return request


def validate_url(value):
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.hostname:
        raise LoadFailure("Use a plain API origin without credentials, query or fragment")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
        raise LoadFailure("Use HTTPS for a remote endpoint, or HTTP on loopback")
    return value.rstrip("/")


def http_transport(url, body, timeout, origin=None):
    headers = {"accept": "application/json"}
    if body is not None:
        headers["content-type"] = "application/json"
    if origin:
        headers["origin"] = origin
    request = Request(url, data=body, headers=headers)
    try:
        response = urlopen(request, timeout=timeout)
    except HTTPError as error:
        response = error
    except (URLError, TimeoutError, OSError) as error:
        raise LoadFailure("network_error") from error
    with response:
        raw = response.read(LIMITS["body_bytes"] + 1)
        if len(raw) > LIMITS["body_bytes"]:
            raise LoadFailure("response_too_large")
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            payload = None
        return response.status, dict(response.headers.items()), payload


def post_with_retry(url, encoded, *, timeout, retries, origin=None, transport=http_transport, sleeper=time.sleep):
    """Every retry sends the identical byte string and prior checkpoint."""
    attempts, statuses = 0, Counter()
    for attempt in range(retries + 1):
        attempts += 1
        try:
            status, headers, payload = transport(url, encoded, timeout, origin)
        except LoadFailure as error:
            if str(error) != "network_error" or attempt == retries:
                raise
            statuses["network_error"] += 1
            status, headers, payload = 0, {}, None
        else:
            statuses[str(status)] += 1
        if 200 <= status < 300:
            if not isinstance(payload, dict):
                raise LoadFailure("invalid_json_response")
            return payload, attempts, dict(statuses)
        # A missing model is not a transient burst; do not hammer the endpoint.
        if isinstance(payload, dict) and payload.get("code") == "model_unavailable":
            raise LoadFailure("model_unavailable")
        if status not in (0, 429, 500, 502, 503, 504) or attempt == retries:
            raise LoadFailure(f"http_{status}")
        delay = min(4.0, .25 * 2 ** attempt) * random.uniform(.8, 1.2)
        retry_after = next((value for key, value in headers.items() if key.lower() == "retry-after"), None)
        if retry_after is not None:
            try:
                delay = max(delay, min(10.0, max(0.0, float(retry_after))))
            except ValueError:
                pass
        sleeper(delay)
    raise LoadFailure("retry_exhausted")


def validate_response(request, response, capabilities):
    for key in ("request_id", "run_id", "revision"):
        if response.get(key) != request[key]:
            raise LoadFailure(f"response_identity_{key}")
    for key in ("model_sha256", "config_sha256", "build_id"):
        if response.get(key) != request[key] or request[key] != capabilities[key]:
            raise LoadFailure(f"response_build_{key}")
    checkpoint = response.get("checkpoint")
    if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get("identity"), dict):
        raise LoadFailure("missing_checkpoint")
    identity = checkpoint["identity"]
    for key in ("run_id", "revision", "source"):
        if identity.get(key) != request[key]:
            raise LoadFailure(f"checkpoint_identity_{key}")
    for key in ("model_sha256", "config_sha256", "build_id"):
        if identity.get(key) != capabilities[key]:
            raise LoadFailure(f"checkpoint_build_{key}")
    observations = response.get("observations")
    if not isinstance(observations, list) or len(observations) != len(request["frames"]):
        raise LoadFailure("observation_count")
    prefix = request["run_id"] + ":s"
    for frame, observation in zip(request["frames"], observations):
        capture = {key: frame[key] for key in ("sample_index", "t", "width", "height", "sha256")}
        if observation.get("capture") != capture or observation.get("t") != frame["t"] or observation.get("frame_index") != frame["sample_index"]:
            raise LoadFailure("observation_frame_identity")
        if any(not str(track.get("track_id", "")).startswith(prefix) for track in observation.get("tracks", [])):
            raise LoadFailure("foreign_track_identity")
    if checkpoint.get("last_index") != request["frames"][-1]["sample_index"] or checkpoint.get("last_t") != request["frames"][-1]["t"]:
        raise LoadFailure("checkpoint_did_not_advance")
    return checkpoint


def client_chain(client_index, template, args, capabilities, barrier, *, transport=http_transport):
    run_id = f"load-{uuid.uuid4().hex}-{client_index}"
    checkpoint, latencies, attempts, statuses = None, [], 0, Counter()
    base = template["frames"]
    time_span = base[-1]["t"] - base[0]["t"] + 1 / LIMITS["sample_hz"]
    index_span = base[-1]["sample_index"] - base[0]["sample_index"] + 1
    barrier.wait(timeout=30)
    for batch in range(args.batches):
        request = copy.deepcopy(template)
        request.update(request_id=f"{run_id}-{batch}", run_id=run_id, checkpoint=checkpoint)
        request.update({key: capabilities[key] for key in ("model_sha256", "config_sha256", "build_id")})
        for frame in request["frames"]:
            frame["t"] = round(frame["t"] + batch * time_span, 9)
            frame["sample_index"] += batch * index_span
        if request["frames"][-1]["t"] >= request["source"]["duration_s"]:
            raise LoadFailure("requested_chain_exceeds_source_duration")
        encoded = json_bytes(request)
        if len(encoded) > LIMITS["body_bytes"]:
            raise LoadFailure("request_with_checkpoint_too_large")
        started = time.perf_counter()
        response, count, seen = post_with_retry(args.url + "/frames/observe-batch", encoded, timeout=args.timeout, retries=args.retries, origin=args.origin, transport=transport)
        candidate = validate_response(request, response, capabilities)
        attempts += count
        statuses.update(seen)
        if args.verify_retry and batch == 0:
            repeated, count, seen = post_with_retry(args.url + "/frames/observe-batch", encoded, timeout=args.timeout, retries=args.retries, origin=args.origin, transport=transport)
            validate_response(request, repeated, capabilities)
            if repeated != response:
                raise LoadFailure("same_request_retry_changed_evidence")
            attempts += count
            statuses.update(seen)
        # Commit only after response and retry/isolation checks pass.
        checkpoint = candidate
        latencies.append(time.perf_counter() - started)
    return {"completed_batches": args.batches, "attempts": attempts, "statuses": dict(statuses), "latencies_s": latencies}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="Lambda URL or local stateless HTTP origin")
    parser.add_argument("--origin", help="Deployed CloudFront site origin, when checking allowed-origin requests")
    parser.add_argument("--clients", type=int, default=10)
    parser.add_argument("--batches", type=int, default=3)
    parser.add_argument("--retries", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=75)
    parser.add_argument("--request-file", type=Path)
    parser.add_argument("--verify-retry", action=argparse.BooleanOptionalAction, default=True, help="Repeat each client's first request before committing its checkpoint (default on)")
    args = parser.parse_args(argv)
    args.url = validate_url(args.url)
    if not 1 <= args.clients <= 100 or not 1 <= args.batches <= 100 or not 0 <= args.retries <= 8 or not math.isfinite(args.timeout) or not 1 <= args.timeout <= 120:
        raise LoadFailure("Use 1-100 clients/batches, 0-8 retries, and a 1-120 second timeout")
    template = synthetic_request()
    if args.request_file:
        if args.request_file.stat().st_size > LIMITS["body_bytes"]:
            raise LoadFailure("request_file_too_large")
        template = json.loads(args.request_file.read_text())
    if len(json_bytes(template)) > LIMITS["body_bytes"] or not isinstance(template.get("frames"), list) or not 1 <= len(template["frames"]) <= LIMITS["frames"]:
        raise LoadFailure("invalid_request_template")
    status, _, capabilities = http_transport(args.url + "/frames/capabilities", None, args.timeout, args.origin)
    if status != 200 or not isinstance(capabilities, dict) or capabilities.get("available") is not True:
        raise LoadFailure("capabilities_or_model_unavailable")
    if capabilities.get("limits") != LIMITS:
        raise LoadFailure("client_and_server_limits_differ")
    barrier = threading.Barrier(args.clients)
    started, successes, errors, latencies, attempts, statuses = time.perf_counter(), 0, Counter(), [], 0, Counter()
    with ThreadPoolExecutor(max_workers=args.clients) as pool:
        work = [pool.submit(client_chain, index, template, args, capabilities, barrier) for index in range(args.clients)]
        for future in as_completed(work):
            try:
                result = future.result()
                successes += 1
                attempts += result["attempts"]
                statuses.update(result["statuses"])
                latencies.extend(result["latencies_s"])
            except Exception as error:
                # Never print request/response data or arbitrary exception text.
                name = str(error) if isinstance(error, LoadFailure) else type(error).__name__
                errors[name if re_safe_error(name) else "unexpected_error"] += 1
    elapsed = time.perf_counter() - started
    ordered = sorted(latencies)
    report = {
        "input": "provided_frame_template" if args.request_file else "synthetic_constant_frame",
        "clients": args.clients, "batches_per_client": args.batches, "successful_clients": successes,
        "failed_clients": args.clients - successes, "errors": dict(errors), "successful_chain_attempts": attempts,
        "successful_chain_http_statuses": dict(statuses), "wall_s": round(elapsed, 3),
        "batch_latency_s_including_retry": {"p50": round(statistics.median(ordered), 3) if ordered else None, "p95": round(ordered[max(0, math.ceil(.95 * len(ordered)) - 1)], 3) if ordered else None},
        "identical_request_retry_checked": args.verify_retry,
        "maximum_clip_or_browser_acceptance": "not tested by this harness",
    }
    print(json.dumps(report, indent=2))
    return 0 if successes == args.clients else 1


def re_safe_error(value):
    return len(value) <= 80 and all(character.isalnum() or character == "_" for character in value)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (LoadFailure, OSError, ValueError, KeyError) as error:
        code = str(error) if isinstance(error, LoadFailure) and re_safe_error(str(error)) else type(error).__name__
        print(json.dumps({"load_check": "failed", "error": code}), file=sys.stderr)
        raise SystemExit(1)
