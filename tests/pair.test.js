// Tests de la vinculación por QR (códigos, cifrado, señalización y protocolo): node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const DleStore = require("../static/js/store.js");
const DlePair = require("../static/js/pair.js");

const TODAY = "2026-10-03";
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Hasta que se cumpla la condición (PBKDF2 y la señalización son asíncronos). */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("tiempo agotado esperando la condición");
    await wait(10);
  }
}

/** Un ntfy en memoria: salas con suscriptores; guarda todo lo publicado. */
function fakeNtfy() {
  const topics = new Map();
  const log = [];
  return {
    log,
    subs: (topic) => (topics.get(topic) || new Set()).size,
    publish: async (topic, text) => {
      assert.ok(text.length <= 4096, `mensaje de ${text.length} bytes > 4 KB`);
      log.push({ topic, text });
      for (const s of topics.get(topic) || []) setTimeout(() => s.onMessage(text));
    },
    subscribe(topic, s) {
      if (!topics.has(topic)) topics.set(topic, new Set());
      topics.get(topic).add(s);
      setTimeout(() => s.onOpen());
      return () => topics.get(topic).delete(s);
    },
  };
}

/** RTCPeerConnection de mentira: la oferta/respuesta llevan el id y al responder se unen los canales. */
function fakeRTC() {
  const registry = new Map();
  let n = 0;
  const channel = () => {
    const ch = { readyState: "connecting", onmessage: null, onopen: null, onclose: null, peer: null };
    ch.send = (data) => { const other = ch.peer; setTimeout(() => other?.onmessage?.({ data })); };
    ch.close = () => {
      if (ch.readyState === "closed") return;
      ch.readyState = "closed";
      setTimeout(() => ch.onclose?.());
      ch.peer?.close();
    };
    return ch;
  };
  class RTC {
    constructor() {
      this.id = ++n;
      registry.set(this.id, this);
      this.iceGatheringState = "complete";
      this.connectionState = "new";
      this.signalingState = "stable";
      this.listeners = {};
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    emit(type, e = {}) { (this.listeners[type] || []).forEach((f) => f(e)); }
    createDataChannel() { this.ch = channel(); return this.ch; }
    async createOffer() { return { type: "offer", sdp: `fake ${this.id}` }; }
    async createAnswer() { return { type: "answer", sdp: `fake ${this.id}` }; }
    async setLocalDescription(d) {
      this.localDescription = d;
      if (d.type === "offer") this.signalingState = "have-local-offer";
    }
    async setRemoteDescription(d) {
      this.signalingState = "stable";
      if (d.type !== "answer") return;
      const other = registry.get(Number(d.sdp.split(" ")[1]));
      const theirs = channel();
      this.ch.peer = theirs;
      theirs.peer = this.ch;
      other.emit("datachannel", { channel: theirs });
      setTimeout(() => {
        for (const c of [this.ch, theirs]) { c.readyState = "open"; c.onopen?.(); }
        this.connectionState = other.connectionState = "connected";
      });
    }
    close() {
      this.connectionState = "closed";
      this.ch?.close();
    }
  }
  return RTC;
}

function device({ ntfy, RTC = fakeRTC(), seed = false, name = "dispositivo" } = {}) {
  const store = DleStore.create(DleStore.memoryStorage(), { seed, today: () => TODAY });
  const storage = DleStore.memoryStorage();
  const d = { store, storage, call: (m, p, b) => store.request(m, p, b), changes: 0 };
  d.pair = DlePair.create({ store, storage, name, signal: ntfy, RTC, onChange: () => d.changes++ });
  d.open = () => d.pair.status().open;
  return d;
}

/** Ambos dispositivos usan el mismo RTC falso (registro compartido). */
function two(opts = {}) {
  const ntfy = fakeNtfy();
  const RTC = fakeRTC();
  return { ntfy, a: device({ ntfy, RTC, name: "PC", ...opts.a }), b: device({ ntfy, RTC, name: "celular", ...opts.b }) };
}

/* ------------------------------------------------------------ códigos */

test("los códigos son cortos, legibles y se aceptan de varias formas", () => {
  const code = DlePair.newCode();
  assert.match(code, /^[2-9A-HJ-NP-Z]{10}$/);
  const pretty = DlePair.formatCode(code);
  assert.match(pretty, /^.{5}-.{5}$/);
  assert.equal(DlePair.parseCode(pretty), code);
  assert.equal(DlePair.parseCode(` ${pretty.toLowerCase()} `), code);
  assert.equal(DlePair.parseCode(`https://x.github.io/dle-tracker/#/pair/${pretty}`), code);
  assert.throws(() => DlePair.parseCode("hola"), /10 letras/);
  assert.throws(() => DlePair.parseCode("K7P2Q-X9M4O"), /10 letras/); // la O no existe en el alfabeto
});

test("cada código da una sala y una clave propias; otro código no puede leer", async () => {
  const r1 = await DlePair.deriveRoom("K7P2QX9M4R");
  const r1b = await DlePair.deriveRoom("K7P2QX9M4R");
  const r2 = await DlePair.deriveRoom("K7P2QX9M4S");
  assert.equal(r1.topic, r1b.topic);
  assert.notEqual(r1.topic, r2.topic);
  assert.match(r1.topic, /^dle-[0-9a-f]{32}$/);
  assert.ok(!r1.topic.includes("K7P2Q"), "la sala no revela el código");
  const msg = { t: "offer", sdp: "v=0\r\n".repeat(200) };
  const sealed = await DlePair.seal(r1.key, msg);
  assert.ok(sealed.length < 600, `comprimido y cifrado: ${sealed.length}`);
  assert.ok(!sealed.includes("v=0"));
  assert.deepEqual(await DlePair.open(r1b.key, sealed), msg);
  assert.equal(await DlePair.open(r2.key, sealed), null);
  assert.equal(await DlePair.open(r1.key, sealed.slice(0, -4) + "AAAA"), null);
});

test("sin WebRTC disponible se avisa", async () => {
  const d = device({ ntfy: fakeNtfy(), RTC: null });
  const st = await d.pair.join("K7P2Q-X9M4R");
  assert.match(st.error, /WebRTC/);
});

/* ------------------------------------------------------------ vinculación */

test("con un solo escaneo los dos dispositivos se conectan y combinan sus datos", async () => {
  const { ntfy, a, b } = two();
  const w = a.call("POST", "/api/games", { name: "Wordle" });
  a.call("POST", "/api/sessions", { game_id: w.id, played_at: TODAY, result: "win", attempts: 3 });
  const g = b.call("POST", "/api/games", { name: "Globle" });
  b.call("POST", "/api/sessions", { game_id: g.id, played_at: TODAY, result: "win", attempts: 6 });

  const code = await a.pair.link(); // el PC muestra el QR
  assert.match(code, /^.{5}-.{5}$/);
  await b.pair.join(`https://x.github.io/dle-tracker/#/pair/${code}`); // el celular lo escanea
  await until(() => a.open() && b.open() && a.pair.status().peers[0].at && b.pair.status().peers[0].at);

  for (const d of [a, b]) {
    assert.deepEqual(d.call("GET", "/api/games").map((x) => x.name).sort(), ["Globle", "Wordle"]);
    assert.equal(d.call("GET", "/api/sessions").length, 2);
    assert.equal(d.changes, 1);
  }
  assert.equal(a.pair.status().peers[0].name, "celular");
  assert.equal(b.pair.status().peers[0].name, "PC");
  // Por ntfy solo pasaron unos pocos mensajes cifrados: hello ×2, (respuesta al hello), offer, answer.
  assert.ok(ntfy.log.length <= 5, `mensajes: ${ntfy.log.length}`);
  for (const { text } of ntfy.log) assert.ok(!/Wordle|offer|fake/.test(text));
});

test("un dispositivo nuevo recibe todo sin duplicar los juegos de ejemplo", async () => {
  const { a, b } = two({ a: { seed: true }, b: { seed: true } });
  a.call("DELETE", "/api/games/1");
  await b.pair.join(await a.pair.link());
  await until(() => a.pair.status().peers[0]?.at && b.pair.status().peers[0]?.at);
  assert.deepEqual(b.call("GET", "/api/games").map((g) => g.name), a.call("GET", "/api/games").map((g) => g.name));
});

test("con la conexión abierta cada cambio llega al instante, también los borrados", async () => {
  const { a, b } = two();
  a.call("POST", "/api/games", { name: "Wordle" });
  await b.pair.join(await a.pair.link());
  await until(() => b.call("GET", "/api/games").length === 1);
  const w = b.call("GET", "/api/games")[0];
  b.call("POST", "/api/sessions", { game_id: w.id, played_at: TODAY, result: "loss", attempts: 6 });
  b.pair.notifyLocalChange();
  await until(() => a.call("GET", "/api/sessions")[0]?.result === "loss");
  a.call("DELETE", `/api/games/${a.call("GET", "/api/games")[0].id}`);
  a.pair.notifyLocalChange();
  await until(() => b.call("GET", "/api/games").length === 0);
});

test("ya vinculados, al volver a abrir la app se reconectan solos", async () => {
  const ntfy = fakeNtfy();
  const RTC = fakeRTC();
  const a = device({ ntfy, RTC, name: "PC" });
  const b = device({ ntfy, RTC, name: "celular" });
  await b.pair.join(await a.pair.link());
  await until(() => a.open() && b.open());
  // El celular cierra la pestaña…
  b.pair.stop();
  await until(() => !a.open());
  // …y la vuelve a abrir más tarde (nueva pestaña, mismo almacenamiento): sin escanear nada.
  a.call("POST", "/api/games", { name: "Worldle" });
  const b2 = { ...b, changes: 0 };
  b2.pair = DlePair.create({ store: b.store, storage: b.storage, name: "celular", signal: ntfy, RTC, onChange: () => b2.changes++ });
  assert.equal(b2.pair.status().linked, true);
  await b2.pair.start();
  await until(() => b2.pair.status().open && b.call("GET", "/api/games").length === 1);
  assert.equal(b.call("GET", "/api/games")[0].name, "Worldle");
});

test("tres dispositivos: un cambio en uno llega a los otros dos", async () => {
  const ntfy = fakeNtfy();
  const RTC = fakeRTC();
  const [pc, phone, tablet] = ["PC", "celular", "tablet"].map((name) => device({ ntfy, RTC, name }));
  const code = await pc.pair.link();
  await phone.pair.join(code);
  await tablet.pair.join(code);
  await until(() => [pc, phone, tablet].every((d) => d.pair.status().open === 2));
  tablet.call("POST", "/api/games", { name: "Tradle" });
  tablet.pair.notifyLocalChange();
  await until(() => [pc, phone].every((d) => d.call("GET", "/api/games").length === 1));
});

test("desvincular deja de escuchar y olvida el código", async () => {
  const { ntfy, a, b } = two();
  await b.pair.join(await a.pair.link());
  await until(() => a.open() && b.open());
  b.pair.unlink();
  assert.equal(b.pair.status().linked, false);
  assert.equal(b.storage.getItem("dle-pair"), null);
  await until(() => !a.open());
  const topic = ntfy.log[0].topic;
  assert.equal(ntfy.subs(topic), 1); // solo queda el PC escuchando
});

test("mensajes de otra sala, propios o dañados se ignoran", async () => {
  const { ntfy, a } = two();
  await a.pair.link();
  await until(() => ntfy.log.length === 1); // su propio "hello"
  const { topic } = ntfy.log[0];
  await ntfy.publish(topic, "basura");
  const other = await DlePair.deriveRoom("ZZZZZZZZZZ");
  await ntfy.publish(topic, await DlePair.seal(other.key, { t: "hello", from: "AAAA" }));
  await wait(50);
  assert.deepEqual(a.pair.status().peers, []);
});

test("historiales grandes viajan en trozos", async () => {
  const { a, b } = two();
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(a.call("POST", "/api/games", { name: `Juego ${i}`, description: "x".repeat(400) }).id);
  let d = new Date("2026-10-03T00:00:00Z");
  for (let day = 0; day < 200; day++) {
    const iso = d.toISOString().slice(0, 10);
    for (const id of ids) a.call("POST", "/api/sessions", { game_id: id, played_at: iso, result: "win", attempts: 4, notes: "nota" });
    d = new Date(d.getTime() - 86400e3);
  }
  await b.pair.join(await a.pair.link());
  await until(() => b.call("GET", "/api/sessions").length === 2400, 5000);
});
