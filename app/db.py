"""Banco de dados SQLite: schema, migrações e carga inicial (seed)."""
import sqlite3
import time
from datetime import datetime, timezone

from . import config

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS layouts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    width      INTEGER NOT NULL DEFAULT 1920,
    height     INTEGER NOT NULL DEFAULT 1080,
    background TEXT NOT NULL DEFAULT '#000000',
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS containers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    layout_id    INTEGER NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT 'Container',
    x            INTEGER NOT NULL DEFAULT 0,
    y            INTEGER NOT NULL DEFAULT 0,
    w            INTEGER NOT NULL DEFAULT 640,
    h            INTEGER NOT NULL DEFAULT 360,
    z_index      INTEGER NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1,
    show_title   INTEGER NOT NULL DEFAULT 0,
    show_border  INTEGER NOT NULL DEFAULT 0,
    border_color TEXT NOT NULL DEFAULT '#3b82f6',
    background   TEXT NOT NULL DEFAULT '#000000',
    fit_mode     TEXT NOT NULL DEFAULT 'contain',
    sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
    name         TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT 'web',
    source       TEXT NOT NULL DEFAULT '',
    duration     INTEGER NOT NULL DEFAULT 60,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    active       INTEGER NOT NULL DEFAULT 1,
    loop         INTEGER NOT NULL DEFAULT 0,
    refresh      INTEGER NOT NULL DEFAULT 0,
    volume       INTEGER NOT NULL DEFAULT 0,
    img_interval INTEGER NOT NULL DEFAULT 10
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT,
    expires_at REAL
);

CREATE TABLE IF NOT EXISTS player_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT,
    level   TEXT,
    source  TEXT,
    message TEXT
);
"""


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def connect():
    con = sqlite3.connect(config.DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    return con


def get_setting(con, key, default=None):
    row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(con, key, value):
    con.execute(
        "INSERT INTO settings(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def bump_player_version(con):
    set_setting(con, "player_version", str(int(time.time() * 1000)))


def init_db():
    config.ensure_dirs()
    con = connect()
    try:
        con.executescript(SCHEMA)
        if get_setting(con, "schema_version") is None:
            set_setting(con, "schema_version", SCHEMA_VERSION)
        _seed(con)
        con.commit()
    finally:
        con.close()


# ---------------------------------------------------------------- seed

SAMPLE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/>
  </linearGradient></defs>
  <rect width="1280" height="720" fill="url(#g)"/>
  <text x="640" y="330" font-family="sans-serif" font-size="72" font-weight="bold"
        fill="#ffffff" text-anchor="middle">{title}</text>
  <text x="640" y="410" font-family="sans-serif" font-size="34"
        fill="rgba(255,255,255,.85)" text-anchor="middle">{subtitle}</text>
</svg>"""

SAMPLES = [
    ("imagem-01.svg", "#0f4c81", "#2dd4bf", "VideoWall", "Imagem de exemplo 01"),
    ("imagem-02.svg", "#7c3aed", "#f472b6", "Comunicação Interna", "Imagem de exemplo 02"),
    ("imagem-03.svg", "#b45309", "#fbbf24", "Avisos Corporativos", "Imagem de exemplo 03"),
]


def _seed(con):
    from . import auth  # import tardio para evitar ciclo

    if get_setting(con, "admin_password_hash") is None:
        set_setting(con, "admin_user", "admin")
        set_setting(con, "admin_password_hash", auth.hash_password("admin"))
        set_setting(con, "player_version", str(int(time.time() * 1000)))
        set_setting(con, "lock_ui", "1")

    if con.execute("SELECT COUNT(*) c FROM layouts").fetchone()["c"] > 0:
        return

    # Imagens de exemplo no diretório de mídia
    sample_dir = config.MEDIA_DIR / "exemplos"
    sample_dir.mkdir(parents=True, exist_ok=True)
    for fname, c1, c2, title, subtitle in SAMPLES:
        p = sample_dir / fname
        if not p.exists():
            p.write_text(SAMPLE_SVG.format(c1=c1, c2=c2, title=title, subtitle=subtitle))

    ts = now_iso()
    cur = con.execute(
        "INSERT INTO layouts(name,width,height,background,is_default,created_at,updated_at) "
        "VALUES(?,?,?,?,1,?,?)",
        ("Exemplo 2x2", 1920, 1080, "#000000", ts, ts),
    )
    lid = cur.lastrowid
    set_setting(con, "active_layout_id", lid)

    def add_container(name, x, y, w, h, show_title=0):
        c = con.execute(
            "INSERT INTO containers(layout_id,name,x,y,w,h,show_title) VALUES(?,?,?,?,?,?,?)",
            (lid, name, x, y, w, h, show_title),
        )
        return c.lastrowid

    def add_content(cid, name, ctype, source, duration=60, sort_order=0, refresh=0, img_interval=10):
        con.execute(
            "INSERT INTO contents(container_id,name,type,source,duration,sort_order,refresh,img_interval) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (cid, name, ctype, source, duration, sort_order, refresh, img_interval),
        )

    c1 = add_container("Boas-vindas", 0, 0, 960, 540)
    add_content(c1, "Página de boas-vindas", "web", "/static/pages/boasvindas.html", 0)

    c2 = add_container("Relógio", 960, 0, 960, 540)
    add_content(c2, "Relógio e data", "web", "/static/pages/relogio.html", 0)

    c3 = add_container("Imagens institucionais", 0, 540, 960, 540)
    add_content(c3, "Pasta de imagens de exemplo", "image_folder", "exemplos", 0, img_interval=10)

    c4 = add_container("Indicadores", 960, 540, 960, 540, show_title=1)
    add_content(c4, "Painel de indicadores (demo)", "web", "/static/pages/indicadores.html", 45, 0, refresh=0)
    add_content(c4, "Imagem institucional", "image", "exemplos/imagem-01.svg", 15, 1)
