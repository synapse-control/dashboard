"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const local = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const RANK = { viewer: 0, operator: 1, admin: 2 };
const S = {
  st: null,
  snap: { hub_ok: false, nodes: [] },
  sig: "",
  sse: false,
  nav: "overview",
  q: {},
  describe: {},
  views: {},
  busy: {},
  values: {},
  scope: {},
  instLive: {},
  readings: {},
  chanErr: {},
  page: 1,
  alertsAll: false,
  hist: null,
  histRange: "1h",
  ovChan: local.get("overview:channel", ""),
  collapsed: local.get("sidebar:collapsed", "0") === "1",
  open: JSON.parse(local.get("sidebar:open", "{}")),
};
const role = () => S.st?.me?.role ?? document.body.dataset.role;
const can = (r) => RANK[role()] >= RANK[r];

const TRANSPORT = { serial: "USB", tcp: "network", ws: "WebSocket", sim: "simulated" };
const BEACON = {
  1: "alive, no hub",
  2: "joining Wi-Fi",
  3: "dialling the hub",
  0: "on the hub",
  9: "lease active",
  5: "failsafe",
  4: "radio held off: supply browned out",
};
const beaconOn = (code, now) => {
  const t = now & 2047;
  return code === 9 ? (t & 127) < 64 : code === 0 ? t < 600 : t < code * 256 && (t & 255) < 100;
};

const ICON = {
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/></svg>',
  devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="13" height="10" rx="1.5"/><rect x="14" y="9" width="7" height="11" rx="1.5"/><path d="M6 18h6"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4M6 12l3-3 3 2 4-4"/></svg>',
  workflow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v4a2 2 0 0 0 2 2h7M15 15l-2-2M15 15l-2 2"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
};

function errText(data, status) {
  let m = data?.error ?? `HTTP ${status}`;
  try {
    const inner = JSON.parse(m);
    m = inner?.error?.msg ? `${inner.error.code}: ${inner.error.msg}` : (inner?.error ?? m);
  } catch {}
  return typeof m === "string" ? m : JSON.stringify(m);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) location.assign("/login");
  if (!res.ok) throw new Error(errText(data, res.status));
  return data;
}
const call = (tool, args = {}) => api("POST", `/api/call/${tool}`, args);

const attrs = (data = {}) => Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
const btn = (label, o = {}) =>
  `<button type="${o.type ?? "button"}" class="btn ${o.size ?? "sm"} ${o.variant ?? "flat"} ${o.color ?? "default"} ${o.cls ?? ""}" ${o.act ? `data-act="${o.act}"` : ""} ${attrs(o.data)} ${o.disabled ? "disabled" : ""} ${o.title ? `title="${esc(o.title)}"` : ""}>${label}</button>`;
const chip = (text, color = "default", variant = "flat", title = "") =>
  `<span class="chip ${variant} ${color}" ${title ? `title="${esc(title)}"` : ""}>${esc(text)}</span>`;
const card = ({ header = "", body = "", footer = "", cls = "", id = "" }) =>
  `<section class="card ${cls}" ${id ? `id="${id}"` : ""}>${header ? `<div class="card-header">${header}</div>` : ""}<div class="card-body">${body}</div>${footer ? `<div class="card-footer">${footer}</div>` : ""}</section>`;
const field = (label, input, desc = "") =>
  `<div class="field-wrap"><label class="field"><span class="field-label">${label}</span>${input}</label>${desc ? `<span class="field-desc">${desc}</span>` : ""}</div>`;
const input = (name, o = {}) =>
  `<input class="field-input" name="${name}" type="${o.type ?? "text"}" value="${esc(o.value ?? "")}" ${o.placeholder ? `placeholder="${esc(o.placeholder)}"` : ""} ${o.extra ?? ""}>`;
const select = (name, options, value, extra = "") =>
  `<select class="field-input" name="${name}" ${extra}>${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const toggle = (checked, extra = "", label = "") =>
  `<label class="switch"><input type="checkbox" ${checked ? "checked" : ""} ${extra}><span class="track"><span class="thumb"></span></span>${label ? `<span>${label}</span>` : ""}</label>`;
const spinner = (label) => `<div class="center"><span class="spinner">${esc(label)}</span></div>`;
const empty = (msg, action = "") => card({ body: `<div class="empty"><p>${msg}</p>${action}</div>` });

function toast(msg, bad = false) {
  const t = document.createElement("div");
  t.className = `toast ${bad ? "bad" : ""}`;
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), bad ? 8000 : 4000);
}

async function busy(el, fn) {
  const label = el?.innerHTML;
  if (el) { el.disabled = true; el.innerHTML = "…"; }
  try { return await fn(); }
  catch (e) { toast(e.message, true); }
  finally { if (el?.isConnected) { el.disabled = false; el.innerHTML = label; } }
}

function modal(title, body, footer, wide = false) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="backdrop" data-act="backdrop"><div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true"><div class="modal-header">${title}</div><div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></div></div>`;
  return $(".modal", root);
}
const closeModal = () => { $("#modal-root").innerHTML = ""; };

const fmtNum = (v) => (v === null || v === undefined || Number.isNaN(v) ? "–" : String(Math.abs(v) >= 100 ? +v.toFixed(1) : +v.toFixed(3)));
const UNIT = { C: "°C", count: "" };
const unitText = (u) => UNIT[u] ?? u ?? "V";
const qty = (v, u) => (u === "Hz"
  ? (Math.abs(v) >= 1e6 ? `${fmtNum(v / 1e6)} MHz` : Math.abs(v) >= 1e3 ? `${fmtNum(v / 1e3)} kHz` : `${fmtNum(v)} Hz`)
  : `${fmtNum(v)}${unitText(u) ? ` ${unitText(u)}` : ""}`);
const fmtUs = (us) => (us >= 1000 ? `${fmtNum(us / 1000)} ms` : `${fmtNum(us)} µs`);
const fmtTime = (t) => new Date(t).toLocaleTimeString();
const fmtWhen = (t) => new Date(t).toLocaleString();
function ago(t) {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtWhen(t);
}
function where(spec) {
  if (!spec) return "";
  const m = spec.match(/^inbound:(ws|tcp):(.+):\d+$/);
  if (m) return `dialled in over ${m[1] === "ws" ? "WebSocket" : "TCP"} from ${m[2]}`;
  if (spec.startsWith("sim:")) return `simulated (${spec.slice(4)})`;
  if (spec.startsWith("tcp:")) return `reached at ${spec.slice(4)}`;
  if (spec.startsWith("/dev/") || spec.startsWith("serial:")) return `USB ${spec.replace("serial:", "")} on the hub`;
  return spec;
}
const initials = (name) => (name || "U").split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join("") || "U";
const words = (s) => String(s ?? "").replace(/_/g, " ");

const devices = () => S.st?.devices ?? [];
const device = (node) => devices().find((d) => d.node === node);
const devName = (node) => device(node)?.name || node;
const liveNode = (node) => (S.snap.nodes ?? []).find((n) => n.node === node);
const online = (node) => Boolean(liveNode(node));
const channels = () => S.st?.channels ?? [];
const channel = (id) => channels().find((c) => c.id === id);
const unitOf = (c) => c.unit || (c.as === "a" ? "V" : "");
const latest = (id) => { const r = S.readings[id]; return r?.length ? r[r.length - 1] : null; };

async function describe(node) {
  if (!S.describe[node]) S.describe[node] = await call("describe_node", { node, full: true });
  return S.describe[node];
}

function go(nav, params = {}) {
  const u = new URLSearchParams({ nav, ...params });
  history.pushState(null, "", `/?${u}`);
  route();
}

function route() {
  const p = new URLSearchParams(location.search);
  S.q = Object.fromEntries(p);
  S.nav = VIEWS[p.get("nav")] ? p.get("nav") : "overview";
  S.page = 1;
  renderShell();
  renderView();
  window.scrollTo(0, 0);
}

function sections() {
  return [
    { key: "nodes", label: "Nodes", icon: ICON.chip, items: [{ key: "nodes", label: "Connected Nodes", nav: "nodes" }] },
    {
      key: "devices", label: "Device Management", icon: ICON.devices, items: [
        { key: "fleet", label: "Device Fleet", nav: "devices" },
        { key: "provision", label: "Add a Board", nav: "provisioning" },
      ],
    },
    {
      key: "monitoring", label: "Real-time Monitoring", icon: ICON.monitor, items: [
        { key: "live", label: "Live Telemetry", nav: "realtime" },
        { key: "alerts", label: "Alerts & Notifications", nav: "alerts", badge: S.st?.unseen },
        { key: "history", label: "Historical Data", nav: "history" },
      ],
    },
    {
      key: "automation", label: "Automation & Rules", icon: ICON.workflow, items: [
        { key: "engine", label: "Rule Engine", nav: "automations" },
        { key: "templates", label: "Workflow Templates", nav: "automations", focus: "templates" },
      ],
    },
  ];
}

function activeItem() {
  if (S.nav === "device") return "fleet";
  for (const s of sections()) for (const it of s.items) if (it.nav === S.nav && (it.focus ?? "") === (S.q.focus ?? "")) return it.key;
  for (const s of sections()) for (const it of s.items) if (it.nav === S.nav) return it.key;
  return "";
}

function renderSidebar() {
  const narrow = matchMedia("(max-width: 767px)").matches;
  const collapsed = S.collapsed || narrow;
  const side = $("#sidebar");
  side.classList.toggle("collapsed", collapsed);
  const filter = (S.sideSearch ?? "").toLowerCase();
  const act = activeItem();
  const top = collapsed
    ? `<div class="side-top">${narrow ? "" : btn("»", { act: "collapse", variant: "light", cls: "icon", title: "Expand sidebar" })}<div class="side-sc">SC</div></div>`
    : `<div class="side-top">${btn("«", { act: "collapse", variant: "light", cls: "icon", title: "Collapse sidebar" })}<div class="grow"><h2>Control Studio</h2><p>Manage devices, data and automations</p><div class="side-search"><label class="field sm"><input class="field-input" data-input="sidesearch" placeholder="Search devices, rules…" value="${esc(S.sideSearch ?? "")}"></label></div></div></div>`;
  const nav = sections().map((s) => {
    const sectionOn = s.items.some((it) => it.key === act);
    if (collapsed) return `<button type="button" class="side-icon ${sectionOn ? "on" : ""}" title="${esc(s.label)}" data-act="go" data-nav="${s.items[0].nav}">${s.icon}</button>`;
    const items = s.items.filter((it) => !filter || it.label.toLowerCase().includes(filter));
    if (filter && !items.length) return "";
    const open = S.open[s.key] ?? true;
    return `<div><button type="button" class="side-sec ${sectionOn ? "on" : ""}" data-act="section" data-key="${s.key}"><span class="row"><span class="ico">${s.icon}</span>${esc(s.label)}</span><span class="caret">${open ? "▾" : "▸"}</span></button>${open ? `<div class="side-items">${items.map((it) => `<button type="button" class="side-item ${it.key === act ? "on" : ""}" data-act="go" data-nav="${it.nav}" ${it.focus ? `data-focus="${it.focus}"` : ""}><span>${esc(it.label)}</span>${it.badge ? `<span class="side-badge">${it.badge}</span>` : ""}</button>`).join("")}</div>` : ""}</div>`;
  }).join("");
  side.innerHTML = `${top}<nav class="side-nav">${nav}</nav>`;
}

function renderNavbar() {
  const me = S.st?.me ?? { name: document.body.dataset.user, role: role() };
  const unseen = S.st?.unseen ?? 0;
  $("#navbar").innerHTML = `
    <div class="navbar-start">
      <a class="brand" href="/?nav=overview" data-act="go" data-nav="overview"><img src="/static/favicon.ico" alt="">Synapse Control</a>
      <div class="row nav-tabs">
        ${btn("Overview", { act: "go", data: { nav: "overview" }, variant: S.nav === "overview" ? "solid" : "light", cls: "h-md" })}
        ${btn("Account", { act: "go", data: { nav: "account" }, variant: S.nav === "account" ? "solid" : "light" })}
      </div>
    </div>
    <div class="navbar-end">
      <form class="nav-search" data-form="search"><label class="field sm"><input class="field-input" name="q" placeholder="Search devices, rules…" value="${esc(S.q.q ?? "")}"></label></form>
      ${btn("Search", { act: "search", variant: "light", cls: "nav-search-btn" })}
      <button type="button" class="bell" data-act="bell" aria-label="Notifications">${bellInner(unseen)}</button>
      <div class="menu-wrap">
        <button type="button" class="avatar" data-act="menu" aria-label="Account menu">${esc(initials(me.name))}</button>
        <div class="menu" role="menu" hidden>
          <div class="menu-head"><strong>${esc(me.name)}</strong>${esc(me.role)}${me.source === "oidc" ? " · single sign-on" : ""}</div>
          <button type="button" data-act="go" data-nav="account">Account</button>
          <button type="button" class="danger-text" data-act="logout">Logout</button>
        </div>
      </div>
    </div>`;
}

const bellInner = (n) => `${ICON.bell}${n > 0 ? `<span class="count">${n > 99 ? "99+" : n}</span>` : ""}`;

function renderBadge() {
  const bell = $(".bell");
  if (bell) bell.innerHTML = bellInner(S.st?.unseen ?? 0);
  renderSidebar();
}

function renderShell() {
  renderNavbar();
  renderSidebar();
  const v = VIEWS[S.nav];
  $("#crumb").textContent = typeof v.title === "function" ? v.title() : v.title;
}

function renderView() {
  const v = VIEWS[S.nav];
  const root = $("#view");
  if (!S.st) { root.innerHTML = spinner("Loading"); return; }
  root.innerHTML = v.html();
  refresh(null);
  v.mount?.(root);
  live();
}

const PART_HTML = new WeakMap();
function refresh(reason) {
  const v = VIEWS[S.nav];
  if (!S.st || !v.parts) return;
  for (const [name, fn] of Object.entries(v.parts)) {
    if (reason && !(v.deps?.[name] ?? []).includes(reason)) continue;
    const el = $(`[data-part="${name}"]`);
    const html = el && fn();
    if (el && PART_HTML.get(el) !== html) { el.innerHTML = html; PART_HTML.set(el, html); }
  }
  live();
}

