"""Bounded, explicit JSON state for fresh stateless frame-processing requests.

The codec is deliberately pinned to trackers 2.6.0. Only XYXY Kalman state and
covariance are carried: the fixed constructor restores noise parameters and the
next timestamped prediction regenerates transition/process-noise matrices.
No class names, executable objects, pickle, or arbitrary attribute maps enter
the restoration path.
"""

from __future__ import annotations

import base64
import binascii
import copy
from importlib.metadata import version
import json
import math

import numpy as np

TRACKERS_VERSION = "2.6.0"
MAX_CHECKPOINT_BYTES = 1024 * 1024
MAX_TRACKS = 256
_COUNTERS = (
    "tracker_id", "age", "time_since_update",
    "number_of_successful_consecutive_updates",
)
_PLANES = (
    "global_gray", "global_background", "calibration_gray", "calibration_background",
)


def json_bytes(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def _keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("Checkpoint has missing or unknown fields")
    return value


def _number(value, *, minimum=0, maximum=1e9, nullable=False, integer=False):
    if value is None and nullable:
        return None
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("Checkpoint has an invalid numeric field")
    return value


def _bool(value):
    if type(value) is not bool:
        raise ValueError("Checkpoint has an invalid boolean field")
    return value


def _array(value, shape, *, minimum=-1e12, maximum=1e12):
    # Validate dimensions before numpy conversion to avoid arbitrary allocations.
    def check(item, dimensions):
        if not dimensions:
            _number(item, minimum=minimum, maximum=maximum)
        elif not isinstance(item, list) or len(item) != dimensions[0]:
            raise ValueError("Checkpoint matrix has an invalid shape")
        else:
            for child in item:
                check(child, dimensions[1:])
    check(value, shape)
    return np.asarray(value, dtype=np.float64)


def _plane_dump(value, shape):
    if value is None:
        return None
    if value.shape != shape or not np.isfinite(value).all() or np.any(value < 0) or np.any(value > 255) or np.any(value != np.floor(value)):
        raise ValueError("Surface checkpoint cannot represent this image exactly")
    return base64.b64encode(value.astype(np.uint8).tobytes()).decode("ascii")


def _plane_load(value, shape, *, as_float=False):
    if value is None:
        return None
    size = math.prod(shape)
    if not isinstance(value, str) or len(value) != 4 * math.ceil(size / 3):
        raise ValueError("Checkpoint image has an invalid encoded size")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Checkpoint image is not valid base64") from exc
    if len(raw) != size:
        raise ValueError("Checkpoint image has an invalid decoded size")
    result = np.frombuffer(raw, dtype=np.uint8).reshape(shape).copy()
    return result.astype(float) if as_float else result


def _track_evidence(value, table_ids, prefix):
    _keys(value, ("track_id", "box", "score", "observed", "table_id", "candidate_table_ids"))
    if not isinstance(value["track_id"], str) or not value["track_id"].startswith(prefix) or len(value["track_id"]) > 256:
        raise ValueError("Checkpoint contains another recording's track")
    box = _array(value["box"], (4,), minimum=0, maximum=1)
    if box[0] >= box[2] or box[1] >= box[3]:
        raise ValueError("Checkpoint track box has no area")
    _number(value["score"], maximum=1)
    _bool(value["observed"])
    candidates = value["candidate_table_ids"]
    if not isinstance(candidates, list) or len(candidates) > len(table_ids) or any(type(key) is not str or key not in table_ids for key in candidates) or len(set(candidates)) != len(candidates):
        raise ValueError("Checkpoint contains invalid table associations")
    if value["table_id"] is not None and value["table_id"] not in table_ids:
        raise ValueError("Checkpoint contains an unknown table")
    return copy.deepcopy(value)


def dump_checkpoint(session, identity):
    """Snapshot one request-local VisionSession into portable JSON primitives."""
    if version("trackers") != TRACKERS_VERSION:
        raise RuntimeError("Stateless checkpoints require trackers==2.6.0")
    people, monitor = session.tracker, session.monitor
    engine = people.tracker
    if len(engine.tracks) > MAX_TRACKS or len(people.recent) > MAX_TRACKS:
        raise ValueError("Recording exceeds the supported track count")
    tracks = []
    for track in engine.tracks:
        tracks.append({
            **{key: int(getattr(track, key)) for key in _COUNTERS},
            "time_since_update_seconds": float(track.time_since_update_seconds),
            "state": track.state_estimator.kf.state.tolist(),
            "state_covariance": track.state_estimator.kf.state_covariance.tolist(),
        })
    result = {
        "trackers_version": TRACKERS_VERSION,
        "identity": copy.deepcopy(identity),
        "last_t": session.last_t,
        "last_index": session.last_index,
        "people": {
            "last_t": people.last_t,
            "scene": people.scene,
            "next_track_id": engine._next_track_id,
            "last_timestamp": engine._last_timestamp,
            "tracks": tracks,
            "recent": {key: [float(value[0]), copy.deepcopy(value[1])] for key, value in people.recent.items()},
        },
        "surface": {
            **{key: _plane_dump(getattr(monitor, key), (90, 160)) for key in _PLANES},
            "previous": {key: _plane_dump(value, (64, 96)) for key, value in monitor.previous.items()},
            "changing": dict(monitor.changing),
            "quiet": dict(monitor.quiet),
            "camera_invalid": bool(monitor.camera_invalid),
            "camera_transform": monitor.camera_transform.tolist(),
        },
    }
    if len(json_bytes(result)) > MAX_CHECKPOINT_BYTES:
        raise ValueError("Recording checkpoint exceeds supported size")
    return result


def restore_checkpoint(session, checkpoint, identity):
    """Validate completely, then restore into a new, request-local session."""
    if version("trackers") != TRACKERS_VERSION:
        raise RuntimeError("Stateless checkpoints require trackers==2.6.0")
    if len(json_bytes(checkpoint)) > MAX_CHECKPOINT_BYTES:
        raise ValueError("Checkpoint exceeds supported size")
    _keys(checkpoint, ("trackers_version", "identity", "last_t", "last_index", "people", "surface"))
    if checkpoint["trackers_version"] != TRACKERS_VERSION:
        raise ValueError("Checkpoint tracker dependency differs from this worker")
    if checkpoint["identity"] != identity:
        raise ValueError("Checkpoint belongs to a different recording, setup, or model")
    last_t = _number(checkpoint["last_t"], nullable=True)
    last_index = _number(checkpoint["last_index"], nullable=True, integer=True)
    if (last_t is None) != (last_index is None):
        raise ValueError("Checkpoint cursor is incomplete")
    people = _keys(checkpoint["people"], ("last_t", "scene", "next_track_id", "last_timestamp", "tracks", "recent"))
    if _number(people["last_t"], nullable=True) != last_t:
        raise ValueError("Checkpoint tracker timestamp differs from its cursor")
    scene = _number(people["scene"], integer=True)
    next_id = _number(people["next_track_id"], integer=True)
    engine_t = _number(people["last_timestamp"], nullable=True)
    if engine_t is not None and (last_t is None or engine_t > last_t):
        raise ValueError("Checkpoint tracker timestamp exceeds cursor")
    if not isinstance(people["tracks"], list) or len(people["tracks"]) > MAX_TRACKS:
        raise ValueError("Checkpoint exceeds supported track count")
    from trackers.core.bytetrack.tracklet import ByteTrackTracklet
    restored_tracks, seen = [], set()
    for item in people["tracks"]:
        _keys(item, (*_COUNTERS, "time_since_update_seconds", "state", "state_covariance"))
        counters = {key: _number(item[key], integer=True, minimum=-1 if key == "tracker_id" else 0) for key in _COUNTERS}
        track_id = counters["tracker_id"]
        if track_id >= 0:
            if track_id >= next_id or track_id in seen:
                raise ValueError("Checkpoint track allocator is inconsistent")
            seen.add(track_id)
        seconds = _number(item["time_since_update_seconds"])
        state = _array(item["state"], (8, 1))
        covariance = _array(item["state_covariance"], (8, 8))
        if not np.allclose(covariance, covariance.T, atol=1e-8) or np.linalg.eigvalsh(covariance).min() < -1e-8:
            raise ValueError("Checkpoint covariance must be positive semidefinite")
        track = ByteTrackTracklet(np.array([0., 0., 1., 1.]))
        saved = track.state_estimator.get_state()
        saved["state"], saved["state_covariance"] = state, covariance
        track.state_estimator.set_state(saved)
        for key, value in counters.items():
            setattr(track, key, value)
        track.time_since_update_seconds = seconds
        restored_tracks.append(track)
    table_ids = {table["id"] for table in session.tables}
    recent = people["recent"]
    if not isinstance(recent, dict) or len(recent) > MAX_TRACKS:
        raise ValueError("Checkpoint exceeds supported recent tracks")
    restored_recent = {}
    for key, value in recent.items():
        if not isinstance(value, list) or len(value) != 2:
            raise ValueError("Checkpoint recent track must include timestamp and evidence")
        t = _number(value[0])
        track = _track_evidence(value[1], table_ids, session.session_id + f":s{scene}:")
        if track["track_id"] != key or last_t is None or t > last_t or last_t - t > 1.00000001:
            raise ValueError("Checkpoint recent track identity/time is inconsistent")
        restored_recent[key] = (t, track)
    surface = _keys(checkpoint["surface"], (*_PLANES, "previous", "changing", "quiet", "camera_invalid", "camera_transform"))
    planes = {key: _plane_load(surface[key], (90, 160)) for key in _PLANES}
    if len({value is None for value in planes.values()}) != 1:
        raise ValueError("Checkpoint camera images are incomplete")
    previous = surface["previous"]
    if not isinstance(previous, dict) or not set(previous) <= table_ids:
        raise ValueError("Checkpoint contains unknown surface tables")
    restored_previous = {key: _plane_load(value, (64, 96), as_float=True) for key, value in previous.items()}
    if any(value is None for value in restored_previous.values()):
        raise ValueError("Checkpoint previous table images cannot be null")
    _keys(surface["changing"], table_ids)
    _keys(surface["quiet"], table_ids)
    changing = {key: _bool(value) for key, value in surface["changing"].items()}
    quiet = {key: _number(value, integer=True) for key, value in surface["quiet"].items()}
    invalid = _bool(surface["camera_invalid"])
    transform = _array(surface["camera_transform"], (3, 3))
    if not np.array_equal(transform[2], [0., 0., 1.]):
        raise ValueError("Checkpoint camera transform is not affine")
    session.last_t, session.last_index = last_t, last_index
    session.tracker.last_t, session.tracker.scene = last_t, scene
    session.tracker.recent = restored_recent
    engine = session.tracker.tracker
    engine._last_timestamp, engine._next_track_id, engine.tracks = engine_t, next_id, restored_tracks
    for key, value in planes.items():
        setattr(session.monitor, key, value)
    session.monitor.previous = restored_previous
    session.monitor.changing, session.monitor.quiet = changing, quiet
    session.monitor.camera_invalid, session.monitor.camera_transform = invalid, transform
