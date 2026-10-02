"""Cuentas, sesiones por cookie, límite de intentos y fecha local del usuario."""

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import Depends, HTTPException, Request
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .database import get_db
from .models import AuthToken, User

COOKIE_NAME = "dle_session"
SESSION_DAYS = 60
SCRYPT = {"n": 2**14, "r": 8, "p": 1}


# ------------------------------------------------------------------ contraseñas


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), dklen=len(expected), n=int(n), r=int(r), p=int(p)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# A los usuarios inexistentes también se les calcula un hash, para que el
# tiempo de respuesta no revele qué nombres existen.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


def check_credentials(db: Session, username: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.username == username.lower()))
    if user is None:
        verify_password(password, _DUMMY_HASH)
        return None
    return user if verify_password(password, user.password_hash) else None


# ------------------------------------------------------------------- sesiones


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def start_session(db: Session, user: User, request: Request, response) -> None:
    token = secrets.token_urlsafe(32)
    db.add(AuthToken(token_hash=_hash_token(token), user_id=user.id,
                     expires_at=_utcnow() + timedelta(days=SESSION_DAYS)))
    # Limpieza oportunista de sesiones caducadas.
    db.execute(delete(AuthToken).where(AuthToken.expires_at < _utcnow()))
    db.commit()
    response.set_cookie(
        COOKIE_NAME, token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def end_session(db: Session, request: Request, response) -> None:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        db.execute(delete(AuthToken).where(AuthToken.token_hash == _hash_token(token)))
        db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")


def optional_user(request: Request, db: Session = Depends(get_db)) -> User | None:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    row = db.scalar(select(AuthToken).where(AuthToken.token_hash == _hash_token(token)))
    if row is None or row.expires_at < _utcnow():
        return None
    return row.user


def current_user(user: User | None = Depends(optional_user)) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Inicia sesión para continuar")
    return user


# ------------------------------------------------------- límite de intentos


class RateLimiter:
    """Ventana deslizante en memoria (suficiente para una sola instancia)."""

    def __init__(self, attempts: int, seconds: int):
        self.attempts, self.seconds = attempts, seconds
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self.seconds:
                hits.popleft()
            if len(hits) >= self.attempts:
                raise HTTPException(status_code=429, detail="Demasiados intentos. Espera unos minutos.")
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


auth_limiter = RateLimiter(attempts=10, seconds=300)
icon_limiter = RateLimiter(attempts=30, seconds=600)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


# ------------------------------------------------------------ fecha local


def user_today(request: Request) -> date:
    """Hoy en la zona horaria del navegador (cabecera X-Timezone, p. ej. America/Santiago).

    Así la racha cambia de día a medianoche del usuario y no a la del servidor.
    """
    tz_name = request.headers.get("x-timezone", "")
    if tz_name and len(tz_name) < 64:
        try:
            return datetime.now(ZoneInfo(tz_name)).date()
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return date.today()
