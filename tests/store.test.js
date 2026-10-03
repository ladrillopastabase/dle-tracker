// Tests de la capa de datos en localStorage: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DleStore = require("../static/js/store.js");

const TODAY = "2026-10-02";

function setup({ seed = false, storage = DleStore.memoryStorage() } = {}) {
  const store = DleStore.create(storage, { seed, today: () => TODAY });
  const call = (method, path, body) => store.request(method, path, body);
  return { store, storage, call };
}

function rejects(fn, status, pattern) {
  assert.throws(fn, (err) => {
    assert.equal(err.status, status, err.message);
    if (pattern) assert.match(err.message, pattern);
    return true;
  });
}

/* ------------------------------------------------------------ juegos */

test("crear, editar, desactivar y eliminar juegos", () => {
  const { call } = setup();
  const g = call("POST", "/api/games", { name: "  Wordle ", url: "https://example.com/w", icon: "🟩" });
  assert.equal(g.id, 1);
  assert.equal(g.name, "Wordle");
  assert.equal(g.active, true);
  assert.equal(g.primary_metric, "attempts");
  assert.equal(call("PUT", `/api/games/${g.id}`, { description: "Palabras" }).description, "Palabras");
  call("PUT", `/api/games/${g.id}`, { active: false });
  assert.equal(call("GET", "/api/stats").total_games, 0);
  assert.equal(call("GET", "/api/games").length, 1);
  call("POST", "/api/sessions", { game_id: g.id, played_at: TODAY, result: "win", attempts: 3 });
  assert.equal(call("DELETE", `/api/games/${g.id}`), null);
  assert.deepEqual(call("GET", "/api/games"), []);
  assert.deepEqual(call("GET", "/api/sessions"), []); // se borran sus partidas
  rejects(() => call("GET", "/api/games/1"), 404);
});

test("validación de juegos", () => {
  const { call } = setup();
  for (const body of [{}, { name: "" }, { name: "   " }]) rejects(() => call("POST", "/api/games", body), 422, /nombre/i);
  for (const url of ["not a url", "ftp://x.com", "http://", "javascript:alert(1)"]) {
    rejects(() => call("POST", "/api/games", { name: "X", url }), 422, /URL/);
  }
  assert.equal(call("POST", "/api/games", { name: "X", url: "" }).url, null);
  rejects(() => call("POST", "/api/games", { name: "x" }), 409);
  rejects(() => call("POST", "/api/games", { name: "Y", track_time: false, primary_metric: "time_seconds" }), 422, /métrica/);
  rejects(() => call("POST", "/api/games", { name: "Z", primary_metric: "nope" }), 422);
  rejects(() => call("POST", "/api/games", { name: "x".repeat(81) }), 422);
});

/* -------------------------------------------------------- partidas */

test("registrar, filtrar, editar y eliminar partidas", () => {
  const { call } = setup();
  const w = call("POST", "/api/games", { name: "Wordle" });
  const o = call("POST", "/api/games", { name: "Globle" });
  const add = (game, played_at, extra = {}) => call("POST", "/api/sessions", { game_id: game.id, played_at, result: "win", ...extra });
  add(w, "2026-10-02", { attempts: 3 });
  add(w, "2026-10-01", { result: "loss", attempts: 6 });
  add(w, "2026-09-27", { attempts: 4 });
  add(o, "2026-10-01", { attempts: 10 });

  assert.deepEqual(call("GET", "/api/sessions").map((s) => s.played_at), ["2026-10-02", "2026-10-01", "2026-10-01", "2026-09-27"]);
  assert.equal(call("GET", "/api/sessions?order=asc")[0].played_at, "2026-09-27");
  assert.equal(call("GET", `/api/sessions?game_id=${w.id}`).length, 3);
  assert.equal(call("GET", "/api/sessions?result=loss").length, 1);
  assert.equal(call("GET", "/api/sessions?date_from=2026-10-01&date_to=2026-10-01").length, 2);
  assert.equal(call("GET", "/api/sessions?limit=1").length, 1);

  const s = call("GET", "/api/sessions?order=asc")[0];
  const edited = call("PUT", `/api/sessions/${s.id}`, { result: "loss", attempts: null, notes: " difícil " });
  assert.equal(edited.result, "loss");
  assert.equal(edited.attempts, null);
  assert.equal(edited.notes, "difícil");
  call("DELETE", `/api/sessions/${s.id}`);
  rejects(() => call("GET", `/api/sessions/${s.id}`), 404);
});