function spark(id) {
  const rs = (S.readings[id] ?? []).slice(-120);
  if (rs.length < 2) return "";
  const vs = rs.map((r) => r.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const t0 = rs[0].t, t1 = rs[rs.length - 1].t || t0 + 1;
  const pts = rs.map((r) => `${(((r.t - t0) / Math.max(1, t1 - t0)) * 100).toFixed(2)},${(38 - ((r.v - lo) / (hi - lo)) * 36).toFixed(2)}`);
  return `<path d="M0,40 L${pts.join(" L")} L100,40 Z"/><polyline points="${pts.join(" ")}"/>`;
}

function chanState(c) {
  if (S.chanErr[c.id]) return ["error", "danger"];
  if (!online(c.node)) return ["offline", "default"];
  const r = latest(c.id);
  if (!r || Date.now() - r.t > Math.max(3 * c.interval_ms, 5000)) return ["waiting", "warning"];
  return ["live", "success"];
}

function live() {
  const now = Date.now();
  for (const el of $$("[data-reading]")) {
    const c = channel(el.dataset.reading);
    const r = c && latest(c.id);
    el.innerHTML = r ? `${esc(fmtNum(r.v))}<span class="unit">${esc(unitOf(c))}</span>` : "–";
  }
  for (const el of $$("[data-ago]")) {
    const c = channel(el.dataset.ago);
    const r = c && latest(c.id);
    el.textContent = r ? `updated ${ago(r.t)}${r.e ? ` · ±${fmtNum(r.e)} ${unitOf(c)}` : ""} · every ${c.interval_ms} ms` : `no reading yet · every ${c?.interval_ms} ms`;
  }
  for (const el of $$("[data-spark]")) el.innerHTML = spark(el.dataset.spark);
  for (const el of $$("[data-h]")) el.style.height = `${el.dataset.h}%`;
  for (const el of $$("[data-w]")) el.style.width = `${el.dataset.w}%`;
  for (const el of $$("[data-chanerr]")) el.textContent = S.chanErr[el.dataset.chanerr] ?? "";
  for (const el of $$("[data-chanstate]")) {
    const c = channel(el.dataset.chanstate);
    if (!c) continue;
    const [label, color] = chanState(c);
    el.className = `chip flat ${color}`;
    el.textContent = label;
  }
  for (const el of $$("[data-wire]")) {
    const n = liveNode(el.dataset.wire);
    const text = (n?.wire ?? []).slice(-6).join("\n");
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of $$("[data-beacon]")) {
    const n = liveNode(el.dataset.beacon);
    const code = n?.beacon;
    el.hidden = code === undefined || code === null;
    el.dataset.code = code ?? "";
    el.title = `beacon code ${code}`;
    const label = $(".label", el);
    if (label) label.textContent = BEACON[code] ?? `code ${code}`;
  }
  void now;
}

function animate() {
  const now = Date.now();
  for (const el of $$("[data-beacon]")) {
    const code = Number(el.dataset.code);
    const led = $(".led", el);
    if (led) led.classList.toggle("on", el.dataset.code !== "" && beaconOn(code, now));
  }
  requestAnimationFrame(animate);
}

const hubPill = () => {
  const ok = S.snap.hub_ok;
  return `<span class="pill ${ok && S.sse ? "live" : ""}">${ok ? (S.sse ? "Hub live" : "Hub reachable, stream offline") : "Hub offline"}</span>`;
};

function stat(title, value, tone = "") {
  return card({ body: `<p class="stat-title">${esc(title)}</p><p class="stat-value ${tone}">${esc(value)}</p>` });
}

function statusItem(label, value, tone = "default") {
  return `<li class="status-item"><span class="dot ${tone}"></span><div class="grow"><p class="k">${esc(label)}</p><p class="v ${tone}">${esc(value)}</p></div></li>`;
}

function logList(entries, emptyText) {
  if (!entries.length) return `<p class="small muted">${esc(emptyText)}</p>`;
  return `<ul class="divide log">${entries.map((e) => `<li class="${e.alert ? "alert" : ""}"><span class="t">${esc(fmtTime(e.time))}</span><span class="k">${esc(e.kind)}</span>: ${esc(e.message)}</li>`).join("")}</ul>`;
}

function channelOptions(withNone) {
  const opts = channels().map((c) => [c.id, `${c.label} (${devName(c.node)} ${c.pin})`]);
  return withNone ? [["", withNone], ...opts] : opts;
}

const VIEWS = {};

VIEWS.overview = {
  title: "Overview",
  html: () => `<div class="grid overview">
    <div class="col2 stack">
      <div class="grid g4" data-part="kpis"></div>
      ${card({ header: `<h2 class="h-xl grow">Fleet telemetry</h2><div data-part="ovpick"></div><span data-part="sse"></span>`, body: `<div data-part="bars"></div>` })}
      ${card({ header: `<h2 class="h-xl grow">Recent alerts</h2>${btn("Refresh", { act: "reload", variant: "light" })}`, body: `<div data-part="recent"></div>` })}
    </div>
    <div class="stack">
      ${card({ header: `<h3 class="h-md">System health</h3>`, body: `<ul class="status-list" data-part="health"></ul>` })}
      ${card({ header: `<h3 class="h-md">Quick actions</h3>`, body: `<div class="stack tight">${btn("Add a board", { act: "go", data: { nav: "provisioning" }, color: "primary" })}${btn("Record a pin", { act: "go", data: { nav: "realtime" }, variant: "light" })}${btn("Create automation", { act: "go", data: { nav: "automations" }, variant: "light" })}</div>` })}
    </div>
  </div>`,
  parts: {
    kpis: () => {
      const total = devices().length;
      const on = devices().filter((d) => online(d.node)).length;
      const c = channel(S.ovChan) ?? channels()[0];
      const r = c && latest(c.id);
      return stat("Devices", total) + stat("Online", on, "success") + stat("Offline", total - on, "danger") +
        (c ? stat(c.label, r ? `${fmtNum(r.v)} ${unitOf(c)}` : "–") : stat("Channels", 0));
    },
    ovpick: () => (channels().length > 1 ? `<label class="field sm">${select("ovchan", channelOptions(), channel(S.ovChan) ? S.ovChan : channels()[0].id, 'data-change="ovchan"')}</label>` : ""),
    sse: () => `<span class="pill ${S.sse && S.snap.hub_ok ? "live" : ""}">${S.sse && S.snap.hub_ok ? "Live" : "Disconnected"}</span>`,
    bars: () => {
      const c = channel(S.ovChan) ?? channels()[0];
      if (!c) return `<div class="empty"><p>No channel records a pin yet.</p>${btn("Record a pin", { act: "go", data: { nav: "realtime" }, color: "primary" })}</div>`;
      const rs = (S.readings[c.id] ?? []).slice(-40);
      if (!rs.length) return `<p class="small muted">Waiting for the first reading of ${esc(c.label)}.</p>`;
      const vs = rs.map((r) => r.v);
      const lo = Math.min(0, ...vs), hi = Math.max(...vs);
      const span = hi - lo || 1;
      return `<div class="bars">${rs.map((r) => `<span data-h="${Math.max(2, ((r.v - lo) / span) * 100).toFixed(1)}" title="${esc(`${fmtNum(r.v)} ${unitOf(c)} at ${fmtTime(r.t)}`)}"></span>`).join("")}</div>
        <p class="tiny muted">${esc(c.label)} on ${esc(devName(c.node))} ${esc(c.pin)}, last ${rs.length} readings, ${esc(fmtNum(Math.min(...vs)))} to ${esc(fmtNum(hi))} ${esc(unitOf(c))}</p>`;
    },
    recent: () => logList(S.st.audit.slice(-20).reverse(), "No recent alerts."),
    health: () => {
      const h = S.snap;
      const rules = (S.st.rules ?? []).filter((r) => r.enabled).length;
      return statusItem("Dashboard", `version ${S.st.version}, you are ${S.st.me.name} (${S.st.me.role})`) +
        statusItem("Hub", h.hub_ok ? `${S.st.hub_url} · version ${h.hub_version}` : h.hub_error || "not answering", h.hub_ok ? "success" : "danger") +
        statusItem("Stream", S.sse ? "SSE connected" : "SSE offline", S.sse ? "success" : "danger") +
        statusItem("Node door", S.st.nodes_url) +
        statusItem("Recording", `${channels().length} channels, ${rules} rules on, data kept ${S.st.settings.retention_days} days`);
    },
  },
  deps: { kpis: ["snapshot", "config", "reading"], ovpick: ["config"], sse: ["sse", "snapshot"], bars: ["reading", "config"], recent: ["audit", "config"], health: ["sse", "config", "nodes"] },
};

function surveyView(node, sv) {
  const group = (label, pins, color) => `<div class="row wrap"><span class="tiny muted w5">${label}</span>${pins.length ? pins.map((p) => chip(p, color)).join("") : '<span class="tiny muted">none</span>'}</div>`;
  const ohm = ({ lo, hi }) => (hi >= 1000 ? `${+(lo / 1000).toFixed(2)}-${+(hi / 1000).toFixed(2)} kΩ` : `${lo}-${hi} Ω`);
  const thev = (p) => (p.v_th && p.r_th_ohm ? `${p.v_th.lo}-${p.v_th.hi} V through ${ohm(p.r_th_ohm)}` : "n/a");
  return `<div class="stack">
    <div class="row between start gap-3"><p class="h-md">${esc(sv.summary)}</p>${btn("Back", { act: "closeview", data: { node }, variant: "light" })}</div>
    ${group("attached", sv.attached, "primary")}${group("unresolved", sv.unresolved, "warning")}${group("floating", sv.floating, "default")}
    <div class="table-wrap"><table><thead><tr><th>Pin</th><th>Label</th><th>Class</th><th>Confidence</th><th>Hi-Z</th><th>Thevenin</th><th>Note</th></tr></thead><tbody>
    ${sv.pins.map((p) => `<tr><td>${esc(p.pin)}</td><td>${esc(p.label ?? "")}</td><td>${esc(words(p.class))}</td><td>${esc(p.confidence)}</td><td>${esc(p.readings?.hiz ?? "n/a")}</td><td>${esc(thev(p))}</td><td class="soft">${esc(p.note ?? "")}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="stack tight small">${sv.buses.map((b) => `<p>${esc(b.bus)}: ${b.result.found.length ? esc(b.result.found.map(String).join(", ")) : `nothing on ${esc(b.bus)}`}${b.note ? `<span class="tiny muted block">${esc(b.note)}</span>` : ""}</p>`).join("")}</div>
    <details><summary>What this cannot tell</summary><ul>${sv.limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details>
  </div>`;
}

function nodeCard(n) {
  const view = S.views[n.node];
  const spin = S.busy[n.node];
  const full = view?.mode === "survey" ? "span-all" : "";
  let body = `<pre class="wire" data-wire="${esc(n.node)}"></pre>`;
  if (spin) body += spinner(spin);
  else if (view?.mode === "survey") body += surveyView(n.node, view.survey);
  else if (view?.mode === "pins") {
    body += `<div class="stack tight"><div class="row between"><span class="small h-md">Pins</span>${btn("Back", { act: "closeview", data: { node: n.node }, variant: "light" })}</div>
      <ul class="stack tight">${view.described.pins.map((p) => `<li class="row wrap small"><span class="w4">${esc(p.id)}</span>${p.label ? `<span class="muted">${esc(p.label)}</span>` : ""}${p.caps.map((c) => chip(c, "default", "bordered")).join("")}</li>`).join("")}</ul></div>`;
  } else {
    body += `<div class="stack tight"><p class="tiny muted">${esc(where(n.port ?? n.spec))}</p><p class="tiny muted">IO ${esc(n.vio)} V${n.simulated ? " · simulated" : ""}</p>${hostedLine(n) ? `<p class="tiny muted">${esc(hostedLine(n))}</p>` : ""}</div>`;
  }
  const footer = view || spin ? "" :
    btn("Survey", { act: "survey", data: { node: n.node }, color: "primary", cls: "grow" }) +
    btn("Pins", { act: "pins", data: { node: n.node }, cls: "grow" }) +
    btn("Control", { act: "go", data: { nav: "device", node: n.node }, cls: "grow" }) +
    (can("operator") ? btn("Disconnect", { act: "disconnect", data: { node: n.node }, color: "danger", variant: "light" }) : "");
  return card({
    cls: full,
    header: `<div class="grow"><h3 class="h-lg break">${esc(n.board)}</h3><p class="tiny muted">${esc(n.node)}${device(n.node) && device(n.node).name !== n.node ? ` · ${esc(device(n.node).name)}` : ""}</p><span class="beacon" data-beacon="${esc(n.node)}" hidden><span class="led"></span><span class="label"></span></span></div>
      ${chip(TRANSPORT[n.transport] ?? n.transport)}`,
    body,
    footer,
  });
}

function bringIn() {
  const key = S.st.node_key || "<node key: ask an admin>";
  const url = S.st.nodes_url;
  const image = S.st.hub_image;
  const bridge = `docker run -d --name synapse-bridge --restart unless-stopped --network host --user 0 --cap-drop ALL --security-opt no-new-privileges \\\n  --device-cgroup-rule 'c 188:* rmw' --device-cgroup-rule 'c 166:* rmw' \\\n  --mount type=bind,source=/dev,target=/host/dev,readonly,bind-recursive=disabled -e SYNAPSE_DEV_DIR=/host/dev \\\n  -e SYNAPSE_NODE_KEY=${key} ${image} \\\n  npx tsx src/cli.ts bridge auto --to ${url}`;
  return { bridge, key, url };
}

const USB_COMPOSE = `    environment:
      SYNAPSE_DEV_DIR: /host/dev
    group_add:
      - "\${SYNAPSE_SERIAL_GID:-dialout}"
    device_cgroup_rules:
      - "c 188:* rmw"
      - "c 166:* rmw"
    volumes:
      - type: bind
        source: /dev
        target: /host/dev
        read_only: true
        bind:
          create_host_path: false
          recursive: disabled`;

const newer = (a, b) => {
  const x = String(a ?? "0").split(".").map(Number), y = String(b ?? "0").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const boardName = (b) => ({ "esp32-devkit": "ESP32 DevKit", "arduino-uno": "Arduino Uno", "arduino-mega": "Arduino Mega", "rp2040-pico": "Raspberry Pi Pico", "esp32-s3": "ESP32-S3", "esp32-c3": "ESP32-C3", atmega328p: "ATmega328P board" })[b] ?? b;
const runs = (id) => (id.state === "firmata" ? `Firmata ${id.firmata?.version ?? ""} ${id.firmata?.name ?? ""}` : `MicroPython ${id.micropython?.version ?? ""} (${id.micropython?.machine ?? ""})`).trim();
const chipOf = (id) => (id?.chip ? ` · chip ${esc(id.chip.detail?.chip || id.chip.name)}` : "");
const HOSTED_NOTE = {
  firmata: "Add as it is leaves the board untouched: the hub speaks Firmata for it. Its failsafe and timing then live on the hub, so if the hub stops, outputs hold until the board resets.",
  micropython: "Add as it is leaves the board untouched: the hub speaks MicroPython for it, and a timer on the board keeps the failsafe. Disconnecting soft-resets it so its own program runs again.",
};
const hostedLine = (n) => (n?.driver && n.driver !== "synapse" ? `runs ${n.fw}; the hub speaks for it · failsafe on the ${n.failsafe} · timing on the ${n.timing}` : "");
const latestFw = () => S.manifest?.fw;
const portLabel = (p) => (p.candidates ?? []).filter((c) => c !== "unknown" && c !== "other").join(" or ") || "a USB serial board";

S.usb = { ports: null, hidden: [], ids: {}, work: {}, err: "" };
S.manifest = null;
S.backups = null;

async function loadBackups() {
  try { S.backups = await call("list_backups"); }
  catch (e) { S.backups = { error: e.message }; }
  refresh("backups");
}

async function loadManifest() {
  if (S.manifest) return;
  try {
    const res = await fetch("/firmware/manifest.json");
    if (res.ok) { S.manifest = await res.json(); refresh("usb"); refresh("web"); }
  } catch {}
}

async function pollPorts() {
  if (S.nav !== "provisioning" || S.usb.polling) return;
  S.usb.polling = true;
  try {
    const r = await call("list_ports");
    S.usb.ports = r.ports;
    S.usb.hidden = r.hidden ?? [];
    S.usb.err = "";
    for (const k of Object.keys(S.usb.ids)) if (!r.ports.some((p) => p.port === k)) delete S.usb.ids[k];
    for (const p of r.ports) if (!p.node && !S.usb.ids[p.port] && !S.usb.work[p.port]) probePort(p.port);
  } catch (e) {
    S.usb.err = e.message;
  } finally {
    S.usb.polling = false;
  }
  refresh("usb");
}

async function probePort(port, deep = false) {
  S.usb.ids[port] = { probing: true, deep };
  refresh("usb");
  try {
    const [id] = await call("scan_devices", deep ? { port, deep: true } : { port });
    S.usb.ids[port] = id ?? { state: "unknown", notes: [] };
  } catch (e) {
    S.usb.ids[port] = { state: "unknown", notes: [e.message] };
  }
  refresh("usb");
}

function usbRow(p) {
  const id = S.usb.ids[p.port];
  const work = S.usb.work[p.port];
  const op = can("operator");
  const data = { port: p.port };
  const head = (title, sub) => `<div class="grow"><p class="h-md">${title}</p><p class="tiny muted">${esc(p.port)} · ${esc(p.bridge)}${sub ? ` · ${sub}` : ""}</p></div>`;
  let main, acts = "";
  if (work) {
    main = head(esc(portLabel(p)), "");
    acts = `<span class="spinner small">${esc(work)}</span>`;
  } else if (p.node) {
    const n = liveNode(p.node);
    main = head(`${esc(devName(p.node))} <span class="tiny muted">${esc(boardName(n?.board ?? ""))}</span>`, "on the hub");
    acts = chip("on the hub", "success") + btn("Open", { act: "go", data: { nav: "device", node: p.node }, color: "primary", variant: "solid" });
  } else if (!id || id.probing) {
    main = head(esc(portLabel(p)), "");
    acts = `<span class="spinner small">${id?.deep ? "Asking the chip itself (the board resets)" : "Asking the board what it runs"}</span>`;
  } else if (id.state === "firmata" || id.state === "micropython") {
    main = head(esc(portLabel(p)), `runs ${esc(runs(id))}${chipOf(id)}`);
    acts = op
      ? btn("Ask the chip", { act: "chipport", data, variant: "light", title: "reset the board into its bootloader and read the chip; writes nothing" }) +
        btn("Install Synapse firmware", { act: "flashport", data, variant: "light" }) +
        btn("Add as it is", { act: "addport", data: { port: p.port, as: id.state }, color: "primary", variant: "solid" })
      : `<span class="tiny muted">an operator can add it</span>`;
  } else if (id.state === "synapse") {
    const old = latestFw() && newer(latestFw(), id.synapse.fw);
    main = head(esc(boardName(id.synapse.board)), `Synapse firmware ${esc(id.synapse.fw)}${old ? `, ${esc(latestFw())} is out` : ""}`);
    acts = op
      ? (old ? btn(`Update to ${esc(latestFw())}`, { act: "flashport", data }) : "") + btn("Add to the hub", { act: "addport", data, color: "primary", variant: "solid" })
      : `<span class="tiny muted">an operator can add it</span>`;
  } else if (id.state === "busy" || id.state === "denied") {
    main = head(esc(portLabel(p)), `<span class="warn-text">${esc(id.state === "busy" ? "another program on this server holds the port" : "the hub may not open the port")}</span>`);
    acts = btn("Check again", { act: "reprobe", data });
  } else {
    main = head(esc(portLabel(p)), `no Synapse firmware, Firmata or MicroPython answered${chipOf(id)}`);
    acts = op && p.family !== "native"
      ? btn("Check again", { act: "reprobe", data, variant: "light" }) + btn("Ask the chip", { act: "chipport", data, variant: "light", title: "reset the board into its bootloader and read the chip; writes nothing" }) + btn("Install Synapse firmware", { act: "flashport", data, color: "primary", variant: "solid" })
      : btn("Check again", { act: "reprobe", data, variant: "light" });
  }
  const said = [...(id?.notes ?? []), ...(HOSTED_NOTE[id?.state] ? [HOSTED_NOTE[id.state]] : [])];
  const notes = !work && !p.node && !id?.probing && said.length && id.state !== "synapse" ? `<p class="tiny soft">${esc(said.join(" "))}</p>` : "";
  return `<div class="py3 stack tight"><div class="row wrap between gap-3">${main}<div class="row wrap">${acts}</div></div>${notes}</div>`;
}

function openFlash(port) {
  const id = S.usb.ids[port];
  const what = id?.state === "synapse" ? `updates the Synapse firmware on ${esc(port)} to ${esc(latestFw() ?? "the hub's build")}`
    : id?.state === "firmata" || id?.state === "micropython" ? `replaces ${esc(runs(id))} on ${esc(port)} with Synapse firmware, which keeps its own failsafe and microsecond timing on the board`
    : `replaces whatever runs on the board on ${esc(port)} with Synapse firmware`;
  modal("Install Synapse firmware",
    `<p class="small soft">This ${what}. The hub first saves a full copy of the board's flash in its data folder; Saved copies of boards, on this page, puts it back byte for byte. Then it writes the firmware, checks every byte, and adds the board to the hub.</p>
    <p class="small soft">It takes a minute or two. Leave the board plugged in until it is on the hub.</p>`,
    btn("Cancel", { act: "close", variant: "light" }) + btn("Install", { act: "doflash", data: { port }, color: "primary", variant: "solid" }));
}

async function flashPort(port) {
  closeModal();
  S.usb.work[port] = "Saving a copy of the board, then installing (a minute or two)";
  refresh("usb");
  try {
    const r = await call("flash_node", { port });
    toast(`Installed and checked; ${port} is on the hub as ${r.connected_as}`);
    delete S.usb.ids[port];
  } catch (e) {
    toast(`Install on ${port} failed: ${e.message}`, true);
    delete S.usb.ids[port];
  } finally {
    delete S.usb.work[port];
    pollPorts();
    loadBackups();
  }
}

function openRestore(file) {
  const b = (S.backups ?? []).find?.((x) => x.file === file);
  const ports = (S.usb.ports ?? []).map((p) => [p.port, `${p.port} · ${portLabel(p)}${p.node ? ` (on the hub as ${p.node})` : ""}`]);
  if (!ports.length) { toast("Plug the board into this server first", true); return; }
  modal("Put a saved copy back",
    `<p class="small soft">This writes ${esc(file)} (${esc(b?.ran ?? "")}, from ${esc(b?.device ?? "")}) back onto a board, byte for byte, and checks it. Whatever the board runs now is replaced, Synapse firmware included. The hub refuses if the board's chip is not a ${esc(b?.chip ?? "")}.</p>
    <form data-form="restore">${field("Board", select("port", ports, ports[0][0]))}<input type="hidden" name="file" value="${esc(file)}"></form>`,
    btn("Cancel", { act: "close", variant: "light" }) + btn("Put it back", { act: "dorestore", color: "danger", variant: "solid" }));
}

async function restorePort(port, file) {
  closeModal();
  S.usb.work[port] = "Putting the saved copy back (a minute for an ESP32)";
  refresh("usb");
  try {
    const r = await call("restore_node", { port, file });
    toast(`${port} is back to ${r.now_runs === "synapse" ? `Synapse firmware ${r.synapse?.fw ?? ""}` : r.now_runs === "firmata" ? `Firmata ${r.firmata?.version ?? ""}` : r.now_runs === "micropython" ? `MicroPython ${r.micropython?.version ?? ""}` : r.now_runs}; checked byte for byte`);
  } catch (e) {
    toast(`Putting ${file} back failed: ${e.message}`, true);
  } finally {
    delete S.usb.work[port];
    delete S.usb.ids[port];
    pollPorts();
  }
}

async function addPort(port, as) {
  S.usb.work[port] = as ? `Taking over its ${as === "firmata" ? "Firmata" : "MicroPython"}` : "Adding it to the hub";
  refresh("usb");
  try {
    const [n] = await call("connect_node", { port: as ? `${as}:${port}` : port });
    toast(`${port} is on the hub as ${n.node}; open it to drive its pins`);
  } catch (e) {
    toast(e.message, true);
    delete S.usb.ids[port];
  } finally {
    delete S.usb.work[port];
    pollPorts();
  }
}

S.web = null;
const tabDoor = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/nodes`;
const serialMod = () => import("/static/serial.js");

function webSet(patch) {
  if (!S.web) return;
  Object.assign(S.web, patch);
  refresh("web");
}

async function webPick() {
  let port;
  try { port = await navigator.serial.requestPort(); }
  catch { return; }
  const m = await serialMod();
  await webReset();
  const g = m.guess(port.getInfo());
  S.web = { port, family: g.family, name: g.name, phase: "detect", msg: "", pct: 0 };
  refresh("web");
  await webDetect();
}

async function webDetect() {
  const m = await serialMod();
  webSet({ phase: "detect", msg: "", describe: null });
  try {
    const { link, describe } = await m.detect(S.web.port);
    S.web.link = link;
    if (describe?.node) {
      const fam = describe.node.arch === "esp32" ? "esp" : "avr";
      webSet({ describe, family: fam, phase: latestFw() && newer(latestFw(), describe.node.fw) ? "old" : "ready" });
      if (S.web.phase === "ready" && fam === "esp") webNet();
    } else {
      await link.close();
      S.web.link = null;
      webSet({ phase: "needfw" });
    }
  } catch (e) {
    webSet({ phase: "error", msg: /already open|Failed to open/i.test(e.message) ? "Another program on this computer has the port open (a serial monitor, the Arduino IDE, a bridge). Close it and press Check again." : e.message });
  }
}

async function webFlash(kind) {
  const m = await serialMod();
  const w = S.web;
  if (w.link) { await w.link.close(); w.link = null; }
  webSet({ phase: "flashing", msg: "Downloading the firmware from the hub", pct: 0 });
  try {
    const progress = (msg, pct) => webSet({ msg, pct });
    if (kind === "esp") {
      const img = await m.firmware("esp32dev");
      await m.flashEsp32(w.port, img, progress);
    } else {
      const res = await fetch("/firmware/uno.hex");
      if (!res.ok) throw new Error(`firmware download failed (HTTP ${res.status})`);
      await m.flashAvr(w.port, await res.text(), progress);
    }
    await new Promise((r) => setTimeout(r, 1500));
    await webDetect();
  } catch (e) {
    webSet({ phase: "error", msg: `Installing failed: ${e.message}` });
  }
}

async function webNet() {
  const m = await serialMod();
  try { webSet({ net: await m.request(S.web.link, "net", {}) }); } catch {}
}

async function webJoin(f) {
  const m = await serialMod();
  const el = f.elements;
  const set = { ssid: el.ssid.value, pass: el.pass.value, hub: el.hub.value.trim(), key: S.st.node_key };
  if (!set.ssid || !set.hub) { $("[data-web-err]", f).textContent = "Give the Wi-Fi name and the hub address."; return; }
  webSet({ phase: "joining", net: null, since: Date.now() });
  try {
    webSet({ net: await m.request(S.web.link, "net", { set }) });
  } catch (e) {
    webSet({ phase: "ready", msg: e.message });
    return;
  }
  const tick = async () => {
    const w = S.web;
    if (!w || w.phase !== "joining") return;
    const id = w.describe.node.id;
    const n = (S.snap.nodes ?? []).find((x) => x.id === id);
    if (n) { webSet({ phase: "joined", node: n.node }); return; }
    try { webSet({ net: await m.request(w.link, "net", {}, "user:browser", 3000) }); } catch {}
    setTimeout(tick, 1500);
  };
  tick();
}

async function webBridge() {
  const m = await serialMod();
  const w = S.web;
  webSet({ phase: "bridged", bridge: "dialling" });
  w.stop = m.tabBridge(w.link, tabDoor(), S.st.node_key, (s) => webSet({ bridge: s }));
}

async function webReset() {
  const w = S.web;
  S.web = null;
  if (!w) return;
  w.stop?.();
  await w.link?.close().catch(() => {});
}

function webView() {
  if (!("serial" in navigator) || !isSecureContext) return `<p class="small soft">This browser cannot reach USB. Open this page in Chrome or Edge on the computer the board is plugged into${isSecureContext ? "" : ", over https"}.</p>`;
  if (!can("admin")) return '<p class="small muted">An admin sets up boards from their computer, because the board is handed the node key.</p>';
  const w = S.web;
  if (!w) return `<p class="small soft">Plug the board into this computer, then choose it. The page reads what it runs, installs Synapse firmware if it needs it, and brings it onto the hub: an ESP32 over its own Wi-Fi, any other board through this tab.</p>
    <div class="row">${btn("Choose the board", { act: "webpick", color: "primary", variant: "solid", size: "md" })}</div>`;
  const d = w.describe?.node;
  const li = (cls, text) => `<li class="${cls}">${text}</li>`;
  const steps = [li("done", `Found ${esc(w.name)} on this computer's USB`)];
  let body = "";
  if (w.phase === "detect") steps.push(li("now", "Asking the board what it runs"));
  else if (w.phase === "error") { steps.push(li("bad", esc(w.msg))); body = btn("Check again", { act: "webdetect", color: "primary" }); }
  else if (w.phase === "needfw" || w.phase === "old") {
    steps.push(li("now", w.phase === "old" ? `It runs Synapse firmware ${esc(d.fw)}; ${esc(latestFw())} is out` : "It does not run Synapse firmware yet"));
    const esp = btn("Install for ESP32", { act: "webflash", data: { kind: "esp" }, color: "primary", variant: "solid" });
    const avr = btn("Install for Arduino Uno or Nano", { act: "webflash", data: { kind: "avr" }, color: w.family === "either" ? "primary" : "default", variant: w.family === "either" ? "solid" : "flat" });
    body = `<p class="small soft">Installing overwrites whatever the board runs now. ${w.family === "either" ? "This USB chip sits on both kinds of board: pick the one in your hand." : ""}</p>
      <div class="row wrap">${w.family === "avr" ? avr : w.family === "esp" ? esp : esp + avr}${w.phase === "old" ? btn("Keep the old firmware", { act: "webkeep", variant: "light" }) : ""}</div>`;
  } else if (w.phase === "flashing") {
    steps.push(li("now", `${esc(w.msg)} ${w.pct ? `${Math.round(w.pct * 100)}%` : ""}`));
    body = `<div class="meter"><span data-w="${Math.round(w.pct * 100)}"></span></div><p class="tiny muted">Keep the board plugged in and this tab open.</p>`;
  } else {
    steps.push(li("done", `Synapse firmware ${esc(d.fw)} on ${esc(boardName(d.board))} (${esc(d.id)})`));
    if (w.family === "esp") body = espView(w);
    else body = avrView(w);
  }
  return `<ul class="checks">${steps.join("")}</ul>${body}
    <div class="row">${btn("Start over", { act: "webreset", variant: "light" })}</div>`;
}

function hubStep(w) {
  return w.node
    ? `<li class="done">On the hub as <strong>${esc(devName(w.node))}</strong> ${btn("Open", { act: "go", data: { nav: "device", node: w.node }, color: "primary", variant: "solid" })}</li>`
    : `<li class="now">Waiting for it to reach the hub</li>`;
}

function espView(w) {
  const n = w.net;
  if (w.phase === "joining" || w.phase === "joined") {
    const wifi = n?.wifi === "up" ? `<li class="done">Joined Wi-Fi ${esc(n.ssid)} at ${esc(n.ip)} (${esc(n.rssi)} dBm)</li>` : `<li class="now">Joining Wi-Fi</li>`;
    const link = n?.link === "up" ? `<li class="done">Dialled ${esc(n.hub)}</li>` : n?.wifi === "up" ? `<li class="now">Dialling the hub</li>` : "";
    const brown = n?.power === "brownout" ? `<p class="small warn-text">The board's supply sagged when its radio started; most computer USB ports cannot feed an ESP32's Wi-Fi. It keeps its settings: plug it into a phone charger or battery bank and it dials in by itself.</p>` : "";
    const slow = !w.node && w.since && Date.now() - w.since > 45000 && n?.wifi !== "up" ? `<p class="small warn-text">It has not joined Wi-Fi yet. Check the name and password (2.4 GHz networks only), then save again.</p>` : "";
    const done = w.phase === "joined" ? `<p class="small soft">It holds the Wi-Fi and hub settings in its flash. Unplug it and power it from anything: it dials in by itself and its LED shows the state.</p>` : "";
    return `<ul class="checks"><li class="done">Stored the Wi-Fi and the hub address</li>${wifi}${link}${w.phase === "joined" ? hubStep(w) : n?.link === "up" ? `<li class="now">Waiting for the hub to list it</li>` : ""}</ul>${brown}${slow}${done}
      ${w.phase === "joining" ? `<div class="row">${btn("Change the Wi-Fi", { act: "webwifi", variant: "light" })}</div>` : ""}`;
  }
  if (w.phase === "bridged") return avrView(w);
  const have = n?.ssid ? `<p class="tiny muted">It holds Wi-Fi ${esc(n.ssid)} and hub ${esc(n.hub || "none")} now${n.wifi === "off" ? "" : `, Wi-Fi ${esc(n.wifi)}`}.</p>` : "";
  return `<form data-form="webjoin" class="stack tight">
      <p class="small soft">Give it the Wi-Fi it will live on. It stores the network, this hub's address and the node key, then dials in by itself on any power supply.</p>
      <div class="form-grid">
        ${field("Wi-Fi name", input("ssid", { value: n?.ssid ?? "", extra: 'autocomplete="off"' }))}
        ${field("Wi-Fi password", input("pass", { type: "password", extra: 'autocomplete="new-password"' }))}
        ${field("Hub address", input("hub", { value: S.st.nodes_url }), "the node door the board dials")}
      </div>${have}
      <p class="err" data-web-err>${esc(w.msg ?? "")}</p>
      <div class="row wrap">${btn("Save and join", { type: "submit", color: "primary", variant: "solid" })}${btn("Or carry it through this tab", { act: "webbridge", variant: "light" })}</div>
    </form>`;
}

function avrView(w) {
  if (w.phase !== "bridged") return `<p class="small soft">${w.family === "esp" ? "" : "This board has no radio. "}This tab can carry it to the hub while the tab stays open. To keep it on the hub for good, plug it into this server, or into any computer running the bridge below.</p>
    <div class="row">${btn("Bring it onto the hub through this tab", { act: "webbridge", color: "primary", variant: "solid" })}</div>`;
  if (!w.node) {
    const id = w.describe.node.id;
    const n = (S.snap.nodes ?? []).find((x) => x.id === id);
    if (n) w.node = n.node;
  }
  const state = { dialling: "Dialling the hub", open: "Linked to the hub", lost: "The link dropped; dialling again", stopped: "Stopped" }[w.bridge] ?? w.bridge;
  return `<ul class="checks"><li class="${w.bridge === "open" ? "done" : "now"}">${esc(state)} through this tab</li>${w.bridge === "open" ? hubStep(w) : ""}</ul>
    <p class="tiny muted">The board stays on the hub while this tab is open. You can use the rest of the dashboard in it.</p>
    <div class="row">${btn("Stop", { act: "webreset", color: "danger", variant: "light" })}</div>`;
}

const BEACON_LEGEND = "one flash, no hub; two, joining Wi-Fi; three, dialling; one long, on the hub; flicker, a lease is active; four, radio held off after a brownout; five, failsafe.";

VIEWS.nodes = {
  title: "Connected Nodes",
  html: () => `<div class="stack">
      <div class="row wrap between gap-3">
        <div class="row wrap gap-3"><h2 class="h-2xl">Nodes</h2><div class="row" data-part="hubchips"></div></div>
        <div class="row wrap">${btn("Refresh", { act: "reload", variant: "light" })}${btn("Add a board", { act: "go", data: { nav: "provisioning" }, color: "primary", variant: "solid" })}</div>
      </div>
      <div data-part="list"></div>
      <p class="tiny muted">Each board's LED shows its state: ${BEACON_LEGEND}</p>
    </div>`,
  parts: {
    hubchips: () => S.snap.hub_ok
      ? chip(`hub ${S.snap.hub_version}`) + chip(can("operator") ? "read-write" : "read-only", can("operator") ? "warning" : "default")
      : chip("hub offline", "danger"),
    list: () => {
      if (!S.snap.hub_ok) return empty(`The hub did not answer. Check that it is running, then press Refresh.${S.snap.hub_error ? `<br><span class="small">${esc(S.snap.hub_error)}</span>` : ""}`);
      const nodes = S.snap.nodes ?? [];
      if (!nodes.length) return empty("No board is on the hub yet. Plug one into this server or your computer and add it.", btn("Add a board", { act: "go", data: { nav: "provisioning" }, color: "primary" }));
      return `<div class="grid cards">${nodes.map(nodeCard).join("")}</div>`;
    },
  },
  deps: { hubchips: ["nodes"], list: ["nodes", "views", "config"] },
};

function openConnect() {
  S.via = S.via ?? "usb";
  const form = () => `${S.via === "usb"
    ? field("Port", input("port", { placeholder: "/dev/ttyACM0" }), "auto connects every Synapse board")
    : `<div class="form-grid">${field("Host", input("host", { placeholder: "machine name or address" }))}${field("Port", input("netport", { value: "4001" }))}${field("Heartbeat (ms)", input("hb", { placeholder: "optional" }))}</div>`}
    ${field("Node name", input("name", { placeholder: "optional" }))}<p class="err" data-connect-err></p>`;
  const m = modal("Connect a board",
    `<div class="row">${btn("USB port on the server", { act: "via", data: { via: "usb" }, variant: S.via === "usb" ? "solid" : "flat" })}${btn("Over the network", { act: "via", data: { via: "net" }, variant: S.via === "net" ? "solid" : "flat" })}</div><form data-form="connect" id="connect-form">${form()}</form>`,
    btn("Cancel", { act: "close", variant: "light" }) + btn("Connect", { act: "submitconnect", color: "primary", variant: "solid" }));
  return m;
}

VIEWS.devices = {
  title: "Device Fleet",
  html: () => `<div class="stack">
    <div class="row wrap between gap-3">
      <div><h2 class="h-2xl">My Devices</h2><p class="small muted">Every board that has reached this hub. Names and descriptions are yours; status is the hub's, live.</p></div>
      ${can("operator") ? btn("+ Register New Device", { act: "register", color: "primary", variant: "solid", size: "md" }) : ""}
    </div>
    ${card({
      header: `<h3 class="h-lg grow">Registered Devices</h3><span data-part="pill"></span>`,
      body: `<div class="row wrap">
          <label class="field sm grow"><input class="field-input" data-input="devq" placeholder="Search by name, node or board" value="${esc(S.q.q ?? "")}"></label>
          <label class="field sm">${select("status", [["all", "All statuses"], ["online", "Online"], ["offline", "Offline"]], S.devStatus ?? "all", 'data-change="devstatus"')}</label>
          ${btn("Refresh", { act: "reload", variant: "light" })}
        </div>
        <div data-part="grid"></div>`,
    })}
  </div>`,
  parts: {
    pill: hubPill,
    grid: () => {
      const q = (S.q.q ?? "").toLowerCase();
      const st = S.devStatus ?? "all";
      const list = devices()
        .filter((d) => !q || [d.name, d.node, d.board, d.description, d.id].some((x) => String(x ?? "").toLowerCase().includes(q)))
        .filter((d) => st === "all" || (st === "online") === online(d.node))
        .sort((a, b) => Number(online(b.node)) - Number(online(a.node)) || a.name.localeCompare(b.name));
      if (!devices().length) return `<div class="empty"><p>No device has reached this hub yet.</p>${btn("Add a board",{ act: "go", data: { nav: "provisioning" }, color: "primary" })}</div>`;
      if (!list.length) return '<p class="small muted">No device matches.</p>';
      const pages = Math.ceil(list.length / 9);
      S.page = Math.min(S.page, pages);
      const shown = list.slice((S.page - 1) * 9, S.page * 9);
      const pager = pages > 1 ? `<div class="row end">${Array.from({ length: pages }, (_, i) => btn(String(i + 1), { act: "page", data: { page: i + 1 }, variant: S.page === i + 1 ? "solid" : "light", cls: "icon" })).join("")}</div>` : "";
      return `<div class="grid cards">${shown.map((d) => {
        const on = online(d.node);
        return card({
          header: `<div class="grow"><h4 class="h-lg">${esc(d.name)}</h4><p class="tiny muted">${esc(d.node)} · ${esc(d.board)}${d.id ? ` · ${esc(d.id)}` : ""}</p></div>${chip(on ? "online" : "offline", on ? "success" : "danger")}`,
          body: `<p class="small soft">${esc(d.description || "No description")}</p>
            <p class="tiny muted">${esc(where(d.where))}</p>
            <p class="tiny muted">${on ? "on the hub now" : `last seen ${esc(ago(d.last_seen))}`} · first seen ${esc(fmtWhen(d.first_seen))}</p>
            <span class="beacon" data-beacon="${esc(d.node)}" hidden><span class="led"></span><span class="label"></span></span>`,
          footer: btn("Open", { act: "go", data: { nav: "device", node: d.node }, color: "primary", cls: "grow" }) +
            (on && can("operator") ? btn("Disconnect", { act: "disconnect", data: { node: d.node }, variant: "light" }) : "") +
            (can("admin") ? btn("Forget", { act: "forget", data: { node: d.node }, color: "danger", variant: "light" }) : ""),
        });
      }).join("")}</div>${pager}`;
    },
  },
  deps: { pill: ["nodes", "sse"], grid: ["nodes", "config", "devlist"] },
};

function openRegister() {
  const opts = devices().map((d) => [d.node, `${d.name} (${d.node}, ${online(d.node) ? "online" : "offline"})`]);
  const first = devices()[0];
  modal("Register a device",
    `<p class="small soft">A board registers itself the first time it reaches the hub. Give it a name and say what it is wired to; the name shows everywhere in the dashboard.</p>
    ${opts.length ? `<form data-form="register" id="register-form" class="stack tight">
      ${field("Device", select("node", opts, first?.node, 'data-change="regpick"'))}
      ${field("Name", input("name", { value: first?.name ?? "", placeholder: "Greenhouse controller" }))}
      ${field("Description", `<textarea class="field-input" name="description" placeholder="What is wired to it, where it lives">${esc(first?.description ?? "")}</textarea>`)}
    </form>` : '<p class="small muted">No board has reached the hub yet.</p>'}
    <div class="stack tight"><p class="h-md">A new board</p>
      <p class="small soft">Plug it into this server or into your computer, then open Add a board. It installs the firmware if the board needs it and brings the board onto the hub; its LED shows one long flash while it is on the hub.</p>
      ${btn("Add a board", { act: "go", data: { nav: "provisioning" }, variant: "light" })}
    </div>`,
    btn("Cancel", { act: "close", variant: "light" }) + (opts.length ? btn("Save", { act: "submitregister", color: "primary", variant: "solid" }) : ""), true);
}

function valueText(v) {
  if (!v) return "–";
  if (v.error) return `<span class="bad-text">${esc(v.error)}</span>`;
  if (v.driven !== undefined) return `driven ${v.driven ? "HIGH" : "LOW"} <span class="tiny muted">press Read to measure</span>`;
  if (v.out) return `${esc(v.out)} <span class="tiny muted">the hardware's own figures</span>`;
  if (v.unit === "logic") return v.v ? "HIGH (1)" : "LOW (0)";
  const duty = v.duty !== undefined && v.duty_err < 0.5 ? ` · duty ${esc(fmtNum(v.duty * 100))} %` : "";
  return `${esc(qty(v.v, v.unit))}${duty} <span class="tiny muted">±${esc(v.unit === "Hz" ? qty(v.err, "Hz") : fmtNum(v.err))}</span>${(v.flags ?? []).filter((f) => f !== "uncalibrated").map((f) => " " + chip(words(f), "warning")).join("")}`;
}

function pinRows(node, d) {
  const op = can("operator");
  const modes = (caps) => [["", "mode…"], ...(caps.includes("din") ? [["in", "input"]] : []), ...(caps.includes("pullup") ? [["in_pullup", "input + pull-up"]] : []), ...(caps.includes("pulldown") ? [["in_pulldown", "input + pull-down"]] : []), ...(caps.includes("dout") ? [["out", "output"]] : []), ["hiz", "hi-Z"]];
  return d.pins.filter((p) => !d.reserved.includes(p.id)).map((p) => {
    const key = `${node}:${p.id}`;
    const has = (c) => p.caps.includes(c);
    const acts = [
      has("ain") ? btn("Read V", { act: "readpin", data: { node, pin: p.id, as: "a" } }) : "",
      has("din") ? btn("Read", { act: "readpin", data: { node, pin: p.id, as: "d" } }) : "",
      has("count") ? btn("Freq", { act: "readpin", data: { node, pin: p.id, as: "f" }, title: `count edges for 100 ms${p.count ? `, up to ${qty(p.count.max_hz, "Hz")}` : ""}` }) : "",
      has("touch") ? btn("Touch", { act: "readpin", data: { node, pin: p.id, as: "t" }, title: "capacitive touch count; it drops when a finger nears the pad" }) : "",
      op && has("dout") ? btn("High", { act: "drive", data: { node, pin: p.id, value: 1 }, color: "primary" }) + btn("Low", { act: "drive", data: { node, pin: p.id, value: 0 } }) : "",
      op && has("pwm") ? `${p.pwm && !p.pwm.hz ? `<label class="field sm duty" title="PWM frequency, Hz, up to ${esc(qty(p.pwm.max_hz, "Hz"))}"><input class="field-input" type="number" min="1" max="${p.pwm.max_hz}" step="1" value="1000" data-hz="${esc(key)}"></label>` : ""}<label class="field sm duty" title="PWM duty, percent"><input class="field-input" type="number" min="0" max="100" step="1" value="50" data-duty="${esc(key)}"></label>${btn("PWM %", { act: "pwm", data: { node, pin: p.id, hz: p.pwm?.hz ?? 490 } })}` : "",
      op && has("aout") ? `<label class="field sm duty" title="DAC output, volts"><input class="field-input" type="number" min="0" max="${p.aout?.range_v[1] ?? d.node.vio}" step="0.01" value="${+(d.node.vio / 2).toFixed(2)}" data-aout="${esc(key)}"></label>${btn("DAC V", { act: "aout", data: { node, pin: p.id } })}<label class="field sm duty" title="sine frequency, Hz${p.aout?.sine_hz ? `, ${p.aout.sine_hz[0]} to ${p.aout.sine_hz[1]}` : ""}"><input class="field-input" type="number" min="${p.aout?.sine_hz?.[0] ?? 1}" max="${p.aout?.sine_hz?.[1] ?? 100000}" step="1" value="1000" data-sine="${esc(key)}"></label>${btn("Sine Hz", { act: "sine", data: { node, pin: p.id } })}` : "",
      op ? btn("Record", { act: "record", data: { node, pin: p.id, as: has("ain") ? "a" : "d" }, variant: "light", color: "primary" }) : "",
    ].join("");
    return `<tr class="mid"><td><strong>${esc(p.id)}</strong>${p.label ? ` <span class="muted">${esc(p.label)}</span>` : ""}${d.node.beacon === p.id ? ` ${chip("beacon", "primary")}` : ""}</td>
      <td class="tiny soft">${esc(p.caps.join(" · "))}</td>
      <td>${op ? `<label class="field sm">${select("mode", modes(p.caps), "", `data-change="setmode" data-node="${esc(node)}" data-pin="${esc(p.id)}"`)}</label>` : ""}</td>
      <td class="mono" data-val="${esc(key)}">${valueText(S.values[key])}</td>
      <td><div class="row wrap">${acts}</div></td></tr>`;
  }).join("");
}

function channelCard(c) {
  const op = can("operator");
  const conv = c.scale !== 1 || c.offset !== 0 ? ` · ×${c.scale} ${c.offset >= 0 ? "+" : "−"} ${Math.abs(c.offset)}` : "";
  return card({
    header: `<div class="grow"><h3 class="h-lg">${esc(c.label)}</h3><p class="tiny muted">${esc(devName(c.node))} · ${esc(c.pin)} · ${c.as === "a" ? "analog" : "digital"}${esc(conv)}</p></div><span class="chip" data-chanstate="${esc(c.id)}"></span>`,
    body: `<div class="reading" data-reading="${esc(c.id)}">–</div>
      <p class="tiny muted" data-ago="${esc(c.id)}"></p>
      <svg class="spark" data-spark="${esc(c.id)}" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"></svg>
      <p class="err tiny" data-chanerr="${esc(c.id)}"></p>
      ${op ? `<form class="row" data-form="poll" data-id="${esc(c.id)}"><label class="field sm grow" title="polling interval in milliseconds"><input class="field-input" name="interval_ms" type="number" min="250" max="3600000" step="50" value="${c.interval_ms}"></label><span class="tiny muted">ms</span>${btn("Update polling", { type: "submit" })}</form>` : ""}`,
    footer: btn("History", { act: "go", data: { nav: "history", channel: c.id }, cls: "grow" }) + (op ? btn("Remove", { act: "rmchan", data: { id: c.id }, color: "danger", variant: "light" }) : ""),
  });
}

const INST = { supply: "Supply", die_temp: "Chip temperature", hall: "Hall sensor" };
const SPANS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

function instCard(node, d) {
  const op = can("operator");
  return card({
    header: `<div class="grow"><h3 class="h-lg">Instruments</h3><p class="tiny muted">Sensors inside the ${esc(d.node.board)}'s own chip, read by its firmware</p></div>${toggle(Boolean(S.instLive[node]), `data-change="instlive" data-node="${esc(node)}"`, "Live")}${btn("Read", { act: "readinst", data: { node } })}`,
    body: `<div class="grid g4">${d.instruments.map((i) => card({ body: `<div class="stack tight">
        <p class="stat-title">${esc(INST[i.type] ?? words(i.type))} <span class="muted">${esc(i.id)}${i.err ? ` · ±${esc(i.err)} ${esc(unitText(i.unit))}` : i.err_pct ? ` · ±${esc(i.err_pct)} %` : ""}</span></p>
        <p class="stat-value mono" data-val="${esc(`${node}:${i.id}`)}">${valueText(S.values[`${node}:${i.id}`])}</p>
        ${i.note ? `<p class="tiny muted">${esc(i.note)}</p>` : ""}
        ${op ? `<div>${btn("Record", { act: "record", data: { node, pin: i.id, as: "a", unit: unitText(i.unit) }, variant: "light", color: "primary" })}</div>` : ""}
      </div>` })).join("")}</div>`,
  });
}

async function readInst(node) {
  const d = await describe(node);
  for (const i of d.instruments ?? []) await readPin(node, i.id, "a");
}

async function instLoop(node) {
  const tok = S.instLive[node];
  const on = () => S.instLive[node] === tok && S.nav === "device" && S.q.node === node && online(node);
  while (on()) {
    await readInst(node);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (S.instLive[node] === tok) delete S.instLive[node];
}

function scopeCard(node, d) {
  const pins = d.pins.filter((p) => p.caps.includes("ain") && !d.reserved.includes(p.id));
  if (!can("operator")) return card({ header: `<h3 class="h-lg">Scope</h3>`, body: '<p class="small muted">An operator runs the scope: a capture can drive a pin, so the hub counts it as a write.</p>' });
  const sc = S.scope[node] ?? {};
  const vio = d.node.vio;
  return card({
    header: `<div class="grow"><h3 class="h-lg">Scope</h3><p class="tiny muted">Real ADC samples from one pin, and the hub's measurements of the trace</p></div>`,
    body: `<div class="stack">
      <form class="row wrap" data-form="scope" data-node="${esc(node)}">
        <label class="field sm" title="pin">${select("pin", pins.map((p) => [p.id, `${p.id}${p.label ? ` ${p.label}` : ""}${p.ain?.wifi_off ? " (Wi-Fi off only)" : ""}`]), sc.pin ?? pins[0].id)}</label>
        <label class="field sm" title="time span">${select("span", SPANS.map((ms) => [ms, ms >= 1000 ? `${ms / 1000} s` : `${ms} ms`]), sc.span ?? 20)}</label>
        <label class="field sm" title="trigger">${select("edge", [["rise", "trigger on rise"], ["fall", "trigger on fall"], ["", "free-running"]], sc.edge ?? (d.node.driver ? "" : "rise"))}</label>
        <label class="field sm duty" title="trigger level, volts"><input class="field-input" name="level" type="number" step="0.05" min="0" max="${vio}" value="${sc.level ?? +(vio / 2).toFixed(2)}"></label><span class="tiny muted">V</span>
        ${btn("Single", { act: "scopeone", data: { node } })}
        ${btn("Run", { act: "scoperun", data: { node }, color: "primary" })}
        ${btn("Stop", { act: "scopestop", data: { node } })}
      </form>
      <div data-scope="${esc(node)}">${scopeView(node)}</div>
    </div>`,
  });
}

function scopeView(node) {
  const sc = S.scope[node] ?? {};
  const c = sc.cap;
  const state = sc.run ? `<p>${chip("running", "success")}</p>` : "";
  const err = sc.err ? `<p class="err">${esc(sc.err)}</p>` : "";
  if (!c) return `${state}${err}${err ? "" : '<p class="small muted">Press Single for one trace or Run for a live one. The scope samples as fast as the span allows; with a trigger it waits up to the span (at least 200 ms) for the crossing, then runs free.</p>'}`;
  const vals = c.vals ?? [];
  const vio = S.describe[node]?.node.vio ?? 5;
  const W = 800, H = 280, L = 48, R = 12, T = 12, B = 28;
  const n = vals.length, dt = c.dt_us / 1000, span = (n - 1) * dt;
  const tr = sc.args.trigger;
  const zero = c.triggered ? c.trigger_index : 0;
  const hi = Math.max(vio, ...vals);
  const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / hi) * (H - T - B);
  const fmtT = (ms) => (span < 2 ? `${Math.round(ms * 1000)} µs` : `${+ms.toFixed(span < 20 ? 2 : span < 200 ? 1 : 0)} ms`);
  let grid = "";
  for (let v = 0; v <= hi + 1e-9; v += hi > 4 ? 1 : 0.5) grid += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(1)} V</text>`;
  for (let k = 0; k <= 10; k++) {
    const i = ((n - 1) * k) / 10;
    grid += `<line class="grid-line" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}"/>`;
    if (k % 2 === 0) grid += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === 10 ? "end" : "middle"}">${esc(fmtT((i - zero) * dt))}</text>`;
  }
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const marks = tr ? `<line class="th" x1="${L}" x2="${W - R}" y1="${y(tr.level_v)}" y2="${y(tr.level_v)}"/>${c.triggered ? `<line class="th" x1="${x(zero)}" x2="${x(zero)}" y1="${T}" y2="${H - B}"/>` : ""}` : "";
  const m = [
    ["Frequency", c.freq_hz !== undefined ? qty(c.freq_hz, "Hz") : "–"],
    ["Vpp", `${fmtNum(c.vpp)} V`],
    ["Mean", `${fmtNum(c.mean)} V`],
    ["RMS", `${fmtNum(c.rms)} V`],
    ["Duty", c.duty !== undefined ? `${fmtNum(c.duty * 100)} %` : "–"],
    ["Rise 10-90 %", c.rise_us !== undefined ? fmtUs(c.rise_us) : "–"],
    ["Fall 90-10 %", c.fall_us !== undefined ? fmtUs(c.fall_us) : "–"],
    ["Min / max", `${fmtNum(c.min)} / ${fmtNum(c.max)} V`],
  ];
  const trig = !tr ? "free-running" : c.triggered ? `triggered on ${tr.edge} through ${fmtNum(tr.level_v)} V; time 0 is the trigger` : `no ${tr.edge} through ${fmtNum(tr.level_v)} V within ${tr.timeout_ms} ms, so the trace runs free`;
  return `${state}${err}<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(c.pin ?? sc.args.pin)} trace">${grid}<polyline class="line" points="${line}"/>${marks}</svg>
    <p class="tiny muted">${esc(sc.args.pin)}: ${n} samples at ${esc(fmtNum(c.actual_sps ?? 1e6 / c.dt_us))} S/s${c.bits ? `, ${c.bits}-bit` : ""}, ${esc(fmtUs(c.dt_us))} apart, the finest time it resolves; each sample ±${esc(fmtNum(c.err))} V · ${esc(trig)} · ${esc(fmtTime(sc.at))}</p>
    <div class="grid g4">${m.map(([k, v]) => stat(k, v)).join("")}</div>`;
}

