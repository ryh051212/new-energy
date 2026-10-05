"""临时启动本地 API 检查真实 HTTP 响应；结束后关闭该临时进程。"""

import json
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def main():
    root = Path(__file__).resolve().parent.parent
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryFile(mode="w+b") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=root, stdout=log, stderr=log,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        try:
            for _ in range(100):
                try:
                    with urlopen(base + "/api/health", timeout=1) as response:
                        assert response.status == 200
                    break
                except (URLError, TimeoutError):
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read().decode("utf-8", errors="replace"))
                    time.sleep(0.1)
            else:
                raise RuntimeError("临时 API 未能启动")
            responses = {}
            for path, count in (("/api/stations", 52), ("/api/stations?coord_system=GCJ-02", 52),
                                ("/api/hex-grid", 170), ("/api/hex-grid?coord_system=GCJ-02", 170)):
                with urlopen(base + path, timeout=10) as response:
                    data = json.load(response)
                    assert response.status == 200 and len(data["features"]) == count
                    responses[path] = data
                print(f"200 {path}: {count} features")
            assert responses["/api/stations"]["features"][0]["geometry"] != responses[
                "/api/stations?coord_system=GCJ-02"]["features"][0]["geometry"]
            try:
                urlopen(base + "/api/stations?coord_system=invalid", timeout=10)
            except HTTPError as error:
                assert error.code == 422
                print("422 invalid coordinate system: rejected")
            else:
                raise AssertionError("无效坐标系未被拒绝")
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
