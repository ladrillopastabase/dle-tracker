"""Conexión a la base de datos y migraciones ligeras.

* Local: SQLite en ``data/dle_games.db`` (o ``DLE_DB_PATH``).
* En la nube: PostgreSQL si se define ``DATABASE_URL`` (p. ej. Neon).
"""

import os
from pathlib import Path

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = BASE_DIR / "data" / "dle_games.db"


class Base(DeclarativeBase):
    pass


def normalize_url(url: str) -> str:
    """Los proveedores entregan ``postgres://``; SQLAlchemy+psycopg necesita otro prefijo."""
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def make_engine(target: str | Path):
    """Crea el motor a partir de una URL de base de datos o de la ruta de un archivo SQLite."""
    url = str(target)
    if "://" not in url:
        path = Path(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        url = f"sqlite:///{path}"
    url = normalize_url(url)

    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False})

        @event.listens_for(engine, "connect")
        def _enable_foreign_keys(dbapi_conn, _record):
            # SQLite no aplica claves foráneas (ni ON DELETE CASCADE) si no se activa.
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return engine
    # pool_pre_ping: los Postgres serverless (Neon) cierran conexiones inactivas.
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=5, pool_recycle=300)


DATABASE_URL = os.environ.get("DATABASE_URL")
DB_PATH = Path(os.environ.get("DLE_DB_PATH", DEFAULT_DB_PATH))
# Carpeta donde la versión anterior guardaba los iconos (se migran a la base de datos).
ICONS_DIR = DB_PATH.parent / "icons"

engine = make_engine(DATABASE_URL or DB_PATH)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


# ----------------------------------------------------------------- migraciones


def _rebuild_legacy_games(engine) -> None:
    """Convierte la tabla ``games`` de la versión monousuario (SQLite).

    Hay que reconstruirla porque cambia una restricción (nombre único global →
    único por usuario). Los juegos quedan sin dueño y los reclama la primera
    cuenta que se registre.
    """
    from .models import Game  # evitar import circular

    with engine.connect() as conn:
        # Los PRAGMA deben ejecutarse fuera de una transacción.
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        # Con legacy_alter_table, renombrar no reescribe las FK de game_sessions,
        # que siguen apuntando a "games" (la tabla nueva).
        conn.exec_driver_sql("PRAGMA legacy_alter_table=ON")
        conn.commit()
        try:
            conn.exec_driver_sql("BEGIN")  # explícito: el DDL también queda dentro
            old_cols = {c["name"] for c in inspect(conn).get_columns("games")}
            conn.exec_driver_sql("ALTER TABLE games RENAME TO games_legacy")
            Game.__table__.create(conn)
            cols = [c.name for c in Game.__table__.columns if c.name in old_cols]
            col_list = ", ".join(cols)
            conn.exec_driver_sql(f"INSERT INTO games ({col_list}) SELECT {col_list} FROM games_legacy")
            conn.exec_driver_sql("DROP TABLE games_legacy")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.exec_driver_sql("PRAGMA legacy_alter_table=OFF")
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            conn.commit()


def _add_missing_columns(engine) -> None:
    """Agrega columnas nuevas (nullable) de los modelos a tablas existentes."""
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not inspector.has_table(table.name):
                continue
            existing = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name not in existing and column.nullable:
                    ddl = column.type.compile(dialect=engine.dialect)
                    conn.execute(text(f'ALTER TABLE {table.name} ADD COLUMN "{column.name}" {ddl}'))


def _import_icon_files(engine) -> None:
    """Pasa a la base de datos los iconos que la versión anterior guardaba en disco."""
    if not ICONS_DIR.is_dir():
        return
    with engine.begin() as conn:
        rows = conn.execute(text("SELECT id, icon_file FROM games WHERE icon_file IS NOT NULL AND icon_data IS NULL"))
        for game_id, name in rows.fetchall():
            path = ICONS_DIR / os.path.basename(name)
            if path.is_file():
                conn.execute(text("UPDATE games SET icon_data = :d WHERE id = :i"), {"d": path.read_bytes(), "i": game_id})
            else:
                conn.execute(text("UPDATE games SET icon_file = NULL WHERE id = :i"), {"i": game_id})


def ensure_schema(engine) -> None:
    """Crea las tablas y actualiza bases de datos de versiones anteriores."""
    from . import models  # noqa: F401  (registra los modelos)

    inspector = inspect(engine)
    legacy = (
        engine.dialect.name == "sqlite"
        and inspector.has_table("games")
        and "user_id" not in {c["name"] for c in inspector.get_columns("games")}
    )
    if legacy:
        _rebuild_legacy_games(engine)
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    _import_icon_files(engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