function drawScope(node) {
  const el = $(`[data-scope="${CSS.escape(node)}"]`);
  if (el) el.innerHTML = scopeView(node);
}

async function scopeShot(node) {
  const f = $(`[data-form="scope"][data-node="${CSS.escape(node)}"]`);
  const sc = S.scope[node] ?? (S.scope[node] = {});
  const d = S.describe[node];
  if (!f || !d?.pins) { sc.run = null; return; }
  const el = f.elements;
  const p = d.pins.find((x) => x.id === el.pin.value);
  const dur = Number(el.span.value);
  const args = { node, pin: p.id, sps: Math.min(p.ain?.max_sps ?? 1000, Math.floor((((d.node.max_samples ?? 500) - 2) * 1000) / dur)), dur_ms: dur, trace: true, file: false };
  if (el.edge.value) args.trigger = { level_v: Number(el.level.value), edge: el.edge.value, timeout_ms: Math.min(1000, Math.max(200, dur)) };
  Object.assign(sc, { pin: p.id, span: dur, edge: el.edge.value, level: el.level.value });
  try {
    sc.cap = await call("capture", args);
    sc.args = args;
    sc.at = Date.now();
    sc.err = "";
  } catch (e) {
    sc.err = e.message;
    sc.run = null;
  }
  drawScope(node);
}

