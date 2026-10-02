import json

import httpx
import pytest
from sqlalchemy import create_engine, inspect, text

from app.database import ICONS_DIR, ensure_schema
from app.services import favicon

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 20
PNG_BIG = b"\x89PNG\r\n\x1a\n" + b"1" * 20
ICO = b"\x00\x00\x01\x00" + b"2" * 20
SVG = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'

PAGE = """
<html><head>
  <link rel="icon" href="/favicon-16.png" sizes="16x16">
  <link rel="shortcut icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32 96x96" href="img/fav-96.png">
  <link rel="apple-touch-icon" href="https://cdn.example.com/apple.png">
  <link rel="mask-icon" href="/mask.svg" color="#000">
  <link rel="manifest" href="/site.webmanifest">
  <link rel="stylesheet" href="/x.css">
</head></html>
"""


def fake_web(monkeypatch, pages):
    """Sustituye la red: `pages` mapea URL → bytes (o una excepción)."""
    calls = []

    def http_get(url, max_bytes):
        calls.append(url)
        value = pages.get(url)
        if value is None:
            raise RuntimeError("404")
        if isinstance(value, Exception):
            raise value
        return value, "", url

    monkeypatch.setattr(favicon, "http_get", http_get)
    return calls


# ------------------------------------------------------------------ parsing


def test_find_candidates_reads_links_and_sizes():
    found, manifest = favicon.find_candidates(PAGE, "https://game.example.com/play/")
    by_url = {c.url: c.size for c in found}
    assert by_url == {
        "https://game.example.com/favicon-16.png": 16,
        "https://game.example.com/favicon.ico": 32,
        "https://game.example.com/play/img/fav-96.png": 96,
        "https://cdn.example.com/apple.png": 180,
    }
    assert manifest == "https://game.example.com/site.webmanifest"


def test_svg_icons_rank_highest_and_base_href_respected():
    html = '<base href="https://other.example/assets/"><link rel="icon" href="logo.svg">'
    found, _ = favicon.find_candidates(html, "https://game.example.com/")
    assert found[0].url == "https://other.example/assets/logo.svg"
    assert found[0].size == favicon.SVG_SCORE


def test_manifest_candidates():
    data = json.dumps({"icons": [
        {"src": "/icons/192.png", "sizes": "192x192"},
        {"src": "/icons/512.png", "sizes": "512x512", "purpose": "maskable"},
        {"src": "/icons/mono.png", "sizes": "512x512", "purpose": "monochrome"},
    ]}).encode()
    found = favicon.manifest_candidates(data, "https://g.example/site.webmanifest")
    assert {c.url: c.size for c in found} == {
        "https://g.example/icons/192.png": 192,
        "https://g.example/icons/512.png": 460,  # maskable penalizado
    }
    assert favicon.manifest_candidates(b"not json", "https://g.example/m.json") == []


def test_detect_image():
    assert favicon.detect_image(PNG) == "png"
    assert favicon.detect_image(ICO) == "ico"
    assert favicon.detect_image(SVG) == "svg"
    assert favicon.detect_image(b"\xff\xd8\xff\xe0rest") == "jpg"
    assert favicon.detect_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "webp"
    assert favicon.detect_image(b"<!doctype html><html>not found</html>") is None


# ------------------------------------------------------------- selección


def test_fetch_best_icon_picks_largest(monkeypatch):
    manifest = json.dumps({"icons": [{"src": "/icon-512.png", "sizes": "512x512"}]}).encode()
    fake_web(monkeypatch, {
        "https://game.example.com/": PAGE.encode(),
        "https://game.example.com/site.webmanifest": manifest,
        "https://game.example.com/icon-512.png": PNG_BIG,
        "https://cdn.example.com/apple.png": PNG,
    })
    data, ext, url = favicon.fetch_best_icon("https://game.example.com/")
    assert (data, ext, url) == (PNG_BIG, "png", "https://game.example.com/icon-512.png")


