"""Conexión a SQLite y sesión de SQLAlchemy."""

import os
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "dle_games.db"


class Base(DeclarativeBase):
    pass


def make_engine(db_path: str | Path):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def _enable_foreign_keys(dbapi_conn, _record):
        # SQLite no aplica claves foráneas (ni ON DELETE CASCADE) si no se activa.
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


DB_PATH = Path(os.environ.get("DLE_DB_PATH", DEFAULT_DB_PATH))
# Los iconos descargados viven junto a la base de datos.
ICONS_DIR = DB_PATH.parent / "icons"

engine = make_engine(DB_PATH)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# Columnas añadidas después de la primera versión: (tabla, columna, DDL).
_ADDED_COLUMNS = [
    ("games", "icon_file", "VARCHAR(120)"),
]


def ensure_schema(engine) -> None:
    """Crea las tablas y agrega columnas nuevas a bases de datos existentes."""
    Base.metadata.create_all(engine)
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in _ADDED_COLUMNS:
            if column not in {c["name"] for c in inspector.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
