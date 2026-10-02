import hashlib
import os

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import ICONS_DIR, get_db
from ..models import Game
from ..schemas import METRIC_FLAG, GameCreate, GameOut, GameUpdate
from ..services import favicon

router = APIRouter(prefix="/api/games", tags=["games"])

ICON_MEDIA_TYPES = {
    "png": "image/png", "jpg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "ico": "image/x-icon", "svg": "image/svg+xml",
}
# Un SVG descargado de internet podría traer scripts: se sirve aislado.
ICON_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "public, max-age=31536000, immutable",
}


def _auto_fetch_enabled() -> bool:
    return os.environ.get("DLE_DISABLE_ICON_FETCH") != "1"


def get_game_or_404(db: Session, game_id: int) -> Game:
    game = db.get(Game, game_id)
    if game is None:
        raise HTTPException(status_code=404, detail="Juego no encontrado")
    return game


def _check_consistency(db: Session, game: Game) -> None:
    if not getattr(game, METRIC_FLAG[game.primary_metric]):
        raise HTTPException(
            status_code=422,
            detail="La métrica principal debe estar entre las métricas que registra el juego",
        )
    duplicate = db.scalar(
        select(Game.id).where(func.lower(Game.name) == game.name.lower(), Game.id != (game.id or -1))
    )
    if duplicate is not None:
        raise HTTPException(status_code=409, detail=f"Ya existe un juego llamado «{game.name}»")


def _remove_icon(game: Game) -> None:
    if game.icon_file:
        (ICONS_DIR / os.path.basename(game.icon_file)).unlink(missing_ok=True)
        game.icon_file = None


def _fetch_icon(game: Game) -> None:
    """Descarga y guarda el mejor icono de game.url. Lanza IconNotFound si no hay."""
    if not game.url:
        raise favicon.IconNotFound("El juego no tiene URL")
    data, ext, _ = favicon.fetch_best_icon(game.url)
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    name = f"game-{game.id}-{hashlib.sha1(data).hexdigest()[:12]}.{ext}"
    (ICONS_DIR / name).write_bytes(data)
    if game.icon_file != name:
        _remove_icon(game)
        game.icon_file = name


def _try_fetch_icon(game: Game) -> bool:
    try:
        _fetch_icon(game)
        return True
    except Exception:
        return False


@router.post("/icons/fetch-missing")
def fetch_missing_icons(db: Session = Depends(get_db)):
    """Intenta descargar el icono de todos los juegos con URL que aún no tienen."""
    updated, failed = [], []
    for game in db.scalars(select(Game).where(Game.url.is_not(None), Game.icon_file.is_(None))):
        (updated if _try_fetch_icon(game) else failed).append(game.name)
        db.commit()
    return {"updated": updated, "failed": failed}


@router.get("", response_model=list[GameOut])
def list_games(include_inactive: bool = True, db: Session = Depends(get_db)):
    query = select(Game).order_by(Game.name)
    if not include_inactive:
        query = query.where(Game.active.is_(True))
    return db.scalars(query).all()


@router.post("", response_model=GameOut, status_code=201)
def create_game(payload: GameCreate, fetch_icon: bool = True, db: Session = Depends(get_db)):
    game = Game(**payload.model_dump())
    _check_consistency(db, game)
    db.add(game)
    db.commit()
    if fetch_icon and game.url and _auto_fetch_enabled() and _try_fetch_icon(game):
        db.commit()
    db.refresh(game)
    return game


@router.get("/{game_id}", response_model=GameOut)
def get_game(game_id: int, db: Session = Depends(get_db)):
    return get_game_or_404(db, game_id)


@router.put("/{game_id}", response_model=GameOut)
def update_game(game_id: int, payload: GameUpdate, db: Session = Depends(get_db)):
    game = get_game_or_404(db, game_id)
    old_url = game.url
    for field, value in payload.model_dump(exclude_unset=True).items():
        # null solo tiene sentido para la URL (quitarla); en el resto se ignora.
        if value is None and field != "url":
            continue
        setattr(game, field, value)
    _check_consistency(db, game)
    if game.url != old_url:
        # El icono pertenecía a la URL anterior.
        if not (game.url and _auto_fetch_enabled() and _try_fetch_icon(game)):
            _remove_icon(game)
    db.commit()
    db.refresh(game)
    return game


@router.delete("/{game_id}", status_code=204)
def delete_game(game_id: int, db: Session = Depends(get_db)):
    """Elimina el juego y todas sus partidas (ON DELETE CASCADE)."""
    game = get_game_or_404(db, game_id)
    _remove_icon(game)
    db.delete(game)
    db.commit()
    return Response(status_code=204)


@router.get("/{game_id}/icon", include_in_schema=False)
def get_icon(game_id: int, db: Session = Depends(get_db)):
    game = get_game_or_404(db, game_id)
    path = ICONS_DIR / os.path.basename(game.icon_file or "")
    if not game.icon_file or not path.is_file():
        raise HTTPException(status_code=404, detail="Este juego no tiene icono descargado")
    media_type = ICON_MEDIA_TYPES.get(path.suffix.lstrip("."), "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers=ICON_HEADERS)


@router.post("/{game_id}/icon", response_model=GameOut)
def refresh_icon(game_id: int, db: Session = Depends(get_db)):
    """(Re)descarga el mejor icono disponible en la URL del juego."""
    game = get_game_or_404(db, game_id)
    if not game.url:
        raise HTTPException(status_code=422, detail="El juego no tiene URL de la que obtener el icono")
    try:
        _fetch_icon(game)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo obtener el icono de {game.url}") from exc
    db.commit()
    db.refresh(game)
    return game


@router.delete("/{game_id}/icon", response_model=GameOut)
def delete_icon(game_id: int, db: Session = Depends(get_db)):
    """Quita el icono descargado; el juego vuelve a mostrar su emoji."""
    game = get_game_or_404(db, game_id)
    _remove_icon(game)
    db.commit()
    db.refresh(game)
    return game
