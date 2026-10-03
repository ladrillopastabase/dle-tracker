"use strict";

/**
 * Emparejar dispositivos directamente con WebRTC, sin cuentas ni servidor de datos.
 *
 * Sin servidor de señalización, los dos dispositivos intercambian una vez sus
 * "códigos de conexión" (la oferta y la respuesta SDP, comprimidas): el primero
 * los muestra como QR/enlace y el segundo responde con otro código. Cuando el
 * canal de datos se abre, se envían sus datos y se combinan con la misma
 * lógica que la sincronización por gist (DleSync.merge). Mientras ambas
 * pestañas sigan abiertas, cada cambio se manda al instante.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sync.js"));
  else root.DlePair = factory(root.DleSync);
})(typeof self !== "undefined" ? self : this, function (Sync) {
  const PREFIX = "DLE1."; // JSON comprimido (deflate-raw) en base64url
  const RAW_PREFIX = "DLE0."; // sin compresión (navegadores sin CompressionStream)
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
  const CHUNK = 16000; // los canales de datos limitan el tamaño de cada mensaje

  /* --------------------------------------------------- códigos de conexión */

  function toB64url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64url(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }

  /** {type, sdp} → "DLE1.xxxx" (texto apto para QR, enlaces y copiar/pegar). */
  async function encodeSignal(desc) {
    const json = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
    if (typeof CompressionStream === "function") {
      return PREFIX + toB64url(await pipe(json, new CompressionStream("deflate-raw")));
    }
    return RAW_PREFIX + toB64url(json);
  }

  /** Acepta el código solo o un enlace que lo contenga (…#/pair/DLE1.xxxx). */
  async function decodeSignal(input) {
    const text = String(input || "").trim();
    const match = text.match(/DLE[01]\.[A-Za-z0-9_-]+/);
    if (!match) throw new Error("Ese no parece un código de emparejamiento");
    const code = match[0];
    let bytes;
    try {
      bytes = fromB64url(code.slice(5));
      if (code.startsWith(PREFIX)) {
        if (typeof DecompressionStream !== "function") throw new Error("compresión no soportada");
        bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
      }
      const { t, s } = JSON.parse(new TextDecoder().decode(bytes));
      if (!["offer", "answer"].includes(t) || typeof s !== "string") throw new Error("formato");
      return { type: t, sdp: s };
    } catch {
      throw new Error("El código está incompleto o dañado: cópialo entero otra vez");
    }
  }

  function waitForIce(pc, timeout) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === "complete") done(); };
      const timer = setTimeout(done, timeout); // si un STUN no responde, seguir con lo que haya
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /* ----------------------------------------------------------- sesión */

  /**
   * @param store        el store local (toPortable / applyPortable)
   * @param onStatus(st) cambios de estado: idle | offering | joining | answering |
   *                     connecting | synced | closed | error
   * @param onChange()   se aplicaron datos recibidos del otro dispositivo
   */
  function create({ store, onStatus = () => {}, onChange = () => {}, RTC = globalThis.RTCPeerConnection,
    iceServers = ICE_SERVERS, iceTimeout = 4000 } = {}) {
    let pc = null;
    let channel = null;
    let st = { phase: "idle" };
    let timer = null;
    const inbox = new Map();

    const set = (phase, extra = {}) => {
      st = { ...st, ...extra, phase };
      onStatus({ ...st });
    };

    function close({ silent = false } = {}) {
      clearTimeout(timer);
      try { channel?.close(); } catch { /* ya cerrado */ }
      try { pc?.close(); } catch { /* ya cerrado */ }
      pc = null;
      channel = null;
      inbox.clear();
      if (!silent) set("closed");
      else st = { phase: "idle" };
    }

    function newPeer() {
      if (!RTC) throw new Error("Este navegador no soporta WebRTC");
      pc = new RTC({ iceServers });
      pc.addEventListener("connectionstatechange", () => {
        if (pc && pc.connectionState === "failed") {
          set("error", { error: "No se pudo conectar. Prueba con ambos dispositivos en la misma red Wi-Fi." });
        }
      });
      return pc;
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
      const code = await encodeSignal(peer.localDescription);
      set("offering", { code, role: "host", error: null });
      return code;
    }

    /** Dispositivo A: recibe el código de respuesta de B. */
    async function acceptAnswer(input) {
      if (!pc || st.role !== "host") throw new Error("Primero genera tu código en este dispositivo");
      const desc = await decodeSignal(input);
      if (desc.type !== "answer") throw new Error("Ese es un código de oferta: pégalo en el otro dispositivo");
      await pc.setRemoteDescription(desc);
      set("connecting");
    }

    /** Dispositivo B: recibe la oferta de A y devuelve su código de respuesta. */
    async function join(input) {
      const desc = await decodeSignal(input);
      if (desc.type !== "offer") throw new Error("Ese es un código de respuesta: pégalo en el dispositivo que mostró el QR");
      close({ silent: true });
      const peer = newPeer();
      peer.addEventListener("datachannel", (e) => attach(e.channel, "guest"));
      await peer.setRemoteDescription(desc);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIce(peer, iceTimeout);
      const code = await encodeSignal(peer.localDescription);
      set("answering", { code, role: "guest", error: null });
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
