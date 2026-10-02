from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Game
from ..schemas import METRIC_FLAG, GameCreate, GameOut, GameUpdate

router = APIRouter(prefix="/api/games", tags=["games"])


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


@router.get("", response_model=list[GameOut])
def list_games(include_inactive: bool = True, db: Session = Depends(get_db)):
    query = select(Game).order_by(Game.name)
    if not include_inactive:
        query = query.where(Game.active.is_(True))
    return db.scalars(query).all()


@router.post("", response_model=GameOut, status_code=201)
def create_game(payload: GameCreate, db: Session = Depends(get_db)):
    game = Game(**payload.model_dump())
    _check_consistency(db, game)
    db.add(game)
    db.commit()
    db.refresh(game)
    return game


@router.get("/{game_id}", response_model=GameOut)
def get_game(game_id: int, db: Session = Depends(get_db)):
    return get_game_or_404(db, game_id)


@router.put("/{game_id}", response_model=GameOut)
def update_game(game_id: int, payload: GameUpdate, db: Session = Depends(get_db)):
    game = get_game_or_404(db, game_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        # null solo tiene sentido para la URL (quitarla); en el resto se ignora.
        if value is None and field != "url":
            continue
        setattr(game, field, value)
    _check_consistency(db, game)
    db.commit()
    db.refresh(game)
    return game


@router.delete("/{game_id}", status_code=204)
def delete_game(game_id: int, db: Session = Depends(get_db)):
    """Elimina el juego y todas sus partidas (ON DELETE CASCADE)."""
    db.delete(get_game_or_404(db, game_id))
    db.commit()
    return Response(status_code=204)
