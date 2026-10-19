"""充电站 CSV 维护、验证和 PostGIS 同步。坐标必须显式指定，空属性保留为未知。"""

import argparse
import csv
import json
import math
from contextlib import closing
from datetime import datetime
from pathlib import Path

from psycopg2.extras import Json

if __package__:
    from .station_access import station_access_guide
    from .station_verification import apply_station_verification
    from .database import get_db_connection
    from .coordinate_transform import gcj02_to_wgs84, wgs84_to_gcj02
    from .spatial_migration import backup_database, recalculate_indicators
else:
    from station_access import station_access_guide
    from station_verification import apply_station_verification
    from database import get_db_connection
    from coordinate_transform import gcj02_to_wgs84, wgs84_to_gcj02
    from spatial_migration import backup_database, recalculate_indicators

ROOT = Path(__file__).resolve().parent.parent
DEMO_DATASET = "xuchang-demo-v1"
FIELDS = ["id", "name", "address", "longitude", "latitude", "coordSystem", "city", "district",
          "operator", "siteType", "chargeType", "totalCount", "fastCount", "regularCount",
          "availableCount", "powerKw", "electricityPrice", "servicePrice", "parkingFee",
          "openingHours", "status", "isSynthetic", "dataSource", "datasetId", "observedAt", "notes", "simulatedFields"]
INTEGER_FIELDS = ("totalCount", "fastCount", "regularCount", "availableCount")
NUMBER_FIELDS = ("powerKw", "electricityPrice", "servicePrice", "parkingFee")
SIMULATABLE_FIELDS = {"address", "city", "district", "operator", "siteType", "chargeType", *INTEGER_FIELDS,
                     *NUMBER_FIELDS, "openingHours", "status", "observedAt"}
PROPERTY_COLUMNS = {
    "city": "city", "district": "district", "operator": "operator", "siteType": "site_type",
    "chargeType": "charge_type", "totalCount": "total_count", "fastCount": "fast_count",
    "regularCount": "regular_count", "availableCount": "available_count", "powerKw": "power_kw",
    "electricityPrice": "electricity_price", "servicePrice": "service_price", "parkingFee": "parking_fee",
    "openingHours": "opening_hours", "status": "status", "isSynthetic": "is_synthetic",
    "dataSource": "data_source", "datasetId": "dataset_id", "observedAt": "observed_at", "notes": "notes",
    "simulatedFields": "simulated_fields",
}


