import math


PI = math.pi
A = 6378245.0
EE = 0.00669342162296594323


def out_of_china(lng, lat):
    """
    判断坐标是否位于 GCJ-02 使用范围之外。
    范围外直接返回原坐标。
    """
    return (
        lng < 72.004
        or lng > 137.8347
        or lat < 0.8293
        or lat > 55.8271
    )


def transform_lat(x, y):
    result = (
        -100.0
        + 2.0 * x
        + 3.0 * y
        + 0.2 * y * y
        + 0.1 * x * y
        + 0.2 * math.sqrt(abs(x))
    )

    result += (
        20.0 * math.sin(6.0 * x * PI)
        + 20.0 * math.sin(2.0 * x * PI)
    ) * 2.0 / 3.0

    result += (
        20.0 * math.sin(y * PI)
        + 40.0 * math.sin(y / 3.0 * PI)
    ) * 2.0 / 3.0

    result += (
        160.0 * math.sin(y / 12.0 * PI)
        + 320.0 * math.sin(y * PI / 30.0)
    ) * 2.0 / 3.0

    return result


def transform_lng(x, y):
    result = (
        300.0
        + x
        + 2.0 * y
        + 0.1 * x * x
        + 0.1 * x * y
        + 0.1 * math.sqrt(abs(x))
    )

    result += (
        20.0 * math.sin(6.0 * x * PI)
        + 20.0 * math.sin(2.0 * x * PI)
    ) * 2.0 / 3.0

    result += (
        20.0 * math.sin(x * PI)
        + 40.0 * math.sin(x / 3.0 * PI)
    ) * 2.0 / 3.0

    result += (
        150.0 * math.sin(x / 12.0 * PI)
        + 300.0 * math.sin(x / 30.0 * PI)
    ) * 2.0 / 3.0

    return result


def wgs84_to_gcj02(lng, lat):
    """
    WGS84 → GCJ-02。

    这个函数除了以后对接高德 API 会用，
    现在还用来验证反向转换结果。
    """

    if out_of_china(lng, lat):
        return lng, lat

    dlat = transform_lat(lng - 105.0, lat - 35.0)
    dlng = transform_lng(lng - 105.0, lat - 35.0)

    rad_lat = lat / 180.0 * PI

    magic = math.sin(rad_lat)
    magic = 1 - EE * magic * magic
    sqrt_magic = math.sqrt(magic)

    dlat = (
        dlat * 180.0
        / (
            (A * (1 - EE))
            / (magic * sqrt_magic)
            * PI
        )
    )

    dlng = (
        dlng * 180.0
        / (
            A
            / sqrt_magic
            * math.cos(rad_lat)
            * PI
        )
    )

    return lng + dlng, lat + dlat


def gcj02_to_wgs84(lng, lat):
    """
    GCJ-02 → WGS84。

    通过迭代反推 WGS84，
    不只是简单减一次偏移量。
    """

    if out_of_china(lng, lat):
        return lng, lat

    wgs_lng = lng
    wgs_lat = lat

    for _ in range(10):

        gcj_lng, gcj_lat = wgs84_to_gcj02(
            wgs_lng,
            wgs_lat
        )

        diff_lng = gcj_lng - lng
        diff_lat = gcj_lat - lat

        wgs_lng -= diff_lng
        wgs_lat -= diff_lat

        if (
            abs(diff_lng) < 1e-7
            and abs(diff_lat) < 1e-7
        ):
            break

    return wgs_lng, wgs_lat