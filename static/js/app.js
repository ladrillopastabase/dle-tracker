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
  dashboard: "~", games: "~/juegos", game: "~/juegos", roulette: "~/ruleta",
  history: "~/historial", stats: "~/stats", calendar: "~/calendario", settings: "~/.config",
};
const NAV_ORDER = ["dashboard", "games", "roulette", "history", "stats", "calendar", "settings"];
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  games: [],
  overview: null,
  today: localISO(new Date()),
  charts: [],
  route: "dashboard",
  history: { game_id: "", result: "", date_from: "", date_to: "", order: "desc" },
  calendar: null, // {year, month, selected}
  roulette: { onlyPending: true, rotation: 0, spinning: false, autoSpin: false, log: [], result: null },
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

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function userName() {
  try { return localStorage.getItem("dle-user") || "player"; } catch { return "player"; }
}

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

async function api(path, options = {}) {
  const init = { headers: {}, ...options };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error("No se pudo conectar con el servidor. ¿Está en ejecución?");
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : `Error ${response.status}`);
  }
  return data;
}

async function loadGames() {
  state.games = await api("/api/games");
  $("#category-list").innerHTML = [...new Set(state.games.map((g) => g.category).filter(Boolean))]
    .map((c) => `<option value="${esc(c)}">`).join("");
}

async function loadOverview() {
  state.overview = await api("/api/stats");
  state.today = state.overview.today;
  updateStatusBar();
  return state.overview;
}

/* ================================================================ UI genérica */

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), type === "error" ? 5000 : 2500);
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
    ? `racha ${o.current_streak}d | hoy ${o.played_today}/${o.total_games} | ${hhmm}`
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
  $("#titlebar-text").textContent = `${userName()}@dle: ${ROUTE_PATH[name]}`;
  destroyCharts();
  const view = $("#view");
  try {
    await loadGames();
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
    return { mood: "happy", text: `¡Todo jugado hoy! ${o.current_streak} día(s) de racha. Vuelve mañana.` };
  }
  if (o.current_streak > 0 && o.played_today === 0) {
    return { mood: "sad", text: `Tu racha de ${o.current_streak} día(s) está en peligro. ¡Juega algo hoy!` };
  }
  if (o.played_today === 0) {
    return { mood: "idle", text: `Hoy te esperan ${pending} juego(s). ¿No sabes por cuál empezar? Gira la ruleta [r].` };
  }
  return { mood: "idle", text: `Vas ${o.played_today}/${o.total_games}. Quedan ${pending}; si dudas, la ruleta elige por ti [r].` };
}

