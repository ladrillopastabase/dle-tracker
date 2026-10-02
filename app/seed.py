"""Juegos de ejemplo que se crean la primera vez que la base está vacía.

Las URLs son las direcciones públicas conocidas de cada juego, pero no se
pudieron comprobar desde el entorno donde se desarrolló la app (sin acceso a
internet). Si alguna cambió, edítala desde la propia aplicación.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Game

SEED_GAMES = [
    {
        "name": "Wordle",
        "description": "Adivina la palabra de 5 letras en 6 intentos",
        "url": "https://www.nytimes.com/games/wordle/index.html",
        "category": "Palabras",
        "icon": "🟩",
        "track_attempts": True,
        "primary_metric": "attempts",
        "lower_is_better": True,
    },
    {
        "name": "Connections",
        "description": "Agrupa 16 palabras en 4 grupos con el mínimo de errores",
        "url": "https://www.nytimes.com/games/connections",
        "category": "Palabras",
        "icon": "🟪",
        "track_attempts": False,
        "track_errors": True,
        "primary_metric": "errors",
        "lower_is_better": True,
    },
    {
        "name": "Framed",
        "description": "Adivina la película a partir de fotogramas",
        "url": "https://framed.wtf/",
        "category": "Cine",
        "icon": "🎬",
        "track_attempts": True,
        "primary_metric": "attempts",
        "lower_is_better": True,
    },
    {
        "name": "Worldle",
        "description": "Adivina el país por su silueta",
        "url": "https://worldle.teuteuf.fr/",
        "category": "Geografía",
        "icon": "🌍",
        "track_attempts": True,
        "primary_metric": "attempts",
        "lower_is_better": True,
    },
    {
        "name": "Globle",
        "description": "Encuentra el país misterioso usando el globo terráqueo",
        "url": "https://globle-game.com/",
        "category": "Geografía",
        "icon": "🌐",
        "track_attempts": True,
        "primary_metric": "attempts",
        "lower_is_better": True,
    },
]


def seed_if_empty(db: Session) -> bool:
    if db.scalar(select(Game.id).limit(1)) is not None:
        return False
    db.add_all(Game(**data) for data in SEED_GAMES)
    db.commit()
    return True
