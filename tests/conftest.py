import os
import shutil
import tempfile
from pathlib import Path

# Antes de importar la app: base de datos temporal (o la PostgreSQL de
# DATABASE_URL, si se define) y sin datos de ejemplo.
_TMP = tempfile.mkdtemp(prefix="dle-tests-")
os.environ["DLE_DB_PATH"] = str(Path(_TMP) / "test.db")
os.environ["DLE_SKIP_SEED"] = "1"
os.environ["DLE_DISABLE_ICON_FETCH"] = "1"  # nunca salir a internet en los tests

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.auth import auth_limiter, icon_limiter  # noqa: E402
from app.database import ICONS_DIR, Base, engine  # noqa: E402
from app.main import app  # noqa: E402

PASSWORD = "password123"


def register(client: TestClient, username: str) -> TestClient:
    response = client.post("/api/auth/register", json={"username": username, "password": PASSWORD})
    assert response.status_code == 201, response.text
    return client


@pytest.fixture()
def anon():
    """Cliente sin sesión, con la base de datos vacía."""
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    shutil.rmtree(ICONS_DIR, ignore_errors=True)
    auth_limiter.reset()
    icon_limiter.reset()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def client(anon):
    """Cliente con una cuenta registrada y la sesión iniciada."""
    return register(anon, "tester")


@pytest.fixture()
def other(client):
    """Un segundo usuario, con su propio navegador (cookies separadas)."""
    with TestClient(app) as c:
        yield register(c, "otro")


@pytest.fixture()
def wordle(client):
    response = client.post(
        "/api/games",
        json={"name": "Wordle", "url": "https://example.com/wordle", "category": "Palabras", "icon": "🟩"},
    )
    assert response.status_code == 201
    return response.json()
