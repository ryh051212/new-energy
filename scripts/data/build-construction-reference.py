"""将官方商业用地草案分区图配准并裁剪到项目魏都区边界，仅用于参考展示。"""

import argparse
import json
from pathlib import Path

import numpy as np
import pyproj
import rasterio
from affine import Affine
from rasterio.features import shapes, sieve
from shapely.geometry import mapping, shape
from shapely.ops import transform, unary_union
from shapely import maximum_inscribed_circle


ROOT = Path(__file__).resolve().parents[2]


def build_reference(image_path, boundary_path):
    boundary_data = json.loads(boundary_path.read_text(encoding="utf-8"))
    if boundary_data.get("metadata", {}).get("coordSystem") != "WGS84":
        raise ValueError("行政边界必须明确为 WGS84，不能将原始高德边界直接叠加")

    boundary = unary_union([shape(feature["geometry"]) for feature in boundary_data["features"]])
    with rasterio.open(image_path) as dataset:
        image = dataset.read([1, 2, 3]).transpose(1, 2, 0).astype(np.float32)

    # 按原图图廓坐标定位；横轴首末刻度为 38474000、38498000，纵轴为 3784000、3758000。
    # 原图未注明投影基准，按 CGCS2000 三度带 38 解释，保留假设，不用于工程测量。
    pixel_transform = Affine(24000 / 1198, 0, 38474000 - 88 * 24000 / 1198,
                             0, -26000 / 1297, 3784000 + 183 * 26000 / 1297)
    to_wgs84 = pyproj.Transformer.from_crs(4526, 4326, always_xy=True).transform
    to_projected = pyproj.Transformer.from_crs(4326, 4526, always_xy=True).transform

    sample_pixels = [(650, 1020), (610, 1130), (690, 805), (550, 650),
                     (450, 550), (290, 800), (800, 280)]
    palette = []
    for x, y in sample_pixels:
        palette.append(np.median(image[y - 4:y + 5, x - 4:x + 5], axis=(0, 1)))
    palette = np.array(palette)

    # 从原图填色识别级别，局部多数票去除文字和道路的干扰，不按距市中心远近生成分区。
    # 使用相对色度区分两种紫色，避免底图深浅与文字把同一级别切成零碎小区。
    normalized = image / np.maximum(image.max(axis=2, keepdims=True), 1)
    palette = palette / palette.max(axis=1, keepdims=True)
    distances = np.stack([np.sum((normalized - color) ** 2, axis=2) for color in palette])
    labels = (np.argmin(distances, axis=0) + 1).astype(np.uint8)
    labels[(image.min(axis=2) > 242) | (image.max(axis=2) < 130)
           | (np.min(distances, axis=0) > 0.1)] = 0
    counts = []
    radius = 4
    for grade in range(1, 8):
        mask = np.pad((labels == grade).astype(np.int32), radius)
        integral = np.pad(mask, ((1, 0), (1, 0))).cumsum(0).cumsum(1)
        size = radius * 2 + 1
        counts.append(integral[size:, size:] - integral[:-size, size:]
                      - integral[size:, :-size] + integral[:-size, :-size])
    counts = np.stack(counts)
    cleaned = (np.argmax(counts, axis=0) + 1).astype(np.uint8)
    cleaned[np.max(counts, axis=0) < 15] = 0
    cleaned = sieve(cleaned, size=120)

    parts = {grade: [] for grade in range(1, 8)}
    for geometry, value in shapes(cleaned, mask=cleaned > 0, transform=pixel_transform):
        projected = shape(geometry)
        if projected.area < 80000:
            continue
        clipped = transform(to_wgs84, projected).intersection(boundary)
        if not clipped.is_empty:
            parts[int(value)].append(clipped)

    rents = [193, 123, 85, 61, 50, 41, 34]
    land_prices = [4350, 3000, 2190, 1680, 1410, 1200, 1050]
    zones = []
    for grade, geometries in parts.items():
        if not geometries:
            continue
        geometry = unary_union(geometries)
        label_center = maximum_inscribed_circle(transform(to_projected, geometry), tolerance=30).coords[0]
        zones.append({
            "type": "Feature",
            "properties": {"id": f"draft-commercial-{grade}", "grade": grade,
                           "annualRentReference": rents[grade - 1],
                           "landPriceReference": land_prices[grade - 1],
                           "labelCoordinates": to_wgs84(*label_center),
                           "boundaryStatus": "draft_georeferenced", "use": "商业用地"},
            "geometry": mapping(geometry),
        })

    context = json.loads((ROOT / "data/processed/weidu-siting-context.geojson").read_text(encoding="utf-8"))
    power = []
    for feature in context["features"]:
        if feature["properties"].get("category") != "power":
            continue
        if boundary.covers(shape(feature["geometry"])):
            power.append(feature)

    return {
        "boundary": boundary_data,
        "zones": {"type": "FeatureCollection", "features": zones},
        "power": {"type": "FeatureCollection", "features": power},
        "metadata": {
            "title": "魏都区建设依据参考图", "coordSystem": "WGS84", "preparedAt": "2026-11-01",
            "powerDataDate": "2026-07-15", "landUse": "商业用地",
            "gradeBoundaryDate": "2024-01-30", "priceTableDate": "2024-04-11",
            "boundaryStatus": "draft_georeferenced", "positionAccuracy": "原图数字化近似位置，仅供区域浏览",
            "projectionAssumption": "原图未明示投影，按 CGCS2000 三度带 38 图廓坐标配准（EPSG:4526）",
            "pixelTransform": list(pixel_transform)[:6],
            "notice": "红线来自征求意见稿，价格来自正式公布参考表；最终分级对应关系待核实，不代表真实场租或可建站结论。",
            "draftSourceUrl": "https://www.xuchang.gov.cn/hdjl/004007/20240130/6ee1e491-a616-4ed8-957b-1eac36ad4214.html",
            "priceSourceUrl": "https://zrzyhghj.xuchang.gov.cn/zxgz/014003/20240605/a4c9ad99-9a01-496c-a638-c6bcefc2b8f3.html",
            "originalMap": "/reference/xuchang-commercial-grades-draft-2024.jpg",
            "attribution": "许昌市自然资源和规划局；项目数据库行政边界；© OpenStreetMap contributors",
        },
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--boundary", type=Path, required=True)
    args = parser.parse_args()
    result = build_reference(args.image, args.boundary)
    destination = ROOT / "data/processed/weidu-construction-reference.json"
    destination.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"已生成 {len(result['zones']['features'])} 个参考级别、{len(result['power']['features'])} 条电力设施记录：{destination}")
