from datetime import date, timedelta

TODAY = date.today()


def iso(offset=0):
    return (TODAY - timedelta(days=offset)).isoformat()


def add_session(client, game_id, offset=0, **fields):
    payload = {"game_id": game_id, "played_at": iso(offset), "result": "win", **fields}
    response = client.post("/api/sessions", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# ------------------------------------------------------------------ juegos


def test_create_game(client):
    response = client.post(
        "/api/games",
        json={"name": "  Connections ", "track_attempts": False, "track_errors": True, "primary_metric": "errors"},
    )
    assert response.status_code == 201
    game = response.json()
    assert game["name"] == "Connections"
    assert game["active"] is True
    assert game["track_errors"] is True
    assert client.get("/api/games").json()[0]["id"] == game["id"]


def test_edit_game(client, wordle):
    response = client.put(f"/api/games/{wordle['id']}", json={"description": "Palabras", "icon": "🟨"})
    assert response.status_code == 200
    assert response.json()["description"] == "Palabras"
    assert response.json()["icon"] == "🟨"
    assert response.json()["name"] == "Wordle"


def test_deactivate_game(client, wordle):
    client.put(f"/api/games/{wordle['id']}", json={"active": False})
    assert client.get("/api/games?include_inactive=false").json() == []
    assert len(client.get("/api/games").json()) == 1
    assert client.get("/api/stats").json()["total_games"] == 0


def test_delete_game_cascades_sessions(client, wordle):
    add_session(client, wordle["id"], attempts=4)
    assert client.delete(f"/api/games/{wordle['id']}").status_code == 204
    assert client.get(f"/api/games/{wordle['id']}").status_code == 404
    assert client.get("/api/sessions").json() == []


def test_game_not_found(client):
    assert client.get("/api/games/999").status_code == 404
    assert client.put("/api/games/999", json={"name": "x"}).status_code == 404
    assert client.delete("/api/games/999").status_code == 404


# ------------------------------------------------------------- validación


def test_game_name_required(client):
    for payload in ({}, {"name": ""}, {"name": "   "}):
        response = client.post("/api/games", json=payload)
        assert response.status_code == 422
        assert "nombre" in response.json()["detail"].lower()


def test_game_url_must_be_valid(client):
    for url in ("not a url", "ftp://example.com", "http://", "javascript:alert(1)"):
        response = client.post("/api/games", json={"name": "X", "url": url})
        assert response.status_code == 422, url
        assert "URL" in response.json()["detail"]
    assert client.post("/api/games", json={"name": "X", "url": ""}).json()["url"] is None


def test_duplicate_game_name_rejected(client, wordle):
    assert client.post("/api/games", json={"name": "wordle"}).status_code == 409


def test_primary_metric_must_be_tracked(client):
    response = client.post("/api/games", json={"name": "X", "track_time": False, "primary_metric": "time_seconds"})
    assert response.status_code == 422


def test_session_validation(client, wordle):
    base = {"game_id": wordle["id"], "played_at": iso(), "result": "win"}
    bad_payloads = [
        {**base, "attempts": -1},
        {**base, "time_seconds": -5},
        {**base, "errors": -1},
        {**base, "score": "abc"},
        {**base, "attempts": "cuatro"},
        {**base, "result": "draw"},
        {**base, "played_at": "2026-02-30"},
        {**base, "played_at": "no-date"},
        {**base, "played_at": (TODAY + timedelta(days=1)).isoformat()},
        {"game_id": wordle["id"], "result": "win"},
    ]
    for payload in bad_payloads:
        response = client.post("/api/sessions", json=payload)
        assert response.status_code == 422, payload
        assert response.json()["detail"]
    assert client.get("/api/sessions").json() == []


def test_session_for_unknown_game(client):
    response = client.post("/api/sessions", json={"game_id": 42, "played_at": iso(), "result": "win"})
    assert response.status_code == 404


def test_one_session_per_game_and_day(client, wordle):
    add_session(client, wordle["id"], attempts=3)
    response = client.post("/api/sessions", json={"game_id": wordle["id"], "played_at": iso(), "result": "loss"})
    assert response.status_code == 409


# ---------------------------------------------------------------- partidas


def test_register_session(client, wordle):
    session = add_session(client, wordle["id"], attempts=4, notes="Fácil")
    assert session["attempts"] == 4
    assert session["score"] is None
    assert client.get(f"/api/sessions/{session['id']}").json()["notes"] == "Fácil"


def test_edit_and_delete_session(client, wordle):
    session = add_session(client, wordle["id"], attempts=4)
    response = client.put(f"/api/sessions/{session['id']}", json={"result": "loss", "attempts": None})
    assert response.status_code == 200
    assert response.json()["result"] == "loss"
    assert response.json()["attempts"] is None
    assert client.put(f"/api/sessions/{session['id']}", json={"attempts": -2}).status_code == 422
    assert client.delete(f"/api/sessions/{session['id']}").status_code == 204
    assert client.get(f"/api/sessions/{session['id']}").status_code == 404


def test_history_filters_and_order(client, wordle):
    other = client.post("/api/games", json={"name": "Globle"}).json()
    add_session(client, wordle["id"], 0, attempts=3)
    add_session(client, wordle["id"], 1, result="loss", attempts=6)
    add_session(client, wordle["id"], 5, attempts=4)
    add_session(client, other["id"], 1, attempts=10)

    history = client.get("/api/sessions").json()
    assert [s["played_at"] for s in history] == [iso(0), iso(1), iso(1), iso(5)]
    assert client.get("/api/sessions?order=asc").json()[0]["played_at"] == iso(5)
    assert len(client.get(f"/api/sessions?game_id={wordle['id']}").json()) == 3
    assert len(client.get("/api/sessions?result=loss").json()) == 1
    ranged = client.get(f"/api/sessions?date_from={iso(1)}&date_to={iso(1)}").json()
    assert {s["game_id"] for s in ranged} == {wordle["id"], other["id"]}


# ------------------------------------------------------------ estadísticas


def test_game_stats(client, wordle):
    add_session(client, wordle["id"], 0, attempts=3)
    add_session(client, wordle["id"], 1, attempts=5)
    add_session(client, wordle["id"], 2, result="loss", attempts=6)
    add_session(client, wordle["id"], 4, attempts=4)

    stats = client.get(f"/api/stats/{wordle['id']}").json()
    assert stats["played"] == 4
    assert stats["wins"] == 3
    assert stats["losses"] == 1
    assert stats["win_rate"] == 75.0
    assert stats["averages"]["attempts"] == 4.5
    assert stats["best"]["attempts"] == 3
    assert stats["worst"]["attempts"] == 6
    assert stats["current_streak"] == 3
    assert stats["best_streak"] == 3
    assert [p["value"] for p in stats["timeline"]] == [4, 6, 5, 3]
    assert {d["value"]: d["count"] for d in stats["distribution"]} == {3: 1, 4: 1, 5: 1, 6: 1}


def test_higher_score_is_better(client):
    game = client.post(
        "/api/games",
        json={"name": "Puntos", "track_attempts": False, "track_score": True, "primary_metric": "score", "lower_is_better": False},
    ).json()
    add_session(client, game["id"], 0, score=80)
    add_session(client, game["id"], 1, score=95.5)
    add_session(client, game["id"], 2, score=10)
    stats = client.get(f"/api/stats/{game['id']}").json()
    assert stats["best"]["score"] == 95.5
    assert stats["worst"]["score"] == 10
    assert stats["distribution"] is None


def test_overview_counts_days_not_sessions(client, wordle):
    other = client.post("/api/games", json={"name": "Globle"}).json()
    third = client.post("/api/games", json={"name": "Framed"}).json()
    # Tres juegos hoy cuentan como un solo día de racha.
    for g in (wordle, other, third):
        add_session(client, g["id"], 0)
    add_session(client, wordle["id"], 1)
    add_session(client, wordle["id"], 2, result="loss")
    add_session(client, wordle["id"], 10)

    overview = client.get("/api/stats").json()
    assert overview["total_games"] == 3
    assert overview["played_today"] == 3
    assert overview["pending_today"] == []
    assert overview["total_sessions"] == 6
    assert overview["wins"] == 5
    assert overview["losses"] == 1
    assert overview["current_streak"] == 3
    assert overview["best_streak"] == 3
    cards = {c["game_id"]: c for c in overview["games"]}
    assert cards[wordle["id"]]["current_streak"] == 3
    assert cards[other["id"]]["current_streak"] == 1
    unlocked = {a["key"] for a in overview["achievements"] if a["unlocked"]}
    assert unlocked == {"first_game"}


def test_pending_today_and_suggestions(client, wordle):
    other = client.post("/api/games", json={"name": "Globle"}).json()
    add_session(client, wordle["id"], 1, attempts=4)
    add_session(client, wordle["id"], 2, attempts=4)
    add_session(client, wordle["id"], 3, attempts=3)
    overview = client.get("/api/stats").json()
    assert set(overview["pending_today"]) == {wordle["id"], other["id"]}
    card = next(c for c in overview["games"] if c["game_id"] == wordle["id"])
    assert card["suggested"]["attempts"] == 4
    assert card["suggested"]["result"] == "win"
    assert card["played_today"] is False
    assert card["last_session"]["played_at"] == iso(1)


def test_streaks_endpoint(client, wordle):
    for offset in (0, 1, 2, 5, 6, 7, 8):
        add_session(client, wordle["id"], offset)
    data = client.get("/api/streaks").json()
    assert data["overall"] == {"current": 3, "best": 4}
    assert data["games"] == [{"game_id": wordle["id"], "current": 3, "best": 4}]


def test_calendar(client, wordle):
    add_session(client, wordle["id"], 0)
    data = client.get(f"/api/calendar?year={TODAY.year}&month={TODAY.month}").json()
    assert data["days"] == [{"date": iso(0), "count": 1, "wins": 1, "losses": 0}]
    assert client.get("/api/calendar?year=2026&month=13").status_code == 422


def test_frontend_served(client):
    assert client.get("/").status_code == 200
    assert client.get("/static/js/app.js").status_code == 200
