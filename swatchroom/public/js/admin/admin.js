// The admin dashboard: a small, framework-free page against /api/admin/* (server/routes/admin.js).
// Separate sign-in from the studio passcode (server/lib/adminAuth.js); nothing here reuses the
// studio's own JS modules on purpose, so this page stays simple and independent of it.
import { initAnalytics } from "../lib/analytics.js";

const root = document.getElementById("admin-root");
let pollTimer = null;
let logsTimer = null;

const state = {
  signedIn: null,
  email: "",
  password: "",
  error: "",
  busy: false,
  overview: null,
  models: null,
  live: null,
  logs: [],
  logType: "",
  logStatus: "",
  loadingLogs: false,
};

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}

async function api(path, options) {
  const response = await fetch("/api/admin" + path, Object.assign({ headers: { "Content-Type": "application/json" } }, options));
  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  if (!response.ok) {
    throw new Error((body && body.error) || "Request failed (" + response.status + ").");
  }
  return body;
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return seconds + "s ago";
  if (seconds < 3600) return Math.round(seconds / 60) + "m ago";
  return Math.round(seconds / 3600) + "h ago";
}

function render() {
  if (!state.signedIn) {
    renderLogin();
  } else {
    renderDashboard();
  }
}

function renderLogin() {
  root.innerHTML =
    '<div class="admin-login"><div class="admin-login-card">' +
    "<h1>Swatchroom Admin</h1>" +
    '<p class="sub">Sign in to see generations, live visitors, model status and logs.</p>' +
    (state.error ? '<p class="admin-error">' + escapeHtml(state.error) + "</p>" : "") +
    '<form id="login-form">' +
    '<div class="admin-field"><label for="email">Email</label>' +
    '<input id="email" type="email" autocomplete="username" required /></div>' +
    '<div class="admin-field"><label for="password">Password</label>' +
    '<input id="password" type="password" autocomplete="current-password" required /></div>' +
    '<button class="admin-btn" type="submit"' +
    (state.busy ? " disabled" : "") +
    ">" +
    (state.busy ? "Signing in…" : "Sign in") +
    "</button>" +
    "</form>" +
    "</div></div>";

  const form = document.getElementById("login-form");
  document.getElementById("email").value = state.email;
  document.getElementById("password").value = state.password;
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    state.email = document.getElementById("email").value;
    state.password = document.getElementById("password").value;
    state.busy = true;
    state.error = "";
    render();
    try {
      await api("/login", { method: "POST", body: JSON.stringify({ email: state.email, password: state.password }) });
      state.signedIn = true;
      state.busy = false;
      startDashboard();
    } catch (error) {
      state.busy = false;
      state.error = error.message;
      render();
    }
  });
}

function statusRow(entry) {
  const status = entry.status || "warn";
  return (
    '<div class="status-row"><span class="dot ' +
    escapeHtml(status) +
    '"></span><span class="name">' +
    escapeHtml(entry.name) +
    '</span><span class="detail">' +
    escapeHtml(entry.detail || "") +
    "</span></div>"
  );
}

function logRow(entry) {
  const pill = entry.status === "ok" ? "ok" : "error";
  return (
    "<tr><td>" +
    new Date(entry.createdAt).toLocaleString() +
    "</td><td>" +
    escapeHtml(entry.type) +
    "</td><td>" +
    escapeHtml(entry.action || "") +
    "</td><td>" +
    escapeHtml(entry.model || "") +
    "</td><td>" +
    escapeHtml(entry.roomId || "") +
    '</td><td><span class="pill ' +
    pill +
    '">' +
    escapeHtml(entry.status) +
    "</span></td><td>" +
    entry.durationMs +
    "ms</td><td>" +
    escapeHtml(entry.visitorId || "") +
    '</td><td class="error-cell" title="' +
    escapeHtml(entry.error || "") +
    '">' +
    escapeHtml(entry.error || "") +
    "</td></tr>"
  );
}

function renderDashboard() {
  const overview = state.overview || {};
  root.innerHTML =
    '<div class="admin-shell">' +
    '<div class="admin-header"><h1>Swatchroom Admin</h1><button class="logout" id="logout-btn">Sign out</button></div>' +
    '<div class="admin-cards">' +
    card(overview.liveNow, "Live now") +
    card(overview.generationsToday, "Generations today") +
    card(overview.generationsTotal, "Generations total") +
    card(overview.errorsToday, "Errors today") +
    card(overview.roomsTotal, "Rooms saved") +
    "</div>" +
    '<div class="admin-section"><h2>Model &amp; service status</h2><p class="admin-note">The Modal pools are shown from this server\'s own record of its last call, so this panel never wakes a GPU. <button class="admin-btn" id="probe-models" type="button">Probe Modal now (starts GPUs, bills)</button></p><div id="models-list">Loading…</div></div>' +
    '<div class="admin-section"><h2>Live visitors</h2><div id="live-list">Loading…</div></div>' +
    '<div class="admin-section"><h2>Generation log</h2>' +
    '<div class="admin-filters">' +
    selectHtml("type-filter", state.logType, [
      ["", "All types"],
      ["generate", "generate"],
      ["scan", "scan"],
      ["pick", "pick"],
      ["pipeline", "pipeline"],
    ]) +
    selectHtml("status-filter", state.logStatus, [
      ["", "All statuses"],
      ["ok", "ok"],
      ["error", "error"],
    ]) +
    "</div>" +
    '<table class="admin-table"><thead><tr><th>Time</th><th>Type</th><th>Action</th><th>Model</th><th>Room</th><th>Status</th><th>Duration</th><th>Visitor</th><th>Error</th></tr></thead>' +
    '<tbody id="logs-body"></tbody></table>' +
    '<button class="admin-loadmore" id="load-more">Load more</button>' +
    "</div>" +
    "</div>";

  document.getElementById("logout-btn").addEventListener("click", async function () {
    await api("/login", { method: "DELETE" }).catch(function () {});
    stopDashboard();
    state.signedIn = false;
    render();
  });
  document.getElementById("type-filter").addEventListener("change", function (event) {
    state.logType = event.target.value;
    refreshLogs(true);
  });
  document.getElementById("status-filter").addEventListener("change", function (event) {
    state.logStatus = event.target.value;
    refreshLogs(true);
  });
  document.getElementById("load-more").addEventListener("click", function () {
    refreshLogs(false);
  });
  document.getElementById("probe-models").addEventListener("click", function (event) {
    // the one deliberate way to call the Modal pools from the dashboard: it starts the ones that have scaled to zero
    const button = event.target;
    button.disabled = true;
    button.textContent = "Probing…";
    refreshModels(true).then(function () {
      button.disabled = false;
      button.textContent = "Probe Modal now (starts GPUs, bills)";
    });
  });

  renderModels();
  renderLive();
  renderLogs();
}

