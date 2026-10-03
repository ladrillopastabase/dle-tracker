"use strict";

/**
 * Sincronización entre dispositivos con un Gist secreto de GitHub (gratis).
 *
 * - `merge(local, remoto)` combina dos estados sin perder datos: cada juego
 *   tiene un `uid` estable y cada partida se identifica por juego + día; si el
 *   mismo registro cambió en ambos lados gana el `updated_at` más reciente, y
 *   las eliminaciones viajan como "lápidas" (tombstones) para que lo borrado
 *   no reaparezca. Juegos con el mismo nombre creados por separado se unen.
 * - `create(...)` habla con la API de GitHub: busca o crea el gist, baja,
 *   combina y sube.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DleSync = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const FILE = "dle-tracker.json";
  const DESCRIPTION = "dle_tracker · sincronización (no borrar)";
  const API = "https://api.github.com";
  const CONFIG_KEY = "dle-sync";
  const TOMBSTONE_DAYS = 180;
  const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=gist&description=dle_tracker%20sync";

  /* ------------------------------------------------------------ merge */

  const newer = (a, b) => String(a.updated_at || "") > String(b.updated_at || "");
  const sessionKey = (x) => `${x.game_uid}|${x.played_at}`;
  const tombKey = (t) => (t.kind === "game" ? `g:${t.uid}` : `s:${t.game_uid}|${t.played_at}`);

  function merge(local, remote, { now = Date.now() } = {}) {
    const clone = (v) => JSON.parse(JSON.stringify(v));
    if (!remote || !Array.isArray(remote.games)) return { ...clone(local), pristine: false };
    // Un dispositivo recién estrenado (solo juegos de ejemplo) adopta la nube tal cual.
    if (local.pristine && !remote.pristine && remote.games.length) return { ...clone(remote), pristine: false };

    // 1. Juegos con el mismo nombre pero distinto uid (creados por separado) → mismo juego.
    const remoteUids = new Set(remote.games.map((g) => g.uid));
    const localUids = new Set(local.games.map((g) => g.uid));
    const remoteByName = new Map(remote.games.map((g) => [g.name.toLowerCase(), g]));
    const deadRemoteByName = new Map((remote.tombstones || []).filter((t) => t.kind === "game" && t.name)
      .map((t) => [t.name.toLowerCase(), t]));
    const alias = new Map();
    for (const g of local.games) {
      if (remoteUids.has(g.uid)) continue;
      const twin = remoteByName.get(g.name.toLowerCase());
      if (twin && !localUids.has(twin.uid)) alias.set(g.uid, twin.uid);
    }
    const fix = (uid) => alias.get(uid) || uid;
    const localGames = local.games.map((g) => ({ ...g, uid: fix(g.uid) }));
    const localSessions = local.sessions.map((x) => ({ ...x, game_uid: fix(x.game_uid) }));
    const localTombs = (local.tombstones || []).map((t) => (t.kind === "game" ? { ...t, uid: fix(t.uid) } : { ...t, game_uid: fix(t.game_uid) }));

    // 2. Lápidas: se queda la más reciente de cada clave.
    const tombs = new Map();
    for (const t of [...(remote.tombstones || []), ...localTombs]) {
      const k = tombKey(t);
      if (!tombs.has(k) || String(t.at) > String(tombs.get(k).at)) tombs.set(k, { ...t });
    }

    // 3. Juegos: unión por uid, gana la versión más nueva; una lápida posterior lo borra.
    const games = new Map();
    for (const g of [...clone(remote.games), ...localGames]) {
      if (!games.has(g.uid) || newer(g, games.get(g.uid))) games.set(g.uid, g);
    }
    for (const [uid, g] of games) {
      const t = tombs.get(`g:${uid}`);
      if (t && String(t.at) >= String(g.updated_at || "")) games.delete(uid);
    }
    // Un juego local "de ejemplo" que en la nube se borró (por nombre) tampoco vuelve.
    for (const [uid, g] of games) {
      const t = deadRemoteByName.get(g.name.toLowerCase());
      if (t && !remoteUids.has(uid) && local.pristine) games.delete(uid);
    }

    // 4. Partidas: unión por juego + día, gana la más nueva.
    const sessions = new Map();
    for (const x of [...clone(remote.sessions || []), ...localSessions]) {
      const k = sessionKey(x);
      if (!sessions.has(k) || newer(x, sessions.get(k))) sessions.set(k, x);
    }
    for (const [k, x] of sessions) {
      const t = tombs.get(`s:${k}`);
      if (!games.has(x.game_uid) || (t && String(t.at) >= String(x.updated_at || ""))) sessions.delete(k);
    }

    // 5. Nombres repetidos tras combinar (p. ej. renombres cruzados): se numeran.
    const seen = new Map();
    for (const g of [...games.values()].sort((a, b) => a.uid.localeCompare(b.uid))) {
      const base = g.name.toLowerCase();
      if (seen.has(base)) {
        let n = 2;
        while ([...games.values()].some((o) => o.name.toLowerCase() === `${base} (${n})`)) n++;
        g.name = `${g.name} (${n})`;
      }
      seen.set(g.name.toLowerCase(), true);
    }

    // 6. Las lápidas viejas ya no hacen falta.
    const cutoff = new Date(now - TOMBSTONE_DAYS * 86400e3).toISOString();
    const keptTombs = [...tombs.values()].filter((t) => String(t.at) >= cutoff);

    return {
      app: "dle-tracker",
      format: 2,
      games: [...games.values()].sort((a, b) => a.uid.localeCompare(b.uid)),
      sessions: [...sessions.values()].sort((a, b) => sessionKey(a).localeCompare(sessionKey(b))),
      tombstones: keptTombs.sort((a, b) => tombKey(a).localeCompare(tombKey(b))),
      pristine: false,
    };
  }

  /** Igualdad de contenido (sin importar orden ni la marca `pristine`). */
  function sameData(a, b) {
    if (!a || !b) return false;
    const canon = (p) => JSON.stringify({
      g: [...p.games].sort((x, y) => x.uid.localeCompare(y.uid)),
      s: [...p.sessions].sort((x, y) => sessionKey(x).localeCompare(sessionKey(y))),
      t: [...(p.tombstones || [])].sort((x, y) => tombKey(x).localeCompare(tombKey(y))),
    });
    return canon(a) === canon(b);
  }

  /* ------------------------------------------------------------ GitHub */

  function create({ storage, store, fetchFn = (...a) => fetch(...a), onChange = () => {}, onStatus = () => {} }) {
    let busy = null;
    let timer = null;

    const readConfig = () => {
      try {
        return JSON.parse(storage.getItem(CONFIG_KEY)) || null;
      } catch {
        return null;
      }
    };
    const writeConfig = (cfg) => {
      try {
        if (cfg) storage.setItem(CONFIG_KEY, JSON.stringify(cfg));
        else storage.removeItem(CONFIG_KEY);
      } catch { /* sin almacenamiento */ }
    };

    async function gh(token, path, { method = "GET", body } = {}) {
      let res;
      try {
        res = await fetchFn(API + path, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        });
      } catch {
        throw Object.assign(new Error("Sin conexión con GitHub"), { status: 0 });
      }
      if (res.status === 401) throw Object.assign(new Error("El token no es válido o expiró"), { status: 401 });
      if (res.status === 403 || res.status === 404) {
        const err = new Error(res.status === 404 ? "No se encontró el gist" : "El token no tiene permiso para gists");
        throw Object.assign(err, { status: res.status });
      }
      if (!res.ok) throw Object.assign(new Error(`GitHub respondió ${res.status}`), { status: res.status });
      return res.status === 204 ? null : res.json();
    }

    async function findGist(token) {
      for (let page = 1; page <= 5; page++) {
        const list = await gh(token, `/gists?per_page=100&page=${page}`);
        const hit = list.find((g) => g.files && g.files[FILE]);
        if (hit) return hit.id;
        if (list.length < 100) break;
      }
      return null;
    }

    async function readRemote(cfg) {
      const gist = await gh(cfg.token, `/gists/${cfg.gistId}`);
      const file = gist.files && gist.files[FILE];
      if (!file) return null;
      let content = file.content;
      if (file.truncated && file.raw_url) {
        const res = await fetchFn(file.raw_url, { cache: "no-store" });
        content = await res.text();
      }
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    }

    async function writeRemote(cfg, data) {
      await gh(cfg.token, `/gists/${cfg.gistId}`, {
        method: "PATCH",
        body: { files: { [FILE]: { content: JSON.stringify(data) } } },
      });
    }

    /** Conecta este dispositivo: valida el token y busca (o crea) el gist. */
    async function connect(token) {
      token = String(token || "").trim();
      if (!token) throw new Error("Pega tu token de GitHub");
      const user = await gh(token, "/user");
      let gistId = await findGist(token);
      let created = false;
      if (!gistId) {
        const gist = await gh(token, "/gists", {
          method: "POST",
          body: { description: DESCRIPTION, public: false, files: { [FILE]: { content: JSON.stringify(store.toPortable()) } } },
        });
        gistId = gist.id;
        created = true;
      }
      writeConfig({ token, gistId, login: user.login, lastSync: null, lastError: null });
      const result = await syncNow();
      return { login: user.login, gistId, created, ...result };
    }

    function disconnect() {
      clearTimeout(timer);
      writeConfig(null);
      onStatus(status());
    }

    /** Baja, combina y sube. Devuelve qué cambió. */
    async function syncNow() {
      if (busy) return busy;
      const cfg = readConfig();
      if (!cfg) return { pulled: false, pushed: false };
      busy = (async () => {
        onStatus({ ...status(), syncing: true });
        try {
          let remote;
          try {
            remote = await readRemote(cfg);
          } catch (err) {
            if (err.status !== 404) throw err;
            // Borraron el gist: se vuelve a crear con lo de este dispositivo.
            const gist = await gh(cfg.token, "/gists", {
              method: "POST",
              body: { description: DESCRIPTION, public: false, files: { [FILE]: { content: JSON.stringify(store.toPortable()) } } },
            });
            cfg.gistId = gist.id;
            remote = null;
          }
          const local = store.toPortable();
          const merged = merge(local, remote);
          const pulled = !sameData(merged, local) || local.pristine;
          if (pulled) store.applyPortable(merged);
          const pushed = !sameData(merged, remote);
          if (pushed) await writeRemote(cfg, merged);
          writeConfig({ ...cfg, lastSync: new Date().toISOString(), lastError: null });
          if (pulled) onChange();
          return { pulled, pushed };
        } catch (err) {
          writeConfig({ ...cfg, lastError: err.message });
          throw err;
        } finally {
          busy = null;
          onStatus(status());
        }
      })();
      return busy;
    }

    /** Sincroniza unos segundos después del último cambio local. */
    function schedule(delay = 4000) {
      if (!readConfig()) return;
      clearTimeout(timer);
      timer = setTimeout(() => syncNow().catch(() => {}), delay);
    }

    function status() {
      const cfg = readConfig();
      return cfg
        ? { connected: true, login: cfg.login, gistId: cfg.gistId, lastSync: cfg.lastSync, lastError: cfg.lastError, syncing: !!busy }
        : { connected: false };
    }

    return { connect, disconnect, syncNow, schedule, status };
  }

  return { merge, sameData, create, FILE, TOKEN_URL, CONFIG_KEY };
});
