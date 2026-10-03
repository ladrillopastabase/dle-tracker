"use strict";

/**
 * Rachas y estadísticas: funciones puras sobre partidas con fechas ISO
 * ("2026-10-02"). Reciben `today` explícitamente para poder probarse.
 * Funciona en el navegador (global `DleLogic`) y en Node (tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DleLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const METRIC_FIELDS = ["attempts", "score", "time_seconds", "errors"];
  const TREND_WINDOW = 10; // partidas recientes vs. las anteriores para la tendencia

  /* ------------------------------------------------------------ fechas */

  function toDate(iso) {
    return new Date(`${iso}T00:00:00Z`);
  }

  function addDays(iso, n) {
    const d = toDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** Lunes = 0 … domingo = 6. */
  function weekday(iso) {
    return (toDate(iso).getUTCDay() + 6) % 7;
  }

  function isValidISODate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && !Number.isNaN(toDate(value).getTime()) && toDate(value).toISOString().slice(0, 10) === value;
  }

  /** Fecha local de hoy en la zona horaria del dispositivo. */
  function localToday(now = new Date()) {
    const pad = (x) => String(x).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  /* ------------------------------------------------------------ rachas */

  /** Mayor cantidad de días consecutivos con al menos una partida. */
  function bestStreak(days) {
    let best = 0;
    let run = 0;
    let previous = null;
    for (const day of [...new Set(days)].sort()) {
      run = previous !== null && addDays(previous, 1) === day ? run + 1 : 1;
      best = Math.max(best, run);
      previous = day;
    }
    return best;
  }

  /**
   * Días consecutivos jugados que terminan hoy. Si hoy aún no se ha jugado, la
   * racha sigue viva mientras ayer se haya jugado (todavía hay tiempo).
   */
  function currentStreak(days, today) {
    const played = new Set([...days].filter((d) => d <= today));
    let cursor;
    if (played.has(today)) cursor = today;
    else if (played.has(addDays(today, -1))) cursor = addDays(today, -1);
    else return 0;
    let streak = 0;
    while (played.has(cursor)) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  function streaks(days, today) {
    days = [...days];
    return { current: currentStreak(days, today), best: bestStreak(days) };
  }

  /* ------------------------------------------------------------ helpers */

  function round(x, digits) {
    const f = 10 ** digits;
    return Math.round((x + Number.EPSILON) * f) / f;
  }

  function avg(values) {
    return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, 2) : null;
  }

  function valuesOf(sessions, field) {
    return sessions.map((s) => s[field]).filter((v) => v !== null && v !== undefined);
  }

  const byDate = (a, b) => (a.played_at < b.played_at ? -1 : a.played_at > b.played_at ? 1 : a.id - b.id);

  /** El valor más frecuente; en empate, el que apareció primero. */
  function mostCommon(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null;
    let bestCount = 0;
    for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
    return best;
  }

  function isBetter(a, b, lowerIsBetter) {
    return lowerIsBetter ? a < b : a > b;
  }

  function streakFields(sessions, today) {
    const s = streaks(sessions.map((x) => x.played_at), today);
    return { current_streak: s.current, best_streak: s.best };
  }

  /* --------------------------------------------------------- estadísticas */

  function basicCounts(sessions) {
    const wins = sessions.filter((s) => s.result === "win").length;
    const played = sessions.length;
    return {
      played,
      wins,
      losses: played - wins,
      win_rate: played ? round((100 * wins) / played, 1) : null,
    };
  }

  function weekBounds(today) {
    const monday = addDays(today, -weekday(today));
    return [monday, addDays(monday, 6)];
  }

  function periodSummary(sessions, start, end) {
    const inRange = sessions.filter((s) => s.played_at >= start && s.played_at <= end);
    return {
      start,
      end,
      ...basicCounts(inRange),
      days_played: new Set(inRange.map((s) => s.played_at)).size,
      avg_attempts: avg(valuesOf(inRange, "attempts")),
      avg_score: avg(valuesOf(inRange, "score")),
      avg_errors: avg(valuesOf(inRange, "errors")),
      avg_time_seconds: avg(valuesOf(inRange, "time_seconds")),
    };
  }

  function weeklyComparison(sessions, today) {
    const [monday, sunday] = weekBounds(today);
    const thisWeek = periodSummary(sessions, monday, sunday);
    const lastWeek = periodSummary(sessions, addDays(monday, -7), addDays(monday, -1));
    const delta = {};
    for (const key of ["avg_attempts", "avg_score", "avg_errors", "avg_time_seconds", "played", "wins"]) {
      const a = thisWeek[key];
      const b = lastWeek[key];
      delta[key] = a !== null && b !== null ? round(a - b, 2) : null;
    }
    return { this_week: thisWeek, last_week: lastWeek, delta };
  }

  /** Compara la media de las últimas N partidas con las N anteriores. */
  function trend(values, lowerIsBetter) {
    const recent = values.slice(-TREND_WINDOW);
    const previous = values.slice(-2 * TREND_WINDOW, Math.max(values.length - TREND_WINDOW, 0));
    if (recent.length < 2 || !previous.length) {
      return { direction: "insufficient_data", recent_avg: avg(recent), previous_avg: avg(previous) };
    }
    const recentAvg = avg(recent);
    const previousAvg = avg(previous);
    const margin = Math.abs(previousAvg) * 0.02; // 2 %: no declarar tendencia por ruido
    let direction;
    if (Math.abs(recentAvg - previousAvg) <= margin) direction = "stable";
    else if (isBetter(recentAvg, previousAvg, lowerIsBetter)) direction = "improving";
    else direction = "worsening";
    return { direction, recent_avg: recentAvg, previous_avg: previousAvg };
  }

  /** Valores más frecuentes de las últimas 20 partidas (para prellenar el formulario). */
  function suggestedValues(sessions) {
    const recent = [...sessions].sort(byDate).reverse().slice(0, 20);
    const suggestion = {};
    for (const field of ["result", ...METRIC_FIELDS]) {
      suggestion[field] = mostCommon(valuesOf(recent, field));
    }
    return suggestion;
  }

  function gameSummary(game, sessions, today) {
    const ordered = [...sessions].sort(byDate);
    return {
      game_id: game.id,
      ...basicCounts(ordered),
      ...streakFields(ordered, today),
      played_today: ordered.some((s) => s.played_at === today),
      last_session: ordered.length ? { ...ordered[ordered.length - 1] } : null,
      suggested: suggestedValues(ordered),
    };
  }

  function gameStats(game, sessions, today) {
    const ordered = [...sessions].sort(byDate);
    const metric = game.primary_metric;
    const withMetric = ordered.filter((s) => s[metric] !== null && s[metric] !== undefined);
    let best = null;
    let worst = null;
    for (const s of withMetric) {
      if (best === null || isBetter(s[metric], best[metric], game.lower_is_better)) best = s;
      if (worst === null || isBetter(worst[metric], s[metric], game.lower_is_better)) worst = s;
    }
    let distribution = null;
    if (metric === "attempts" || metric === "errors") {
      const counts = new Map();
      for (const s of withMetric) counts.set(s[metric], (counts.get(s[metric]) || 0) + 1);
      distribution = [...counts.keys()].sort((a, b) => a - b).map((value) => ({ value, count: counts.get(value) }));
    }
    const averages = {};
    for (const f of METRIC_FIELDS) averages[f] = avg(valuesOf(ordered, f));
    return {
      game_id: game.id,
      ...basicCounts(ordered),
      ...streakFields(ordered, today),
      averages,
      primary_metric: metric,
      lower_is_better: game.lower_is_better,
      best: best ? { ...best } : null,
      worst: worst ? { ...worst } : null,
      distribution,
      timeline: ordered.map((s) => ({ date: s.played_at, result: s.result, value: s[metric] ?? null })),
      trend: trend(withMetric.map((s) => s[metric]), game.lower_is_better),
      week: weeklyComparison(ordered, today),
      recent: ordered.slice(-10).reverse().map((s) => ({ ...s })),
    };
  }

  const ACHIEVEMENTS = [
    // [clave, icono, título, fuente, objetivo]
    ["first_game", "🏆", "Primera partida", "played", 1],
    ["perfect_1", "✨", "Día perfecto (todo jugado)", "perfect_days", 1],
    ["streak_7", "🔥", "7 días seguidos", "best_streak", 7],
    ["collector_10", "🗂️", "10 juegos en tu lista", "games", 10],
    ["explorer_5", "🧭", "Juegos de 5 categorías", "categories", 5],
    ["perfect_10", "💎", "10 días perfectos", "perfect_days", 10],
    ["streak_30", "🔥", "30 días seguidos", "best_streak", 30],
    ["games_100", "🎯", "100 partidas", "played", 100],
    ["wins_100", "💯", "100 victorias", "wins", 100],
    ["streak_100", "🌋", "100 días seguidos", "best_streak", 100],
    ["games_1000", "🏅", "1000 partidas", "played", 1000],
  ];

  function achievements(values) {
    return ACHIEVEMENTS.map(([key, icon, title, source, target]) => ({
      key, icon, title, target,
      progress: Math.min(values[source] || 0, target),
      unlocked: (values[source] || 0) >= target,
    }));
  }

  /** ¿Toca jugar este juego ese día? `days` = días de la semana (0 = lunes); vacío = todos. */
  function isScheduled(game, day) {
    return !Array.isArray(game.days) || !game.days.length || game.days.includes(weekday(day));
  }

  /**
   * Días perfectos: se jugaron todos los juegos activos que tocaban ese día
   * (y que ya existían). Devuelve la lista de fechas.
   */
  function perfectDays(games, sessions) {
    const active = games.filter((g) => g.active);
    const playedBy = new Map();
    for (const s of sessions) {
      if (!playedBy.has(s.played_at)) playedBy.set(s.played_at, new Set());
      playedBy.get(s.played_at).add(s.game_id);
    }
    const result = [];
    for (const [day, ids] of playedBy) {
      const due = active.filter((g) => isScheduled(g, day) && (!g.created_at || g.created_at.slice(0, 10) <= day));
      if (due.length && due.every((g) => ids.has(g.id))) result.push(day);
    }
    return result.sort();
  }

  function overview(games, sessions, today) {
    const counts = basicCounts(sessions);
    const overall = streaks(sessions.map((s) => s.played_at), today);
    const byGame = new Map(games.map((g) => [g.id, []]));
    for (const s of sessions) byGame.get(s.game_id)?.push(s);
    const active = games.filter((g) => g.active);
    const playedTodayIds = new Set(sessions.filter((s) => s.played_at === today).map((s) => s.game_id));
    const due = active.filter((g) => isScheduled(g, today));
    const playedToday = active.filter((g) => playedTodayIds.has(g.id));
    const perfect = perfectDays(games, sessions);
    const perfectStreaks = streaks(perfect, today);
    return {
      today,
      total_games: active.length,
      // Hoy: los que tocan hoy más los que jugaste aunque no tocaran.
      today_total: new Set([...due, ...playedToday]).size,
      played_today: playedToday.length,
      pending_today: due.filter((g) => !playedTodayIds.has(g.id)).map((g) => g.id),
      resting_today: active.filter((g) => !isScheduled(g, today) && !playedTodayIds.has(g.id)).map((g) => g.id),
      total_sessions: counts.played,
      wins: counts.wins,
      losses: counts.losses,
      win_rate: counts.win_rate,
      current_streak: overall.current,
      best_streak: overall.best,
      perfect_days: perfect.length,
      perfect_today: perfect.includes(today),
      perfect_streak: perfectStreaks.current,
      week: weeklyComparison(sessions, today),
      achievements: achievements({
        ...counts,
        best_streak: overall.best,
        perfect_days: perfect.length,
        games: games.length,
        categories: new Set(games.map((g) => (g.category || "").trim().toLowerCase()).filter(Boolean)).size,
      }),
      games: games.map((g) => ({ ...gameSummary(g, byGame.get(g.id), today), scheduled_today: isScheduled(g, today) })),
    };
  }

  /** Resumen de actividad entre dos fechas (para el mapa anual). */
  function activitySummary(sessions, from, to) {
    const inRange = sessions.filter((s) => s.played_at >= from && s.played_at <= to);
    const days = [...new Set(inRange.map((s) => s.played_at))];
    const perWeekday = Array(7).fill(0);
    const perMonth = new Map();
    for (const s of inRange) {
      perWeekday[weekday(s.played_at)] += 1;
      const m = s.played_at.slice(0, 7);
      perMonth.set(m, (perMonth.get(m) || 0) + 1);
    }
    const topWeekday = inRange.length ? perWeekday.indexOf(Math.max(...perWeekday)) : null;
    let topMonth = null;
    for (const [m, n] of perMonth) if (!topMonth || n > topMonth.count) topMonth = { month: m, count: n };
    return {
      sessions: inRange.length,
      days_played: days.length,
      best_streak: bestStreak(days),
      top_weekday: topWeekday,
      per_weekday: perWeekday,
      top_month: topMonth,
    };
  }

  function calendarMonth(sessions, year, month) {
    const prefix = `${year}-${String(month).padStart(2, "0")}-`;
    const days = new Map();
    for (const s of sessions) {
      if (!s.played_at.startsWith(prefix)) continue;
      if (!days.has(s.played_at)) days.set(s.played_at, { date: s.played_at, count: 0, wins: 0, losses: 0 });
      const day = days.get(s.played_at);
      day.count += 1;
      day[s.result === "win" ? "wins" : "losses"] += 1;
    }
    return [...days.keys()].sort().map((d) => days.get(d));
  }

  /* ------------------------------------------------ resultados compartidos */

  // Cuadrados de color que usan los juegos al compartir (🟩🟨⬛⬜🟦🟪🟥🟧🟫).
  const SQUARE = /[\u{1F7E5}-\u{1F7EB}\u2B1B\u2B1C]/gu;

  function squares(line) {
    return line.match(SQUARE) || [];
  }

  /**
   * Interpreta el texto que comparten los juegos ("Wordle 1.234 4/6", la
   * cuadrícula de Connections, "Tiempo 1:23"…) y devuelve los campos que pudo
   * deducir: result, attempts, errors, time_seconds, score.
   */
  function parseShare(text) {
    const out = {};
    if (typeof text !== "string" || !text.trim()) return out;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const gridLines = lines.filter((l) => squares(l).length >= 3 && squares(l).length === [...l.replace(/\s/g, "")].length);

    // "4/6", "X/6", "3 / 8" — el primero que no sea una fecha.
    const frac = text.replace(/\d{1,4}[/-]\d{1,2}[/-]\d{1,4}/g, " ").match(/(^|[^\d/])(\d{1,3}|X)\s*\/\s*(\d{1,3})(?![\d/])/i);
    if (frac) {
      if (frac[2].toUpperCase() === "X") {
        out.result = "loss";
        out.attempts = Number(frac[3]);
      } else {
        const n = Number(frac[2]);
        const max = Number(frac[3]);
        if (n <= max) {
          out.attempts = n;
          out.result = "win";
        }
      }
    }

    // Cuadrícula tipo Connections: filas de 4 cuadrados.
    const rows4 = gridLines.map(squares).filter((r) => r.length === 4);
    if (rows4.length && rows4.length === gridLines.length && /connections|grupos|puzzle #/i.test(text)) {
      const solved = rows4.filter((r) => r.every((c) => c === r[0])).length;
      out.errors = rows4.length - solved;
      out.result = solved >= 4 ? "win" : "loss";
      delete out.attempts;
    } else if (!frac && !gridLines.length && lines.some((l) => /[\u{1F7E5}\u{1F7E9}]/u.test(l) && squares(l).length >= 4)) {
      // Una fila tipo Framed ("🎥 🟥 🟥 🟩 ⬛ ⬛"): el primer 🟩 marca el intento.
      const row = squares(lines.find((l) => /[\u{1F7E5}\u{1F7E9}]/u.test(l) && squares(l).length >= 4));
      const hit = row.indexOf("\u{1F7E9}");
      out.result = hit >= 0 ? "win" : "loss";
      out.attempts = hit >= 0 ? hit + 1 : row.filter((c) => c === "\u{1F7E5}").length;
    } else if (!frac && gridLines.length) {
      // Cuadrícula tipo Wordle sin "n/6": cada fila es un intento.
      out.attempts = gridLines.length;
      const last = squares(gridLines[gridLines.length - 1]);
      out.result = last.every((c) => c === "\u{1F7E9}") ? "win" : "loss";
    }

    // Tiempo: "1:23", "01:02:03", "45s", "45 segundos".
    const clock = text.match(/(?:^|\D)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)/);
    if (clock) {
      out.time_seconds = clock[3] !== undefined
        ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
        : Number(clock[1]) * 60 + Number(clock[2]);
    } else {
      const secs = text.match(/(\d{1,5})\s*(s|seg|segundos|sec|seconds)\b/i);
      if (secs) out.time_seconds = Number(secs[1]);
    }

    // Puntaje: "Score: 85", "85 puntos", "puntaje 85".
    const score = text.match(/(?:score|puntaje|puntuaci[oó]n|points|puntos)\s*[:=]?\s*(-?\d+(?:[.,]\d+)?)/i)
      || text.match(/(-?\d+(?:[.,]\d+)?)\s*(?:points|puntos|pts)\b/i);
    if (score) out.score = Number(score[1].replace(",", "."));

    // Palabras que delatan el resultado.
    if (!out.result) {
      if (/(failed|perd[ií]|lost|game over|❌)/i.test(text)) out.result = "loss";
      else if (/(solved|won|gané|correct|🎉|✅|🏆)/i.test(text)) out.result = "win";
    }
    return out;
  }

  return {
    parseShare,
    METRIC_FIELDS, addDays, weekday, isValidISODate, localToday,
    bestStreak, currentStreak, streaks,
    basicCounts, weekBounds, weeklyComparison, trend, suggestedValues,
    gameSummary, gameStats, achievements, overview, calendarMonth,
    isScheduled, perfectDays, activitySummary,
  };
});
