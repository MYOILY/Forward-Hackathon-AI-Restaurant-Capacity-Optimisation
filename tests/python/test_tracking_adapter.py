"""Independent tracker-adapter checks using deliberately reordered observed boxes."""

import numpy as np
import pytest
from processor.tracking import PeopleTracker

TABLE = {"id": "T1", "occupancy_regions": [[[0, 0], [1, 0], [1, 1], [0, 1]]]}
PERSON = {"class_id": 0, "score": 0.9, "box": [0.1, 0.1, 0.3, 0.8]}


class FakeTracker:
    instances = []

    def __init__(self, **settings):
        self.times = []
        self.settings = settings
        self.__class__.instances.append(self)

    def update(self, detections, timestamp):
        self.times.append(timestamp)
        detections = detections[np.arange(len(detections))[::-1]]
        detections.tracker_id = np.arange(len(detections)) + 10
        return detections


def test_B14_returned_box_id_order_stays_together_and_source_time_is_forwarded():
    tracker = PeopleTracker(200, 100, 24, tracker_factory=FakeTracker)
    other = {**PERSON, "box": [0.6, 0.1, 0.9, 0.8]}
    result = tracker.update([PERSON, other], [TABLE], 1.25, 30)
    np.testing.assert_allclose(result["tracks"][0]["box"], other["box"])
    assert result["tracks"][0]["track_id"].endswith(":10")
    assert tracker.tracker.times == [1.25]


def test_B08_valid_empty_is_vacancy_even_while_predicted_identity_is_retained():
    tracker = PeopleTracker(200, 100, 24, tracker_factory=FakeTracker)
    seen = tracker.update([PERSON], [TABLE], 0, 0)
    absent = tracker.update([], [TABLE], 0.1, 2)
    assert absent["tables"] == {"T1": "absent"}
    assert absent["tracks"][0]["observed"] is False
    assert absent["tracks"][0]["track_id"] == seen["tracks"][0]["track_id"]


def test_B13_failed_analysis_is_not_valid_empty_and_cannot_generate_fresh_tracks():
    tracker = PeopleTracker(200, 100, 24, tracker_factory=FakeTracker)
    tracker.update([PERSON], [TABLE], 0, 0)
    failed = tracker.update([PERSON], [TABLE], 0.1, 2, valid=False)
    assert failed["tables"] == {"T1": "uncertain"}
    assert all(not item["observed"] for item in failed["tracks"])
    assert tracker.tracker.times == [0]


@pytest.mark.parametrize("scene_cut,gap", [(True, 0.1), (False, 1.1)])
def test_B12_scene_or_long_gap_changes_namespace_and_expires_cached_identity(
    scene_cut, gap
):
    tracker = PeopleTracker(200, 100, 24, tracker_factory=FakeTracker)
    before = tracker.update([PERSON], [TABLE], 0, 0)
    after = tracker.update([PERSON], [TABLE], gap, 27, scene_cut=scene_cut)
    assert before["tracks"][0]["track_id"] != after["tracks"][0]["track_id"]
    assert len(after["tracks"]) == 1


def test_B04_unmatched_credible_boxes_use_unique_frame_scoped_ids():
    class Unmatched(FakeTracker):
        def update(self, detections, timestamp):
            detections.tracker_id = np.full(len(detections), -1)
            return detections

    tracker = PeopleTracker(200, 100, 24, tracker_factory=Unmatched)
    first = tracker.update([PERSON], [TABLE], 0, 0)
    second = tracker.update([PERSON], [TABLE], 0.1, 2)
    assert first["tables"] == second["tables"] == {"T1": "present"}
    assert first["tracks"][0]["track_id"] != second["tracks"][0]["track_id"]
    assert len(second["tracks"]) == 1
