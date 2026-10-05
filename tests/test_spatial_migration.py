import unittest

from backend.spatial_migration import convert_geometry
from backend.coordinate_transform import wgs84_to_gcj02


class GeometryConversionTests(unittest.TestCase):
    def test_point_converts_coordinates_and_preserves_height(self):
        original = {"type": "Point", "coordinates": [113.8668, 34.035164, 12]}
        converted, metrics = convert_geometry(original)
        self.assertNotEqual(converted["coordinates"][:2], original["coordinates"][:2])
        self.assertEqual(converted["coordinates"][2], 12)
        self.assertEqual(original["coordinates"], [113.8668, 34.035164, 12])
        check = wgs84_to_gcj02(*converted["coordinates"][:2])
        for actual, expected in zip(check, original["coordinates"][:2]):
            self.assertAlmostEqual(actual, expected, places=7)
        self.assertLess(metrics["max_roundtrip_error_degrees"], 1e-7)

    def test_multipolygon_preserves_hole_and_ring_closure(self):
        outer = [[113.8, 34.0], [113.9, 34.0], [113.9, 34.1], [113.8, 34.0]]
        hole = [[113.84, 34.02], [113.85, 34.02], [113.85, 34.03], [113.84, 34.02]]
        original = {"type": "MultiPolygon", "coordinates": [[outer, hole], [outer]]}
        converted, metrics = convert_geometry(original)
        self.assertEqual(len(converted["coordinates"]), 2)
        self.assertEqual(len(converted["coordinates"][0]), 2)
        for polygon in converted["coordinates"]:
            for ring in polygon:
                self.assertEqual(ring[0], ring[-1])
        self.assertEqual(metrics["vertices"], 12)

    def test_invalid_coordinates_fail_before_conversion(self):
        for coordinates in ([181, 34], [113, float("nan")], [True, 34], [113], []):
            with self.subTest(coordinates=coordinates):
                with self.assertRaises(ValueError):
                    convert_geometry({"type": "Point", "coordinates": coordinates})


if __name__ == "__main__":
    unittest.main()
