"""Servidor HTTP do VideoWall (somente biblioteca padrão do Python).

Rotas:
  /              -> redireciona para /admin
  /login         -> página de login
  /admin         -> painel administrativo (exige sessão)
  /player        -> tela de exibição (player)
  /static/*      -> arquivos estáticos (painel, player, páginas internas)
  /media/*       -> arquivos de mídia enviados (com suporte a HTTP Range)
  /api/*         -> API REST (ver api.py)
"""
import json
import logging
import logging.handlers
import mimetypes
import os
import re
import socketserver
import traceback
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

from . import api, auth, config, db

log = logging.getLogger("videowall")


class Request:
    """Contexto de uma requisição entregue aos handlers da API."""

    def __init__(self, handler, con, match, query):
        self.handler = handler
        self.con = con
        self.match = match
        self.query = query
        self._json = None
        self.extra_headers = []

    def json(self):
        if self._json is None:
            length = int(self.handler.headers.get("Content-Length") or 0)
            if length:
                try:
                    self._json = json.loads(self.handler.rfile.read(length).decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    self._json = {}
            else:
                self._json = {}
        return self._json

    def cookie(self, name):
        c = SimpleCookie(self.handler.headers.get("Cookie", ""))
        return c[name].value if name in c else None

    def set_cookie(self, name, value, expire=False):
        attrs = f"{name}={value}; Path=/; HttpOnly; SameSite=Lax"
        if expire:
            attrs += "; Max-Age=0"
        else:
            attrs += f"; Max-Age={config.SESSION_TTL_DAYS * 86400}"
        self.extra_headers.append(("Set-Cookie", attrs))


class Handler(BaseHTTPRequestHandler):
    server_version = "VideoWall/1.0"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ infra

    def log_message(self, fmt, *args):  # silencia o log padrão por requisição
        pass

    def _send(self, status, body: bytes, ctype="application/json; charset=utf-8", headers=()):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj, headers=()):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode(), headers=headers)

    def _redirect(self, location):
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ------------------------------------------------------------ estáticos

    def _serve_file(self, path, cache=False):
        if not path.is_file():
            self._json(404, {"error": "Não encontrado"})
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        size = path.stat().st_size
        range_header = self.headers.get("Range")
        start, end = 0, size - 1
        status = HTTPStatus.OK
        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):  # bytes=-N (últimos N bytes)
                    start = max(0, size - int(m.group(2)))
                status = HTTPStatus.PARTIAL_CONTENT
        if start >= size:
            self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "max-age=300" if cache else "no-store")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    # ------------------------------------------------------------ dispatch

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        try:
            self._route(method)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            log.error("Erro em %s %s\n%s", method, self.path, traceback.format_exc())
            try:
                self._json(500, {"error": "Erro interno do servidor"})
            except Exception:
                pass

    def _has_session(self, con):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        token = c[auth.COOKIE_NAME].value if auth.COOKIE_NAME in c else None
        return auth.session_valid(con, token)

    def _route(self, method):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}

        # --- páginas e estáticos
        if method == "GET":
            if path == "/":
                return self._redirect("/admin")
            if path == "/login":
                return self._serve_file(config.STATIC_DIR / "admin" / "login.html")
            if path == "/player":
                return self._serve_file(config.STATIC_DIR / "player" / "player.html")
            if path == "/admin":
                con = db.connect()
                try:
                    ok = self._has_session(con)
                finally:
                    con.close()
                if not ok:
                    return self._redirect("/login")
                return self._serve_file(config.STATIC_DIR / "admin" / "index.html")
            if path.startswith("/static/"):
                target = (config.STATIC_DIR / path[len("/static/"):]).resolve()
                if not str(target).startswith(str(config.STATIC_DIR.resolve())):
                    return self._json(403, {"error": "Acesso negado"})
                return self._serve_file(target, cache=True)
            if path.startswith("/media/"):
                target = api.safe_media_path(path[len("/media/"):])
                if target is None:
                    return self._json(403, {"error": "Acesso negado"})
                return self._serve_file(target, cache=True)

        # --- API
        for m, rx, fn, needs_auth in api.ROUTES:
            if m != method:
                continue
            match = rx.match(path)
            if not match:
                continue
            con = db.connect()
            try:
                if needs_auth and not self._has_session(con):
                    return self._json(401, {"error": "Não autenticado"})
                req = Request(self, con, match, query)
                result = fn(req)
                con.commit()
                if isinstance(result, tuple):
                    status, payload = result
                else:
                    status, payload = 200, result
                return self._json(status, payload, headers=req.extra_headers)
            finally:
                con.close()

        self._json(404, {"error": "Rota não encontrada"})


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def setup_logging():
    config.ensure_dirs()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    fh = logging.handlers.RotatingFileHandler(
        config.LOG_DIR / "server.log", maxBytes=2_000_000, backupCount=3
    )
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    log.setLevel(logging.INFO)
    log.addHandler(fh)
    log.addHandler(sh)


def main():
    setup_logging()
    db.init_db()
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    log.info("VideoWall iniciado em http://%s:%s", config.HOST, config.PORT)
    log.info("Painel: http://%s:%s/admin | Player: http://%s:%s/player",
             config.HOST, config.PORT, config.HOST, config.PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Encerrando.")
        server.shutdown()


if __name__ == "__main__":
    main()
