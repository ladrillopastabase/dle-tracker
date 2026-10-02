from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_user, user_today
from ..database import get_db
from ..models import Game, GameSession, User
from ..schemas import GameOut, SessionOut
from ..services import stats as stats_service
from ..services.streaks import streaks
from .games import get_game_or_404

router = APIRouter(prefix="/api", tags=["stats"])


def _all(db: Session, user: User) -> tuple[list[Game], list[GameSession]]:
    games = list(db.scalars(select(Game).where(Game.user_id == user.id).order_by(Game.name)))
    sessions = list(db.scalars(
        select(GameSession).join(Game).where(Game.user_id == user.id).order_by(GameSession.played_at)
    ))
    return games, sessions


@router.get("/stats")
def overview(user: User = Depends(current_user), today: date = Depends(user_today), db: Session = Depends(get_db)):
    games, sessions = _all(db, user)
    return stats_service.overview(games, sessions, today)


@router.get("/stats/{game_id}")
def game_stats(game_id: int, user: User = Depends(current_user), today: date = Depends(user_today),
               db: Session = Depends(get_db)):
    game = get_game_or_404(db, game_id, user)
    sessions = list(db.scalars(select(GameSession).where(GameSession.game_id == game_id)))
    return stats_service.game_stats(game, sessions, today)


@router.get("/streaks")
def all_streaks(user: User = Depends(current_user), today: date = Depends(user_today), db: Session = Depends(get_db)):
    games, sessions = _all(db, user)
    return {
        "overall": streaks((s.played_at for s in sessions), today),
        "games": [
            {"game_id": g.id, **streaks((s.played_at for s in sessions if s.game_id == g.id), today)}
            for g in games
        ],
    }


@router.get("/calendar")
def calendar(year: int, month: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not 1 <= month <= 12 or not 1970 <= year <= 9999:
        raise HTTPException(status_code=422, detail="Mes o año inválido")
    _, sessions = _all(db, user)
    return {"year": year, "month": month, "days": stats_service.calendar_month(sessions, year, month)}


@router.get("/export")
def export(user: User = Depends(current_user), today: date = Depends(user_today), db: Session = Depends(get_db)):
    """Copia de seguridad en JSON de los datos del usuario."""
    games, sessions = _all(db, user)
    return {
        "exported_at": today,
        "user": user.username,
        "games": [GameOut.model_validate(g).model_dump() for g in games],
        "sessions": [SessionOut.model_validate(s).model_dump() for s in sessions],
    }
