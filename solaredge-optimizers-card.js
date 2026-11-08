/**
 * SolarEdge Optimizers card for Home Assistant.
 *
 * Finds every optimizer from the SolarEdge Optimizers integration on its own
 * and shows them as a panel map grouped by string, coloured by power, with
 * health problems marked. Also draws today's total optimizer output and the
 * optimizers producing least compared with their peers.
 *
 * https://github.com/SharperThanThou/SolarEdge-Optimizers-Card
 */

const VERSION = "0.1.0";
const DOMAIN = "solaredge_optimizers";
const HISTORY_REFRESH_MS = 10 * 60 * 1000;
const BUCKET_MS = 5 * 60 * 1000;

// Sequential blue ramp (magnitude). Light mode runs light -> dark, dark mode
// runs dark -> light so low output always recedes towards the card surface.
const RAMP_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#104281"];
const RAMP_DARK = ["#16263d", "#104281", "#184f95", "#256abf", "#2a78d6", "#5598e7", "#86b6ef"];
// The LCARS style sits on black, so it also runs dark -> light.
const RAMP_LCARS = ["#1c2340", "#2b3a7a", "#3f55b0", "#5a73d6", "#7d93f0", "#99aaff", "#c4ceff"];

const LCARS = { orange: "#ff9c3c", peach: "#ffcc99", lavender: "#cc99cc", violet: "#9977dd", blue: "#99aaff", tan: "#dd9966" };
const TONE = { good: "#0ca30c", serious: "#ec835a", critical: "#d03b3b" };
const FONT_URL = "https://fonts.googleapis.com/css2?family=Antonio:wght@400;700&display=swap";

function loadLcarsFont() {
  if (document.getElementById("solaredge-optimizers-card-font")) return;
  const link = document.createElement("link");
  link.id = "solaredge-optimizers-card-font";
  link.rel = "stylesheet";
  link.href = FONT_URL;
  document.head.append(link);
}

