-- 在 pgAdmin 的 nev_webgis 数据库执行；本文件只读。
-- 五张主几何列均应为 4326，原始备份列为 0。
SELECT f_table_name, f_geometry_column, type, srid
FROM geometry_columns
WHERE f_table_schema = 'public'
  AND f_table_name IN ('stations','residential_pois','commercial_pois','hex_grid','weidu_boundary')
ORDER BY f_table_name, f_geometry_column;

-- 坐标应实际发生变化；geom 与 geom_wgs84 应一致。
SELECT id, ST_AsText(geom_gcj02) AS original_gcj02,
       ST_AsText(geom) AS converted_wgs84,
       lng, lat, ST_Equals(geom,geom_wgs84) AS candidate_matches
FROM stations ORDER BY id LIMIT 5;

-- 迁移记录包含坐标回转误差、逐对空间关系比对、边缘归属和供需重算结果。
SELECT migration_id, applied_at, report
FROM coordinate_migrations WHERE migration_id = 'gcj02_to_wgs84_v1';

-- 总计应为：170 个网格，52 个站点，224 个区内小区，200 个商业 POI。
SELECT COUNT(*) AS grid_count, SUM(station_count) AS stations,
       SUM(residential_count) AS residential, SUM(commercial_count) AS commercial,
       COUNT(*) FILTER (WHERE residential_norm IS NULL OR commercial_norm IS NULL
           OR demand_index IS NULL OR supply_index IS NULL OR mismatch_index IS NULL) AS missing_indices
FROM hex_grid;

-- 归一化范围、等权需求公式、错配公式检查，错误记录数应为 0。
SELECT COUNT(*) AS incorrect_indices FROM hex_grid
WHERE residential_norm NOT BETWEEN 0 AND 1 OR commercial_norm NOT BETWEEN 0 AND 1
   OR demand_index NOT BETWEEN 0 AND 1 OR supply_index NOT BETWEEN 0 AND 1
   OR mismatch_index NOT BETWEEN -1 AND 1
   OR ABS(demand_index - ROUND((0.5*residential_norm+0.5*commercial_norm)::numeric,3)) > 1e-9
   OR ABS(mismatch_index - ROUND((demand_index-supply_index)::numeric,3)) > 1e-9;

SELECT supply_demand_type, COUNT(*) FROM hex_grid GROUP BY supply_demand_type ORDER BY supply_demand_type;