async function scopeLoop(node) {
  const sc = S.scope[node];
  const tok = sc.run;
  while (sc.run === tok && S.nav === "device" && S.q.node === node && online(node)) await scopeShot(node);
  if (sc.run === tok) sc.run = null;
  drawScope(node);
}

VIEWS.device = {
  title: () => devName(S.q.node ?? ""),
  html: () => `<div class="stack">
    <div>${btn("← Device Fleet", { act: "go", data: { nav: "devices" }, variant: "light" })}</div>
    <div data-part="head"></div>
    <div data-part="pins"></div>
    <div data-part="inst"></div>
    <div data-part="scope"></div>
    <div data-part="survey"></div>
    <div data-part="chans"></div>
    ${card({ header: `<h3 class="h-lg">Recent activity</h3>`, body: `<div data-part="activity"></div>` })}
  </div>`,
  mount: () => loadDescribe(S.q.node),
  parts: {
    head: () => {
      const node = S.q.node;
      const d = device(node);
      const n = liveNode(node);
      if (!d && !n) return empty(`No device called ${esc(node)} has reached this hub.`, btn("Device Fleet", { act: "go", data: { nav: "devices" } }));
      const on = Boolean(n);
      const op = can("operator");
      const data = { node };
      return card({ body: `<div class="stack tight">
            <div class="row wrap"><h2 class="h-2xl">${esc(d?.name ?? node)}</h2>${chip(on ? "online" : "offline", on ? "success" : "danger")}${chip(n ? TRANSPORT[n.transport] ?? n.transport : d.board)}<span class="beacon" data-beacon="${esc(node)}" hidden><span class="led"></span><span class="label"></span></span></div>
            <p class="small soft">${esc(d?.description || "No description yet.")}</p>
            <p class="tiny muted">${esc(node)} · ${esc(n?.board ?? d?.board)} · ${esc(n?.arch ?? d?.arch ?? "")}${n ? ` · IO ${esc(n.vio)} V` : ""} · ${esc(where(n?.port ?? d?.where))} · ${on ? "on the hub now" : `last seen ${esc(ago(d?.last_seen))}`}${d ? ` · first seen ${esc(fmtWhen(d.first_seen))}` : ""}</p>
            ${hostedLine(n) ? `<p class="tiny muted">${esc(hostedLine(n))}</p>` : ""}
          <div class="row wrap">
            ${on && op ? btn("Identify", { act: "identify", data, color: "primary", title: "blink the onboard LED" }) : ""}
            ${on ? btn("Read inputs", { act: "readall", data }) : ""}
            ${on ? btn("Survey", { act: "survey", data }) : ""}
            ${on && op ? btn("Release my pins", { act: "release", data }) : ""}
            ${op && d ? btn("Edit", { act: "editdev", data }) : ""}
            ${on && op ? btn("Disconnect", { act: "disconnect", data, variant: "light" }) : ""}
            ${can("admin") && d ? btn("Forget", { act: "forget", data, color: "danger", variant: "light" }) : ""}
          </div>
        </div>
        <pre class="wire" data-wire="${esc(node)}"></pre>` });
    },
    pins: () => {
      const node = S.q.node;
      if (!online(node)) return device(node) ? empty("This device is offline. Its pins come back here when it dials in again.") : "";
      const d = S.describe[node];
      if (!d) return card({ body: spinner("Asking the board for its pins") });
      if (d.error) return card({ body: `<p class="err">${esc(d.error)}</p>` });
      return card({
        header: `<div class="grow"><h3 class="h-lg">Pins</h3><p class="tiny muted">${esc(d.node.board)} firmware ${esc(d.node.fw ?? "")} · reserved ${esc(d.reserved.join(", ") || "none")} · ${esc(d.buses.map((b) => `${b.id} (${Object.entries(b.pins).map(([k, v]) => `${k} ${v}`).join(", ")})`).join(" "))}</p></div>`,
        body: `<div class="table-wrap"><table><thead><tr><th>Pin</th><th>Can</th><th>Mode</th><th>Value</th><th>Do</th></tr></thead><tbody>${pinRows(node, d)}</tbody></table></div>
          <p class="tiny muted">Driving a pin leases it to you for a minute; ${d.node.failsafe === "hub" ? "the hub sends every output to hi-Z if the link to it drops, but if the hub itself stops, outputs hold until the board resets" : "the board's failsafe sends every output to hi-Z if the hub link drops"}. Check what a pin is wired to before driving it.</p>
          ${d.node.notes?.length ? `<details><summary class="tiny">What the hub does for this board</summary><ul class="tiny soft">${d.node.notes.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}`,
      });
    },
    inst: () => {
      const d = online(S.q.node) && S.describe[S.q.node];
      return d?.instruments?.length ? instCard(S.q.node, d) : "";
    },
    scope: () => {
      const d = online(S.q.node) && S.describe[S.q.node];
      return d?.pins && d.pins.some((p) => p.caps.includes("ain") && !d.reserved.includes(p.id)) ? scopeCard(S.q.node, d) : "";
    },
    survey: () => {
      const node = S.q.node;
      if (S.busy[node]) return card({ body: spinner(S.busy[node]) });
      const v = S.views[node];
      return v?.mode === "survey" ? card({ header: `<h3 class="h-lg">Survey</h3>`, body: surveyView(node, v.survey) }) : "";
    },
    chans: () => {
      const list = channels().filter((c) => c.node === S.q.node);
      if (!list.length) return "";
      return `<div class="stack tight"><h3 class="h-lg">Recorded channels</h3><div class="grid cards">${list.map(channelCard).join("")}</div></div>`;
    },
    activity: () => logList(S.st.audit.filter((e) => e.node === S.q.node).slice(-15).reverse(), "Nothing has happened on this device yet."),
  },
  deps: { head: ["nodes", "config"], pins: ["nodes", "describe"], inst: ["nodes", "describe"], scope: ["nodes", "describe"], survey: ["views"], chans: ["config"], activity: ["audit", "config"] },
};

async function loadDescribe(node) {
  if (!node || !online(node) || S.describe[node]) return;
  try { await describe(node); }
  catch (e) { S.describe[node] = { error: e.message }; }
  refresh("describe");
}

VIEWS.provisioning = {
  title: "Add a Board",
  html: () => {
    const b = bringIn();
    const admin = can("admin");
    return `<div class="stack">
      <div><h2 class="h-2xl">Add a board</h2><p class="small muted">Plug a board in and it shows up here. Boards on this server's USB are added with one press; a board on your own computer is set up from this page in Chrome or Edge; a board anywhere else dials in through a bridge.</p></div>
      ${card({ header: `<h3 class="h-lg grow">Plugged into this server</h3>${btn("Check now", { act: "pollports", variant: "light" })}`, body: `<div data-part="usb"></div>` })}
      ${card({ header: `<h3 class="h-lg grow">Saved copies of boards</h3>${btn("Check now", { act: "loadbackups", variant: "light" })}`, body: `<div data-part="backups"></div>` })}
      ${card({ header: `<h3 class="h-lg">Plugged into this computer</h3>`, body: `<div class="stack" data-part="web"></div>` })}
      ${card({ header: `<h3 class="h-lg">Plugged into another computer</h3>`, body: `
        <p class="small soft">On a Linux machine with Docker, run this once. It watches that machine's USB, brings every board on it that runs Synapse firmware, Firmata or MicroPython to this hub, and redials if the link drops. A board running anything else is set up first from the card above.</p>
        ${admin ? `<div class="row start"><pre class="code grow">${esc(b.bridge)}</pre>${btn("Copy", { act: "copy", data: { text: b.bridge } })}</div>` : `<p class="small muted">An admin sees the command, because it holds the node key.</p>`}
        <p class="tiny muted">Docker on a Mac or Windows cannot reach USB: use the card above in Chrome or Edge there.</p>` })}
      ${card({ header: `<h3 class="h-lg">Node door and key</h3>`, body: `
        <p class="small soft">Every board reaches the hub here and presents the node key as its first line. Whoever can reach the address and holds the key can join, so keep the key private. Its LED shows the state: ${BEACON_LEGEND}</p>
        <div class="row start"><pre class="code grow">${esc(b.url)}</pre>${btn("Copy", { act: "copy", data: { text: b.url } })}</div>
        ${admin ? `<div class="row start"><pre class="code grow">${esc(b.key)}</pre>${btn("Copy", { act: "copy", data: { text: b.key } })}</div>` : `<p class="small muted">Only an admin sees the node key.</p>`}
        <p class="small soft">A board behind a listening bridge on a network the hub reaches is added by address.</p>
        <div class="row">${btn("Connect by address", { act: "connect", disabled: !can("operator") })}</div>` })}
    </div>`;
  },
  mount: () => {
    loadManifest();
    loadBackups();
    pollPorts();
    clearInterval(S.usbTimer);
    S.usbTimer = setInterval(() => { if (S.nav === "provisioning") pollPorts(); else clearInterval(S.usbTimer); }, 2000);
  },
  parts: {
    usb: () => {
      if (!S.snap.hub_ok) return '<p class="small muted">The hub is not answering, so it cannot look at its USB.</p>';
      if (S.usb.err) return `<p class="err">${esc(S.usb.err)}</p>`;
      if (!S.usb.ports) return spinner("Looking at this server's USB");
      const hidden = S.usb.hidden.length ? `<div class="stack tight"><p class="small warn-text">This server has ${esc(S.usb.hidden.join(", "))}, but the hub has no access to USB. Add these lines to the hub service in compose.yaml, set SYNAPSE_SERIAL_GID in .env to the group that owns the port (<code class="inline">stat -c %g ${esc(S.usb.hidden[0])}</code>), and run <code class="inline">docker compose up -d</code>:</p>
        <div class="row start"><pre class="code grow">${esc(USB_COMPOSE)}</pre>${btn("Copy", { act: "copy", data: { text: USB_COMPOSE } })}</div></div>` : "";
      if (!S.usb.ports.length) return `${hidden}${hidden ? "" : '<p class="small muted">Nothing is plugged into this server. Plug a board in; it shows up here within two seconds.</p>'}`;
      return `<div class="divide">${S.usb.ports.map(usbRow).join("")}</div>${hidden}`;
    },
    backups: () => {
      if (!S.backups) return spinner("Reading the hub's saved copies");
      if (S.backups.error) return `<p class="err">${esc(S.backups.error)}</p>`;
      if (!S.backups.length) return '<p class="small muted">No copies yet. The hub saves one before it installs Synapse firmware on a board, so whatever ran there can be put back.</p>';
      const op = can("operator");
      return `<div class="divide">${S.backups.map((b) => `<div class="py3 row wrap between gap-3"><div class="grow"><p class="h-md">${esc(b.ran)}</p><p class="tiny muted">${esc(b.chip)} · from ${esc(b.device)} · ${esc(fmtWhen(b.taken))} · ${esc(Math.round(b.bytes / 1024))} KB · ${esc(b.file)}</p></div>${op ? btn("Put back", { act: "restorepick", data: { file: b.file } }) : ""}</div>`).join("")}</div>`;
    },
    web: webView,
  },
  deps: { usb: ["usb", "nodes"], backups: ["backups"], web: ["web", "nodes"] },
};

const PRESETS = {
  volts: { label: "Voltage (V)", as: "a", unit: "V", scale: 1, offset: 0 },
  tmp36: { label: "TMP36 temperature (°C)", as: "a", unit: "°C", scale: 100, offset: -50 },
  lm35: { label: "LM35 temperature (°C)", as: "a", unit: "°C", scale: 100, offset: 0 },
  pct: { label: "Percent of supply (%)", as: "a", unit: "%", scale: "vio", offset: 0 },
  logic: { label: "Logic level (0/1)", as: "d", unit: "", scale: 1, offset: 0 },
  custom: { label: "Custom" },
};

VIEWS.realtime = {
  title: "Live Telemetry",
  html: () => {
    const onlineDevs = devices().filter((d) => online(d.node));
    return `<div class="stack">
      <div class="row wrap between gap-3"><div><h2 class="h-2xl">Real-Time Monitor</h2><p class="small muted">The dashboard reads each channel from its board at the interval you set, keeps every reading for ${S.st.settings.retention_days} days, and runs the rules that watch it.</p></div><span data-part="pill"></span></div>
      ${can("operator") ? card({
        header: `<h3 class="h-lg">Record a pin</h3>`,
        body: onlineDevs.length ? `<form data-form="addchan" id="chan-form" class="form-grid">
          ${field("Device", select("node", onlineDevs.map((d) => [d.node, d.name]), S.q.node ?? onlineDevs[0].node, 'data-change="chandev"'))}
          ${field("Pin", select("pin", [["", "loading pins…"]], ""))}
          ${field("Sensor", select("preset", Object.entries(PRESETS).map(([k, p]) => [k, p.label]), "volts", 'data-change="preset"'))}
          ${field("Read as", select("as", [["a", "analog (volts)"], ["d", "digital (0/1)"]], "a"))}
          ${field("Label", input("label", { placeholder: "Potentiometer" }))}
          ${field("Unit", input("unit", { value: "V" }))}
          ${field("Scale (×)", input("scale", { type: "number", value: "1", extra: 'step="any"' }))}
          ${field("Offset (+)", input("offset", { type: "number", value: "0", extra: 'step="any"' }))}
          ${field("Poll every (ms)", input("interval_ms", { type: "number", value: "2000", extra: 'min="250" max="3600000" step="50"' }))}
          <div class="full row end">${btn("Add Channel", { type: "submit", color: "primary", variant: "solid" })}</div>
        </form>` : '<p class="small muted">No device is online. A channel needs a board on the hub to pick its pin.</p>',
      }) : ""}
      <div data-part="chans"></div>
    </div>`;
  },
  mount: () => fillPins($("#chan-form")),
  parts: {
    pill: hubPill,
    chans: () => channels().length
      ? `<div class="grid cards">${channels().map(channelCard).join("")}</div>`
      : empty("No channel yet. Record a pin above, or press Record on any pin of a device."),
  },
  deps: { pill: ["nodes", "sse"], chans: ["config"] },
};

async function fillPins(form, pick) {
  if (!form) return;
  const node = form.elements.node.value;
  const sel = form.elements.pin;
  try {
    const d = await describe(node);
    const pins = d.pins.filter((p) => !d.reserved.includes(p.id) && (p.caps.includes("ain") || p.caps.includes("din")));
    sel.innerHTML = pins.map((p) => `<option value="${esc(p.id)}" data-ain="${p.caps.includes("ain")}">${esc(p.id)}${p.label ? ` (${esc(p.label)})` : ""}${p.caps.includes("ain") ? " · analog" : ""}</option>`).join("");
    const first = pins.find((p) => p.id === pick) ?? pins.find((p) => p.caps.includes("ain")) ?? pins[0];
    if (first) sel.value = first.id;
    form.dataset.vio = d.node.vio;
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

VIEWS.history = {
  title: "Historical Data",
  html: () => {
    const id = channel(S.q.channel) ? S.q.channel : channels()[0]?.id ?? "";
    S.q.channel = id;
    return `<div class="stack">
      <div><h2 class="h-2xl">Historical Data</h2><p class="small muted">Every reading the dashboard recorded, kept for ${S.st.settings.retention_days} days. Download any range as CSV.</p></div>
      ${channels().length ? card({
        body: `<div class="row wrap gap-3">
          <label class="field sm grow">${select("channel", channelOptions(), id, 'data-change="histchan"')}</label>
          <div class="seg">${Object.keys({ "15m": 1, "1h": 1, "6h": 1, "24h": 1, "7d": 1, "30d": 1 }).map((r) => btn(r, { act: "histrange", data: { range: r }, variant: "light", cls: S.histRange === r ? "on" : "" })).join("")}</div>
          <a class="btn sm flat primary" data-part="csv" href="/api/history.csv?channel=${encodeURIComponent(id)}&range=${S.histRange}">Download CSV</a>
        </div>
        <div data-part="chart">${spinner("Loading")}</div>`,
      }) : empty("No channel has recorded anything yet.", btn("Record a pin", { act: "go", data: { nav: "realtime" }, color: "primary" }))}
    </div>`;
  },
  mount: () => loadHistory(),
  parts: {
    chart: () => histChart(),
  },
  deps: { chart: ["hist"] },
};

async function loadHistory() {
  const id = S.q.channel;
  if (!id) return;
  try {
    S.hist = await api("GET", `/api/history?channel=${encodeURIComponent(id)}&range=${S.histRange}`);
  } catch (e) {
    S.hist = { error: e.message };
  }
  const csv = $('[data-part="csv"]');
  if (csv) csv.href = `/api/history.csv?channel=${encodeURIComponent(id)}&range=${S.histRange}`;
  refresh("hist");
}

function histChart() {
  const h = S.hist;
  if (!h) return spinner("Loading");
  if (h.error) return `<p class="err">${esc(h.error)}</p>`;
  const c = h.channel;
  const unit = unitOf(c);
  const pts = h.points;
  const stats = h.stats.n
    ? `<div class="grid g4">${stat("Readings", h.stats.n)}${stat("Min", `${fmtNum(h.stats.min)} ${unit}`)}${stat("Max", `${fmtNum(h.stats.max)} ${unit}`)}${stat("Mean", `${fmtNum(h.stats.mean)} ${unit}`)}</div>`
    : "";
  if (pts.length < 2) return `<p class="small muted">Not enough readings of ${esc(c.label)} in this range yet.</p>${stats}`;
  const W = 800, H = 280, L = 56, R = 12, T = 12, B = 28;
  const rules = (S.st.rules ?? []).filter((r) => r.channel === c.id);
  let lo = Math.min(...pts.map((p) => p.min), ...rules.map((r) => r.threshold));
  let hi = Math.max(...pts.map((p) => p.max), ...rules.map((r) => r.threshold));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const grid = [0, 1, 2, 3, 4].map((i) => {
    const v = lo + ((hi - lo) * i) / 4;
    return `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmtNum(v))}</text>`;
  }).join("");
  const times = [0, 1, 2, 3].map((i) => {
    const t = t0 + ((t1 - t0) * i) / 3;
    const span = t1 - t0 > 86400000;
    return `<text class="axis" x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === 3 ? "end" : "middle"}">${esc(span ? new Date(t).toLocaleDateString() : fmtTime(t))}</text>`;
  }).join("");
  const band = `M${pts.map((p) => `${x(p.t).toFixed(1)},${y(p.max).toFixed(1)}`).join(" L")} L${pts.slice().reverse().map((p) => `${x(p.t).toFixed(1)},${y(p.min).toFixed(1)}`).join(" L")} Z`;
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const ths = rules.map((r) => `<line class="th" x1="${L}" x2="${W - R}" y1="${y(r.threshold)}" y2="${y(r.threshold)}"/><text class="axis" x="${W - R}" y="${y(r.threshold) - 4}" text-anchor="end">${esc(r.name)} ${esc(r.op)} ${esc(r.threshold)}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(c.label)} over time">${grid}<path class="band" d="${band}"/><polyline class="line" points="${line}"/>${ths}${times}</svg>
    <p class="tiny muted">${esc(c.label)} (${esc(devName(c.node))} ${esc(c.pin)}) in ${esc(unit || "logic")}; the shaded band is the min to max of each point, dashed lines are rule thresholds.</p>${stats}`;
}