const STATUS = {
  ok: { tone: "good", icon: "mdi:check-circle-outline", label: "OK", problem: false },
  low_output: { tone: "serious", icon: "mdi:solar-power-variant-outline", label: "Low output", problem: true },
  no_output: { tone: "critical", icon: "mdi:power-plug-off-outline", label: "No output", problem: true },
  not_reporting: { tone: "critical", icon: "mdi:access-point-network-off", label: "Not reporting", problem: true },
  safe_mode: { tone: "critical", icon: "mdi:shield-alert-outline", label: "Stuck in safe mode", problem: true },
  unknown: { tone: "none", icon: "mdi:help-circle-outline", label: "Unknown", problem: false },
};

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const num = (state) => {
  const value = parseFloat(state?.state);
  return Number.isFinite(value) ? value : null;
};

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function mix(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ch = (shift) => Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

function rampColor(ramp, t) {
  const x = Math.min(Math.max(t, 0), 1) * (ramp.length - 1);
  const i = Math.min(Math.floor(x), ramp.length - 2);
  return mix(ramp[i], ramp[i + 1], x - i);
}

function isLight(hex) {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  return lum > 0.32;
}

function formatPower(watts) {
  if (watts === null) return "–";
  if (Math.abs(watts) >= 1000) return `${(watts / 1000).toFixed(watts >= 10000 ? 1 : 2)} kW`;
  return `${Math.round(watts)} W`;
}

function relativeTime(date, now = Date.now()) {
  if (!date || Number.isNaN(date.getTime())) return "–";
  const minutes = Math.round((now - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (value <= step * exp) return step * exp;
  }
  return 10 * exp;
}

class SolarEdgeOptimizersCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._optimizers = [];
    this._sites = [];
    this._history = null;
    this._historyFetched = 0;
    this._width = 0;
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = {
      title: "Solar optimizers",
      show_history: true,
      show_weakest: 5,
      style: "default",
      lcars_font: true,
      ...config,
    };
    this._signature = null;
    this._schedule();
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    if (!previous || previous.entities !== hass.entities || previous.devices !== hass.devices) {
      this._discover();
    }
    const signature = this._stateSignature();
    if (signature !== this._signature) {
      this._signature = signature;
      this._schedule();
    }
    this._maybeFetchHistory();
  }

  getCardSize() {
    return 10;
  }

  getGridOptions() {
    return { columns: "full", min_columns: 6, min_rows: 6 };
  }

  connectedCallback() {
    this._resize = new ResizeObserver((entries) => {
      const width = Math.round(entries[0].contentRect.width);
      if (Math.abs(width - this._width) > 4) {
        this._width = width;
        this._schedule();
      }
    });
    this._resize.observe(this);
    this._clock = setInterval(() => this._schedule(), 60 * 1000);
  }

  disconnectedCallback() {
    this._resize?.disconnect();
    clearInterval(this._clock);
  }

  // ----- discovery -------------------------------------------------------

  _discover() {
    const hass = this._hass;
    const byDevice = new Map();
    for (const entry of Object.values(hass.entities || {})) {
      if (entry.platform !== DOMAIN || !entry.device_id) continue;
      if (!byDevice.has(entry.device_id)) byDevice.set(entry.device_id, []);
      byDevice.get(entry.device_id).push(entry);
    }

    const optimizers = [];
    const sites = new Map();
    for (const [deviceId, entries] of byDevice) {
      const find = (key) => entries.find((e) => e.translation_key === key)?.entity_id;
      if (find("unhealthy_optimizers") || find("any_optimizer_problem")) {
        sites.set(deviceId, {
          deviceId,
          name: this._deviceName(deviceId),
          problem: find("any_optimizer_problem"),
          latest: find("latest_measurement"),
        });
        continue;
      }
      const health = find("health");
      if (!health) continue;
      const power = entries.find(
        (e) => e.entity_id.startsWith("sensor.") && !e.translation_key && hass.states[e.entity_id]?.attributes.device_class === "power",
      )?.entity_id;
      optimizers.push({
        deviceId,
        siteId: this._rootDevice(deviceId),
        name: this._deviceName(deviceId).replace(/^Optimizer\s+/i, ""),
        fullName: this._deviceName(deviceId),
        health,
        power,
        ratio: find("peer_ratio"),
        voltage: find("module_voltage"),
        last: find("last_measurement"),
      });
    }
    optimizers.sort((a, b) => naturalCompare(a.name, b.name));
    if (this._config?.site) {
      const want = String(this._config.site).toLowerCase();
      this._sites = [...sites.values()].filter((s) => s.name.toLowerCase().includes(want));
      const keep = new Set(this._sites.map((s) => s.deviceId));
      this._optimizers = optimizers.filter((o) => keep.has(o.siteId));
    } else {
      this._sites = [...sites.values()];
      this._optimizers = optimizers;
    }
    this._entityIds = this._optimizers.flatMap((o) => [o.health, o.power, o.ratio, o.last]).filter(Boolean);
    this._entityIds.push(...this._sites.flatMap((s) => [s.problem, s.latest]).filter(Boolean));
    this._signature = null;
    this._history = null;
    this._historyFetched = 0;
  }

  _deviceName(deviceId) {
    const device = this._hass.devices?.[deviceId];
    return device?.name_by_user || device?.name || deviceId;
  }

  _rootDevice(deviceId) {
    let id = deviceId;
    for (let i = 0; i < 5; i += 1) {
      const parent = this._hass.devices?.[id]?.via_device_id;
      if (!parent) break;
      id = parent;
    }
    return id;
  }

  _stateSignature() {
    const states = this._hass.states;
    return (this._entityIds || []).map((id) => states[id]?.last_updated ?? "").join("|") + `|${this._hass.themes?.darkMode}`;
  }

  // ----- history ---------------------------------------------------------

  async _maybeFetchHistory() {
    if (!this._config?.show_history || this._fetching || !this._optimizers.length) return;
    if (Date.now() - this._historyFetched < HISTORY_REFRESH_MS) return;
    const ids = this._optimizers.map((o) => o.power).filter(Boolean);
    if (!ids.length) return;
    this._fetching = true;
    this._historyFetched = Date.now();
    try {
      const end = new Date();
      const start = new Date(end);
      start.setHours(0, 0, 0, 0);
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: ids,
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      this._history = this._sumHistory(result, ids, start.getTime(), end.getTime());
      this._schedule();
    } catch (err) {
      console.warn("solaredge-optimizers-card: history unavailable", err);
    } finally {
      this._fetching = false;
    }
  }

  _sumHistory(result, ids, start, end) {
    const series = ids.map((id) =>
      (result[id] || [])
        .map((p) => ({ t: (p.lu ?? p.lc ?? 0) * 1000, v: parseFloat(p.s) }))
        .sort((a, b) => a.t - b.t),
    );
    const cursors = series.map(() => 0);
    const values = series.map(() => 0);
    const points = [];
    for (let t = start; t <= end; t += BUCKET_MS) {
      let total = 0;
      series.forEach((s, i) => {
        while (cursors[i] < s.length && s[cursors[i]].t <= t) {
          const v = s[cursors[i]].v;
          values[i] = Number.isFinite(v) ? v : 0;
          cursors[i] += 1;
        }
        total += values[i];
      });
      points.push({ t, v: total });
    }
    return points;
  }

  // ----- rendering -------------------------------------------------------

  _schedule() {
    if (this._pending) return;
    this._pending = true;
    requestAnimationFrame(() => {
      this._pending = false;
      this._render();
    });
  }

  _model() {
    const states = this._hass.states;
    const items = this._optimizers.map((o) => {
      const health = states[o.health];
      const status = health?.state in STATUS ? health.state : "unknown";
      const last = states[o.last]?.state;
      return {
        ...o,
        status,
        statusLabel: health && this._hass.formatEntityState ? this._hass.formatEntityState(health) : STATUS[status].label,
        string: health?.attributes.string || "Unassigned",
        watts: num(states[o.power]),
        ratio: num(states[o.ratio]),
        volts: num(states[o.voltage]),
        lastAt: last ? new Date(last) : null,
      };
    });
    const strings = new Map();
    for (const item of items) {
      if (!strings.has(item.string)) strings.set(item.string, []);
      strings.get(item.string).push(item);
    }
    const sortedStrings = [...strings.entries()].sort(([a], [b]) => naturalCompare(a, b));
    const max = Math.max(this._config.max_power || 0, ...items.map((i) => i.watts || 0));
    const latest = items.reduce((acc, i) => (i.lastAt && (!acc || i.lastAt > acc) ? i.lastAt : acc), null);
    return { items, strings: sortedStrings, max, latest };
  }

  _render() {
    if (!this._hass || !this._config) return;
    const model = this._model();
    const dark = Boolean(this._hass.themes?.darkMode);
    const lcars = this._config.style === "lcars";
    this._lcars = lcars;
    const ramp = lcars ? RAMP_LCARS : dark ? RAMP_DARK : RAMP_LIGHT;
    if (lcars && this._config.lcars_font) loadLcarsFont();

    if (!this._shell) {
      this.shadowRoot.innerHTML = `<style>${STYLES}</style><ha-card><div class="body"></div><div class="tip" role="tooltip"></div></ha-card>`;
      this._card = this.shadowRoot.querySelector("ha-card");
      this._shell = this.shadowRoot.querySelector(".body");
      this._tip = this.shadowRoot.querySelector(".tip");
      this._shell.addEventListener("pointerover", (ev) => this._hover(ev));
      this._shell.addEventListener("pointermove", (ev) => this._hover(ev));
      this._shell.addEventListener("pointerleave", () => this._hideTip());
      this._shell.addEventListener("click", (ev) => this._click(ev));
      this._shell.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") this._click(ev);
      });
    }
    this._items = model.items;
    this._card.classList.toggle("lcars", lcars);
    this._shell.classList.toggle("narrow", Boolean(this._width) && this._width < 520);

    if (!model.items.length) {
      this._shell.innerHTML = `<div class="empty">No optimizers found. Install and set up the
        <a href="https://github.com/SharperThanThou/SolarEdge-Optimizers" target="_blank" rel="noreferrer">SolarEdge Optimizers</a>
        integration first.</div>`;
      return;
    }

    if (lcars) {
      this._shell.innerHTML = this._renderLcars(model, ramp);
      return;
    }
    const stroke = dark ? "#3987e5" : "#2a78d6";
    this._shell.innerHTML = [
      this._config.title ? `<h1 class="title">${esc(this._config.title)}</h1>` : "",
      this._renderStats(model),
      this._config.show_history ? this._renderHistory(stroke, this._width - 32) : "",
      this._renderMap(model, ramp),
      this._renderWeakest(model, ramp),
    ].join("");
  }

  _summary({ items, latest }) {
    const problems = items.filter((i) => STATUS[i.status].problem);
    return {
      total: items.reduce((sum, i) => sum + (i.watts || 0), 0),
      producing: items.filter((i) => (i.watts || 0) > 0).length,
      problems,
      tone: problems.length ? (problems.some((p) => STATUS[p.status].tone === "critical") ? "critical" : "serious") : "good",
      latest,
    };
  }

  _renderLcars(model, ramp) {
    const sum = this._summary(model);
    const side = this._width && this._width < 520 ? 70 : 124;
    const alert = sum.problems.length ? `background:${TONE[sum.tone]}` : `background:${LCARS.blue}`;
    const block = (label, value, style, cls = "") =>
      `<div class="lc-block ${cls}" style="${style}"><span class="lc-label">${label}</span><span class="lc-value">${value}</span></div>`;
    return `<div class="lc" style="--side:${side}px">
      <div class="lc-corner"></div>
      <div class="lc-top"><span class="lc-bar"></span>${this._config.title ? `<h1 class="lc-title">${esc(this._config.title)}</h1>` : ""}<span class="lc-cap"></span></div>
      <div class="lc-side">
        ${block("Output", formatPower(sum.total), `background:${LCARS.lavender}`)}
        ${block("Producing", `${sum.producing}/${model.items.length}`, `background:${LCARS.peach}`)}
        ${block("Problems", sum.problems.length, alert, sum.tone === "critical" ? "alert" : "")}
        ${block("Last report", relativeTime(sum.latest), `background:${LCARS.tan}`, "small")}
        <div class="lc-block lc-fill" style="background:${LCARS.violet}"></div>
      </div>
      <div class="lc-main">
        ${this._config.show_history ? this._renderHistory(LCARS.orange, this._width - side - 46) : ""}
        ${this._renderMap(model, ramp)}
        ${this._renderWeakest(model, ramp)}
      </div>
      <div class="lc-corner-b"></div>
      <div class="lc-bottom"><span class="lc-bar"></span>
        <span class="lc-code">${model.items.length} optimizers · ${model.strings.length} ${model.strings.length === 1 ? "string" : "strings"}</span>
        <span class="lc-cap"></span></div>
    </div>`;
  }

  _renderStats(model) {
    const { total, producing, problems, tone: problemTone, latest } = this._summary(model);
    const { items } = model;
    return `<div class="stats">
      <div class="stat"><div class="label">Output now</div><div class="value">${formatPower(total)}</div></div>
      <div class="stat"><div class="label">Producing</div><div class="value">${producing}<span class="of"> / ${items.length}</span></div></div>
      <div class="stat"><div class="label">Problems</div><div class="value">
        <ha-icon class="tone-${problemTone}" icon="${problems.length ? "mdi:alert-circle" : "mdi:check-circle"}"></ha-icon>${problems.length}</div></div>
      <div class="stat"><div class="label">Last report</div><div class="value small">${relativeTime(latest)}</div></div>
    </div>`;
  }

  _renderMap({ strings, max }, ramp) {
    const sections = strings.map(([name, list]) => {
      const total = list.reduce((sum, i) => sum + (i.watts || 0), 0);
      const tiles = list.map((item) => {
        const index = this._items.indexOf(item);
        const status = STATUS[item.status];
        const lit = item.watts && item.watts > 0;
        let fill = lit ? rampColor(ramp, item.watts / (max || 1)) : null;
        if (this._lcars && status.problem) fill = TONE[status.tone];
        const ink = fill ? (isLight(fill) ? "#0b0b0b" : "#ffffff") : null;
        const style = fill ? `background:${fill};color:${ink}` : "";
        const badge = status.problem
          ? `<span class="badge tone-bg-${status.tone}"><ha-icon icon="${status.icon}"></ha-icon></span>`
          : "";
        return `<div class="tile ${lit ? "" : "dim"} ${status.problem ? `problem ring-${status.tone}` : ""}"
            style="${style}" data-index="${index}" tabindex="0" role="button"
            aria-label="${esc(`${item.fullName}: ${formatPower(item.watts)}, ${item.statusLabel}`)}">
          ${badge}
          <span class="name">${esc(item.name)}</span>
          <span class="watts">${item.watts === null ? "–" : Math.round(item.watts)}<small> W</small></span>
          ${status.problem ? `<span class="state">${esc(item.statusLabel)}</span>` : ""}
        </div>`;
      });
      return `<section class="string">
        <div class="string-head"><span>${esc(name === "Unassigned" ? (strings.length > 1 ? "Not in a string" : "Optimizers") : /^string/i.test(name) ? name : `String ${name}`)}</span>
          <span class="rule"></span><span class="muted">${list.length} · ${formatPower(total)}</span></div>
        <div class="grid">${tiles.join("")}</div>
      </section>`;
    });
    const gradient = ramp.map((c, i) => `${c} ${Math.round((i / (ramp.length - 1)) * 100)}%`).join(",");
    return `<div class="map">${sections.join("")}</div>
      <div class="legend">
        ${max > 0 ? `<span class="scale"><span class="muted">0 W</span><span class="bar" style="background:linear-gradient(90deg,${gradient})"></span><span class="muted">${formatPower(max)}</span></span>` : ""}
        <span class="key"><span class="dot tone-bg-serious"></span>Low output</span>
        <span class="key"><span class="dot tone-bg-critical"></span>No output / not reporting / safe mode</span>
      </div>`;
  }

  _renderWeakest({ items }, ramp) {
    const count = Number(this._config.show_weakest) || 0;
    if (!count) return "";
    const compared = items.filter((i) => i.ratio !== null).sort((a, b) => a.ratio - b.ratio).slice(0, count);
    const head = `<h2 class="sub">Lowest output vs peers</h2>`;
    if (!compared.length) {
      return `${head}<p class="muted note">Comparisons start once the panels produce enough power to judge.</p>`;
    }
    const scaleMax = Math.max(150, ...compared.map((i) => i.ratio));
    const rows = compared.map((item) => {
      const index = this._items.indexOf(item);
      const status = STATUS[item.status];
      const width = Math.max((item.ratio / scaleMax) * 100, 0.5);
      return `<div class="row" data-index="${index}" tabindex="0" role="button">
        <span class="row-name">${esc(item.name)}</span>
        <span class="track"><span class="fill" style="width:${width}%;background:${ramp[4]}"></span>
          <span class="ref" style="left:${(100 / scaleMax) * 100}%"></span></span>
        <span class="row-val">${Math.round(item.ratio)}%</span>
        <span class="row-status">${status.problem ? `<ha-icon class="tone-${status.tone}" icon="${status.icon}"></ha-icon><span class="row-label">${esc(item.statusLabel)}</span>` : ""}</span>
      </div>`;
    });
    return `${head}<div class="rows">${rows.join("")}</div>
      <p class="muted note">The tick marks 100%, the median of each optimizer's string.</p>`;
  }

  _renderHistory(stroke, available) {
    const head = `<h2 class="sub">Optimizer output today</h2>`;
    const points = this._history;
    if (!points) return `${head}<div class="chart placeholder muted">Loading history…</div>`;
    const width = Math.max(available || 0, 220);
    const height = 140;
    const pad = { l: 44, r: 8, t: 8, b: 22 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const day0 = new Date(points[0].t);
    const dayStart = day0.getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;
    const peak = Math.max(...points.map((p) => p.v));
    const yMax = niceMax(peak * 1.05);
    const x = (t) => pad.l + ((t - dayStart) / (dayEnd - dayStart)) * innerW;
    const y = (v) => pad.t + innerH - (v / yMax) * innerH;
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${line}L${x(points.at(-1).t).toFixed(1)},${y(0)}L${x(points[0].t).toFixed(1)},${y(0)}Z`;
    const grid = [0, 0.5, 1]
      .map((f) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(yMax * f)}" y2="${y(yMax * f)}" class="${f ? "gridline" : "baseline"}"/>
        <text x="${pad.l - 6}" y="${y(yMax * f) + 4}" text-anchor="end" class="axis">${formatPower(yMax * f)}</text>`)
      .join("");
    const ticks = [0, 6, 12, 18, 24]
      .map((h) => `<text x="${x(dayStart + h * 3600 * 1000)}" y="${height - 6}" text-anchor="middle" class="axis">${String(h % 24).padStart(2, "0")}:00</text>`)
      .join("");
    this._chartGeom = { points, x, y, pad, width, height, dayStart, dayEnd, innerW };
    return `${head}<div class="chart" data-chart="1">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Total optimizer output today, peak ${formatPower(peak)}">
        ${grid}${ticks}
        <path d="${area}" fill="${stroke}" opacity="0.16"/>
        <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + innerH}" visibility="hidden"/>
        <circle class="cross-dot" r="4" fill="${stroke}" visibility="hidden"/>
      </svg></div>`;
  }

  // ----- interaction -----------------------------------------------------

  _hover(ev) {
    const chart = ev.target.closest?.("[data-chart]");
    if (chart && this._chartGeom) {
      this._hoverChart(ev, chart);
      return;
    }
    const el = ev.target.closest?.("[data-index]");
    if (!el) {
      this._hideTip();
      return;
    }
    const item = this._items[Number(el.dataset.index)];
    if (!item) return;
    const status = STATUS[item.status];
    this._showTip(
      ev,
      `<strong>${esc(item.fullName)}</strong>
      <div class="tip-row"><span>String</span><span>${esc(item.string)}</span></div>
      <div class="tip-row"><span>Power</span><span>${formatPower(item.watts)}</span></div>
      <div class="tip-row"><span>vs peers</span><span>${item.ratio === null ? "–" : `${Math.round(item.ratio)}%`}</span></div>
      <div class="tip-row"><span>Module</span><span>${item.volts === null ? "–" : `${item.volts.toFixed(1)} V`}</span></div>
      <div class="tip-row"><span>Health</span><span>${status.problem ? `<ha-icon class="tone-${status.tone}" icon="${status.icon}"></ha-icon>` : ""}${esc(item.statusLabel)}</span></div>
      <div class="tip-row"><span>Reported</span><span>${relativeTime(item.lastAt)}</span></div>`,
    );
  }

  _hoverChart(ev, chart) {
    const g = this._chartGeom;
    const svg = chart.querySelector("svg");
    const rect = svg.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = g.dayStart + ((px - g.pad.l) / g.innerW) * (g.dayEnd - g.dayStart);
    let best = g.points[0];
    for (const p of g.points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (t > g.points.at(-1).t + BUCKET_MS || px < g.pad.l) {
      this._hideTip();
      return;
    }
    const cx = g.x(best.t);
    const cross = svg.querySelector(".cross");
    const dot = svg.querySelector(".cross-dot");
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", g.y(best.v));
    dot.setAttribute("visibility", "visible");
    const time = new Date(best.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    this._showTip(ev, `<div class="tip-row"><span>${time}</span><strong>${formatPower(best.v)}</strong></div>`);
  }

  _showTip(ev, html) {
    const tip = this._tip;
    tip.innerHTML = html;
    tip.style.display = "block";
    const card = this.shadowRoot.querySelector("ha-card").getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = ev.clientX - card.left + 14;
    let top = ev.clientY - card.top + 14;
    if (left + tw > card.width - 4) left = ev.clientX - card.left - tw - 14;
    if (top + th > card.height - 4) top = ev.clientY - card.top - th - 14;
    tip.style.left = `${Math.max(left, 4)}px`;
    tip.style.top = `${Math.max(top, 4)}px`;
  }

  _hideTip() {
    if (this._tip) this._tip.style.display = "none";
    this.shadowRoot.querySelectorAll(".cross, .cross-dot").forEach((el) => el.setAttribute("visibility", "hidden"));
  }

  _click(ev) {
    const el = ev.target.closest?.("[data-index]");
    if (!el) return;
    const item = this._items[Number(el.dataset.index)];
    if (!item) return;
    ev.preventDefault();
    this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: item.health } }));
  }
}

