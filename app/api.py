"""Rotas da API REST.

Cada handler recebe um objeto Request (ver server.py) e retorna:
  - dict/list            -> 200 JSON
  - (status, dict/list)  -> status JSON
"""
import json
import re
import shutil
import time
import urllib.request
import urllib.error
from pathlib import Path

from . import auth, config, db

ROUTES = []  # (method, regex, handler, exige_auth)


def route(method, pattern, needs_auth=True):
    def deco(fn):
        ROUTES.append((method, re.compile("^" + pattern + "$"), fn, needs_auth))
        return fn
    return deco


def err(status, msg):
    return status, {"error": msg}


# ------------------------------------------------------------------ helpers

LAYOUT_FIELDS = {"name", "width", "height", "background"}
CONTAINER_FIELDS = {
    "name", "x", "y", "w", "h", "z_index", "active", "show_title",
    "show_border", "border_color", "background", "fit_mode", "sort_order",
}
CONTENT_FIELDS = {
    "name", "type", "source", "duration", "sort_order", "active",
    "loop", "refresh", "volume", "img_interval",
}
CONTENT_TYPES = {"web", "image", "video", "image_folder"}
FIT_MODES = {"contain", "cover", "fill"}

INT_FIELDS = {
    "width", "height", "x", "y", "w", "h", "z_index", "active", "show_title",
    "show_border", "sort_order", "duration", "loop", "refresh", "volume",
    "img_interval",
}


def clean_fields(data, allowed):
    out = {}
    for k, v in (data or {}).items():
        if k not in allowed:
            continue
        if k in INT_FIELDS:
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
        out[k] = v
    if "fit_mode" in out and out["fit_mode"] not in FIT_MODES:
        out.pop("fit_mode")
    if "type" in out and out["type"] not in CONTENT_TYPES:
        out.pop("type")
    return out


def layout_tree(con, layout_id):
    lay = con.execute("SELECT * FROM layouts WHERE id=?", (layout_id,)).fetchone()
    if not lay:
        return None
    lay = dict(lay)
    lay["containers"] = []
    rows = con.execute(
        "SELECT * FROM containers WHERE layout_id=? ORDER BY sort_order, id", (layout_id,)
    ).fetchall()
    for r in rows:
        c = dict(r)
        c["contents"] = [
            dict(x) for x in con.execute(
                "SELECT * FROM contents WHERE container_id=? ORDER BY sort_order, id", (r["id"],)
            ).fetchall()
        ]
        lay["containers"].append(c)
    return lay


def safe_media_path(rel):
    """Resolve caminho relativo dentro de MEDIA_DIR, bloqueando path traversal."""
    rel = (rel or "").strip().lstrip("/")
    p = (config.MEDIA_DIR / rel).resolve()
    if not str(p).startswith(str(config.MEDIA_DIR.resolve())):
        return None
    return p


SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9À-ÿ ._()\-]+")


def sanitize_name(name):
    name = SAFE_NAME_RE.sub("_", (name or "").strip())
    return name.strip(". ") or "arquivo"


# ------------------------------------------------------------------ auth

@route("POST", "/api/login", needs_auth=False)
def login(req):
    data = req.json() or {}
    if not auth.check_login(req.con, data.get("username", ""), data.get("password", "")):
        time.sleep(0.6)  # mitiga força bruta
        return err(401, "Usuário ou senha inválidos")
    token = auth.create_session(req.con)
    req.set_cookie(auth.COOKIE_NAME, token)
    return {"ok": True}


@route("POST", "/api/logout", needs_auth=False)
def logout(req):
    auth.delete_session(req.con, req.cookie(auth.COOKIE_NAME))
    req.set_cookie(auth.COOKIE_NAME, "", expire=True)
    return {"ok": True}


@route("GET", "/api/me")
def me(req):
    return {
        "user": db.get_setting(req.con, "admin_user", "admin"),
        "default_password": auth.using_default_password(req.con),
    }


@route("POST", "/api/password")
def change_password(req):
    data = req.json() or {}
    cur, new = data.get("current", ""), data.get("new", "")
    user = db.get_setting(req.con, "admin_user", "admin")
    if not auth.check_login(req.con, user, cur):
        return err(400, "Senha atual incorreta")
    if len(new) < 4:
        return err(400, "A nova senha deve ter pelo menos 4 caracteres")
    db.set_setting(req.con, "admin_password_hash", auth.hash_password(new))
    return {"ok": True}


