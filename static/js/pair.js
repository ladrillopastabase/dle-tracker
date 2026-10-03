"use strict";

/**
 * Sincronizar dos dispositivos en la misma red, sin ningún servicio externo.
 *
 * Los navegadores solo pueden hablar entre sí con WebRTC, y para empezar cada
 * uno necesita unos datos del otro (la "oferta" y la "respuesta"). Aquí esos
 * datos viajan en QR pequeños: el primer dispositivo muestra el suyo, el otro
 * lo escanea y muestra su respuesta, y el primero la escanea (o la pega).
 *
 * - Sin servidores STUN/TURN ni de señalización: solo direcciones de la red
 *   local, así que ambos deben estar en la misma Wi-Fi (o uno compartiendo
 *   datos con el otro).
 * - Los códigos son compactos: de la SDP solo viaja lo imprescindible (usuario
 *   y clave ICE, huella DTLS, rol y direcciones) y se reconstruye al leerla.
 * - Al abrirse el canal se combinan los datos (DleSync.merge) y, mientras ambas
 *   pestañas sigan abiertas, cada cambio se manda al instante.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sync.js"));
  else root.DlePair = factory(root.DleSync);
})(typeof self !== "undefined" ? self : this, function (Sync) {
  const PREFIX = "DLE2";
  const ICE_SERVERS = []; // solo red local: nada sale de tu Wi-Fi
  const CHUNK = 16000; // los canales de datos limitan el tamaño de cada mensaje
  const SETUP = { actpass: "p", active: "a", passive: "s" };
  const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

  /* --------------------------------------------------- códigos de conexión */

  function toB64url(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  const hexToBytes = (hex) => Uint8Array.from(hex.match(/[0-9a-f]{2}/gi) || [], (h) => parseInt(h, 16));
  const bytesToHex = (bytes, sep = "") => Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
  // usuario/clave ICE usan + y /: se cambian por - y _ para que el código vaya bien en un enlace.
  const iceOut = (s) => s.replace(/\+/g, "-").replace(/\//g, "_");
  const iceIn = (s) => s.replace(/-/g, "+").replace(/_/g, "/");

  function packAddr(addr) {
    const m = MDNS.exec(addr);
    return m ? `m${toB64url(hexToBytes(m.slice(1).join("")))}` : addr;
  }

  function unpackAddr(text) {
    if (!text.startsWith("m")) return text;
    const h = bytesToHex(fromB64url(text.slice(1))).toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  }

  /** {type, sdp} → "DLE2~o~…" (~120 caracteres: QR pequeño, rápido de escanear). */
  function encodeSignal(desc) {
    const sdp = desc.sdp;
    const get = (k) => (sdp.match(new RegExp(`^a=${k}:(.+)$`, "m")) || [])[1]?.trim();
    const ufrag = get("ice-ufrag");
    const pwd = get("ice-pwd");
    const fp = (get("fingerprint") || "").split(/\s+/);
    const setup = SETUP[get("setup")];
    if (!ufrag || !pwd || fp[0]?.toLowerCase() !== "sha-256" || !setup) throw new Error("No se pudo preparar la conexión");
    const cands = [];
    for (const [, addr, port] of sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gim)) {
      if (cands.length < 4) cands.push(`${packAddr(addr)}!${port}`);
    }
    if (!cands.length) throw new Error("Este dispositivo no está conectado a ninguna red local");
    return [PREFIX, desc.type === "offer" ? "o" : "a", iceOut(ufrag), iceOut(pwd), toB64url(hexToBytes(fp[1])), setup, cands.join(",")].join("~");
  }

  /** Lo inverso: acepta el código solo o un enlace que lo contenga (…#/pair/DLE2~…). */
  function decodeSignal(input) {
    const match = String(input || "").match(/DLE2~[A-Za-z0-9\-_~.:,!]+/);
    if (!match) throw new Error("Ese no parece un código de sincronización");
    const [, t, ufrag, pwd, fp, setup, cands] = match[0].split("~");
    const role = Object.keys(SETUP).find((k) => SETUP[k] === setup);
    let fpBytes;
    try {
      fpBytes = fromB64url(fp || "");
    } catch {
      fpBytes = [];
    }
    const addrs = (cands || "").split(",").map((c) => c.split("!")).filter(([a, p]) => a && /^\d+$/.test(p || ""));
    if (!["o", "a"].includes(t) || !ufrag || !pwd || fpBytes.length !== 32 || !role || !addrs.length) {
      throw new Error("El código está incompleto o dañado: vuelve a escanearlo");
    }
    const session = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
    const lines = [
      "v=0", `o=- ${session} 2 IN IP4 127.0.0.1`, "s=-", "t=0 0", "a=group:BUNDLE 0", "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
      ...addrs.map(([a, p], i) => `a=candidate:${i + 1} 1 udp ${2122260223 - i} ${unpackAddr(a)} ${p} typ host generation 0`),
      `a=ice-ufrag:${iceIn(ufrag)}`, `a=ice-pwd:${iceIn(pwd)}`, "a=ice-options:trickle",
      `a=fingerprint:sha-256 ${bytesToHex(fpBytes, ":")}`, `a=setup:${role}`,
      "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144",
    ];
    return { type: t === "o" ? "offer" : "answer", sdp: lines.join("\r\n") + "\r\n" };
  }

  /** Sin servidores externos las direcciones locales salen enseguida; no hace falta esperar más. */
  function waitForIce(pc, timeout) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const timer = setTimeout(done, timeout);
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /* ----------------------------------------------------------- sesión */

  const NO_CONNECT = "No se pudieron conectar. Comprueba que ambos estén en la misma red Wi-Fi. Algunas redes "
    + "(universidades, cafeterías, Wi-Fi de invitados) aíslan los dispositivos entre sí: en ese caso, comparte "
    + "datos desde el celular, conecta el PC a esa red y vuelve a intentarlo.";

  /**
   * @param store        el store local (toPortable / applyPortable)
   * @param onStatus(st) fases: idle | offering | answering | connecting | synced | closed | error
   * @param onChange()   se aplicaron datos recibidos del otro dispositivo
   */
  function create({ store, onStatus = () => {}, onChange = () => {}, RTC = globalThis.RTCPeerConnection,
    iceServers = ICE_SERVERS, iceTimeout = 1500, connectTimeout = 20000 } = {}) {
    let pc = null;
    let channel = null;
    let st = { phase: "idle" };
    let timer = null;
    let deadline = null;
    const inbox = new Map();

    const set = (phase, extra = {}) => {
      st = { ...st, error: null, ...extra, phase };
      onStatus({ ...st });
    };

    function close({ silent = false } = {}) {
      clearTimeout(timer);
      clearTimeout(deadline);
      const ch = channel;
      channel = null;
      try { ch?.close(); } catch { /* ya cerrado */ }
      try { pc?.close(); } catch { /* ya cerrado */ }
      pc = null;
      inbox.clear();
      if (!silent) set("closed");
      else st = { phase: "idle" };
    }

    function fail(message) {
      close({ silent: true });
      set("error", { error: message });
    }

    /** Si el canal no se abre a tiempo, avisar en vez de quedarse esperando para siempre. */
    function armDeadline(ms) {
      clearTimeout(deadline);
      deadline = setTimeout(() => { if (!channel || channel.readyState !== "open") fail(NO_CONNECT); }, ms);
    }

    function newPeer() {
      if (!RTC) throw new Error("Este navegador no soporta WebRTC");
      const peer = new RTC({ iceServers });
      pc = peer;
      peer.addEventListener("connectionstatechange", () => {
        if (pc === peer && peer.connectionState === "failed") fail(NO_CONNECT);
      });
      return peer;
    }

    /** Envía un objeto en trozos (los canales tienen un tamaño máximo por mensaje). */
    function send(obj) {
      if (!channel || channel.readyState !== "open") return false;
      const text = JSON.stringify(obj);
      const id = Math.random().toString(36).slice(2, 10);
      const n = Math.max(1, Math.ceil(text.length / CHUNK));
      for (let i = 0; i < n; i++) channel.send(JSON.stringify({ id, i, n, part: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
      return true;
    }

    function sendState() {
      return send({ type: "state", data: store.toPortable() });
    }

    function receive(raw) {
      let piece;
      try {
        piece = JSON.parse(raw);
      } catch {
        return;
      }
      const parts = inbox.get(piece.id) || [];
      parts[piece.i] = piece.part;
      inbox.set(piece.id, parts);
      if (parts.filter((p) => p !== undefined).length < piece.n) return;
      inbox.delete(piece.id);
      let msg;
      try {
        msg = JSON.parse(parts.join(""));
      } catch {
        return;
      }
      if (msg.type === "state" && msg.data && Array.isArray(msg.data.games)) handleState(msg.data);
      else if (msg.type === "ok") synced(msg.games, msg.sessions, false);
    }

    /** Combina lo recibido; si este dispositivo tenía algo más, lo devuelve. */
    function handleState(remote) {
      const local = store.toPortable();
      const merged = Sync.merge(local, remote);
      const pulled = !Sync.sameData(merged, local) || local.pristine;
      if (pulled) store.applyPortable(merged);
      const counts = [merged.games.length, merged.sessions.length];
      // Si el otro ya tiene lo mismo, basta con avisarle de que todo cuadra.
      if (!Sync.sameData(merged, remote)) send({ type: "state", data: merged });
      else send({ type: "ok", games: counts[0], sessions: counts[1] });
      synced(...counts, pulled);
      if (pulled) onChange();
    }

    function synced(games, sessions, pulled) {
      set("synced", { at: Date.now(), games, sessions, pulled });
    }

    function attach(ch, role) {
      channel = ch;
      ch.onopen = () => {
        clearTimeout(deadline);
        set("connecting");
        if (role === "host") sendState(); // el que ofreció empieza; el otro combina y responde
      };
      ch.onmessage = (e) => receive(e.data);
      ch.onclose = () => { if (channel === ch) set("closed"); };
      if (ch.readyState === "open") ch.onopen();
    }

    /** Dispositivo A: crea la oferta y devuelve su código. */
    async function host() {
      close({ silent: true });
      const peer = newPeer();
      attach(peer.createDataChannel("dle-sync", { ordered: true }), "host");
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer, iceTimeout);
      const code = encodeSignal(peer.localDescription);
      set("offering", { code, role: "host" });
      return code;
    }

    /** Dispositivo A: recibe el código de respuesta de B. */
    async function acceptAnswer(input) {
      if (!pc || st.role !== "host") throw new Error("Primero muestra tu QR en este dispositivo");
      const desc = decodeSignal(input);
      if (desc.type !== "answer") throw new Error("Ese es el QR de este mismo paso: escanea el que muestra el otro dispositivo");
      await pc.setRemoteDescription(desc);
      set("connecting");
      armDeadline(connectTimeout);
    }

    /** Dispositivo B: recibe la oferta de A y devuelve su código de respuesta. */
    async function join(input) {
      const desc = decodeSignal(input);
      if (desc.type !== "offer") throw new Error("Ese es un código de respuesta: escanéalo desde el dispositivo que mostró el primer QR");
      close({ silent: true });
      const peer = newPeer();
      peer.addEventListener("datachannel", (e) => attach(e.channel, "guest"));
      await peer.setRemoteDescription(desc);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIce(peer, iceTimeout);
      const code = encodeSignal(peer.localDescription);
      set("answering", { code, role: "guest" });
      armDeadline(5 * 60000); // tiempo de sobra para escanear la respuesta
      return code;
    }

    /** Cambio local: se envía al otro dispositivo (agrupando cambios seguidos). */
    function notifyLocalChange() {
      if (!channel || channel.readyState !== "open") return;
      clearTimeout(timer);
      timer = setTimeout(sendState, 600);
    }

    return {
      host, acceptAnswer, join, close, notifyLocalChange,
      status: () => ({ ...st, open: !!channel && channel.readyState === "open" }),
      _attach: attach, // para tests
    };
  }

  return { create, encodeSignal, decodeSignal, ICE_SERVERS };
});
