from pathlib import Path
import os
import psycopg2
from dotenv import load_dotenv

backend_dir = Path(__file__).resolve().parent
load_dotenv(backend_dir / ".env.local")
load_dotenv(backend_dir.parent / ".env.local")


def get_db_connection(password=None):
    """
    创建 PostgreSQL 数据库连接
    """

    conn = psycopg2.connect(
        database="nev_webgis",
        user="postgres",
        password=password if password is not None else os.getenv("DB_PASSWORD"),
        host="localhost",

        # 你的端口
        port=5433
    )

    return conn
  #只负责连接数据库