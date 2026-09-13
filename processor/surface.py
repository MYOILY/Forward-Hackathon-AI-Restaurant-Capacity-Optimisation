"""Conservative visibility/change evidence; these signals never prove a reset."""

from __future__ import annotations

import copy
import cv2
import numpy as np

from .geometry import rectify_tabletop, validate_polygon


def _background_mask(shape, detections):
    """Keep person texture and a small box-edge margin out of camera evidence."""
    height, width = shape
    mask = np.full(shape, 255, np.uint8)
    for detection in detections:
        if detection["class_id"] != 0 or detection["score"] < 0.1:
            continue
        x1, y1, x2, y2 = detection["box"]
        left, top = max(0, int(np.floor(x1 * width)) - 2), max(
            0, int(np.floor(y1 * height)) - 2
        )
        right, bottom = min(width, int(np.ceil(x2 * width)) + 2), min(
            height, int(np.ceil(y2 * height)) + 2
        )
        mask[top:bottom, left:right] = 0
    return mask


def _spread(points, shape):
    """A local moving patch cannot establish motion of the whole camera."""
    height, width = shape
    points = np.asarray(points, np.float32).reshape(-1, 2)
    if len(points) < 12:
        return False
    span = np.ptp(points, axis=0)
    return (
        span[0] >= width * 0.4
        and span[1] >= height * 0.4
        and cv2.contourArea(cv2.convexHull(points)) >= width * height * 0.12
    )


def _background_transform(reference, current, reference_mask, current_mask):
    corners = cv2.goodFeaturesToTrack(reference, 100, 0.03, 7, mask=reference_mask)
    if corners is None or not _spread(corners, reference.shape):
        return None
    flowed, status, _ = cv2.calcOpticalFlowPyrLK(reference, current, corners, None)
    if flowed is None or status is None:
        return None
    points = flowed.reshape(-1, 2)
    height, width = current.shape
    usable = status.reshape(-1).astype(bool) & np.isfinite(points).all(axis=1)
    usable &= (
        (points[:, 0] >= 0)
        & (points[:, 0] < width)
        & (points[:, 1] >= 0)
        & (points[:, 1] < height)
    )
    indices = np.flatnonzero(usable)
    if len(indices) < 12:
        return None
    pixels = points[indices].astype(int)
    usable[indices] &= current_mask[pixels[:, 1], pixels[:, 0]] != 0
    if usable.sum() < 12:
        return None
    # Reject mismatches when texture disappears or another object covers it.
    first, last = corners[usable], flowed[usable]
    returned, backward_status, _ = cv2.calcOpticalFlowPyrLK(
        current, reference, last, None
    )
    if returned is None or backward_status is None:
        return None
    consistent = backward_status.reshape(-1).astype(bool) & (
        np.linalg.norm((returned - first).reshape(-1, 2), axis=1) <= 1.0
    )
    first, last = first[consistent], last[consistent]
    if not _spread(first, reference.shape) or not _spread(last, current.shape):
        return None
    affine, inliers = cv2.estimateAffinePartial2D(
        first, last, method=cv2.RANSAC, ransacReprojThreshold=1.5
    )
    if (
        affine is None
        or inliers is None
        or not np.isfinite(affine).all()
        or np.mean(inliers) < 0.8
    ):
        return None
    trusted = inliers.reshape(-1).astype(bool)
    return (
        affine
        if _spread(first[trusted], reference.shape)
        and _spread(last[trusted], current.shape)
        else None
    )


