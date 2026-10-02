import hashlib
import os

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, undefer

from ..auth import client_ip, current_user, icon_limiter
from ..database import SessionLocal, get_db
from ..models import Game, User
from ..schemas import METRIC_FLAG, GameCreate, GameOut, GameUpdate
from ..services import favicon

router = APIRouter(prefix="/api/games", tags=["games"])

MAX_GAMES_PER_USER = 100
ICON_MEDIA_TYPES = {
    "png": "image/png", "jpg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "ico": "image/x-icon", "svg": "image/svg+xml",
}
# Un SVG descargado de internet podría traer scripts: se sirve aislado.
ICON_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=31536000, immutable",
}


def auto_fetch_enabled() -> bool:
    return os.environ.get("DLE_DISABLE_ICON_FETCH") != "1"


def get_game_or_404(db: Session, game_id: int, user: User) -> Game:
    """El juego, solo si pertenece al usuario (si no, 404: no se revela que existe)."""
    game = db.get(Game, game_id)
    if game is None or game.user_id != user.id:
        raise HTTPException(status_code=404, detail="Juego no encontrado")
    return game


def _check_consistency(db: Session, game: Game) -> None:
    if not getattr(game, METRIC_FLAG[game.primary_metric]):
        raise HTTPException(
            status_code=422,
            detail="La métrica principal debe estar entre las métricas que registra el juego",
        )
    duplicate = db.scalar(
        select(Game.id).where(
            Game.user_id == game.user_id,
            func.lower(Game.name) == game.name.lower(),
            Game.id != (game.id or -1),
        )
    )
    if duplicate is not None:
        raise HTTPException(status_code=409, detail=f"Ya existe un juego llamado «{game.name}»")


# ------------------------------------------------------------------ iconos


def _remove_icon(game: Game) -> None:
    game.icon_file = None
    game.icon_data = None


def _fetch_icon(game: Game) -> None:
    """Descarga el mejor icono de game.url y lo guarda en la base de datos."""
    if not game.url:
        raise favicon.IconNotFound("El juego no tiene URL")
    data, ext, _ = favicon.fetch_best_icon(game.url)
    game.icon_data = data
    game.icon_file = f"{hashlib.sha1(data).hexdigest()[:12]}.{ext}"


def _try_fetch_icon(game: Game) -> bool:
    try:
        _fetch_icon(game)
        return True
    except Exception:
        return False


def fetch_icons_background(game_ids: list[int]) -> None:
    """Descarga iconos después de responder (p. ej. juegos de ejemplo de una cuenta nueva)."""
    with SessionLocal() as db:
        for game in db.scalars(select(Game).where(Game.id.in_(game_ids), Game.icon_file.is_(None))):
            if _try_fetch_icon(game):
                db.commit()


@router.post("/icons/fetch-missing")
def fetch_missing_icons(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Intenta descargar el icono de los juegos con URL que aún no tienen."""
    icon_limiter.check(f"{user.id}:{client_ip(request)}")
    updated, failed = [], []
    query = select(Game).where(Game.user_id == user.id, Game.url.is_not(None), Game.icon_file.is_(None))
    for game in db.scalars(query.order_by(Game.name)):
        (updated if _try_fetch_icon(game) else failed).append(game.name)
        db.commit()
    return {"updated": updated, "failed": failed}


# ------------------------------------------------------------------ CRUD


@router.get("", response_model=list[GameOut])
def list_games(include_inactive: bool = True, user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = select(Game).where(Game.user_id == user.id).order_by(Game.name)
    if not include_inactive:
        query = query.where(Game.active.is_(True))
    return db.scalars(query).all()


@router.post("", response_model=GameOut, status_code=201)
def create_game(payload: GameCreate, request: Request, fetch_icon: bool = True,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    count = db.scalar(select(func.count(Game.id)).where(Game.user_id == user.id))
    if count >= MAX_GAMES_PER_USER:
        raise HTTPException(status_code=422, detail=f"Máximo {MAX_GAMES_PER_USER} juegos por cuenta")
    game = Game(user_id=user.id, **payload.model_dump())
    _check_consistency(db, game)
    db.add(game)
    db.commit()
    if fetch_icon and game.url and auto_fetch_enabled():
        icon_limiter.check(f"{user.id}:{client_ip(request)}")
        if _try_fetch_icon(game):
            db.commit()
    db.refresh(game)
    return game


@router.get("/{game_id}", response_model=GameOut)
def get_game(game_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return get_game_or_404(db, game_id, user)


@router.put("/{game_id}", response_model=GameOut)
def update_game(game_id: int, payload: GameUpdate, request: Request,
                user: User = Depends(current_user), db: Session = Depends(get_db)):
    game = get_game_or_404(db, game_id, user)
    old_url = game.url
    for field, value in payload.model_dump(exclude_unset=True).items():
        # null solo tiene sentido para la URL (quitarla); en el resto se ignora.
        if value is None and field != "url":
            continue
        setattr(game, field, value)
    _check_consistency(db, game)
    if game.url != old_url:
        # El icono pertenecía a la URL anterior.
        fetched = False
        if game.url and auto_fetch_enabled():
            icon_limiter.check(f"{user.id}:{client_ip(request)}")
            fetched = _try_fetch_icon(game)
        if not fetched:
            _remove_icon(game)
    db.commit()
    db.refresh(game)
    return game


@router.delete("/{game_id}", status_code=204)
def delete_game(game_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Elimina el juego y todas sus partidas (ON DELETE CASCADE)."""
    db.delete(get_game_or_404(db, game_id, user))
    db.commit()
    return Response(status_code=204)


# ----------------------------------------------------------- icono: endpoints


@router.get("/{game_id}/icon", include_in_schema=False)
def get_icon(game_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    game = db.scalar(select(Game).where(Game.id == game_id, Game.user_id == user.id).options(undefer(Game.icon_data)))
    if game is None or not game.icon_file or not game.icon_data:
        raise HTTPException(status_code=404, detail="Este juego no tiene icono descargado")
    ext = game.icon_file.rsplit(".", 1)[-1]
    return Response(game.icon_data, media_type=ICON_MEDIA_TYPES.get(ext, "application/octet-stream"),
                    headers=ICON_HEADERS)


@router.post("/{game_id}/icon", response_model=GameOut)
def refresh_icon(game_id: int, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """(Re)descarga el mejor icono disponible en la URL del juego."""
    game = get_game_or_404(db, game_id, user)
    if not game.url:
        raise HTTPException(status_code=422, detail="El juego no tiene URL de la que obtener el icono")
    icon_limiter.check(f"{user.id}:{client_ip(request)}")
    try:
        _fetch_icon(game)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"No se pudo obtener el icono de {game.url}") from exc
    db.commit()
    db.refresh(game)
    return game


@router.delete("/{game_id}/icon", response_model=GameOut)
def delete_icon(game_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Quita el icono descargado; el juego vuelve a mostrar su emoji."""
    game = get_game_or_404(db, game_id, user)
    _remove_icon(game)
    db.commit()
    db.refresh(game)
    return game