function gameCard(game, card) {
  const last = card?.last_session;
  const status = card?.played_today ? resultTag(last.result) : '<span class="tag pending">[PEND]</span> pendiente';
  const rows = [["estado", status]];
  if (last) {
    rows.push(["última", fmtDate(last.played_at)]);
    const summary = sessionSummary(game, last);
    if (summary) rows.push(["datos", esc(summary)]);
  } else {
    rows.push(["última", '<span class="muted">sin partidas</span>']);
  }
  rows.push(["racha", card?.current_streak
    ? `<span class="tag streak">${card.current_streak}d</span> ${asciiBar(Math.min(card.current_streak, 10), 10, 10)}`
    : '<span class="muted">—</span>']);
  const body = `
    ${kv(rows)}
    <div class="card-actions">
      ${game.url ? `<a class="btn" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer">▶ jugar</a>` : ""}
      <button class="btn primary" data-log="${game.id}">${card?.played_today ? "editar" : "+ registrar"}</button>
    </div>`;
  const title = `${esc(game.icon)} <a href="#/game/${game.id}">${esc(slug(game.name))}</a>`;
  return pane(title, body, { cls: `game-card ${card?.played_today ? "done" : ""}`, tag: "article" });
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
  const items = list.map((a) => `
    <li class="${a.unlocked ? "" : "locked"}">
      <span class="box">${a.unlocked ? "[x]" : "[ ]"}</span>
      <span>${a.icon} ${esc(a.title)}</span>
      ${a.unlocked ? "" : `<span>${asciiBar(a.progress, a.target, 12)} <span class="muted">${a.progress}/${a.target}</span></span>`}
    </li>`).join("");
  return pane("logros", `<ul class="achievements">${items}</ul>`);
}

async function renderDashboard() {
  const o = await loadOverview();
  const cards = Object.fromEntries(o.games.map((c) => [c.game_id, c]));
  const active = state.games.filter((g) => g.active);
  active.sort((a, b) => (cards[a.id]?.played_today - cards[b.id]?.played_today) || a.name.localeCompare(b.name));
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
          ["hoy", `${o.played_today}/${o.total_games} ${asciiBar(o.played_today, o.total_games || 1, 12)}`],
          ["partidas", o.total_sessions],
          ["victorias", `<span class="c-win">${o.wins}</span>`],
          ["derrotas", `<span class="c-loss">${o.losses}</span>`],
          ["% victorias", pct(o.win_rate)],
          ["racha", `<span class="c-streak">${o.current_streak} días</span>`],
          ["mejor racha", `${o.best_streak} días`],
        ])}
        <div class="swatches" aria-hidden="true">${swatches}</div>
        <div class="speech"><span data-text="${esc(text)}"></span></div>
      </div>
    </div>`;

  return `
    ${pageHead({
      cmd: "dlefetch",
      title: "dashboard",
      actions: `<a class="btn" href="#/roulette" data-spin-link>🎲 ruleta</a><button class="btn primary" data-new-game>+ juego</button>`,
    })}
    ${pane("sistema", fetch)}
    <section class="section">
      <div class="section-head">
        <div class="prompt"><span class="u">$</span> <span class="cmd">ls juegos/ --sort=pendientes</span></div>
        <span class="muted small">${o.pending_today.length ? `${o.pending_today.length} pendiente(s)` : "todo jugado ✓"}</span>
      </div>
      ${active.length
        ? `<div class="game-grid">${active.map((g) => gameCard(g, cards[g.id])).join("")}</div>`
        : pane("", '<p class="empty">no hay juegos activos <button class="btn primary" data-new-game>+ juego</button></p>')}
    </section>
    <section class="section grid-2">
      ${weekPane(o.week, { title: "esta semana" })}
      ${achievementsPane(o.achievements)}
    </section>`;
}

/* ================================================================ mis juegos */