def read_catalog(path):
    """完整验证后才允许写入；CSV 使用 UTF-8，支持 Excel 保存的 BOM。"""
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        headers = set(reader.fieldnames or [])
        if "slowCount" in headers and "regularCount" in headers:
            raise ValueError("请只保留 regularCount 列，不能同时填写旧 slowCount 列")
        normalized_headers = (headers - {"slowCount"}) | ({"regularCount"} if "slowCount" in headers else set())
        required = set(FIELDS) - {"simulatedFields"}
        if not reader.fieldnames or required - normalized_headers:
            raise ValueError(f"缺少 CSV 列：{sorted(required - normalized_headers)}")
        unknown = normalized_headers - set(FIELDS)
        if unknown:
            raise ValueError(f"未知列（请检查拼写）：{sorted(unknown)}")
        rows = []
        ids = set()
        for line, raw in enumerate(reader, 2):
            if None in raw or any(value is None for value in raw.values()):
                raise ValueError(f"第 {line} 行列数不一致")
            row = {key: value.strip() for key, value in raw.items()}
            if "slowCount" in row:
                row["regularCount"] = row.pop("slowCount")
            if row.get("chargeType") == "slow":
                row["chargeType"] = "regular"
            row.setdefault("simulatedFields", "[]")
            try:
                if not row["id"] or not row["name"] or row["id"] in ids:
                    raise ValueError("ID/名称不能为空，ID 不可重复")
                ids.add(row["id"])
                if row["coordSystem"] not in ("WGS84", "GCJ-02"):
                    raise ValueError("coordSystem 只能为 WGS84 或 GCJ-02")
                longitude, latitude = float(row["longitude"]), float(row["latitude"])
                if not math.isfinite(longitude) or not math.isfinite(latitude) or not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
                    raise ValueError("经纬度无效")
                row["longitude"], row["latitude"] = longitude, latitude
                for field in INTEGER_FIELDS + NUMBER_FIELDS:
                    value = row[field]
                    row[field] = None if value == "" else float(value)
                    if row[field] is not None:
                        if not math.isfinite(row[field]) or row[field] < 0:
                            raise ValueError(f"{field} 必须是有限非负数，未知请留空")
                        if field in INTEGER_FIELDS:
                            if not row[field].is_integer():
                                raise ValueError(f"{field} 必须为整数")
                            row[field] = int(row[field])
                total, fast, regular, available = (row[field] for field in INTEGER_FIELDS)
                if total is not None:
                    if available is not None and available > total:
                        raise ValueError("空闲桩数不能大于总桩数")
                    if (fast or 0) + (regular or 0) > total or (fast is not None and regular is not None and fast + regular != total):
                        raise ValueError("快充桩数 + 普通充电桩数应等于总桩数")
                if row["chargeType"] not in ("fast", "regular"):
                    raise ValueError("chargeType 只能为 fast（快充）/ regular（普通充电）")
                if row["chargeType"] == "regular" and fast:
                    raise ValueError("有快充桩的站点不能标记为普通充电")
                if row["chargeType"] == "fast" and fast == 0:
                    raise ValueError("快充站的 fastCount 不能为 0")
                if row["status"] not in ("active", "maintenance", "offline", "retired"):
                    raise ValueError("status 不在允许列表中")
                if row["status"] != "active" and available not in (None, 0):
                    raise ValueError("非运营站点的空闲桩数应为 0 或未知")
                if row["isSynthetic"].lower() not in ("true", "false"):
                    raise ValueError("isSynthetic 必须明确填 true 或 false")
                row["isSynthetic"] = row["isSynthetic"].lower() == "true"
                if not row["dataSource"] or not row["datasetId"]:
                    raise ValueError("dataSource 和 datasetId 必须填写")
                if not row["city"]:
                    raise ValueError("city 必须填写")
                if row["isSynthetic"] != (row["dataSource"] == "synthetic"):
                    raise ValueError("虚拟数据的 dataSource 必须是 synthetic，真实数据不能使用 synthetic")
                if row["observedAt"]:
                    observed = datetime.fromisoformat(row["observedAt"])
                    if observed.tzinfo is None:
                        raise ValueError("observedAt 必须包含时区，例如 +08:00")
                    row["observedAt"] = observed.isoformat()
                else:
                    row["observedAt"] = None
                row["simulatedFields"] = json.loads(row["simulatedFields"] or "[]")
                fields = row["simulatedFields"]
                if not isinstance(fields, list) or any(not isinstance(field, str) or field not in SIMULATABLE_FIELDS for field in fields) or len(fields) != len(set(fields)):
                    raise ValueError("simulatedFields 必须为不重复的演示属性字段名 JSON 数组")
                rows.append(row)
            except (ValueError, TypeError) as error:
                raise ValueError(f"第 {line} 行（{row.get('id', '')}）：{error}") from error
    if not rows:
        raise ValueError("CSV 不能是空文件")
    return rows


def ensure_schema(cursor):
    cursor.execute("""DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stations' AND column_name='slow_count')
            AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='stations' AND column_name='regular_count') THEN
            ALTER TABLE stations RENAME COLUMN slow_count TO regular_count;
        END IF;
    END $$""")
    cursor.execute("""ALTER TABLE stations
        ADD COLUMN IF NOT EXISTS city text NOT NULL DEFAULT '许昌市',
        ADD COLUMN IF NOT EXISTS district text,
        ADD COLUMN IF NOT EXISTS operator text,
        ADD COLUMN IF NOT EXISTS site_type text,
        ADD COLUMN IF NOT EXISTS charge_type text NOT NULL DEFAULT 'regular',
        ADD COLUMN IF NOT EXISTS total_count integer,
        ADD COLUMN IF NOT EXISTS fast_count integer,
        ADD COLUMN IF NOT EXISTS regular_count integer,
        ADD COLUMN IF NOT EXISTS available_count integer,
        ADD COLUMN IF NOT EXISTS power_kw double precision,
        ADD COLUMN IF NOT EXISTS electricity_price double precision,
        ADD COLUMN IF NOT EXISTS service_price double precision,
        ADD COLUMN IF NOT EXISTS parking_fee double precision,
        ADD COLUMN IF NOT EXISTS opening_hours text,
        ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'existing-poi',
        ADD COLUMN IF NOT EXISTS dataset_id text NOT NULL DEFAULT 'existing-poi',
        ADD COLUMN IF NOT EXISTS observed_at timestamptz,
        ADD COLUMN IF NOT EXISTS notes text,
        ADD COLUMN IF NOT EXISTS simulated_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()
    """)
    cursor.execute("ALTER TABLE stations DROP CONSTRAINT IF EXISTS stations_catalog_values")
    cursor.execute("""UPDATE stations SET
        simulated_fields=CASE WHEN charge_type NOT IN ('fast','slow','regular') OR charge_type IS NULL
            THEN CASE WHEN simulated_fields ? 'chargeType' THEN simulated_fields ELSE simulated_fields || '["chargeType"]'::jsonb END
            ELSE simulated_fields END,
        charge_type=CASE WHEN charge_type='fast' OR fast_count>0 THEN 'fast' ELSE 'regular' END
        WHERE charge_type IS NULL OR charge_type NOT IN ('fast','regular')""")
    cursor.execute("ALTER TABLE stations ALTER COLUMN charge_type SET DEFAULT 'regular'")
    cursor.execute("""ALTER TABLE stations ADD CONSTRAINT stations_catalog_values CHECK (
                charge_type IN ('fast','regular') AND status IN ('active','maintenance','offline','retired')
                AND (total_count IS NULL OR total_count >= 0) AND (fast_count IS NULL OR fast_count >= 0)
                AND (regular_count IS NULL OR regular_count >= 0) AND (available_count IS NULL OR available_count >= 0)
                AND (total_count IS NULL OR available_count IS NULL OR available_count <= total_count)
                AND (total_count IS NULL OR fast_count IS NULL OR regular_count IS NULL OR fast_count + regular_count = total_count)
                AND (charge_type<>'regular' OR fast_count IS NULL OR fast_count=0)
                AND (charge_type<>'fast' OR fast_count IS NULL OR fast_count>0)
                AND jsonb_typeof(simulated_fields)='array'
                AND (status='active' OR available_count IS NULL OR available_count=0)
                AND (power_kw IS NULL OR power_kw >= 0 AND power_kw < 'Infinity'::float8)
                AND (electricity_price IS NULL OR electricity_price >= 0 AND electricity_price < 'Infinity'::float8)
                AND (service_price IS NULL OR service_price >= 0 AND service_price < 'Infinity'::float8)
                AND (parking_fee IS NULL OR parking_fee >= 0 AND parking_fee < 'Infinity'::float8)
                AND (is_synthetic = (data_source='synthetic'))
            )""")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_stations_dataset ON stations(dataset_id,is_synthetic)")
    cursor.execute("""CREATE TABLE IF NOT EXISTS station_imports (
        id bigserial PRIMARY KEY, imported_at timestamptz NOT NULL DEFAULT now(),
        source_file text NOT NULL, report jsonb NOT NULL)""")


