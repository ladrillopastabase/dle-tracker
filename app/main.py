"""Punto de entrada de la aplicación: ``uvicorn app.main:app --reload``."""

from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from sqlalchemy import text

from .database import BASE_DIR, SessionLocal, engine, ensure_schema
from .routes import auth, games, sessions, stats

FIELD_LABELS = {
    "username": "Usuario",
    "password": "Contraseña",
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
        "string_too_short": f"necesita al menos {ctx.get('min_length')} caracteres",
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
    yield


app = FastAPI(title="DLE Games Tracker", lifespan=lifespan)


@app.exception_handler(RequestValidationError)
async def validation_handler(_request: Request, exc: RequestValidationError):
    errors = [_friendly(e) for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": "; ".join(errors), "errors": errors})


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
}
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


@app.middleware("http")
async def security(request: Request, call_next):
    # Rechaza peticiones que modifican datos enviadas desde otra web (CSRF),
    # además de la protección que ya da la cookie SameSite=Lax.
    origin = request.headers.get("origin")
    if request.method in UNSAFE_METHODS and origin and urlparse(origin).netloc != request.headers.get("host"):
        return JSONResponse(status_code=403, content={"detail": "Origen no permitido"})
    response = await call_next(request)
    for name, value in SECURITY_HEADERS.items():
        response.headers.setdefault(name, value)
    return response


@app.get("/api/health", include_in_schema=False)
def health():
    """Para el chequeo del hosting: comprueba también la base de datos."""
    with SessionLocal() as db:
        db.execute(text("SELECT 1"))
    return {"status": "ok"}


app.include_router(auth.router)
app.include_router(games.router)
app.include_router(sessions.router)
app.include_router(stats.router)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(BASE_DIR / "templates" / "index.html")