VIEWS.alerts = {
  title: "Alerts & Notifications",
  html: () => `<div class="stack">
    <div class="row wrap between gap-3"><div><h2 class="h-2xl">Alerts & Notifications</h2><p class="small muted">Boards dropping off the hub, failsafes, brownouts, rules that could not act, the hub going quiet. Webhooks on the Account page send them on.</p></div>
      <div class="row"><div class="seg">${btn("Alerts", { act: "alertsall", data: { all: 0 }, variant: "light", cls: S.alertsAll ? "" : "on" })}${btn("Everything", { act: "alertsall", data: { all: 1 }, variant: "light", cls: S.alertsAll ? "on" : "" })}</div></div></div>
    ${card({ body: `<div data-part="list"></div>` })}
  </div>`,
  mount: () => markSeen(),
  parts: {
    list: () => {
      const list = S.st.audit.filter((e) => S.alertsAll || e.alert).slice().reverse();
      if (!list.length) return `<p class="small muted">${S.alertsAll ? "Nothing has happened yet." : "No alerts. Everything that reached the hub stayed on it."}</p>`;
      return `<ul class="divide log">${list.map((e) => `<li class="${e.alert ? "alert" : ""}"><div class="row wrap between"><span><span class="t">${esc(fmtWhen(e.time))}</span>${chip(e.kind, e.alert ? "warning" : "default")}${e.node ? ` <a class="tiny muted" href="/?nav=device&node=${encodeURIComponent(e.node)}" data-act="go" data-nav="device" data-node="${esc(e.node)}">${esc(devName(e.node))}</a>` : ""}</span></div><p class="small mt1">${esc(e.message)}</p></li>`).join("")}</ul>`;
    },
  },
  deps: { list: ["audit", "config", "alerts"] },
};

