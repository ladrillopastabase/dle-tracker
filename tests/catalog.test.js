// Tests del catálogo "descubrir": node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../static/js/catalog.js");
const DleStore = require("../static/js/store.js");

const RAW = [
  { id: 2, name: "Zeta", url: "https://zeta.example/play/", description: "Z", category: "Words", themes: ["Anagrams"] },
  { id: 1, name: "alfa", url: "https://www.alfa.example", description: "A", category: "Geography" },
  { id: 3, name: "Mala", url: "javascript:alert(1)", description: "", category: "Words" },
  { id: 4, name: "Rara", url: "https://rara.example", description: "R", category: "Inventada" },
];
const FRESH = [{ id: 1, date_added: "2026-09-01" }, { id: 2, date_added: "2026-09-20" }, { id: 99, date_added: "2026-09-30" }];
const WEEKLY = [{ date: "2026-09-21", dle_ids: [2] }, { date: "2026-09-28", dle_ids: [1, 99] }];

function fakeFetch(map, calls = []) {
  return async (url) => {
    calls.push(url);
    const file = url.slice(C.BASE.length);
    if (!(file in map)) return { ok: false, status: 404, json: async () => null };
    if (map[file] instanceof Error) throw map[file];
    return { ok: true, status: 200, json: async () => map[file] };
  };
}

test("normaliza: filtra URLs inválidas, ordena y traduce categorías", () => {
  const c = C.normalize(RAW, FRESH, WEEKLY);
  assert.deepEqual(c.games.map((g) => g.name), ["alfa", "Rara", "Zeta"]);
  assert.deepEqual(c.fresh, [{ id: 2, date_added: "2026-09-20" }, { id: 1, date_added: "2026-09-01" }]);
  assert.deepEqual(c.weekly, { date: "2026-09-28", ids: [1] });
  assert.deepEqual(C.categoryInfo("Geography"), { key: "Geography", label: "Geografía", icon: "🌍" });
  assert.equal(C.categoryInfo("Inventada").label, "Inventada");
});

test("compara URLs sin www, barra final ni mayúsculas", () => {
  assert.equal(C.urlKey("https://www.Alfa.example/"), C.urlKey("http://alfa.example"));
  assert.equal(C.urlKey("https://zeta.example/play/"), "zeta.example/play");
  assert.equal(C.urlKey("no url"), "");
});

test("descarga, guarda en caché y respeta el día de vigencia", async () => {
  const storage = DleStore.memoryStorage();
  const calls = [];
  const fetchFn = fakeFetch({ "dles.json": RAW, "new_dles.json": FRESH, "dles_of_the_week.json": WEEKLY }, calls);
  const first = await C.load(storage, { fetchFn, now: 1000 });
  assert.equal(first.from, "network");
  assert.equal(first.games.length, 3);
  assert.equal(calls.length, 3);
  assert.equal((await C.load(storage, { fetchFn, now: 1000 + 3600e3 })).from, "cache");
  assert.equal(calls.length, 3);
  assert.equal((await C.load(storage, { fetchFn, now: 1000 + 25 * 3600e3 })).from, "network");
  assert.equal((await C.load(storage, { fetchFn, now: 1000 + 25 * 3600e3, force: true })).from, "network");
});

test("sin conexión usa la caché vieja; sin caché da un error claro", async () => {
  const storage = DleStore.memoryStorage();
  const offline = fakeFetch({ "dles.json": new Error("offline") });
  await assert.rejects(C.load(storage, { fetchFn: offline }), /catálogo/);
  await C.load(storage, { fetchFn: fakeFetch({ "dles.json": RAW }), now: 0 });
  const stale = await C.load(storage, { fetchFn: offline, now: 10 * 24 * 3600e3 });
  assert.equal(stale.from, "stale");
  assert.equal(stale.games.length, 3);
  assert.equal(stale.weekly, null); // faltaban las listas opcionales
});

test("toGame crea un juego válido para el store", () => {
  const entry = C.normalize(RAW, [], []).games.find((g) => g.name === "alfa");
  const store = DleStore.create(DleStore.memoryStorage(), { seed: false, today: () => "2026-10-03" });
  const game = store.request("POST", "/api/games", C.toGame(entry));
  assert.equal(game.category, "Geografía");
  assert.equal(game.icon, "🌍");
  assert.equal(game.url, "https://www.alfa.example");
});
