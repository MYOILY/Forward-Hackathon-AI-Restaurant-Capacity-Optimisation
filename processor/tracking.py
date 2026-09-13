"""Timestamp-aware ByteTrack adapter. No predicted box creates presence."""

from __future__ import annotations

import copy
import math

import numpy as np

from .geometry import point_in_polygon


def build_track_evidence(detections, tracker_ids, tables):
    if len(detections) != len(tracker_ids):
        raise ValueError("Detection and identity arrays must have the same length")
    tracks = []
    presence = {
        table["id"]: (
            "uncertain" if table.get("monitoring_enabled", True) is False else "absent"
        )
        for table in tables
    }
    monitored = [
        table for table in tables if table.get("monitoring_enabled", True) is not False
    ]
    for detection, track_id in zip(detections, tracker_ids):
        if detection["class_id"] != 0:
            continue
        box = detection["box"]
        centre = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        candidates = [
            table["id"]
            for table in monitored
            if any(
                point_in_polygon(centre, polygon)
                for polygon in table["occupancy_regions"]
            )
        ]
        assigned = candidates[0] if len(candidates) == 1 else None
        tracks.append(
            {
                "track_id": str(track_id),
                "box": list(box),
                "score": float(detection["score"]),
                "observed": True,
                "table_id": assigned,
                "candidate_table_ids": candidates,
            }
        )
        if assigned:
            presence[assigned] = "present"
        elif len(candidates) > 1:
            for table_id in candidates:
                if presence[table_id] != "present":
                    presence[table_id] = "uncertain"
    return tracks, presence


class PeopleTracker:
    def __init__(self, width, height, fps, clip_id="clip", tracker_factory=None):
        if width < 1 or height < 1 or not math.isfinite(fps) or fps <= 0:
            raise ValueError("Tracker needs positive source dimensions and FPS")
        self.width, self.height, self.fps, self.clip_id = (
            width,
            height,
            fps,
            str(clip_id),
        )
        self.settings = {
            "lost_track_buffer": 30,
            "frame_rate": fps,
            "track_activation_threshold": 0.4,
            "minimum_consecutive_frames": 1,
            "minimum_iou_threshold": 0.1,
            "high_conf_det_threshold": 0.3,
        }
        if tracker_factory is None:
            from trackers import ByteTrackTracker

            tracker_factory = ByteTrackTracker
        self.factory = tracker_factory
        self.tracker = self.factory(**self.settings)
        self.last_t = None
        self.scene = 0
        self.recent = {}

    def set_tables(self, tables):
        """Reassociate last-known evidence without resetting anonymous IDs."""
        for track_id, (t, track) in list(self.recent.items()):
            detection = {"class_id": 0, "score": track["score"], "box": track["box"]}
            updated, _ = build_track_evidence([detection], [track_id], tables)
            self.recent[track_id] = (t, updated[0])

    def update(self, detections, tables, t, frame_index, valid=True, scene_cut=False):
        if (
            type(t) not in (int, float)
            or not math.isfinite(t)
            or t < 0
            or (self.last_t is not None and t <= self.last_t)
        ):
            raise ValueError(
                "Tracking timestamps must strictly increase in source seconds"
            )
        if scene_cut or (self.last_t is not None and t - self.last_t > 1.0 + 1e-8):
            self.scene += 1
            self.tracker = self.factory(**self.settings)
            self.recent.clear()
        self.last_t = t
        self.recent = {
            key: value
            for key, value in self.recent.items()
            if t - value[0] <= 1.0 + 1e-8
        }
        if not valid:
            return {
                "tracks": [
                    dict(copy.deepcopy(value[1]), observed=False)
                    for value in self.recent.values()
                ],
                "tables": {table["id"]: "uncertain" for table in tables},
            }
        import supervision as sv

        people = [
            item
            for item in detections
            if item["class_id"] == 0 and item["score"] >= 0.1
        ]
        scale = np.array(
            [self.width, self.height, self.width, self.height], dtype=np.float32
        )
        input_detections = sv.Detections(
            xyxy=np.asarray([item["box"] for item in people], dtype=np.float32).reshape(
                -1, 4
            )
            * scale,
            confidence=np.array([item["score"] for item in people], dtype=np.float32),
            class_id=np.zeros(len(people), dtype=int),
        )
        tracked = self.tracker.update(input_detections, timestamp=float(t))
        observed, ids = [], []
        for index, box in enumerate(tracked.xyxy):
            score = float(tracked.confidence[index])
            identity = int(tracked.tracker_id[index])
            # Weak unmatched detections can obstruct a surface but cannot create
            # a durable identity. New credible boxes still invalidate clearance.
            if identity < 0 and score < 0.3:
                continue
            track_id = (
                f"{self.clip_id}:s{self.scene}:{identity}"
                if identity >= 0
                else f"{self.clip_id}:s{self.scene}:pending:{frame_index}:{index}"
            )
            observed.append(
                {
                    "class_id": 0,
                    "score": score,
                    "box": np.clip(box / scale, 0, 1).astype(float).tolist(),
                }
            )
            ids.append(track_id)
        tracks, presence = build_track_evidence(observed, ids, tables)
        for track in tracks:
            if ":pending:" not in track["track_id"]:
                self.recent[track["track_id"]] = (t, copy.deepcopy(track))
        observed_ids = set(ids)
        tracks.extend(
            dict(copy.deepcopy(value[1]), observed=False)
            for key, value in self.recent.items()
            if key not in observed_ids
        )
        return {"tracks": tracks, "tables": presence}
