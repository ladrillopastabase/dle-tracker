from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select

from app.database import SessionLocal
from app.models import Game
from app.seed import SEED_GAMES

from .conftest import PASSWORD, register


# ------------------------------------------------------------- cuentas


def test_register_login_logout(anon):
    assert anon.get("/api/auth/me").status_code == 401
    response = anon.post("/api/auth/register", json={"username": "  Isi_99 ", "password": PASSWORD})
    assert response.status_code == 201
    assert response.json() == {"username": "isi_99"}
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert anon.get("/api/auth/me").json() == {"username": "isi_99"}

    assert anon.post("/api/auth/logout").status_code == 204
    assert anon.get("/api/auth/me").status_code == 401
    assert anon.get("/api/games").status_code == 401

    assert anon.post("/api/auth/login", json={"username": "ISI_99", "password": "wrong-pass"}).status_code == 401
    assert anon.post("/api/auth/login", json={"username": "nadie", "password": PASSWORD}).status_code == 401
    assert anon.post("/api/auth/login", json={"username": "ISI_99", "password": PASSWORD}).status_code == 200
    assert anon.get("/api/games").status_code == 200


def test_register_validation(anon):
    bad = [
        {"username": "ab", "password": PASSWORD},
        {"username": "con espacio", "password": PASSWORD},
        {"username": "ok_user", "password": "corta"},
        {"username": "ok_user"},
    ]
    for payload in bad:
        response = anon.post("/api/auth/register", json=payload)
        assert response.status_code == 422, payload
        assert response.json()["detail"]
    register(anon, "ok_user")
    assert anon.post("/api/auth/register", json={"username": "OK_USER", "password": PASSWORD}).status_code == 409


def test_everything_requires_login(anon):
    for method, path in [("get", "/api/games"), ("post", "/api/games"), ("get", "/api/sessions"),
                         ("get", "/api/stats"), ("get", "/api/streaks"), ("get", "/api/export"),
                         ("get", "/api/calendar?year=2026&month=1"), ("get", "/api/games/1/icon")]:
        assert getattr(anon, method)(path).status_code == 401, path


def test_login_rate_limited(anon):
    register(anon, "victima")
    codes = [anon.post("/api/auth/login", json={"username": "victima", "password": "x" * 8}).status_code
             for _ in range(12)]
    assert codes[0] == 401
    assert codes[-1] == 429


def test_delete_account_removes_data(client, wordle):
    client.post("/api/sessions", json={"game_id": wordle["id"], "played_at": datetime.now().date().isoformat(),
                                       "result": "win"})
    assert client.request("DELETE", "/api/auth/me", json={"password": "incorrecta"}).status_code == 403
    assert client.request("DELETE", "/api/auth/me", json={"password": PASSWORD}).status_code == 204
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json={"username": "tester", "password": PASSWORD}).status_code == 401
    with SessionLocal() as db:
        assert db.scalar(select(Game.id)) is None


def test_new_account_gets_example_games(anon, monkeypatch):
    monkeypatch.delenv("DLE_SKIP_SEED")
    register(anon, "nueva")
    names = sorted(g["name"] for g in anon.get("/api/games").json())
    assert names == sorted(g["name"] for g in SEED_GAMES)


def test_first_account_claims_single_user_data(anon, monkeypatch):
    """Los juegos de la versión monousuario (sin dueño) pasan a la primera cuenta."""
    monkeypatch.delenv("DLE_SKIP_SEED")
    with SessionLocal() as db:
        db.add(Game(name="Mi Wordle"))
        db.commit()
    register(anon, "duena")
    assert [g["name"] for g in anon.get("/api/games").json()] == ["Mi Wordle"]


# ----------------------------------------------------------- aislamiento


def test_users_cannot_see_or_touch_each_other(client, other, wordle):
    today = datetime.now().date().isoformat()
    session = client.post("/api/sessions", json={"game_id": wordle["id"], "played_at": today, "result": "win"}).json()

    assert other.get("/api/games").json() == []
    assert other.get("/api/sessions").json() == []
    assert other.get("/api/stats").json()["total_sessions"] == 0
    assert other.get("/api/export").json()["games"] == []
    for method, path, body in [
        ("get", f"/api/games/{wordle['id']}", None),
        ("put", f"/api/games/{wordle['id']}", {"name": "hack"}),
        ("delete", f"/api/games/{wordle['id']}", None),
        ("get", f"/api/stats/{wordle['id']}", None),
        ("get", f"/api/games/{wordle['id']}/icon", None),
        ("post", f"/api/games/{wordle['id']}/icon", None),
        ("get", f"/api/sessions/{session['id']}", None),
        ("put", f"/api/sessions/{session['id']}", {"result": "loss"}),
        ("delete", f"/api/sessions/{session['id']}", None),
    ]:
        response = other.request(method.upper(), path, json=body)
        assert response.status_code == 404, (method, path)

    # Tampoco puede registrar partidas en un juego ajeno ni moverlas a él.
    assert other.post("/api/sessions", json={"game_id": wordle["id"], "played_at": today, "result": "win"}).status_code == 404
    own = other.post("/api/games", json={"name": "Wordle"}).json()  # mismo nombre: permitido
    mine = other.post("/api/sessions", json={"game_id": own["id"], "played_at": today, "result": "win"}).json()
    assert other.put(f"/api/sessions/{mine['id']}", json={"game_id": wordle["id"]}).status_code == 404

    assert client.get(f"/api/sessions/{session['id']}").json()["result"] == "win"
    assert len(client.get("/api/games").json()) == 1


# --------------------------------------------------------- zona horaria


def test_today_follows_browser_timezone(client, wordle):
    # Kiritimati (UTC+14) y Pago Pago (UTC-11) siempre están en días distintos.
    ahead = datetime.now(ZoneInfo("Pacific/Kiritimati")).date()
    behind = datetime.now(ZoneInfo("Pacific/Pago_Pago")).date()
    assert ahead > behind
    payload = {"game_id": wordle["id"], "played_at": ahead.isoformat(), "result": "win"}

    response = client.post("/api/sessions", json=payload, headers={"X-Timezone": "Pacific/Pago_Pago"})
    assert response.status_code == 422
    assert "futuro" in response.json()["detail"]
    assert client.post("/api/sessions", json=payload, headers={"X-Timezone": "Pacific/Kiritimati"}).status_code == 201

    stats = client.get("/api/stats", headers={"X-Timezone": "Pacific/Kiritimati"}).json()
    assert stats["today"] == ahead.isoformat()
    assert stats["played_today"] == 1
    assert client.get("/api/stats", headers={"X-Timezone": "Pacific/Pago_Pago"}).json()["current_streak"] == 0
    # Zona inválida: se ignora y se usa la del servidor.
    assert client.get("/api/stats", headers={"X-Timezone": "Marte/Olympus"}).status_code == 200


# -------------------------------------------------------------- varios


def test_cross_site_requests_rejected(client):
    response = client.post("/api/games", json={"name": "X"}, headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert client.post("/api/games", json={"name": "X"}, headers={"Origin": "http://testserver"}).status_code == 201


def test_health_and_security_headers(anon):
    response = anon.get("/api/health")
    assert response.json() == {"status": "ok"}
    assert response.headers["x-frame-options"] == "DENY"
