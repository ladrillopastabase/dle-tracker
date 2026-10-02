from datetime import date, timedelta

from app.services.streaks import best_streak, current_streak

TODAY = date(2026, 10, 2)


def days_ago(*offsets):
    return [TODAY - timedelta(days=o) for o in offsets]


def test_no_days():
    assert current_streak([], TODAY) == 0
    assert best_streak([]) == 0


def test_single_day_today():
    assert current_streak(days_ago(0), TODAY) == 1
    assert best_streak(days_ago(0)) == 1


def test_consecutive_days_ending_today():
    assert current_streak(days_ago(0, 1, 2, 3), TODAY) == 4


def test_streak_alive_if_played_yesterday_but_not_today():
    assert current_streak(days_ago(1, 2, 3), TODAY) == 3


def test_streak_broken_if_last_play_two_days_ago():
    assert current_streak(days_ago(2, 3, 4), TODAY) == 0
    assert best_streak(days_ago(2, 3, 4)) == 3


def test_gap_resets_current_streak():
    # Hoy, ayer, (hueco el día 2), 3, 4, 5, 6
    days = days_ago(0, 1, 3, 4, 5, 6)
    assert current_streak(days, TODAY) == 2
    assert best_streak(days) == 4


def test_multiple_games_same_day_count_once():
    days = days_ago(0, 0, 0, 1, 1)
    assert current_streak(days, TODAY) == 2
    assert best_streak(days) == 2


def test_unsorted_input():
    days = days_ago(5, 0, 3, 1, 4, 2)
    assert current_streak(days, TODAY) == 6
    assert best_streak(days) == 6


def test_best_streak_across_month_and_year_boundaries():
    days = [date(2025, 12, 30), date(2025, 12, 31), date(2026, 1, 1), date(2026, 1, 2)]
    assert best_streak(days) == 4
    feb = [date(2024, 2, 28), date(2024, 2, 29), date(2024, 3, 1)]  # año bisiesto
    assert best_streak(feb) == 3


def test_future_dates_ignored_for_current_streak():
    days = days_ago(0, 1) + [TODAY + timedelta(days=1)]
    assert current_streak(days, TODAY) == 2


def test_best_streak_picks_longest_of_several_runs():
    days = days_ago(0, 1) + days_ago(10, 11, 12, 13, 14) + days_ago(20, 21, 22)
    assert best_streak(days) == 5
    assert current_streak(days, TODAY) == 2