def test_fetch_best_icon_skips_broken_and_non_images(monkeypatch):
    fake_web(monkeypatch, {
        "https://game.example.com/": PAGE.encode(),
        # apple.png (180) no existe, fav-96 devuelve HTML: debe caer en el siguiente.
        "https://game.example.com/play/img/fav-96.png": b"<html>oops</html>",
        "https://game.example.com/favicon.ico": ICO,
    })
    data, ext, url = favicon.fetch_best_icon("https://game.example.com/")
    assert ext == "ico" and url == "https://game.example.com/favicon.ico"


def test_falls_back_to_favicon_ico_when_page_fails(monkeypatch):
    fake_web(monkeypatch, {"https://down.example/favicon.ico": ICO})
    assert favicon.fetch_best_icon("https://down.example/game")[1] == "ico"


def test_raises_when_nothing_found(monkeypatch):
    fake_web(monkeypatch, {})
    with pytest.raises(favicon.IconNotFound):
        favicon.fetch_best_icon("https://nothing.example/")


# ------------------------------------------------------------------- API


@pytest.fixture()
def icon_source(monkeypatch):
    """Activa la descarga automática con un 'internet' falso: URL del juego → icono."""
    sources = {}

    def fetch(url):
        if url not in sources:
            raise favicon.IconNotFound(url)
        return sources[url], favicon.detect_image(sources[url]), url + "icon"

    monkeypatch.setenv("DLE_DISABLE_ICON_FETCH", "0")
    monkeypatch.setattr(favicon, "fetch_best_icon", fetch)
    return sources


def test_icon_downloaded_when_game_created(client, icon_source):
    icon_source["https://wordle.example/"] = SVG
    game = client.post("/api/games", json={"name": "Wordle", "url": "https://wordle.example/"}).json()
    assert game["icon_url"].startswith(f"/api/games/{game['id']}/icon?v=")
    response = client.get(game["icon_url"])
    assert response.status_code == 200
    assert response.content == SVG
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert "sandbox" in response.headers["content-security-policy"]


def test_game_created_even_if_icon_fails(client, icon_source):
    response = client.post("/api/games", json={"name": "X", "url": "https://broken.example/"})
    assert response.status_code == 201
    assert response.json()["icon_url"] is None
    assert client.get(f"/api/games/{response.json()['id']}/icon").status_code == 404


def test_icon_refetched_when_url_changes(client, icon_source):
    icon_source["https://a.example/"] = PNG
    icon_source["https://b.example/"] = ICO
    game = client.post("/api/games", json={"name": "X", "url": "https://a.example/"}).json()
    assert client.get(game["icon_url"]).content == PNG

    updated = client.put(f"/api/games/{game['id']}", json={"url": "https://b.example/"}).json()
    assert updated["icon_url"] != game["icon_url"]
    assert client.get(updated["icon_url"]).content == ICO
    assert client.get(updated["icon_url"]).headers["content-type"] == "image/x-icon"

    # Otros cambios no tocan el icono; quitar la URL lo elimina.
    assert client.put(f"/api/games/{game['id']}", json={"category": "x"}).json()["icon_url"] == updated["icon_url"]
    assert client.put(f"/api/games/{game['id']}", json={"url": None}).json()["icon_url"] is None


def test_refresh_and_remove_icon_endpoints(client, icon_source):
    game = client.post("/api/games", json={"name": "X", "url": "https://late.example/"}).json()
    assert client.post(f"/api/games/{game['id']}/icon").status_code == 502
    icon_source["https://late.example/"] = PNG
    refreshed = client.post(f"/api/games/{game['id']}/icon").json()
    assert refreshed["icon_url"]
    assert client.delete(f"/api/games/{game['id']}/icon").json()["icon_url"] is None
    no_url = client.post("/api/games", json={"name": "Y"}).json()
    assert client.post(f"/api/games/{no_url['id']}/icon").status_code == 422


def test_fetch_missing_icons(client, icon_source):
    icon_source["https://ok.example/"] = PNG
    client.post("/api/games", json={"name": "A", "url": "https://ok.example/"}, params={"fetch_icon": False})
    client.post("/api/games", json={"name": "B", "url": "https://ko.example/"}, params={"fetch_icon": False})
    client.post("/api/games", json={"name": "C"})
    assert client.post("/api/games/icons/fetch-missing").json() == {"updated": ["A"], "failed": ["B"]}