# ------------------------------------------------------------------ layouts

@route("GET", "/api/layouts")
def list_layouts(req):
    rows = req.con.execute(
        "SELECT l.*, (SELECT COUNT(*) FROM containers c WHERE c.layout_id=l.id) AS containers "
        "FROM layouts l ORDER BY name"
    ).fetchall()
    active = db.get_setting(req.con, "active_layout_id")
    return {
        "layouts": [dict(r) for r in rows],
        "active_layout_id": int(active) if active else None,
    }


@route("POST", "/api/layouts")
def create_layout(req):
    data = clean_fields(req.json(), LAYOUT_FIELDS)
    if not data.get("name"):
        return err(400, "Informe o nome do layout")
    ts = db.now_iso()
    cur = req.con.execute(
        "INSERT INTO layouts(name,width,height,background,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        (data["name"], data.get("width", 1920), data.get("height", 1080),
         data.get("background", "#000000"), ts, ts),
    )
    return layout_tree(req.con, cur.lastrowid)


@route("GET", r"/api/layouts/(\d+)")
def get_layout(req):
    lay = layout_tree(req.con, int(req.match.group(1)))
    return lay if lay else err(404, "Layout não encontrado")


@route("PUT", r"/api/layouts/(\d+)")
def update_layout(req):
    lid = int(req.match.group(1))
    data = clean_fields(req.json(), LAYOUT_FIELDS)
    if not data:
        return err(400, "Nada para atualizar")
    sets = ", ".join(f"{k}=?" for k in data)
    req.con.execute(
        f"UPDATE layouts SET {sets}, updated_at=? WHERE id=?",
        (*data.values(), db.now_iso(), lid),
    )
    return layout_tree(req.con, lid) or err(404, "Layout não encontrado")


@route("DELETE", r"/api/layouts/(\d+)")
def delete_layout(req):
    lid = int(req.match.group(1))
    active = db.get_setting(req.con, "active_layout_id")
    if active and int(active) == lid:
        return err(400, "Não é possível excluir o layout ativo no videowall")
    req.con.execute("DELETE FROM layouts WHERE id=?", (lid,))
    return {"ok": True}


@route("POST", r"/api/layouts/(\d+)/duplicate")
def duplicate_layout(req):
    src = layout_tree(req.con, int(req.match.group(1)))
    if not src:
        return err(404, "Layout não encontrado")
    ts = db.now_iso()
    cur = req.con.execute(
        "INSERT INTO layouts(name,width,height,background,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        (src["name"] + " (cópia)", src["width"], src["height"], src["background"], ts, ts),
    )
    new_id = cur.lastrowid
    for c in src["containers"]:
        cc = req.con.execute(
            "INSERT INTO containers(layout_id,name,x,y,w,h,z_index,active,show_title,show_border,"
            "border_color,background,fit_mode,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (new_id, c["name"], c["x"], c["y"], c["w"], c["h"], c["z_index"], c["active"],
             c["show_title"], c["show_border"], c["border_color"], c["background"],
             c["fit_mode"], c["sort_order"]),
        )
        for it in c["contents"]:
            req.con.execute(
                "INSERT INTO contents(container_id,name,type,source,duration,sort_order,active,"
                "loop,refresh,volume,img_interval) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (cc.lastrowid, it["name"], it["type"], it["source"], it["duration"],
                 it["sort_order"], it["active"], it["loop"], it["refresh"], it["volume"],
                 it["img_interval"]),
            )
    return layout_tree(req.con, new_id)


@route("POST", r"/api/layouts/(\d+)/apply")
def apply_layout(req):
    lid = int(req.match.group(1))
    if not req.con.execute("SELECT id FROM layouts WHERE id=?", (lid,)).fetchone():
        return err(404, "Layout não encontrado")
    db.set_setting(req.con, "active_layout_id", lid)
    db.bump_player_version(req.con)
    return {"ok": True, "active_layout_id": lid}


@route("POST", r"/api/layouts/(\d+)/set-default")
def set_default_layout(req):
    lid = int(req.match.group(1))
    req.con.execute("UPDATE layouts SET is_default=0")
    req.con.execute("UPDATE layouts SET is_default=1 WHERE id=?", (lid,))
    return {"ok": True}


