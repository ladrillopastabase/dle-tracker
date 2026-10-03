// Tests de la sincronización: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DleStore = require("../static/js/store.js");
const DleSync = require("../static/js/sync.js");

const TODAY = "2026-10-03";
const device = (seed = false) => {
  const storage = DleStore.memoryStorage();
  const store = DleStore.create(storage, { seed, today: () => TODAY });
  return { storage, store, call: (m, p, b) => store.request(m, p, b) };
};
const names = (p) => p.games.map((g) => g.name).sort();
const tick = () => new Promise((r) => setTimeout(r, 5)); // para que updated_at avance

/* ------------------------------------------------------------ merge */

test("sin nube: el estado local se sube tal cual", () => {
  const a = device();
  a.call("POST", "/api/games", { name: "Wordle" });
  const merged = DleSync.merge(a.store.toPortable(), null);
  assert.deepEqual(names(merged), ["Wordle"]);
});

test("une juegos y partidas de dos dispositivos sin perder nada", () => {
  const a = device();
  const b = device();
  const wa = a.call("POST", "/api/games", { name: "Wordle" });
  a.call("POST", "/api/sessions", { game_id: wa.id, played_at: "2026-10-01", result: "win", attempts: 3 });
  const gb = b.call("POST", "/api/games", { name: "Globle" });
  b.call("POST", "/api/sessions", { game_id: gb.id, played_at: "2026-10-02", result: "win", attempts: 5 });
  const merged = DleSync.merge(a.store.toPortable(), b.store.toPortable());
  assert.deepEqual(names(merged), ["Globle", "Wordle"]);
  assert.equal(merged.sessions.length, 2);
});

test("el mismo juego creado en ambos lados (mismo nombre) se une", () => {
  const a = device();
  const b = device();
  const wa = a.call("POST", "/api/games", { name: "Wordle" });
  const wb = b.call("POST", "/api/games", { name: "wordle" });
  a.call("POST", "/api/sessions", { game_id: wa.id, played_at: "2026-10-01", result: "win", attempts: 3 });
  b.call("POST", "/api/sessions", { game_id: wb.id, played_at: "2026-10-02", result: "loss", attempts: 6 });
  const merged = DleSync.merge(a.store.toPortable(), b.store.toPortable());
  assert.equal(merged.games.length, 1);
  assert.equal(merged.sessions.length, 2);
  assert.ok(merged.sessions.every((x) => x.game_uid === merged.games[0].uid));
});

test("si se editó lo mismo en los dos, gana el cambio más reciente", async () => {
  const a = device();
  const w = a.call("POST", "/api/games", { name: "Wordle" });
  const s = a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-01", result: "win", attempts: 4 });
  const b = device();
  b.store.applyPortable(a.store.toPortable());
  await tick();
  a.call("PUT", `/api/sessions/${s.id}`, { attempts: 3 });
  await tick();
  b.call("PUT", `/api/sessions/${b.call("GET", "/api/sessions")[0].id}`, { attempts: 5, notes: "después" });
  const merged = DleSync.merge(a.store.toPortable(), b.store.toPortable());
  assert.equal(merged.sessions[0].attempts, 5);
  assert.equal(merged.sessions[0].notes, "después");
});

test("lo borrado en un dispositivo no reaparece desde el otro", async () => {
  const a = device();
  const w = a.call("POST", "/api/games", { name: "Wordle" });
  const g = a.call("POST", "/api/games", { name: "Globle" });
  const s = a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-01", result: "win", attempts: 4 });
  a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-02", result: "win", attempts: 2 });
  const b = device();
  b.store.applyPortable(a.store.toPortable());
  await tick();
  a.call("DELETE", `/api/sessions/${s.id}`);
  a.call("DELETE", `/api/games/${g.id}`);
  const merged = DleSync.merge(b.store.toPortable(), a.store.toPortable());
  assert.deepEqual(names(merged), ["Wordle"]);
  assert.deepEqual(merged.sessions.map((x) => x.played_at), ["2026-10-02"]);
});

