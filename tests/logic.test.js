// Tests de rachas y estadísticas: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../static/js/logic.js");

const TODAY = "2026-10-02";
const daysAgo = (...offsets) => offsets.map((o) => L.addDays(TODAY, -o));

let nextId = 1;
function session(offset, fields = {}) {
  return { id: nextId++, game_id: 1, played_at: L.addDays(TODAY, -offset), result: "win",
    score: null, attempts: null, errors: null, time_seconds: null, notes: "", ...fields };
}

/* ------------------------------------------------------------ fechas */

test("addDays cruza meses, años y bisiestos", () => {
  assert.equal(L.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(L.addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(L.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(L.weekday("2026-10-05"), 0); // lunes
  assert.equal(L.weekday("2026-10-04"), 6); // domingo
});

test("isValidISODate", () => {
  assert.ok(L.isValidISODate("2026-10-02"));
  for (const bad of ["2026-02-30", "02/10/2026", "2026-1-1", "", null, "no-date"]) assert.ok(!L.isValidISODate(bad), bad);
});

/* ------------------------------------------------------------ rachas */

test("sin partidas no hay racha", () => {
  assert.equal(L.currentStreak([], TODAY), 0);
  assert.equal(L.bestStreak([]), 0);
});

test("días consecutivos que terminan hoy", () => {
  assert.equal(L.currentStreak(daysAgo(0), TODAY), 1);
  assert.equal(L.currentStreak(daysAgo(0, 1, 2, 3), TODAY), 4);
});

test("la racha sigue viva si se jugó ayer pero aún no hoy", () => {
  assert.equal(L.currentStreak(daysAgo(1, 2, 3), TODAY), 3);
});

test("la racha se rompe si el último día fue anteayer", () => {
  assert.equal(L.currentStreak(daysAgo(2, 3, 4), TODAY), 0);
  assert.equal(L.bestStreak(daysAgo(2, 3, 4)), 3);
});

test("un hueco reinicia la racha actual", () => {
  const days = daysAgo(0, 1, 3, 4, 5, 6);
  assert.equal(L.currentStreak(days, TODAY), 2);
  assert.equal(L.bestStreak(days), 4);
});

test("varios juegos el mismo día cuentan como un día", () => {
  const days = daysAgo(0, 0, 0, 1, 1);
  assert.equal(L.currentStreak(days, TODAY), 2);
  assert.equal(L.bestStreak(days), 2);
});

test("entrada desordenada, cambios de mes/año y bisiestos", () => {
  assert.equal(L.currentStreak(daysAgo(5, 0, 3, 1, 4, 2), TODAY), 6);
  assert.equal(L.bestStreak(["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"]), 4);
  assert.equal(L.bestStreak(["2024-02-28", "2024-02-29", "2024-03-01"]), 3);
});

test("las fechas futuras no cuentan para la racha actual", () => {
  assert.equal(L.currentStreak([...daysAgo(0, 1), L.addDays(TODAY, 1)], TODAY), 2);
});

test("la mejor racha es la más larga de varias", () => {
  const days = [...daysAgo(0, 1), ...daysAgo(10, 11, 12, 13, 14), ...daysAgo(20, 21, 22)];
  assert.equal(L.bestStreak(days), 5);
  assert.equal(L.currentStreak(days, TODAY), 2);
});

/* --------------------------------------------------------- estadísticas */

const wordle = { id: 1, name: "Wordle", active: true, primary_metric: "attempts", lower_is_better: true };

test("estadísticas de un juego", () => {
  const sessions = [session(0, { attempts: 3 }), session(1, { attempts: 5 }),
    session(2, { result: "loss", attempts: 6 }), session(4, { attempts: 4 })];
  const s = L.gameStats(wordle, sessions, TODAY);
  assert.equal(s.played, 4);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 1);
  assert.equal(s.win_rate, 75);
  assert.equal(s.averages.attempts, 4.5);
  assert.equal(s.best.attempts, 3);
  assert.equal(s.worst.attempts, 6);
  assert.equal(s.current_streak, 3);
  assert.equal(s.best_streak, 3);
  assert.deepEqual(s.timeline.map((p) => p.value), [4, 6, 5, 3]);
  assert.deepEqual(s.distribution, [3, 4, 5, 6].map((value) => ({ value, count: 1 })));
  assert.equal(s.recent[0].played_at, TODAY);
});

test("en puntaje, mayor es mejor y no hay distribución", () => {
  const game = { ...wordle, primary_metric: "score", lower_is_better: false };
  const s = L.gameStats(game, [session(0, { score: 80 }), session(1, { score: 95.5 }), session(2, { score: 10 })], TODAY);
  assert.equal(s.best.score, 95.5);
  assert.equal(s.worst.score, 10);
  assert.equal(s.distribution, null);
});

test("tendencia: compara las últimas 10 partidas con las 10 anteriores", () => {
  const worse = [...Array(10).fill(3), ...Array(10).fill(5)];
  assert.equal(L.trend(worse, true).direction, "worsening");
  assert.equal(L.trend(worse, false).direction, "improving");
  assert.equal(L.trend(Array(20).fill(4), true).direction, "stable");
  assert.equal(L.trend([1, 2, 3], true).direction, "insufficient_data");
});

test("sugerencias: el valor más frecuente reciente (empate → el más reciente)", () => {
  const s = L.suggestedValues([session(1, { attempts: 4 }), session(2, { attempts: 4 }), session(3, { attempts: 3 })]);
  assert.equal(s.attempts, 4);
  assert.equal(s.result, "win");
  assert.equal(L.suggestedValues([session(1, { attempts: 5 }), session(2, { attempts: 2 })]).attempts, 5);
});

test("resumen global: días, no partidas, para la racha", () => {
  const games = [wordle, { ...wordle, id: 2, name: "Globle" }, { ...wordle, id: 3, name: "Framed", active: false }];
  const sessions = [session(0), { ...session(0), game_id: 2 }, session(1), session(2, { result: "loss" }), session(10)];
  const o = L.overview(games, sessions, TODAY);
  assert.equal(o.total_games, 2);
  assert.equal(o.played_today, 2);
  assert.deepEqual(o.pending_today, []);
  assert.equal(o.total_sessions, 5);
  assert.equal(o.wins, 4);
  assert.equal(o.losses, 1);
  assert.equal(o.current_streak, 3);
  assert.equal(o.best_streak, 3);
  assert.deepEqual(o.achievements.filter((a) => a.unlocked).map((a) => a.key), ["first_game"]);
  assert.equal(o.games.find((g) => g.game_id === 2).current_streak, 1);
});

test("semana actual vs anterior (lunes a domingo)", () => {
  const today = "2026-10-07"; // miércoles
  const w = L.weeklyComparison([
    { ...session(0), played_at: "2026-10-05", attempts: 3 },
    { ...session(0), played_at: "2026-10-04", attempts: 5 }, // domingo anterior
  ], today);
  assert.equal(w.this_week.start, "2026-10-05");
  assert.equal(w.this_week.end, "2026-10-11");
  assert.equal(w.this_week.avg_attempts, 3);
  assert.equal(w.last_week.avg_attempts, 5);
  assert.equal(w.delta.avg_attempts, -2);
});

test("calendario del mes", () => {
  const days = L.calendarMonth([session(0), session(0, { result: "loss" }), { ...session(0), played_at: "2026-09-30" }], 2026, 10);
  assert.deepEqual(days, [{ date: TODAY, count: 2, wins: 1, losses: 1 }]);
});
