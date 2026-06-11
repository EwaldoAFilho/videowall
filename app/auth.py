"""Autenticação: hash de senha (PBKDF2) e sessões por cookie."""
import hashlib
import secrets
import time

from . import config, db

PBKDF2_ITER = 240_000
COOKIE_NAME = "vw_session"


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITER)
    return f"{salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, expected = stored.split("$", 1)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITER)
        return secrets.compare_digest(dk.hex(), expected)
    except Exception:
        return False


def create_session(con) -> str:
    token = secrets.token_urlsafe(32)
    expires = time.time() + config.SESSION_TTL_DAYS * 86400
    con.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
    con.execute(
        "INSERT INTO sessions(token,created_at,expires_at) VALUES(?,?,?)",
        (token, db.now_iso(), expires),
    )
    return token


def session_valid(con, token: str) -> bool:
    if not token:
        return False
    row = con.execute("SELECT expires_at FROM sessions WHERE token=?", (token,)).fetchone()
    return bool(row and row["expires_at"] > time.time())


def delete_session(con, token: str):
    con.execute("DELETE FROM sessions WHERE token=?", (token,))


def check_login(con, username: str, password: str) -> bool:
    user = db.get_setting(con, "admin_user", "admin")
    stored = db.get_setting(con, "admin_password_hash", "")
    return secrets.compare_digest(username or "", user) and verify_password(password or "", stored)


def using_default_password(con) -> bool:
    stored = db.get_setting(con, "admin_password_hash", "")
    return verify_password("admin", stored)
