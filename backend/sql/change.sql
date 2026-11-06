CREATE TABLE stations (
    -- 高德 POI 的唯一编号
    id TEXT PRIMARY KEY,

    -- 充电站名称
    name TEXT NOT NULL,

    -- 地址
    address TEXT,

    -- 原始经纬度
    lng DOUBLE PRECISION,
    lat DOUBLE PRECISION,

    -- PostGIS 空间字段
    -- 暂时不指定具体 SRID
    geom geometry(Point)
);