test("validación de partidas", () => {
  const { call } = setup();
  const w = call("POST", "/api/games", { name: "Wordle" });
  const base = { game_id: w.id, played_at: TODAY, result: "win" };
  for (const bad of [
    { attempts: -1 }, { time_seconds: -5 }, { errors: -1 }, { attempts: 2.5 }, { attempts: "4" },
    { score: "abc" }, { score: Infinity }, { result: "draw" }, { played_at: "2026-02-30" },
    { played_at: "no-date" }, { played_at: "2026-10-03" }, { played_at: null }, { notes: "x".repeat(1001) },
  ]) {
    rejects(() => call("POST", "/api/sessions", { ...base, ...bad }), 422);
  }
  rejects(() => call("POST", "/api/sessions", { game_id: 99, played_at: TODAY, result: "win" }), 404);
  call("POST", "/api/sessions", { ...base, attempts: 3 });
  rejects(() => call("POST", "/api/sessions", { ...base, result: "loss" }), 409); // una por día
  assert.equal(call("GET", "/api/sessions").length, 1);
});

/* ---------------------------------------------------- persistencia */

test("los datos sobreviven a recargar la página", () => {
  const storage = DleStore.memoryStorage();
  const first = setup({ storage });
  const w = first.call("POST", "/api/games", { name: "Wordle" });
  first.call("POST", "/api/sessions", { game_id: w.id, played_at: TODAY, result: "win", attempts: 4 });

  const again = setup({ storage }); // como abrir la página de nuevo
  assert.equal(again.call("GET", "/api/games")[0].name, "Wordle");
  assert.equal(again.call("GET", "/api/stats").current_streak, 1);
  assert.equal(again.call("POST", "/api/games", { name: "Otro" }).id, 2); // no reutiliza ids
});

test("juegos de ejemplo solo la primera vez", () => {
  const storage = DleStore.memoryStorage();
  const { call } = setup({ seed: true, storage });
  assert.equal(call("GET", "/api/games").length, DleStore.SEED_GAMES.length);
  call("DELETE", "/api/games/1");
  assert.equal(setup({ seed: true, storage }).call("GET", "/api/games").length, DleStore.SEED_GAMES.length - 1);
});

test("datos corruptos no rompen la app", () => {
  const storage = DleStore.memoryStorage();
  storage.setItem(DleStore.STORAGE_KEY, "{not json");
  const { call } = setup({ seed: true, storage });
  assert.deepEqual(call("GET", "/api/games"), []);
});

test("reset vuelve a los juegos de ejemplo", () => {
  const { call } = setup({ seed: true });
  call("POST", "/api/games", { name: "Extra" });
  assert.deepEqual(call("POST", "/api/reset"), { games: DleStore.SEED_GAMES.length, sessions: 0 });
});

/* ------------------------------------------------- copia de seguridad */

test("exportar e importar conserva todo", () => {
  const a = setup();
  const w = a.call("POST", "/api/games", { name: "Wordle", url: "https://w.example/" });
  a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-01", result: "win", attempts: 3, notes: "ok" });
  const backup = JSON.parse(JSON.stringify(a.call("GET", "/api/export")));

  const b = setup({ seed: true });
  assert.deepEqual(b.call("POST", "/api/import", backup), { games: 1, sessions: 1 });
  const [game] = b.call("GET", "/api/games");
  assert.equal(game.name, "Wordle");
  assert.equal(game.icon_url, w.icon_url);
  assert.equal(b.call("GET", "/api/sessions")[0].notes, "ok");
});