PRESETS = {"1": (1, 1), "2v": (2, 1), "2h": (1, 2), "2x2": (2, 2), "3x2": (3, 2), "4x2": (4, 2)}


@route("POST", r"/api/layouts/(\d+)/preset")
def apply_preset(req):
    lid = int(req.match.group(1))
    lay = req.con.execute("SELECT * FROM layouts WHERE id=?", (lid,)).fetchone()
    if not lay:
        return err(404, "Layout não encontrado")
    preset = (req.json() or {}).get("preset")
    if preset not in PRESETS:
        return err(400, "Preset inválido")
    cols, rows = PRESETS[preset]
    req.con.execute("DELETE FROM containers WHERE layout_id=?", (lid,))
    cw, ch = lay["width"] // cols, lay["height"] // rows
    n = 1
    for r in range(rows):
        for c in range(cols):
            req.con.execute(
                "INSERT INTO containers(layout_id,name,x,y,w,h,sort_order) VALUES(?,?,?,?,?,?,?)",
                (lid, f"Container {n:02d}", c * cw, r * ch, cw, ch, n),
            )
            n += 1
    return layout_tree(req.con, lid)


# ------------------------------------------------------------------ containers

@route("POST", r"/api/layouts/(\d+)/containers")
def create_container(req):
    lid = int(req.match.group(1))
    if not req.con.execute("SELECT id FROM layouts WHERE id=?", (lid,)).fetchone():
        return err(404, "Layout não encontrado")
    data = clean_fields(req.json(), CONTAINER_FIELDS)
    data.setdefault("name", "Novo container")
    data.setdefault("x", 40), data.setdefault("y", 40)
    data.setdefault("w", 640), data.setdefault("h", 360)
    cols = ["layout_id"] + list(data.keys())
    sql = f"INSERT INTO containers({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
    cur = req.con.execute(sql, (lid, *data.values()))
    row = req.con.execute("SELECT * FROM containers WHERE id=?", (cur.lastrowid,)).fetchone()
    out = dict(row); out["contents"] = []
    return out


@route("PUT", r"/api/containers/(\d+)")
def update_container(req):
    cid = int(req.match.group(1))
    data = clean_fields(req.json(), CONTAINER_FIELDS)
    if not data:
        return err(400, "Nada para atualizar")
    sets = ", ".join(f"{k}=?" for k in data)
    req.con.execute(f"UPDATE containers SET {sets} WHERE id=?", (*data.values(), cid))
    row = req.con.execute("SELECT * FROM containers WHERE id=?", (cid,)).fetchone()
    return dict(row) if row else err(404, "Container não encontrado")


@route("DELETE", r"/api/containers/(\d+)")
def delete_container(req):
    req.con.execute("DELETE FROM containers WHERE id=?", (int(req.match.group(1)),))
    return {"ok": True}


@route("POST", r"/api/containers/(\d+)/duplicate")
def duplicate_container(req):
    cid = int(req.match.group(1))
    c = req.con.execute("SELECT * FROM containers WHERE id=?", (cid,)).fetchone()
    if not c:
        return err(404, "Container não encontrado")
    cur = req.con.execute(
        "INSERT INTO containers(layout_id,name,x,y,w,h,z_index,active,show_title,show_border,"
        "border_color,background,fit_mode,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (c["layout_id"], c["name"] + " (cópia)", min(c["x"] + 40, 99999), min(c["y"] + 40, 99999),
         c["w"], c["h"], c["z_index"], c["active"], c["show_title"], c["show_border"],
         c["border_color"], c["background"], c["fit_mode"], c["sort_order"] + 1),
    )
    new_id = cur.lastrowid
    for it in req.con.execute(
        "SELECT * FROM contents WHERE container_id=? ORDER BY sort_order, id", (cid,)
    ).fetchall():
        req.con.execute(
            "INSERT INTO contents(container_id,name,type,source,duration,sort_order,active,"
            "loop,refresh,volume,img_interval) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (new_id, it["name"], it["type"], it["source"], it["duration"], it["sort_order"],
             it["active"], it["loop"], it["refresh"], it["volume"], it["img_interval"]),
        )
    row = req.con.execute("SELECT * FROM containers WHERE id=?", (new_id,)).fetchone()
    out = dict(row)
    out["contents"] = [dict(x) for x in req.con.execute(
        "SELECT * FROM contents WHERE container_id=? ORDER BY sort_order, id", (new_id,)
    ).fetchall()]
    return out


