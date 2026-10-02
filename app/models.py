"""Modelos ORM.

Dos tablas:

* ``games``: los juegos a trackear. Cada juego declara qué métricas usa
  (``track_*``) y cuál es su métrica principal, de modo que Wordle use
  intentos, Connections errores y un juego contrarreloj use tiempo, sin
  romper el esquema.
* ``game_sessions``: una partida por juego y día (restricción única).
"""

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base

METRICS = ("attempts", "score", "time_seconds", "errors")
RESULTS = ("win", "loss")


class Game(Base):
    __tablename__ = "games"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    category: Mapped[str] = mapped_column(String(50), default="", nullable=False)
    icon: Mapped[str] = mapped_column(String(16), default="🎮", nullable=False)
    # Favicon descargado de la URL del juego (archivo en data/icons/); si no hay, se usa el emoji.
    icon_file: Mapped[str | None] = mapped_column(String(120), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Qué campos muestra el formulario de "Registrar resultado" para este juego.
    track_attempts: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    track_score: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    track_time: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    track_errors: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Métrica usada para "mejor/peor resultado" y el gráfico de evolución.
    primary_metric: Mapped[str] = mapped_column(String(20), default="attempts", nullable=False)
    lower_is_better: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    sessions: Mapped[list["GameSession"]] = relationship(
        back_populates="game", cascade="all, delete-orphan", passive_deletes=True
    )

    __table_args__ = (
        CheckConstraint(
            "primary_metric IN ('attempts','score','time_seconds','errors')",
            name="ck_games_primary_metric",
        ),
    )


class GameSession(Base):
    __tablename__ = "game_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    game_id: Mapped[int] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), nullable=False, index=True
    )
    played_at: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    result: Mapped[str] = mapped_column(String(10), nullable=False)
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    attempts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    errors: Mapped[int | None] = mapped_column(Integer, nullable=True)
    time_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), nullable=False)

    game: Mapped[Game] = relationship(back_populates="sessions")

    __table_args__ = (
        UniqueConstraint("game_id", "played_at", name="uq_session_game_day"),
        CheckConstraint("result IN ('win','loss')", name="ck_sessions_result"),
        CheckConstraint("attempts IS NULL OR attempts >= 0", name="ck_sessions_attempts"),
        CheckConstraint("errors IS NULL OR errors >= 0", name="ck_sessions_errors"),
        CheckConstraint("time_seconds IS NULL OR time_seconds >= 0", name="ck_sessions_time"),
    )
