from pathlib import Path
import os
import psycopg2
from dotenv import load_dotenv

backend_dir = Path(__file__).resolve().parents[1]
load_dotenv(backend_dir / ".env.local")
load_dotenv(backend_dir.parent / ".env.local")


def get_db_connection(password=None):
    """
    创建 PostgreSQL 数据库连接
    """

    conn = psycopg2.connect(
        database=os.getenv("DB_NAME", "nev_webgis"),
        user=os.getenv("DB_USER", "postgres"),
        password=password if password is not None else os.getenv("DB_PASSWORD"),
        host=os.getenv("DB_HOST", "localhost"),
        # 保留原有默认端口，协作成员可在本机配置中覆盖。
        port=int(os.getenv("DB_PORT", "5433"))
    )

    return conn
  #只负责连接数据库