class SurfaceMonitor:
    def __init__(self, tables):
        self.tables = copy.deepcopy(tables)
        for table in tables:
            validate_polygon(table["tabletop_polygon"], quadrilateral=True)
        self.previous = {}
        self.global_gray = None
        self.global_background = None
        self.calibration_gray = None
        self.calibration_background = None
        self.camera_invalid = False
        # Register directly to the original view: slow pans still accumulate,
        # while independent inter-frame fitting errors cannot drift over time.
        self.camera_transform = np.eye(3, dtype=float)
        self.changing = {table["id"]: False for table in tables}
        self.quiet = {table["id"]: 0 for table in tables}

    def set_tables(self, tables):
        """Update reviewed regions without forgetting a camera-movement latch."""
        previous = {table["id"]: table for table in self.tables}
        for table in tables:
            validate_polygon(table["tabletop_polygon"], quadrilateral=True)
        ids = {table["id"] for table in tables}
        self.previous = {
            key: value for key, value in self.previous.items() if key in ids
        }
        for table in tables:
            old = previous.get(table["id"], {})
            changed = old.get("tabletop_polygon") != table[
                "tabletop_polygon"
            ] or old.get("monitoring_enabled", True) != table.get(
                "monitoring_enabled", True
            )
            if changed:
                self.previous.pop(table["id"], None)
                self.changing[table["id"]], self.quiet[table["id"]] = False, 0
        self.changing = {key: self.changing.get(key, False) for key in ids}
        self.quiet = {key: self.quiet.get(key, 0) for key in ids}
        self.tables = copy.deepcopy(tables)

    def update(self, frame, detections, valid=True):
        if not valid or not any(
            table.get("monitoring_enabled", True) is not False for table in self.tables
        ):
            return {
                "surface": {
                    table["id"]: {
                        "visible": None,
                        "changed": False,
                        "camera_moved": self.camera_invalid,
                    }
                    for table in self.tables
                },
                "scene_cut": False,
            }
        gray = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2GRAY)
        background = _background_mask(gray.shape, detections)
        scene_cut = False
        if self.global_gray is not None and not self.camera_invalid:
            shared_background = (background != 0) & (self.global_background != 0)
            # A passing person can replace most of an image without a scene cut.
            delta = (gray.astype(float) - self.global_gray.astype(float))[
                shared_background
            ]
            large_cut = (
                np.mean(shared_background) >= 0.2
                and len(delta) > 0
                and np.mean(np.abs(delta - np.median(delta)) > 40) > 0.65
            )
            moved = False
            affine = _background_transform(
                self.calibration_gray, gray, self.calibration_background, background
            )
            if affine is not None:
                self.camera_transform[:2] = affine
                translation = np.linalg.norm(affine[:2, 2])
                angle = abs(np.degrees(np.arctan2(affine[1, 0], affine[0, 0])))
                scale = np.hypot(affine[0, 0], affine[1, 0])
                moved = translation > 3.2 or angle > 2.0 or abs(scale - 1.0) > 0.02
            scene_cut = bool(large_cut or moved)
            self.camera_invalid = scene_cut
        self.global_gray = gray
        self.global_background = background
        if self.calibration_gray is None:
            self.calibration_gray, self.calibration_background = gray, background
        evidence = {}
        for table in self.tables:
            if table.get("monitoring_enabled", True) is False:
                evidence[table["id"]] = {
                    "visible": None,
                    "changed": False,
                    "camera_moved": self.camera_invalid,
                }
                continue
            polygon = np.asarray(table["tabletop_polygon"], dtype=np.float32)
            obscured = False
            for detection in detections:
                if detection["class_id"] != 0 or detection["score"] < 0.1:
                    continue
                x1, y1, x2, y2 = detection["box"]
                box_polygon = np.array(
                    [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], dtype=np.float32
                )
                overlap, _ = cv2.intersectConvexConvex(polygon, box_polygon)
                if overlap > 1e-8:
                    obscured = True
                    break
            visible = not obscured and not self.camera_invalid
            table_id = table["id"]
            if visible:
                patch = cv2.cvtColor(
                    rectify_tabletop(frame, table["tabletop_polygon"], (96, 64)),
                    cv2.COLOR_BGR2GRAY,
                )
                # Brightness-normalized differences intentionally ignore normal
                # lighting shifts; they must not conceal loss of usable image
                # evidence. Darkness/saturation invalidates existing clearance.
                if np.percentile(patch, 95) < 16 or np.percentile(patch, 5) > 249:
                    evidence[table_id] = {
                        "visible": False,
                        "changed": False,
                        "camera_moved": self.camera_invalid,
                    }
                    continue
                patch = cv2.GaussianBlur(patch, (5, 5), 0).astype(float)
                previous = self.previous.get(table_id)
                change = False
                if previous is not None:
                    difference = patch - previous
                    change = bool(
                        np.mean(np.abs(difference - np.median(difference)) > 15) > 0.08
                    )
                if change:
                    self.changing[table_id], self.quiet[table_id] = True, 0
                else:
                    self.quiet[table_id] += 1
                    if self.quiet[table_id] >= 2:
                        self.changing[table_id] = False
                self.previous[table_id] = patch
            evidence[table_id] = {
                "visible": visible,
                "changed": self.changing[table_id] if visible else False,
                "camera_moved": self.camera_invalid,
            }
        return {"surface": evidence, "scene_cut": scene_cut}
