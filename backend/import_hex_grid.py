"""按稳定的网格 ID 更新分析结果；保留已有表结构和其他数据。"""

import json
import math
import sys
from contextlib import closing
from pathlib import Path
from typing import TypeGuard

if __package__:
    from .database import get_db_connection
    from .geometry_import import update_geometry
    from .spatial_migration import source_srid, recalculate_indicators
else:
    from database import get_db_connection
    from geometry_import import update_geometry
    from spatial_migration import source_srid, recalculate_indicators

GEOJSON_PATH = Path(__file__).resolve().parent.parent / "public/geojson/hex-grid.json"
COUNT_FIELDS = ("stationCount", "residentialCount", "commercialCount")
INDEX_FIELDS = ("residentialNorm", "commercialNorm", "demandIndex", "supplyIndex", "mismatchIndex")
CLASSIFICATIONS = {
    "high-demand-low-supply", "high-demand-high-supply",
    "low-demand-high-supply", "low-demand-low-supply",
}


def _is_valid_number(value) -> TypeGuard[int | float]:
    """接受有限的 int/float，但拒绝 None、bool 和非数值字符串。

    返回 TypeGuard 而非普通 bool，让类型检查器在通过校验后
    把 value 收窄为 int | float，后续比较和入库才不会被判为 None。
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def read_grid_rows(path=GEOJSON_PATH):
    
    """先验证整份输入，避免坏数据导致部分导入。"""
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if data.get("type") != "FeatureCollection" or not data.get("features"):
        raise ValueError("网格文件必须是非空 FeatureCollection")
    rows, ids = [], set()
    for feature in data["features"]:
        properties = feature.get("properties") or {}
        grid_id = properties.get("id", feature.get("id"))
        if type(grid_id) is not int or grid_id <= 0 or grid_id in ids:
            raise ValueError(f"网格 ID 必须是唯一正整数：{grid_id}")
        ids.add(grid_id)
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Polygon" or not geometry.get("coordinates"):
            raise ValueError(f"网格 {grid_id} 缺少 Polygon 几何")
        # 用显式循环收集字段：校验通过后 value 已被收窄为数值类型，
        # counts / indices 因此是 list[int | float]，后续比较才有类型保证。
        counts = []
        for field in COUNT_FIELDS:
            value = properties.get(field)
            if not _is_valid_number(value) or value < 0:
                raise ValueError(f"网格 {grid_id} 的数量字段必须为非负整数")
            counts.append(value)
        indices = []
        for field in INDEX_FIELDS:
            value = properties.get(field)
            if not _is_valid_number(value):
                raise ValueError(f"网格 {grid_id} 缺少有效分析指数")
            indices.append(value)
        if any(not 0 <= value <= 1 for value in indices[:4]) or not -1 <= indices[4] <= 1:
            raise ValueError(f"网格 {grid_id} 的分析指数超出范围")
        classification = properties.get("supplyDemandType")
        if not isinstance(classification, str) or classification not in CLASSIFICATIONS:
            raise ValueError(f"网格 {grid_id} 的供需类型无效")
        rows.append((grid_id, *counts, *indices, classification, json.dumps(geometry)))
    return rows


def import_hex_grid(connection, path=GEOJSON_PATH):
    """调用方管理事务，可提交整批更新，也可回滚试运行。"""
    rows = read_grid_rows(path)
    try:
        with connection.cursor() as cursor:
            for row in rows:
                cursor.execute("""
                    INSERT INTO hex_grid (
                        id, station_count, residential_count, commercial_count,
                        residential_norm, commercial_norm, demand_index, supply_index,
                        mismatch_index, supply_demand_type
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        station_count = EXCLUDED.station_count,
                        residential_count = EXCLUDED.residential_count,
                        commercial_count = EXCLUDED.commercial_count,
                        residential_norm = EXCLUDED.residential_norm,
                        commercial_norm = EXCLUDED.commercial_norm,
                        demand_index = EXCLUDED.demand_index,
                        supply_index = EXCLUDED.supply_index,
                        mismatch_index = EXCLUDED.mismatch_index,
                        supply_demand_type = EXCLUDED.supply_demand_type
                """, row[:10])
                update_geometry(cursor, "hex_grid", row[0], json.loads(row[10]))
            if source_srid(cursor, "hex_grid") == 4326:
                recalculate_indicators(cursor)
        return len(rows)
    except Exception:
        connection.rollback()
        raise


def main():
    try:
        with closing(get_db_connection()) as connection:
            with connection:
                count = import_hex_grid(connection)
        print(f"六边形更新完成，共处理 {count} 个网格")
    except Exception as exc:
        print(f"六边形网格导入失败：{exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
