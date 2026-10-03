"use strict";

/**
 * Vincular dispositivos con un solo QR (o un código para teclear en el PC).
 *
 * - El QR solo lleva un código secreto corto (p. ej. K7P2Q-X9M4R). De él salen,
 *   con PBKDF2, el nombre de una "sala" y una clave AES-GCM.
 * - Los dispositivos se encuentran en esa sala a través de un servicio público
 *   de mensajes (ntfy.sh), por donde solo viajan los datos de conexión WebRTC
 *   cifrados con la clave. Ni ntfy ni nadie sin el código puede leerlos.
 * - Luego se conectan directamente (WebRTC) y se mandan sus datos, que se
 *   combinan con la misma lógica que la sincronización por gist (DleSync.merge).
 * - El código queda guardado: cada vez que dos dispositivos vinculados tienen la
 *   app abierta se reconectan solos y cada cambio llega al instante.
 *
 * Señalización: "hello" (estoy aquí) → el de id menor manda "offer" → "answer".
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./sync.js"));
  else root.DlePair = factory(root.DleSync);
})(typeof self !== "undefined" ? self : this, function (Sync) {
  const SIGNAL_URL = "https://ntfy.sh";
  const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // sin 0/O ni 1/I para teclearlo sin dudas
  const CODE_LEN = 10;
  const GROUP_KEY = "dle-pair";
  const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
  const CHUNK = 16000; // los canales de datos limitan el tamaño de cada mensaje

  /* ------------------------------------------------------------ códigos */

  const randomId = (n = 12) => {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(bytes, (b) => ALPHABET[b % 32]).join("");
  };
  const newCode = () => randomId(CODE_LEN);
  const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

  /** Acepta el código (con o sin guion, en minúsculas) o un enlace …#/pair/XXXXX-XXXXX. */
  function parseCode(input) {
    let text = String(input || "").trim();
    const link = text.match(/#\/pair\/([^\s?#&]+)/);
    if (link) text = decodeURIComponent(link[1]);
    const code = text.toUpperCase().replace(/[\s-]/g, "");
    if (code.length !== CODE_LEN || [...code].some((c) => !ALPHABET.includes(c))) {
      throw new Error(`El código tiene ${CODE_LEN} letras y números, como ${formatCode("K7P2QX9M4R")}`);
    }
    return code;
  }

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

  /** Código → { topic, key }: la sala de ntfy y la clave para cifrar lo que pasa por ella. */
  async function deriveRoom(code) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("dle-tracker/pair/v1"), iterations: 100000 },
      base, 384,
    ));
    const topic = "dle-" + Array.from(bits.subarray(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
    const key = await crypto.subtle.importKey("raw", bits.subarray(16), "AES-GCM", false, ["encrypt", "decrypt"]);
    return { topic, key };
  }

  /** Objeto → JSON comprimido y cifrado (los mensajes de ntfy admiten hasta 4 KB). */
  async function seal(key, obj) {
    let bytes = new TextEncoder().encode(JSON.stringify(obj));
    const zip = typeof CompressionStream === "function";
    if (zip) bytes = await pipe(bytes, new CompressionStream("deflate-raw"));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
    const out = new Uint8Array(13 + ct.length);
    out[0] = zip ? 1 : 0;
    out.set(iv, 1);
    out.set(ct, 13);
    return toB64url(out);
  }

  /** Lo inverso de `seal`; null si no es de esta sala (otra clave) o está dañado. */
  async function open(key, text) {
    try {
      const raw = fromB64url(text);
      let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.subarray(1, 13) }, key, raw.subarray(13)));
      if (raw[0] === 1) bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
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

  /* ----------------------------------------------------- señalización (ntfy) */

  /** Publicar y escuchar mensajes de texto en una sala de ntfy.sh (gratis, sin cuenta). */
  function ntfySignal({ base = SIGNAL_URL, fetchFn = (...a) => fetch(...a), EventSourceCls = globalThis.EventSource } = {}) {
    return {
      async publish(topic, text) {
        const res = await fetchFn(`${base}/${topic}`, { method: "POST", body: text });
        if (!res.ok) throw new Error(`ntfy respondió ${res.status}`);
      },
      subscribe(topic, { onMessage, onOpen = () => {}, onError = () => {} }) {
        if (!EventSourceCls) throw new Error("Este navegador no puede escuchar mensajes");
        const es = new EventSourceCls(`${base}/${topic}/sse`);
        es.onopen = () => onOpen();
        es.onerror = () => onError();
        es.onmessage = (e) => {
          try {
            const m = JSON.parse(e.data);
            if ((!m.event || m.event === "message") && typeof m.message === "string") onMessage(m.message);
          } catch { /* keepalive u otro evento */ }
        };
        return () => es.close();
      },
    };
  }

  /* ------------------------------------------------------------- sesión */

  /**
   * @param store        el store local (toPortable / applyPortable)
   * @param storage      dónde guardar el código del grupo (localStorage)
   * @param name         nombre de este dispositivo (se muestra en los otros)
   * @param onStatus(st) { linked, code, listening, error, peers: [{ id, name, open, at, games, sessions }] }
   * @param onChange()   se aplicaron datos recibidos de otro dispositivo
   */
  function create({ store, storage, name = "dispositivo", onStatus = () => {}, onChange = () => {},
    RTC = globalThis.RTCPeerConnection, signal = ntfySignal(), iceServers = ICE_SERVERS, iceTimeout = 3000 } = {}) {
    const me = randomId(); // id de esta pestaña: cambia en cada carga
    const peers = new Map();
    let room = null; // { code, topic, key }
    let unsubscribe = null;
    let listening = false;
    let error = null;
    let timer = null;

    const readGroup = () => {
      try {
        return JSON.parse(storage.getItem(GROUP_KEY)) || null;
      } catch {
        return null;
      }
    };
    const writeGroup = (g) => {
      try {
        if (g) storage.setItem(GROUP_KEY, JSON.stringify(g));
        else storage.removeItem(GROUP_KEY);
      } catch { /* sin almacenamiento */ }
    };

    function status() {
      const g = readGroup();
      return {
        linked: !!g,
        code: g ? formatCode(g.code) : null,
        listening,
        error,
        peers: [...peers.values()].map((p) => ({ id: p.id, name: p.name, open: p.open, at: p.at, games: p.games, sessions: p.sessions })),
        open: [...peers.values()].filter((p) => p.open).length,
      };
    }
    const emit = () => onStatus(status());

    async function post(obj) {
      if (!room) return;
      await signal.publish(room.topic, await seal(room.key, { ...obj, from: me }));
    }

    /* --- canal de datos con un dispositivo --- */

    function send(peer, obj) {
      const ch = peer.channel;
      if (!ch || ch.readyState !== "open") return;
      const text = JSON.stringify(obj);
      const id = randomId(8);
      const n = Math.max(1, Math.ceil(text.length / CHUNK));
      for (let i = 0; i < n; i++) ch.send(JSON.stringify({ id, i, n, part: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
    }

    function broadcast(except = null) {
      const data = store.toPortable();
      for (const p of peers.values()) if (p.open && p !== except) send(p, { type: "state", data });
    }

    function receive(peer, raw) {
      let piece;
      try {
        piece = JSON.parse(raw);
      } catch {
        return;
      }
      const parts = peer.inbox.get(piece.id) || [];
      parts[piece.i] = piece.part;
      peer.inbox.set(piece.id, parts);
      if (parts.filter((p) => p !== undefined).length < piece.n) return;
      peer.inbox.delete(piece.id);
      let msg;
      try {
        msg = JSON.parse(parts.join(""));
      } catch {
        return;
      }
      if (msg.type === "state" && msg.data && Array.isArray(msg.data.games)) handleState(peer, msg.data);
      else if (msg.type === "ok") synced(peer, msg.games, msg.sessions);
    }

    /** Combina lo recibido; si este dispositivo tenía algo más, se lo devuelve. */
    function handleState(peer, remote) {
      const local = store.toPortable();
      const merged = Sync.merge(local, remote);
      const pulled = !Sync.sameData(merged, local) || local.pristine;
      if (pulled) store.applyPortable(merged);
      if (!Sync.sameData(merged, remote)) send(peer, { type: "state", data: merged });
      else if (!peer.at) send(peer, { type: "ok", games: merged.games.length, sessions: merged.sessions.length });
      synced(peer, merged.games.length, merged.sessions.length);
      if (pulled) {
        broadcast(peer); // y a los demás dispositivos conectados
        onChange();
      }
    }

    function synced(peer, games, sessions) {
      Object.assign(peer, { at: Date.now(), games, sessions });
      emit();
    }

    function dropPeer(peer) {
      if (peers.get(peer.id) !== peer) return;
      peers.delete(peer.id);
      try { peer.channel?.close(); } catch { /* ya cerrado */ }
      try { peer.pc.close(); } catch { /* ya cerrado */ }
      emit();
    }

    function newPeer(id, peerName) {
      const old = peers.get(id);
      if (old) dropPeer(old);
      const pc = new RTC({ iceServers });
      const peer = { id, name: peerName || "dispositivo", pc, channel: null, inbox: new Map(), open: false, at: null, created: Date.now() };
      peers.set(id, peer);
      pc.addEventListener("connectionstatechange", () => {
        if (["failed", "closed"].includes(pc.connectionState)) dropPeer(peer);
      });
      emit();
      return peer;
    }

    function attach(peer, ch, starter) {
      peer.channel = ch;
      ch.onopen = () => {
        peer.open = true;
        emit();
        if (starter) send(peer, { type: "state", data: store.toPortable() }); // quien ofreció empieza
      };
      ch.onmessage = (e) => receive(peer, e.data);
      ch.onclose = () => dropPeer(peer);
      if (ch.readyState === "open") ch.onopen();
    }

    /* --- señalización --- */

    async function hello(to = null) {
      await post({ t: "hello", to, name });
    }

    async function offer(id, peerName) {
      const peer = newPeer(id, peerName);
      attach(peer, peer.pc.createDataChannel("dle-sync", { ordered: true }), true);
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      await waitForIce(peer.pc, iceTimeout);
      if (peers.get(id) !== peer) return;
      await post({ t: "offer", to: id, name, sdp: peer.pc.localDescription.sdp });
    }

    async function answer(id, peerName, sdp) {
      const peer = newPeer(id, peerName);
      peer.pc.addEventListener("datachannel", (e) => attach(peer, e.channel, false));
      await peer.pc.setRemoteDescription({ type: "offer", sdp });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await waitForIce(peer.pc, iceTimeout);
      if (peers.get(id) !== peer) return;
      await post({ t: "answer", to: id, sdp: peer.pc.localDescription.sdp });
    }

    async function onSignal(text) {
      const r = room;
      const msg = r && (await open(r.key, text));
      if (!msg || room !== r || msg.from === me || (msg.to && msg.to !== me)) return;
      try {
        if (msg.t === "hello") {
          const known = peers.get(msg.from);
          if (known && (known.open || Date.now() - known.created < 10000)) return; // ya en curso
          // De cada pareja, ofrece el de id menor; el otro solo le avisa que está.
          if (me < msg.from) await offer(msg.from, msg.name);
          else if (!msg.to) await hello(msg.from);
        } else if (msg.t === "offer" && typeof msg.sdp === "string") {
          await answer(msg.from, msg.name, msg.sdp);
        } else if (msg.t === "answer" && typeof msg.sdp === "string") {
          const peer = peers.get(msg.from);
          if (peer && peer.pc.signalingState === "have-local-offer") await peer.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        }
      } catch (err) {
        error = `No se pudo conectar: ${err.message}`;
        emit();
      }
    }

    /* --- API --- */

    /** Entra a la sala del grupo guardado y avisa a los demás. */
    async function start() {
      const g = readGroup();
      if (!g) return status();
      if (!RTC) {
        error = "Este navegador no soporta WebRTC";
        emit();
        return status();
      }
      if (room?.code === g.code && unsubscribe) return status();
      stop();
      const r = { code: g.code, ...(await deriveRoom(g.code)) };
      if (readGroup()?.code !== g.code) return status(); // cambió mientras se derivaba la clave
      room = r;
      error = null;
      await new Promise((resolve) => {
        let first = true;
        unsubscribe = signal.subscribe(r.topic, {
          onMessage: (text) => { onSignal(text); },
          onOpen: () => {
            listening = true;
            error = null;
            emit();
            hello().catch((err) => { error = `Sin conexión con el servicio de enlace (${err.message})`; emit(); });
            if (first) resolve();
            first = false;
          },
          onError: () => {
            listening = false;
            error = "Sin conexión con el servicio de enlace; se reintenta solo";
            emit();
            if (first) resolve();
            first = false;
          },
        });
      });
      return status();
    }

    /** Cierra conexiones y deja de escuchar (el grupo sigue guardado). */
    function stop() {
      clearTimeout(timer);
      unsubscribe?.();
      unsubscribe = null;
      listening = false;
      for (const p of [...peers.values()]) dropPeer(p);
      room = null;
    }

    /** Crea un grupo nuevo (si no hay) y devuelve su código para mostrarlo. */
    async function link() {
      if (!readGroup()) writeGroup({ code: newCode() });
      await start();
      return status().code;
    }

    /** Entra al grupo de otro dispositivo con su código o enlace. */
    async function join(input) {
      const code = parseCode(input);
      if (readGroup()?.code !== code) {
        stop();
        writeGroup({ code });
      }
      await start();
      return status();
    }

    /** Este dispositivo deja el grupo (los demás siguen vinculados entre sí). */
    function unlink() {
      stop();
      writeGroup(null);
      error = null;
      emit();
    }

    /** Al volver a la pestaña: si no hay nadie conectado, volver a saludar. */
    function wake() {
      if (!readGroup()) return;
      if (!unsubscribe) start().catch(() => {});
      else if (listening && ![...peers.values()].some((p) => p.open)) hello().catch(() => {});
    }

    /** Cambio local: se envía a los dispositivos conectados (agrupando cambios seguidos). */
    function notifyLocalChange() {
      if (![...peers.values()].some((p) => p.open)) return;
      clearTimeout(timer);
      timer = setTimeout(() => broadcast(), 600);
    }

    return { start, stop, link, join, unlink, wake, notifyLocalChange, status };
  }

  return { create, ntfySignal, parseCode, formatCode, newCode, deriveRoom, seal, open, ICE_SERVERS, SIGNAL_URL };
});
