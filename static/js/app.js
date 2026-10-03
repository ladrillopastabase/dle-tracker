"use strict";

/* ================================================================ utilidades */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const METRICS = {
  attempts: { label: "intentos", flag: "track_attempts", quick: [1, 2, 3, 4, 5, 6] },
  errors: { label: "errores", flag: "track_errors", quick: [0, 1, 2, 3, 4] },
  score: { label: "puntaje", flag: "track_score" },
  time_seconds: { label: "tiempo", flag: "track_time" },
};
const RESULT_LABEL = { win: "victoria", loss: "derrota" };
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const ROUTE_PATH = {
  dashboard: "~", games: "~/juegos", game: "~/juegos", discover: "~/descubrir", roulette: "~/ruleta",
  history: "~/historial", stats: "~/stats", calendar: "~/calendario", settings: "~/.config",
};
const NAV_ORDER = ["dashboard", "games", "discover", "roulette", "history", "stats", "calendar", "settings"];
const SORTS = {
  pending: "pendientes primero",
  favorites: "favoritos primero",
  name: "nombre",
  streak: "racha más larga",
};
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  games: [],
  overview: null,
  today: localISO(new Date()),
  charts: [],
  route: "dashboard",
  history: { game_id: "", result: "", date_from: "", date_to: "", order: "desc" },
  calendar: null, // {year, month, selected}
  roulette: { pool: "pending", spinning: false, autoSpin: false, log: [], result: null },
  discover: { q: "", cat: "", hideAdded: true, limit: 48, suggestion: null, catalog: null, focus: false },
};

