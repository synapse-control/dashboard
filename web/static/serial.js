const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const supported = () => typeof navigator !== "undefined" && "serial" in navigator && globalThis.isSecureContext !== false;

const FAMILY = {
  0x2341: "avr", 0x2a03: "avr", 0x10c4: "esp", 0x1a86: "either", 0x0403: "either", 0x303a: "esp-native",
};
export function guess(info = {}) {
  const fam = FAMILY[info.usbVendorId] ?? "either";
  const names = { avr: "an Arduino", esp: "an ESP32 board", either: "a USB serial board", "esp-native": "an ESP32-S3/C3 (native USB)" };
  return { family: fam, name: names[fam] };
}

export class Link {
  constructor(port) {
    this.port = port;
    this.bytes = [];
    this.text = "";
    this.waiters = [];
    this.onLine = null;
  }
  async open(baudRate = 115200) {
    await this.port.open({ baudRate, bufferSize: 65536 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.push(value);
        }
      } catch {}
    })();
  }
  push(chunk) {
    for (const b of chunk) this.bytes.push(b);
    if (this.bytes.length > 1 << 20) this.bytes.splice(0, this.bytes.length - (1 << 20));
    this.text += new TextDecoder("latin1").decode(chunk);
    let i;
    while ((i = this.text.indexOf("\n")) >= 0) {
      const line = this.text.slice(0, i).replace(/\r$/, "");
      this.text = this.text.slice(i + 1);
      if (line) this.lineIn(line);
    }
    if (this.text.length > 1 << 18) this.text = "";
    for (const w of this.waiters.splice(0)) w();
  }
  lineIn(line) {
    this.onLine?.(line);
    let msg = null;
    if (line.startsWith("{")) { try { msg = JSON.parse(line); } catch {} }
    if (msg) this.lastMsgs = [...(this.lastMsgs ?? []).slice(-50), msg];
    for (const f of [...(this.listeners ?? [])]) f(line, msg);
  }
  listen(f) { (this.listeners ??= []).push(f); return () => { this.listeners = this.listeners.filter((x) => x !== f); }; }
  async close() {
    try { await this.reader?.cancel(); } catch {}
    await this.reading;
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port.close(); } catch {}
  }
  write(data) { return this.writer.write(typeof data === "string" ? enc.encode(data) : data); }
  signals(o) { return this.port.setSignals(o); }
  drain() { this.bytes = []; }
  async take(n, ms) {
    const end = Date.now() + ms;
    while (this.bytes.length < n) {
      const left = end - Date.now();
      if (left <= 0) throw new Error("the board did not answer");
      await Promise.race([new Promise((r) => this.waiters.push(r)), sleep(left)]);
    }
    return this.bytes.splice(0, n);
  }
  waitMsg(test, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error("the board did not answer")); }, ms);
      const off = this.listen((line, msg) => { if (msg && test(msg)) { clearTimeout(t); off(); resolve(msg); } });
    });
  }
}

let nextId = 1;
export async function request(link, op, args = {}, by = "user:browser", ms = 5000) {
  const id = 100000 + nextId++;
  const wait = link.waitMsg((m) => m.t === "result" && m.id === id, ms);
  await link.write(JSON.stringify({ t: "cmd", v: 2, id, op, args, by }) + "\n");
  const r = await wait;
  if (!r.ok) throw new Error(`${r.err?.code ?? "ERROR"}: ${r.err?.msg ?? "the board refused"}`);
  return r.data;
}

export async function detect(port) {
  const link = new Link(port);
  await link.open(115200);
  const got = link.waitMsg((m) => m.t === "describe", 3500).catch(() => null);
  await link.signals({ dataTerminalReady: false, requestToSend: true });
  await sleep(100);
  await link.signals({ dataTerminalReady: false, requestToSend: false });
  let d = await got;
  if (!d) {
    const again = link.waitMsg((m) => m.t === "describe", 2000).catch(() => null);
    await link.write('{"t":"cmd","v":2,"id":0,"op":"describe"}\n');
    d = await again;
  }
  return { link, describe: d };
}

