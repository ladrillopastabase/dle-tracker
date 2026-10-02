"""Estadísticas, resumen semanal, logros y sugerencias para el formulario.

Funciones puras sobre listas de partidas: reciben ``today`` explícitamente
para poder probarse con fechas fijas.
"""

from collections import Counter
from datetime import date, timedelta

from ..models import Game, GameSession
from ..schemas import SessionOut
from .streaks import streaks

METRIC_FIELDS = ("attempts", "score", "time_seconds", "errors")
TREND_WINDOW = 10  # partidas recientes vs. las anteriores para la tendencia


def _avg(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def _values(sessions: list[GameSession], field: str) -> list[float]:
    return [getattr(s, field) for s in sessions if getattr(s, field) is not None]


def basic_counts(sessions: list[GameSession]) -> dict:
    wins = sum(1 for s in sessions if s.result == "win")
    played = len(sessions)
    return {
        "played": played,
        "wins": wins,
        "losses": played - wins,
        "win_rate": round(100 * wins / played, 1) if played else None,
    }


def week_bounds(today: date) -> tuple[date, date]:
    """Lunes y domingo de la semana de ``today``."""
    monday = today - timedelta(days=today.weekday())
    return monday, monday + timedelta(days=6)


def period_summary(sessions: list[GameSession], start: date, end: date) -> dict:
    in_range = [s for s in sessions if start <= s.played_at <= end]
    return {
        "start": start,
        "end": end,
        **basic_counts(in_range),
        "days_played": len({s.played_at for s in in_range}),
        "avg_attempts": _avg(_values(in_range, "attempts")),
        "avg_score": _avg(_values(in_range, "score")),
        "avg_errors": _avg(_values(in_range, "errors")),
        "avg_time_seconds": _avg(_values(in_range, "time_seconds")),
    }


def weekly_comparison(sessions: list[GameSession], today: date) -> dict:
    monday, sunday = week_bounds(today)
    this_week = period_summary(sessions, monday, sunday)
    last_week = period_summary(sessions, monday - timedelta(days=7), monday - timedelta(days=1))
    delta = {}
    for key in ("avg_attempts", "avg_score", "avg_errors", "avg_time_seconds", "played", "wins"):
        a, b = this_week[key], last_week[key]
        delta[key] = round(a - b, 2) if a is not None and b is not None else None
    return {"this_week": this_week, "last_week": last_week, "delta": delta}


def _is_better(a: float, b: float, lower_is_better: bool) -> bool:
    return a < b if lower_is_better else a > b


def trend(values: list[float], lower_is_better: bool) -> dict:
    """Compara la media de las últimas N partidas con las N anteriores."""
    recent = values[-TREND_WINDOW:]
    previous = values[-2 * TREND_WINDOW : -TREND_WINDOW]
    if len(recent) < 2 or not previous:
        return {"direction": "insufficient_data", "recent_avg": _avg(recent), "previous_avg": _avg(previous)}
    recent_avg, previous_avg = _avg(recent), _avg(previous)
    # Margen de 2 % para no declarar tendencia por ruido.
    margin = abs(previous_avg) * 0.02
    if abs(recent_avg - previous_avg) <= margin:
        direction = "stable"
    elif _is_better(recent_avg, previous_avg, lower_is_better):
        direction = "improving"
    else:
        direction = "worsening"
    return {"direction": direction, "recent_avg": recent_avg, "previous_avg": previous_avg}


def suggested_values(sessions: list[GameSession]) -> dict:
    """Valores más frecuentes de las últimas 20 partidas para prellenar el formulario.

    En caso de empate gana el valor más reciente.
    """
    recent = sorted(sessions, key=lambda s: s.played_at, reverse=True)[:20]
    suggestion = {}
    for field in ("result", *METRIC_FIELDS):
        values = [getattr(s, field) for s in recent if getattr(s, field) is not None]
        suggestion[field] = Counter(values).most_common(1)[0][0] if values else None
    return suggestion


def game_summary(game: Game, sessions: list[GameSession], today: date) -> dict:
    """Datos de la tarjeta de un juego en el dashboard."""
    ordered = sorted(sessions, key=lambda s: s.played_at)
    last = ordered[-1] if ordered else None
    return {
        "game_id": game.id,
        **basic_counts(ordered),
        **{f"{k}_streak": v for k, v in streaks((s.played_at for s in ordered), today).items()},
        "played_today": any(s.played_at == today for s in ordered),
        "last_session": SessionOut.model_validate(last).model_dump() if last else None,
        "suggested": suggested_values(ordered),
    }


def game_stats(game: Game, sessions: list[GameSession], today: date) -> dict:
    """Estadísticas completas de un juego."""
    ordered = sorted(sessions, key=lambda s: s.played_at)
    metric = game.primary_metric
    with_metric = [s for s in ordered if getattr(s, metric) is not None]
    best = worst = None
    for s in with_metric:
        value = getattr(s, metric)
        if best is None or _is_better(value, getattr(best, metric), game.lower_is_better):
            best = s
        if worst is None or _is_better(getattr(worst, metric), value, game.lower_is_better):
            worst = s

    distribution = None
    if metric in ("attempts", "errors"):
        counts = Counter(getattr(s, metric) for s in with_metric)
        distribution = [{"value": v, "count": counts[v]} for v in sorted(counts)]

    return {
        "game_id": game.id,
        **basic_counts(ordered),
        **{f"{k}_streak": v for k, v in streaks((s.played_at for s in ordered), today).items()},
        "averages": {f: _avg(_values(ordered, f)) for f in METRIC_FIELDS},
        "primary_metric": metric,
        "lower_is_better": game.lower_is_better,
        "best": SessionOut.model_validate(best).model_dump() if best else None,
        "worst": SessionOut.model_validate(worst).model_dump() if worst else None,
        "distribution": distribution,
        "timeline": [
            {"date": s.played_at, "result": s.result, "value": getattr(s, metric)} for s in ordered
        ],
        "trend": trend([getattr(s, metric) for s in with_metric], game.lower_is_better),
        "week": weekly_comparison(ordered, today),
        "recent": [SessionOut.model_validate(s).model_dump() for s in reversed(ordered[-10:])],
    }


ACHIEVEMENTS = (
    # (clave, icono, título, fuente, objetivo)
    ("first_game", "🏆", "Primera partida", "played", 1),
    ("streak_7", "🔥", "7 días seguidos", "best_streak", 7),
    ("streak_30", "🔥", "30 días seguidos", "best_streak", 30),
    ("games_100", "🎯", "100 partidas", "played", 100),
    ("wins_100", "💯", "100 victorias", "wins", 100),
)


def achievements(values: dict) -> list[dict]:
    return [
        {
            "key": key,
            "icon": icon,
            "title": title,
            "target": target,
            "progress": min(values[source], target),
            "unlocked": values[source] >= target,
        }
        for key, icon, title, source, target in ACHIEVEMENTS
    ]


def overview(games: list[Game], sessions: list[GameSession], today: date) -> dict:
    """Resumen global para el dashboard."""
    counts = basic_counts(sessions)
    overall_streaks = streaks((s.played_at for s in sessions), today)
    by_game: dict[int, list[GameSession]] = {g.id: [] for g in games}
    for s in sessions:
        by_game.setdefault(s.game_id, []).append(s)

    active = [g for g in games if g.active]
    played_today_ids = {s.game_id for s in sessions if s.played_at == today}
    return {
        "today": today,
        "total_games": len(active),
        "played_today": len([g for g in active if g.id in played_today_ids]),
        "pending_today": [g.id for g in active if g.id not in played_today_ids],
        "total_sessions": counts["played"],
        "wins": counts["wins"],
        "losses": counts["losses"],
        "win_rate": counts["win_rate"],
        "current_streak": overall_streaks["current"],
        "best_streak": overall_streaks["best"],
        "week": weekly_comparison(sessions, today),
        "achievements": achievements({**counts, "best_streak": overall_streaks["best"]}),
        "games": [game_summary(g, by_game[g.id], today) for g in games],
    }


def calendar_month(sessions: list[GameSession], year: int, month: int) -> list[dict]:
    days: dict[date, dict] = {}
    for s in sessions:
        if s.played_at.year == year and s.played_at.month == month:
            day = days.setdefault(s.played_at, {"date": s.played_at, "count": 0, "wins": 0, "losses": 0})
            day["count"] += 1
            day["wins" if s.result == "win" else "losses"] += 1
    return [days[d] for d in sorted(days)]
