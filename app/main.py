"""Punto de entrada de la aplicación: ``uvicorn app.main:app --reload``."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .database import BASE_DIR, SessionLocal, engine, ensure_schema
from .routes import games, sessions, stats
from .seed import seed_if_empty

FIELD_LABELS = {
    "name": "Nombre",
    "description": "Descripción",
    "url": "URL",
    "category": "Categoría",
    "icon": "Icono",
    "primary_metric": "Métrica principal",
    "game_id": "Juego",
    "played_at": "Fecha",
    "result": "Resultado",
    "score": "Puntaje",
    "attempts": "Intentos",
    "errors": "Errores",
    "time_seconds": "Tiempo",
    "notes": "Notas",
}


def _friendly(error: dict) -> str:
    """Traduce un error de Pydantic a un mensaje legible en español."""
    kind, ctx = error["type"], error.get("ctx", {})
    messages = {
        "missing": "es obligatorio",
        "greater_than_equal": f"debe ser mayor o igual a {ctx.get('ge')}",
        "less_than_equal": f"debe ser menor o igual a {ctx.get('le')}",
        "string_too_long": f"admite como máximo {ctx.get('max_length')} caracteres",
        "int_parsing": "debe ser un número entero",
        "int_from_float": "debe ser un número entero",
        "float_parsing": "debe ser un número",
        "date_parsing": "debe ser una fecha válida (AAAA-MM-DD)",
        "date_from_datetime_parsing": "debe ser una fecha válida (AAAA-MM-DD)",
        "literal_error": f"debe ser uno de: {ctx.get('expected')}",
        "bool_parsing": "debe ser verdadero o falso",
    }
    if kind == "value_error":
        return str(ctx.get("error", error["msg"]))
    field = next((str(p) for p in reversed(error["loc"]) if isinstance(p, str)), "")
    label = FIELD_LABELS.get(field, field or "Valor")
    return f"{label} {messages.get(kind, 'no es válido')}"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_schema(engine)
    if os.environ.get("DLE_SKIP_SEED") != "1":
        with SessionLocal() as db:
            seed_if_empty(db)
    yield


app = FastAPI(title="DLE Games Tracker", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError):
    errors = [_friendly(e) for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": "; ".join(errors), "errors": errors})


app.include_router(games.router)
app.include_router(sessions.router)
app.include_router(stats.router)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(BASE_DIR / "templates" / "index.html")
