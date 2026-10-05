import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import main
from backend.import_hex_grid import GEOJSON_PATH, read_grid_rows


class GridValidationTests(unittest.TestCase):
    def check_bad_input(self, change):
        data = json.loads(GEOJSON_PATH.read_text(encoding="utf-8-sig"))
        change(data)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "grid.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                read_grid_rows(path)

    def test_duplicate_id_is_rejected(self):
        self.check_bad_input(lambda data: data["features"].append(data["features"][0]))

    def test_missing_normalization_is_rejected(self):
        self.check_bad_input(lambda data: data["features"][0]["properties"].pop("residentialNorm"))

    def test_nonfinite_index_is_rejected(self):
        self.check_bad_input(lambda data: data["features"][0]["properties"].update(demandIndex=float("nan")))

    def test_none_index_is_rejected(self):
        self.check_bad_input(lambda data: data["features"][0]["properties"].update(demandIndex=None))


class GridApiTests(unittest.TestCase):
    @patch.object(main, "get_db_connection")
    def test_normalization_is_returned(self, connect):
        connection = connect.return_value
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = [(1, 2, 3, 4, 0.5, 0.4, 0.1,
                                        "high-demand-high-supply", 0.6, 0.4,
                                        '{"type":"Polygon","coordinates":[]}')]
        feature = main.get_hex_grid()["features"][0]
        self.assertEqual(feature["properties"]["residentialNorm"], 0.6)
        self.assertEqual(feature["properties"]["commercialNorm"], 0.4)
        connection.close.assert_called_once()

    @patch.object(main, "get_db_connection")
    def test_query_failure_still_closes_connection(self, connect):
        connection = connect.return_value
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.execute.side_effect = RuntimeError("query failed")
        with self.assertRaises(RuntimeError):
            main.get_hex_grid()
        connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
