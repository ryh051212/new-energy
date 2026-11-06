import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from backend.facility_catalog import CATEGORIES, ENDPOINT, matching_type, read_facilities
from backend import main


def snapshot():
    return {"source": "AMap", "endpoint": ENDPOINT, "region": "411002", "coordSystem": "GCJ-02",
        "queries": {key: {**category, "status": "complete",
            "pages": [{"page": 1, "fetchedAt": "2026-10-16T12:00:00+08:00", "reportedCount": "1"}],
            "pois": [{"id": "B" + key, "name": category["name"], "location": "113.83,34.03",
                      "typecode": category["types"], "type": category["name"], "address": []}]}
            for key, category in CATEGORIES.items()}}


class FacilityCatalogTests(unittest.TestCase):
    def read(self, data):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "amap.json"
            path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            return read_facilities(path)

    def test_converts_raw_coordinates_and_preserves_unknowns(self):
        rows, report = self.read(snapshot())
        self.assertEqual(len(rows), len(CATEGORIES))
        self.assertEqual(rows[0]["raw_lng"], 113.83)
        self.assertGreater(abs(rows[0]["lng"] - 113.83), .001)
        self.assertEqual(rows[0]["address"], "")
        self.assertEqual(report["rejected"], [])
        self.assertTrue(rows[0]["source_url"].startswith("https://www.amap.com/place/"))

    def test_unknown_or_unfinished_sources_are_rejected(self):
        for key, value in (("source", "unknown"), ("coordSystem", "WGS84"), ("region", "411000")):
            data = snapshot()
            data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.read(data)
        data = snapshot()
        data["queries"]["parking"]["status"] = "collecting"
        with self.assertRaisesRegex(ValueError, "尚未结束"):
            self.read(data)
        data = snapshot()
        del data["queries"]["school"]
        with self.assertRaisesRegex(ValueError, "缺少设施类别"):
            self.read(data)

    def test_invalid_coordinates_and_wrong_class_are_quarantined(self):
        for update in ({"location": "NaN,34"}, {"location": "181,34"},
                       {"location": "113.83,34,0"}, {"typecode": "050000"}, {"name": []}):
            data = snapshot()
            data["queries"]["parking"]["pois"][0].update(update)
            rows, report = self.read(data)
            self.assertEqual(len(report["rejected"]), 1)
            self.assertNotIn("Bparking", [row["id"] for row in rows])

    def test_id_deduplication_and_collection_limits_are_explicit(self):
        data = snapshot()
        query = data["queries"]["parking"]
        query["pois"].append(copy.deepcopy(query["pois"][0]))
        query["status"] = "page_limit"
        rows, report = self.read(data)
        self.assertEqual(len(rows), len(CATEGORIES))
        self.assertEqual(report["queries"]["parking"]["status"], "page_limit")
        self.assertFalse(report["queries"]["parking"]["exhaustive"])

    def test_type_hierarchy_keeps_hospitals_separate_from_pharmacies(self):
        self.assertTrue(matching_type("090101", "090100"))
        self.assertFalse(matching_type("090600", "090100"))
        self.assertTrue(matching_type("170201", "170000"))
        self.assertFalse(matching_type("120301", "120302"))

    def test_invalid_api_parameters_do_not_touch_database(self):
        with patch("backend.main.get_db_connection") as connect:
            for params in ({"category": "unknown"}, {"lng": 113.83, "lat": None},
                           {"lng": None, "lat": 34.03}):
                with self.subTest(params=params), self.assertRaises(HTTPException) as error:
                    main.get_facility_pois(**params)
                self.assertEqual(error.exception.status_code, 422)
            self.assertEqual(len(main.get_facility_categories()["categories"]), 12)
            connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
