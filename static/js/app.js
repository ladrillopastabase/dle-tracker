"use strict";

/* ================================================================ utilidades */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const METRICS = {
  attempts: { label: "Intentos", flag: "track_attempts", quick: [1, 2, 3, 4, 5, 6] },
  errors: { label: "Errores", flag: "track_errors", quick: [0, 1, 2, 3, 4] },
  score: { label: "Puntaje", flag: "track_score" },
  time_seconds: { label: "Tiempo", flag: "track_time" },
};
const RESULT_LABEL = { win: "Victoria", loss: "Derrota" };
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const state = {
  games: [],
  overview: null,
  today: localISO(new Date()),
  charts: [],
  history: { game_id: "", result: "", date_from: "", date_to: "", order: "desc" },
  calendar: null, // {year, month, selected}
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
  if (relative && iso === state.today) return "Hoy";
  if (relative && iso === addDays(state.today, -1)) return "Ayer";
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

function trackedMetrics(game) {
  return Object.keys(METRICS).filter((m) => game[METRICS[m].flag]);
}

function sessionSummary(game, s) {
  return trackedMetrics(game)
    .filter((m) => s[m] != null)
    .map((m) => `${fmtMetric(m, s[m])} ${METRICS[m].label.toLowerCase()}`)
    .join(" · ");
}

function resultBadge(result) {
  return `<span class="badge ${result}">${result === "win" ? "✓" : "✕"} ${RESULT_LABEL[result]}</span>`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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

function confirmDialog(title, text, okLabel = "Eliminar") {
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

// Cerrar modales con los botones [data-close].
document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) closer.closest("dialog").close();
});

/* ================================================================ gráficos */

function destroyCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
}

function chartTheme() {
  if (!window.Chart) return;
  Chart.defaults.font.family = cssVar("--font");
  Chart.defaults.color = cssVar("--text-2");
  Chart.defaults.borderColor = cssVar("--grid");
  Chart.defaults.plugins.tooltip.backgroundColor = cssVar("--text");
  Chart.defaults.plugins.tooltip.titleColor = cssVar("--bg");
  Chart.defaults.plugins.tooltip.bodyColor = cssVar("--bg");
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.boxHeight = 8;
  Chart.defaults.maintainAspectRatio = false;
}

function makeChart(canvas, config) {
  if (!window.Chart || !canvas) {
    if (canvas) canvas.parentElement.innerHTML = '<p class="empty">Gráficos no disponibles.</p>';
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
    canvas.parentElement.innerHTML = '<p class="empty">Aún no hay datos de la métrica principal.</p>';
    return;
  }
  const metric = stats.primary_metric;
  const values = points.map((p) => p.value);
  const win = cssVar("--win");
  const loss = cssVar("--loss");
  const accent = cssVar("--accent");
  makeChart(canvas, {
    type: "line",
    data: {
      labels: points.map((p) => fmtDate(p.date, { relative: false })),
      datasets: [
        {
          label: METRICS[metric].label,
          data: values,
          borderColor: accent,
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: points.map((p) => (p.result === "win" ? win : loss)),
          pointBorderColor: cssVar("--surface"),
          pointBorderWidth: 2,
          cubicInterpolationMode: "monotone",
        },
        {
          label: "Media móvil (7)",
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
          reverse: false,
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
              return p ? `Resultado: ${RESULT_LABEL[p.result]}` : "";
            },
          },
        },
      },
    },
  });
}

