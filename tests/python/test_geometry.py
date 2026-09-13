from processor.geometry import point_in_polygon


def test_inclusive_polygon_boundary():
    polygon = [[0.1, 0.1], [0.7, 0.1], [0.7, 0.7], [0.1, 0.7]]
    assert point_in_polygon((0.1, 0.3), polygon)
    assert point_in_polygon((0.4, 0.4), polygon)
    assert not point_in_polygon((0.8, 0.8), polygon)
