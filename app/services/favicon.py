"""Obtiene el icono de mejor calidad de la página de un juego.

1. Descarga el HTML de la URL del juego.
2. Reúne candidatos: <link rel="icon">, apple-touch-icon, iconos del web
   manifest y, como último recurso, /favicon.ico.
3. Los ordena por calidad (SVG primero, luego el tamaño declarado más grande)
   y descarga el primero que resulte ser una imagen válida.

La descarga HTTP pasa por ``http_get`` para poder sustituirla en los tests.

Seguridad: como cualquiera puede indicar una URL, el servidor solo visita
direcciones públicas de internet (nada de localhost, redes privadas ni la IP
de metadatos de la nube), y lo comprueba en cada redirección. Para pruebas
locales se puede desactivar con DLE_ALLOW_PRIVATE_FETCH=1.
"""

import ipaddress
import json
import os
import re
import socket
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

TIMEOUT = httpx.Timeout(6.0, connect=4.0)
MAX_HTML_BYTES = 1_500_000
MAX_ICON_BYTES = 1_000_000
MAX_ATTEMPTS = 6
MAX_REDIRECTS = 5
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0 Safari/537.36 dle-tracker"
)

# Tamaño supuesto cuando el sitio no declara `sizes`.
DEFAULT_SIZE = {"apple-touch-icon": 180, "apple-touch-icon-precomposed": 180}
SVG_SCORE = 10_000


class IconNotFound(Exception):
    """No se encontró ningún icono válido."""


@dataclass
class Candidate:
    url: str
    size: int  # lado mayor en píxeles (SVG_SCORE para vectoriales)
    source: str

    @property
    def score(self) -> int:
        return self.size


# Los tests pueden inyectar un httpx.MockTransport.
_transport: httpx.BaseTransport | None = None


class BlockedURL(ValueError):
    """La URL apunta a una dirección no pública."""


