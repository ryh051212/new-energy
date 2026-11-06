"""按高德分类采集魏都区 POI；逐页落盘，可续采，不包含密钥和推测数据。"""

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "data/managed/facility-categories.json"
ENDPOINT = "https://restapi.amap.com/v3/place/text"


def now():
    return datetime.now(timezone.utc).isoformat()


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 某些 Windows 工作区仅授予文件写权限，替换已有路径会被拒绝。
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    for attempt in range(8):
        try:
            path.write_text(content, encoding="utf-8")
            return
        except OSError:
            if attempt == 7:
                raise
            time.sleep(.25 * (attempt + 1))


def collect(output, max_pages=40, interval=1.3, resume=False):
    load_dotenv(ROOT / "backend/.env.local")
    load_dotenv(ROOT / ".env.local")
    key = os.getenv("AMAP_WEB_KEY") or os.getenv("AMAP_KEY")
    if not key:
        raise ValueError("未配置 AMAP_WEB_KEY / AMAP_KEY")
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    data = json.loads(output.read_text(encoding="utf-8")) if resume and output.exists() else {
        "source": "AMap", "endpoint": ENDPOINT, "region": config["region"],
        "coordSystem": "GCJ-02", "startedAt": now(), "queries": {},
    }
    if data.get("region") != config["region"] or data.get("coordSystem") != "GCJ-02":
        raise ValueError("续采文件的区域/坐标系不匹配")
    session = requests.Session()
    for category in config["categories"]:
        category_id = category["id"]
        query = data["queries"].setdefault(category_id, {
            **category, "pages": [], "pois": [], "status": "pending",
        })
        if query["types"] != category["types"]:
            raise ValueError("续采文件的分类码不匹配")
        if query["status"] == "complete":
            continue
        seen = {poi["id"] for poi in query["pois"]}
        for page in range(len(query["pages"]) + 1, max_pages + 1):
            params = {"key": key, "types": category["types"], "city": config["region"],
                      "citylimit": "true", "offset": 25, "page": page, "extensions": "base"}
            payload = None
            for attempt in range(3):
                time.sleep(interval * (attempt + 1))
                try:
                    response = session.get(ENDPOINT, params=params, timeout=25)
                    response.raise_for_status()
                    payload = response.json()
                except (requests.RequestException, ValueError) as error:
                    query["lastError"] = {"at": now(), "kind": type(error).__name__}
                    save_json(output, data)
                    if attempt == 2:
                        raise RuntimeError("高德网络请求失败，已保存进度；异常 URL 不输出") from None
                    continue
                if payload.get("status") == "1":
                    break
                query["lastError"] = {"at": now(), "info": payload.get("info"),
                                      "infocode": payload.get("infocode")}
                save_json(output, data)
                if payload.get("infocode") != "10021" or attempt == 2:
                    raise RuntimeError(f"高德接口拒绝请求：{payload.get('info')} ({payload.get('infocode')})")
            pois = payload.get("pois")
            if not isinstance(pois, list):
                raise ValueError("高德返回的 pois 不是数组，保留已有文件")
            added = [poi for poi in pois if isinstance(poi, dict) and poi.get("id") not in seen]
            query["pois"].extend(added)
            seen.update(poi["id"] for poi in added)
            query["pages"].append({"page": page, "fetchedAt": now(), "returned": len(pois),
                                   "added": len(added), "reportedCount": payload.get("count")})
            query["status"] = "collecting"
            if len(pois) < 25:
                query["status"] = "complete"
            elif not added:
                query["status"] = "repeated_page"
            elif page == max_pages:
                query["status"] = "page_limit"
            data["updatedAt"] = now()
            save_json(output, data)
            print(f"{category['name']} 第 {page} 页：{len(pois)} 条，累计 {len(query['pois'])}（{query['status']}）", flush=True)
            if query["status"] != "collecting":
                break
    data["finishedAt"] = now()
    data["complete"] = all(q["status"] == "complete" for q in data["queries"].values())
    save_json(output, data)
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "data/raw/amap-facilities.json")
    parser.add_argument("--max-pages", type=int, default=40)
    parser.add_argument("--interval", type=float, default=1.3)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.max_pages <= 40 or args.interval < 1:
        parser.error("max-pages 须为 1～40，interval 至少 1 秒")
    collect(args.output, args.max_pages, args.interval, args.resume)


if __name__ == "__main__":
    main()