# ------------------------------------------------------------------ conteúdos

@route("POST", r"/api/containers/(\d+)/contents")
def create_content(req):
    cid = int(req.match.group(1))
    if not req.con.execute("SELECT id FROM containers WHERE id=?", (cid,)).fetchone():
        return err(404, "Container não encontrado")
    data = clean_fields(req.json(), CONTENT_FIELDS)
    if not data.get("source"):
        return err(400, "Informe a URL ou caminho do conteúdo")
    data.setdefault("type", "web")
    data.setdefault("name", data["source"][:60])
    nxt = req.con.execute(
        "SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM contents WHERE container_id=?", (cid,)
    ).fetchone()["n"]
    data.setdefault("sort_order", nxt)
    cols = ["container_id"] + list(data.keys())
    sql = f"INSERT INTO contents({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
    cur = req.con.execute(sql, (cid, *data.values()))
    return dict(req.con.execute("SELECT * FROM contents WHERE id=?", (cur.lastrowid,)).fetchone())


@route("PUT", r"/api/contents/(\d+)")
def update_content(req):
    iid = int(req.match.group(1))
    data = clean_fields(req.json(), CONTENT_FIELDS)
    if not data:
        return err(400, "Nada para atualizar")
    sets = ", ".join(f"{k}=?" for k in data)
    req.con.execute(f"UPDATE contents SET {sets} WHERE id=?", (*data.values(), iid))
    row = req.con.execute("SELECT * FROM contents WHERE id=?", (iid,)).fetchone()
    return dict(row) if row else err(404, "Conteúdo não encontrado")


@route("DELETE", r"/api/contents/(\d+)")
def delete_content(req):
    req.con.execute("DELETE FROM contents WHERE id=?", (int(req.match.group(1)),))
    return {"ok": True}


@route("POST", r"/api/contents/(\d+)/move")
def move_content(req):
    iid = int(req.match.group(1))
    direction = (req.json() or {}).get("direction")
    row = req.con.execute("SELECT * FROM contents WHERE id=?", (iid,)).fetchone()
    if not row:
        return err(404, "Conteúdo não encontrado")
    items = req.con.execute(
        "SELECT id FROM contents WHERE container_id=? ORDER BY sort_order, id",
        (row["container_id"],),
    ).fetchall()
    ids = [r["id"] for r in items]
    i = ids.index(iid)
    j = i - 1 if direction == "up" else i + 1
    if 0 <= j < len(ids):
        ids[i], ids[j] = ids[j], ids[i]
    for order, _id in enumerate(ids):
        req.con.execute("UPDATE contents SET sort_order=? WHERE id=?", (order, _id))
    return {"ok": True}


# ------------------------------------------------------------------ mídia

@route("GET", "/api/media")
def list_media(req):
    rel = req.query.get("path", "")
    base = safe_media_path(rel)
    if base is None or not base.is_dir():
        return err(404, "Pasta não encontrada")
    folders, files = [], []
    for p in sorted(base.iterdir(), key=lambda x: x.name.lower()):
        if p.name.startswith("."):
            continue
        rp = str(p.relative_to(config.MEDIA_DIR))
        if p.is_dir():
            folders.append({"name": p.name, "path": rp})
        else:
            ext = p.suffix.lower()
            kind = "image" if ext in config.IMAGE_EXTS else "video" if ext in config.VIDEO_EXTS else "file"
            files.append({"name": p.name, "path": rp, "size": p.stat().st_size, "kind": kind})
    return {"path": rel, "folders": folders, "files": files}


@route("POST", "/api/media/folder")
def create_media_folder(req):
    data = req.json() or {}
    parent = safe_media_path(data.get("path", ""))
    name = sanitize_name(data.get("name", ""))
    if parent is None or not name:
        return err(400, "Nome de pasta inválido")
    (parent / name).mkdir(parents=True, exist_ok=True)
    return {"ok": True}


