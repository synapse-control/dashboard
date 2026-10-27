"use strict";

const admin = document.querySelector("main")?.dataset.admin === "true";

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "class") e.className = v;
    else if (v !== undefined && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k instanceof Node ? k : String(k));
  return e;
};

const message = (data, status) => {
  let m = data?.error ?? `HTTP ${status}`;
  try {
    const inner = JSON.parse(m);
    m = inner?.error?.msg ?? inner?.error ?? m;
  } catch {}
  return typeof m === "string" ? m : JSON.stringify(m);
};

async function call(tool, args = {}) {
  const res = await fetch(`/api/call/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(message(data, res.status));
  return data;
}

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

const leds = new Set();
const animate = () => {
  const now = Date.now();
  for (const led of leds) {
    if (!led.isConnected) { leds.delete(led); continue; }
    const code = Number(led.dataset.code);
    led.classList.toggle("on", Number.isFinite(code) && led.dataset.code !== "" && beaconOn(code, now));
  }
  requestAnimationFrame(animate);
};
requestAnimationFrame(animate);

const led = (code) => {
  const e = el("span", { class: "led", "data-code": code ?? "", title: code === undefined ? "no beacon reported" : `beacon ${code}` });
  leds.add(e);
  return e;
};

const hubPill = (s) => {
  const p = document.getElementById("hub");
  if (!p) return;
  p.textContent = s.hub_ok ? `hub ${s.hub_version} · ${s.nodes.length} node${s.nodes.length === 1 ? "" : "s"}` : (s.hub_error || "hub offline");
  p.className = `pill ${s.hub_ok ? "ok" : "bad"}`;
};

const fail = (target, e) => target.replaceChildren(el("p", { class: "error" }, e.message ?? String(e)));

function nodeCard(n, open = true) {
  const beacon = n.beacon === undefined ? "no beacon reported" : `${BEACON[n.beacon] ?? `code ${n.beacon}`}`;
  return el("article", { class: "card node" },
    el("div", { class: "head" },
      el("h2", {}, led(n.beacon), el("a", { href: `/node/${encodeURIComponent(n.node)}` }, n.node)),
      el("span", { class: `pill ${n.simulated ? "" : "ok"}` }, TRANSPORT[n.transport] ?? n.transport)),
    el("dl", {},
      el("dt", {}, "board"), el("dd", {}, n.board),
      el("dt", {}, "chip"), el("dd", {}, `${n.arch} · ${n.vio} V logic`),
      el("dt", {}, "beacon"), el("dd", {}, beacon),
      el("dt", {}, "link"), el("dd", { class: "mono" }, n.spec)),
    el("div", { class: "row" },
      open ? el("a", { class: "button", href: `/node/${encodeURIComponent(n.node)}` }, "Open") : null,
      admin ? el("button", { type: "button", class: "secondary", on: { click: async (ev) => {
        if (!confirm(`Disconnect ${n.node} from the hub?`)) return;
        ev.target.disabled = true;
        try { await call("disconnect_node", { node: n.node }); } catch (e) { alert(e.message); ev.target.disabled = false; }
      } } }, "Disconnect") : null));
}

function nodesView(root) {
  return (s) => {
    document.getElementById("empty").hidden = !s.hub_ok || s.nodes.length > 0;
    root.replaceChildren(...s.nodes.map(nodeCard));
  };
}

function pinsTable(name, described, target) {
  const rows = described.pins.map((p) => {
    const out = el("td", { class: "mono" });
    const run = (fn) => async (ev) => {
      ev.target.disabled = true;
      try { out.textContent = await fn(); } catch (e) { out.textContent = e.message; }
      ev.target.disabled = false;
    };
    const analog = p.caps.includes("ain");
    const read = run(async () => {
      const r = await call("read", { node: name, pin: p.id, as: analog ? "a" : "d" });
      return analog ? `${r.v} ${r.unit} ± ${r.err}${r.flags?.length ? ` (${r.flags.join(", ")})` : ""}` : `logic ${r.value ?? r.v}`;
    });
    const actions = [el("button", { type: "button", class: "small", on: { click: read } }, "Read")];
    if (admin && p.caps.includes("dout")) {
      for (const v of [0, 1]) actions.push(el("button", { type: "button", class: "small secondary", on: { click: run(async () => {
        await call("write", { node: name, pin: p.id, value: v });
        return `driven ${v ? "high" : "low"}`;
      }) } }, `Drive ${v ? "high" : "low"}`));
      actions.push(el("button", { type: "button", class: "small secondary", on: { click: run(async () => {
        await call("release", { node: name, pins: [p.id] });
        return "released (high impedance)";
      }) } }, "Release"));
    }
    return el("tr", {}, el("td", { class: "mono" }, p.id), el("td", {}, p.label ?? ""), el("td", { class: "muted" }, p.caps.join(" ")), el("td", { class: "row" }, actions), out);
  });
  target.replaceChildren(el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Pin"), el("th", {}, "Label"), el("th", {}, "Can"), el("th", {}, ""), el("th", {}, "Result"))),
    el("tbody", {}, rows)));
  const reserved = described.reserved?.length ? `reserved: ${described.reserved.join(", ")}` : "";
  document.getElementById("pins-note").textContent = reserved;
}

const range = (r, unit) => (r ? `${r.lo}-${r.hi} ${unit}` : "");

function surveyView(s, target) {
  target.replaceChildren(
    el("p", {}, s.summary),
    el("div", { class: "scroll" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Pin"), el("th", {}, "Finding"), el("th", {}, "Confidence"), el("th", {}, "Source"), el("th", {}, "Note"))),
      el("tbody", {}, s.pins.map((p) => el("tr", { class: s.attached.includes(p.pin) ? "hit" : "" },
        el("td", { class: "mono" }, p.label ? `${p.pin} (${p.label})` : p.pin),
        el("td", {}, (p.verdict ?? p.class).replace(/_/g, " ")),
        el("td", {}, p.confidence),
        el("td", { class: "mono" }, p.v_th ? `${range(p.v_th, "V")} through ${range(p.r_th_ohm, "Ω")}` : ""),
        el("td", { class: "muted" }, p.note ?? "")))))),
    s.buses?.length ? el("p", {}, s.buses.map((b) => `${b.bus}: ${b.result.found.length ? `found ${b.result.found.map((f) => (typeof f === "object" ? JSON.stringify(f) : f)).join(", ")}` : "nothing found"}`).join("; ")) : null,
    s.limits?.length ? el("details", {}, el("summary", {}, "What this cannot tell"), el("ul", {}, s.limits.map((l) => el("li", {}, l)))) : null);
}

function nodeView(root) {
  const name = root.dataset.node;
  let described = false;
  const pins = document.getElementById("pins");
  const surveyBtn = document.getElementById("survey");
  const surveyOut = document.getElementById("survey-out");
  surveyBtn.addEventListener("click", async () => {
    surveyBtn.disabled = true;
    surveyOut.replaceChildren(el("p", { class: "muted" }, "Surveying every pin…"));
    try { surveyView(await call("identify_circuit", { node: name }), surveyOut); } catch (e) { fail(surveyOut, e); }
    surveyBtn.disabled = false;
  });
  return (s) => {
    const n = s.nodes.find((x) => x.node === name);
    const summary = document.getElementById("summary");
    if (!n) {
      summary.replaceChildren(el("p", { class: "muted" }, s.hub_ok ? `${name} is not on the hub right now. It will appear here when it dials back in.` : "The hub is offline."));
      return;
    }
    summary.replaceChildren(nodeCard(n, false));
    document.getElementById("wire").textContent = n.wire.join("\n");
    if (!described) {
      described = true;
      call("describe_node", { node: name, full: true }).then((d) => pinsTable(name, d, pins)).catch((e) => { described = false; fail(pins, e); });
    }
  };
}

function addView() {
  const scan = document.getElementById("scan");
  const scanOut = document.getElementById("scan-out");
  scan?.addEventListener("click", async () => {
    scan.disabled = true;
    scanOut.replaceChildren(el("p", { class: "muted" }, "Scanning…"));
    try {
      const rows = await call("scan_devices", { deep: false });
      scanOut.replaceChildren(rows.length ? el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Port"), el("th", {}, "Bridge"), el("th", {}, "Runs"), el("th", {}, ""))),
        el("tbody", {}, rows.map((r) => el("tr", {},
          el("td", { class: "mono" }, r.port), el("td", {}, r.bridge), el("td", {}, r.synapse ? `Synapse ${r.synapse.fw} on ${r.synapse.board}` : r.state),
          el("td", {}, r.synapse ? el("button", { type: "button", class: "small", on: { click: async (ev) => {
            ev.target.disabled = true;
            try { await call("connect_node", { port: r.port }); ev.target.textContent = "connected"; } catch (e) { alert(e.message); ev.target.disabled = false; }
          } } }, "Connect") : ""))))) : el("p", { class: "muted" }, "No USB boards are visible to the hub."));
    } catch (e) { fail(scanOut, e); }
    scan.disabled = false;
  });
  const form = document.getElementById("connect");
  form?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(form);
    const out = document.getElementById("connect-out");
    out.textContent = "Connecting…";
    try {
      const args = { port: `tcp:${f.get("host").trim()}:${f.get("port").trim()}` };
      if (f.get("name").trim()) args.name = f.get("name").trim();
      await call("connect_node", args);
      out.textContent = "Connected. It is on the Nodes page.";
    } catch (e) { out.textContent = e.message; }
  });
}

const view = document.querySelector("[data-view]");
if (view) {
  const update = view.dataset.view === "node" ? nodeView(view) : nodesView(view);
  const es = new EventSource("/events");
  es.onmessage = (m) => {
    const s = JSON.parse(m.data);
    hubPill(s);
    update(s);
  };
  es.onerror = () => {
    const p = document.getElementById("hub");
    if (p) { p.textContent = "reconnecting…"; p.className = "pill bad"; }
  };
}
if (document.getElementById("scan") || document.getElementById("connect")) addView();