async function markSeen() {
  if (!S.st?.unseen) return;
  try {
    await api("POST", "/api/alerts/seen", {});
    S.st.unseen = 0;
    renderBadge();
  } catch {}
}

const TEMPLATES = {
  "threshold-light": { name: "Light above a level", op: ">", threshold: 2.5, then: "high", else: "low", duty: 50, text: "Turn an output on while an analog reading is above a level and off below it. A potentiometer or light sensor on A0 and the onboard LED on D13 is enough to see it work on an Uno." },
  "overheat-cutoff": { name: "Over-temperature cutoff", op: ">", threshold: 30, then: "low", else: "high", duty: 50, text: "Hold a heater or relay output low while a temperature channel (the TMP36 or LM35 sensor preset) reads above 30 °C, and high again once it cools." },
  "low-supply": { name: "Low-supply warning", op: "<", threshold: 3.4, then: "high", else: "low", duty: 50, text: "Light a warning LED while a battery or supply channel, read through a divider, drops below 3.4 V." },
  "dim-in-dark": { name: "Dim light in the dark", op: "<", threshold: 1, then: "pwm", else: "low", duty: 30, text: "Run a lamp at 30% PWM while a light-sensor channel reads below 1 V, and switch it off in daylight." },
};

function ruleForm() {
  const devs = devices();
  const first = devs.find((d) => online(d.node)) ?? devs[0];
  return `<form data-form="rule" id="rule-form" class="form-grid">
    ${field("Name", input("name", { placeholder: "Light above a level" }))}
    ${field("Template", select("template", [["", "Custom"], ...Object.entries(TEMPLATES).map(([k, t]) => [k, t.name])], "", 'data-change="template"'))}
    ${field("Watch channel", select("channel", channelOptions(channels().length ? "" : "no channel yet: record a pin first"), channels()[0]?.id ?? ""))}
    ${field("Condition", select("op", [[">", "is above (>)"], [">=", "is at or above (≥)"], ["<", "is below (<)"], ["<=", "is at or below (≤)"], ["==", "equals (=)"], ["!=", "differs from (≠)"]], ">"))}
    ${field("Threshold", input("threshold", { type: "number", value: "2.5", extra: 'step="any"' }))}
    ${field("Drive device", select("then_node", devs.map((d) => [d.node, d.name]), first?.node ?? "", 'data-change="rulenode"'))}
    ${field("Drive pin", select("then_pin", [["", "loading pins…"]], ""))}
    ${field("Then set it", select("then_mode", [["high", "high"], ["low", "low"], ["pwm", "PWM"]], "high"))}
    ${field("Then PWM duty (%)", input("then_duty", { type: "number", value: "50", extra: 'min="0" max="100" step="1"' }))}
    ${field("Otherwise set it", select("else_mode", [["", "leave it"], ["high", "high"], ["low", "low"], ["pwm", "PWM"]], "low"))}
    ${field("Otherwise PWM duty (%)", input("else_duty", { type: "number", value: "0", extra: 'min="0" max="100" step="1"' }))}
    <div class="row end self-center">${btn("Simulate", { act: "simulate" })}${btn("Add Rule", { type: "submit", color: "primary", variant: "solid" })}</div>
    <p class="full small" data-sim></p>
  </form>`;
}

async function fillOutPins(form) {
  if (!form) return;
  const node = form.elements.then_node.value;
  const sel = form.elements.then_pin;
  if (!node) return;
  if (!online(node)) { sel.innerHTML = '<option value="">device offline</option>'; return; }
  try {
    const d = await describe(node);
    const pins = d.pins.filter((p) => !d.reserved.includes(p.id) && p.caps.includes("dout"));
    sel.innerHTML = pins.map((p) => `<option value="${esc(p.id)}">${esc(p.id)}${p.label ? ` (${esc(p.label)})` : ""}${p.caps.includes("pwm") ? " · pwm" : ""}</option>`).join("");
    sel.value = pins.find((p) => p.id === d.node.beacon)?.id ?? pins[0]?.id ?? "";
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
  }
}

function ruleBody(form) {
  const f = form.elements;
  const out = (mode, duty) => ({ node: f.then_node.value, pin: f.then_pin.value, mode, duty: mode === "pwm" ? Number(duty) / 100 : 0 });
  return {
    name: f.name.value.trim(),
    template: f.template.value,
    channel: f.channel.value,
    op: f.op.value,
    threshold: Number(f.threshold.value),
    then: out(f.then_mode.value, f.then_duty.value),
    else: f.else_mode.value ? out(f.else_mode.value, f.else_duty.value) : null,
  };
}

const outText = (o) => (o ? `${devName(o.node)} ${o.pin} ${o.mode === "pwm" ? `PWM ${Math.round(o.duty * 100)}%` : o.mode}` : "leave it");