function distributionChart(canvas, stats) {
  if (!stats.distribution?.length) {
    canvas.parentElement.innerHTML = '<p class="empty">Sin distribución para esta métrica.</p>';
    return;
  }
  makeChart(canvas, {
    type: "bar",
    data: {
      labels: stats.distribution.map((d) => d.value),
      datasets: [{
        label: "Partidas",
        data: stats.distribution.map((d) => d.count),
        backgroundColor: cssVar("--accent"),
        borderRadius: 4,
        maxBarThickness: 36,
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
  history: renderHistory,
  stats: renderStats,
  calendar: renderCalendar,
  settings: renderSettings,
};

async function router() {
  const [name = "dashboard", param] = location.hash.replace(/^#\/?/, "").split("/");
  const render = routes[name] || renderDashboard;
  $$(".nav-link").forEach((a) => {
    const active = a.dataset.route === name || (name === "game" && a.dataset.route === "games");
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  destroyCharts();
  const view = $("#view");
  try {
    await loadGames();
    const html = await render(param);
    if (html !== undefined) {
      view.innerHTML = `<div class="view">${html}</div>`;
    }
    afterRender[name]?.(param);
  } catch (err) {
    view.innerHTML = `<div class="view card empty">⚠️ ${esc(err.message)}</div>`;
  }
}

const afterRender = {};

function refresh() {
  router();
}

window.addEventListener("hashchange", () => {
  router();
  $("#view").focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

/* ================================================================ dashboard */

function tile(label, value, extra = "") {
  return `<div class="card tile ${extra}"><div class="label">${label}</div><div class="value num">${value}</div></div>`;
}

function weekCard(week, { title = "Esta semana", metricKey = "attempts", lowerBetter = true } = {}) {
  const t = week.this_week;
  const l = week.last_week;
  const avgKey = `avg_${metricKey}`;
  const delta = week.delta[avgKey];
  let deltaHtml = '<span class="muted">—</span>';
  if (delta != null) {
    const better = delta === 0 ? null : (delta < 0) === lowerBetter;
    const cls = better == null ? "" : better ? "delta-good" : "delta-bad";
    const arrow = delta === 0 ? "=" : delta < 0 ? "▼" : "▲";
    deltaHtml = `<span class="${cls}">${arrow} ${fmtMetric(metricKey, Math.abs(delta))}</span>`;
  }
  return `
    <div class="card">
      <div class="section-head"><h2>📅 ${title}</h2><span class="muted small">${fmtDate(t.start, { relative: false })} – ${fmtDate(t.end, { relative: false })}</span></div>
      <div class="week-grid">
        <div><div class="muted small">Partidas</div><div class="value num">${t.played}</div></div>
        <div><div class="muted small">Victorias</div><div class="value num">${t.wins}</div></div>
        <div><div class="muted small">Derrotas</div><div class="value num">${t.losses}</div></div>
        <div><div class="muted small">Días jugados</div><div class="value num">${t.days_played}/7</div></div>
      </div>
      <div class="week-grid">
        <div><div class="muted small">Promedio ${METRICS[metricKey].label.toLowerCase()}</div><div class="value num">${fmtMetric(metricKey, t[avgKey])}</div></div>
        <div><div class="muted small">Semana anterior</div><div class="value num">${fmtMetric(metricKey, l[avgKey])}</div></div>
        <div><div class="muted small">Variación</div><div class="value num">${deltaHtml}</div></div>
      </div>
    </div>`;
}

function achievementsHtml(list) {
  return `<div class="achievements">${list.map((a) => `
    <div class="card achievement ${a.unlocked ? "" : "locked"}" title="${a.unlocked ? "Desbloqueado" : `Progreso ${a.progress}/${a.target}`}">
      <span class="a-icon" aria-hidden="true">${a.icon}</span>
      <div class="grow">
        <div><b>${esc(a.title)}</b></div>
        <div class="muted small">${a.unlocked ? "Desbloqueado" : `${a.progress} / ${a.target}`}</div>
        ${a.unlocked ? "" : `<div class="bar"><span style="width:${(100 * a.progress) / a.target}%"></span></div>`}
      </div>
    </div>`).join("")}</div>`;
}

function gameCard(game, card) {
  const last = card?.last_session;
  const lines = [];
  if (last) {
    lines.push(`<div>Última partida: <b>${fmtDate(last.played_at)}</b></div>`);
    lines.push(`<div>Resultado: <b>${RESULT_LABEL[last.result]}</b></div>`);
    const summary = sessionSummary(game, last);
    if (summary) lines.push(`<div>${esc(summary)}</div>`);
  } else {
    lines.push('<div class="muted">Sin partidas todavía</div>');
  }
  const status = card?.played_today
    ? resultBadge(last.result)
    : '<span class="badge pending">Pendiente</span>';
  const streak = card?.current_streak
    ? `<span class="badge streak">🔥 ${card.current_streak} ${card.current_streak === 1 ? "día" : "días"}</span>`
    : '<span class="muted small">Sin racha activa</span>';
  return `
    <article class="card game-card ${card?.played_today ? "done" : ""}">
      <div class="game-card-head">
        <span class="game-icon" aria-hidden="true">${esc(game.icon)}</span>
        <a class="game-title" href="#/game/${game.id}">${esc(game.name)}</a>
        <span class="ml-auto">${status}</span>
      </div>
      <div class="game-meta">${lines.join("")}</div>
      <div>${streak}</div>
      <div class="card-actions">
        ${game.url ? `<a class="btn" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer">▶ Jugar</a>` : ""}
        <button class="btn primary" data-log="${game.id}">${card?.played_today ? "✎ Editar hoy" : "＋ Registrar"}</button>
      </div>
    </article>`;
}

async function renderDashboard() {
  const o = await loadOverview();
  const cards = Object.fromEntries(o.games.map((c) => [c.game_id, c]));
  const active = state.games.filter((g) => g.active);
  // Pendientes primero, luego por nombre.
  active.sort((a, b) => (cards[a.id]?.played_today - cards[b.id]?.played_today) || a.name.localeCompare(b.name));
  let dateLabel = parseISO(o.today).toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  dateLabel = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);

  return `
    <div class="page-head">
      <div><h1>Dashboard</h1><p>${esc(dateLabel)}</p></div>
      <button class="btn" data-new-game>＋ Agregar juego</button>
    </div>
    <div class="tiles four">
      ${tile("Juegos", o.total_games)}
      ${tile("Jugados hoy", `${o.played_today}<small> / ${o.total_games}</small>`)}
      ${tile("Partidas", o.total_sessions)}
      ${tile("Victorias", o.wins)}
      ${tile("Derrotas", o.losses)}
      ${tile("% victorias", pct(o.win_rate))}
      ${tile("🔥 Racha actual", `${o.current_streak}<small> días</small>`, "streak")}
      ${tile("🏆 Mejor racha", `${o.best_streak}<small> días</small>`)}
    </div>

    <section class="section">
      <div class="section-head">
        <h2>Mis juegos</h2>
        <span class="muted small">${o.pending_today.length ? `${o.pending_today.length} pendiente(s) hoy` : "¡Todo jugado hoy! 🎉"}</span>
      </div>
      ${active.length
        ? `<div class="game-grid">${active.map((g) => gameCard(g, cards[g.id])).join("")}</div>`
        : '<div class="card empty">No tienes juegos activos. <button class="btn primary sm" data-new-game>Agregar juego</button></div>'}
    </section>

    <section class="section grid-2">
      ${weekCard(o.week)}
      <div>
        <div class="section-head"><h2>Logros</h2></div>
        ${achievementsHtml(o.achievements)}
      </div>
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
        <span class="game-icon" aria-hidden="true">${esc(g.icon)}</span>
        <div class="grow">
          <a class="game-title" href="#/game/${g.id}">${esc(g.name)}</a>
          ${g.category ? `<span class="badge cat">${esc(g.category)}</span>` : ""}
          ${g.active ? "" : '<span class="badge pending">Inactivo</span>'}
          <div class="muted small">${esc(g.description || "")}${g.description ? " · " : ""}${c?.played || 0} partidas · métrica: ${METRICS[g.primary_metric].label.toLowerCase()}</div>
        </div>
        ${g.url ? `<a class="btn sm ghost" href="${esc(g.url)}" target="_blank" rel="noopener noreferrer" title="Jugar">▶</a>` : ""}
        <button class="btn sm" data-edit-game="${g.id}">Editar</button>
        <button class="btn sm" data-toggle-game="${g.id}">${g.active ? "Desactivar" : "Activar"}</button>
        <button class="btn sm danger ghost" data-delete-game="${g.id}">Eliminar</button>
      </li>`;
  });
  return `
    <div class="page-head">
      <div><h1>Mis juegos</h1><p>Agrega, edita, desactiva o elimina juegos.</p></div>
      <button class="btn primary" data-new-game>＋ Agregar juego</button>
    </div>
    <div class="card">${rows.length ? `<ul class="list">${rows.join("")}</ul>` : '<p class="empty">Aún no tienes juegos.</p>'}</div>`;
}

/* ================================================================ página de juego */

async function renderGame(id) {
  const game = gameById(id);
  if (!game) throw new Error("Juego no encontrado");
  const s = await api(`/api/stats/${game.id}`);
  await loadOverview();
  state.gameStats = s;
  const metric = game.primary_metric;
  const trendLabel = {
    improving: '<span class="trend delta-good">▲ Mejorando</span>',
    worsening: '<span class="trend delta-bad">▼ Empeorando</span>',
    stable: '<span class="trend">＝ Estable</span>',
    insufficient_data: '<span class="trend muted">Faltan datos para ver la tendencia</span>',
  }[s.trend.direction];

  const recent = s.recent.map((r) => `
    <li>
      <span class="num" style="width:90px">${fmtDate(r.played_at)}</span>
      ${resultBadge(r.result)}
      <span class="grow muted small">${esc(sessionSummary(game, r))}${r.notes ? ` · ${esc(r.notes)}` : ""}</span>
      <button class="btn sm ghost" data-edit-session="${r.id}">Editar</button>
    </li>`).join("");

  return `
    <div class="page-head">
      <div>
        <h1>${esc(game.icon)} ${esc(game.name)} ${game.active ? "" : '<span class="badge pending">Inactivo</span>'}</h1>
        <p>${esc(game.description || game.category || "")}</p>
      </div>
      <div class="card-actions">
        ${game.url ? `<a class="btn" href="${esc(game.url)}" target="_blank" rel="noopener noreferrer">▶ Jugar</a>` : ""}
        <button class="btn" data-edit-game="${game.id}">Editar</button>
        <button class="btn primary" data-log="${game.id}">＋ Registrar resultado</button>
      </div>
    </div>
    <div class="tiles">
      ${tile("🔥 Racha actual", s.current_streak, "streak")}
      ${tile("🏆 Mejor racha", s.best_streak)}
      ${tile("Partidas", s.played)}
      ${tile("Victorias", s.wins)}
      ${tile("Derrotas", s.losses)}
      ${tile("% victorias", pct(s.win_rate))}
      ${trackedMetrics(game).map((m) => tile(`Promedio ${METRICS[m].label.toLowerCase()}`, fmtMetric(m, s.averages[m]))).join("")}
      ${tile("Mejor resultado", s.best ? fmtMetric(metric, s.best[metric]) : "—")}
      ${tile("Peor resultado", s.worst ? fmtMetric(metric, s.worst[metric]) : "—")}
    </div>

    <section class="section card">
      <div class="section-head"><h2>Evolución · ${METRICS[metric].label}</h2>${trendLabel}</div>
      <div class="chart-box"><canvas id="evolution-chart" aria-label="Evolución de ${METRICS[metric].label}"></canvas></div>
      <p class="muted small" style="margin:8px 0 0">Puntos: <span style="color:var(--win)">●</span> victoria · <span style="color:var(--loss)">●</span> derrota.
      ${s.trend.recent_avg != null && s.trend.previous_avg != null ? `Últimas 10 partidas: ${fmtMetric(metric, s.trend.recent_avg)} vs. 10 anteriores: ${fmtMetric(metric, s.trend.previous_avg)}.` : ""}</p>
    </section>

    <section class="section grid-2">
      ${weekCard(s.week, { title: "Esta semana vs. anterior", metricKey: metric, lowerBetter: game.lower_is_better })}
      <div class="card">
        <div class="section-head"><h2>Distribución</h2></div>
        <div class="chart-box short"><canvas id="distribution-chart" aria-label="Distribución"></canvas></div>
      </div>
    </section>

    <section class="section card">
      <div class="section-head"><h2>Historial reciente</h2><a href="#/history" data-history-game="${game.id}">Ver todo →</a></div>
      ${recent ? `<ul class="list">${recent}</ul>` : '<p class="empty">Aún no hay partidas registradas.</p>'}
    </section>`;
}

afterRender.game = () => {
  evolutionChart($("#evolution-chart"), state.gameStats);
  distributionChart($("#distribution-chart"), state.gameStats);
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
        <td class="num" data-label="">${fmtDate(s.played_at)}</td>
        <td data-label="">${g ? `<a href="#/game/${g.id}">${esc(g.icon)} ${esc(g.name)}</a>` : "—"}</td>
        <td data-label="">${resultBadge(s.result)}</td>
        ${cell("Puntaje", fmtNum(s.score))}
        ${cell("Intentos", fmtNum(s.attempts))}
        ${cell("Errores", fmtNum(s.errors))}
        ${cell("Tiempo", fmtTime(s.time_seconds))}
        <td class="notes-cell ${s.notes ? "" : "empty-cell"}" data-label="" title="${esc(s.notes)}">${esc(s.notes)}</td>
        <td class="actions">
          <button class="btn sm ghost" data-edit-session="${s.id}" aria-label="Editar">✎</button>
          <button class="btn sm danger ghost" data-delete-session="${s.id}" aria-label="Eliminar">🗑</button>
        </td>
      </tr>`;
  }).join("");
  const hasFilters = f.game_id || f.result || f.date_from || f.date_to;

  return `
    <div class="page-head">
      <div><h1>Historial</h1><p>${sessions.length} partida(s)${hasFilters ? " con los filtros actuales" : ""}.</p></div>
      <button class="btn primary" data-log="">＋ Registrar partida</button>
    </div>
    <form class="filters" id="history-filters">
      <label class="field">Juego<select name="game_id"><option value="">Todos</option>${gameOptions}</select></label>
      <label class="field">Resultado
        <select name="result">
          <option value="">Todos</option>
          <option value="win" ${f.result === "win" ? "selected" : ""}>Victoria</option>
          <option value="loss" ${f.result === "loss" ? "selected" : ""}>Derrota</option>
        </select>
      </label>
      <label class="field">Desde<input type="date" name="date_from" value="${f.date_from}"></label>
      <label class="field">Hasta<input type="date" name="date_to" value="${f.date_to}"></label>
      ${hasFilters ? '<button type="button" class="btn ghost" data-clear-filters>Limpiar</button>' : ""}
    </form>
    <div class="card table-wrap">
      ${rows ? `
        <table class="history-table">
          <thead><tr>
            <th><button data-toggle-order title="Cambiar orden">Fecha ${f.order === "desc" ? "↓" : "↑"}</button></th>
            <th>Juego</th><th>Resultado</th>
            <th class="num">Puntaje</th><th class="num">Intentos</th><th class="num">Errores</th><th class="num">Tiempo</th>
            <th>Notas</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<p class="empty">No hay partidas que coincidan.</p>'}
    </div>`;
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
    const trend = { improving: "▲", worsening: "▼", stable: "＝", insufficient_data: "" }[s.trend.direction];
    const trendCls = { improving: "delta-good", worsening: "delta-bad" }[s.trend.direction] || "";
    return `
      <tr>
        <td class="nowrap"><a href="#/game/${g.id}">${esc(g.icon)} ${esc(g.name)}</a></td>
        <td class="num">${s.played}</td>
        <td class="num">${s.wins}</td>
        <td class="num">${s.losses}</td>
        <td class="num">${pct(s.win_rate)}</td>
        <td class="muted">${METRICS[m].label}</td>
        <td class="num">${fmtMetric(m, s.averages[m])}</td>
        <td class="num">${s.best ? fmtMetric(m, s.best[m]) : "—"}</td>
        <td class="num">${s.worst ? fmtMetric(m, s.worst[m]) : "—"}</td>
        <td class="num">${s.current_streak}</td>
        <td class="num">${s.best_streak}</td>
        <td class="${trendCls}" title="Tendencia">${trend}</td>
      </tr>`;
  }).join("");

  return `
    <div class="page-head"><div><h1>Estadísticas</h1><p>Tu rendimiento global y por juego.</p></div></div>
    <div class="tiles">
      ${tile("Partidas", o.total_sessions)}
      ${tile("% victorias", pct(o.win_rate))}
      ${tile("🔥 Racha actual", o.current_streak, "streak")}
      ${tile("🏆 Mejor racha", o.best_streak)}
    </div>
    <section class="section grid-2">
      <div class="card">
        <div class="section-head"><h2>Partidas por día</h2><span class="muted small">últimos 30 días</span></div>
        <div class="chart-box short"><canvas id="daily-chart"></canvas></div>
      </div>
      <div class="card">
        <div class="section-head"><h2>Victorias / derrotas</h2></div>
        <div class="chart-box short"><canvas id="winloss-chart"></canvas></div>
      </div>
    </section>
    <section class="section card">
      <div class="section-head">
        <h2>Evolución por juego</h2>
        ${perGame.length ? `<select id="stats-game" style="width:auto">${perGame.map((s) => {
          const g = gameById(s.game_id);
          return `<option value="${g.id}">${esc(g.icon)} ${esc(g.name)}</option>`;
        }).join("")}</select>` : ""}
      </div>
      <div class="chart-box"><canvas id="game-evolution-chart"></canvas></div>
    </section>
    <section class="section card table-wrap">
      <div class="section-head"><h2>Por juego</h2></div>
      ${rows ? `<table>
        <thead><tr>
          <th>Juego</th><th class="num">Partidas</th><th class="num">Vict.</th><th class="num">Derr.</th><th class="num">%</th>
          <th>Métrica</th><th class="num">Promedio</th><th class="num">Mejor</th><th class="num">Peor</th>
          <th class="num">Racha</th><th class="num">Mejor racha</th><th>Tend.</th>
        </tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">Registra partidas para ver estadísticas.</p>'}
    </section>`;
}

afterRender.stats = () => {
  const { o, perGame, recent, since } = state.statsData;
  // Partidas por día (30 días, incluye días sin jugar).
  const counts = {};
  recent.forEach((s) => { counts[s.played_at] = (counts[s.played_at] || 0) + 1; });
  const days = Array.from({ length: 30 }, (_, i) => addDays(since, i));
  makeChart($("#daily-chart"), {
    type: "bar",
    data: {
      labels: days.map((d) => fmtDate(d, { relative: false }).slice(0, 5)),
      datasets: [{ label: "Partidas", data: days.map((d) => counts[d] || 0), backgroundColor: cssVar("--accent"), borderRadius: 4, maxBarThickness: 18 }],
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
        labels: [`Victorias (${o.wins})`, `Derrotas (${o.losses})`],
        datasets: [{ data: [o.wins, o.losses], backgroundColor: [cssVar("--win"), cssVar("--loss")], borderColor: cssVar("--surface"), borderWidth: 2 }],
      },
      options: { cutout: "65%", plugins: { legend: { position: "right" } } },
    });
  } else {
    $("#winloss-chart").parentElement.innerHTML = '<p class="empty">Sin partidas todavía.</p>';
  }

  const select = $("#stats-game");
  const draw = () => {
    state.charts.filter((c) => c.canvas.id === "game-evolution-chart").forEach((c) => c.destroy());
    state.charts = state.charts.filter((c) => c.canvas?.id !== "game-evolution-chart");
    const s = perGame.find((p) => String(p.game_id) === select.value);
    evolutionChart($("#game-evolution-chart"), s);
  };
  if (select) {
    select.addEventListener("change", draw);
    draw();
  } else {
    $("#game-evolution-chart").parentElement.innerHTML = '<p class="empty">Sin datos todavía.</p>';
  }
};

/* ================================================================ calendario */

async function renderCalendar() {
  if (!state.calendar) {
    const t = parseISO(state.today);
    state.calendar = { year: t.getFullYear(), month: t.getMonth() + 1, selected: state.today };
  }
  const { year, month, selected } = state.calendar;
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const last = `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const sessions = await api(`/api/sessions?date_from=${first}&date_to=${last}&order=asc`);
  const byDay = {};
  sessions.forEach((s) => (byDay[s.played_at] ||= []).push(s));

  const offset = (parseISO(first).getDay() + 6) % 7; // lunes = 0
  const cells = ["L", "M", "X", "J", "V", "S", "D"].map((d) => `<div class="cal-dow">${d}</div>`);
  for (let i = 0; i < offset; i++) cells.push('<div class="cal-day blank"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
    cells.push(`<button class="${cls}" data-day="${iso}" aria-label="${label}" ${iso > state.today ? "disabled" : ""}><span class="d">${d}</span><span class="icons" aria-hidden="true">${icons}</span>${list.length ? `<span class="cnt" aria-hidden="true">${list.length}</span>` : ""}</button>`);
  }

  const daySessions = byDay[selected] || [];
  const dayList = daySessions.map((s) => {
    const g = gameById(s.game_id);
    return `
      <li>
        <span class="game-icon" aria-hidden="true">${esc(g?.icon)}</span>
        <div class="grow"><b>${esc(g?.name)}</b><div class="muted small">${g ? esc(sessionSummary(g, s)) : ""}${s.notes ? ` · ${esc(s.notes)}` : ""}</div></div>
        ${resultBadge(s.result)}
        <button class="btn sm ghost" data-edit-session="${s.id}">Editar</button>
      </li>`;
  }).join("");
  const playedDays = Object.keys(byDay).length;
  const selectedInMonth = selected?.startsWith(first.slice(0, 7));

  return `
    <div class="page-head">
      <div><h1>Calendario</h1><p>${playedDays} día(s) jugados este mes.</p></div>
      <div class="cal-head">
        <button class="btn sm" data-cal="-1" aria-label="Mes anterior">←</button>
        <h2>${MONTHS[month - 1]} ${year}</h2>
        <button class="btn sm" data-cal="1" aria-label="Mes siguiente">→</button>
        <button class="btn sm ghost" data-cal="0">Hoy</button>
      </div>
    </div>
    <div class="grid-2" style="align-items:start">
      <div class="card"><div class="calendar">${cells.join("")}</div></div>
      <div class="card">
        ${selectedInMonth ? `
          <div class="section-head">
            <h2>${fmtDate(selected)}${selected === state.today || selected === addDays(state.today, -1) ? ` <span class="muted small">${fmtDate(selected, { relative: false })}</span>` : ""}</h2>
            <button class="btn sm primary" data-log="" data-log-date="${selected}">＋ Registrar</button>
          </div>
          ${dayList ? `<ul class="list">${dayList}</ul>` : '<p class="empty">No jugaste este día.</p>'}`
          : '<p class="empty">Selecciona un día para ver sus partidas.</p>'}
      </div>
    </div>`;
}

/* ================================================================ configuración */

function currentTheme() {
  try { return localStorage.getItem("dle-theme") || "system"; } catch { return "system"; }
}

function applyTheme(theme) {
  try {
    if (theme === "system") localStorage.removeItem("dle-theme"); else localStorage.setItem("dle-theme", theme);
  } catch { /* almacenamiento no disponible */ }
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

async function renderSettings() {
  const theme = currentTheme();
  const opt = (value, label) => `<label><input type="radio" name="theme" value="${value}" ${theme === value ? "checked" : ""}><span>${label}</span></label>`;
  return `
    <div class="page-head"><div><h1>Configuración</h1></div></div>
    <div class="grid-2" style="align-items:start">
      <div class="card">
        <h2>Apariencia</h2>
        <p class="muted small">Elige el tema de la interfaz.</p>
        <div class="segmented" id="theme-picker" style="grid-template-columns:repeat(3,1fr)">
          ${opt("system", "💻 Sistema")}${opt("light", "☀️ Claro")}${opt("dark", "🌙 Oscuro")}
        </div>
      </div>
      <div class="card">
        <h2>Datos</h2>
        <p class="muted small">Los datos se guardan en SQLite (<code>data/dle_games.db</code>). Puedes descargar una copia en JSON.</p>
        <button class="btn" id="export-btn">⬇ Exportar datos (JSON)</button>
      </div>
    </div>`;
}

afterRender.settings = () => {
  $("#theme-picker").addEventListener("change", (e) => applyTheme(e.target.value));
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
  $("#game-form-title").textContent = game ? `Editar ${game.name}` : "Agregar juego";
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
    toast(id ? "Juego actualizado" : `«${name}» agregado`);
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
    return `<label class="field">Tiempo (m:ss o segundos)
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
    // Si ya registró ese juego en esa fecha, editar en vez de duplicar.
    const existing = await api(`/api/sessions?game_id=${gameId}&date_from=${playedAt}&date_to=${playedAt}`);
    if (existing.length) session = existing[0];
  }
  const fixedGame = session?.game_id ?? gameId;
  const activeGames = state.games.filter((g) => g.active || g.id === fixedGame);
  el.game_id.innerHTML = activeGames.map((g) => `<option value="${g.id}">${esc(g.icon)} ${esc(g.name)}</option>`).join("");
  if (!activeGames.length) return toast("Primero agrega un juego.", "error");
  el.game_id.value = fixedGame ?? activeGames[0].id;
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
  // Valores de la partida que se edita o, al registrar, los más usados del juego.
  const values = session || {
    result: suggested.result || "win",
    attempts: suggested.attempts, errors: suggested.errors,
    score: suggested.score, time_seconds: suggested.time_seconds,
  };
  $("#session-form-title").textContent = `${session ? "Editar" : "Registrar"} · ${game.icon} ${game.name}`;
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
  if (!payload.result) return showFormError(sessionForm, "Elige Victoria o Derrota.");

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
    toast(id ? "Partida actualizada" : `${game.icon} ${game.name} registrado`);
    refresh();
  } catch (err) {
    showFormError(sessionForm, err.message);
  }
});

async function deleteSession(id) {
  const ok = await confirmDialog("Eliminar partida", "Esta partida se eliminará definitivamente.");
  if (!ok) return false;
  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    toast("Partida eliminada");
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
    else if (d.toggleGame) {
      const g = gameById(d.toggleGame);
      await api(`/api/games/${g.id}`, { method: "PUT", body: { active: !g.active } });
      toast(`${g.name} ${g.active ? "desactivado" : "activado"}`);
      refresh();
    } else if (d.deleteGame) {
      const g = gameById(d.deleteGame);
      const ok = await confirmDialog(
        `Eliminar ${g.name}`,
        `Se eliminará «${g.name}» y TODAS sus partidas registradas. Esta acción no se puede deshacer. Si solo quieres ocultarlo, usa «Desactivar».`,
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

// Redibuja los gráficos si cambia el tema del sistema.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (state.charts.length) refresh();
});
const themeObserver = new MutationObserver(() => { if (state.charts.length) refresh(); });
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

if (!location.hash) history.replaceState(null, "", "#/dashboard");
router();