test("un juego borrado y vuelto a crear después sí se mantiene", async () => {
  const a = device();
  const g = a.call("POST", "/api/games", { name: "Globle" });
  const b = device();
  b.store.applyPortable(a.store.toPortable());
  a.call("DELETE", `/api/games/${g.id}`);
  await tick();
  b.call("PUT", `/api/games/${b.call("GET", "/api/games")[0].id}`, { description: "editado después" });
  const merged = DleSync.merge(a.store.toPortable(), b.store.toPortable());
  assert.deepEqual(names(merged), ["Globle"]);
});

test("cambiar la fecha de una partida no deja la vieja en el otro dispositivo", async () => {
  const a = device();
  const w = a.call("POST", "/api/games", { name: "Wordle" });
  const s = a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-01", result: "win", attempts: 4 });
  const b = device();
  b.store.applyPortable(a.store.toPortable());
  await tick();
  a.call("PUT", `/api/sessions/${s.id}`, { played_at: "2026-09-30" });
  const merged = DleSync.merge(b.store.toPortable(), a.store.toPortable());
  assert.deepEqual(merged.sessions.map((x) => x.played_at), ["2026-09-30"]);
});

test("renombrar un juego conserva sus partidas en el otro dispositivo", async () => {
  const a = device();
  const w = a.call("POST", "/api/games", { name: "Wordle" });
  a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-01", result: "win", attempts: 4 });
  const b = device();
  b.store.applyPortable(a.store.toPortable());
  await tick();
  a.call("PUT", `/api/games/${w.id}`, { name: "Wordle NYT" });
  const merged = DleSync.merge(b.store.toPortable(), a.store.toPortable());
  assert.deepEqual(names(merged), ["Wordle NYT"]);
  assert.equal(merged.sessions.length, 1);
});

test("un dispositivo recién estrenado adopta la nube (no duplica los ejemplos)", () => {
  const a = device(true);
  a.call("DELETE", "/api/games/1"); // borró Wordle de los ejemplos
  a.call("POST", "/api/games", { name: "Tradle" });
  const fresh = device(true);
  const merged = DleSync.merge(fresh.store.toPortable(), a.store.toPortable());
  assert.deepEqual(names(merged), names(a.store.toPortable()));
  assert.ok(!names(merged).includes("Wordle"));
});

test("nombres repetidos tras combinar se numeran", async () => {
  const a = device();
  const x = a.call("POST", "/api/games", { name: "Uno" });
  a.call("POST", "/api/games", { name: "Dos" });
  const b = device();
  b.store.applyPortable(a.store.toPortable());
  await tick();
  a.call("PUT", `/api/games/${x.id}`, { name: "Tres" });
  const dos = b.call("GET", "/api/games").find((g) => g.name === "Dos");
  b.call("PUT", `/api/games/${dos.id}`, { name: "Tres" });
  const merged = DleSync.merge(a.store.toPortable(), b.store.toPortable());
  assert.deepEqual(names(merged), ["Tres", "Tres (2)"]);
});

test("las lápidas viejas se descartan", () => {
  const a = device();
  const g = a.call("POST", "/api/games", { name: "X" });
  a.call("DELETE", `/api/games/${g.id}`);
  const later = Date.now() + 200 * 86400e3;
  assert.equal(DleSync.merge(a.store.toPortable(), null, { now: later }).tombstones.length, 1); // sin nube: no se toca
  assert.equal(DleSync.merge(a.store.toPortable(), { games: [], sessions: [], tombstones: [] }, { now: later }).tombstones.length, 0);
});

test("applyPortable conserva los ids locales", () => {
  const a = device();
  const w = a.call("POST", "/api/games", { name: "Wordle" });
  const s = a.call("POST", "/api/sessions", { game_id: w.id, played_at: "2026-10-01", result: "win", attempts: 4 });
  const merged = DleSync.merge(a.store.toPortable(), null);
  a.store.applyPortable(merged);
  assert.equal(a.call("GET", `/api/games/${w.id}`).name, "Wordle");
  assert.equal(a.call("GET", `/api/sessions/${s.id}`).attempts, 4);
});

/* ------------------------------------------------- GitHub simulado */