VIEWS.automations = {
  title: () => (S.q.focus === "templates" ? "Workflow Templates" : "Rule Engine"),
  html: () => `<div class="stack">
    <div><h2 class="h-2xl">Automations</h2><p class="small muted">A rule runs in the dashboard on every reading of its channel. When the condition becomes true it drives its pin; when it becomes false it applies the otherwise action. It re-asserts every 30 s, so a board that reset or redialled comes back to the right state. Rules drive pins as user:rules; a person's lease on the same pin blocks the rule until the lease lapses.</p></div>
    ${can("operator") ? card({ header: `<h3 class="h-lg">New automation</h3>`, body: ruleForm() }) : ""}
    ${card({ id: "templates", header: `<h3 class="h-lg">Workflow templates</h3>`, body: `<div class="grid g2">${Object.entries(TEMPLATES).map(([k, t]) => `<div class="stack tight"><p class="h-md">${esc(t.name)}</p><p class="small soft">${esc(t.text)}</p><p class="tiny muted">when ${esc(t.op)} ${esc(t.threshold)} set ${esc(t.then)}${t.then === "pwm" ? ` ${t.duty}%` : ""}, otherwise ${esc(t.else)}</p>${can("operator") ? `<div>${btn("Use template", { act: "usetemplate", data: { t: k }, color: "primary" })}</div>` : ""}</div>`).join("")}</div>` })}
    ${card({ header: `<h3 class="h-lg grow">Rules</h3><span class="tiny muted" data-part="count"></span>`, body: `<div data-part="rules"></div>` })}
    ${card({ header: `<h3 class="h-lg">Execution logs</h3>`, body: `<div data-part="logs"></div>` })}
  </div>`,
  mount: () => {
    fillOutPins($("#rule-form"));
    if (S.q.focus === "templates") $("#templates")?.scrollIntoView({ block: "start" });
  },
  parts: {
    count: () => `${(S.st.rules ?? []).filter((r) => r.enabled).length} of ${(S.st.rules ?? []).length} on`,
    rules: () => {
      const q = (S.q.q ?? "").toLowerCase();
      const list = (S.st.rules ?? []).filter((r) => !q || r.name.toLowerCase().includes(q));
      if (!list.length) return `<p class="small muted">${q ? "No rule matches." : "No rules yet."}</p>`;
      const op = can("operator");
      return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Watches</th><th>Condition</th><th>Action</th><th>State</th><th>Execs</th><th>Last</th><th>Enabled</th><th></th></tr></thead><tbody>
        ${list.map((r) => {
          const c = channel(r.channel);
          const state = r.state === undefined || r.state === null ? chip("waiting") : r.state ? chip("met", "success") : chip("clear");
          const failed = (r.last_result ?? "").startsWith("failed");
          return `<tr class="mid"><td><strong>${esc(r.name)}</strong><br><span class="tiny muted">v${r.version} by ${esc(r.by)}</span></td>
            <td>${c ? `${esc(c.label)}<br><span class="tiny muted">${esc(devName(c.node))} ${esc(c.pin)}</span>` : '<span class="bad-text">channel gone</span>'}</td>
            <td>${esc(r.op)} ${esc(r.threshold)} ${esc(c ? unitOf(c) : "")}</td>
            <td class="small">then ${esc(outText(r.then))}<br><span class="muted">otherwise ${esc(outText(r.else))}</span></td>
            <td>${state}</td><td>${r.executions}</td>
            <td class="small">${r.last_at ? esc(ago(r.last_at)) : "never"}${r.last_result ? `<br><span class="tiny ${failed ? "bad-text" : "muted"}">${esc(r.last_result)}</span>` : ""}</td>
            <td>${toggle(r.enabled, `data-change="ruleon" data-id="${esc(r.id)}" ${op ? "" : "disabled"}`)}</td>
            <td>${op ? btn("Delete", { act: "rmrule", data: { id: r.id }, color: "danger", variant: "light" }) : ""}</td></tr>`;
        }).join("")}</tbody></table></div>`;
    },
    logs: () => logList(S.st.audit.filter((e) => e.kind.startsWith("automation.")).slice(-100).reverse(), "No rule has run yet."),
  },
  deps: { count: ["config"], rules: ["config"], logs: ["audit", "config"] },
};

VIEWS.account = {
  title: "Account",
  html: () => {
    const me = S.st.me;
    const admin = can("admin");
    const theme = local.get("theme", "light");
    const perms = [
      ["See nodes, devices, readings, history and alerts; survey and read pins; simulate rules", true, true, true],
      ["Drive pins, run sequences, connect and disconnect boards", true, true, false],
      ["Record channels, write rules, name and describe devices", true, true, false],
      ["People, webhooks, data retention, the node key, forget devices", true, false, false],
    ];
    const mark = (b) => (b ? '<span class="ok-text">✓</span>' : '<span class="muted">–</span>');
    return `<div class="stack">
      <h2 class="h-2xl">Account</h2>
      <div class="grid g2">
        ${card({ header: `<h3 class="h-lg">Account Details</h3>`, body: `<div class="row gap-3"><span class="avatar lg">${esc(initials(me.name))}</span><div><p class="h-md">${esc(me.name)}</p><p class="small muted">${esc(me.role)} · ${me.source === "oidc" ? "single sign-on" : "local account"}</p></div></div>
          <ul class="status-list">${statusItem("Dashboard", `version ${S.st.version}`)}${statusItem("Hub", S.snap.hub_ok ? `version ${S.snap.hub_version}` : "offline", S.snap.hub_ok ? "success" : "danger")}</ul>` })}
        ${card({ header: `<h3 class="h-lg">UI & Appearance</h3>`, body: `<div class="row between wrap"><span class="small">Theme</span><div class="seg">${["light", "dark", "system"].map((t) => btn(t[0].toUpperCase() + t.slice(1), { act: "theme", data: { theme: t }, variant: "light", cls: theme === t ? "on" : "" })).join("")}</div></div>
          <div class="row between"><span class="small">Collapse the sidebar</span>${toggle(S.collapsed, 'data-change="sidebarpref"')}</div>
          <p class="tiny muted">Kept in this browser.</p>` })}
      </div>
      ${card({ header: `<h3 class="h-lg">Data & Retention</h3>`, body: `<form data-form="settings" class="row wrap gap-3">
          ${field("Keep readings and the activity log for (days)", input("retention_days", { type: "number", value: S.st.settings.retention_days, extra: `min="1" max="3650" ${admin ? "" : "disabled"}` }))}
          ${admin ? btn("Save", { type: "submit", color: "primary", variant: "solid" }) : ""}
        </form><p class="tiny muted">Readings live in the dashboard's data folder as one file a day; older days are deleted hourly. Nothing leaves this server unless a webhook sends it.</p>` })}
      ${card({ header: `<h3 class="h-lg">Roles & Permissions</h3>`, body: `<div class="table-wrap"><table><thead><tr><th>Permission</th><th>admin</th><th>operator</th><th>viewer</th></tr></thead><tbody>${perms.map(([p, ...r]) => `<tr><td class="small">${esc(p)}</td>${r.map(mark).map((m) => `<td>${m}</td>`).join("")}</tr>`).join("")}</tbody></table></div><p class="tiny muted">You are ${esc(me.role)}. Single sign-on gives admin to members of the admin group and viewer to everyone else.</p>` })}
      ${admin ? card({ header: `<h3 class="h-lg">People</h3>`, body: `<div data-part="people"></div>${S.st.local_login ? `<form data-form="adduser" class="form-grid">
          ${field("Name", input("name", { extra: 'autocomplete="off"' }))}
          ${field("Password (10+ characters)", input("password", { type: "password", extra: 'autocomplete="new-password" minlength="10"' }))}
          ${field("Role", select("role", [["viewer", "viewer"], ["operator", "operator"], ["admin", "admin"]], "viewer"))}
          <div class="full row end">${btn("Add person", { type: "submit", color: "primary", variant: "solid" })}</div></form>` : '<p class="small muted">Local sign-in is off; people come from single sign-on.</p>'}` }) : ""}
      ${admin ? card({ header: `<h3 class="h-lg">Webhooks</h3>`, body: `<p class="small soft">Each event is POSTed as JSON with an <code class="inline">x-synapse-signature: sha256=…</code> header, the HMAC-SHA256 of the body under the webhook's secret.</p><div data-part="hooks"></div>
          <form data-form="addhook" class="form-grid">
            <div class="span2">${field("URL", input("url", { type: "url", placeholder: "https://example.com/hooks/synapse" }))}</div>
            ${field("Event", select("event", [["alert", "every alert"], ["all", "everything"], ["node.joined", "node.joined"], ["node.dropped", "node.dropped"], ["device.new", "device.new"], ["automation.execution", "automation.execution"], ["automation.failed", "automation.failed"]], "alert"))}
            <div class="full row end">${btn("Add webhook", { type: "submit", color: "primary", variant: "solid" })}</div>
          </form>` }) : ""}
    </div>`;
  },
  parts: {
    people: () => {
      const users = S.st.users ?? [];
      if (!users.length) return '<p class="small muted">No local accounts.</p>';
      return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th></th></tr></thead><tbody>${users.map((u) => `<tr class="mid"><td>${esc(u.name)}${u.name === S.st.me.name ? ' <span class="tiny muted">(you)</span>' : ""}</td><td>${chip(u.role, u.role === "admin" ? "primary" : "default")}</td><td>${btn("Remove", { act: "rmuser", data: { name: u.name }, color: "danger", variant: "light" })}</td></tr>`).join("")}</tbody></table></div>`;
    },
    hooks: () => {
      const hooks = S.st.webhooks ?? [];
      if (!hooks.length) return '<p class="small muted">No webhooks yet.</p>';
      return `<div class="table-wrap"><table><thead><tr><th>URL</th><th>Event</th><th>Last delivery</th><th>Secret</th><th>Enabled</th><th></th></tr></thead><tbody>${hooks.map((h) => `<tr class="mid">
        <td class="break small">${esc(h.url)}</td><td>${chip(h.event)}</td>
        <td class="small">${h.last_at ? `${esc(ago(h.last_at))}<br><span class="tiny ${h.last_error ? "bad-text" : "ok-text"}">${h.last_error ? esc(h.last_error) : `HTTP ${h.last_code}`}</span>` : "never"}</td>
        <td>${btn("Copy", { act: "copy", data: { text: h.secret } })}</td>
        <td>${toggle(h.enabled, `data-change="hookon" data-id="${esc(h.id)}"`)}</td>
        <td><div class="row">${btn("Send test", { act: "testhook", data: { id: h.id } })}${btn("Delete", { act: "rmhook", data: { id: h.id }, color: "danger", variant: "light" })}</div></td></tr>`).join("")}</tbody></table></div>`;
    },
  },
  deps: { people: ["config"], hooks: ["config"] },
};

function setView(node, view) {
  if (view) S.views[node] = view;
  else delete S.views[node];
  refresh("views");
}

async function survey(node) {
  S.busy[node] = "Surveying the board, up to 30 s";
  refresh("views");
  try {
    setView(node, { mode: "survey", survey: await call("identify_circuit", { node }) });
  } catch (e) {
    toast(e.message, true);
  } finally {
    delete S.busy[node];
    refresh("views");
  }
}

function setValue(key, v) {
  S.values[key] = v;
  const el = $(`[data-val="${CSS.escape(key)}"]`);
  if (el) el.innerHTML = valueText(v);
}

async function readPin(node, pin, as) {
  const key = `${node}:${pin}`;
  try { setValue(key, await call("read", { node, pin, as, n: as === "a" || as === "t" ? 16 : 1 })); }
  catch (e) { setValue(key, { error: e.message }); }
}