def check_public_url(url: str) -> None:
    """Lanza BlockedURL si la URL no es http(s) o resuelve a una IP no pública."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise BlockedURL(url)
    if os.environ.get("DLE_ALLOW_PRIVATE_FETCH") == "1":
        return
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except (socket.gaierror, UnicodeError) as exc:
        raise BlockedURL(url) from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global or ip.is_multicast:
            raise BlockedURL(url)


def http_get(url: str, max_bytes: int) -> tuple[bytes, str, str]:
    """GET con límite de tamaño. Devuelve (contenido, content-type, url final).

    Las redirecciones se siguen a mano para validar cada destino.
    """
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, headers={"User-Agent": USER_AGENT},
                      transport=_transport) as client:
        for _ in range(MAX_REDIRECTS + 1):
            check_public_url(url)
            with client.stream("GET", url) as response:
                if response.is_redirect and response.headers.get("location"):
                    url = urljoin(url, response.headers["location"])
                    continue
                response.raise_for_status()
                chunks, total = [], 0
                for chunk in response.iter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise ValueError("respuesta demasiado grande")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers.get("content-type", ""), str(response.url)
        raise ValueError("demasiadas redirecciones")


# ------------------------------------------------------------------ parsing


class _LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[dict] = []
        self.base: str | None = None

    def handle_starttag(self, tag, attrs):
        attrs = {k.lower(): (v or "") for k, v in attrs}
        if tag == "link":
            self.links.append(attrs)
        elif tag == "base" and attrs.get("href") and self.base is None:
            self.base = attrs["href"]


def _max_size(sizes: str) -> int | None:
    """'16x16 32x32' → 32; 'any' → SVG_SCORE; vacío → None."""
    sizes = sizes.strip().lower()
    if not sizes:
        return None
    if "any" in sizes.split():
        return SVG_SCORE
    found = [max(int(w), int(h)) for w, h in re.findall(r"(\d+)\s*x\s*(\d+)", sizes)]
    return max(found) if found else None


def _is_svg(url: str, mime: str = "") -> bool:
    return "svg" in mime.lower() or urlparse(url).path.lower().endswith(".svg")


def find_candidates(html: str, page_url: str) -> tuple[list[Candidate], str | None]:
    """Candidatos declarados en el HTML y la URL del manifest (si hay)."""
    parser = _LinkParser()
    try:
        parser.feed(html)
    except Exception:  # HTML muy roto: nos quedamos con lo que se haya leído
        pass
    base = urljoin(page_url, parser.base) if parser.base else page_url
    candidates, manifest = [], None
    for link in parser.links:
        rels = set(link.get("rel", "").lower().split())
        href = link.get("href", "").strip()
        if not href or href.startswith("data:"):
            continue
        url = urljoin(base, href)
        if "manifest" in rels:
            manifest = manifest or url
            continue
        rel = next((r for r in ("apple-touch-icon", "apple-touch-icon-precomposed", "icon") if r in rels), None)
        if rel is None:
            continue  # mask-icon (monocromo), preload, etc.
        size = _max_size(link.get("sizes", ""))
        if _is_svg(url, link.get("type", "")):
            size = SVG_SCORE
        elif size is None:
            size = DEFAULT_SIZE.get(rel, 32)
        candidates.append(Candidate(url, size, rel))
    return candidates, manifest


def manifest_candidates(data: bytes, manifest_url: str) -> list[Candidate]:
    try:
        manifest = json.loads(data.decode("utf-8", errors="replace"))
    except ValueError:
        return []
    result = []
    for icon in manifest.get("icons", []) if isinstance(manifest, dict) else []:
        if not isinstance(icon, dict) or not icon.get("src"):
            continue
        purpose = str(icon.get("purpose", "any")).split()
        if purpose == ["monochrome"]:
            continue
        url = urljoin(manifest_url, icon["src"])
        size = SVG_SCORE if _is_svg(url, str(icon.get("type", ""))) else (_max_size(str(icon.get("sizes", ""))) or 48)
        if "any" not in purpose:
            size = int(size * 0.9)  # los "maskable" llevan relleno: algo menos preferibles
        result.append(Candidate(url, size, "manifest"))
    return result


# ---------------------------------------------------------------- validación

_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"GIF87a", "gif"),
    (b"GIF89a", "gif"),
    (b"\x00\x00\x01\x00", "ico"),
)


def detect_image(data: bytes) -> str | None:
    """Extensión según los bytes reales del archivo, o None si no es una imagen."""
    for magic, ext in _SIGNATURES:
        if data.startswith(magic):
            return ext
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    head = data[:1024].lstrip().lower()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in data[:4096].lower()):
        return "svg"
    return None


# ------------------------------------------------------------------ principal


def fetch_best_icon(page_url: str) -> tuple[bytes, str, str]:
    """Devuelve (bytes, extensión, url del icono) del mejor icono disponible."""
    candidates: list[Candidate] = []
    final_url = page_url
    try:
        html, _, final_url = http_get(page_url, MAX_HTML_BYTES)
        found, manifest_url = find_candidates(html.decode("utf-8", errors="replace"), final_url)
        candidates += found
        if manifest_url:
            try:
                data, _, _ = http_get(manifest_url, 300_000)
                candidates += manifest_candidates(data, manifest_url)
            except Exception:
                pass
    except Exception:
        pass  # aunque la página falle, se prueba /favicon.ico
    parsed = urlparse(final_url)
    candidates.append(Candidate(f"{parsed.scheme}://{parsed.netloc}/favicon.ico", 16, "fallback"))

    seen, ordered = set(), []
    for c in sorted(candidates, key=lambda c: c.score, reverse=True):
        if c.url not in seen and urlparse(c.url).scheme in ("http", "https"):
            seen.add(c.url)
            ordered.append(c)

    for candidate in ordered[:MAX_ATTEMPTS]:
        try:
            data, _, _ = http_get(candidate.url, MAX_ICON_BYTES)
        except Exception:
            continue
        ext = detect_image(data)
        if ext:
            return data, ext, candidate.url
    raise IconNotFound(f"No se encontró un icono en {page_url}")