function fakeGitHub() {
  const gists = new Map();
  let n = 0;
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const method = opts.method || "GET";
    calls.push(`${method} ${pathname}`);
    if (opts.headers?.Authorization !== "Bearer good-token") return json(401, { message: "Bad credentials" });
    if (pathname === "/user") return json(200, { login: "isidora" });
    if (pathname === "/gists" && method === "GET") return json(200, [...gists.values()]);
    if (pathname === "/gists" && method === "POST") {
      const body = JSON.parse(opts.body);
      const id = `g${++n}`;
      gists.set(id, { id, description: body.description, public: body.public, files: { ...body.files } });
      return json(201, gists.get(id));
    }
    const m = pathname.match(/^\/gists\/(\w+)$/);
    if (m && gists.has(m[1])) {
      if (method === "PATCH") Object.assign(gists.get(m[1]).files, JSON.parse(opts.body).files);
      return json(200, gists.get(m[1]));
    }
    return json(404, { message: "Not Found" });
  };
  return { fetchFn, gists, calls };
}

function syncDevice(gh, seed = false) {
  const d = device(seed);
  d.changes = 0;
  d.sync = DleSync.create({ storage: d.storage, store: d.store, fetchFn: gh.fetchFn, onChange: () => d.changes++ });
  return d;
}

test("dos dispositivos se sincronizan a través de un gist secreto", async () => {
  const gh = fakeGitHub();
  const pc = syncDevice(gh, true);
  const w = pc.call("GET", "/api/games").find((g) => g.name === "Wordle");
  pc.call("POST", "/api/sessions", { game_id: w.id, played_at: TODAY, result: "win", attempts: 3 });

  const first = await pc.sync.connect("good-token");
  assert.equal(first.created, true);
  assert.equal(gh.gists.size, 1);
  const gist = [...gh.gists.values()][0];
  assert.equal(gist.public, false);

  const phone = syncDevice(gh, true); // celular nuevo, con los ejemplos
  const second = await phone.sync.connect("good-token");
  assert.equal(second.created, false); // encontró el mismo gist
  assert.equal(phone.call("GET", "/api/sessions").length, 1);
  assert.equal(phone.call("GET", "/api/games").length, 5);
  assert.equal(phone.changes, 1);

  // Registro en el celular → llega al PC.
  const globle = phone.call("GET", "/api/games").find((g) => g.name === "Globle");
  phone.call("POST", "/api/sessions", { game_id: globle.id, played_at: TODAY, result: "win", attempts: 7 });
  await phone.sync.syncNow();
  const r = await pc.sync.syncNow();
  assert.deepEqual(r, { pulled: true, pushed: false });
  assert.equal(pc.call("GET", "/api/stats").played_today, 2);

  // Sin cambios no se vuelve a subir.
  assert.deepEqual(await pc.sync.syncNow(), { pulled: false, pushed: false });
  assert.equal(pc.sync.status().login, "isidora");
});

test("token inválido: error claro y no queda conectado", async () => {
  const gh = fakeGitHub();
  const d = syncDevice(gh);
  await assert.rejects(d.sync.connect("bad-token"), /token/);
  assert.equal(d.sync.status().connected, false);
  await assert.rejects(d.sync.connect("  "), /token/);
});

test("si borraron el gist, se vuelve a crear con lo de este dispositivo", async () => {
  const gh = fakeGitHub();
  const d = syncDevice(gh);
  d.call("POST", "/api/games", { name: "Wordle" });
  await d.sync.connect("good-token");
  gh.gists.clear();
  await d.sync.syncNow();
  assert.equal(gh.gists.size, 1);
  const content = JSON.parse([...gh.gists.values()][0].files[DleSync.FILE].content);
  assert.deepEqual(names(content), ["Wordle"]);
});

test("desconectar olvida el token pero conserva los datos", async () => {
  const gh = fakeGitHub();
  const d = syncDevice(gh);
  d.call("POST", "/api/games", { name: "Wordle" });
  await d.sync.connect("good-token");
  d.sync.disconnect();
  assert.equal(d.sync.status().connected, false);
  assert.equal(d.storage.getItem(DleSync.CONFIG_KEY), null);
  assert.equal(d.call("GET", "/api/games").length, 1);
  assert.deepEqual(await d.sync.syncNow(), { pulled: false, pushed: false });
});