def sync_catalog(connection, rows, retire_demo=False):
    if retire_demo and any(row["isSynthetic"] for row in rows):
        raise ValueError("--retire-demo 只允许用于全部为真实数据的导入文件")
    report = {"input_records": len(rows), "inserted": 0, "updated": 0, "retired_demo": 0}
    with connection.cursor() as cursor:
        cursor.execute("SET LOCAL lock_timeout = '10s'")
        cursor.execute("SELECT pg_advisory_xact_lock(4326001)")
        ensure_schema(cursor)
        columns = ["id", "name", "address", "lng", "lat", "geom", "geom_wgs84", "geom_gcj02", *PROPERTY_COLUMNS.values()]
        geometry_sql = "ST_SetSRID(ST_MakePoint(%s,%s),4326)"
        values_sql = ["%s"] * 5 + [geometry_sql, geometry_sql, "ST_SetSRID(ST_MakePoint(%s,%s),0)"] + ["%s"] * len(PROPERTY_COLUMNS)
        updates = ",".join(f"{column}=EXCLUDED.{column}" for column in columns if column != "id")
        query = f"INSERT INTO stations ({','.join(columns)}) VALUES ({','.join(values_sql)}) ON CONFLICT(id) DO UPDATE SET {updates},updated_at=now() RETURNING (xmax=0)"
        for row in rows:
            cursor.execute("SELECT is_synthetic,dataset_id FROM stations WHERE id=%s FOR UPDATE", (row["id"],))
            existing = cursor.fetchone()
            if existing and row["isSynthetic"] and (not existing[0] or existing[1] != row["datasetId"]):
                raise ValueError(f"虚拟站点 {row['id']} 不能覆盖已有非虚拟或其他批次的数据")
            lng, lat = row["longitude"], row["latitude"]
            if row["coordSystem"] == "GCJ-02":
                gcj = (lng, lat)
                lng, lat = gcj02_to_wgs84(lng, lat)
            else:
                gcj = wgs84_to_gcj02(lng, lat)
            params = [row["id"], row["name"], row["address"], lng, lat, lng, lat, lng, lat, *gcj]
            params += [Json(row[field]) if field == 'simulatedFields' else row[field] if row[field] != "" else None for field in PROPERTY_COLUMNS]
            cursor.execute(query, params)
            report["inserted" if cursor.fetchone()[0] else "updated"] += 1
        if retire_demo:
            cursor.execute("""UPDATE stations SET status='retired',available_count=0,updated_at=now()
                WHERE is_synthetic AND dataset_id=%s AND status<>'retired'""", (DEMO_DATASET,))
            report["retired_demo"] = cursor.rowcount
        report["grid_analysis"] = recalculate_indicators(cursor)
        cursor.execute("""SELECT count(*),count(*) FILTER(WHERE is_synthetic),
            count(*) FILTER(WHERE NOT is_synthetic) FROM stations WHERE status<>'retired'""")
        total, synthetic, existing = cursor.fetchone()
        report.update(active_stations=total, synthetic_stations=synthetic, existing_or_real_stations=existing)
    return report