function localISO(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISO(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return localISO(d);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDate(iso, { relative = true } = {}) {
  if (!iso) return "—";
  if (relative && iso === state.today) return "hoy";
  if (relative && iso === addDays(state.today, -1)) return "ayer";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtTime(seconds) {
  if (seconds == null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function fmtNum(v, digits = 2) {
  if (v == null) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(digits).replace(/\.?0+$/, "");
}

function fmtMetric(metric, v) {
  if (v == null) return "—";
  return metric === "time_seconds" ? fmtTime(Math.round(v)) : fmtNum(v);
}

/** "1:23", "1:02:03" o "83" → segundos. Devuelve NaN si no es válido. */
function parseTime(text) {
  const parts = text.trim().split(":");
  if (parts.some((p) => !/^\d+$/.test(p)) || parts.length > 3) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function pct(v) {
  return v == null ? "—" : `${fmtNum(v, 1)}%`;
}

function gameById(id) {
  return state.games.find((g) => g.id === Number(id));
}

function slug(name) {
  return String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function trackedMetrics(game) {
  return Object.keys(METRICS).filter((m) => game[METRICS[m].flag]);
}

function sessionSummary(game, s) {
  return trackedMetrics(game)
    .filter((m) => s[m] != null)
    .map((m) => `${fmtMetric(m, s[m])} ${METRICS[m].label}`)
    .join(" · ");
}

function resultTag(result, { label = true } = {}) {
  const tag = result === "win" ? "[ OK ]" : "[FAIL]";
  return `<span class="tag ${result}">${tag}</span>${label ? ` ${RESULT_LABEL[result]}` : ""}`;
}

function asciiBar(value, max, width = 16) {
  const filled = max ? Math.round((Math.min(value, max) / max) * width) : 0;
  return `<span class="bar" aria-hidden="true">${"█".repeat(filled)}<span class="rest">${"░".repeat(width - filled)}</span></span>`;
}

/** Candidatos de icono que quedan por probar después de `game.icon_url`. */
function iconFallbacks(game) {
  const all = DleStore.iconCandidates(game.url || "");
  const i = all.indexOf(game.icon_url);
  return i >= 0 ? all.slice(i + 1) : [];
}

/** Icono del juego: el de su web (con alternativas si falla) o, si no hay, su emoji. */
function gicon(game, cls = "") {
  if (!game) return "";
  if (game.icon_url) {
    return `<img class="gicon ${cls}" src="${esc(game.icon_url)}" alt="" data-emoji="${esc(game.icon)}"
      data-fallbacks="${esc(iconFallbacks(game).join(" "))}" referrerpolicy="no-referrer" loading="lazy" decoding="async">`;
  }
  return `<span class="gicon-emoji ${cls}" aria-hidden="true">${esc(game.icon)}</span>`;
}

// Si un icono no carga, se prueba el siguiente candidato y, al final, el emoji.
document.addEventListener("error", (e) => {
  const el = e.target;
  const isImg = el instanceof HTMLImageElement && el.classList.contains("gicon");
  const isSvgImage = el instanceof SVGImageElement && el.dataset.fallbacks !== undefined;
  if (!isImg && !isSvgImage) return;
  const [next, ...rest] = (el.dataset.fallbacks || "").split(" ").filter(Boolean);
  if (next) {
    el.dataset.fallbacks = rest.join(" ");
    el.setAttribute(isImg ? "src" : "href", next);
  } else if (isImg) {
    const span = document.createElement("span");
    span.className = el.className.replace("gicon", "gicon-emoji");
    span.textContent = el.dataset.emoji || "🎮";
    el.replaceWith(span);
  } else {
    el.remove();
  }
}, true);

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function userName() {
  try { return localStorage.getItem("dle-user") || "player"; } catch { return "player"; }
}

/* ================================================================ jugando ahora */

/* Al pulsar «jugar», el juego se abre en otra pestaña y la app queda
   esperando: al volver a esta pestaña se abre el registro de ese juego. */

function loadPlaying() {
  try {
    const list = JSON.parse(localStorage.getItem("dle-playing")) || [];
    // Solo cuenta lo empezado en las últimas 12 horas.
    return list.filter((p) => Date.now() - p.started < 12 * 3600e3 && gameById(p.id));
  } catch {
    return [];
  }
}

function savePlaying(list) {
  writePref("dle-playing", list.length ? JSON.stringify(list) : null);
  renderPlayingBar();
}

function isPlaying(id) {
  return loadPlaying().some((p) => p.id === Number(id));
}

function playingSince(id) {
  return loadPlaying().find((p) => p.id === Number(id))?.started ?? null;
}

function startPlaying(id) {
  const list = loadPlaying().filter((p) => p.id !== Number(id));
  list.unshift({ id: Number(id), started: Date.now(), prompted: false });
  savePlaying(list);
}

function stopPlaying(id) {
  savePlaying(loadPlaying().filter((p) => p.id !== Number(id)));
}

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return fmtTime(s);
}

function renderPlayingBar() {
  const bar = $("#playing-bar");
  const list = loadPlaying();
  bar.hidden = !list.length;
  if (!list.length) {
    bar.innerHTML = "";
    return;
  }
  bar.innerHTML = `<span class="pb-label">▶ jugando</span>${list.map((p) => {
    const g = gameById(p.id);
    return `<span class="pb-item">${gicon(g)} ${esc(g.name)} <span class="pb-time num" data-since="${p.started}">${elapsed(Date.now() - p.started)}</span>
      <button class="btn primary" data-log="${g.id}">⏎ anotar</button>
      <button class="icon-btn" data-stop-playing="${g.id}" title="Dejar de esperar" aria-label="Dejar de esperar ${esc(g.name)}">[x]</button></span>`;
  }).join("")}`;
}

setInterval(() => {
  $$("#playing-bar .pb-time").forEach((el) => { el.textContent = elapsed(Date.now() - Number(el.dataset.since)); });
  const hint = $("#elapsed-hint [data-since]");
  if (hint) hint.textContent = elapsed(Date.now() - Number(hint.dataset.since));
}, 1000);

/** Al volver a la pestaña, abre el registro del último juego que abriste (una vez). */
function promptPlaying() {
  if (document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
  const list = loadPlaying();
  const next = list.find((p) => !p.prompted && Date.now() - p.started > 4000);
  if (!next) return;
  next.prompted = true;
  savePlaying(list);
  openSessionForm({ gameId: next.id, fromPlay: true }).catch((err) => toast(err.message, "error"));
}

document.addEventListener("visibilitychange", promptPlaying);
window.addEventListener("focus", promptPlaying);

/* ================================================================ piezas de UI */

/** Cabecera de página con línea de prompt: player@dle:~/ruta$ comando */
function pageHead({ cmd, title, sub = "", actions = "" }) {
  return `
    <div class="page-head">
      <div>
        <div class="prompt"><span class="u">${esc(userName())}@dle</span>:<span class="p">${ROUTE_PATH[state.route]}</span>$ <span class="cmd">${esc(cmd)}</span><span class="cursor" aria-hidden="true"></span></div>
        <h1>${title}</h1>
        ${sub ? `<p>${sub}</p>` : ""}
      </div>
      ${actions ? `<div class="card-actions">${actions}</div>` : ""}
    </div>`;
}

function pane(title, body, { aside = "", cls = "", tag = "section" } = {}) {
  return `<${tag} class="pane ${cls}">${title ? `<span class="pane-title">${title}</span>` : ""}${aside ? `<span class="pane-aside">${aside}</span>` : ""}${body}</${tag}>`;
}

function kv(pairs) {
  return `<dl class="kv">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

/** Escribe el texto letra a letra, como una terminal. */
function typewrite(el) {
  if (!el) return;
  const text = el.dataset.text || "";
  if (REDUCED_MOTION.matches) { el.textContent = text; return; }
  el.textContent = "";
  let i = 0;
  const tick = () => {
    if (!el.isConnected) return;
    el.textContent = text.slice(0, ++i);
    if (i < text.length) setTimeout(tick, 18);
  };
  tick();
}

/* ================================================================ API */

/* Los datos viven en localStorage (store.js). Si el navegador no lo permite
   (p. ej. modo privado estricto), se usa memoria y se avisa. */
const STORAGE = (() => {
  try {
    const probe = "dle-tracker:probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    setTimeout(() => toast("Este navegador no permite guardar datos: se perderán al cerrar la pestaña.", "error"), 500);
    return DleStore.memoryStorage();
  }
})();
const store = DleStore.create(STORAGE);

/** Misma interfaz que la antigua API REST, pero resuelta en el navegador. */
async function api(path, options = {}) {
  try {
    return store.request(options.method || "GET", path, options.body);
  } catch (err) {
    throw new Error(err.message);
  }
}

async function loadGames() {
  state.games = await api("/api/games");
}

async function loadOverview() {
  state.overview = await api("/api/stats");
  state.today = state.overview.today;
  updateStatusBar();
  return state.overview;
}

/* ================================================================ UI genérica */

/** Aviso breve; `action` = { label, run } añade un botón (p. ej. «deshacer»). */
function toast(message, type = "info", action = null) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "btn toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.remove();
      action.run();
    });
    el.append(" ", btn);
  }
  $("#toasts").append(el);
  setTimeout(() => el.remove(), action ? 7000 : type === "error" ? 5000 : 2500);
}

function confirmDialog(title, text, okLabel = "eliminar") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  dialog.querySelector('button[value="ok"]').textContent = okLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

function showFormError(form, message) {
  const box = $(".form-error", form);
  box.textContent = message || "";
  box.hidden = !message;
}

document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) closer.closest("dialog").close();
});

function updateStatusBar() {
  const now = new Date();
  const hhmm = now.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const o = state.overview;
  $("#status-right").textContent = o
    ? `racha ${o.current_streak}d | hoy ${o.played_today}/${o.today_total} | ${hhmm}`
    : hhmm;
  $("#clock").textContent = `${state.today} ${hhmm}`;
}
setInterval(updateStatusBar, 30000);

/* ================================================================ gráficos */

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

function chartTheme() {
  if (!window.Chart) return;
  Chart.defaults.font.family = cssVar("--font");
  Chart.defaults.font.size = 11;
  Chart.defaults.color = cssVar("--text-2");
  Chart.defaults.borderColor = cssVar("--line");
  const tip = Chart.defaults.plugins.tooltip;
  tip.backgroundColor = cssVar("--bg");
  tip.borderColor = cssVar("--accent");
  tip.borderWidth = 1;
  tip.titleColor = cssVar("--accent");
  tip.bodyColor = cssVar("--text");
  tip.padding = 8;
  tip.cornerRadius = 0;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxHeight = 7;
  Chart.defaults.maintainAspectRatio = false;
}

function makeChart(canvas, config) {
  if (!window.Chart || !canvas) {
    if (canvas) canvas.parentElement.innerHTML = '<p class="empty">gráficos no disponibles</p>';
    return null;
  }
  chartTheme();
  const chart = new Chart(canvas, config);
  state.charts.push(chart);
  return chart;
}

/** Media móvil de `n` puntos, para ver la tendencia sin el ruido diario. */
function movingAverage(values, n = 7) {
  return values.map((_, i) => {
    const win = values.slice(Math.max(0, i - n + 1), i + 1).filter((v) => v != null);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
}

function evolutionChart(canvas, stats) {
  const points = stats.timeline.filter((p) => p.value != null);
  if (!points.length) {
    canvas.parentElement.innerHTML = '<p class="empty">aún no hay datos de la métrica principal</p>';
    return;
  }
  const metric = stats.primary_metric;
  const values = points.map((p) => p.value);
  const win = cssVar("--win");
  const loss = cssVar("--loss");
  makeChart(canvas, {
    type: "line",
    data: {
      labels: points.map((p) => fmtDate(p.date, { relative: false })),
      datasets: [
        {
          label: METRICS[metric].label,
          data: values,
          borderColor: cssVar("--accent"),
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointStyle: "rect",
          pointBackgroundColor: points.map((p) => (p.result === "win" ? win : loss)),
          pointBorderColor: cssVar("--surface"),
          pointBorderWidth: 2,
          stepped: false,
          cubicInterpolationMode: "monotone",
        },
        {
          label: "media móvil (7)",
          data: movingAverage(values),
          borderColor: cssVar("--muted"),
          borderDash: [4, 4],
          borderWidth: 2,
          pointRadius: 0,
          cubicInterpolationMode: "monotone",
        },
      ],
    },
    options: {
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          ticks: { callback: (v) => fmtMetric(metric, v), precision: 0 },
          title: { display: true, text: `${METRICS[metric].label} (${stats.lower_is_better ? "menor es mejor" : "mayor es mejor"})` },
        },
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtMetric(metric, ctx.parsed.y)}`,
            afterBody: (items) => {
              const p = points[items[0].dataIndex];
              return p ? `resultado: ${RESULT_LABEL[p.result]}` : "";
            },
          },
        },
      },
    },
  });
}

function distributionChart(canvas, stats) {
  if (!stats.distribution?.length) {
    canvas.parentElement.innerHTML = '<p class="empty">sin distribución para esta métrica</p>';
    return;
  }
  makeChart(canvas, {
    type: "bar",
    data: {
      labels: stats.distribution.map((d) => d.value),
      datasets: [{
        label: "partidas",
        data: stats.distribution.map((d) => d.count),
        backgroundColor: cssVar("--accent"),
        maxBarThickness: 32,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { precision: 0 } },
        x: { grid: { display: false }, title: { display: true, text: METRICS[stats.primary_metric].label } },
      },
    },
  });
}

/* ================================================================ router */

const routes = {
  dashboard: renderDashboard,
  games: renderGames,
  game: renderGame,
  discover: renderDiscover,
  roulette: renderRoulette,
  history: renderHistory,
  stats: renderStats,
  calendar: renderCalendar,
  settings: renderSettings,
};
const afterRender = {};

async function router() {
  let [name = "dashboard", param] = location.hash.replace(/^#\/?/, "").split("/");
  if (!routes[name]) name = "dashboard";
  state.route = name;
  const navName = name === "game" ? "games" : name;
  $$("[data-route]").forEach((a) => {
    const active = a.dataset.route === navName;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  destroyCharts();
  const view = $("#view");
  $("#titlebar-text").textContent = `${userName()}@dle: ${ROUTE_PATH[name]}`;
  try {
    await loadGames();
    renderPlayingBar();
    const html = await routes[name](param);
    view.innerHTML = `<div class="view">${html}</div>`;
    Mascot.mountAll(view);
    $$("[data-text]", view).forEach(typewrite);
    afterRender[name]?.(param);
  } catch (err) {
    view.innerHTML = `<div class="view">${pane("error", `<p class="c-loss">${esc(err.message)}</p>`)}</div>`;
  }
}

const refresh = () => router();

window.addEventListener("hashchange", () => {
  router();
  $("#view").focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

/* ================================================================ dashboard */

/** Estado de ánimo y mensaje de Bit según cómo va el día. */
function mascotState(o) {
  const pending = o.pending_today.length;
  if (!o.total_games) return { mood: "sleep", text: "No tengo juegos que vigilar... agrega uno y despierto." };
  if (!pending) {
    return { mood: "happy", text: o.perfect_today
      ? `¡Día perfecto! ✨ Llevas ${o.perfect_streak} día(s) perfecto(s) seguidos y ${o.current_streak} de racha.`
      : `¡Todo lo de hoy está jugado! ${o.current_streak} día(s) de racha. Vuelve mañana.` };
  }
  if (o.current_streak > 0 && o.played_today === 0) {
    return { mood: "sad", text: `Tu racha de ${o.current_streak} día(s) está en peligro. ¡Juega algo hoy!` };
  }
  if (o.played_today === 0) {
    return { mood: "idle", text: `Hoy te esperan ${pending} juego(s). ¿No sabes por cuál empezar? Gira la ruleta [r].` };
  }
  return { mood: "idle", text: `Vas ${o.played_today}/${o.today_total}. Quedan ${pending}; si dudas, la ruleta elige por ti [r].` };
}

/**
 * Registro en un toque desde la tarjeta: 1·2·3·4·5·6·✗ (intentos) o
 * 0·1·2·3·✗ (errores). Solo para juegos cuya métrica principal es esa.
 */
function quickLogRow(game) {
  const metric = game.primary_metric;
  if (!["attempts", "errors"].includes(metric) || game.track_time || game.track_score) return "";
  const values = METRICS[metric].quick;
  return `<div class="quicklog-wrap"><span class="muted small">registro rápido · ${metric === "attempts" ? "intentos" : "errores"}</span>
    <div class="quicklog" role="group" aria-label="Registro rápido de ${esc(game.name)}">
      ${values.map((v) => `<button class="ql" data-quicklog="${game.id}" data-value="${v}" title="Victoria con ${v} ${METRICS[metric].label}">${v}</button>`).join("")}
      <button class="ql loss" data-quicklog="${game.id}" data-value="loss" title="Derrota">✗</button>
    </div></div>`;
}

async function quickLog(gameId, value) {
  const game = gameById(gameId);
  const metric = game.primary_metric;
  const loss = value === "loss";
  const max = METRICS[metric].quick.at(-1);
  const body = { game_id: game.id, played_at: state.today, result: loss ? "loss" : "win", notes: "" };
  body[metric] = loss ? (metric === "attempts" ? max : max) : Number(value);
  const session = await api("/api/sessions", { method: "POST", body });
  stopPlaying(game.id);
  toast(`${game.name}: ${loss ? "derrota" : `victoria · ${body[metric]} ${METRICS[metric].label}`}`, "info", {
    label: "deshacer",
    run: async () => {
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      toast("registro deshecho");
      refresh();
    },
  });
  refresh();
}

function favButton(game) {
  return `<button class="star ${game.favorite ? "on" : ""}" data-fav="${game.id}" aria-pressed="${game.favorite}"
    title="${game.favorite ? "Quitar de favoritos" : "Marcar como favorito"}">${game.favorite ? "★" : "☆"}</button>`;
}

function gameCard(game, card) {
  const last = card?.last_session;
  const resting = !card?.played_today && card?.scheduled_today === false;
  const status = card?.played_today ? resultTag(last.result)
    : resting ? '<span class="tag pending">[ zz ]</span> descansa hoy' : '<span class="tag pending">[PEND]</span> pendiente';
  const rows = [["estado", status]];
  const compact = readPref("dle-density", "") === "compact";
  if (compact) {
    // En modo compacto solo estado y racha.
  } else if (last) {
    rows.push(["última", fmtDate(last.played_at)]);
    const summary = sessionSummary(game, last);
    if (summary) rows.push(["datos", esc(summary)]);
  } else {
    rows.push(["última", '<span class="muted">sin partidas</span>']);
  }
  rows.push(["racha", card?.current_streak
    ? `<span class="tag streak">${card.current_streak}d</span> ${asciiBar(Math.min(card.current_streak, 10), 10, 10)}`
    : '<span class="muted">—</span>']);
  const playing = isPlaying(game.id);
  const body = `
    ${kv(rows)}
    ${!card?.played_today ? quickLogRow(game) : ""}
    <div class="card-actions">
      ${game.url ? `<a class="btn" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer" data-play="${game.id}">▶ jugar</a>` : ""}
      <button class="btn primary" data-log="${game.id}">${card?.played_today ? "editar" : playing ? "⏎ anotar resultado" : "+ registrar"}</button>
    </div>`;
  const title = `${gicon(game)} <a href="#/game/${game.id}">${esc(slug(game.name))}</a>`;
  return pane(title, body, { cls: `game-card ${card?.played_today ? "done" : ""} ${resting ? "resting" : ""} ${playing && !card?.played_today ? "playing" : ""}`, tag: "article", aside: favButton(game) });
}

function weekPane(week, { title = "semana", metricKey = "attempts", lowerBetter = true } = {}) {
  const t = week.this_week;
  const l = week.last_week;
  const avgKey = `avg_${metricKey}`;
  const delta = week.delta[avgKey];
  let deltaHtml = '<span class="muted">—</span>';
  if (delta != null) {
    const better = delta === 0 ? null : (delta < 0) === lowerBetter;
    const cls = better == null ? "" : better ? "delta-good" : "delta-bad";
    const sign = delta > 0 ? "+" : delta < 0 ? "-" : "±";
    deltaHtml = `<span class="${cls}">${sign}${fmtMetric(metricKey, Math.abs(delta))} ${better == null ? "" : better ? "(mejor)" : "(peor)"}</span>`;
  }
  const body = kv([
    ["partidas", `${t.played} <span class="muted">(${t.wins} ok / ${t.losses} fail)</span>`],
    ["días", `${t.days_played}/7 ${asciiBar(t.days_played, 7, 7)}`],
    [`prom. ${METRICS[metricKey].label}`, fmtMetric(metricKey, t[avgKey])],
    ["sem. anterior", fmtMetric(metricKey, l[avgKey])],
    ["variación", deltaHtml],
  ]);
  return pane(title, body, { aside: `<span class="muted">${fmtDate(t.start, { relative: false })} → ${fmtDate(t.end, { relative: false })}</span>` });
}

function achievementsPane(list) {
  const unlocked = list.filter((a) => a.unlocked);
  const next = list.filter((a) => !a.unlocked).slice(0, 3);
  const items = [...unlocked, ...next].map((a) => `
    <li class="${a.unlocked ? "" : "locked"}">
      <span class="box">${a.unlocked ? "[x]" : "[ ]"}</span>
      <span>${a.icon} ${esc(a.title)}</span>
      ${a.unlocked ? "" : `<span>${asciiBar(a.progress, a.target, 12)} <span class="muted">${a.progress}/${a.target}</span></span>`}
    </li>`).join("");
  return pane("logros", `<ul class="achievements">${items}</ul>`, { aside: `<span class="muted">${unlocked.length}/${list.length}</span>` });
}

async function renderDashboard() {
  const o = await loadOverview();
  const cards = Object.fromEntries(o.games.map((c) => [c.game_id, c]));
  const active = sortGames(state.games.filter((g) => g.active), cards);
  const pendingIds = new Set(o.pending_today);
  const nextPending = active.find((g) => pendingIds.has(g.id) && g.url);
  const dateLabel = parseISO(o.today).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  const { mood, text } = mascotState(o);
  const swatches = ["--accent", "--win", "--streak", "--loss", "--info", "--text-2", "--line-2", "--muted"]
    .map((v) => `<i style="background:var(${v})"></i>`).join("");

  const fetch = `
    <div class="fetch">
      <div class="fetch-art"><span data-mascot="${mood}" data-scale="10" id="dash-mascot"></span></div>
      <div class="fetch-info">
        <div class="host">${esc(userName())}@dle-tracker</div>
        <hr>
        ${kv([
          ["fecha", esc(dateLabel)],
          ["juegos", o.total_games],
          ["hoy", `${o.played_today}/${o.today_total} ${asciiBar(o.played_today, o.today_total || 1, 12)}${o.perfect_today ? ' <span class="c-streak">✨ perfecto</span>' : ""}`],
          ["partidas", o.total_sessions],
          ["victorias", `<span class="c-win">${o.wins}</span>`],
          ["derrotas", `<span class="c-loss">${o.losses}</span>`],
          ["% victorias", pct(o.win_rate)],
          ["racha", `<span class="c-streak">${o.current_streak} días</span>`],
          ["mejor racha", `${o.best_streak} días`],
          ["días perfectos", `${o.perfect_days}${o.perfect_streak > 1 ? ` <span class="muted">(${o.perfect_streak} seguidos)</span>` : ""}`],
        ])}
        <div class="swatches" aria-hidden="true">${swatches}</div>
        <div class="speech"><span data-text="${esc(text)}"></span></div>
      </div>
    </div>`;

  return `
    ${pageHead({
      cmd: "dlefetch",
      title: "dashboard",
      actions: `
        ${nextPending ? `<a class="btn primary" href="${esc(nextPending.url)}" target="_blank" rel="noopener noreferrer" data-play="${nextPending.id}"
          title="Abrir ${esc(nextPending.name)}">▶ siguiente: ${esc(nextPending.name)}</a>` : ""}
        <a class="btn" href="#/roulette" data-spin-link>🎲 ruleta</a>
        <button class="btn" data-share-day title="Copiar el resumen de hoy">⧉ compartir día</button>
        <button class="btn" data-new-game>+ juego</button>`,
    })}
    <div class="dash-top">
      ${pane("sistema", fetch)}
      <div class="stack">
        ${weekPane(o.week, { title: "esta semana" })}
        ${achievementsPane(o.achievements)}
      </div>
    </div>
    <section class="section">
      <div class="section-head">
        <div class="prompt"><span class="u">$</span> <span class="cmd">ls juegos/ --sort=${esc(readPref("dle-sort", "pending"))}</span></div>
        <span class="card-actions">
          <span class="muted small">${o.pending_today.length ? `${o.pending_today.length} pendiente(s)` : "todo jugado ✓"}</span>
          <select id="sort-select" class="inline-select" aria-label="Ordenar juegos">
            ${Object.entries(SORTS).map(([k, label]) => `<option value="${k}" ${readPref("dle-sort", "pending") === k ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </span>
      </div>
      ${active.length
        ? `<div class="game-grid">${active.map((g) => gameCard(g, cards[g.id])).join("")}</div>`
        : pane("", '<p class="empty">no hay juegos activos <a class="btn primary" href="#/discover">descubrir juegos</a></p>')}
    </section>`;
}

/** Ordena las tarjetas según la preferencia del dashboard. */
function sortGames(games, cards) {
  const mode = readPref("dle-sort", "pending");
  const byName = (a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" });
  // 0 = pendiente, 1 = jugado, 2 = descansa hoy
  const pending = (g) => (cards[g.id]?.played_today ? 1 : cards[g.id]?.scheduled_today === false ? 2 : 0);
  const fav = (g) => (g.favorite ? 0 : 1);
  const cmp = {
    pending: (a, b) => pending(a) - pending(b) || fav(a) - fav(b) || byName(a, b),
    favorites: (a, b) => fav(a) - fav(b) || pending(a) - pending(b) || byName(a, b),
    name: byName,
    streak: (a, b) => (cards[b.id]?.current_streak || 0) - (cards[a.id]?.current_streak || 0) || byName(a, b),
  }[mode] || byName;
  return [...games].sort(cmp);
}

afterRender.dashboard = () => {
  $("#sort-select")?.addEventListener("change", (e) => {
    writePref("dle-sort", e.target.value);
    refresh();
  });
};

/** Texto para compartir cómo te fue hoy. */
function daySummaryText() {
  const o = state.overview;
  const cards = Object.fromEntries(o.games.map((c) => [c.game_id, c]));
  const active = sortGames(state.games.filter((g) => g.active), cards);
  const date = parseISO(o.today).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  const lines = active.map((g) => {
    const c = cards[g.id];
    if (!c?.played_today) return c?.scheduled_today === false ? null : `⏳ ${g.name}`;
    const s = c.last_session;
    const detail = sessionSummary(g, s);
    return `${s.result === "win" ? "✅" : "❌"} ${g.name}${detail ? ` — ${detail}` : ""}`;
  });
  return [`dle_tracker · ${date}`, ...lines.filter(Boolean), "",
    `${o.played_today}/${o.today_total} jugados${o.perfect_today ? " · ✨ día perfecto" : ""} · 🔥 ${o.current_streak} día(s) de racha`].join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/* ================================================================ descubrir */

function catalogAddedIndex() {
  const keys = new Map();
  for (const g of state.games) {
    keys.set(`u:${DleCatalog.urlKey(g.url || "")}`, g);
    keys.set(`n:${g.name.toLowerCase()}`, g);
  }
  return (entry) => keys.get(`u:${DleCatalog.urlKey(entry.url)}`) || keys.get(`n:${entry.name.toLowerCase()}`) || null;
}

function catalogCard(entry, added, { highlight = false, badge = "" } = {}) {
  const cat = DleCatalog.categoryInfo(entry.category);
  const pseudo = { icon: cat.icon, url: entry.url, icon_url: DleStore.iconCandidates(entry.url)[0] || null };
  const actions = added
    ? `<a class="btn" href="#/game/${added.id}">✓ en tus juegos</a>`
    : `<button class="btn primary" data-add-catalog="${entry.id}">+ agregar</button>`;
  const body = `
    <p class="dim small cat-desc">${esc(entry.description)}</p>
    <div class="cat-meta"><span class="tag cat">#${esc(slug(cat.label))}</span>${entry.themes.map((t) => `<span class="muted small">${esc(t.toLowerCase())}</span>`).join(" ")}${badge}</div>
    <div class="card-actions">
      <a class="btn" href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">▶ probar</a>
      ${actions}
    </div>`;
  return pane(`${gicon(pseudo)} ${esc(entry.name)}`, body, { cls: `cat-card ${highlight ? "highlight" : ""} ${added ? "added" : ""}`, tag: "article" });
}

function filteredCatalog() {
  const d = state.discover;
  const isAdded = catalogAddedIndex();
  const q = d.q.trim().toLowerCase();
  return d.catalog.games.filter((g) =>
    (!d.cat || g.category === d.cat)
    && (!d.hideAdded || !isAdded(g))
    && (!q || g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q)
      || g.themes.some((t) => t.toLowerCase().includes(q))));
}

function discoverResultsHtml() {
  const d = state.discover;
  const isAdded = catalogAddedIndex();
  const list = filteredCatalog();
  const shown = list.slice(0, d.limit);
  const suggestion = d.suggestion && d.catalog.games.find((g) => g.id === d.suggestion);
  return `
    ${suggestion ? `<div class="suggestion">
        <div class="speech"><span>¿Qué tal <b>${esc(suggestion.name)}</b>? ${esc(DleCatalog.categoryInfo(suggestion.category).label)}, y no lo tienes todavía.</span></div>
        ${catalogCard(suggestion, isAdded(suggestion), { highlight: true })}
      </div>` : ""}
    <p class="muted small">${list.length} resultado(s)${d.q ? ` para «${esc(d.q)}»` : ""}</p>
    ${shown.length ? `<div class="game-grid">${shown.map((g) => catalogCard(g, isAdded(g))).join("")}</div>` : '<p class="empty">nada por aquí: prueba otra búsqueda o categoría</p>'}
    ${list.length > shown.length ? `<div class="more"><button class="btn" data-more>ver ${Math.min(48, list.length - shown.length)} más</button></div>` : ""}`;
}

async function renderDiscover() {
  const d = state.discover;
  let notice = "";
  try {
    d.catalog = await DleCatalog.load(STORAGE);
    if (d.catalog.from === "stale") notice = '<p class="muted small">sin conexión: mostrando el catálogo guardado</p>';
  } catch (err) {
    if (!d.catalog) {
      return `${pageHead({ cmd: "apt update", title: "descubrir" })}
        ${pane("error", `<p class="c-loss">${esc(err.message)}</p><button class="btn primary" data-catalog-refresh>↻ reintentar</button>`)}`;
    }
  }
  const c = d.catalog;
  const isAdded = catalogAddedIndex();
  const byId = new Map(c.games.map((g) => [g.id, g]));
  const counts = {};
  for (const g of c.games) counts[g.category] = (counts[g.category] || 0) + 1;
  const chips = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([key, n]) => {
    const cat = DleCatalog.categoryInfo(key);
    return `<label><input type="radio" name="cat" value="${esc(key)}" ${d.cat === key ? "checked" : ""}><span>${cat.icon} ${esc(cat.label.toLowerCase())} <span class="muted">${n}</span></span></label>`;
  }).join("");
  const weekly = (c.weekly?.ids || []).map((id) => byId.get(id)).filter(Boolean);
  const fresh = c.fresh.slice(0, 6).map((f) => [byId.get(f.id), f.date_added]).filter(([g]) => g);
  const updated = new Date(c.fetched_at).toLocaleDateString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return `
    ${pageHead({
      cmd: "apt search dle",
      title: "descubrir",
      sub: `${c.games.length} juegos diarios del catálogo de <a href="${DleCatalog.SITE}" target="_blank" rel="noopener">dles.aukspot.com</a>`,
      actions: `<button class="btn primary" data-surprise>🎲 sorpréndeme</button>
        <button class="btn" data-catalog-refresh title="Actualizado: ${esc(updated)}">↻ actualizar</button>`,
    })}
    ${notice}
    ${weekly.length ? `<section class="section">
      <div class="section-head"><div class="prompt"><span class="u">$</span> <span class="cmd">cat destacados_de_la_semana</span></div>
        <span class="muted small">semana del ${fmtDate(c.weekly.date, { relative: false })}</span></div>
      <div class="game-grid">${weekly.map((g) => catalogCard(g, isAdded(g), { badge: '<span class="tag streak">★ destacado</span>' })).join("")}</div>
    </section>` : ""}
    ${fresh.length ? `<section class="section">
      <div class="section-head"><div class="prompt"><span class="u">$</span> <span class="cmd">ls -t nuevos/ | head</span></div></div>
      <div class="game-grid">${fresh.map(([g, date]) => catalogCard(g, isAdded(g), { badge: `<span class="tag info">nuevo · ${fmtDate(date, { relative: false })}</span>` })).join("")}</div>
    </section>` : ""}
    <section class="section">
      <div class="section-head"><div class="prompt"><span class="u">$</span> <span class="cmd" id="grep-cmd">grep -i "${esc(d.q)}" catalogo.json</span></div></div>
      <div class="discover-filters">
        <label class="field search-field">buscar <kbd>/</kbd>
          <input type="search" id="discover-q" value="${esc(d.q)}" placeholder="nombre, tema o descripción (en inglés)…" autocomplete="off">
        </label>
        <label class="check"><input type="checkbox" id="hide-added" ${d.hideAdded ? "checked" : ""}> ocultar los que ya tengo</label>
      </div>
      <div class="segmented chips-row" id="cat-chips" role="radiogroup" aria-label="Categoría">
        <label><input type="radio" name="cat" value="" ${d.cat ? "" : "checked"}><span>todas <span class="muted">${c.games.length}</span></span></label>
        ${chips}
      </div>
      <div id="discover-results">${discoverResultsHtml()}</div>
    </section>
    <p class="muted small credit">Catálogo: <a href="${DleCatalog.SITE}" target="_blank" rel="noopener">dles.aukspot.com</a>
      (<a href="https://github.com/aukspot/dles" target="_blank" rel="noopener">código y datos GPL-3.0</a>), descargado desde GitHub y guardado en tu navegador.</p>`;
}

function refreshDiscoverResults() {
  const box = $("#discover-results");
  if (!box) return;
  box.innerHTML = discoverResultsHtml();
  $("#grep-cmd").textContent = `grep -i "${state.discover.q}" catalogo.json`;
}

afterRender.discover = () => {
  const d = state.discover;
  const q = $("#discover-q");
  if (!q) return;
  let timer;
  q.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      d.q = q.value;
      d.limit = 48;
      d.suggestion = null;
      refreshDiscoverResults();
    }, 120);
  });
  $("#hide-added").addEventListener("change", (e) => {
    d.hideAdded = e.target.checked;
    refreshDiscoverResults();
  });
  $("#cat-chips").addEventListener("change", (e) => {
    d.cat = e.target.value;
    d.limit = 48;
    d.suggestion = null;
    refreshDiscoverResults();
  });
  if (d.focus) {
    d.focus = false;
    q.focus();
    q.select();
  }
};

async function addFromCatalog(id, button) {
  const entry = state.discover.catalog?.games.find((g) => g.id === Number(id));
  if (!entry) return;
  button.disabled = true;
  try {
    const game = await api("/api/games", { method: "POST", body: DleCatalog.toGame(entry) });
    state.games.push(game);
    toast(`${game.name} agregado a tus juegos`);
    const card = button.closest(".cat-card");
    card.classList.add("added");
    button.outerHTML = `<a class="btn" href="#/game/${game.id}">✓ en tus juegos</a>`;
  } catch (err) {
    button.disabled = false;
    toast(err.message, "error");
  }
}

/* ================================================================ mis juegos */

async function renderGames() {
  const o = await loadOverview();
  const cards = Object.fromEntries(o.games.map((c) => [c.game_id, c]));
  const rows = state.games.map((g) => {
    const c = cards[g.id];
    return `
      <li class="manage-row ${g.active ? "" : "inactive"}">
        ${gicon(g, "lg")}
        <div class="grow">
          <a href="#/game/${g.id}"><b>${esc(g.name)}</b></a>
          ${g.category ? `<span class="tag cat">#${esc(slug(g.category))}</span>` : ""}
          ${g.active ? "" : '<span class="tag pending">[inactivo]</span>'}
          <div class="muted small">${esc(g.description || "")}${g.description ? " · " : ""}${c?.played || 0} partidas · métrica: ${METRICS[g.primary_metric].label}</div>
        </div>
        <span class="card-actions">
          ${g.url ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" data-play="${g.id}">▶</a>` : ""}
          <button class="btn" data-edit-game="${g.id}">editar</button>
          <button class="btn" data-toggle-game="${g.id}">${g.active ? "desactivar" : "activar"}</button>
          <button class="btn danger" data-delete-game="${g.id}">rm</button>
        </span>
      </li>`;
  });
  return `
    ${pageHead({
      cmd: "ls -la juegos/",
      title: "juegos",
      sub: `total ${state.games.length}`,
      actions: `${state.games.some((g) => g.url && !g.icon_url) ? '<button class="btn" data-fetch-icons>↻ iconos faltantes</button>' : ""}<button class="btn primary" data-new-game>+ nuevo juego</button>`,
    })}
    ${pane("juegos/", rows.length ? `<ul class="list">${rows.join("")}</ul>` : '<p class="empty">aún no tienes juegos</p>')}`;
}

/* ================================================================ página de juego */

async function renderGame(id) {
  const game = gameById(id);
  if (!game) throw new Error("juego no encontrado");
  const s = await api(`/api/stats/${game.id}`);
  await loadOverview();
  state.gameStats = s;
  const metric = game.primary_metric;
  const trendLabel = {
    improving: '<span class="trend delta-good">▲ mejorando</span>',
    worsening: '<span class="trend delta-bad">▼ empeorando</span>',
    stable: '<span class="trend">= estable</span>',
    insufficient_data: '<span class="muted">faltan datos</span>',
  }[s.trend.direction];

  const recent = s.recent.map((r) => `
    <li>
      <span class="num">${fmtDate(r.played_at, { relative: false })}</span>
      ${resultTag(r.result)}
      <span class="grow dim small">${esc(sessionSummary(game, r))}${r.notes ? ` # ${esc(r.notes)}` : ""}</span>
      <button class="btn" data-edit-session="${r.id}">editar</button>
    </li>`).join("");

  const summary = kv([
    ["racha", `<span class="c-streak">${s.current_streak} días</span>`],
    ["mejor racha", `${s.best_streak} días`],
    ["partidas", s.played],
    ["victorias", `<span class="c-win">${s.wins}</span>`],
    ["derrotas", `<span class="c-loss">${s.losses}</span>`],
    ["% victorias", `${pct(s.win_rate)} ${s.win_rate != null ? asciiBar(s.win_rate, 100, 12) : ""}`],
    ...trackedMetrics(game).map((m) => [`prom. ${METRICS[m].label}`, fmtMetric(m, s.averages[m])]),
    ["mejor", s.best ? `${fmtMetric(metric, s.best[metric])} <span class="muted">(${fmtDate(s.best.played_at, { relative: false })})</span>` : "—"],
    ["peor", s.worst ? `${fmtMetric(metric, s.worst[metric])} <span class="muted">(${fmtDate(s.worst.played_at, { relative: false })})</span>` : "—"],
    ["tendencia", trendLabel],
  ]);

  return `
    ${pageHead({
      cmd: `cat juegos/${slug(game.name)}`,
      title: `${gicon(game, "xl")} ${esc(game.name)} ${game.active ? "" : '<span class="tag pending small">[inactivo]</span>'}`,
      sub: esc(game.description || game.category || ""),
      actions: `
        ${game.url ? `<a class="btn" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer" data-play="${game.id}">▶ jugar</a>` : ""}
        <button class="btn" data-edit-game="${game.id}">editar</button>
        <button class="btn primary" data-log="${game.id}">+ registrar</button>`,
    })}
    <div class="grid-2">
      ${pane("resumen", summary)}
      ${pane(`evolución · ${METRICS[metric].label}`, `
        <div class="chart-box"><canvas id="evolution-chart" aria-label="Evolución de ${METRICS[metric].label}"></canvas></div>
        <p class="muted small" style="margin:8px 0 0"><span class="c-win">■</span> victoria · <span class="c-loss">■</span> derrota
        ${s.trend.recent_avg != null && s.trend.previous_avg != null ? ` · últimas 10: ${fmtMetric(metric, s.trend.recent_avg)} vs 10 anteriores: ${fmtMetric(metric, s.trend.previous_avg)}` : ""}</p>`)}
    </div>
    <section class="section grid-2">
      ${weekPane(s.week, { title: "esta semana vs anterior", metricKey: metric, lowerBetter: game.lower_is_better })}
      ${pane("distribución", '<div class="chart-box short"><canvas id="distribution-chart" aria-label="Distribución"></canvas></div>')}
    </section>
    <section class="section">
      ${pane("tail partidas.log", recent ? `<ul class="list">${recent}</ul>` : '<p class="empty">aún no hay partidas</p>',
        { aside: `<a href="#/history" data-history-game="${game.id}">ver todo →</a>` })}
    </section>`;
}

afterRender.game = () => {
  evolutionChart($("#evolution-chart"), state.gameStats);
  distributionChart($("#distribution-chart"), state.gameStats);
};

/* ================================================================ ruleta */

const POOLS = { pending: "pendientes de hoy", all: "todos los activos", favorites: "favoritos" };
const REEL = { length: 64, winnerAt: 56 };

function roulettePool(pool = state.roulette.pool) {
  const active = state.games.filter((g) => g.active);
  if (pool === "favorites") return active.filter((g) => g.favorite);
  if (pool === "pending") {
    const pending = new Set(state.overview?.pending_today || []);
    return active.filter((g) => pending.has(g.id));
  }
  return active;
}

/** Secuencia de la tira: aleatoria, sin repetir vecinos, con el ganador en `winnerAt`. */
function reelSequence(games, winner) {
  const seq = [];
  for (let i = 0; i < REEL.length; i++) {
    if (i === REEL.winnerAt) { seq.push(winner); continue; }
    let pick;
    do {
      pick = games[Math.floor(Math.random() * games.length)];
    } while (games.length > 1 && (pick === seq[i - 1] || (i + 1 === REEL.winnerAt && pick === winner)));
    seq.push(pick);
  }
  return seq;
}

function reelTile(g, i) {
  return `<div class="reel-tile" data-i="${i}">${gicon(g, "reel-icon")}<span class="reel-name">${esc(g.name)}</span></div>`;
}

/* --- sonido opcional (WebAudio, sin archivos) --- */
let audioCtx = null;
function beep(freq = 1400, ms = 18, gain = 0.04) {
  if (readPref("dle-sound", "off") !== "on") return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const vol = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    vol.gain.value = gain;
    osc.connect(vol).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + ms / 1000);
  } catch { /* sin audio */ }
}

function fanfare() {
  [880, 1175, 1568].forEach((f, i) => setTimeout(() => beep(f, 90, 0.05), i * 110));
}

/** Confeti ASCII que sale del ganador. */
function confetti(target) {
  if (REDUCED_MOTION.matches || !target) return;
  const layer = $("#reel-fx");
  if (!layer) return;
  const box = target.getBoundingClientRect();
  const origin = layer.getBoundingClientRect();
  const chars = ["*", "+", "✦", "·", "★", "#", "$", "@"];
  for (let i = 0; i < 28; i++) {
    const s = document.createElement("span");
    s.className = "spark";
    s.textContent = chars[i % chars.length];
    s.style.left = `${box.left - origin.left + box.width / 2}px`;
    s.style.top = `${box.top - origin.top + box.height / 2}px`;
    const angle = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 120;
    s.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    s.style.setProperty("--dy", `${Math.sin(angle) * dist * 0.6}px`);
    s.style.color = ["var(--accent)", "var(--streak)", "var(--info)", "var(--win)"][i % 4];
    layer.append(s);
    setTimeout(() => s.remove(), 1100);
  }
}

function loadQueue() {
  try {
    const q = JSON.parse(localStorage.getItem("dle-queue"));
    if (q && q.date === state.today && Array.isArray(q.ids)) return q.ids;
  } catch { /* nada */ }
  return null;
}

function saveQueue(ids) {
  writePref("dle-queue", ids ? JSON.stringify({ date: state.today, ids }) : null);
}

function queuePane() {
  const ids = (loadQueue() || []).filter((id) => gameById(id));
  if (!ids.length) {
    return pane("cola del día", `<p class="dim small">Baraja tus juegos y juégalos en ese orden: perfecto para no pensar.</p>
      <button class="btn primary" data-shuffle-queue>⇄ barajar cola</button>`);
  }
  const cards = Object.fromEntries((state.overview?.games || []).map((c) => [c.game_id, c]));
  const items = ids.map((id, i) => {
    const g = gameById(id);
    const done = cards[id]?.played_today;
    return `<li class="${done ? "done" : ""}">
      <span class="q-num">${String(i + 1).padStart(2, "0")}</span>
      ${gicon(g)} <span class="grow">${esc(g.name)}</span>
      ${done ? resultTag(cards[id].last_session.result, { label: false })
        : `${g.url ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" title="Jugar" data-play="${g.id}">▶</a>` : ""}
           <button class="btn primary" data-log="${g.id}" title="Registrar">+</button>`}
    </li>`;
  }).join("");
  const left = ids.filter((id) => !cards[id]?.played_today).length;
  return pane("cola del día", `<ol class="queue">${items}</ol>
    <div class="card-actions" style="margin-top:10px">
      <button class="btn" data-shuffle-queue>⇄ volver a barajar</button>
      <button class="btn danger" data-clear-queue>borrar</button>
    </div>`, { aside: `<span class="muted">${left ? `quedan ${left}` : "¡completa! ✓"}</span>` });
}

async function renderRoulette() {
  const o = await loadOverview();
  const r = state.roulette;
  // Si ya está todo jugado, no tiene sentido filtrar por pendientes.
  if (r.pool === "pending" && !o.pending_today.length) r.pool = "all";
  const games = roulettePool();
  state.reelGames = games;
  const res = r.result && games.find((g) => g.id === r.result) ? gameById(r.result) : null;
  const sound = readPref("dle-sound", "off") === "on";
  const counts = { pending: roulettePool("pending").length, all: roulettePool("all").length, favorites: roulettePool("favorites").length };

  // Tira inicial (antes de girar): los juegos del grupo, repetidos.
  const initial = games.length ? Array.from({ length: 24 }, (_, i) => games[i % games.length]) : [];
  const reel = games.length
    ? `<div class="reel-window" id="reel-window">
         <span class="reel-marker top" aria-hidden="true">▼</span>
         <div class="reel-strip" id="reel-strip">${initial.map(reelTile).join("")}</div>
         <span class="reel-marker bottom" aria-hidden="true">▲</span>
         <div class="reel-fx" id="reel-fx" aria-hidden="true"></div>
       </div>`
    : `<p class="empty">no hay juegos en «${POOLS[r.pool]}»</p>`;

  const resultHtml = res
    ? `<div class="result-row">
         <span data-mascot="happy" data-scale="5"></span>
         <div class="grow">
           <div class="result-name">${gicon(res, "xl")} ${esc(res.name)}</div>
           <p class="dim small">${esc(res.description || "")}</p>
         </div>
       </div>
       <div class="card-actions">
         ${res.url ? `<a class="btn primary" href="${esc(res.url)}" target="_blank" rel="noopener noreferrer" data-play="${res.id}">▶ jugar ahora</a>` : ""}
         <button class="btn" data-log="${res.id}">+ registrar</button>
       </div>`
    : `<div class="result-row"><span data-mascot="${r.spinning ? "spin" : "idle"}" data-scale="5" id="reel-mascot"></span>
       <p class="dim grow">Pulsa <b>girar</b> (o la tecla <kbd>r</kbd>) y Bit elegirá un juego al azar.</p></div>`;

  return `
    ${pageHead({
      cmd: `shuf -n 1 ${r.pool}.txt`,
      title: "ruleta",
      sub: "¿No sabes qué jugar? Deja que el azar decida.",
      actions: `<button class="btn" data-toggle-sound aria-pressed="${sound}">${sound ? "🔊 sonido" : "🔇 sin sonido"}</button>
        <button class="btn primary big" id="spin-btn" ${games.length && !r.spinning ? "" : "disabled"}>🎲 girar</button>`,
    })}
    ${pane(`${games.length} juego(s) · ${POOLS[r.pool]}`, reel, { cls: "reel-pane" })}
    <div class="roulette-grid section">
      ${pane("opciones", `
        <div class="segmented pool-picker" role="radiogroup" aria-label="Juegos en la ruleta">
          ${Object.entries(POOLS).map(([k, label]) => `<label><input type="radio" name="pool" value="${k}" ${r.pool === k ? "checked" : ""} ${counts[k] ? "" : "disabled"}><span>${label} (${counts[k]})</span></label>`).join("")}
        </div>`)}
      ${pane("resultado", `<div id="roulette-result">${resultHtml}</div>`)}
      ${queuePane()}
      ${pane("stdout", `<pre class="console-log" id="roulette-log">${r.log.length ? r.log.join("\n") : '<span class="muted">esperando…</span>'}</pre>`)}
    </div>`;
}

function rouletteLog(line) {
  const r = state.roulette;
  r.log.push(line);
  if (r.log.length > 30) r.log.shift();
  const el = $("#roulette-log");
  if (el) {
    el.innerHTML = r.log.join("\n");
    el.scrollTop = el.scrollHeight;
  }
}

function spinRoulette() {
  const r = state.roulette;
  const games = state.reelGames || [];
  const strip = $("#reel-strip");
  const win = $("#reel-window");
  if (r.spinning || !games.length || !strip) return;
  r.spinning = true;
  r.result = null;
  $("#spin-btn").disabled = true;
  Mascot.setMood($("#reel-mascot"), "spin");
  $("#roulette-result").innerHTML = '<div class="result-row"><span data-mascot="spin" data-scale="5"></span><p class="dim grow">girando<span class="cursor"></span></p></div>';
  Mascot.mountAll($("#roulette-result"));
  rouletteLog(`<b>$</b> shuf -n 1 ${r.pool}.txt`);

  const winner = games[Math.floor(Math.random() * games.length)];
  strip.style.transition = "none";
  strip.style.transform = "translateX(0)";
  strip.innerHTML = reelSequence(games, winner).map(reelTile).join("");
  const tile = strip.querySelector(".reel-tile");
  const step = tile.getBoundingClientRect().width + parseFloat(getComputedStyle(strip).columnGap || 0);
  const jitter = (Math.random() - 0.5) * step * 0.6;
  const target = REEL.winnerAt * step + step / 2 - win.clientWidth / 2 + jitter;
  void strip.offsetWidth; // aplica la posición inicial antes de animar

  const duration = REDUCED_MOTION.matches ? 0 : 5200;
  strip.style.transition = duration ? `transform ${duration}ms cubic-bezier(0.08, 0.62, 0.1, 1)` : "none";
  strip.style.transform = `translateX(${-target}px)`;

  // "Tic" cada vez que una tarjeta pasa bajo el marcador.
  let last = -1;
  const tiles = strip.children;
  const tick = () => {
    if (!r.spinning) return;
    const x = -new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41;
    const idx = Math.floor((x + win.clientWidth / 2) / step);
    if (idx !== last && tiles[idx]) {
      tiles[last]?.classList.remove("under");
      tiles[idx].classList.add("under");
      last = idx;
      beep();
    }
    requestAnimationFrame(tick);
  };
  if (duration) requestAnimationFrame(tick);

  const finish = () => {
    if (!r.spinning) return;
    r.spinning = false;
    r.result = winner.id;
    rouletteLog(`→ ${esc(winner.name)}`);
    const tileEl = tiles[REEL.winnerAt];
    [...tiles].forEach((t) => t.classList.remove("under"));
    tileEl.classList.add("winner");
    confetti(tileEl);
    fanfare();
    setTimeout(() => {
      if (state.route !== "roulette") return;
      // Solo se actualizan los paneles; la tira se queda en el ganador.
      $("#spin-btn").disabled = false;
      $("#roulette-result").innerHTML = `
        <div class="result-row"><span data-mascot="happy" data-scale="5"></span>
          <div class="grow"><div class="result-name">${gicon(winner, "xl")} ${esc(winner.name)}</div>
          <p class="dim small">${esc(winner.description || "")}</p></div></div>
        <div class="card-actions">
          ${winner.url ? `<a class="btn primary" href="${esc(winner.url)}" target="_blank" rel="noopener noreferrer" data-play="${winner.id}">▶ jugar ahora</a>` : ""}
          <button class="btn" data-log="${winner.id}">+ registrar</button>
        </div>`;
      Mascot.mountAll($("#roulette-result"));
    }, duration ? 350 : 0);
  };
  if (duration) {
    // Solo cuenta el fin de la animación de la tira (las tarjetas también emiten transitionend).
    const onEnd = (e) => {
      if (e.target !== strip || e.propertyName !== "transform") return;
      strip.removeEventListener("transitionend", onEnd);
      finish();
    };
    strip.addEventListener("transitionend", onEnd);
    setTimeout(finish, duration + 400);
  } else {
    finish();
  }
}

afterRender.roulette = () => {
  const r = state.roulette;
  $("#spin-btn")?.addEventListener("click", spinRoulette);
  $$('input[name="pool"]').forEach((input) => input.addEventListener("change", () => {
    r.pool = input.value;
    r.result = null;
    refresh();
  }));
  if (r.autoSpin) {
    r.autoSpin = false;
    setTimeout(spinRoulette, 250);
  }
};

/* ================================================================ historial */

async function renderHistory() {
  const f = state.history;
  const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== ""));
  const sessions = await api(`/api/sessions?${params}`);
  const gameOptions = state.games
    .map((g) => `<option value="${g.id}" ${String(g.id) === f.game_id ? "selected" : ""}>${esc(g.icon)} ${esc(g.name)}</option>`)
    .join("");
  const rows = sessions.map((s) => {
    const g = gameById(s.game_id);
    const cell = (label, value, cls = "num") =>
      `<td class="${cls} ${value === "—" ? "empty-cell" : ""}" data-label="${label}">${value}</td>`;
    return `
      <tr>
        <td class="num nowrap" data-label="">${fmtDate(s.played_at)}</td>
        <td class="nowrap" data-label="">${g ? `<a href="#/game/${g.id}">${gicon(g)} ${esc(g.name)}</a>` : "—"}</td>
        <td class="nowrap" data-label="">${resultTag(s.result)}</td>
        ${cell("puntaje", fmtNum(s.score))}
        ${cell("intentos", fmtNum(s.attempts))}
        ${cell("errores", fmtNum(s.errors))}
        ${cell("tiempo", fmtTime(s.time_seconds))}
        <td class="notes-cell ${s.notes ? "" : "empty-cell"}" data-label="" title="${esc(s.notes)}">${s.notes ? `# ${esc(s.notes)}` : ""}</td>
        <td class="actions">
          <button class="btn" data-edit-session="${s.id}" aria-label="Editar">edit</button>
          <button class="btn danger" data-delete-session="${s.id}" aria-label="Eliminar">rm</button>
        </td>
      </tr>`;
  }).join("");
  const hasFilters = f.game_id || f.result || f.date_from || f.date_to;
  const grepParts = [
    f.game_id && `--juego=${slug(gameById(f.game_id)?.name || f.game_id)}`,
    f.result && `--resultado=${f.result}`,
    f.date_from && `--desde=${f.date_from}`,
    f.date_to && `--hasta=${f.date_to}`,
  ].filter(Boolean).join(" ");

  return `
    ${pageHead({
      cmd: `grep partidas.log ${grepParts}${f.order === "asc" ? " | sort" : " | sort -r"}`,
      title: "historial",
      sub: `${sessions.length} línea(s)${hasFilters ? " con filtros" : ""}`,
      actions: '<button class="btn primary" data-log="">+ registrar</button>',
    })}
    <form class="filters" id="history-filters">
      <label class="field">juego<select name="game_id"><option value="">*</option>${gameOptions}</select></label>
      <label class="field">resultado
        <select name="result">
          <option value="">*</option>
          <option value="win" ${f.result === "win" ? "selected" : ""}>victoria</option>
          <option value="loss" ${f.result === "loss" ? "selected" : ""}>derrota</option>
        </select>
      </label>
      <label class="field">desde<input type="date" name="date_from" value="${f.date_from}"></label>
      <label class="field">hasta<input type="date" name="date_to" value="${f.date_to}"></label>
      ${hasFilters ? '<button type="button" class="btn" data-clear-filters>limpiar</button>' : ""}
    </form>
    ${pane("partidas.log", `<div class="table-wrap">
      ${rows ? `
        <table class="history-table">
          <thead><tr>
            <th><button data-toggle-order title="Cambiar orden">fecha ${f.order === "desc" ? "↓" : "↑"}</button></th>
            <th>juego</th><th>resultado</th>
            <th class="num">puntaje</th><th class="num">intentos</th><th class="num">errores</th><th class="num">tiempo</th>
            <th>notas</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<p class="empty">no hay partidas que coincidan</p>'}
    </div>`)}`;
}

afterRender.history = () => {
  $("#history-filters")?.addEventListener("change", (e) => {
    state.history[e.target.name] = e.target.value;
    refresh();
  });
};

/* ================================================================ estadísticas */

async function renderStats() {
  const o = await loadOverview();
  const withData = state.games.filter((g) => o.games.find((c) => c.game_id === g.id)?.played);
  const perGame = await Promise.all(withData.map((g) => api(`/api/stats/${g.id}`)));
  const since = addDays(state.today, -29);
  const recent = await api(`/api/sessions?date_from=${since}&order=asc`);
  const yearAgo = addDays(state.today, -370);
  const yearSessions = await api(`/api/sessions?date_from=${yearAgo}&order=asc`);
  state.statsData = { o, perGame, recent, since };

  const rows = perGame.map((s) => {
    const g = gameById(s.game_id);
    const m = s.primary_metric;
    const trend = { improving: "▲", worsening: "▼", stable: "=", insufficient_data: "" }[s.trend.direction];
    const trendCls = { improving: "delta-good", worsening: "delta-bad" }[s.trend.direction] || "";
    return `
      <tr>
        <td class="nowrap"><a href="#/game/${g.id}">${gicon(g)} ${esc(g.name)}</a></td>
        <td class="num">${s.played}</td>
        <td class="num c-win">${s.wins}</td>
        <td class="num c-loss">${s.losses}</td>
        <td class="num">${pct(s.win_rate)}</td>
        <td class="muted">${METRICS[m].label}</td>
        <td class="num">${fmtMetric(m, s.averages[m])}</td>
        <td class="num">${s.best ? fmtMetric(m, s.best[m]) : "—"}</td>
        <td class="num">${s.worst ? fmtMetric(m, s.worst[m]) : "—"}</td>
        <td class="num c-streak">${s.current_streak}</td>
        <td class="num">${s.best_streak}</td>
        <td class="${trendCls}" title="Tendencia">${trend}</td>
      </tr>`;
  }).join("");

  const winBar = o.total_sessions
    ? `<p>${asciiBar(o.wins, o.total_sessions, 30)}</p>
       ${kv([["victorias", `<span class="c-win">${o.wins}</span> (${pct(o.win_rate)})`], ["derrotas", `<span class="c-loss">${o.losses}</span>`]])}`
    : "";

  return `
    ${pageHead({ cmd: "dle stats --all", title: "estadísticas", sub: `${o.total_sessions} partidas · racha ${o.current_streak} · mejor ${o.best_streak}` })}
    <div class="grid-2">
      ${pane("partidas por día", '<div class="chart-box short"><canvas id="daily-chart"></canvas></div>', { aside: '<span class="muted">30 días</span>' })}
      ${pane("victorias / derrotas", `<div class="chart-box short"><canvas id="winloss-chart"></canvas></div>${winBar}`)}
    </div>
    <section class="section">
      ${pane("actividad · último año", heatmapHtml(yearSessions))}
    </section>
    <section class="section">
      ${pane("evolución por juego", `
        ${perGame.length ? `<label class="field" style="max-width:260px">juego<select id="stats-game">${perGame.map((s) => {
          const g = gameById(s.game_id);
          return `<option value="${g.id}">${esc(g.icon)} ${esc(g.name)}</option>`;
        }).join("")}</select></label>` : ""}
        <div class="chart-box"><canvas id="game-evolution-chart"></canvas></div>`)}
    </section>
    <section class="section">
      ${pane("por juego", `<div class="table-wrap">${rows ? `<table>
        <thead><tr>
          <th>juego</th><th class="num">part.</th><th class="num">ok</th><th class="num">fail</th><th class="num">%</th>
          <th>métrica</th><th class="num">prom.</th><th class="num">mejor</th><th class="num">peor</th>
          <th class="num">racha</th><th class="num">máx.</th><th>tend.</th>
        </tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">registra partidas para ver estadísticas</p>'}</div>`)}
    </section>`;
}

/** Mapa de actividad estilo GitHub: 53 semanas que ocupan todo el ancho. */
function heatmapHtml(sessions) {
  const counts = {};
  for (const s of sessions) counts[s.played_at] = (counts[s.played_at] || 0) + 1;
  const today = state.today;
  const weekdayIdx = (parseISO(today).getDay() + 6) % 7;
  const start = addDays(today, -(52 * 7 + weekdayIdx)); // lunes de hace 52 semanas
  const max = Math.max(1, ...Object.values(counts));
  const cells = [];
  const months = [];
  let lastMonth = -1;
  for (let i = 0; ; i++) {
    const day = addDays(start, i);
    if (day > today) break;
    const n = counts[day] || 0;
    const level = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
    const d = parseISO(day);
    const col = Math.floor(i / 7) + 2; // la columna 1 son los nombres de los días
    if (i % 7 === 0 && d.getMonth() !== lastMonth) {
      if (lastMonth !== -1 || d.getDate() <= 7) months.push(`<span style="grid-column:${col} / span 4">${MONTHS[d.getMonth()].slice(0, 3)}</span>`);
      lastMonth = d.getMonth();
    }
    cells.push(`<i class="l${level}${day === today ? " today" : ""}" style="grid-column:${col};grid-row:${(i % 7) + 2}"
      title="${fmtDate(day, { relative: false })}: ${n ? `${n} partida(s)` : "sin partidas"}"></i>`);
  }
  const labels = ["lu", "", "mi", "", "vi", "", "do"].map((l, r) => `<b style="grid-row:${r + 2}">${l}</b>`).join("");
  const a = DleLogic.activitySummary(sessions, start, today);
  const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
  const topMonth = a.top_month ? `${MONTHS[Number(a.top_month.month.slice(5)) - 1]} ${a.top_month.month.slice(0, 4)}` : "—";
  return `<div class="heatmap-wrap">
      <div class="heatmap" role="img" aria-label="Partidas por día durante el último año">${months.join("")}${labels}${cells.join("")}</div>
    </div>
    <div class="heat-footer">
      <dl class="heat-stats">
        <div><dt>días jugados</dt><dd>${a.days_played}</dd></div>
        <div><dt>partidas</dt><dd>${a.sessions}</dd></div>
        <div><dt>racha más larga</dt><dd>${a.best_streak} d</dd></div>
        <div><dt>día favorito</dt><dd>${a.top_weekday === null ? "—" : WEEKDAYS[a.top_weekday]}</dd></div>
        <div><dt>mes más activo</dt><dd>${topMonth}</dd></div>
      </dl>
      <p class="muted small heat-legend">menos <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> más</p>
    </div>`;
}

afterRender.stats = () => {
  const { o, perGame, recent, since } = state.statsData;
  const counts = {};
  recent.forEach((s) => { counts[s.played_at] = (counts[s.played_at] || 0) + 1; });
  const days = Array.from({ length: 30 }, (_, i) => addDays(since, i));
  makeChart($("#daily-chart"), {
    type: "bar",
    data: {
      labels: days.map((d) => fmtDate(d, { relative: false }).slice(0, 5)),
      datasets: [{ label: "partidas", data: days.map((d) => counts[d] || 0), backgroundColor: cssVar("--accent"), maxBarThickness: 14 }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } }, x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } } },
    },
  });

  if (o.total_sessions) {
    makeChart($("#winloss-chart"), {
      type: "doughnut",
      data: {
        labels: ["victorias", "derrotas"],
        datasets: [{ data: [o.wins, o.losses], backgroundColor: [cssVar("--win"), cssVar("--loss")], borderColor: cssVar("--surface"), borderWidth: 2 }],
      },
      options: { cutout: "70%", plugins: { legend: { position: "right" } } },
    });
  } else {
    $("#winloss-chart").parentElement.innerHTML = '<p class="empty">sin partidas todavía</p>';
  }

  const select = $("#stats-game");
  const draw = () => {
    state.charts.filter((c) => c.canvas?.id === "game-evolution-chart").forEach((c) => c.destroy());
    state.charts = state.charts.filter((c) => c.canvas?.id !== "game-evolution-chart");
    evolutionChart($("#game-evolution-chart"), perGame.find((p) => String(p.game_id) === select.value));
  };
  if (select) {
    select.addEventListener("change", draw);
    draw();
  } else {
    $("#game-evolution-chart").parentElement.innerHTML = '<p class="empty">sin datos todavía</p>';
  }
};

/* ================================================================ calendario */

async function renderCalendar() {
  if (!state.calendar) {
    const t = parseISO(state.today);
    state.calendar = { year: t.getFullYear(), month: t.getMonth() + 1, selected: state.today };
  }
  const { year, month, selected } = state.calendar;
  const mm = String(month).padStart(2, "0");
  const first = `${year}-${mm}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const last = `${year}-${mm}-${String(daysInMonth).padStart(2, "0")}`;
  const sessions = await api(`/api/sessions?date_from=${first}&date_to=${last}&order=asc`);
  const byDay = {};
  sessions.forEach((s) => (byDay[s.played_at] ||= []).push(s));

  const offset = (parseISO(first).getDay() + 6) % 7; // lunes = 0
  const cells = ["lu", "ma", "mi", "ju", "vi", "sá", "do"].map((d) => `<div class="cal-dow">${d}</div>`);
  for (let i = 0; i < offset; i++) cells.push('<div class="cal-day blank"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${mm}-${String(d).padStart(2, "0")}`;
    const list = byDay[iso] || [];
    const cls = [
      "cal-day",
      list.length ? "played" : "",
      iso === state.today ? "today" : "",
      iso === selected ? "selected" : "",
      iso > state.today ? "future" : "",
    ].join(" ");
    const shown = list.slice(0, 4).map((s) => gicon(gameById(s.game_id), "sm")).join("");
    const icons = list.length > 4 ? `${shown}<span class="more">+${list.length - 4}</span>` : shown;
    const label = `${d} de ${MONTHS[month - 1]}: ${list.length ? `${list.length} partida(s)` : "sin partidas"}`;
    cells.push(`<button class="${cls}" data-day="${iso}" aria-label="${label}" ${iso > state.today ? "disabled" : ""}><span class="d">${String(d).padStart(2, " ")}</span><span class="icons" aria-hidden="true">${icons}</span>${list.length ? `<span class="cnt" aria-hidden="true">${list.length}</span>` : ""}</button>`);
  }

  const daySessions = byDay[selected] || [];
  const dayList = daySessions.map((s) => {
    const g = gameById(s.game_id);
    return `
      <li>
        ${gicon(g, "lg")}
        <div class="grow"><b>${esc(g?.name)}</b><div class="muted small">${g ? esc(sessionSummary(g, s)) : ""}${s.notes ? ` # ${esc(s.notes)}` : ""}</div></div>
        ${resultTag(s.result, { label: false })}
        <button class="btn" data-edit-session="${s.id}">editar</button>
      </li>`;
  }).join("");
  const playedDays = Object.keys(byDay).length;
  const selectedInMonth = selected?.startsWith(`${year}-${mm}`);

  return `
    ${pageHead({
      cmd: `cal ${month} ${year}`,
      title: "calendario",
      sub: `${playedDays} día(s) jugados este mes`,
      actions: `
        <span class="cal-head">
          <button class="btn" data-cal="-1" aria-label="Mes anterior">←</button>
          <h2>${MONTHS[month - 1]} ${year}</h2>
          <button class="btn" data-cal="1" aria-label="Mes siguiente">→</button>
          <button class="btn" data-cal="0">hoy</button>
        </span>`,
    })}
    <div class="grid-2" style="align-items:start">
      ${pane(`${MONTHS[month - 1]} ${year}`, `<div class="calendar">${cells.join("")}</div>`)}
      ${selectedInMonth
        ? pane(fmtDate(selected, { relative: false }), `
            ${dayList ? `<ul class="list">${dayList}</ul>` : '<p class="empty">no jugaste este día</p>'}
            <div class="card-actions" style="margin-top:10px"><button class="btn primary" data-log="" data-log-date="${selected}">+ registrar en este día</button></div>`,
          { aside: selected === state.today ? '<span class="muted">hoy</span>' : "" })
        : pane("día", '<p class="empty">selecciona un día</p>')}
    </div>`;
}

/* ================================================================ configuración */

function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function writePref(key, value) {
  try {
    if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch { /* almacenamiento no disponible */ }
}

const ACCENTS = [
  ["#4af626", "verde fósforo"], ["#5fd7ff", "cian"], ["#ffb000", "ámbar"], ["#ff5fd7", "magenta"],
  ["#ff5f56", "rojo"], ["#b18cff", "violeta"], ["#ffffff", "blanco"], ["#0d7a28", "verde bosque"],
];

/** Color de acento personalizado (vacío = el del tema). */
function setAccent(hex) {
  const root = document.documentElement.style;
  if (/^#[0-9a-f]{6}$/i.test(hex || "")) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
    root.setProperty("--accent", hex);
    root.setProperty("--glow", `rgba(${r}, ${g}, ${b}, 0.35)`);
    root.setProperty("--accent-ink", 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#050805" : "#ffffff");
    writePref("dle-accent", hex);
  } else {
    for (const p of ["--accent", "--glow", "--accent-ink"]) root.removeProperty(p);
    writePref("dle-accent", null);
  }
  refresh();
}

function applyTheme(theme) {
  writePref("dle-theme", theme === "system" ? null : theme);
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

async function renderSettings() {
  const theme = readPref("dle-theme", "system");
  const crt = readPref("dle-crt", "on");
  const bit = readPref("dle-bit", "on");
  const density = readPref("dle-density", "normal");
  const accent = readPref("dle-accent", "");
  const opt = (name, value, label, current) =>
    `<label><input type="radio" name="${name}" value="${value}" ${current === value ? "checked" : ""}><span>${label}</span></label>`;
  return `
    ${pageHead({ cmd: "vim ~/.config/dle/config", title: "configuración" })}
    <div class="grid-2" style="align-items:start">
      <div class="stack">
        ${pane("tema", `
          <div class="segmented" id="theme-picker" style="grid-template-columns:repeat(2,1fr)">
            ${opt("theme", "system", "sistema", theme)}${opt("theme", "phosphor", "phosphor", theme)}
            ${opt("theme", "amber", "amber", theme)}${opt("theme", "paper", "paper (claro)", theme)}
          </div>
          <p class="muted small">«sistema» usa phosphor en modo oscuro y paper en modo claro.</p>`)}
        ${pane("color de acento", `
          <div class="swatch-picker" id="accent-picker">
            ${ACCENTS.map(([hex, name]) => `<button type="button" class="swatch ${accent === hex ? "on" : ""}" data-accent="${hex}"
              style="--sw:${hex}" title="${name}" aria-label="${name}"></button>`).join("")}
            <label class="swatch custom" title="Elegir otro color"><input type="color" id="accent-custom" value="${accent || "#4af626"}"></label>
          </div>
          <div class="card-actions" style="margin-top:10px"><button class="btn" data-accent="">restablecer (según el tema)</button></div>`)}
        ${pane("efectos", `
          <div class="segmented" id="crt-picker">
            ${opt("crt", "on", "scanlines on", crt)}${opt("crt", "off", "scanlines off", crt)}
          </div>
          <div class="segmented" id="bit-picker" style="margin-top:8px">
            ${opt("bit", "on", "mostrar a Bit", bit)}${opt("bit", "off", "ocultar a Bit", bit)}
          </div>
          <div class="segmented" id="density-picker" style="margin-top:8px">
            ${opt("density", "normal", "tarjetas completas", density)}${opt("density", "compact", "tarjetas compactas", density)}
          </div>`)}
      </div>
      <div class="stack">
        ${pane("usuario", `
          <label class="field">nombre en el prompt
            <input id="user-input" maxlength="20" value="${esc(userName())}" autocomplete="off" spellcheck="false">
          </label>`)}
        ${pane("datos", `
          <p class="dim small">Tus juegos y partidas se guardan <b>solo en este navegador</b> (localStorage).
          Exporta una copia para no perderlos o para pasarlos a otro dispositivo.</p>
          <div class="card-actions">
            <button class="btn primary" id="export-btn">⬇ exportar json</button>
            <button class="btn" id="import-btn">⬆ importar json</button>
            <input type="file" id="import-file" accept="application/json,.json" hidden>
          </div>
          <p class="muted small">Importar reemplaza los datos actuales. Acepta copias de esta app y de la versión con servidor.</p>`)}
        ${pane("zona peligrosa", `
          <p class="dim small">Borra todos los juegos y partidas de este navegador y vuelve a los juegos de ejemplo.</p>
          <button class="btn danger" id="reset-btn">rm -rf ~/.dle</button>`)}
        ${pane("atajos", kv([
          [": o ctrl+k", "paleta de comandos"],
          ["1-8", "navegar entre secciones"],
          ["/", "buscar juegos nuevos"],
          ["r", "girar la ruleta"],
          ["n", "registrar partida"],
          ["esc", "cerrar ventana"],
        ]))}
      </div>
    </div>`;
}

afterRender.settings = () => {
  $("#theme-picker").addEventListener("change", (e) => applyTheme(e.target.value));
  $("#accent-picker").addEventListener("click", (e) => {
    const b = e.target.closest("[data-accent]");
    if (b) setAccent(b.dataset.accent);
  });
  $("#accent-custom").addEventListener("change", (e) => setAccent(e.target.value));
  $("[data-accent='']")?.addEventListener("click", () => setAccent(""));
  $("#bit-picker").addEventListener("change", (e) => {
    writePref("dle-bit", e.target.value === "off" ? "off" : null);
    if (e.target.value === "off") document.documentElement.dataset.bit = "off";
    else delete document.documentElement.dataset.bit;
  });
  $("#density-picker").addEventListener("change", (e) => {
    writePref("dle-density", e.target.value === "compact" ? "compact" : null);
    if (e.target.value === "compact") document.documentElement.dataset.density = "compact";
    else delete document.documentElement.dataset.density;
  });
  $("#crt-picker").addEventListener("change", (e) => {
    writePref("dle-crt", e.target.value === "off" ? "off" : null);
    if (e.target.value === "off") document.documentElement.dataset.crt = "off";
    else delete document.documentElement.dataset.crt;
  });
  $("#user-input").addEventListener("change", (e) => {
    const value = e.target.value.trim().replace(/\s+/g, "_");
    writePref("dle-user", value || null);
    toast(`usuario: ${userName()}`);
    refresh();
  });
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      return toast("El archivo no es un JSON válido", "error");
    }
    const ok = await confirmDialog("importar copia", `Se reemplazarán todos tus datos actuales por los de «${file.name}».`, "importar");
    if (!ok) return;
    try {
      const r = await api("/api/import", { method: "POST", body: payload });
      toast(`importados ${r.games} juego(s) y ${r.sessions} partida(s)`);
      refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#reset-btn").addEventListener("click", async () => {
    const ok = await confirmDialog("rm -rf ~/.dle", "Se borrarán todos tus juegos y partidas de este navegador. Exporta una copia antes si quieres conservarlos.", "borrar todo");
    if (!ok) return;
    await api("/api/reset", { method: "POST" });
    state.calendar = null;
    state.roulette.log = [];
    state.roulette.result = null;
    toast("datos borrados");
    refresh();
  });
  $("#export-btn").addEventListener("click", async () => {
    try {
      const data = await api("/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `dle-games-${state.today}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast(err.message, "error");
    }
  });
};

/* ================================================================ formulario de juego */

const gameForm = $("#game-form");

function updatePrimaryOptions(preferred) {
  const select = gameForm.elements.primary_metric;
  const current = preferred || select.value;
  const tracked = Object.keys(METRICS).filter((m) => gameForm.elements[METRICS[m].flag].checked);
  select.innerHTML = tracked.map((m) => `<option value="${m}">${METRICS[m].label}</option>`).join("")
    || '<option value="">— marca al menos una métrica —</option>';
  select.value = tracked.includes(current) ? current : tracked[0] || "";
}

function openGameForm(game = null) {
  gameForm.reset();
  showFormError(gameForm, "");
  gameForm.dataset.id = game?.id ?? "";
  $("#game-form-title").textContent = game ? `editar ${slug(game.name)}` : "nuevo juego";
  const g = game || { name: "", icon: "", url: "", category: "", description: "", active: true,
    track_attempts: true, track_errors: false, track_score: false, track_time: false,
    primary_metric: "attempts", lower_is_better: true };
  for (const key of ["name", "icon", "url", "category", "description"]) gameForm.elements[key].value = g[key] ?? "";
  for (const key of ["track_attempts", "track_errors", "track_score", "track_time", "active", "lower_is_better"]) {
    gameForm.elements[key].checked = !!g[key];
  }
  $("#active-field").hidden = !game;
  renderCategoryPicker(g.category || "");
  renderEmojiPicker();
  $$('#day-picker input').forEach((c) => { c.checked = Array.isArray(g.days) && g.days.includes(Number(c.value)); });
  renderIconStatus(game);
  updatePrimaryOptions(g.primary_metric);
  $("#game-dialog").showModal();
  gameForm.elements.name.focus();
}

/** Estado del favicon dentro del formulario de juego. */
function renderIconStatus(game) {
  const box = $("#icon-status");
  if (!game) {
    box.innerHTML = '<span class="muted">el icono se descargará automáticamente desde la url</span>';
    return;
  }
  box.innerHTML = game.icon_url
    ? `${gicon(game, "xl")} <span class="dim">obtenido de la web del juego</span>
       <button type="button" class="btn" data-icon-refresh="${game.id}">↻ actualizar</button>
       <button type="button" class="btn danger" data-icon-remove="${game.id}">quitar</button>`
    : `<span class="muted">sin icono descargado: se usa el emoji</span>
       ${game.url ? `<button type="button" class="btn" data-icon-refresh="${game.id}">↻ obtener de la url</button>` : ""}`;
}

async function iconAction(id, method) {
  const box = $("#icon-status");
  if (method === "POST") box.innerHTML = '<span class="dim">buscando el mejor icono<span class="cursor"></span></span>';
  try {
    const game = await api(`/api/games/${id}/icon`, { method });
    state.games = state.games.map((g) => (g.id === game.id ? game : g));
    renderIconStatus(game);
    toast(method === "POST" ? "icono actualizado" : "icono quitado");
    refresh();
  } catch (err) {
    renderIconStatus(gameById(id));
    toast(err.message, "error");
  }
}

gameForm.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (t?.dataset.iconRefresh) iconAction(Number(t.dataset.iconRefresh), "POST");
  else if (t?.dataset.iconRemove) iconAction(Number(t.dataset.iconRemove), "DELETE");
});

/* --- selector de categoría e icono --- */

const EMOJIS = ["🟩", "🟨", "🟪", "🟦", "🟥", "🔤", "🧩", "🧠", "🧮", "🌍", "🗺️", "🚩", "🎬", "📺", "🎵", "🎮",
  "⚽", "🃏", "🔬", "🎨", "🍔", "🚗", "📜", "❓", "📏", "🔷", "🎯", "⭐", "🔥", "💎", "🐱", "🎲"];

/** Categorías del catálogo (con su icono) más las que ya usas. */
function categoryOptions(current) {
  const options = Object.values(DleCatalog.CATEGORIES).map(([label, icon]) => ({ label, icon }));
  const known = new Set(options.map((o) => o.label.toLowerCase()));
  for (const c of [...state.games.map((g) => g.category), current]) {
    if (c && !known.has(c.toLowerCase())) {
      known.add(c.toLowerCase());
      options.push({ label: c, icon: "🏷️", custom: true });
    }
  }
  return options;
}

function renderCategoryPicker(current) {
  const options = categoryOptions(current);
  const match = options.find((o) => o.label.toLowerCase() === current.toLowerCase());
  $("#cat-picker").innerHTML = `
    <label><input type="radio" name="cat-choice" value="" ${current ? "" : "checked"}><span class="muted">ninguna</span></label>
    ${options.map((o) => `<label><input type="radio" name="cat-choice" value="${esc(o.label)}" data-icon="${esc(o.icon)}"
      ${match === o ? "checked" : ""}><span>${o.icon} ${esc(o.label.toLowerCase())}</span></label>`).join("")}
    <label><input type="radio" name="cat-choice" value="__other"><span>＋ otra</span></label>`;
  const input = $("#category-input");
  input.value = current;
  input.hidden = true;
}

function renderEmojiPicker() {
  const current = gameForm.elements.icon.value;
  const catIcon = $('#cat-picker input:checked')?.dataset.icon;
  const list = [...new Set([catIcon, ...EMOJIS].filter((x) => x && x !== "🏷️"))];
  $("#emoji-picker").innerHTML = list.map((e) => `<button type="button" class="emoji ${e === current ? "on" : ""}" data-emoji-pick="${e}"
    aria-label="Usar ${e}">${e}</button>`).join("");
}

$("#cat-picker").addEventListener("change", (e) => {
  const input = $("#category-input");
  if (e.target.value === "__other") {
    input.hidden = false;
    input.value = "";
    input.focus();
    return;
  }
  input.hidden = true;
  input.value = e.target.value;
  // Sugerir el icono de la categoría si el actual es genérico.
  const icon = gameForm.elements.icon;
  const generic = !icon.value || icon.value === "🎮" || Object.values(DleCatalog.CATEGORIES).some(([, i]) => i === icon.value);
  if (generic && e.target.dataset.icon && e.target.dataset.icon !== "🏷️") icon.value = e.target.dataset.icon;
  renderEmojiPicker();
});

$("#emoji-picker").addEventListener("click", (e) => {
  const b = e.target.closest("[data-emoji-pick]");
  if (!b) return;
  gameForm.elements.icon.value = b.dataset.emojiPick;
  renderEmojiPicker();
});
gameForm.elements.icon.addEventListener("input", renderEmojiPicker);

gameForm.addEventListener("change", (e) => {
  if (e.target.name?.startsWith("track_")) updatePrimaryOptions();
  if (e.target.name === "primary_metric") {
    // Por defecto: en puntaje más es mejor; en intentos, errores y tiempo, menos.
    gameForm.elements.lower_is_better.checked = e.target.value !== "score";
  }
});

gameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = gameForm.elements;
  const name = el.name.value.trim();
  if (!name) return showFormError(gameForm, "El nombre es obligatorio.");
  if (el.url.value.trim() && !/^https?:\/\/[^\s/]+/i.test(el.url.value.trim())) {
    return showFormError(gameForm, "La URL debe comenzar con http:// o https://");
  }
  if (!el.primary_metric.value) return showFormError(gameForm, "Selecciona al menos una métrica.");
  const payload = {
    name,
    icon: el.icon.value.trim() || "🎮",
    url: el.url.value.trim() || null,
    category: el.category.value.trim(),
    description: el.description.value.trim(),
    track_attempts: el.track_attempts.checked,
    track_errors: el.track_errors.checked,
    track_score: el.track_score.checked,
    track_time: el.track_time.checked,
    primary_metric: el.primary_metric.value,
    lower_is_better: el.lower_is_better.checked,
    days: $$('#day-picker input:checked').map((c) => Number(c.value)),
  };
  const id = gameForm.dataset.id;
  if (id) payload.active = el.active.checked;
  const submit = gameForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  const urlChanged = payload.url && payload.url !== (gameById(id)?.url ?? null);
  if (urlChanged) submit.textContent = "buscando icono…";
  try {
    const game = await api(id ? `/api/games/${id}` : "/api/games", { method: id ? "PUT" : "POST", body: payload });
    $("#game-dialog").close();
    toast(id ? "juego actualizado" : `${name} agregado`);
    if (urlChanged && !game.icon_url) toast("no se encontró icono en la url: se usará el emoji", "error");
    refresh();
  } catch (err) {
    showFormError(gameForm, err.message);
  } finally {
    submit.disabled = false;
    submit.textContent = "guardar";
  }
});

/* ================================================================ formulario de partida */

const sessionForm = $("#session-form");

function metricFieldHtml(metric, value) {
  const def = METRICS[metric];
  if (metric === "time_seconds") {
    return `<label class="field">tiempo (m:ss o segundos)
      <input name="time_seconds" inputmode="numeric" placeholder="1:30" value="${value != null ? fmtTime(value) : ""}" autocomplete="off"></label>`;
  }
  const input = `<input name="${metric}" type="number" inputmode="${metric === "score" ? "decimal" : "numeric"}" ${metric === "score" ? 'step="any"' : 'min="0" step="1"'} value="${value ?? ""}">`;
  if (!def.quick) return `<label class="field">${def.label}${input}</label>`;
  const buttons = def.quick.map((n) => `<button type="button" data-quick="${metric}" data-value="${n}" class="${value === n ? "selected" : ""}">${n}</button>`).join("");
  return `<div class="field"><span class="field-label">${def.label}</span><div class="quick">${buttons}${input}</div></div>`;
}

function renderMetricFields(game, values) {
  $("#metric-fields").innerHTML = trackedMetrics(game).map((m) => metricFieldHtml(m, values[m])).join("");
}

/**
 * Abre el formulario de partida.
 * - session: edita una partida existente.
 * - gameId: registra para ese juego (si ya hay partida ese día, la edita).
 * - sin gameId: muestra selector de juego.
 */
async function openSessionForm({ gameId = null, session = null, date = null, fromPlay = false } = {}) {
  sessionForm.reset();
  showFormError(sessionForm, "");
  if (!state.overview) await loadOverview();
  const el = sessionForm.elements;
  const playedAt = session?.played_at || date || state.today;

  if (!session && gameId) {
    const existing = await api(`/api/sessions?game_id=${gameId}&date_from=${playedAt}&date_to=${playedAt}`);
    if (existing.length) session = existing[0];
  }
  const fixedGame = session?.game_id ?? gameId;
  const activeGames = state.games.filter((g) => g.active || g.id === fixedGame);
  if (!activeGames.length) return toast("Primero agrega un juego.", "error");
  el.game_id.innerHTML = activeGames.map((g) => `<option value="${g.id}">${esc(g.icon)} ${esc(g.name)}</option>`).join("");
  // Sin juego fijo, proponer el primer pendiente de hoy.
  const firstPending = state.overview?.pending_today.find((id) => activeGames.some((g) => g.id === id));
  el.game_id.value = fixedGame ?? firstPending ?? activeGames[0].id;
  $("#session-game-field").hidden = !!fixedGame;

  sessionForm.dataset.id = session?.id ?? "";
  $("#session-delete").hidden = !session;
  el.played_at.value = playedAt;
  el.played_at.max = state.today;
  syncDateChips();
  el.notes.value = session?.notes ?? "";
  $("#notes-details").open = !!session?.notes;
  $("#share-input").value = "";
  $("#share-detected").textContent = "";
  $("#paste-details").open = false;
  fillForGame(session);
  $("#session-dialog").showModal();
  const firstMetric = $("#metric-fields input");
  (firstMetric || sessionForm.querySelector('[name="result"]:checked'))?.focus();
  // Si el navegador ya dio permiso, leer el resultado copiado sin preguntar.
  if (!session && fromPlay) tryClipboard({ silent: true });
}

function syncDateChips() {
  const v = sessionForm.elements.played_at.value;
  const when = v === state.today ? "today" : v === addDays(state.today, -1) ? "yesterday" : "other";
  sessionForm.elements.when.value = when;
  sessionForm.elements.played_at.classList.toggle("collapsed", when !== "other");
}

/** Lee el portapapeles y lo interpreta. `silent`: solo si ya hay permiso, sin avisos. */
async function tryClipboard({ silent = false } = {}) {
  if (!navigator.clipboard?.readText) {
    if (!silent) {
      $("#paste-details").open = true;
      $("#share-input").focus();
    }
    return;
  }
  try {
    if (silent) {
      const perm = await navigator.permissions?.query({ name: "clipboard-read" }).catch(() => null);
      if (perm?.state !== "granted") return;
    }
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      if (!silent) $("#share-detected").textContent = "el portapapeles está vacío";
      return;
    }
    $("#share-input").value = text;
    applySharedResult(text);
  } catch {
    if (!silent) {
      $("#share-detected").textContent = "no pude leer el portapapeles: pega el texto aquí abajo";
      $("#paste-details").open = true;
      $("#share-input").focus();
    }
  }
}

$("#paste-clipboard").addEventListener("click", () => tryClipboard());
$("#date-chips").addEventListener("change", (e) => {
  const el = sessionForm.elements.played_at;
  if (e.target.value === "today") el.value = state.today;
  else if (e.target.value === "yesterday") el.value = addDays(state.today, -1);
  el.classList.toggle("collapsed", e.target.value !== "other");
  if (e.target.value === "other") el.focus();
});
sessionForm.elements.played_at.addEventListener("change", syncDateChips);

/** Ajusta título, resultado y métricas al juego seleccionado. */
function fillForGame(session = null) {
  const el = sessionForm.elements;
  const game = gameById(el.game_id.value);
  const suggested = state.overview?.games.find((c) => c.game_id === game.id)?.suggested || {};
  const values = session || {
    result: suggested.result || "win",
    attempts: suggested.attempts, errors: suggested.errors,
    score: suggested.score, time_seconds: suggested.time_seconds,
  };
  $("#session-form-title").textContent = `${session ? "editar" : "registrar"} · ${slug(game.name)}`;
  el.result.value = values.result || "win";
  renderMetricFields(game, values);
  const since = playingSince(game.id);
  $("#session-head").innerHTML = `${gicon(game, "xl")}<div><b>${esc(game.name)}</b>
    <div class="muted small">${since ? `jugando desde hace <span class="num">${elapsed(Date.now() - since)}</span>` : esc(game.category || "")}</div></div>`;
  const hint = $("#elapsed-hint");
  hint.hidden = !(since && game.track_time && !session);
  if (!hint.hidden) {
    hint.innerHTML = `⏱ <span class="num" data-since="${since}">${elapsed(Date.now() - since)}</span> desde que abriste el juego
      <button type="button" class="btn" data-use-elapsed>usar como tiempo</button>`;
  }
}

sessionForm.addEventListener("change", (e) => {
  if (e.target.name === "game_id") fillForGame();
});

/** Rellena el formulario a partir del texto que comparte el juego. */
function applySharedResult(text) {
  const parsed = DleLogic.parseShare(text);
  const el = sessionForm.elements;
  const game = gameById(el.game_id.value);
  const applied = [];
  if (parsed.result) {
    el.result.value = parsed.result;
    applied.push(RESULT_LABEL[parsed.result]);
  }
  for (const metric of trackedMetrics(game)) {
    if (parsed[metric] === undefined) continue;
    const input = el[metric];
    input.value = metric === "time_seconds" ? fmtTime(parsed[metric]) : parsed[metric];
    input.dispatchEvent(new Event("input", { bubbles: true }));
    applied.push(`${fmtMetric(metric, parsed[metric])} ${METRICS[metric].label}`);
  }
  $("#share-detected").textContent = text.trim()
    ? (applied.length ? `detectado: ${applied.join(" · ")}` : "no reconocí el formato; completa los campos a mano")
    : "";
}

$("#share-input").addEventListener("input", (e) => applySharedResult(e.target.value));

sessionForm.addEventListener("click", (e) => {
  if (e.target.closest("[data-use-elapsed]")) {
    const since = playingSince(sessionForm.elements.game_id.value);
    const input = sessionForm.elements.time_seconds;
    if (since && input) input.value = elapsed(Date.now() - since);
    return;
  }
  const btn = e.target.closest("[data-quick]");
  if (!btn) return;
  const input = sessionForm.elements[btn.dataset.quick];
  input.value = btn.dataset.value;
  $$(`[data-quick="${btn.dataset.quick}"]`, sessionForm).forEach((b) => b.classList.toggle("selected", b === btn));
});

sessionForm.addEventListener("input", (e) => {
  if (METRICS[e.target.name]?.quick) {
    $$(`[data-quick="${e.target.name}"]`, sessionForm).forEach((b) => b.classList.toggle("selected", b.dataset.value === e.target.value));
  }
  e.target.removeAttribute("aria-invalid");
});

sessionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const el = sessionForm.elements;
  const game = gameById(el.game_id.value);
  const payload = {
    game_id: game.id,
    played_at: el.played_at.value,
    result: el.result.value,
    notes: el.notes.value.trim(),
  };
  if (!payload.played_at) return showFormError(sessionForm, "La fecha es obligatoria.");
  if (payload.played_at > state.today) return showFormError(sessionForm, "La fecha no puede estar en el futuro.");
  if (!payload.result) return showFormError(sessionForm, "Elige victoria o derrota.");

  for (const metric of trackedMetrics(game)) {
    const input = el[metric];
    const raw = input.value.trim();
    if (raw === "") { payload[metric] = null; continue; }
    const value = metric === "time_seconds" ? parseTime(raw) : Number(raw);
    const invalid = !Number.isFinite(value)
      || (metric !== "score" && (value < 0 || !Number.isInteger(value)));
    if (invalid) {
      input.setAttribute("aria-invalid", "true");
      input.focus();
      const hint = metric === "time_seconds" ? "usa m:ss o segundos" : metric === "score" ? "debe ser un número" : "debe ser un entero ≥ 0";
      return showFormError(sessionForm, `${METRICS[metric].label}: ${hint}.`);
    }
    payload[metric] = value;
  }

  const id = sessionForm.dataset.id;
  try {
    await api(id ? `/api/sessions/${id}` : "/api/sessions", { method: id ? "PUT" : "POST", body: payload });
    stopPlaying(game.id);
    $("#session-dialog").close();
    toast(id ? "partida actualizada" : `${game.name} registrado`);
    refresh();
  } catch (err) {
    showFormError(sessionForm, err.message);
  }
});

async function deleteSession(id) {
  const ok = await confirmDialog("rm partida", "Esta partida se eliminará definitivamente.");
  if (!ok) return false;
  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    toast("partida eliminada");
    refresh();
    return true;
  } catch (err) {
    toast(err.message, "error");
    return false;
  }
}

$("#session-delete").addEventListener("click", async () => {
  const id = sessionForm.dataset.id;
  $("#session-dialog").close();
  await deleteSession(id);
});

/* ================================================================ acciones globales */

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  const d = t.dataset;
  // «Jugar»: el enlace abre la pestaña del juego y la app queda esperando.
  if (d.play) {
    startPlaying(d.play);
    if (state.route === "dashboard") refresh();
    return;
  }
  try {
    if ("newGame" in d) openGameForm();
    else if (d.editGame) openGameForm(gameById(d.editGame));
    else if ("log" in d) await openSessionForm({ gameId: d.log ? Number(d.log) : null, date: d.logDate || null });
    else if (d.editSession) await openSessionForm({ session: await api(`/api/sessions/${d.editSession}`) });
    else if (d.deleteSession) await deleteSession(d.deleteSession);
    else if ("spinLink" in d) state.roulette.autoSpin = true;
    else if (d.quicklog) {
      t.disabled = true;
      await quickLog(Number(d.quicklog), d.value);
    } else if (d.stopPlaying) {
      stopPlaying(d.stopPlaying);
      if (state.route === "dashboard") refresh();
    }
    else if ("toggleSound" in d) {
      writePref("dle-sound", readPref("dle-sound", "off") === "on" ? null : "on");
      beep(1200, 40);
      refresh();
    } else if ("shuffleQueue" in d) {
      const ids = roulettePool(state.roulette.pool === "favorites" ? "favorites" : "pending").map((g) => g.id);
      const pool = ids.length ? ids : roulettePool("all").map((g) => g.id);
      for (let i = pool.length - 1; i > 0; i--) {
        const k = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[k]] = [pool[k], pool[i]];
      }
      saveQueue(pool);
      rouletteLog(`<b>$</b> shuf pendientes.txt > cola_${state.today}.txt  (${pool.length})`);
      refresh();
    } else if ("clearQueue" in d) {
      saveQueue(null);
      refresh();
    }
    else if (d.fav) {
      const g = gameById(d.fav);
      await api(`/api/games/${g.id}`, { method: "PUT", body: { favorite: !g.favorite } });
      refresh();
    } else if ("shareDay" in d) {
      toast(await copyText(daySummaryText()) ? "resumen copiado: pégalo donde quieras" : "no se pudo copiar", "info");
    } else if (d.addCatalog) await addFromCatalog(d.addCatalog, t);
    else if ("more" in d) {
      state.discover.limit += 48;
      refreshDiscoverResults();
    } else if ("surprise" in d) {
      const pool = filteredCatalog().filter((g) => !catalogAddedIndex()(g));
      const all = pool.length ? pool : state.discover.catalog.games;
      state.discover.suggestion = all[Math.floor(Math.random() * all.length)].id;
      refreshDiscoverResults();
      $("#discover-results").scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "start" });
    } else if ("catalogRefresh" in d) {
      t.disabled = true;
      try {
        state.discover.catalog = await DleCatalog.load(STORAGE, { force: true });
        toast(`catálogo actualizado: ${state.discover.catalog.games.length} juegos`);
      } catch (err) {
        toast(err.message, "error");
      }
      refresh();
    }
    else if ("fetchIcons" in d) {
      t.disabled = true;
      t.textContent = "buscando…";
      const r = await api("/api/games/icons/fetch-missing", { method: "POST" });
      toast(`iconos: ${r.updated.length} descargado(s)${r.failed.length ? `, sin icono: ${r.failed.join(", ")}` : ""}`, r.failed.length && !r.updated.length ? "error" : "info");
      refresh();
    }
    else if (d.toggleGame) {
      const g = gameById(d.toggleGame);
      await api(`/api/games/${g.id}`, { method: "PUT", body: { active: !g.active } });
      toast(`${g.name} ${g.active ? "desactivado" : "activado"}`);
      refresh();
    } else if (d.deleteGame) {
      const g = gameById(d.deleteGame);
      const ok = await confirmDialog(
        `rm -rf ${slug(g.name)}`,
        `Se eliminará «${g.name}» y TODAS sus partidas. No se puede deshacer. Si solo quieres ocultarlo, usa «desactivar».`,
      );
      if (!ok) return;
      await api(`/api/games/${g.id}`, { method: "DELETE" });
      toast(`${g.name} eliminado`);
      if (location.hash.startsWith("#/game/")) location.hash = "#/games"; else refresh();
    } else if ("toggleOrder" in d) {
      state.history.order = state.history.order === "desc" ? "asc" : "desc";
      refresh();
    } else if ("clearFilters" in d) {
      state.history = { game_id: "", result: "", date_from: "", date_to: "", order: state.history.order };
      refresh();
    } else if (d.historyGame) {
      state.history = { game_id: d.historyGame, result: "", date_from: "", date_to: "", order: "desc" };
    } else if (d.day) {
      state.calendar.selected = d.day;
      refresh();
    } else if (d.cal !== undefined) {
      const c = state.calendar;
      if (d.cal === "0") {
        state.calendar = null;
      } else {
        const next = new Date(c.year, c.month - 1 + Number(d.cal), 1);
        state.calendar = { year: next.getFullYear(), month: next.getMonth() + 1, selected: c.selected };
      }
      refresh();
    }
  } catch (err) {
    toast(err.message, "error");
  }
});

