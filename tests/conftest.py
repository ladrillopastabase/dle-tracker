import os
import shutil
import tempfile
from pathlib import Path

# Antes de importar la app: base de datos temporal y sin datos de ejemplo.
_TMP = tempfile.mkdtemp(prefix="dle-tests-")
os.environ["DLE_DB_PATH"] = str(Path(_TMP) / "test.db")
os.environ["DLE_SKIP_SEED"] = "1"
os.environ["DLE_DISABLE_ICON_FETCH"] = "1"  # nunca salir a internet en los tests

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import ICONS_DIR, Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    shutil.rmtree(ICONS_DIR, ignore_errors=True)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def wordle(client):
    response = client.post(
        "/api/games",
        json={"name": "Wordle", "url": "https://example.com/wordle", "category": "Palabras", "icon": "🟩"},
    )
    assert response.status_code == 201
    return response.json()
