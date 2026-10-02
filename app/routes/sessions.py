from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import current_user, user_today
from ..database import get_db
from ..models import Game, GameSession, User
from ..schemas import Result, SessionCreate, SessionOut, SessionUpdate
from .games import get_game_or_404

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

# Campos que no admiten null; un null explícito en un PUT se ignora.
REQUIRED_FIELDS = {"game_id", "played_at", "result", "notes"}


def get_session_or_404(db: Session, session_id: int, user: User) -> GameSession:
    session = db.get(GameSession, session_id)
    if session is None or session.game.user_id != user.id:
        raise HTTPException(status_code=404, detail="Partida no encontrada")
    return session


def _check_not_future(played_at: date, today: date) -> None:
    if played_at > today:
        raise HTTPException(status_code=422, detail="La fecha no puede estar en el futuro")


def _check_unique_day(db: Session, session: GameSession) -> None:
    clash = db.scalar(
        select(GameSession.id).where(
            GameSession.game_id == session.game_id,
            GameSession.played_at == session.played_at,
            GameSession.id != (session.id or -1),
        )
    )
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail="Ya registraste una partida de este juego en esa fecha. Edítala desde el historial.",
        )


@router.get("", response_model=list[SessionOut])
def list_sessions(
    game_id: int | None = None,
    result: Result | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    order: Literal["asc", "desc"] = "desc",
    limit: int | None = None,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    query = select(GameSession).join(Game).where(Game.user_id == user.id)
    if game_id is not None:
        query = query.where(GameSession.game_id == game_id)
    if result is not None:
        query = query.where(GameSession.result == result)
    if date_from is not None:
        query = query.where(GameSession.played_at >= date_from)
    if date_to is not None:
        query = query.where(GameSession.played_at <= date_to)
    if order == "asc":
        query = query.order_by(GameSession.played_at.asc(), GameSession.id.asc())
    else:
        query = query.order_by(GameSession.played_at.desc(), GameSession.id.desc())
    if limit is not None:
        query = query.limit(max(limit, 0))
    return db.scalars(query).all()


@router.post("", response_model=SessionOut, status_code=201)
def create_session(payload: SessionCreate, user: User = Depends(current_user),
                   today: date = Depends(user_today), db: Session = Depends(get_db)):
    get_game_or_404(db, payload.game_id, user)
    _check_not_future(payload.played_at, today)
    session = GameSession(**payload.model_dump())
    _check_unique_day(db, session)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/{session_id}", response_model=SessionOut)
def get_session(session_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return get_session_or_404(db, session_id, user)


@router.put("/{session_id}", response_model=SessionOut)
def update_session(session_id: int, payload: SessionUpdate, user: User = Depends(current_user),
                   today: date = Depends(user_today), db: Session = Depends(get_db)):
    session = get_session_or_404(db, session_id, user)
    changes = payload.model_dump(exclude_unset=True)
    if changes.get("game_id") is not None:
        get_game_or_404(db, changes["game_id"], user)
    if changes.get("played_at") is not None:
        _check_not_future(changes["played_at"], today)
    for field, value in changes.items():
        if value is None and field in REQUIRED_FIELDS:
            continue
        setattr(session, field, value)
    _check_unique_day(db, session)
    db.commit()
    db.refresh(session)
    return session


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(get_session_or_404(db, session_id, user))
    db.commit()
    return Response(status_code=204)
