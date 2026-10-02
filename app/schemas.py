"""Esquemas Pydantic: validación de entrada y forma de las respuestas."""

import math
from datetime import date, datetime
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator

Metric = Literal["attempts", "score", "time_seconds", "errors"]
Result = Literal["win", "loss"]

# Qué flag track_* habilita cada métrica.
METRIC_FLAG = {
    "attempts": "track_attempts",
    "score": "track_score",
    "time_seconds": "track_time",
    "errors": "track_errors",
}


def _clean_url(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or " " in value:
        raise ValueError("La URL debe ser válida y comenzar con http:// o https://")
    return value


def _clean_name(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        raise ValueError("El nombre es obligatorio")
    return value


def _not_future(value: date | None) -> date | None:
    if value is not None and value > date.today():
        raise ValueError("La fecha no puede estar en el futuro")
    return value


def _finite(value: float | None) -> float | None:
    if value is not None and not math.isfinite(value):
        raise ValueError("El puntaje debe ser un número válido")
    return value


# ---------------------------------------------------------------- juegos


class GameFields(BaseModel):
    """Campos comunes; en GameCreate algunos pasan a ser obligatorios."""

    name: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    url: str | None = Field(default=None, max_length=500)
    category: str | None = Field(default=None, max_length=50)
    icon: str | None = Field(default=None, max_length=16)
    active: bool | None = None
    track_attempts: bool | None = None
    track_score: bool | None = None
    track_time: bool | None = None
    track_errors: bool | None = None
    primary_metric: Metric | None = None
    lower_is_better: bool | None = None

    _name = field_validator("name")(_clean_name)
    _url = field_validator("url")(_clean_url)

    @field_validator("description", "category", "icon")
    @classmethod
    def _strip(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class GameCreate(GameFields):
    name: str = Field(max_length=80)
    description: str = Field(default="", max_length=500)
    category: str = Field(default="", max_length=50)
    icon: str = Field(default="🎮", max_length=16)
    active: bool = True
    track_attempts: bool = True
    track_score: bool = False
    track_time: bool = False
    track_errors: bool = False
    primary_metric: Metric = "attempts"
    lower_is_better: bool = True


class GameUpdate(GameFields):
    """PUT acepta cambios parciales (p. ej. solo ``{"active": false}``)."""


class GameOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str
    url: str | None
    category: str
    icon: str
    active: bool
    track_attempts: bool
    track_score: bool
    track_time: bool
    track_errors: bool
    primary_metric: Metric
    lower_is_better: bool
    created_at: datetime


# -------------------------------------------------------------- partidas


class SessionFields(BaseModel):
    played_at: date | None = None
    result: Result | None = None
    score: float | None = None
    attempts: int | None = Field(default=None, ge=0, le=1000)
    errors: int | None = Field(default=None, ge=0, le=1000)
    time_seconds: int | None = Field(default=None, ge=0, le=86400)
    notes: str | None = Field(default=None, max_length=1000)

    _date = field_validator("played_at")(_not_future)
    _score = field_validator("score")(_finite)


class SessionCreate(SessionFields):
    game_id: int
    played_at: date
    result: Result
    notes: str = Field(default="", max_length=1000)


class SessionUpdate(SessionFields):
    game_id: int | None = None


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    game_id: int
    played_at: date
    result: Result
    score: float | None
    attempts: int | None
    errors: int | None
    time_seconds: int | None
    notes: str
    created_at: datetime