const STYLES = `
  :host { display: block; }
  ha-card { position: relative; overflow: visible; }
  .body { padding: 16px; }
  .title { margin: 0 0 12px; font-size: 1.25rem; font-weight: 500; color: var(--primary-text-color); }
  .sub { margin: 20px 0 8px; font-size: 0.95rem; font-weight: 500; color: var(--primary-text-color); }
  .muted { color: var(--secondary-text-color); }
  .note { font-size: 0.8rem; margin: 6px 0 0; }
  .empty { padding: 8px 0; color: var(--secondary-text-color); }
  .empty a { color: var(--primary-color); }

  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; }
  .stat { padding: 10px 12px; border-radius: 12px; background: var(--secondary-background-color); }
  .stat .label { font-size: 0.75rem; color: var(--secondary-text-color); }
  .stat .value { font-size: 1.5rem; font-weight: 500; color: var(--primary-text-color); display: flex; align-items: center; gap: 4px; }
  .stat .value.small { font-size: 1.05rem; min-height: 2.25rem; }
  .stat .of { font-size: 0.95rem; color: var(--secondary-text-color); font-weight: 400; }
  .stat ha-icon { --mdc-icon-size: 22px; }

  .map { display: flex; flex-direction: column; gap: 14px; margin-top: 20px; }
  .string-head { display: flex; justify-content: space-between; font-size: 0.85rem; margin-bottom: 6px; color: var(--primary-text-color); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(56px, 1fr)); gap: 4px; }
  .tile { position: relative; aspect-ratio: 3 / 4; border-radius: 6px; padding: 5px 6px; box-sizing: border-box;
    display: flex; flex-direction: column; justify-content: space-between; cursor: pointer; min-width: 0;
    background: var(--secondary-background-color); color: var(--primary-text-color); outline: none;
    background-image: linear-gradient(transparent 49%, rgba(255,255,255,0.12) 50%, transparent 51%); }
  .tile.dim { color: var(--secondary-text-color); }
  .tile:hover, .tile:focus-visible { box-shadow: 0 0 0 2px var(--primary-text-color); }
  .tile.problem { box-shadow: 0 0 0 2px var(--card-background-color, #fff), 0 0 0 4px var(--ring); }
  .tile .name { font-size: 0.7rem; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile .watts { font-size: 1.05rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tile .watts small { font-size: 0.65rem; font-weight: 400; }
  .tile .state { font-size: 0.62rem; line-height: 1.1; }
  .badge { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; color: #fff;
    box-shadow: 0 0 0 2px var(--card-background-color, #fff); }
  .badge ha-icon { --mdc-icon-size: 13px; display: flex; }

  .ring-serious { --ring: #ec835a; }
  .ring-critical { --ring: #d03b3b; }
  .tone-good { color: #0ca30c; }
  .tone-serious { color: #ec835a; }
  .tone-critical { color: #d03b3b; }
  .tone-bg-serious { background: #ec835a; }
  .tone-bg-critical { background: #d03b3b; }

  .legend { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin-top: 12px; font-size: 0.75rem; color: var(--secondary-text-color); }
  .legend .scale { display: inline-flex; align-items: center; gap: 6px; }
  .legend .bar { width: 96px; height: 8px; border-radius: 4px; }
  .legend .key { display: inline-flex; align-items: center; gap: 6px; }
  .legend .dot { width: 10px; height: 10px; border-radius: 50%; }

  .rows { display: flex; flex-direction: column; gap: 4px; }
  .row { display: grid; grid-template-columns: minmax(48px, auto) 1fr 44px minmax(0, 9rem); align-items: center; gap: 8px;
    font-size: 0.8rem; color: var(--primary-text-color); cursor: pointer; padding: 2px 4px; border-radius: 6px; outline: none; }
  .row:hover, .row:focus-visible { background: var(--secondary-background-color); }
  .row-name { white-space: nowrap; }
  .row-val { text-align: right; font-variant-numeric: tabular-nums; }
  .row-status { display: flex; align-items: center; gap: 4px; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; }
  .row-status ha-icon { --mdc-icon-size: 16px; }
  .track { position: relative; height: 10px; border-radius: 0 4px 4px 0; }
  .track .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 0 4px 4px 0; }
  .track .ref { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--primary-text-color); opacity: 0.5; }

  .chart { position: relative; }
  .chart.placeholder { height: 140px; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; }
  .chart svg { display: block; overflow: visible; }
  .axis { font-size: 10px; fill: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .gridline { stroke: var(--divider-color); stroke-width: 1; }
  .baseline { stroke: var(--secondary-text-color); stroke-width: 1; opacity: 0.6; }
  .cross { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 3 3; }
  .cross-dot { stroke: var(--card-background-color, #fff); stroke-width: 2; }

  .tip { position: absolute; display: none; z-index: 10; pointer-events: none; min-width: 150px; max-width: 240px;
    padding: 8px 10px; border-radius: 8px; font-size: 0.78rem; line-height: 1.5;
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    box-shadow: 0 4px 16px rgba(0,0,0,0.25); border: 1px solid var(--divider-color); }
  .tip strong { font-weight: 600; }
  .tip-row { display: flex; justify-content: space-between; gap: 12px; }
  .tip-row span:first-child { color: var(--secondary-text-color); }
  .tip-row span:last-child { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; }
  .tip ha-icon { --mdc-icon-size: 14px; }
  .rule { display: none; }
  .narrow .row { grid-template-columns: minmax(40px, auto) 1fr 40px 18px; }
  .narrow .row-label { display: none; }
  .narrow .lc-title { font-size: 1.35rem; margin-top: -1px; }
  .narrow .lc-top .lc-cap, .narrow .lc-bottom .lc-cap { width: 24px; }
  .narrow .lc-block { min-height: 54px; padding: 4px 6px; }
  .narrow .lc-value { font-size: 1.15rem; }
  .narrow .lc-block.small .lc-value { font-size: 0.85rem; }
  .narrow .lc-main { padding-left: 12px; }
  .narrow .lc-code { font-size: 0.7rem; }

  /* ----- LCARS style ----------------------------------------------------- */
  ha-card.lcars {
    --lc-orange: #ff9c3c; --lc-peach: #ffcc99; --lc-lavender: #cc99cc; --lc-violet: #9977dd; --lc-blue: #99aaff;
    --primary-text-color: var(--lc-peach); --secondary-text-color: var(--lc-lavender);
    --secondary-background-color: #14182c; --divider-color: #2a2f4d; --card-background-color: #000;
    --ha-card-background: #000;
    background: #000; color: var(--lc-peach); border: none;
    font-family: Antonio, "Arial Narrow", "Roboto Condensed", sans-serif;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .lcars .body { padding: 12px; }
  .lc { display: grid; grid-template-columns: var(--side) minmax(0, 1fr); grid-template-rows: 52px auto 34px; }
  .lc-corner { background: var(--lc-orange); border-top-left-radius: 48px 40px; }
  .lc-corner-b { background: var(--lc-orange); border-bottom-left-radius: 48px 34px; }
  .lc-top, .lc-bottom { position: relative; display: flex; gap: 6px; min-width: 0; }
  .lc-top { align-items: flex-start; }
  .lc-bottom { align-items: flex-end; }
  .lc-top .lc-bar { height: 22px; flex: 1 1 24px; background: var(--lc-orange); }
  .lc-bottom .lc-bar { height: 14px; flex: 1 1 24px; background: var(--lc-orange); }
  .lc-top::before, .lc-bottom::before { content: ""; position: absolute; left: 0; width: 26px; height: 26px; }
  .lc-top::before { top: 22px; background: radial-gradient(circle at 100% 100%, transparent 25.5px, var(--lc-orange) 26px); }
  .lc-bottom::before { bottom: 14px; background: radial-gradient(circle at 100% 0, transparent 25.5px, var(--lc-orange) 26px); }
  .lc-title { margin: -5px 0 0; padding: 0 4px; font-size: 2rem; line-height: 1; font-weight: 400; color: var(--lc-orange);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .lc-top .lc-cap { width: 44px; height: 22px; flex: none; background: var(--lc-lavender); border-radius: 0 11px 11px 0; }
  .lc-bottom .lc-cap { width: 44px; height: 14px; flex: none; background: var(--lc-blue); border-radius: 0 7px 7px 0; }
  .lc-code { font-size: 0.8rem; line-height: 1; color: var(--lc-lavender); white-space: nowrap; margin-bottom: -2px; }
  .lc-side { display: flex; flex-direction: column; gap: 4px; padding: 4px 0; }
  .lc-block { display: flex; flex-direction: column; align-items: flex-end; justify-content: flex-end; min-height: 62px;
    padding: 4px 8px; color: #000; box-sizing: border-box; }
  .lc-label { font-size: 0.7rem; line-height: 1.1; text-align: right; }
  .lc-value { font-size: 1.6rem; line-height: 1.05; font-weight: 700; text-align: right; }
  .lc-block.small .lc-value { font-size: 1.05rem; }
  .lc-fill { flex: 1; min-height: 24px; }
  .lc-main { padding: 6px 2px 10px 18px; min-width: 0; }

  .lcars .sub, .lcars .string-head { display: flex; align-items: center; gap: 8px; font-weight: 400; }
  .lcars .sub { margin: 14px 0 8px; font-size: 1.05rem; color: var(--lc-orange); }
  .lcars .lc-main > .sub:first-child { margin-top: 2px; }
  .lcars .sub::after { content: ""; flex: 1; height: 10px; border-radius: 5px; background: var(--lc-violet); }
  .lcars .string-head { justify-content: flex-start; font-size: 0.95rem; color: var(--lc-peach); }
  .lcars .string-head .rule { display: block; flex: 1; height: 6px; border-radius: 3px; background: var(--lc-blue); opacity: 0.8; }
  .lcars .map { margin-top: 16px; }

  .lcars .grid { grid-template-columns: repeat(auto-fill, minmax(74px, 1fr)); gap: 6px; }
  .lcars .tile { aspect-ratio: auto; min-height: 46px; border-radius: 23px; padding: 3px 14px 4px 8px;
    align-items: flex-end; justify-content: flex-end; background-image: none; background-color: #14182c; color: var(--lc-lavender); }
  .lcars .tile .name { font-size: 0.72rem; line-height: 1; }
  .lcars .tile .watts { font-size: 1.1rem; line-height: 1.05; font-weight: 700; }
  .lcars .tile .state { font-size: 0.66rem; font-weight: 700; line-height: 1.05; text-align: right; overflow-wrap: anywhere; }
  .lcars .tile.problem { box-shadow: none; color: #000 !important; }
  .lcars .tile.problem .watts, .lcars .tile .badge { display: none; }
  .lcars .tile:hover, .lcars .tile:focus-visible { box-shadow: 0 0 0 2px var(--lc-peach); }
  .lcars .tile.ring-critical, .lcars .lc-block.alert { animation: lc-alert 1.6s ease-in-out infinite; }
  @keyframes lc-alert { 50% { filter: brightness(0.75) saturate(1.3); } }
  @media (prefers-reduced-motion: reduce) {
    .lcars .tile.ring-critical, .lcars .lc-block.alert { animation: none; }
  }

  .lcars .legend { font-size: 0.75rem; }
  .lcars .row { font-size: 0.9rem; }
  .lcars .track .fill { border-radius: 0 5px 5px 0; }
  .lcars .track .ref { background: var(--lc-orange); opacity: 1; }
  .lcars .note, .lcars .muted { color: var(--lc-lavender); }
  .lcars .axis { font-size: 11px; letter-spacing: 0.04em; }
  .lcars .tip { background: #000; border: 2px solid var(--lc-orange); border-radius: 0 14px 14px 0; box-shadow: none; }
  .lcars .tip strong { color: var(--lc-orange); font-weight: 400; }
  .lcars .chart.placeholder { color: var(--lc-lavender); }
`;

customElements.define("solaredge-optimizers-card", SolarEdgeOptimizersCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "solaredge-optimizers-card",
  name: "SolarEdge Optimizers",
  description: "Panel map, health and today's output for every SolarEdge optimizer.",
  preview: true,
  documentationURL: "https://github.com/SharperThanThou/SolarEdge-Optimizers-Card",
});

console.info(`%c SOLAREDGE-OPTIMIZERS-CARD %c ${VERSION} `, "color:#fff;background:#256abf;font-weight:600", "color:#256abf;background:#fff");
