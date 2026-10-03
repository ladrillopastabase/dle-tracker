// Tests de la sincronización en la red local (códigos compactos y protocolo): node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DleStore = require("../static/js/store.js");
const DlePair = require("../static/js/pair.js");

const TODAY = "2026-10-03";
const sdp = (setup, cands) => ["v=0", "o=- 6822683021183029030 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0",
  "a=extmap-allow-mixed", "a=msid-semantic: WMS", "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
  ...cands, "a=ice-ufrag:/cHN", "a=ice-pwd:6Jf7i/rfid+e28iG8Li9U79L", "a=ice-options:trickle",
  "a=fingerprint:sha-256 B6:93:06:98:02:95:EB:30:BC:81:E7:62:DF:7E:0E:BA:80:A0:C6:D4:43:E0:D5:96:7B:A5:56:D8:A0:61:16:84",
  `a=setup:${setup}`, "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144", ""].join("\r\n");
const MDNS_CAND = "a=candidate:3135578019 1 udp 2113937151 4c2014de-fd3d-4527-87df-054bdc2ae69c.local 48052 typ host generation 0 network-cost 999";
const IP_CAND = "a=candidate:1 1 UDP 2122187007 192.168.1.20 54321 typ host"; // estilo Firefox
const TCP_CAND = "a=candidate:2 1 tcp 1518280447 192.168.1.20 9 typ host tcptype active generation 0";

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

test("los códigos son cortos y conservan todo lo necesario para conectar", () => {
  const offer = { type: "offer", sdp: sdp("actpass", [MDNS_CAND, IP_CAND, TCP_CAND]) };
  const code = DlePair.encodeSignal(offer);
  assert.match(code, /^DLE2~o~/);
  assert.ok(code.length < 160, `código de ${code.length} caracteres`);
  assert.ok(!/[+/\s]/.test(code), "apto para un enlace");
  const back = DlePair.decodeSignal(`https://ladrillopastabase.github.io/dle-tracker/#/pair/${code}`);
  assert.equal(back.type, "offer");
  for (const line of ["a=ice-ufrag:/cHN", "a=ice-pwd:6Jf7i/rfid+e28iG8Li9U79L", "a=setup:actpass",
    "a=fingerprint:sha-256 B6:93:06:98:02:95:EB:30:BC:81:E7:62:DF:7E:0E:BA:80:A0:C6:D4:43:E0:D5:96:7B:A5:56:D8:A0:61:16:84",
    " 4c2014de-fd3d-4527-87df-054bdc2ae69c.local 48052 typ host", " 192.168.1.20 54321 typ host"]) {
    assert.ok(back.sdp.includes(line), `falta ${line}`);
  }
  assert.ok(!back.sdp.includes("tcp"), "solo candidatos UDP");
  // Volver a codificar la SDP reconstruida da el mismo código.
  assert.equal(DlePair.encodeSignal(back), code);
  assert.equal(DlePair.decodeSignal(DlePair.encodeSignal({ type: "answer", sdp: sdp("active", [IP_CAND]) })).type, "answer");
});

test("códigos dañados, ajenos o sin red local dan un error claro", () => {
  assert.throws(() => DlePair.decodeSignal("hola"), /no parece/);
  const code = DlePair.encodeSignal({ type: "offer", sdp: sdp("actpass", [MDNS_CAND]) });
  assert.throws(() => DlePair.decodeSignal(code.slice(0, 40)), /incompleto|dañado/);
  assert.throws(() => DlePair.decodeSignal(""), /no parece/);
  assert.throws(() => DlePair.encodeSignal({ type: "offer", sdp: sdp("actpass", [TCP_CAND]) }), /red local/);
});

test("sin WebRTC disponible se avisa", async () => {
  const d = device();
  await assert.rejects(d.pair.host(), /WebRTC/);
  const offer = DlePair.encodeSignal({ type: "offer", sdp: sdp("actpass", [MDNS_CAND]) });
  await assert.rejects(d.pair.join(offer), /WebRTC/);
  const answer = DlePair.encodeSignal({ type: "answer", sdp: sdp("active", [MDNS_CAND]) });
  await assert.rejects(d.pair.join(answer), /código de respuesta/);
  await assert.rejects(d.pair.acceptAnswer(answer), /Primero/);
});

test("no se usa ningún servidor externo y, si no conecta, avisa en vez de esperar para siempre", async () => {
  const configs = [];
  class FakeRTC {
    constructor(cfg) { configs.push(cfg); this.iceGatheringState = "complete"; this.listeners = {}; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    removeEventListener() {}
    createDataChannel() { return { readyState: "connecting", close() {} }; }
    async createOffer() { return { type: "offer", sdp: sdp("actpass", [MDNS_CAND]) }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    close() {}
  }
  const store = DleStore.create(DleStore.memoryStorage(), { today: () => TODAY });
  const phases = [];
  const pair = DlePair.create({ store, RTC: FakeRTC, connectTimeout: 50, onStatus: (s) => phases.push(s) });
  await pair.host();
  await pair.acceptAnswer(DlePair.encodeSignal({ type: "answer", sdp: sdp("active", [IP_CAND]) }));
  assert.deepEqual(configs, [{ iceServers: [] }]);
  await wait(100);
  const last = phases.at(-1);
  assert.equal(last.phase, "error");
  assert.match(last.error, /misma red Wi-Fi/);
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
