import os

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..auth import (
    auth_limiter,
    check_credentials,
    client_ip,
    current_user,
    end_session,
    hash_password,
    start_session,
)
from ..database import get_db
from ..models import Game, User
from ..schemas import AccountIn, LoginIn, PasswordIn, UserOut
from ..seed import seed_for_user
from .games import auto_fetch_enabled, fetch_icons_background

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
def register(payload: AccountIn, request: Request, response: Response,
             background: BackgroundTasks, db: Session = Depends(get_db)):
    auth_limiter.check(client_ip(request))
    if db.scalar(select(User.id).where(User.username == payload.username)) is not None:
        raise HTTPException(status_code=409, detail="Ese nombre de usuario ya existe")
    first_user = db.scalar(select(func.count(User.id))) == 0
    user = User(username=payload.username, password_hash=hash_password(payload.password))
    db.add(user)
    db.commit()

    # La primera cuenta hereda los datos de la versión monousuario, si los hay.
    claimed = 0
    if first_user:
        claimed = db.execute(update(Game).where(Game.user_id.is_(None)).values(user_id=user.id)).rowcount
        db.commit()
    if not claimed and os.environ.get("DLE_SKIP_SEED") != "1":
        games = seed_for_user(db, user)
        if auto_fetch_enabled():
            background.add_task(fetch_icons_background, [g.id for g in games])

    start_session(db, user, request, response)
    return user


@router.post("/login", response_model=UserOut)
def login(payload: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    auth_limiter.check(client_ip(request))
    user = check_credentials(db, payload.username, payload.password)
    if user is None:
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")
    start_session(db, user, request, response)
    return user


@router.post("/logout", status_code=204)
def logout(request: Request, db: Session = Depends(get_db)):
    response = Response(status_code=204)
    end_session(db, request, response)
    return response


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.delete("/me", status_code=204)
def delete_account(payload: PasswordIn, request: Request,
                   user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Elimina la cuenta y todos sus datos. Pide la contraseña como confirmación."""
    auth_limiter.check(client_ip(request))
    if check_credentials(db, user.username, payload.password) is None:
        raise HTTPException(status_code=403, detail="Contraseña incorrecta")
    response = Response(status_code=204)
    end_session(db, request, response)
    db.delete(db.merge(user))
    db.commit()
    return response
