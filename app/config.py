"""Configuração central do VideoWall.

Tudo pode ser sobrescrito por variáveis de ambiente (ver config/videowall.env).
"""
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("VIDEOWALL_DATA", str(APP_DIR / "data")))
MEDIA_DIR = DATA_DIR / "media"
LOG_DIR = DATA_DIR / "logs"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = DATA_DIR / "videowall.db"
STATIC_DIR = APP_DIR / "static"

HOST = os.environ.get("VIDEOWALL_BIND", "127.0.0.1")
PORT = int(os.environ.get("VIDEOWALL_PORT", "8777"))

SESSION_TTL_DAYS = int(os.environ.get("VIDEOWALL_SESSION_DAYS", "7"))
MAX_UPLOAD_MB = int(os.environ.get("VIDEOWALL_MAX_UPLOAD_MB", "4096"))

# Extensões aceitas no gerenciador de mídia
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".bmp"}
VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".ogv", ".mov"}
ALLOWED_EXTS = IMAGE_EXTS | VIDEO_EXTS | {".pdf"}


def ensure_dirs():
    for d in (DATA_DIR, MEDIA_DIR, LOG_DIR, BACKUP_DIR):
        d.mkdir(parents=True, exist_ok=True)