/* ================================================================ paleta de comandos */

const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Todas las acciones disponibles ahora mismo. */
function paletteCommands(query) {
  const cmds = [];
  const add = (label, hint, run) => cmds.push({ label, hint, run });
  const names = { dashboard: "dashboard", games: "juegos", discover: "descubrir", roulette: "ruleta",
    history: "historial", stats: "estadísticas", calendar: "calendario", settings: "configuración" };
  NAV_ORDER.forEach((r, i) => add(`ir a ${names[r]}`, String(i + 1), () => { location.hash = `#/${r}`; }));
  const pending = new Set(state.overview?.pending_today || []);
  for (const g of [...state.games].filter((x) => x.active).sort((a, b) => pending.has(b.id) - pending.has(a.id))) {
    if (g.url) add(`jugar ${g.name}`, pending.has(g.id) ? "pendiente" : "", () => { startPlaying(g.id); window.open(g.url, "_blank", "noopener"); });
    add(`registrar ${g.name}`, "", () => openSessionForm({ gameId: g.id }));
    add(`ver ${g.name}`, "", () => { location.hash = `#/game/${g.id}`; });
  }
  add("girar la ruleta", "r", () => { state.roulette.autoSpin = true; if (state.route === "roulette") spinRoulette(); else location.hash = "#/roulette"; });
  add("registrar partida", "n", () => openSessionForm());
  add("nuevo juego", "", () => openGameForm());
  add("compartir el día (copiar resumen)", "", async () => toast(await copyText(daySummaryText()) ? "resumen copiado" : "no se pudo copiar"));
  add("sorpréndeme con un juego nuevo", "", () => { state.discover.suggestion = null; location.hash = "#/discover"; });
  for (const t of ["sistema", "phosphor", "amber", "paper"]) add(`tema ${t}`, "", () => applyTheme(t === "sistema" ? "system" : t));
  add("exportar datos (json)", "", async () => { location.hash = "#/settings"; setTimeout(() => $("#export-btn")?.click(), 300); });
  if (query.trim()) {
    add(`buscar «${query.trim()}» en el catálogo`, "/", () => {
      state.discover.q = query.trim();
      state.discover.focus = true;
      if (state.route === "discover") refresh(); else location.hash = "#/discover";
    });
  }
  return cmds;
}