async function sha256(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function firmware(board, fetchFn = fetch) {
  const m = await (await fetchFn("/firmware/manifest.json")).json();
  const b = m.boards?.[board];
  if (!b) throw new Error(`this hub has no firmware for ${board}`);
  const res = await fetchFn(`/firmware/${b.file}`);
  if (!res.ok) throw new Error(`firmware download failed (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256(bytes)) !== b.sha256) throw new Error("the firmware download is corrupt (checksum differs); try again");
  return { fw: m.fw, bytes, address: b.address ?? 0, keep: b.keep };
}

export async function flashEsp32(port, image, progress = () => {}, loadEsptool = () => import("/static/vendor/esptool.js")) {
  const { ESPLoader, Transport } = await loadEsptool();
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine() {}, write() {} };
  const loader = new ESPLoader({ transport, baudrate: 460800, terminal });
  try {
    progress("Putting the board into its download mode", 0);
    await loader.main();
    const chip = loader.chip.CHIP_NAME;
    if (chip !== "ESP32") throw new Error(`this is an ${chip}; Synapse firmware runs on the classic ESP32 so far`);
    const [from, to] = image.keep ?? [image.bytes.length, image.bytes.length];
    await loader.writeFlash({
      fileArray: [{ data: image.bytes.slice(0, from), address: image.address }, { data: image.bytes.slice(to), address: image.address + to }].filter((f) => f.data.length),
      flashMode: "keep", flashFreq: "keep", flashSize: "keep", eraseAll: false, compress: true,
      reportProgress: (_i, written, total) => progress("Writing the firmware", written / total),
    });
    progress("Restarting the board", 1);
    await loader.after("hard_reset");
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

export function parseHex(text) {
  const out = new Uint8Array(32768).fill(0xff);
  let base = 0, top = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(":")) continue;
    const b = line.slice(1).match(/../g).map((x) => parseInt(x, 16));
    const [len, hi, lo, type] = b;
    if (type === 0) {
      const at = base + ((hi << 8) | lo);
      for (let k = 0; k < len; k++) out[at + k] = b[4 + k];
      top = Math.max(top, at + len);
    } else if (type === 1) break;
    else if (type === 2) base = ((b[4] << 8) | b[5]) << 4;
    else if (type === 4) base = ((b[4] << 8) | b[5]) << 16;
  }
  return out.slice(0, Math.ceil(top / 128) * 128);
}

async function stk(link, bytes, answer, ms = 400) {
  link.drain();
  await link.write(new Uint8Array([...bytes, 0x20]));
  const r = await link.take(answer + 2, ms);
  if (r[0] !== 0x14 || r[r.length - 1] !== 0x10) throw new Error("the bootloader answered out of step");
  return r.slice(1, -1);
}

export async function flashAvr(port, hexText, progress = () => {}) {
  const image = parseHex(hexText);
  let last;
  for (const baud of [115200, 57600]) {
    const link = new Link(port);
    await link.open(baud);
    try {
      progress("Resetting the board into its bootloader", 0);
      await link.signals({ dataTerminalReady: false, requestToSend: false });
      await sleep(250);
      await link.signals({ dataTerminalReady: true, requestToSend: true });
      await sleep(50);
      let synced = false;
      for (let k = 0; k < 4 && !synced; k++) {
        link.drain();
        await link.write(new Uint8Array([0x30, 0x20]));
        const end = Date.now() + (k ? 600 : 2000);
        while (!synced && Date.now() < end) {
          const i = link.bytes.indexOf(0x14);
          synced = i >= 0 && link.bytes[i + 1] === 0x10;
          if (!synced) await sleep(20);
        }
      }
      if (!synced) throw new Error("no bootloader answered");
      await sleep(50);
      const sig = await stk(link, [0x75], 3);
      if (sig.join(",") !== "30,149,15") throw new Error(`this chip is not an ATmega328P (signature ${sig.map((x) => x.toString(16)).join(" ")})`);
      await stk(link, [0x50], 0);
      for (let at = 0; at < image.length; at += 128) {
        const w = at >> 1;
        await stk(link, [0x55, w & 0xff, w >> 8], 0);
        await stk(link, [0x64, 0x00, 0x80, 0x46, ...image.slice(at, at + 128)], 0, 1000);
        progress("Writing the firmware", (at + 128) / image.length / 2);
      }
      for (let at = 0; at < image.length; at += 128) {
        const w = at >> 1;
        await stk(link, [0x55, w & 0xff, w >> 8], 0);
        const got = await stk(link, [0x74, 0x00, 0x80, 0x46], 128, 1000);
        for (let k = 0; k < 128; k++) if (got[k] !== image[at + k]) throw new Error(`verify failed at byte ${at + k}`);
        progress("Checking what was written", 0.5 + (at + 128) / image.length / 2);
      }
      await stk(link, [0x51], 0);
      progress("Restarting the board", 1);
      return;
    } catch (e) {
      if (!last || /no bootloader/.test(last.message)) last = e;
    } finally {
      await link.close();
    }
  }
  throw last;
}

export function tabBridge(link, url, key, onState) {
  let ws = null, stopped = false, timer = null;
  const off = link.listen((line) => { if (ws?.readyState === 1) ws.send(line + "\n"); });
  const connect = () => {
    if (stopped) return;
    onState("dialling");
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: "auth", key }) + "\n");
      link.write('{"t":"cmd","v":2,"id":0,"op":"describe"}\n');
      onState("open");
    };
    ws.onmessage = (e) => link.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    ws.onclose = () => { if (!stopped) { onState("lost"); timer = setTimeout(connect, 2000); } };
    ws.onerror = () => {};
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); off(); ws?.close(); onState("stopped"); };
}