@route("PUT", "/api/media/upload")
def upload_media(req):
    folder = safe_media_path(req.query.get("folder", ""))
    name = sanitize_name(req.query.get("name", ""))
    if folder is None or not name:
        return err(400, "Parâmetros inválidos")
    ext = Path(name).suffix.lower()
    if ext not in config.ALLOWED_EXTS:
        return err(400, f"Extensão não permitida: {ext}")
    length = int(req.handler.headers.get("Content-Length") or 0)
    if length <= 0:
        return err(400, "Arquivo vazio")
    if length > config.MAX_UPLOAD_MB * 1024 * 1024:
        return err(413, f"Arquivo maior que o limite de {config.MAX_UPLOAD_MB} MB")
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / name
    remaining = length
    with open(dest, "wb") as f:
        while remaining > 0:
            chunk = req.handler.rfile.read(min(1024 * 512, remaining))
            if not chunk:
                break
            f.write(chunk)
            remaining -= len(chunk)
    if remaining > 0:
        dest.unlink(missing_ok=True)
        return err(400, "Upload incompleto")
    return {"ok": True, "path": str(dest.relative_to(config.MEDIA_DIR))}


@route("DELETE", "/api/media")
def delete_media(req):
    p = safe_media_path(req.query.get("path", ""))
    if p is None or p == config.MEDIA_DIR.resolve() or not p.exists():
        return err(404, "Arquivo ou pasta não encontrado")
    if p.is_dir():
        shutil.rmtree(p)
    else:
        p.unlink()
    return {"ok": True}


# ------------------------------------------------------------------ player

def _player_state(con, layout_id):
    lay = layout_tree(con, layout_id) if layout_id else None
    return {
        "version": db.get_setting(con, "player_version", "0"),
        "lock_ui": db.get_setting(con, "lock_ui", "1") == "1",
        "layout": lay,
    }


@route("GET", "/api/player/state", needs_auth=False)
def player_state(req):
    if req.query.get("layout_id"):  # modo pré-visualização
        return _player_state(req.con, int(req.query["layout_id"]))
    active = db.get_setting(req.con, "active_layout_id")
    return _player_state(req.con, int(active) if active else None)


@route("POST", "/api/player/heartbeat", needs_auth=False)
def player_heartbeat(req):
    if req.query.get("preview") != "1":
        db.set_setting(req.con, "last_heartbeat", time.time())
    return {"version": db.get_setting(req.con, "player_version", "0")}


@route("POST", "/api/player/log", needs_auth=False)
def player_log(req):
    data = req.json() or {}
    req.con.execute(
        "INSERT INTO player_log(ts,level,source,message) VALUES(?,?,?,?)",
        (db.now_iso(), str(data.get("level", "error"))[:10],
         str(data.get("source", ""))[:120], str(data.get("message", ""))[:500]),
    )
    req.con.execute(
        "DELETE FROM player_log WHERE id NOT IN (SELECT id FROM player_log ORDER BY id DESC LIMIT 2000)"
    )
    return {"ok": True}


@route("GET", "/api/player/folder", needs_auth=False)
def player_folder(req):
    base = safe_media_path(req.query.get("path", ""))
    if base is None or not base.is_dir():
        return {"images": []}
    images = sorted(
        str(p.relative_to(config.MEDIA_DIR))
        for p in base.iterdir()
        if p.is_file() and p.suffix.lower() in config.IMAGE_EXTS
    )
    return {"images": images}


@route("POST", "/api/player/restart")
def player_restart(req):
    db.bump_player_version(req.con)
    return {"ok": True}


# ------------------------------------------------------------------ status / logs / config

@route("GET", "/api/status")
def status(req):
    hb = db.get_setting(req.con, "last_heartbeat")
    hb = float(hb) if hb else 0
    active = db.get_setting(req.con, "active_layout_id")
    lay = None
    if active:
        row = req.con.execute("SELECT id,name FROM layouts WHERE id=?", (int(active),)).fetchone()
        lay = dict(row) if row else None
    return {
        "player_online": (time.time() - hb) < 90 if hb else False,
        "last_heartbeat": hb,
        "active_layout": lay,
        "version": db.get_setting(req.con, "player_version", "0"),
        "lock_ui": db.get_setting(req.con, "lock_ui", "1") == "1",
    }