test("importa la exportación de la versión con servidor", () => {
  const { call } = setup();
  const result = call("POST", "/api/import", {
    exported_at: "2026-10-02", user: "isidora",
    games: [{ id: 7, name: "Wordle", url: "https://w.example/", icon: "🟩", icon_url: "/api/games/7/icon?v=abc.png",
      active: true, track_attempts: true, track_score: false, track_time: false, track_errors: false,
      primary_metric: "attempts", lower_is_better: true, description: "", category: "", created_at: "2026-09-01T10:00:00" }],
    sessions: [
      { id: 50, game_id: 7, played_at: "2026-10-01", result: "win", attempts: 4, score: null, errors: null, time_seconds: null, notes: "" },
      { id: 51, game_id: 7, played_at: "2026-10-01", result: "loss", attempts: 6, notes: "" }, // duplicada
    ],
  });
  assert.deepEqual(result, { games: 1, sessions: 1 });
  const [game] = call("GET", "/api/games");
  assert.equal(game.icon_url, "https://w.example/apple-touch-icon.png"); // la ruta /api/... se recalcula
  assert.equal(call("GET", "/api/sessions")[0].game_id, game.id);
});

test("importar un archivo inválido no toca los datos", () => {
  const { call } = setup();
  call("POST", "/api/games", { name: "Mío" });
  rejects(() => call("POST", "/api/import", { hello: 1 }), 422);
  rejects(() => call("POST", "/api/import", { games: [{ id: 1, name: "" }], sessions: [] }), 422, /nombre/);
  rejects(() => call("POST", "/api/import", { games: [], sessions: [{ game_id: 3, played_at: "2026-10-01", result: "win" }] }), 422);
  assert.equal(call("GET", "/api/games")[0].name, "Mío");
});

/* ------------------------------------------------------------ iconos */

test("candidatos de icono, de mejor a peor", () => {
  assert.deepEqual(DleStore.iconCandidates("https://www.nytimes.com/games/wordle/index.html"), [
    "https://www.nytimes.com/apple-touch-icon.png",
    "https://www.google.com/s2/favicons?domain=www.nytimes.com&sz=256",
    "https://www.nytimes.com/favicon.ico",
  ]);
  assert.deepEqual(DleStore.iconCandidates("no es url"), []);
});

test("el icono sigue a la URL y se puede quitar o restaurar", () => {
  const { call } = setup();
  const g = call("POST", "/api/games", { name: "X", url: "https://a.example/play" });
  assert.equal(g.icon_url, "https://a.example/apple-touch-icon.png");
  assert.equal(call("PUT", `/api/games/${g.id}`, { url: "https://b.example/" }).icon_url, "https://b.example/apple-touch-icon.png");
  assert.equal(call("PUT", `/api/games/${g.id}`, { category: "c" }).icon_url, "https://b.example/apple-touch-icon.png");
  assert.equal(call("DELETE", `/api/games/${g.id}/icon`).icon_url, null);
  assert.deepEqual(call("POST", "/api/games/icons/fetch-missing"), { updated: ["X"], failed: [] });
  assert.equal(call("PUT", `/api/games/${g.id}`, { url: null }).icon_url, null);
  rejects(() => call("POST", `/api/games/${g.id}/icon`), 422);
});

test("estadísticas y rachas desde el store", () => {
  const { call } = setup();
  const w = call("POST", "/api/games", { name: "Wordle" });
  for (const d of ["2026-10-02", "2026-10-01", "2026-09-30", "2026-09-27"]) {
    call("POST", "/api/sessions", { game_id: w.id, played_at: d, result: "win", attempts: 4 });
  }
  assert.deepEqual(call("GET", "/api/streaks").overall, { current: 3, best: 3 });
  assert.equal(call("GET", `/api/stats/${w.id}`).averages.attempts, 4);
  assert.equal(call("GET", "/api/calendar?year=2026&month=9").days.length, 2);
  rejects(() => call("GET", "/api/calendar?year=2026&month=13"), 422);
  rejects(() => call("GET", "/api/nada"), 404);
});