def station_properties(station_id, name, address, record):
    """统一两类充电类型，并明确区分虚拟地点与真实地点的演示属性。"""
    properties = {"id": station_id, "name": name, "address": address, "coordSystem": "WGS84"}
    properties.update({field: record.get(column) for field, column in PROPERTY_COLUMNS.items()})
    properties["chargeType"] = 'fast' if properties["chargeType"] == 'fast' else 'regular'
    properties["regularCount"] = record.get('regular_count', record.get('slow_count'))
    properties["simulatedFields"] = record.get('simulated_fields') or []
    properties["hasSimulatedAttributes"] = bool(properties["simulatedFields"])
    properties["isSynthetic"] = bool(properties["isSynthetic"])
    properties["updatedAt"] = record.get("updated_at")
    guide = station_access_guide(station_id, name, properties['isSynthetic'])
    if guide:
        properties['accessGuide'] = guide
    properties['estimatedWaitMinutes'] = record.get('estimated_wait_minutes')
    properties['vehicleCompatible'] = record.get('vehicle_compatible')
    # 可选运营字段仅原样透传。缺失时保持未知，不由快充分类、采集或入库时间推断。
    properties.update({field: record.get(column) for field, column in {
        'chargingCurrentTypes': 'charging_current_types', 'verifiedAt': 'verified_at',
        'chargingCurrentTypesComplete': 'charging_current_types_complete',
        'availabilityIsRealtime': 'availability_is_realtime', 'availabilityUpdatedAt': 'availability_updated_at',
        'availabilityExpiresAt': 'availability_expires_at',
    }.items() if column in record})
    properties["pricePerKwh"] = (round(properties["electricityPrice"] + properties["servicePrice"], 2)
                                  if properties["electricityPrice"] is not None and properties["servicePrice"] is not None else None)
    return apply_station_verification(properties)


def export_catalog(connection, path, include_synthetic=True):
    """导出现有有效记录，用同一 CSV 格式维护真实站点和虚拟站点。"""
    if path.exists():
        raise ValueError("导出目标已存在，请另选文件名以保护已有修改")
    with connection.cursor() as cursor:
        cursor.execute("""SELECT id,name,address,ST_X(geom),ST_Y(geom),
            to_jsonb(s) - ARRAY['geom','geom_wgs84','geom_gcj02','lng','lat'] FROM stations s
            WHERE geom IS NOT NULL AND (to_jsonb(s)->>'status') IS DISTINCT FROM 'retired'
            AND (%s OR NOT COALESCE((to_jsonb(s)->>'is_synthetic')::boolean,false)) ORDER BY id""", (include_synthetic,))
        rows = []
        for row_id, name, address, lng, lat, record in cursor.fetchall():
            properties = station_properties(row_id, name, address, record)
            properties.update(longitude=lng, latitude=lat)
            properties['isSynthetic'] = str(properties['isSynthetic']).lower()
            properties['simulatedFields'] = json.dumps(properties['simulatedFields'], ensure_ascii=False)
            rows.append({field: properties.get(field) for field in FIELDS})
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, nargs='?', help="UTF-8 CSV 维护文件")
    parser.add_argument("--export", type=Path, help="导出当前数据库站点到新的 CSV 文件")
    parser.add_argument("--apply", action="store_true", help="备份后正式写入；默认只校验并试运行回滚")
    parser.add_argument("--retire-demo", action="store_true", help="导入真实数据成功后，停用本演示批次；保留记录便于追溯")
    parser.add_argument("--report", type=Path, default=ROOT / "docs/station-import-latest.json")
    args = parser.parse_args()
    if args.export:
        if args.path or args.apply or args.retire_demo:
            parser.error("--export 不能与导入选项同时使用")
        with closing(get_db_connection()) as connection:
            count = export_catalog(connection, args.export)
        print(f"Exported {count} stations")
        return
    if not args.path:
        parser.error("请指定 CSV 路径或使用 --export")
    rows = read_catalog(args.path)
    # 先完成可回滚的数据库验证，再备份、执行正式同步。
    with closing(get_db_connection()) as connection:
        try:
            report = sync_catalog(connection, rows, args.retire_demo)
        finally:
            connection.rollback()
    backup = str(backup_database()) if args.apply else None
    if args.apply:
        with closing(get_db_connection()) as connection:
            with connection:
                report = sync_catalog(connection, rows, args.retire_demo)
                cursor = connection.cursor()
                cursor.execute("INSERT INTO station_imports(source_file,report) VALUES(%s,%s)", (args.path.name, Json(report)))
                cursor.close()
    report.update(committed=args.apply, source_file=args.path.name, backup=backup)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