async function renderGames() {
  const o = await loadOverview();
  const cards = Object.fromEntries(o.games.map((c) => [c.game_id, c]));
  const rows = state.games.map((g) => {
    const c = cards[g.id];
    return `
      <li class="manage-row ${g.active ? "" : "inactive"}">
        <span class="ls-perm">${g.active ? "-rwxr-xr-x" : "-r--r--r--"}</span>
        <span class="game-icon" aria-hidden="true">${esc(g.icon)}</span>
        <div class="grow">
          <a href="#/game/${g.id}"><b>${esc(g.name)}</b></a>
          ${g.category ? `<span class="tag cat">#${esc(slug(g.category))}</span>` : ""}
          ${g.active ? "" : '<span class="tag pending">[inactivo]</span>'}
          <div class="muted small">${esc(g.description || "")}${g.description ? " · " : ""}${c?.played || 0} partidas · métrica: ${METRICS[g.primary_metric].label}</div>
        </div>
        <span class="card-actions">
          ${g.url ? `<a class="btn" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer">▶</a>` : ""}
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
      actions: '<button class="btn primary" data-new-game>+ nuevo juego</button>',
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
      title: `${esc(game.icon)} ${esc(game.name)} ${game.active ? "" : '<span class="tag pending small">[inactivo]</span>'}`,
      sub: esc(game.description || game.category || ""),
      actions: `
        ${game.url ? `<a class="btn" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer">▶ jugar</a>` : ""}
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

function rouletteCandidates() {
  const active = state.games.filter((g) => g.active);
  if (!state.roulette.onlyPending) return active;
  const pending = new Set(state.overview?.pending_today || []);
  return active.filter((g) => pending.has(g.id));
}

function wheelSvg(games) {
  const R = 190;
  const n = games.length;
  const per = 360 / n;
  const point = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return [r * Math.sin(a), -r * Math.cos(a)];
  };
  const segs = games.map((g, i) => {
    const cls = `seg ${i % 2 ? "b" : "a"}`;
    let shape;
    if (n === 1) {
      shape = `<circle class="${cls}" r="${R}" data-seg="${i}"/>`;
    } else {
      const [x1, y1] = point(i * per - per / 2, R);
      const [x2, y2] = point(i * per + per / 2, R);
      shape = `<path class="${cls}" data-seg="${i}" d="M0 0 L${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${per > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z"/>`;
    }
    const name = g.name.length > 12 ? `${g.name.slice(0, 11)}…` : g.name;
    const label = `<text data-seg-label="${i}" transform="rotate(${i * per - 90}) translate(${R * 0.58} 0)" text-anchor="middle">${esc(g.icon)} ${esc(name)}</text>`;
    return shape + label;
  }).join("");
  return `<svg class="wheel" id="wheel" viewBox="-200 -200 400 400" role="img" aria-label="Ruleta con ${n} juegos"
    style="transform: rotate(${state.roulette.rotation}deg)">
    <circle r="198" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${segs}
  </svg>`;
}

async function renderRoulette() {
  const o = await loadOverview();
  const r = state.roulette;
  // Si ya está todo jugado, no tiene sentido filtrar por pendientes.
  if (r.onlyPending && !o.pending_today.length) r.onlyPending = false;
  const games = rouletteCandidates();
  state.wheelGames = games;
  const res = r.result && games.find((g) => g.id === r.result) ? gameById(r.result) : null;

  const wheel = games.length
    ? `<div class="wheel-wrap">
         <span class="wheel-pointer" aria-hidden="true">▼</span>
         ${wheelSvg(games)}
         <div class="wheel-hub"><span data-mascot="${r.spinning ? "spin" : res ? "happy" : "idle"}" data-scale="5" id="wheel-mascot"></span></div>
       </div>`
    : '<p class="empty">no hay juegos para girar</p>';

  const resultHtml = res
    ? `<div class="result-name">${esc(res.icon)} ${esc(res.name)}</div>
       <p class="dim small">${esc(res.description || "")}</p>
       <div class="card-actions">
         ${res.url ? `<a class="btn primary" href="${esc(res.url)}" target="_blank" rel="noopener noreferrer">▶ jugar ahora</a>` : ""}
         <button class="btn" data-log="${res.id}">+ registrar</button>
       </div>`
    : `<p class="dim">Pulsa <b>girar</b> (o la tecla <kbd>r</kbd>) y Bit elegirá un juego al azar.</p>`;

  return `
    ${pageHead({
      cmd: `shuf -n 1 ${r.onlyPending ? "pendientes_hoy" : "juegos_activos"}.txt`,
      title: "ruleta",
      sub: "¿No sabes qué jugar? Deja que el azar decida.",
    })}
    <div class="roulette">
      ${pane(`${games.length} juego(s)`, wheel)}
      <div class="stack">
        ${pane("opciones", `
          <div class="segmented" role="radiogroup" aria-label="Juegos en la ruleta">
            <label><input type="radio" name="pool" value="pending" ${r.onlyPending ? "checked" : ""} ${o.pending_today.length ? "" : "disabled"}><span>pendientes (${o.pending_today.length})</span></label>
            <label><input type="radio" name="pool" value="all" ${r.onlyPending ? "" : "checked"}><span>todos (${state.games.filter((g) => g.active).length})</span></label>
          </div>
          <div style="margin-top:14px"><button class="btn primary big" id="spin-btn" ${games.length && !r.spinning ? "" : "disabled"}>🎲 girar</button></div>`)}
        ${pane("resultado", `<div id="roulette-result">${resultHtml}</div>`)}
        ${pane("stdout", `<pre class="console-log" id="roulette-log">${r.log.length ? r.log.join("\n") : '<span class="muted">esperando…</span>'}</pre>`)}
      </div>
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
  const games = state.wheelGames || [];
  const wheel = $("#wheel");
  if (r.spinning || !games.length || !wheel) return;
  r.spinning = true;
  r.result = null;
  $("#spin-btn").disabled = true;
  $$("#wheel .win").forEach((el) => el.classList.remove("win"));
  Mascot.setMood($("#wheel-mascot"), "spin");
  $("#roulette-result").innerHTML = '<p class="dim">girando<span class="cursor"></span></p>';
  rouletteLog(`<b>$</b> shuf -n 1 ${r.onlyPending ? "pendientes_hoy" : "juegos_activos"}.txt`);

  const n = games.length;
  const per = 360 / n;
  const index = Math.floor(Math.random() * n);
  // Rotación necesaria para que el centro del segmento quede bajo el puntero (arriba).
  const target = ((-index * per) % 360 + 360) % 360;
  const current = ((r.rotation % 360) + 360) % 360;
  const jitter = (Math.random() - 0.5) * per * 0.6;
  r.rotation += 360 * 6 + ((target - current + 360) % 360) + jitter;
  const finish = () => {
    if (!r.spinning) return;
    r.spinning = false;
    const game = games[index];
    r.result = game.id;
    rouletteLog(`→ ${esc(game.icon)} ${esc(game.name)}`);
    if (state.route === "roulette") refresh();
  };
  wheel.addEventListener("transitionend", finish, { once: true });
  wheel.style.transform = `rotate(${r.rotation}deg)`;
  // Sin animación (movimiento reducido) transitionend no se dispara.
  setTimeout(finish, REDUCED_MOTION.matches ? 50 : 4600);
}

afterRender.roulette = () => {
  const r = state.roulette;
  if (r.result) {
    const i = (state.wheelGames || []).findIndex((g) => g.id === r.result);
    $(`#wheel [data-seg="${i}"]`)?.classList.add("win");
    $(`#wheel [data-seg-label="${i}"]`)?.classList.add("win");
  }
  $("#spin-btn")?.addEventListener("click", spinRoulette);
  $$('input[name="pool"]').forEach((input) => input.addEventListener("change", () => {
    r.onlyPending = input.value === "pending";
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
        <td class="nowrap" data-label="">${g ? `<a href="#/game/${g.id}">${esc(g.icon)} ${esc(g.name)}</a>` : "—"}</td>
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
  state.statsData = { o, perGame, recent, since };

  const rows = perGame.map((s) => {
    const g = gameById(s.game_id);
    const m = s.primary_metric;
    const trend = { improving: "▲", worsening: "▼", stable: "=", insufficient_data: "" }[s.trend.direction];
    const trendCls = { improving: "delta-good", worsening: "delta-bad" }[s.trend.direction] || "";
    return `
      <tr>
        <td class="nowrap"><a href="#/game/${g.id}">${esc(g.icon)} ${esc(g.name)}</a></td>
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
    const shown = list.slice(0, 4).map((s) => esc(gameById(s.game_id)?.icon || "•")).join("");
    const icons = list.length > 4 ? `${shown}<span class="more">+${list.length - 4}</span>` : shown;
    const label = `${d} de ${MONTHS[month - 1]}: ${list.length ? `${list.length} partida(s)` : "sin partidas"}`;
    cells.push(`<button class="${cls}" data-day="${iso}" aria-label="${label}" ${iso > state.today ? "disabled" : ""}><span class="d">${String(d).padStart(2, " ")}</span><span class="icons" aria-hidden="true">${icons}</span>${list.length ? `<span class="cnt" aria-hidden="true">${list.length}</span>` : ""}</button>`);
  }

  const daySessions = byDay[selected] || [];
  const dayList = daySessions.map((s) => {
    const g = gameById(s.game_id);
    return `
      <li>
        <span class="game-icon" aria-hidden="true">${esc(g?.icon)}</span>
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

function applyTheme(theme) {
  writePref("dle-theme", theme === "system" ? null : theme);
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

async function renderSettings() {
  const theme = readPref("dle-theme", "system");
  const crt = readPref("dle-crt", "on");
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
        ${pane("efectos", `
          <div class="segmented" id="crt-picker">
            ${opt("crt", "on", "scanlines on", crt)}${opt("crt", "off", "scanlines off", crt)}
          </div>`)}
      </div>
      <div class="stack">
        ${pane("usuario", `
          <label class="field">nombre en el prompt
            <input id="user-input" maxlength="20" value="${esc(userName())}" autocomplete="off" spellcheck="false">
          </label>`)}
        ${pane("datos", `
          <p class="dim small">Los datos viven en SQLite (<code>data/dle_games.db</code>).</p>
          <button class="btn primary" id="export-btn">⬇ exportar json</button>`)}
        ${pane("atajos", kv([
          ["1-7", "navegar entre secciones"],
          ["r", "girar la ruleta"],
          ["n", "registrar partida"],
          ["esc", "cerrar ventana"],
        ]))}
      </div>
    </div>`;
}

afterRender.settings = () => {
  $("#theme-picker").addEventListener("change", (e) => applyTheme(e.target.value));
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
  updatePrimaryOptions(g.primary_metric);
  $("#game-dialog").showModal();
  gameForm.elements.name.focus();
}

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
  };
  const id = gameForm.dataset.id;
  if (id) payload.active = el.active.checked;
  try {
    await api(id ? `/api/games/${id}` : "/api/games", { method: id ? "PUT" : "POST", body: payload });
    $("#game-dialog").close();
    toast(id ? "juego actualizado" : `${name} agregado`);
    refresh();
  } catch (err) {
    showFormError(gameForm, err.message);
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
async function openSessionForm({ gameId = null, session = null, date = null } = {}) {
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
  el.notes.value = session?.notes ?? "";
  $("#notes-details").open = !!session?.notes;
  fillForGame(session);
  $("#session-dialog").showModal();
  const firstMetric = $("#metric-fields input");
  (firstMetric || sessionForm.querySelector('[name="result"]:checked'))?.focus();
}

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
}

sessionForm.addEventListener("change", (e) => {
  if (e.target.name === "game_id") fillForGame();
});

sessionForm.addEventListener("click", (e) => {
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
  try {
    if ("newGame" in d) openGameForm();
    else if (d.editGame) openGameForm(gameById(d.editGame));
    else if ("log" in d) await openSessionForm({ gameId: d.log ? Number(d.log) : null, date: d.logDate || null });
    else if (d.editSession) await openSessionForm({ session: await api(`/api/sessions/${d.editSession}`) });
    else if (d.deleteSession) await deleteSession(d.deleteSession);
    else if ("spinLink" in d) state.roulette.autoSpin = true;
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

/* Atajos de teclado: 1-7 navegan, r gira la ruleta, n registra partida. */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.target.closest("input, select, textarea, [contenteditable]")) return;
  const n = Number(e.key);
  if (n >= 1 && n <= NAV_ORDER.length) {
    location.hash = `#/${NAV_ORDER[n - 1]}`;
  } else if (e.key === "r") {
    if (state.route === "roulette") spinRoulette();
    else { state.roulette.autoSpin = true; location.hash = "#/roulette"; }
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

Mascot.mountAll(document.querySelector(".sidebar"));
updateStatusBar();
if (!location.hash) history.replaceState(null, "", "#/dashboard");
router();