function filterCommands(query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const all = paletteCommands(query);
  if (!words.length) return all.slice(0, 12);
  return all
    .map((c) => ({ c, label: norm(c.label) }))
    .filter(({ c, label }) => words.every((w) => label.includes(w)) || c.label.startsWith("buscar «"))
    .sort((a, b) => (b.label.startsWith(words[0]) - a.label.startsWith(words[0])))
    .map(({ c }) => c)
    .slice(0, 12);
}

const palette = { items: [], index: 0 };

function renderPalette() {
  const list = $("#palette-list");
  palette.items = filterCommands($("#palette-q").value);
  palette.index = Math.min(palette.index, Math.max(palette.items.length - 1, 0));
  list.innerHTML = palette.items.map((c, i) => `<li role="option" data-i="${i}" aria-selected="${i === palette.index}"
    class="${i === palette.index ? "sel" : ""}"><span>${esc(c.label)}</span>${c.hint ? `<kbd>${esc(c.hint)}</kbd>` : ""}</li>`).join("")
    || '<li class="muted">sin coincidencias</li>';
}

function openPalette() {
  const dialog = $("#palette");
  if (dialog.open) return;
  $("#palette-q").value = "";
  palette.index = 0;
  renderPalette();
  dialog.showModal();
  $("#palette-q").focus();
}