function card(value, label) {
  return (
    '<div class="admin-card"><div class="value">' +
    (value == null ? "—" : value) +
    '</div><div class="label">' +
    escapeHtml(label) +
    "</div></div>"
  );
}

function selectHtml(id, selected, options) {
  return (
    '<select id="' +
    id +
    '">' +
    options
      .map(function (pair) {
        return '<option value="' + pair[0] + '"' + (pair[0] === selected ? " selected" : "") + ">" + pair[1] + "</option>";
      })
      .join("") +
    "</select>"
  );
}

function renderModels() {
  const el = document.getElementById("models-list");
  if (!el) return;
  if (!state.models) {
    el.textContent = "Loading…";
    return;
  }
  el.innerHTML = state.models.map(statusRow).join("");
}

function renderLive() {
  const el = document.getElementById("live-list");
  if (!el) return;
  if (!state.live || state.live.visitors.length === 0) {
    el.innerHTML = '<p class="admin-note">Nobody active in the last 90 seconds.</p>';
    return;
  }
  el.innerHTML =
    '<table class="admin-table"><thead><tr><th>Visitor</th><th>Page / route</th><th>Last seen</th></tr></thead><tbody>' +
    state.live.visitors
      .map(function (visitor) {
        return (
          "<tr><td>" +
          escapeHtml(visitor.id) +
          "</td><td>" +
          escapeHtml(visitor.path) +
          "</td><td>" +
          timeAgo(visitor.lastSeen) +
          "</td></tr>"
        );
      })
      .join("") +
    "</tbody></table>";
}

function renderLogs() {
  const body = document.getElementById("logs-body");
  if (!body) return;
  body.innerHTML = state.logs.map(logRow).join("");
}

async function refreshOverview() {
  try {
    state.overview = await api("/overview");
    if (document.getElementById("admin-root").querySelector(".admin-cards")) {
      const cardsHtml =
        card(state.overview.liveNow, "Live now") +
        card(state.overview.generationsToday, "Generations today") +
        card(state.overview.generationsTotal, "Generations total") +
        card(state.overview.errorsToday, "Errors today") +
        card(state.overview.roomsTotal, "Rooms saved");
      document.querySelector(".admin-cards").innerHTML = cardsHtml;
    }
  } catch (error) {
    if (/sign in/i.test(error.message)) {
      stopDashboard();
      state.signedIn = false;
      render();
    }
  }
}

async function refreshModels(probe) {
  try {
    const answer = await api(probe ? "/models?probe=1" : "/models");
    state.models = answer.results;
    renderModels();
  } catch (error) {
    // transient; next poll tries again
  }
}

async function refreshLive() {
  try {
    state.live = await api("/live");
    renderLive();
  } catch (error) {
    // transient
  }
}

async function refreshLogs(reset) {
  if (state.loadingLogs) return;
  state.loadingLogs = true;
  try {
    const params = new URLSearchParams();
    if (state.logType) params.set("type", state.logType);
    if (state.logStatus) params.set("status", state.logStatus);
    params.set("limit", "50");
    if (!reset && state.logs.length) {
      params.set("before", String(new Date(state.logs[state.logs.length - 1].createdAt).getTime()));
    }
    const answer = await api("/logs?" + params.toString());
    state.logs = reset ? answer.logs : state.logs.concat(answer.logs);
    renderLogs();
  } catch (error) {
    // transient
  } finally {
    state.loadingLogs = false;
  }
}

function startDashboard() {
  render();
  refreshOverview();
  refreshModels();
  refreshLive();
  refreshLogs(true);
  pollTimer = setInterval(function () {
    refreshOverview();
    refreshLive();
  }, 15000);
  logsTimer = setInterval(function () {
    refreshModels(false);
  }, 30000);
}

function stopDashboard() {
  clearInterval(pollTimer);
  clearInterval(logsTimer);
  pollTimer = null;
  logsTimer = null;
}

async function start() {
  try {
    const session = await fetch("/api/session").then(function (response) {
      return response.json();
    });
    initAnalytics(session.posthog);
  } catch (error) {
    // analytics is best-effort
  }
  try {
    const me = await api("/me");
    state.signedIn = me.signedIn;
  } catch (error) {
    state.signedIn = false;
  }
  if (state.signedIn) {
    startDashboard();
  } else {
    render();
  }
}

start();
