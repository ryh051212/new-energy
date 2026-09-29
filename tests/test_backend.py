import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend import main


class StationsApiTests(unittest.TestCase):
    @patch.dict("os.environ", {"DB_PASSWORD": "test-password"})
    @patch.object(main.psycopg2, "connect")
    def test_query_with_and_without_name(self, connect):
        cursor = connect.return_value.cursor.return_value.__enter__.return_value
        cursor.fetchall.return_value = [("station-1", "测试充电站", "测试地址", 113.8, 34.0)]

        result = main.get_stations("测试")
        sql, params = cursor.execute.call_args.args
        self.assertIn("WHERE name ILIKE %s", sql)
        self.assertEqual(params, ("%测试%",))
        self.assertEqual(result["features"][0]["geometry"]["coordinates"], [113.8, 34.0])
        self.assertTrue(connect.return_value.close.called)

        cursor.execute.reset_mock()
        main.get_stations()
        self.assertNotIn("WHERE", cursor.execute.call_args.args[0])
        self.assertEqual(len(cursor.execute.call_args.args), 1)

    @patch.dict("os.environ", {"DB_PASSWORD": ""})
    def test_missing_password_returns_service_error(self):
        with self.assertRaises(HTTPException) as raised:
            main.get_stations()
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
