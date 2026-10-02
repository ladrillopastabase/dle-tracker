"""Cálculo de rachas basado en días de calendario, no en número de partidas."""

from collections.abc import Iterable
from datetime import date, timedelta

ONE_DAY = timedelta(days=1)


def best_streak(days: Iterable[date]) -> int:
    """Mayor cantidad de días consecutivos con al menos una partida."""
    best = run = 0
    previous = None
    for day in sorted(set(days)):
        run = run + 1 if previous is not None and day - previous == ONE_DAY else 1
        best = max(best, run)
        previous = day
    return best


def current_streak(days: Iterable[date], today: date) -> int:
    """Días consecutivos jugados que terminan hoy.

    Si hoy aún no se ha jugado, la racha sigue viva mientras ayer se haya
    jugado (todavía hay tiempo de mantenerla), así que se cuenta desde ayer.
    """
    played = {d for d in days if d <= today}
    if today in played:
        cursor = today
    elif today - ONE_DAY in played:
        cursor = today - ONE_DAY
    else:
        return 0
    streak = 0
    while cursor in played:
        streak += 1
        cursor -= ONE_DAY
    return streak


def streaks(days: Iterable[date], today: date) -> dict:
    days = list(days)
    return {"current": current_streak(days, today), "best": best_streak(days)}
