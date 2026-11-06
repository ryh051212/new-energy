"""后端服务启动脚本

使用方式：
    python run.py                    # 开发模式（自动重载）
    python run.py --no-reload        # 生产模式
"""
import sys
from pathlib import Path

# 确保 backend 作为包的根目录
backend_dir = Path(__file__).parent.resolve()
parent_dir = backend_dir.parent

# 将父目录添加到 Python 路径，这样可以 import backend.api.main
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

if __name__ == "__main__":
    import uvicorn

    # 检查是否禁用自动重载
    reload = "--no-reload" not in sys.argv

    # 从 backend.api.main 导入 app
    uvicorn.run(
        "backend.api.main:app",
        host="127.0.0.1",
        port=8000,
        reload=reload,
        reload_dirs=[str(backend_dir)] if reload else None
    )
