"""Validated source-image geometry for table processing; never map coordinates."""

from __future__ import annotations
from collections.abc import Sequence

import hashlib
import json
import math

import cv2
import numpy as np


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _intersects(a, b, c, d):
    def on(a, b, p):
        return (
            abs(_cross(a, b, p)) <= 1e-12
            and min(a[0], b[0]) - 1e-12 <= p[0] <= max(a[0], b[0]) + 1e-12
            and min(a[1], b[1]) - 1e-12 <= p[1] <= max(a[1], b[1]) + 1e-12
        )

    ab_c, ab_d, cd_a, cd_b = (
        _cross(a, b, c),
        _cross(a, b, d),
        _cross(c, d, a),
        _cross(c, d, b),
    )
    return (
        (ab_c * ab_d < 0 and cd_a * cd_b < 0)
        or on(a, b, c)
        or on(a, b, d)
        or on(c, d, a)
        or on(c, d, b)
    )


def validate_polygon(points, quadrilateral=False):
    """Reject out-of-frame, degenerate, crossing and nonconvex tabletop quads."""
    if (
        not isinstance(points, (list, tuple))
        or len(points) < 3
        or (quadrilateral and len(points) != 4)
    ):
        raise ValueError(
            "Tabletop needs four ordered corners; occupancy needs at least three"
        )
    if any(
        not isinstance(p, (list, tuple))
        or len(p) != 2
        or any(
            type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1
            for v in p
        )
        for p in points
    ):
        raise ValueError(
            "Polygon coordinates must be finite normalized source-image points"
        )
    if len({tuple(p) for p in points}) != len(points):
        raise ValueError("Polygon has duplicate corners")
    area2 = sum(
        points[i][0] * points[(i + 1) % len(points)][1]
        - points[(i + 1) % len(points)][0] * points[i][1]
        for i in range(len(points))
    )
    if abs(area2) < 1e-8:
        raise ValueError("Polygon has no usable area")
    n = len(points)
    for i in range(n):
        for j in range(i + 1, n):
            if j == i + 1 or (i == 0 and j == n - 1):
                continue
            if _intersects(
                points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]
            ):
                raise ValueError("Polygon edges intersect")
    if quadrilateral:
        turns = [
            _cross(points[i], points[(i + 1) % n], points[(i + 2) % n])
            for i in range(n)
        ]
        if not (all(x > 1e-10 for x in turns) or all(x < -1e-10 for x in turns)):
            raise ValueError(
                "Tabletop corners must describe a strictly convex quadrilateral"
            )


def geometry_hash(tabletop_polygon, occupancy_regions=None):
    """Hash only ordered source polygons, agreeing with JS integral numbers."""
    if isinstance(tabletop_polygon, dict):
        occupancy_regions = tabletop_polygon["occupancy_regions"]
        tabletop_polygon = tabletop_polygon["tabletop_polygon"]
    validate_polygon(tabletop_polygon, quadrilateral=True)
    if not isinstance(occupancy_regions, list) or not occupancy_regions:
        raise ValueError("At least one occupancy polygon is required")
    for polygon in occupancy_regions:
        validate_polygon(polygon)

    def normalize(value):
        if isinstance(value, (tuple, list)):
            return [normalize(item) for item in value]
        return int(value) if type(value) is float and value.is_integer() else value

    value = {
        "tabletop_polygon": normalize(tabletop_polygon),
        "occupancy_regions": normalize(occupancy_regions),
    }
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def rectify_tabletop(frame_bgr, polygon, output_size=(384, 256)):
    """Warp ordered corners to TL/TR/BR/BL; tuple size is (width,height).

    An integer size sets the longest edge while preserving average opposite-edge
    proportions. Corner order is respected, never silently reordered.
    """
    validate_polygon(polygon, quadrilateral=True)
    if (
        not isinstance(frame_bgr, np.ndarray)
        or frame_bgr.dtype != np.uint8
        or frame_bgr.ndim != 3
        or frame_bgr.shape[2] != 3
        or min(frame_bgr.shape[:2]) < 2
    ):
        raise ValueError("Rectification requires a nonempty uint8 BGR frame")
    h, w = frame_bgr.shape[:2]
    source = np.asarray(polygon, dtype=np.float32) * np.array(
        [w - 1, h - 1], dtype=np.float32
    )
    if type(output_size) is int:
        if not 16 <= output_size <= 2048:
            raise ValueError("Rectification max side must be 16..2048")
        horizontal = (
            np.linalg.norm(source[1] - source[0])
            + np.linalg.norm(source[2] - source[3])
        ) / 2
        vertical = (
            np.linalg.norm(source[3] - source[0])
            + np.linalg.norm(source[2] - source[1])
        ) / 2
        scale = output_size / max(horizontal, vertical)
        output_size = (
            max(8, round(horizontal * scale)),
            max(8, round(vertical * scale)),
        )
    if (
        not isinstance(output_size, (list, tuple))
        or len(output_size) != 2
        or any(type(v) is not int or not 2 <= v <= 2048 for v in output_size)
    ):
        raise ValueError("Rectification size must contain two integers in 2..2048")
    ow, oh = output_size
    destination = np.array(
        [[0, 0], [ow - 1, 0], [ow - 1, oh - 1], [0, oh - 1]], dtype=np.float32
    )
    transform = cv2.getPerspectiveTransform(source, destination)
    if not np.isfinite(transform).all() or abs(np.linalg.det(transform)) < 1e-12:
        raise ValueError("Unstable tabletop homography")
    return cv2.warpPerspective(
        frame_bgr,
        transform,
        (ow, oh),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )


def point_in_polygon(
    point: Sequence[float], polygon: Sequence[Sequence[float]]
) -> bool:
    """Return containment, including points on an edge or vertex."""
    if len(polygon) < 3:
        raise ValueError("A seating polygon must have at least three vertices")
    x, y = map(float, point)
    inside = False
    epsilon = 1e-10
    for index, current in enumerate(polygon):
        previous = polygon[index - 1]
        ax, ay = map(float, previous)
        bx, by = map(float, current)
        cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
        if (
            abs(cross) <= epsilon
            and min(ax, bx) - epsilon <= x <= max(ax, bx) + epsilon
            and min(ay, by) - epsilon <= y <= max(ay, by) + epsilon
        ):
            return True
        if (ay > y) != (by > y):
            intersection_x = ax + (y - ay) * (bx - ax) / (by - ay)
            if x < intersection_x:
                inside = not inside
    return inside


def _expanded(box, horizontal=0.03, vertical=0.03):
    return [
        max(0.0, box[0] - horizontal),
        max(0.0, box[1] - vertical),
        min(1.0, box[2] + horizontal),
        min(1.0, box[3] + vertical),
    ]


def _polygon(box):
    x1, y1, x2, y2 = box
    return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
