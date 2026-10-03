"use strict";

/**
 * Datos de la app guardados en localStorage (no hay servidor: funciona en
 * GitHub Pages). Expone `DleStore.create(storage)` con una mini "API REST"
 * (`request(method, path, body)`) que responde lo mismo que respondía el
 * backend FastAPI, para que la interfaz no tenga que cambiar.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./logic.js"));
  else root.DleStore = factory(root.DleLogic);
})(typeof self !== "undefined" ? self : this, function (L) {
  const STORAGE_KEY = "dle-tracker:data";
  const VERSION = 1;
  const METRICS = ["attempts", "score", "time_seconds", "errors"];
  const METRIC_FLAG = { attempts: "track_attempts", score: "track_score", time_seconds: "track_time", errors: "track_errors" };
  const MAX_GAMES = 200;

  const SEED_GAMES = [
    { name: "Wordle", description: "Adivina la palabra de 5 letras en 6 intentos",
      url: "https://www.nytimes.com/games/wordle/index.html", category: "Palabras", icon: "🟩" },
    { name: "Connections", description: "Agrupa 16 palabras en 4 grupos con el mínimo de errores",
      url: "https://www.nytimes.com/games/connections", category: "Palabras", icon: "🟪",
      track_attempts: false, track_errors: true, primary_metric: "errors" },
    { name: "Framed", description: "Adivina la película a partir de fotogramas",
      url: "https://framed.wtf/", category: "Cine", icon: "🎬" },
    { name: "Worldle", description: "Adivina el país por su silueta",
      url: "https://worldle.teuteuf.fr/", category: "Geografía", icon: "🌍" },
    { name: "Globle", description: "Encuentra el país misterioso usando el globo terráqueo",
      url: "https://globle-game.com/", category: "Geografía", icon: "🌐" },
  ];

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  const fail = (status, message) => { throw new ApiError(status, message); };

  /* ------------------------------------------------------------ iconos */

  /**
   * Candidatos de icono para la URL de un juego, de mejor a peor calidad.
   * Sin servidor no se puede leer el HTML de otra web (CORS), así que se
   * prueban como <img>: apple-touch-icon (~180 px), el servicio de favicons de
   * Google en alta resolución y /favicon.ico. La interfaz pasa al siguiente si
   * uno falla y, al final, al emoji.
   */
  function iconCandidates(url) {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return [];
    }
    if (!host) return [];
    return [
      `https://${host}/apple-touch-icon.png`,
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`,
      `https://${host}/favicon.ico`,
    ];
  }

  /* -------------------------------------------------------- validación */

  function cleanText(value, field, max, { required = false } = {}) {
    if (value === undefined || value === null) value = "";
    if (typeof value !== "string") fail(422, `${field} no es válido`);
    value = value.trim();
    if (required && !value) fail(422, `${field} es obligatorio`);
    if (value.length > max) fail(422, `${field} admite como máximo ${max} caracteres`);
    return value;
  }

  function cleanUrl(value) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") fail(422, "La URL no es válida");
    value = value.trim();
    if (!value) return null;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      parsed = null;
    }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || /\s/.test(value)) {
      fail(422, "La URL debe ser válida y comenzar con http:// o https://");
    }
    if (value.length > 500) fail(422, "La URL admite como máximo 500 caracteres");
    return value;
  }

  function cleanBool(value, field) {
    if (typeof value !== "boolean") fail(422, `${field} debe ser verdadero o falso`);
    return value;
  }

  function cleanInt(value, field, max) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "number" || !Number.isInteger(value)) fail(422, `${field} debe ser un número entero`);
    if (value < 0) fail(422, `${field} debe ser mayor o igual a 0`);
    if (value > max) fail(422, `${field} debe ser menor o igual a ${max}`);
    return value;
  }

  function cleanScore(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "number" || !Number.isFinite(value)) fail(422, "Puntaje debe ser un número");
    return value;
  }

  const GAME_DEFAULTS = {
    name: "", description: "", url: null, category: "", icon: "🎮", active: true, favorite: false, days: null,
    track_attempts: true, track_score: false, track_time: false, track_errors: false,
    primary_metric: "attempts", lower_is_better: true,
  };

  /** Aplica `changes` (parciales) sobre `base` validando cada campo. */
  function mergeGame(base, changes) {
    const game = { ...base };
    if ("name" in changes) game.name = cleanText(changes.name, "El nombre", 80, { required: true });
    if ("description" in changes) game.description = cleanText(changes.description, "Descripción", 500);
    if ("category" in changes) game.category = cleanText(changes.category, "Categoría", 50);
    if ("icon" in changes) game.icon = cleanText(changes.icon, "Icono", 16) || "🎮";
    if ("url" in changes) game.url = cleanUrl(changes.url);
    for (const key of ["active", "favorite", "track_attempts", "track_score", "track_time", "track_errors", "lower_is_better"]) {
      if (key in changes && changes[key] !== null) game[key] = cleanBool(changes[key], key);
    }
    if ("days" in changes) {
      const days = changes.days;
      if (days === null || (Array.isArray(days) && (days.length === 0 || days.length === 7))) {
        game.days = null; // todos los días
      } else if (Array.isArray(days) && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
        game.days = [...new Set(days)].sort((a, b) => a - b);
      } else {
        fail(422, "Días debe ser una lista de días de la semana (0 = lunes … 6 = domingo)");
      }
    }
    if ("primary_metric" in changes && changes.primary_metric !== null) {
      if (!METRICS.includes(changes.primary_metric)) fail(422, `Métrica principal debe ser una de: ${METRICS.join(", ")}`);
      game.primary_metric = changes.primary_metric;
    }
    if (!game.name) fail(422, "El nombre es obligatorio");
    if (!game[METRIC_FLAG[game.primary_metric]]) {
      fail(422, "La métrica principal debe estar entre las métricas que registra el juego");
    }
    return game;
  }

  function mergeSession(base, changes, today) {
    const s = { ...base };
    if ("game_id" in changes && changes.game_id !== null) s.game_id = changes.game_id;
    if ("played_at" in changes && changes.played_at !== null) {
      if (!L.isValidISODate(changes.played_at)) fail(422, "Fecha debe ser una fecha válida (AAAA-MM-DD)");
      s.played_at = changes.played_at;
    }
    if ("result" in changes && changes.result !== null) {
      if (!["win", "loss"].includes(changes.result)) fail(422, "Resultado debe ser uno de: 'win', 'loss'");
      s.result = changes.result;
    }
    if ("attempts" in changes) s.attempts = cleanInt(changes.attempts, "Intentos", 1000);
    if ("errors" in changes) s.errors = cleanInt(changes.errors, "Errores", 1000);
    if ("time_seconds" in changes) s.time_seconds = cleanInt(changes.time_seconds, "Tiempo", 86400);
    if ("score" in changes) s.score = cleanScore(changes.score);
    if ("notes" in changes && changes.notes !== null) s.notes = cleanText(changes.notes, "Notas", 1000);
    if (!s.played_at) fail(422, "Fecha es obligatorio");
    if (!s.result) fail(422, "Resultado es obligatorio");
    if (s.played_at > today) fail(422, "La fecha no puede estar en el futuro");
    return s;
  }

  /* ------------------------------------------------------------- store */

  function emptyData() {
    return { version: VERSION, seq: { game: 0, session: 0 }, games: [], sessions: [], tombstones: [] };
  }

  function nowISO() {
    return new Date().toISOString().slice(0, 19);
  }

  /** Marca de tiempo completa (UTC, con milisegundos) para resolver conflictos al sincronizar. */
  function stamp() {
    return new Date().toISOString();
  }

  /** Identificador estable de un juego entre dispositivos. */
  function newUid() {
    const bytes = new Uint8Array(9);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
  }

  /** Completa campos de versiones anteriores. Devuelve true si cambió algo. */
  function normalize(data) {
    let changed = false;
    if (!Array.isArray(data.tombstones)) { data.tombstones = []; changed = true; }
    for (const g of data.games) {
      g.favorite = g.favorite === true;
      if (!Array.isArray(g.days)) g.days = null;
      if (!g.uid) { g.uid = newUid(); changed = true; }
      if (!g.updated_at) { g.updated_at = `${g.created_at || "1970-01-01T00:00:00"}Z`.replace(/ZZ$/, "Z"); changed = true; }
    }
    for (const x of data.sessions) {
      if (!x.updated_at) { x.updated_at = `${x.created_at || "1970-01-01T00:00:00"}Z`.replace(/ZZ$/, "Z"); changed = true; }
    }
    return changed;
  }

  /**
   * @param storage objeto con getItem/setItem/removeItem (localStorage o uno en memoria)
   * @param options.seed crear los juegos de ejemplo la primera vez (por defecto, sí)
   * @param options.today función que devuelve la fecha de hoy (ISO)
   */
  function create(storage, { seed = true, today = () => L.localToday() } = {}) {
    let data = null;
    data = load();

    function load() {
      let raw = null;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch {
        raw = null;
      }
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.games) && Array.isArray(parsed.sessions)) {
            // Campos añadidos en versiones posteriores (uid, updated_at…): se guardan
            // enseguida para que el uid no cambie en cada carga.
            if (normalize(parsed)) save(parsed);
            return parsed;
          }
        } catch {
          /* datos corruptos: se empieza de cero sin pisar lo guardado hasta el primer cambio */
        }
      }
      const fresh = emptyData();
      if (seed && raw === null) {
        for (const g of SEED_GAMES) {
          const game = { ...GAME_DEFAULTS, ...g, id: ++fresh.seq.game, uid: newUid(), created_at: nowISO(), updated_at: stamp() };
          game.icon_url = iconCandidates(game.url)[0] || null;
          fresh.games.push(game);
        }
        // Datos recién creados: al conectar la sincronización se reemplazan por los de la nube.
        fresh.pristine = true;
        save(fresh);
      }
      return fresh;
    }

    function save(value = data) {
      if (value === data) data.pristine = false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch (err) {
        fail(507, "No se pudo guardar en este navegador (¿almacenamiento lleno o modo privado?)");
      }
    }

    const sortedGames = () => [...data.games].sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
    const gameOr404 = (id) => data.games.find((g) => g.id === Number(id)) || fail(404, "Juego no encontrado");
    const sessionOr404 = (id) => data.sessions.find((s) => s.id === Number(id)) || fail(404, "Partida no encontrada");
    const sessionsOf = (gameId) => data.sessions.filter((s) => s.game_id === gameId);

    function checkUniqueName(game) {
      const clash = data.games.find((g) => g.id !== game.id && g.name.toLowerCase() === game.name.toLowerCase());
      if (clash) fail(409, `Ya existe un juego llamado «${game.name}»`);
    }

    function checkUniqueDay(session) {
      const clash = data.sessions.find((s) => s.id !== session.id && s.game_id === session.game_id && s.played_at === session.played_at);
      if (clash) fail(409, "Ya registraste una partida de este juego en esa fecha. Edítala desde el historial.");
    }

    /* --------------------------------------------------------- juegos */

    function createGame(body) {
      if (data.games.length >= MAX_GAMES) fail(422, `Máximo ${MAX_GAMES} juegos`);
      const game = mergeGame(GAME_DEFAULTS, body || {});
      game.id = data.seq.game + 1;
      game.uid = newUid();
      game.created_at = nowISO();
      game.updated_at = stamp();
      game.icon_url = iconCandidates(game.url)[0] || null;
      checkUniqueName(game);
      data.seq.game = game.id;
      data.games.push(game);
      save();
      return game;
    }

    function updateGame(id, body) {
      const current = gameOr404(id);
      const game = mergeGame(current, body || {});
      checkUniqueName(game);
      // El icono dependía de la URL anterior.
      if (game.url !== current.url) game.icon_url = iconCandidates(game.url)[0] || null;
      game.updated_at = stamp();
      Object.assign(current, game);
      save();
      return current;
    }

    function deleteGame(id) {
      const game = gameOr404(id);
      data.games = data.games.filter((g) => g !== game);
      data.sessions = data.sessions.filter((s) => s.game_id !== game.id);
      data.tombstones.push({ kind: "game", uid: game.uid, name: game.name, at: stamp() });
      save();
      return null;
    }

    function sessionTombstone(session) {
      const game = data.games.find((g) => g.id === session.game_id);
      if (game) data.tombstones.push({ kind: "session", game_uid: game.uid, played_at: session.played_at, at: stamp() });
    }

    /* -------------------------------------------------------- partidas */

    function listSessions(q) {
      let list = data.sessions;
      if (q.get("game_id")) list = list.filter((s) => s.game_id === Number(q.get("game_id")));
      if (q.get("result")) list = list.filter((s) => s.result === q.get("result"));
      if (q.get("date_from")) list = list.filter((s) => s.played_at >= q.get("date_from"));
      if (q.get("date_to")) list = list.filter((s) => s.played_at <= q.get("date_to"));
      const asc = q.get("order") === "asc";
      list = [...list].sort((a, b) => {
        const cmp = a.played_at < b.played_at ? -1 : a.played_at > b.played_at ? 1 : a.id - b.id;
        return asc ? cmp : -cmp;
      });
      if (q.get("limit")) list = list.slice(0, Math.max(Number(q.get("limit")) || 0, 0));
      return list.map((s) => ({ ...s }));
    }

    function createSession(body) {
      body = body || {};
      gameOr404(body.game_id);
      const base = { game_id: Number(body.game_id), played_at: null, result: null,
        score: null, attempts: null, errors: null, time_seconds: null, notes: "" };
      const session = mergeSession(base, body, today());
      session.id = data.seq.session + 1;
      session.created_at = nowISO();
      session.updated_at = stamp();
      checkUniqueDay(session);
      data.seq.session = session.id;
      data.sessions.push(session);
      save();
      return { ...session };
    }

    function updateSession(id, body) {
      const current = sessionOr404(id);
      body = body || {};
      if (body.game_id !== undefined && body.game_id !== null) gameOr404(body.game_id);
      const session = mergeSession(current, body, today());
      session.game_id = Number(session.game_id);
      checkUniqueDay(session);
      // Si cambia el juego o la fecha, la "clave" anterior deja de existir en los otros dispositivos.
      if (session.game_id !== current.game_id || session.played_at !== current.played_at) sessionTombstone(current);
      session.updated_at = stamp();
      Object.assign(current, session);
      save();
      return { ...current };
    }

    function deleteSession(id) {
      const session = sessionOr404(id);
      data.sessions = data.sessions.filter((s) => s !== session);
      sessionTombstone(session);
      save();
      return null;
    }

    /* ------------------------------------------------- copia de seguridad */

    function exportData() {
      return {
        app: "dle-tracker",
        version: VERSION,
        exported_at: today(),
        games: sortedGames().map((g) => ({ ...g })),
        sessions: [...data.sessions].sort((a, b) => (a.played_at < b.played_at ? -1 : 1)).map((s) => ({ ...s })),
      };
    }

    /**
     * Reemplaza todos los datos por los de una copia exportada (de esta app o
     * de la versión con servidor). Valida cada registro antes de tocar nada.
     */
    function importData(payload) {
      if (!payload || !Array.isArray(payload.games) || !Array.isArray(payload.sessions)) {
        fail(422, "El archivo no es una copia de seguridad de DLE Tracker");
      }
      const next = emptyData();
      const idMap = new Map();
      for (const raw of payload.games) {
        const fields = {};
        for (const key of Object.keys(GAME_DEFAULTS)) if (key in raw) fields[key] = raw[key];
        let game;
        try {
          game = mergeGame(GAME_DEFAULTS, fields);
        } catch (err) {
          fail(422, `Juego «${raw.name ?? "?"}»: ${err.message}`);
        }
        if (next.games.some((g) => g.name.toLowerCase() === game.name.toLowerCase())) {
          fail(422, `Juego repetido en el archivo: «${game.name}»`);
        }
        game.id = ++next.seq.game;
        game.uid = typeof raw.uid === "string" && raw.uid ? raw.uid : newUid();
        game.created_at = typeof raw.created_at === "string" ? raw.created_at : nowISO();
        game.updated_at = stamp();
        // Las URLs de icono del servidor (/api/...) no sirven aquí: se recalculan.
        game.icon_url = typeof raw.icon_url === "string" && /^https:\/\//.test(raw.icon_url)
          ? raw.icon_url : iconCandidates(game.url)[0] || null;
        idMap.set(raw.id, game.id);
        next.games.push(game);
      }
      const seen = new Set();
      for (const raw of payload.sessions) {
        const gameId = idMap.get(raw.game_id);
        if (gameId === undefined) fail(422, `Partida del ${raw.played_at ?? "?"} sin juego asociado`);
        const fields = {};
        for (const key of ["played_at", "result", "score", "attempts", "errors", "time_seconds", "notes"]) {
          if (key in raw) fields[key] = raw[key];
        }
        let session;
        try {
          session = mergeSession({ game_id: gameId, notes: "", score: null, attempts: null, errors: null, time_seconds: null }, fields, "9999-12-31");
        } catch (err) {
          fail(422, `Partida del ${raw.played_at ?? "?"}: ${err.message}`);
        }
        const key = `${gameId}|${session.played_at}`;
        if (seen.has(key)) continue; // duplicada: se conserva la primera
        seen.add(key);
        session.id = ++next.seq.session;
        session.created_at = typeof raw.created_at === "string" ? raw.created_at : nowISO();
        session.updated_at = stamp();
        next.sessions.push(session);
      }
      save(next);
      data = next;
      return { games: next.games.length, sessions: next.sessions.length };
    }

    /* ---------------------------------------------------- sincronización */

    /**
     * Formato que se sube a la nube: sin ids locales; las partidas apuntan al
     * `uid` del juego. Así dos dispositivos pueden combinar sus datos.
     */
    function toPortable() {
      const uidOf = new Map(data.games.map((g) => [g.id, g.uid]));
      return {
        app: "dle-tracker",
        format: 2,
        games: data.games.map(({ id, ...g }) => ({ ...g })),
        sessions: data.sessions.map(({ id, game_id, ...x }) => ({ ...x, game_uid: uidOf.get(game_id) })).filter((x) => x.game_uid),
        tombstones: data.tombstones.map((t) => ({ ...t })),
        pristine: data.pristine === true,
      };
    }

    /** Reemplaza los datos locales por un estado combinado, conservando los ids locales. */
    function applyPortable(p) {
      const next = emptyData();
      next.seq = { ...data.seq };
      const localGame = new Map(data.games.map((g) => [g.uid, g]));
      const idOfUid = new Map();
      for (const raw of p.games) {
        const id = localGame.get(raw.uid)?.id ?? ++next.seq.game;
        idOfUid.set(raw.uid, id);
        next.games.push({ ...GAME_DEFAULTS, ...raw, id });
      }
      const localSession = new Map(data.sessions.map((x) => [`${data.games.find((g) => g.id === x.game_id)?.uid}|${x.played_at}`, x]));
      for (const raw of p.sessions) {
        const gameId = idOfUid.get(raw.game_uid);
        if (gameId === undefined) continue;
        const { game_uid, ...rest } = raw;
        const id = localSession.get(`${game_uid}|${raw.played_at}`)?.id ?? ++next.seq.session;
        next.sessions.push({ ...rest, id, game_id: gameId });
      }
      next.tombstones = (p.tombstones || []).map((t) => ({ ...t }));
      next.pristine = false;
      data = next;
      save();
      return { games: next.games.length, sessions: next.sessions.length };
    }

    function reset() {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch { /* nada que borrar */ }
      data = load();
      return { games: data.games.length, sessions: 0 };
    }

    /* ----------------------------------------------------- mini router */

    function request(method, path, body) {
      const url = new URL(path, "http://local");
      const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
      const q = url.searchParams;
      const [a, b, c] = parts;
      const t = today();
      method = method.toUpperCase();

      if (a === "games") {
        if (!b) {
          if (method === "GET") return sortedGames().map((g) => ({ ...g }));
          if (method === "POST") return { ...createGame(body) };
        } else if (b === "icons" && c === "fetch-missing" && method === "POST") {
          const updated = [];
          for (const g of sortedGames()) {
            if (g.url && !g.icon_url) {
              g.icon_url = iconCandidates(g.url)[0];
              updated.push(g.name);
            }
          }
          save();
          return { updated, failed: [] };
        } else if (c === "icon") {
          const game = gameOr404(b);
          if (method === "POST") {
            if (!game.url) fail(422, "El juego no tiene URL de la que obtener el icono");
            game.icon_url = iconCandidates(game.url)[0];
          } else if (method === "DELETE") {
            game.icon_url = null;
          } else fail(405, "Método no permitido");
          save();
          return { ...game };
        } else if (!c) {
          if (method === "GET") return { ...gameOr404(b) };
          if (method === "PUT") return { ...updateGame(b, body) };
          if (method === "DELETE") return deleteGame(b);
        }
      } else if (a === "sessions") {
        if (!b) {
          if (method === "GET") return listSessions(q);
          if (method === "POST") return createSession(body);
        } else {
          if (method === "GET") return { ...sessionOr404(b) };
          if (method === "PUT") return updateSession(b, body);
          if (method === "DELETE") return deleteSession(b);
        }
      } else if (a === "stats" && method === "GET") {
        if (!b) return L.overview(sortedGames(), data.sessions, t);
        const game = gameOr404(b);
        return L.gameStats(game, sessionsOf(game.id), t);
      } else if (a === "streaks" && method === "GET") {
        return {
          overall: L.streaks(data.sessions.map((s) => s.played_at), t),
          games: sortedGames().map((g) => ({ game_id: g.id, ...L.streaks(sessionsOf(g.id).map((s) => s.played_at), t) })),
        };
      } else if (a === "calendar" && method === "GET") {
        const year = Number(q.get("year"));
        const month = Number(q.get("month"));
        if (!(month >= 1 && month <= 12) || !(year >= 1970 && year <= 9999)) fail(422, "Mes o año inválido");
        return { year, month, days: L.calendarMonth(data.sessions, year, month) };
      } else if (a === "export" && method === "GET") {
        return exportData();
      } else if (a === "import" && method === "POST") {
        return importData(body);
      } else if (a === "reset" && method === "POST") {
        return reset();
      }
      fail(404, "Ruta no encontrada");
    }

    return { request, exportData, importData, reset, iconCandidates, toPortable, applyPortable };
  }

  /** Almacenamiento en memoria, por si localStorage no está disponible. */
  function memoryStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  }

  return { create, memoryStorage, iconCandidates, ApiError, STORAGE_KEY, SEED_GAMES };
});
