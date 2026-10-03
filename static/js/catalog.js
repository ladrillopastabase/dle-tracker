"use strict";

/**
 * Catálogo para "descubrir" juegos: el listado público de dles.aukspot.com
 * (https://github.com/aukspot/dles, GPL-3.0). No se copia en este repositorio:
 * el navegador lo descarga de GitHub y lo guarda en caché (localStorage) un día,
 * así que siempre está al día y sigue funcionando sin conexión.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DleCatalog = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const BASE = "https://raw.githubusercontent.com/aukspot/dles/main/src/lib/data/";
  const SOURCES = { games: "dles.json", fresh: "new_dles.json", weekly: "dles_of_the_week.json" };
  const CACHE_KEY = "dle-tracker:catalog";
  const TTL_MS = 24 * 3600 * 1000;
  const SITE = "https://dles.aukspot.com/";

  const CATEGORIES = {
    "Words": ["Palabras", "🔤"],
    "Video Games": ["Videojuegos", "🎮"],
    "Math/Logic": ["Lógica y números", "🧮"],
    "Geography": ["Geografía", "🌍"],
    "Movies/TV": ["Cine y TV", "🎬"],
    "Miscellaneous": ["Varios", "🎲"],
    "Music": ["Música", "🎵"],
    "Trivia": ["Trivia", "❓"],
    "Shapes/Patterns": ["Formas y patrones", "🔷"],
    "Estimation": ["Estimación", "📏"],
    "Sports": ["Deportes", "⚽"],
    "Card/Board Games": ["Cartas y tablero", "🃏"],
    "History": ["Historia", "📜"],
    "Science/Nature": ["Ciencia y naturaleza", "🔬"],
    "Colors": ["Colores", "🎨"],
    "Novelty": ["Curiosidades", "✨"],
    "Food": ["Comida", "🍔"],
    "Vehicles": ["Vehículos", "🚗"],
  };

  function categoryInfo(key) {
    const [label, icon] = CATEGORIES[key] || [key || "Varios", "🎲"];
    return { key: key || "Miscellaneous", label, icon };
  }

  /** Clave para comparar URLs: dominio sin www + ruta sin barra final ni #/?. */
  function urlKey(url) {
    try {
      const u = new URL(url);
      return (u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase();
    } catch {
      return "";
    }
  }

  /** Convierte los JSON del repositorio en el formato que usa la app. */
  function normalize(rawGames, rawFresh, rawWeekly) {
    const games = (Array.isArray(rawGames) ? rawGames : [])
      .filter((g) => g && typeof g.name === "string" && typeof g.url === "string" && /^https?:\/\//.test(g.url))
      .map((g) => {
        const cat = categoryInfo(g.category);
        return {
          id: g.id,
          name: g.name.slice(0, 80),
          url: g.url,
          description: typeof g.description === "string" ? g.description.slice(0, 500) : "",
          category: cat.key,
          themes: Array.isArray(g.themes) ? g.themes.filter((t) => typeof t === "string") : [],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const known = new Set(games.map((g) => g.id));
    const fresh = (Array.isArray(rawFresh) ? rawFresh : [])
      .filter((g) => known.has(g.id))
      .sort((a, b) => String(b.date_added).localeCompare(String(a.date_added)))
      .map((g) => ({ id: g.id, date_added: g.date_added }));
    const latestWeek = (Array.isArray(rawWeekly) ? rawWeekly : [])
      .filter((w) => w && Array.isArray(w.dle_ids))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const weekly = latestWeek ? { date: latestWeek.date, ids: latestWeek.dle_ids.filter((id) => known.has(id)) } : null;
    return { games, fresh, weekly };
  }

  function readCache(storage) {
    try {
      const cached = JSON.parse(storage.getItem(CACHE_KEY));
      if (cached && Array.isArray(cached.games) && cached.games.length) return cached;
    } catch { /* sin caché */ }
    return null;
  }

  /**
   * Devuelve el catálogo: de la caché si es reciente; si no, lo descarga.
   * Si la descarga falla y hay caché (aunque sea vieja), usa la caché.
   */
  async function load(storage, { force = false, fetchFn = fetch, now = Date.now() } = {}) {
    const cached = readCache(storage);
    if (cached && !force && now - cached.fetched_at < TTL_MS) return { ...cached, from: "cache" };
    try {
      const get = async (file) => {
        const res = await fetchFn(BASE + file, { cache: "no-cache" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      const [games, fresh, weekly] = await Promise.all([
        get(SOURCES.games),
        get(SOURCES.fresh).catch(() => []),
        get(SOURCES.weekly).catch(() => []),
      ]);
      const catalog = { ...normalize(games, fresh, weekly), fetched_at: now };
      if (!catalog.games.length) throw new Error("catálogo vacío");
      try {
        storage.setItem(CACHE_KEY, JSON.stringify(catalog));
      } catch { /* sin espacio: se usa igual */ }
      return { ...catalog, from: "network" };
    } catch (err) {
      if (cached) return { ...cached, from: "stale", error: err.message };
      throw new Error("No se pudo descargar el catálogo. Revisa tu conexión e inténtalo de nuevo.");
    }
  }

  /** Datos para crear un juego propio a partir de una entrada del catálogo. */
  function toGame(entry) {
    const cat = categoryInfo(entry.category);
    return {
      name: entry.name,
      url: entry.url,
      description: entry.description,
      category: cat.label,
      icon: cat.icon,
    };
  }

  return { load, normalize, urlKey, categoryInfo, toGame, CATEGORIES, CACHE_KEY, SITE, BASE };
});
