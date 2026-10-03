// Tests del emparejamiento WebRTC (protocolo y códigos): node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DleStore = require("../static/js/store.js");
const DlePair = require("../static/js/pair.js");

const TODAY = "2026-10-03";
const SDP = "v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n"
  + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n"
  + "a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0\r\n".repeat(4)
  + "a=ice-ufrag:abcd\r\na=ice-pwd:0123456789abcdefghijklmnop\r\na=fingerprint:sha-256 "
  + "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\r\n";

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
function device(seed = false) {
  const store = DleStore.create(DleStore.memoryStorage(), { seed, today: () => TODAY });
  const d = { store, call: (m, p, b) => store.request(m, p, b), changes: 0, statuses: [] };
  d.pair = DlePair.create({ store, onChange: () => d.changes++, onStatus: (s) => d.statuses.push(s.phase), RTC: null });
  return d;
}

/** Dos extremos de un "canal de datos" en memoria (como RTCDataChannel). */
function channelPair() {
  const make = () => ({ readyState: "open", sent: 0, onmessage: null, onopen: null, onclose: null, close() {} });
  const a = make();
  const b = make();
  a.send = (data) => { a.sent++; setTimeout(() => b.onmessage?.({ data })); };
  b.send = (data) => { b.sent++; setTimeout(() => a.onmessage?.({ data })); };
  return [a, b];
}

function connect(host, guest) {
  const [ch1, ch2] = channelPair();
  guest.pair._attach(ch2, "guest");
  host.pair._attach(ch1, "host");
  return [ch1, ch2];
}

/* ------------------------------------------------------------ códigos */

test("los códigos se comprimen y se recuperan intactos", async () => {
  const code = await DlePair.encodeSignal({ type: "offer", sdp: SDP });
  assert.match(code, /^DLE1\.[A-Za-z0-9_-]+$/);
  assert.ok(code.length < SDP.length, `comprimido: ${code.length} < ${SDP.length}`);
  assert.deepEqual(await DlePair.decodeSignal(code), { type: "offer", sdp: SDP });
  // También dentro de un enlace o con espacios alrededor.
  const url = `https://ladrillopastabase.github.io/dle-tracker/#/pair/${code}`;
  assert.equal((await DlePair.decodeSignal(`  ${url}\n`)).type, "offer");
});

test("códigos dañados o ajenos dan un error claro", async () => {
  await assert.rejects(DlePair.decodeSignal("hola"), /no parece/);
  const code = await DlePair.encodeSignal({ type: "answer", sdp: SDP });
  await assert.rejects(DlePair.decodeSignal(code.slice(0, 40)), /incompleto|dañado/);
  await assert.rejects(DlePair.decodeSignal(""), /no parece/);
});

test("sin WebRTC disponible se avisa", async () => {
  const d = device();
  await assert.rejects(d.pair.host(), /WebRTC/);
  const offer = await DlePair.encodeSignal({ type: "offer", sdp: SDP });
  await assert.rejects(d.pair.join(offer), /WebRTC/);
  const answer = await DlePair.encodeSignal({ type: "answer", sdp: SDP });
  await assert.rejects(d.pair.join(answer), /código de respuesta/);
  await assert.rejects(d.pair.acceptAnswer(answer), /Primero/);
});

/* ------------------------------------------------------------ protocolo */

test("al conectar, ambos dispositivos quedan con los datos combinados", async () => {
  const pc = device();
  const phone = device();
  const w = pc.call("POST", "/api/games", { name: "Wordle" });
  pc.call("POST", "/api/sessions", { game_id: w.id, played_at: TODAY, result: "win", attempts: 3 });
  const g = phone.call("POST", "/api/games", { name: "Globle" });
  phone.call("POST", "/api/sessions", { game_id: g.id, played_at: TODAY, result: "win", attempts: 6 });
  phone.call("POST", "/api/games", { name: "wordle" }); // mismo juego creado en el celular

  connect(pc, phone);
  await wait(60);
  for (const d of [pc, phone]) {
    // Los dos «Wordle» son el mismo juego (gana el nombre de la versión más reciente).
    assert.deepEqual(d.call("GET", "/api/games").map((x) => x.name.toLowerCase()).sort(), ["globle", "wordle"]);
    assert.equal(d.call("GET", "/api/sessions").length, 2);
    assert.equal(d.pair.status().phase, "synced");
    assert.equal(d.changes, 1);
  }
});

test("un dispositivo nuevo recibe todo sin duplicar los juegos de ejemplo", async () => {
  const pc = device(true);
  pc.call("DELETE", "/api/games/1");
  const phone = device(true);
  connect(pc, phone);
  await wait(60);
  assert.deepEqual(phone.call("GET", "/api/games").map((g) => g.name), pc.call("GET", "/api/games").map((g) => g.name));
  // Aunque el nuevo no tenga nada que devolver, el que ofreció también se entera.
  for (const d of [pc, phone]) assert.equal(d.pair.status().phase, "synced");
});

test("con la conexión abierta, cada cambio llega al otro dispositivo", async () => {
  const pc = device();
  const phone = device();
  pc.call("POST", "/api/games", { name: "Wordle" });
  connect(pc, phone);
  await wait(60);
  const w = phone.call("GET", "/api/games")[0];
  phone.call("POST", "/api/sessions", { game_id: w.id, played_at: TODAY, result: "loss", attempts: 6 });
  phone.pair.notifyLocalChange();
  await wait(700);
  assert.equal(pc.call("GET", "/api/sessions")[0].result, "loss");
  // Y los borrados también.
  pc.call("DELETE", `/api/games/${pc.call("GET", "/api/games")[0].id}`);
  pc.pair.notifyLocalChange();
  await wait(700);
  assert.deepEqual(phone.call("GET", "/api/games"), []);
});

test("historiales grandes viajan en trozos", async () => {
  const pc = device();
  const phone = device();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(pc.call("POST", "/api/games", { name: `Juego ${i}`, description: "x".repeat(400) }).id);
  let d = new Date("2026-10-03T00:00:00Z");
  for (let day = 0; day < 200; day++) {
    const iso = d.toISOString().slice(0, 10);
    for (const id of ids) pc.call("POST", "/api/sessions", { game_id: id, played_at: iso, result: "win", attempts: 4, notes: "nota" });
    d = new Date(d.getTime() - 86400e3);
  }
  const [ch1] = connect(pc, phone);
  await wait(300);
  assert.equal(phone.call("GET", "/api/sessions").length, 2400);
  assert.ok(ch1.sent > 1, `se envió en ${ch1.sent} trozos`);
});

test("sin cambios no hay ida y vuelta infinita", async () => {
  const pc = device();
  const phone = device();
  pc.call("POST", "/api/games", { name: "Wordle" });
  const [ch1, ch2] = connect(pc, phone);
  await wait(100);
  const sent = ch1.sent + ch2.sent;
  await wait(200);
  assert.equal(ch1.sent + ch2.sent, sent);
  assert.ok(sent <= 2);
});
