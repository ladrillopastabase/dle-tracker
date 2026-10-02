import json

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


def test_icon_refetched_when_url_changes_and_files_cleaned(client, icon_source):
    icon_source["https://a.example/"] = PNG
    icon_source["https://b.example/"] = ICO
    game = client.post("/api/games", json={"name": "X", "url": "https://a.example/"}).json()
    first = sorted(ICONS_DIR.glob(f"game-{game['id']}-*"))
    assert len(first) == 1

    updated = client.put(f"/api/games/{game['id']}", json={"url": "https://b.example/"}).json()
    assert updated["icon_url"] != game["icon_url"]
    assert client.get(updated["icon_url"]).content == ICO
    assert not first[0].exists()

    # Sin URL no hay icono.
    assert client.put(f"/api/games/{game['id']}", json={"url": None}).json()["icon_url"] is None
    client.delete(f"/api/games/{game['id']}")
    assert not list(ICONS_DIR.glob(f"game-{game['id']}-*"))


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


def test_ensure_schema_adds_icon_column_to_old_database(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE games (id INTEGER PRIMARY KEY, name VARCHAR(80))"))
    ensure_schema(engine)
    assert "icon_file" in {c["name"] for c in inspect(engine).get_columns("games")}
