"""Convert the scenario station CSV into the validated station catalog format.

This script only creates a new CSV. It does not connect to or modify PostGIS.
Real station identifiers, names, addresses and WGS84 coordinates are preserved.
All derived operational fields are explicitly listed in ``simulatedFields``.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from backend.catalog.station_catalog import FIELDS, read_catalog


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUT = ROOT / "data" / "managed" / "scenario-v1" / "01_充电站模拟属性.csv"
DEFAULT_OUTPUT = ROOT / "data" / "managed" / "scenario-v1" / "stations-scenario-v1.csv"
DATASET_ID = "weidu-scenario-attributes-v1"
SIMULATED_FIELDS = [
    "siteType",
    "chargeType",
    "totalCount",
    "fastCount",
    "regularCount",
    "powerKw",
    "electricityPrice",
    "servicePrice",
    "parkingFee",
    "openingHours",
    "status",
]


def integer(value: str, field: str, line: int) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"第{line}行 {field} 不是数字：{value!r}") from error
    if number < 0 or not number.is_integer():
        raise ValueError(f"第{line}行 {field} 必须是非负整数：{value!r}")
    return int(number)


def number(value: str, field: str, line: int) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"第{line}行 {field} 不是数字：{value!r}") from error
    if result < 0:
        raise ValueError(f"第{line}行 {field} 不能为负数：{value!r}")
    return result


def catalog_status(value: str) -> str:
    return {
        "开放": "active",
        "限时开放": "active",
        "情景维护": "maintenance",
        "限制使用": "offline",
        "暂不可用": "offline",
    }.get(value, "offline")


def convert(input_path: Path, output_path: Path) -> dict:
    with input_path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {
            "station_id", "station_name", "address", "lon_wgs84", "lat_wgs84",
            "local_context", "simulated_open_status", "simulated_business_hours",
            "simulated_fast_connectors", "simulated_slow_connectors",
            "simulated_dc_kw_per_connector", "simulated_ac_kw_per_connector",
            "service_fee_cny_per_kwh", "total_price_flat_cny_per_kwh",
            "parking_fee_cny_per_hour", "status_value_basis", "simulation_version",
        }
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"模拟充电站CSV缺少字段：{sorted(missing)}")
        source_rows = list(reader)

    output_rows = []
    seen_ids = set()
    for line, source in enumerate(source_rows, 2):
        station_id = source["station_id"].strip()
        if not station_id or station_id in seen_ids:
            raise ValueError(f"第{line}行站点ID为空或重复：{station_id!r}")
        seen_ids.add(station_id)

        fast = integer(source["simulated_fast_connectors"], "快充枪数", line)
        regular = integer(source["simulated_slow_connectors"], "普通充电枪数", line)
        service_price = number(source["service_fee_cny_per_kwh"], "服务费", line)
        flat_total = number(source["total_price_flat_cny_per_kwh"], "平段总价", line)
        electricity_price = round(max(0.0, flat_total - service_price), 4)
        power = number(
            source["simulated_dc_kw_per_connector"] if fast else source["simulated_ac_kw_per_connector"],
            "单枪功率", line,
        )
        open_status = source["simulated_open_status"].strip()
        notes = "；".join(filter(None, [
            "名称、地址和坐标为原始采集字段，运营属性为文献约束的情景模拟",
            f"模拟开放状态={open_status}",
            f"状态依据={source['status_value_basis'].strip()}",
            f"模拟版本={source['simulation_version'].strip()}",
        ]))
        output_rows.append({
            "id": station_id,
            "name": source["station_name"].strip(),
            "address": source["address"].strip(),
            "longitude": source["lon_wgs84"].strip(),
            "latitude": source["lat_wgs84"].strip(),
            "coordSystem": "WGS84",
            "city": "许昌市",
            "district": "魏都区",
            "operator": "",
            "siteType": source["local_context"].strip(),
            "chargeType": "fast" if fast else "regular",
            "totalCount": fast + regular,
            "fastCount": fast,
            "regularCount": regular,
            "availableCount": "",
            "powerKw": power,
            "electricityPrice": electricity_price,
            "servicePrice": service_price,
            "parkingFee": number(source["parking_fee_cny_per_hour"], "停车费", line),
            "openingHours": source["simulated_business_hours"].strip(),
            "status": catalog_status(open_status),
            "isSynthetic": "false",
            "dataSource": "real-location-simulated-attributes",
            "datasetId": DATASET_ID,
            "observedAt": "",
            "notes": notes,
            "simulatedFields": json.dumps(SIMULATED_FIELDS, ensure_ascii=False, separators=(",", ":")),
        })

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(output_rows)

    validated = read_catalog(output_path)
    if len(validated) != len(source_rows):
        raise RuntimeError("转换后的记录数与源文件不一致")
    for source, target in zip(source_rows, validated):
        if (
            source["station_id"].strip() != target["id"]
            or source["station_name"].strip() != target["name"]
            or float(source["lon_wgs84"]) != target["longitude"]
            or float(source["lat_wgs84"]) != target["latitude"]
        ):
            raise RuntimeError(f"名称或坐标保持检查失败：{source['station_id']}")

    return {
        "input": str(input_path),
        "output": str(output_path),
        "records": len(validated),
        "real_locations": sum(not row["isSynthetic"] for row in validated),
        "records_with_simulated_attributes": sum(bool(row["simulatedFields"]) for row in validated),
        "name_coordinate_check": "passed",
        "database_modified": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="准备充电站情景属性导入CSV（不修改数据库）")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    report = convert(args.input.resolve(), args.output.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