# ------------------------------------------------------------- SSRF


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/", "http://localhost:8000/", "http://10.0.0.5/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://0.0.0.0/",
    "ftp://example.com/", "file:///etc/passwd", "http:///nohost",
])
def test_private_and_odd_urls_blocked(url):
    with pytest.raises(favicon.BlockedURL):
        favicon.check_public_url(url)


def test_public_ip_allowed():
    favicon.check_public_url("https://93.184.216.34/")


def test_redirect_to_private_address_blocked(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})

    monkeypatch.setattr(favicon, "_transport", httpx.MockTransport(handler))
    with pytest.raises(favicon.BlockedURL):
        favicon.http_get("http://93.184.216.34/", 1000)
    assert seen == ["http://93.184.216.34/"]  # nunca se pidió la IP interna


def test_redirects_followed_and_size_limited(monkeypatch):
    def handler(request):
        if request.url.path == "/":
            return httpx.Response(301, headers={"location": "/icon.png"})
        return httpx.Response(200, content=PNG)

    monkeypatch.setattr(favicon, "_transport", httpx.MockTransport(handler))
    data, _, final = favicon.http_get("http://93.184.216.34/", 1000)
    assert data == PNG and final.endswith("/icon.png")
    with pytest.raises(ValueError):
        favicon.http_get("http://93.184.216.34/", 10)


# -------------------------------------------------------- migración


def test_migrates_single_user_database(tmp_path):
    """Una base de la versión anterior conserva sus datos y queda lista para cuentas."""
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(text("""CREATE TABLE games (
            id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
            url VARCHAR(500), category VARCHAR(50) NOT NULL DEFAULT '', icon VARCHAR(16) NOT NULL DEFAULT '',
            active BOOLEAN NOT NULL DEFAULT 1, track_attempts BOOLEAN NOT NULL DEFAULT 1,
            track_score BOOLEAN NOT NULL DEFAULT 0, track_time BOOLEAN NOT NULL DEFAULT 0,
            track_errors BOOLEAN NOT NULL DEFAULT 0, primary_metric VARCHAR(20) NOT NULL DEFAULT 'attempts',
            lower_is_better BOOLEAN NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
            icon_file VARCHAR(120))"""))
        conn.execute(text("""CREATE TABLE game_sessions (
            id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games (id) ON DELETE CASCADE,
            played_at DATE NOT NULL, result VARCHAR(10) NOT NULL, score FLOAT, attempts INTEGER,
            errors INTEGER, time_seconds INTEGER, notes TEXT NOT NULL DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL)"""))
        conn.execute(text("INSERT INTO games (id, name, icon, icon_file) VALUES (1, 'Wordle', 'W', 'game-1-abc.png')"))
        conn.execute(text("INSERT INTO game_sessions (game_id, played_at, result, attempts) VALUES (1, '2026-10-01', 'win', 3)"))
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    (ICONS_DIR / "game-1-abc.png").write_bytes(PNG)

    ensure_schema(engine)
    ensure_schema(engine)  # idempotente

    with engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        assert conn.execute(text("SELECT name, user_id, icon_data FROM games")).one() == ("Wordle", None, PNG)
        assert conn.execute(text("SELECT attempts FROM game_sessions")).scalar() == 3
        # Las FK de game_sessions siguen apuntando a la tabla games nueva.
        assert conn.execute(text("PRAGMA foreign_key_check")).fetchall() == []
        # El nombre ya solo es único por usuario.
        conn.execute(text("INSERT INTO users (id, username, password_hash) VALUES (1, 'a', 'x'), (2, 'b', 'x')"))
        conn.execute(text("UPDATE games SET user_id = 1"))
        conn.execute(text("INSERT INTO games (user_id, name, icon, active, track_attempts, track_score, track_time,"
                          " track_errors, primary_metric, lower_is_better, description, category)"
                          " VALUES (2, 'Wordle', 'W', 1, 1, 0, 0, 0, 'attempts', 1, '', '')"))
        conn.execute(text("DELETE FROM games WHERE id = 1"))
        assert conn.execute(text("SELECT COUNT(*) FROM game_sessions")).scalar() == 0  # cascade intacto
    assert {"users", "auth_tokens"} <= set(inspect(engine).get_table_names())