@route("GET", "/api/logs")
def get_logs(req):
    limit = min(int(req.query.get("limit", 100)), 500)
    rows = req.con.execute(
        "SELECT * FROM player_log ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return {"logs": [dict(r) for r in rows]}


@route("POST", "/api/logs/clear")
def clear_logs(req):
    req.con.execute("DELETE FROM player_log")
    return {"ok": True}


@route("POST", "/api/settings")
def update_settings(req):
    data = req.json() or {}
    if "lock_ui" in data:
        db.set_setting(req.con, "lock_ui", "1" if data["lock_ui"] else "0")
        db.bump_player_version(req.con)
    return {"ok": True}


IFRAME_SRC_RE = re.compile(r'<iframe[^>]*\bsrc\s*=\s*["\']([^"\']+)["\']', re.I)


def extract_iframe_src(s):
    s = (s or "").strip()
    if not s.startswith("<"):
        return s
    m = IFRAME_SRC_RE.search(s)
    return m.group(1).replace("&amp;", "&") if m else s


def _http_open(url, range_bytes=None):
    headers = {"User-Agent": "VideoWall/1.0"}
    if range_bytes:
        headers["Range"] = range_bytes
    return urllib.request.urlopen(
        urllib.request.Request(url, method="GET", headers=headers), timeout=8)


def _result(ok, kind, note, status=200, frame_blocked=False):
    return {"ok": ok, "kind": kind, "status": status, "frame_blocked": frame_blocked, "note": note}


def _validate_hls(url):
    try:
        r = _http_open(url)
        head = r.read(256).decode("utf-8", "ignore")
        ok = "#EXTM3U" in head
        note = ("Stream HLS válido — toca direto, sem play." if ok
                else "Respondeu, mas não parece um playlist HLS (#EXTM3U).")
        return _result(ok, "hls", note, status=getattr(r, "status", 200))
    except urllib.error.HTTPError as e:
        return _result(False, "hls", f"Servidor respondeu erro HTTP {e.code}.", status=e.code)
    except Exception as e:
        return _result(False, "hls", f"Falha ao acessar o stream: {e.__class__.__name__}", status=0)


def _validate_media(url, label):
    try:
        try:
            r = _http_open(url, range_bytes="bytes=0-1")
        except urllib.error.HTTPError as e:
            if e.code in (405, 416, 501):
                r = _http_open(url)
            else:
                raise
        ctype = (r.headers.get("Content-Type") or "").lower()
        return _result(True, label, f"{label.capitalize()} acessível ({ctype or 'sem content-type'}) — autoplay.",
                       status=getattr(r, "status", 200))
    except urllib.error.HTTPError as e:
        return _result(False, label, f"Servidor respondeu erro HTTP {e.code}.", status=e.code)
    except Exception as e:
        return _result(False, label, f"Falha ao acessar: {e.__class__.__name__}", status=0)


def _validate_page(url):
    try:
        r = _http_open(url)
        xfo = (r.headers.get("X-Frame-Options") or "").upper()
        csp = r.headers.get("Content-Security-Policy") or ""
        blocked = bool(xfo in ("DENY", "SAMEORIGIN") or "frame-ancestors" in csp.lower())
        return _result(True, "site",
                       ("Este site bloqueia exibição em container (X-Frame-Options/CSP). "
                        "Use o link de incorporação (embed) se houver.") if blocked else "URL acessível.",
                       status=getattr(r, "status", 200), frame_blocked=blocked)
    except urllib.error.HTTPError as e:
        return _result(False, "site", f"O servidor respondeu erro HTTP {e.code}.", status=e.code)
    except Exception as e:
        return _result(False, "site", f"Falha ao acessar: {e.__class__.__name__}", status=0)


@route("POST", "/api/check-url")
def check_url(req):
    raw = (req.json() or {}).get("url", "").strip()
    src = extract_iframe_src(raw)
    if not src:
        return err(400, "Informe a URL ou o caminho do conteúdo")
    low = src.split("?")[0].split("#")[0].lower()

    # Páginas internas e rotas do próprio VideoWall
    if src.startswith("/"):
        if src.startswith("/static/"):
            p = (config.STATIC_DIR / src[len("/static/"):].split("?")[0]).resolve()
            ok = str(p).startswith(str(config.STATIC_DIR.resolve())) and p.is_file()
            return _result(ok, "interna", "Página interna do VideoWall." if ok
                           else "Arquivo interno não encontrado.", status=200 if ok else 404)
        return _result(True, "interna", "Caminho interno do VideoWall.")

    # Serviços reconhecidos (incorporação com autoplay)
    if re.search(r"youtube\.com|youtu\.be|youtube-nocookie\.com", src, re.I):
        return _result(True, "youtube", "YouTube — será incorporado com autoplay (requer permitir incorporação).")
    if re.search(r"twitch\.tv", src, re.I):
        return _result(True, "twitch", "Twitch — autoplay (o domínio do telão precisa estar liberado no 'parent').")
    if re.search(r"vimeo\.com", src, re.I):
        return _result(True, "vimeo", "Vimeo — será incorporado com autoplay.")

    # HTTP/HTTPS: valida de fato conforme a extensão
    if low.startswith(("http://", "https://")):
        if low.endswith(".m3u8"):
            return _validate_hls(src)
        if re.search(r"\.(mp4|webm|ogv|mov|m4v)$", low):
            return _validate_media(src, "vídeo")
        if re.search(r"\.(mjpg|mjpeg)$", low):
            return _validate_media(src, "imagem")
        return _validate_page(src)

    # Caminho de arquivo de mídia local (sem esquema)
    p = safe_media_path(src)
    if p and p.exists():
        kind = "vídeo" if p.suffix.lower() in config.VIDEO_EXTS else "imagem"
        return _result(True, "midia", f"Arquivo de mídia encontrado ({kind}).")
    return _result(False, "desconhecido",
                   "Não reconheci como URL (http/https), caminho interno (/…) ou arquivo de mídia.", status=0)


@route("GET", "/api/export")
def export_config(req):
    layouts = [
        layout_tree(req.con, r["id"])
        for r in req.con.execute("SELECT id FROM layouts ORDER BY id").fetchall()
    ]
    return {
        "videowall_export": 1,
        "exported_at": db.now_iso(),
        "active_layout_id": db.get_setting(req.con, "active_layout_id"),
        "lock_ui": db.get_setting(req.con, "lock_ui", "1"),
        "layouts": layouts,
    }


@route("POST", "/api/import")
def import_config(req):
    data = req.json() or {}
    if data.get("videowall_export") != 1 or not isinstance(data.get("layouts"), list):
        return err(400, "Arquivo de configuração inválido")
    con = req.con
    con.execute("DELETE FROM layouts")
    old_active = data.get("active_layout_id")
    new_active = None
    for lay in data["layouts"]:
        lf = clean_fields(lay, LAYOUT_FIELDS)
        ts = db.now_iso()
        cur = con.execute(
            "INSERT INTO layouts(name,width,height,background,is_default,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?)",
            (lf.get("name", "Layout"), lf.get("width", 1920), lf.get("height", 1080),
             lf.get("background", "#000000"), int(lay.get("is_default", 0)), ts, ts),
        )
        lid = cur.lastrowid
        if old_active and str(lay.get("id")) == str(old_active):
            new_active = lid
        for c in lay.get("containers", []):
            cf = clean_fields(c, CONTAINER_FIELDS)
            cols = ["layout_id"] + list(cf.keys())
            cc = con.execute(
                f"INSERT INTO containers({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                (lid, *cf.values()),
            )
            for it in c.get("contents", []):
                itf = clean_fields(it, CONTENT_FIELDS)
                if not itf.get("source"):
                    continue
                icols = ["container_id"] + list(itf.keys())
                con.execute(
                    f"INSERT INTO contents({','.join(icols)}) VALUES({','.join('?' * len(icols))})",
                    (cc.lastrowid, *itf.values()),
                )
    if new_active is None:
        row = con.execute("SELECT id FROM layouts ORDER BY is_default DESC, id LIMIT 1").fetchone()
        new_active = row["id"] if row else None
    if new_active:
        db.set_setting(con, "active_layout_id", new_active)
    if "lock_ui" in data:
        db.set_setting(con, "lock_ui", "1" if str(data["lock_ui"]) == "1" else "0")
    db.bump_player_version(con)
    return {"ok": True, "layouts": len(data["layouts"])}