const ACT = {
  go: (el) => {
    const { act, nav, ...params } = el.dataset;
    void act;
    go(nav, params);
  },
  section: (el) => {
    S.open[el.dataset.key] = !(S.open[el.dataset.key] ?? true);
    local.set("sidebar:open", JSON.stringify(S.open));
    renderSidebar();
  },
  collapse: () => {
    S.collapsed = !S.collapsed;
    local.set("sidebar:collapsed", S.collapsed ? "1" : "0");
    renderSidebar();
  },
  search: () => $('[data-form="search"]')?.requestSubmit(),
  bell: () => go("alerts"),
  menu: (el) => {
    const m = el.parentElement.querySelector(".menu");
    m.hidden = !m.hidden;
  },
  logout: () => $("#logout").submit(),
  reload: async (el) => busy(el, async () => { await loadState(); refresh(null); }),
  copy: (el) => (navigator.clipboard ? navigator.clipboard.writeText(el.dataset.text) : Promise.reject()).then(() => { el.textContent = "Copied"; setTimeout(() => { if (el.isConnected) el.textContent = "Copy"; }, 1500); }).catch(() => toast("This browser allows copying only over HTTPS; select the text instead", true)),
  backdrop: (el, e) => { if (e.target === el) closeModal(); },
  close: closeModal,
  survey: (el) => survey(el.dataset.node),
  pins: async (el) => {
    const node = el.dataset.node;
    S.busy[node] = "Reading the board's pins";
    refresh("views");
    try { setView(node, { mode: "pins", described: await describe(node) }); }
    catch (e) { toast(e.message, true); }
    finally { delete S.busy[node]; refresh("views"); }
  },
  closeview: (el) => setView(el.dataset.node, null),
  disconnect: async (el) => {
    const node = el.dataset.node;
    if (!confirm(`Disconnect ${devName(node)} from the hub? Its outputs fall back to hi-Z.`)) return;
    await busy(el, async () => { await call("disconnect_node", { node }); setView(node, null); toast(`${devName(node)} disconnected`); });
  },
  forget: async (el) => {
    const node = el.dataset.node;
    if (!confirm(`Forget ${devName(node)}? Its channels, their history links and the rules that use it are removed. If it is online it is disconnected; it registers again the next time it dials in.`)) return;
    await busy(el, async () => {
      const r = await api("DELETE", `/api/devices/${encodeURIComponent(node)}`);
      toast(`Forgot ${node}, ${r.channels} channels and ${r.rules} rules`);
      if (S.nav === "device") go("devices");
    });
  },
  connect: () => openConnect(),
  via: (el) => { S.via = el.dataset.via; openConnect(); },
  pollports: (el) => busy(el, () => pollPorts()),
  reprobe: (el) => probePort(el.dataset.port),
  chipport: (el) => probePort(el.dataset.port, true),
  loadbackups: () => loadBackups(),
  restorepick: (el) => openRestore(el.dataset.file),
  dorestore: () => { const f = $('[data-form="restore"]'); if (f) restorePort(f.elements.port.value, f.elements.file.value); },
  addport: (el) => addPort(el.dataset.port, el.dataset.as),
  flashport: (el) => openFlash(el.dataset.port),
  doflash: (el) => flashPort(el.dataset.port),
  webpick: () => webPick().catch((e) => toast(e.message, true)),
  webdetect: () => webDetect(),
  webflash: (el) => webFlash(el.dataset.kind),
  webkeep: () => { webSet({ phase: "ready" }); if (S.web.family === "esp") webNet(); },
  webwifi: () => webSet({ phase: "ready", msg: "" }),
  webbridge: () => webBridge().catch((e) => toast(e.message, true)),
  webreset: () => webReset().then(() => refresh("web")),
  submitconnect: () => $("#connect-form")?.requestSubmit(),
  register: () => openRegister(),
  submitregister: () => $("#register-form")?.requestSubmit(),
  page: (el) => { S.page = Number(el.dataset.page); refresh("devlist"); },
  identify: (el) => busy(el, async () => {
    const node = el.dataset.node;
    const d = await describe(node);
    const led = d.node.beacon || d.pins.find((p) => p.label === "LED")?.id;
    if (!led) throw new Error("this board names no onboard LED");
    const blinks = Math.max(1, Math.min(Math.floor((d.node.max_steps ?? 16) / 4), Math.floor((d.node.max_dur_ms ?? 1000) / 300), 3));
    const steps = [];
    for (let i = 0; i < blinks; i++) steps.push({ write: [led, 1] }, { wait_us: 150000 }, { write: [led, 0] }, { wait_us: 150000 });
    await call("run_sequence", { node, steps });
    toast(`${devName(node)} blinked ${led} ${blinks} times; its status beacon resumes when your lease ends in a minute`);
  }),
  readall: (el) => busy(el, async () => {
    const node = el.dataset.node;
    const d = await describe(node);
    for (const p of d.pins.filter((p) => !d.reserved.includes(p.id) && p.caps.includes("ain"))) await readPin(node, p.id, "a");
  }),
  release: (el) => busy(el, async () => {
    await call("release", { node: el.dataset.node });
    toast(`Released your pins on ${devName(el.dataset.node)}; they are hi-Z`);
  }),
  editdev: (el) => {
    const d = device(el.dataset.node);
    modal(`Edit ${esc(d.name)}`, `<form data-form="editdev" id="editdev-form" data-node="${esc(d.node)}" class="stack tight">${field("Name", input("name", { value: d.name }))}${field("Description", `<textarea class="field-input" name="description">${esc(d.description)}</textarea>`)}</form>`,
      btn("Cancel", { act: "close", variant: "light" }) + btn("Save", { act: "submitedit", color: "primary", variant: "solid" }));
  },
  submitedit: () => $("#editdev-form")?.requestSubmit(),
  readpin: (el) => busy(el, () => readPin(el.dataset.node, el.dataset.pin, el.dataset.as)),
  drive: (el) => busy(el, async () => {
    const { node, pin, value } = el.dataset;
    await call("write", { node, pin, value: Number(value) });
    setValue(`${node}:${pin}`, { driven: Number(value) });
  }),
  pwm: (el) => busy(el, async () => {
    const { node, pin } = el.dataset;
    const key = `${node}:${pin}`;
    const duty = Number($(`[data-duty="${CSS.escape(key)}"]`).value);
    if (!(duty >= 0 && duty <= 100)) throw new Error("duty is 0 to 100 %");
    const hzEl = $(`[data-hz="${CSS.escape(key)}"]`);
    const hz = Number(hzEl ? hzEl.value : el.dataset.hz);
    const r = await call("write", { node, pin, pwm: { hz, duty: duty / 100 } });
    const o = r.pwm ?? { hz, duty: duty / 100 };
    setValue(key, { out: `PWM ${qty(o.hz, "Hz")} at ${fmtNum(o.duty * 100)} %${o.bits ? `, ${o.bits}-bit` : ""}` });
  }),
  aout: (el) => busy(el, async () => {
    const { node, pin } = el.dataset;
    const key = `${node}:${pin}`;
    const v = Number($(`[data-aout="${CSS.escape(key)}"]`).value);
    const r = await call("write", { node, pin, aout: v });
    setValue(key, { out: r.aout ? `DAC ${fmtNum(r.aout.v)} V (code ${r.aout.code})` : `DAC ${fmtNum(v)} V` });
  }),
  sine: (el) => busy(el, async () => {
    const { node, pin } = el.dataset;
    const key = `${node}:${pin}`;
    const hz = Number($(`[data-sine="${CSS.escape(key)}"]`).value);
    const r = await call("write", { node, pin, sine: { hz } });
    const s = r.sine ?? { hz };
    setValue(key, { out: `sine ${qty(s.hz, "Hz")}${s.vpp ? `, ${fmtNum(s.vpp)} Vpp around ${fmtNum(s.offset_v)} V` : ""}` });
  }),
  readinst: (el) => busy(el, () => readInst(el.dataset.node)),
  scopeone: (el) => busy(el, () => scopeShot(el.dataset.node)),
  scoperun: (el) => {
    const node = el.dataset.node;
    const sc = S.scope[node] ?? (S.scope[node] = {});
    if (sc.run) return;
    sc.run = {};
    drawScope(node);
    scopeLoop(node);
  },
  scopestop: (el) => {
    const sc = S.scope[el.dataset.node];
    if (sc) sc.run = null;
    drawScope(el.dataset.node);
  },
  record: (el) => busy(el, async () => {
    const { node, pin, as } = el.dataset;
    const unit = el.dataset.unit ?? (as === "a" ? "V" : "");
    const c = await api("POST", "/api/channels", { node, pin, as, label: `${devName(node)} ${pin}`, unit, scale: 1, offset: 0, interval_ms: 2000 });
    toast(`Recording ${c.label} every 2 s; it is on Live Telemetry`);
  }),
  rmchan: async (el) => {
    if (!confirm("Stop recording this channel? Its history files stay until retention removes them.")) return;
    await busy(el, () => api("DELETE", `/api/channels/${encodeURIComponent(el.dataset.id)}`));
  },
  histrange: (el) => {
    S.histRange = el.dataset.range;
    $$(".seg .btn", el.parentElement).forEach((b) => b.classList.toggle("on", b === el));
    loadHistory();
  },
  alertsall: (el) => {
    S.alertsAll = el.dataset.all === "1";
    $$(".seg .btn", el.parentElement).forEach((b) => b.classList.toggle("on", b === el));
    refresh("alerts");
  },
  usetemplate: (el) => {
    const form = $("#rule-form");
    if (!form) return;
    form.elements.template.value = el.dataset.t;
    applyTemplate(form);
    form.scrollIntoView({ block: "start" });
  },
  simulate: (el) => busy(el, async () => {
    const form = $("#rule-form");
    const body = ruleBody(form);
    const out = $("[data-sim]", form);
    const r = await api("POST", "/api/simulate", body);
    out.innerHTML = `${esc(r.label)} reads <strong>${esc(fmtNum(r.value))} ${esc(r.unit || "V")}</strong> ±${esc(fmtNum(r.err))} now: the condition is <strong class="${r.met ? "ok-text" : ""}">${r.met ? "met" : "not met"}</strong>, so the rule would ${esc(r.would)}.`;
  }),
  rmrule: async (el) => {
    if (!confirm("Delete this rule? The pin keeps its last state.")) return;
    await busy(el, () => api("DELETE", `/api/rules/${encodeURIComponent(el.dataset.id)}`));
  },
  theme: (el) => {
    local.set("theme", el.dataset.theme);
    const dark = el.dataset.theme === "dark" || (el.dataset.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    $$(".seg .btn", el.parentElement).forEach((b) => b.classList.toggle("on", b === el));
  },
  rmuser: async (el) => {
    if (!confirm(`Remove ${el.dataset.name}? Their session ends at once.`)) return;
    await busy(el, () => api("DELETE", `/api/users/${encodeURIComponent(el.dataset.name)}`));
  },
  testhook: (el) => busy(el, async () => {
    const r = await api("POST", `/api/webhooks/${encodeURIComponent(el.dataset.id)}/test`, {});
    toast(r.error ? `The test failed: ${r.error}` : `Delivered, HTTP ${r.code}`, Boolean(r.error));
  }),
  rmhook: async (el) => {
    if (!confirm("Delete this webhook?")) return;
    await busy(el, () => api("DELETE", `/api/webhooks/${encodeURIComponent(el.dataset.id)}`));
  },
};

function applyTemplate(form) {
  const t = TEMPLATES[form.elements.template.value];
  if (!t) return;
  const f = form.elements;
  f.name.value = t.name;
  f.op.value = t.op;
  f.threshold.value = t.threshold;
  f.then_mode.value = t.then;
  f.then_duty.value = t.duty;
  f.else_mode.value = t.else;
}

const FORM = {
  search: (f) => go("devices", { q: f.elements.q.value.trim() }),
  webjoin: (f) => webJoin(f),
  restore: (f) => restorePort(f.elements.port.value, f.elements.file.value),
  connect: async (f, e) => {
    const el = f.elements;
    const target = S.via === "usb" ? el.port.value.trim() : `tcp:${el.host.value.trim()}:${el.netport.value.trim()}${el.hb.value.trim() ? `:${el.hb.value.trim()}` : ""}`;
    const err = $("[data-connect-err]", f);
    if (S.via === "usb" ? !target : !el.host.value.trim()) { err.textContent = "Say where the board is."; return; }
    await busy(e.submitter, async () => {
      try {
        const name = el.name.value.trim();
        await call("connect_node", name ? { port: target, name } : { port: target });
        closeModal();
        toast(`Connected ${target}`);
      } catch (x) { err.textContent = x.message; }
    });
  },
  register: (f) => busy(null, async () => {
    const node = f.elements.node.value;
    await api("PUT", `/api/devices/${encodeURIComponent(node)}`, { name: f.elements.name.value, description: f.elements.description.value });
    closeModal();
    toast(`Saved ${f.elements.name.value || node}`);
  }),
  editdev: (f) => busy(null, async () => {
    await api("PUT", `/api/devices/${encodeURIComponent(f.dataset.node)}`, { name: f.elements.name.value, description: f.elements.description.value });
    closeModal();
  }),
  addchan: (f, e) => busy(e.submitter, async () => {
    const el = f.elements;
    const c = await api("POST", "/api/channels", {
      node: el.node.value, pin: el.pin.value, as: el.as.value, label: el.label.value, unit: el.unit.value,
      scale: Number(el.scale.value), offset: Number(el.offset.value), interval_ms: Number(el.interval_ms.value),
    });
    el.label.value = "";
    toast(`Recording ${c.label} every ${c.interval_ms} ms`);
  }),
  poll: (f, e) => busy(e.submitter, async () => {
    const c = channel(f.dataset.id);
    const ms = Number(f.elements.interval_ms.value);
    await api("PUT", `/api/channels/${encodeURIComponent(c.id)}`, { ...c, interval_ms: ms });
    toast(`${c.label} now polls every ${ms} ms`);
  }),
  rule: (f, e) => busy(e.submitter, async () => {
    const body = ruleBody(f);
    const r = await api("POST", "/api/rules", body);
    toast(`Rule '${r.name}' is on; it acts on the next reading`);
    f.elements.name.value = "";
    $("[data-sim]", f).textContent = "";
  }),
  settings: (f, e) => busy(e.submitter, async () => {
    await api("PUT", "/api/settings", { retention_days: Number(f.elements.retention_days.value) });
    toast("Saved");
  }),
  adduser: (f, e) => busy(e.submitter, async () => {
    await api("POST", "/api/users", { name: f.elements.name.value, password: f.elements.password.value, role: f.elements.role.value });
    toast(`Added ${f.elements.name.value}`);
    f.reset();
  }),
  addhook: (f, e) => busy(e.submitter, async () => {
    await api("POST", "/api/webhooks", { url: f.elements.url.value, event: f.elements.event.value });
    toast("Webhook added; press Send test to check it");
    f.reset();
  }),
};

const CHANGE = {
  ovchan: (el) => { S.ovChan = el.value; local.set("overview:channel", el.value); refresh("reading"); },
  devstatus: (el) => { S.devStatus = el.value; S.page = 1; refresh("devlist"); },
  chandev: (el) => fillPins(el.form),
  preset: (el) => {
    const p = PRESETS[el.value];
    const f = el.form.elements;
    if (!p.as) return;
    f.as.value = p.as;
    f.unit.value = p.unit;
    f.scale.value = p.scale === "vio" ? +(100 / Number(el.form.dataset.vio || 5)).toFixed(4) : p.scale;
    f.offset.value = p.offset;
  },
  histchan: (el) => { S.q.channel = el.value; history.replaceState(null, "", `/?nav=history&channel=${encodeURIComponent(el.value)}`); loadHistory(); },
  template: (el) => applyTemplate(el.form),
  rulenode: (el) => fillOutPins(el.form),
  ruleon: async (el) => {
    try { await api("PUT", `/api/rules/${encodeURIComponent(el.dataset.id)}`, { enabled: el.checked }); }
    catch (e) { el.checked = !el.checked; toast(e.message, true); }
  },
  hookon: async (el) => {
    try { await api("PUT", `/api/webhooks/${encodeURIComponent(el.dataset.id)}`, { enabled: el.checked }); }
    catch (e) { el.checked = !el.checked; toast(e.message, true); }
  },
  sidebarpref: (el) => { S.collapsed = el.checked; local.set("sidebar:collapsed", el.checked ? "1" : "0"); renderSidebar(); },
  regpick: (el) => {
    const d = device(el.value);
    el.form.elements.name.value = d?.name ?? "";
    el.form.elements.description.value = d?.description ?? "";
  },
  instlive: (el) => {
    const node = el.dataset.node;
    if (el.checked) { S.instLive[node] = {}; instLoop(node); }
    else delete S.instLive[node];
  },
  setmode: async (el) => {
    const { node, pin } = el.dataset;
    if (!el.value) return;
    try { await call("set_mode", { node, pin, mode: el.value }); toast(`${pin} is now ${el.selectedOptions[0].textContent}`); }
    catch (e) { toast(e.message, true); }
    el.value = "";
  },
};

const INPUT = {
  sidesearch: (el) => {
    S.sideSearch = el.value;
    renderSidebar();
    const again = $('[data-input="sidesearch"]');
    again.focus();
    again.setSelectionRange(el.value.length, el.value.length);
  },
  devq: (el) => { S.q.q = el.value; S.page = 1; refresh("devlist"); },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!e.target.closest(".menu-wrap")) $$(".menu").forEach((m) => { m.hidden = true; });
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (el.dataset.act !== "backdrop" || e.target === el) e.preventDefault();
  if (el.closest(".menu")) el.closest(".menu").hidden = true;
  fn(el, e);
});
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  FORM[f.dataset.form]?.(f, e);
});
document.addEventListener("change", (e) => {
  const el = e.target.closest("[data-change]");
  if (el) CHANGE[el.dataset.change]?.(el, e);
});
document.addEventListener("input", (e) => {
  const el = e.target.closest("[data-input]");
  if (el) INPUT[el.dataset.input]?.(el, e);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
window.addEventListener("popstate", route);
matchMedia("(max-width: 767px)").addEventListener("change", renderSidebar);

async function loadState() {
  const st = await api("GET", "/api/state");
  S.st = st;
  if (st.hub && (st.hub.hub_ok !== undefined)) applySnap(st.hub, false);
  for (const c of st.channels) {
    const have = S.readings[c.id] ?? [];
    const lastT = have.length ? have[have.length - 1].t : 0;
    S.readings[c.id] = have.length ? [...have, ...c.readings.filter((r) => r.t > lastT)].slice(-600) : c.readings;
    if (c.error) S.chanErr[c.id] = c.error;
    else delete S.chanErr[c.id];
  }
  for (const id of Object.keys(S.readings)) if (!st.channels.some((c) => c.id === id)) delete S.readings[id];
}

function applySnap(snap, render = true) {
  const prevNodes = new Set((S.snap.nodes ?? []).map((n) => n.node));
  S.snap = { ...snap, nodes: snap.nodes ?? [] };
  const sig = `${snap.hub_ok}|${S.snap.nodes.map((n) => `${n.node}:${n.transport}:${n.port}`).join(",")}`;
  const changed = sig !== S.sig;
  S.sig = sig;
  for (const n of S.snap.nodes) if (!prevNodes.has(n.node)) delete S.describe[n.node];
  if (!render) return;
  if (changed) {
    refresh("nodes");
    if (S.nav === "device") loadDescribe(S.q.node);
    renderSidebar();
  }
  refresh("snapshot");
}

let reloadTimer = null;
function onFeed(msg) {
  const { kind, data } = msg;
  if (kind === "reading") {
    const list = S.readings[data.c] ?? (S.readings[data.c] = []);
    list.push(data);
    if (list.length > 600) list.splice(0, list.length - 600);
    refresh("reading");
  } else if (kind === "audit") {
    if (!S.st) return;
    S.st.audit.push(data);
    if (S.st.audit.length > 300) S.st.audit.splice(0, S.st.audit.length - 300);
    if (data.alert) {
      S.st.unseen = (S.st.unseen ?? 0) + 1;
      if (S.nav === "alerts") markSeen();
      else renderBadge();
    }
    refresh("audit");
  } else if (kind === "channel") {
    if (data.error) S.chanErr[data.id] = data.error;
    else delete S.chanErr[data.id];
    live();
  } else if (kind === "config") {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try { await loadState(); refresh("config"); renderSidebar(); } catch {}
    }, 150);
  }
}

function connectStream() {
  const es = new EventSource("/events");
  es.addEventListener("open", () => { S.sse = true; refresh("sse"); });
  es.addEventListener("error", () => { S.sse = false; refresh("sse"); });
  es.addEventListener("snapshot", (e) => { try { applySnap(JSON.parse(e.data)); } catch {} });
  es.addEventListener("feed", (e) => { try { onFeed(JSON.parse(e.data)); } catch {} });
}

async function start() {
  renderShell();
  renderView();
  try {
    await loadState();
  } catch (e) {
    $("#view").innerHTML = card({ body: `<p class="err">${esc(e.message)}</p>` });
    return;
  }
  route();
  connectStream();
  requestAnimationFrame(animate);
  setInterval(live, 1000);
  setInterval(() => { if (S.nav === "history" && ["15m", "1h"].includes(S.histRange)) loadHistory(); }, 15000);
}

start();