function runPalette(i = palette.index) {
  const cmd = palette.items[i];
  if (!cmd) return;
  $("#palette").close();
  Promise.resolve(cmd.run()).catch((err) => toast(err.message, "error"));
}

$("#palette-q").addEventListener("input", () => { palette.index = 0; renderPalette(); });
$("#palette-q").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = palette.items.length || 1;
    palette.index = (palette.index + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPalette();
  }
});
$("#palette-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) runPalette(Number(li.dataset.i));
});
$("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") e.target.close(); });

/* Atajos de teclado: 1-8 navegan, : o Ctrl+K abre comandos, / busca, r gira la ruleta, n registra. */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (!document.querySelector("dialog[open]:not(#palette)")) openPalette();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (document.querySelector("dialog[open]")) return;
  // Solo se bloquean mientras se escribe (no en casillas ni botones de opción).
  const typing = e.target.closest("select, textarea, [contenteditable]")
    || (e.target.matches("input") && !["radio", "checkbox", "button", "submit", "range", "color"].includes(e.target.type));
  if (typing) return;
  const n = Number(e.key);
  if (n >= 1 && n <= NAV_ORDER.length) {
    location.hash = `#/${NAV_ORDER[n - 1]}`;
  } else if (e.key === "r") {
    if (state.route === "roulette") spinRoulette();
    else { state.roulette.autoSpin = true; location.hash = "#/roulette"; }
  } else if (e.key === ":") {
    openPalette();
  } else if (e.key === "/") {
    state.discover.focus = true;
    if (state.route === "discover") $("#discover-q")?.focus();
    else location.hash = "#/discover";
  } else if (e.key === "n") {
    openSessionForm().catch((err) => toast(err.message, "error"));
  } else {
    return;
  }
  e.preventDefault();
});

// Redibuja los gráficos si cambia el tema.
const redrawIfCharts = () => { if (state.charts.length) refresh(); };
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redrawIfCharts);
new MutationObserver(redrawIfCharts).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// App instalable y sin conexión (solo en https o localhost).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

Mascot.mountAll(document.querySelector(".sidebar"));
updateStatusBar();
if (!location.hash) history.replaceState(null, "", "#/dashboard");
router();
