/**
 * SolarEdge Optimizers card for Home Assistant.
 *
 * Finds every optimizer from the SolarEdge Optimizers integration on its own
 * and shows them as a panel map grouped by string, coloured by power, with
 * health problems marked. A day navigator shows any recorded day: energy per
 * optimizer, per string and for the site, worked out from Home Assistant's
 * power statistics, plus the day's output curve and the optimizers that
 * produced least compared with their peers.
 *
 * https://github.com/SharperThanThou/SolarEdge-Optimizers-Card
 */

const VERSION = "0.1.0";
const DOMAIN = "solaredge_optimizers";
const STATS_REFRESH_MS = 5 * 60 * 1000;

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

function formatEnergy(wh) {
  if (wh === null || wh === undefined) return "–";
  const kwh = wh / 1000;
  const digits = kwh >= 100 ? 0 : kwh >= 10 ? 1 : 2;
  return `${kwh.toFixed(digits)} kWh`;
}

const FORECAST_DOMAIN = "forecast_solar";
const SETUP_FORECAST_URL = "https://my.home-assistant.io/redirect/config_flow_start/?domain=forecast_solar";

/** An energy sensor's state in Wh, whatever unit it's displayed in. */
function energyWh(state) {
  const value = num(state);
  if (value === null) return null;
  const unit = state.attributes?.unit_of_measurement;
  return unit === "kWh" ? value * 1000 : unit === "MWh" ? value * 1e6 : value;
}

/**
 * The AC rating in W encoded in a SolarEdge inverter model, such as
 * SE11400H-US -> 11400 or SE10K-RWS -> 10000. Null if it can't be read.
 */
function inverterRating(model) {
  const match = /SE\s?-?(\d+(?:[.,]\d+)?)\s*(K)?/i.exec(model || "");
  if (!match) return null;
  const value = parseFloat(match[1].replace(",", "."));
  if (match[2]) return value * 1000;
  return value >= 1000 ? value : null;
}

const pct = (value) => (value === null || value === undefined || !Number.isFinite(value) ? "–" : `${Math.round(value)}%`);

// "25.0 kWh" -> "25.0<small> kWh</small>", for big figures.
const smallUnit = (text) => String(text).replace(/^(\S+)\s+([kM]?Wh?)$/, "$1<small> $2</small>");

const toMs = (value) => (typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value));

const isoDay = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const startOfDay = (date) => {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
};

const addDays = (date, days) => {
  const day = new Date(date);
  day.setDate(day.getDate() + days);
  return startOfDay(day);
};

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Forecast.Solar entries by config entry ID, with their useful entities. */
function discoverForecasts(hass) {
  const forecasts = new Map();
  for (const entry of Object.values(hass.entities || {})) {
    if (entry.platform !== FORECAST_DOMAIN || !entry.device_id) continue;
    const entryId = hass.devices?.[entry.device_id]?.config_entries?.[0] || entry.device_id;
    if (!forecasts.has(entryId)) forecasts.set(entryId, { entryId, deviceId: entry.device_id });
    const forecast = forecasts.get(entryId);
    if (entry.translation_key === "energy_production_today") forecast.today = entry.entity_id;
    if (entry.translation_key === "energy_production_today_remaining") forecast.remaining = entry.entity_id;
    if (entry.translation_key === "power_production_now") forecast.power = entry.entity_id;
  }
  return forecasts;
}

/** Forecast.Solar entry titles. Every entry's device has the same name, so
 * the title the user gave the entry is the only way to tell them apart. */
async function loadForecastTitles(hass) {
  try {
    const entries = await hass.callWS({ type: "config_entries/get", domain: FORECAST_DOMAIN });
    return new Map(entries.map((e) => [e.entry_id, e.title]));
  } catch (err) {
    return new Map();
  }
}

/** String names reported by the optimizers' health sensors. */
function discoverStrings(hass) {
  const names = new Set();
  for (const entry of Object.values(hass.entities || {})) {
    if (entry.platform !== DOMAIN || entry.translation_key !== "health") continue;
    const name = hass.states[entry.entity_id]?.attributes.string;
    if (name) names.add(String(name));
  }
  return [...names].sort(naturalCompare);
}

class SolarEdgeOptimizersCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._optimizers = [];
    this._sites = [];
    this._days = new Map();
    this._day = null; // null means today
    this._width = 0;
  }

  static getStubConfig() {
    return {};
  }

  static getConfigElement() {
    return document.createElement("solaredge-optimizers-card-editor");
  }

  setConfig(config) {
    this._config = {
      title: "Solar optimizers",
      show_history: true,
      show_weakest: 5,
      style: "default",
      lcars_font: true,
      forecast: true,
      forecast_strings: {},
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
    this._ensureDayData();
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
    this._clock = setInterval(() => {
      this._ensureDayData();
      this._schedule();
    }, 60 * 1000);
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
        inverterId: this._hass.devices?.[deviceId]?.via_device_id || null,
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
    this._forecasts = discoverForecasts(hass);
    this._entityIds = this._optimizers.flatMap((o) => [o.health, o.power, o.ratio, o.last]).filter(Boolean);
    this._entityIds.push(...this._sites.flatMap((s) => [s.problem, s.latest]).filter(Boolean));
    this._entityIds.push(...[...this._forecasts.values()].flatMap((f) => [f.today, f.remaining]).filter(Boolean));
    this._signature = null;
    this._days = new Map();
    this._loadForecastTitles();
  }

  async _loadForecastTitles() {
    if (!this._forecasts.size) return;
    this._forecastTitles = await loadForecastTitles(this._hass);
    this._schedule();
  }

  /** Which Forecast.Solar entries feed the site total and each string. */
  _forecastPlan() {
    const entries = this._forecasts || new Map();
    const available = entries.size > 0;
    if (this._config.forecast === false || !available) return { enabled: false, available, site: [], byString: new Map() };
    const titles = this._forecastTitles || new Map();
    const resolve = (value) => {
      if (!value) return null;
      if (entries.has(value)) return value;
      const want = String(value).trim().toLowerCase();
      for (const [id, title] of titles) if (entries.has(id) && title.trim().toLowerCase() === want) return id;
      return null;
    };
    const byString = new Map();
    for (const [name, value] of Object.entries(this._config.forecast_strings || {})) {
      const id = resolve(value);
      if (id) byString.set(String(name), id);
    }
    // Without a mapping, assume every Forecast.Solar entry describes this site.
    const site = byString.size ? [...new Set(byString.values())] : [...entries.keys()];
    return { enabled: true, available, site, byString };
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

  // ----- days and statistics ---------------------------------------------

  /** Midnight at the start of the selected day. */
  _selectedDay() {
    const today = startOfDay(new Date());
    if (!this._day || this._day >= today) return today;
    return this._day;
  }

  _isToday() {
    return this._selectedDay().getTime() === startOfDay(new Date()).getTime();
  }

  _setDay(day) {
    const today = startOfDay(new Date());
    this._day = day && day < today ? startOfDay(day) : null;
    this._hideTip();
    this._ensureDayData();
    this._schedule();
  }

  _ensureDayData() {
    if (!this._hass || !this._optimizers.length) return;
    const day = this._selectedDay();
    const key = isoDay(day);
    const cached = this._days.get(key);
    const today = this._isToday();
    if (cached?.loading) return;
    if (cached && (!today || Date.now() - cached.fetchedAt < STATS_REFRESH_MS)) return;
    this._loadDay(key, day, today, cached);
  }

  async _loadDay(key, day, today, previous) {
    const optimizerIds = this._optimizers.map((o) => o.power).filter(Boolean);
    if (!optimizerIds.length) return;
    const forecastIds = [...(this._forecasts?.values() || [])].map((f) => f.power).filter(Boolean);
    const ids = [...optimizerIds, ...forecastIds];
    this._days.set(key, { ...(previous || {}), loading: true });
    const start = day;
    const end = today ? new Date() : addDays(day, 1);
    let data;
    try {
      let period = "5minute";
      let result = await this._fetchStats(ids, start, end, period);
      if (!Object.values(result).some((rows) => rows?.length)) {
        // Five-minute statistics are purged with the recorder's history;
        // hourly ones are kept long term.
        period = "hour";
        result = await this._fetchStats(ids, start, end, period);
      }
      data = this._summariseStats(result, ids, period, new Set(optimizerIds));
      if (today && forecastIds.length) {
        // The full curve for the rest of today is only offered for forecast
        // entries that are linked to solar panels in the Energy dashboard.
        data.solar = await this._hass.callWS({ type: "energy/solar_forecast" }).catch(() => null);
      }
    } catch (err) {
      console.warn("solaredge-optimizers-card: statistics unavailable", err);
      data = { error: true, perEntity: new Map(), curve: [], period: null, lastEnd: start.getTime() };
    }
    this._days.set(key, { ...data, day: start.getTime(), fetchedAt: Date.now(), loading: false });
    this._schedule();
  }

  _fetchStats(ids, start, end, period) {
    return this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: ids,
      period,
      types: ["mean", "max"],
      units: { power: "W" },
    });
  }

  _summariseStats(result, ids, period, optimizerIds) {
    const perEntity = new Map();
    const totals = new Map();
    let lastEnd = 0;
    for (const id of ids) {
      const series = new Map();
      let energy = 0;
      let peak = 0;
      let rows = 0;
      for (const row of result[id] || []) {
        const start = toMs(row.start);
        const end = row.end !== undefined ? toMs(row.end) : start + (period === "hour" ? 3600000 : 300000);
        const mean = Number(row.mean);
        if (!Number.isFinite(start) || !Number.isFinite(mean)) continue;
        energy += (Math.max(mean, 0) * (end - start)) / 3600000;
        peak = Math.max(peak, Number(row.max) || mean);
        series.set(start, mean);
        if (optimizerIds.has(id)) {
          totals.set(start, (totals.get(start) || 0) + mean);
          lastEnd = Math.max(lastEnd, end);
        }
        rows += 1;
      }
      perEntity.set(id, rows ? { energy, peak, series } : null);
    }
    const curve = [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }));
    return { perEntity, curve, period, lastEnd };
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
    const today = this._isToday();
    const day = this._selectedDay();
    const stats = this._days.get(isoDay(day));
    const ready = Boolean(stats && stats.perEntity);
    const now = Date.now();

    const items = this._optimizers.map((o) => {
      const health = states[o.health];
      const status = today && health?.state in STATUS ? health.state : "unknown";
      const last = states[o.last]?.state;
      const watts = num(states[o.power]);
      const stat = ready ? stats.perEntity.get(o.power) : undefined;
      let energy = ready ? (stat ? stat.energy : 0) : null;
      if (today && ready && watts) {
        // Statistics trail by up to ten minutes; fill the gap with the
        // current reading, but never more than 20 minutes of it.
        const gap = Math.min(Math.max(now - (stats.lastEnd || now), 0), 20 * 60000);
        energy += (watts * gap) / 3600000;
      }
      return {
        ...o,
        status,
        statusLabel: health && this._hass.formatEntityState ? this._hass.formatEntityState(health) : STATUS[status].label,
        string: health?.attributes.string || "Unassigned",
        watts,
        energy,
        peak: stat?.peak ?? null,
        series: stat?.series,
        ratio: today ? num(states[o.ratio]) : null,
        volts: num(states[o.voltage]),
        lastAt: last ? new Date(last) : null,
      };
    });

    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.string)) groups.set(item.string, []);
      groups.get(item.string).push(item);
    }
    const strings = [...groups.entries()]
      .sort(([a], [b]) => naturalCompare(a, b))
      .map(([name, list]) => {
        const totals = new Map();
        for (const item of list) {
          for (const [t, v] of item.series || []) totals.set(t, (totals.get(t) || 0) + v);
        }
        return {
          name,
          list,
          inverterId: list[0]?.inverterId || null,
          watts: list.reduce((sum, i) => sum + (i.watts || 0), 0),
          energy: ready ? list.reduce((sum, i) => sum + (i.energy || 0), 0) : null,
          peak: totals.size ? Math.max(...totals.values()) : null,
        };
      });

    // Energy as a share of the median of the rest of the string, for past days.
    for (const group of strings) {
      for (const item of group.list) {
        const others = group.list.filter((o) => o !== item && o.energy !== null).map((o) => o.energy);
        const pool = others.length >= 2 ? others : items.filter((o) => o !== item && o.energy !== null).map((o) => o.energy);
        const med = median(pool);
        item.energyRatio = item.energy !== null && med ? (item.energy / med) * 100 : null;
      }
    }

    const energy = ready ? items.reduce((sum, i) => sum + (i.energy || 0), 0) : null;
    const plan = this._forecastPlan();
    const forecast = plan.enabled ? this._forecastModel(plan, { today, day, stats, ready, strings, energy }) : null;

    const curve = ready ? [...stats.curve] : null;
    if (curve && today) curve.push({ t: now, v: items.reduce((sum, i) => sum + (i.watts || 0), 0) });
    const scaleMax = today
      ? Math.max(this._config.max_power || 0, ...items.map((i) => i.watts || 0))
      : Math.max(...items.map((i) => i.energy || 0));
    const latest = items.reduce((acc, i) => (i.lastAt && (!acc || i.lastAt > acc) ? i.lastAt : acc), null);
    return {
      today,
      day,
      ready,
      error: Boolean(stats?.error),
      period: stats?.period,
      items,
      strings,
      scaleMax,
      latest,
      curve,
      energy,
      plan,
      forecast,
      peak: curve && curve.length ? Math.max(...curve.map((p) => p.v)) : null,
    };
  }

  _forecastModel(plan, { today, day, stats, ready, strings, energy }) {
    const states = this._hass.states;
    const now = Date.now();
    const dayStart = day.getTime();
    const dayEnd = addDays(day, 1).getTime();
    const solar = stats?.solar;
    // The full curve for today, if the Energy dashboard offers it.
    const full = Boolean(today && solar && plan.site.every((id) => solar[id]?.wh_hours));
    const step = full || stats?.period === "hour" ? 3600000 : 300000;

    // Each entry's forecast through the day: period start -> mean W.
    const series = new Map();
    for (const id of plan.site) {
      const points = new Map();
      if (full) {
        // Hourly energy in Wh is also the hour's mean power in W.
        for (const [iso, wh] of Object.entries(solar[id].wh_hours)) {
          const t = Date.parse(iso);
          if (t >= dayStart && t < dayEnd) points.set(t, wh);
        }
      } else if (ready) {
        const power = this._forecasts.get(id)?.power;
        for (const [t, v] of stats.perEntity.get(power)?.series || []) points.set(t, v);
      }
      series.set(id, points);
    }

    // Each Forecast.Solar entry only knows its own panels, but strings on one
    // inverter share its AC limit. Cap their combined forecast at that limit
    // and scale each entry down in proportion.
    const groups = this._inverterGroups(plan, strings);
    const capped = new Map(plan.site.map((id) => [id, new Map(series.get(id))]));
    let clipping = false;
    for (const group of groups) {
      if (!group.limit) continue;
      const times = new Set(group.ids.flatMap((id) => [...series.get(id).keys()]));
      for (const t of times) {
        const sum = group.ids.reduce((acc, id) => acc + (series.get(id).get(t) || 0), 0);
        if (sum <= group.limit) continue;
        clipping = true;
        const factor = group.limit / sum;
        for (const id of group.ids) {
          const v = series.get(id).get(t);
          if (v !== undefined) capped.get(id).set(t, v * factor);
        }
      }
    }
    const integrate = (points, until = Infinity) => {
      let wh = 0;
      for (const [t, v] of points) {
        if (t >= until) continue;
        wh += (v * (Math.min(t + step, until) - t)) / 3600000;
      }
      return wh;
    };

    const figures = (entryId) => {
      const f = this._forecasts.get(entryId);
      if (!f) return null;
      const raw = series.get(entryId);
      const cap = capped.get(entryId);
      if (today && full) return { total: integrate(cap), expected: integrate(cap, now) };
      if (today) {
        // The sensors give the uncapped day; take off what the cap removed
        // from the part of today that's been recorded.
        const total = energyWh(states[f.today]);
        const remaining = energyWh(states[f.remaining]);
        if (total === null) return { total: null, expected: null };
        const lost = integrate(raw, now) - integrate(cap, now);
        return { total: total - lost, expected: remaining === null ? null : Math.max(total - remaining - lost, 0) };
      }
      // Earlier days: add up the recorded forecast power, the same way
      // actual energy is worked out.
      return { total: ready && raw.size ? integrate(cap) : null, expected: null };
    };
    const combine = (ids) => {
      const figs = ids.map(figures).filter(Boolean);
      if (!figs.length || figs.some((f) => f.total === null)) return { total: null, expected: null };
      return {
        total: figs.reduce((sum, f) => sum + f.total, 0),
        expected: figs.every((f) => f.expected !== null) ? figs.reduce((sum, f) => sum + f.expected, 0) : null,
      };
    };
    // Today compares with what the forecast expected by now, earlier days
    // with the whole day's forecast. Ignore tiny bases around sunrise.
    const withRatio = (fig, actual) => {
      const base = today ? fig.expected : fig.total;
      return { ...fig, ratio: actual !== null && base !== null && base > 50 ? (actual / base) * 100 : null };
    };
    const site = withRatio(combine(plan.site), energy);
    for (const group of strings) {
      const id = plan.byString.get(group.name);
      group.forecast = id ? withRatio(combine([id]), group.energy) : null;
      group.forecastTitle = id ? this._forecastTitles?.get(id) : null;
    }

    const totals = new Map();
    for (const id of plan.site) for (const [t, v] of capped.get(id)) totals.set(t, (totals.get(t) || 0) + v);
    const curve = totals.size
      ? { points: [...totals.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })), step, full }
      : null;
    const limited = groups.filter((g) => g.limit);
    return {
      site,
      curve,
      groups,
      clipping,
      // Without the full curve, today's cap only covers what's been recorded.
      partialCap: today && !full && limited.length > 0,
      limit: limited.length === 1 && groups.length === 1 ? limited[0].limit : null,
    };
  }

  /** Forecast entries grouped by the inverter their strings are wired to. */
  _inverterGroups(plan, strings) {
    const override = this._config.inverter_power;
    const limitFor = (inverterId) => {
      const device = this._hass.devices?.[inverterId];
      const name = device?.name_by_user || device?.name || "Inverter";
      if (override && typeof override === "object") {
        const value = Number(override[name] ?? override[inverterId]);
        if (value > 0) return { name, limit: value, source: "setting" };
      } else if (Number(override) > 0) {
        return { name, limit: Number(override), source: "setting" };
      }
      const rating = inverterRating(device?.model);
      return { name, limit: rating, source: rating ? device.model : null };
    };
    const groups = new Map();
    const add = (inverterId, entryId) => {
      if (!groups.has(inverterId)) groups.set(inverterId, { inverterId, ...limitFor(inverterId), ids: [] });
      groups.get(inverterId).ids.push(entryId);
    };
    if (plan.byString.size) {
      const placed = new Set();
      for (const group of strings) {
        const id = plan.byString.get(group.name);
        if (!id || placed.has(id)) continue;
        placed.add(id);
        add(group.inverterId || "unknown", id);
      }
      return [...groups.values()];
    }
    // No mapping: every entry is assumed to cover the whole site.
    const inverters = [...new Set(strings.map((g) => g.inverterId).filter(Boolean))];
    if (inverters.length === 1) {
      for (const id of plan.site) add(inverters[0], id);
      return [...groups.values()];
    }
    const parts = inverters.map(limitFor);
    const limit = parts.length && parts.every((p) => p.limit) ? parts.reduce((sum, p) => sum + p.limit, 0) : null;
    return [{ inverterId: "all", name: "All inverters", limit, source: limit ? "combined" : null, ids: [...plan.site] }];
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (this.shadowRoot.activeElement?.classList?.contains("nav-date")) {
      // Re-rendering would close the date picker; try again once it's done.
      this._deferred = true;
      return;
    }
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
        if ((ev.key === "Enter" || ev.key === " ") && !ev.target.closest?.("button, input")) this._click(ev);
      });
      this._shell.addEventListener("change", (ev) => {
        if (!ev.target.classList?.contains("nav-date") || !ev.target.value) return;
        const [y, m, d] = ev.target.value.split("-").map(Number);
        ev.target.blur();
        this._setDay(new Date(y, m - 1, d));
      });
      this._shell.addEventListener("focusout", () => {
        if (this._deferred) {
          this._deferred = false;
          this._schedule();
        }
      });
    }
    this._model_ = model;
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
    const forecastStroke = dark ? "#d95926" : "#eb6834";
    this._shell.innerHTML = [
      `<div class="head">${this._config.title ? `<h1 class="title">${esc(this._config.title)}</h1>` : ""}${this._renderNav(model)}</div>`,
      this._renderStats(model),
      this._renderForecastNote(model),
      this._config.show_history ? this._renderHistory(model, stroke, forecastStroke, this._width - 32) : "",
      this._renderMap(model, ramp),
      this._renderWeakest(model, ramp),
    ].join("");
  }

  _dayLabel(model, long = false) {
    if (model.today) return "Today";
    if (model.day.getTime() === addDays(startOfDay(new Date()), -1).getTime()) return "Yesterday";
    return model.day.toLocaleDateString(undefined, long
      ? { weekday: "long", day: "numeric", month: "long", year: "numeric" }
      : { weekday: "short", day: "numeric", month: "short" });
  }

  _renderNav(model) {
    const today = isoDay(startOfDay(new Date()));
    return `<div class="nav" role="group" aria-label="Day">
      <button class="nav-btn" data-nav="prev" aria-label="Previous day">‹</button>
      <input class="nav-date" type="date" value="${isoDay(model.day)}" max="${today}" aria-label="Day to show">
      <button class="nav-btn" data-nav="next" aria-label="Next day" ${model.today ? "disabled" : ""}>›</button>
      <button class="nav-btn nav-today" data-nav="today" ${model.today ? "disabled" : ""}>Today</button>
    </div>`;
  }

  _summary({ items, latest }) {
    const problems = items.filter((i) => STATUS[i.status].problem);
    return {
      total: items.reduce((sum, i) => sum + (i.watts || 0), 0),
      producing: items.filter((i) => (i.watts || 0) > 0).length,
      produced: items.filter((i) => (i.energy || 0) > 0).length,
      problems,
      tone: problems.length ? (problems.some((p) => STATUS[p.status].tone === "critical") ? "critical" : "serious") : "good",
      latest,
    };
  }

  /** The forecast figure for the summary, or null when it's switched off. */
  _forecastSummary(model) {
    const { plan, forecast } = model;
    if (this._config.forecast === false) return null;
    if (!plan.available) return { label: "Forecast", value: "Set up", sub: "Needs internet" };
    const site = forecast?.site;
    const value = site?.total === null || site?.total === undefined ? "–" : formatEnergy(site.total);
    const sub = site?.ratio === null || site?.ratio === undefined
      ? ""
      : model.today ? `${pct(site.ratio)} of expected` : `Actual ${pct(site.ratio)}`;
    return { label: "Forecast", value, sub };
  }

  _renderForecastNote(model) {
    if (!this._noteOpen || this._config.forecast === false) return "";
    const close = `<button class="note-close" data-action="forecast" aria-label="Close">×</button>`;
    if (!model.plan.available) {
      return `<div class="note-panel" role="note">${close}
        <strong>Predicted generation needs an internet connection.</strong>
        <p>It comes from Home Assistant's Forecast.Solar integration, which downloads a forecast from
        forecast.solar using your location and the tilt, direction and size of your panels. This card doesn't
        contact anything itself.</p>
        <p>Add Forecast.Solar once for each roof face, rename each entry after its roof face (for example
        "South roof"), then choose which entry belongs to each string in this card's settings. The card's
        README has step-by-step instructions.</p>
        <p><a href="${SETUP_FORECAST_URL}" target="_blank" rel="noreferrer">Set up Forecast.Solar</a></p>
      </div>`;
    }
    const titles = this._forecastTitles || new Map();
    const name = (id) => esc(titles.get(id) || "an unnamed Forecast.Solar entry");
    const mapped = model.strings.filter((g) => model.plan.byString.has(g.name));
    const mapping = mapped.length
      ? `<ul>${mapped.map((g) => `<li>${esc(this._stringTitle(g.name, model.strings.length))} → ${name(model.plan.byString.get(g.name))}</li>`).join("")}</ul>`
      : `<p>No strings are matched to a forecast yet, so the site forecast adds up all ${model.plan.site.length}
         Forecast.Solar ${model.plan.site.length === 1 ? "entry" : "entries"}. Match each string in this card's settings
         to see a forecast per string.</p>`;
    const watts = (w) => `${Math.round(w).toLocaleString()} W`;
    const groups = model.forecast?.groups || [];
    const limitText = groups
      .map((g) => {
        if (!g.limit) {
          return `<p>${esc(g.name)}: its AC rating couldn't be read from its model, so the forecast isn't capped. Set
            <em>Inverter AC limit</em> in this card's settings if the panels can produce more than the inverter.</p>`;
        }
        const from = g.source === "setting" ? "from this card's settings"
          : g.source === "combined" ? "the inverters' ratings added up" : `read from its model, ${esc(g.source)}`;
        return `<p>Capped at ${esc(g.name)}'s ${watts(g.limit)} (${from}): the panels on it can't deliver more than
          the inverter, so their combined forecast is limited to that and each string's share is scaled down to match.</p>`;
      })
      .join("");
    const partial = model.forecast?.partialCap
      ? `<p>Today the cap only covers the part of the day already recorded, so today's forecast total can be a little
         high on days the inverter limits output. Linking the entries in the Energy dashboard (README step 5) lets the
         card cap the whole day.</p>`
      : "";
    const hint = model.today && model.forecast && !model.forecast.curve?.full
      ? `<p>To see the rest of today's forecast on the chart, add the Forecast.Solar entries to your solar
         panels in the Energy dashboard settings.</p>`
      : "";
    return `<div class="note-panel" role="note">${close}
      <strong>Predicted generation from Forecast.Solar</strong>
      <p>Downloaded by Home Assistant over the internet, based on each Forecast.Solar entry's location, tilt,
      direction and size. Today's percentage compares the energy produced so far with what the forecast expected
      by now; for an earlier day it compares the whole day.</p>
      ${mapping}${limitText}${partial}${hint}
    </div>`;
  }

  _energyText(model) {
    if (model.error) return "–";
    return model.ready ? formatEnergy(model.energy) : "…";
  }

  _renderLcars(model, ramp) {
    const sum = this._summary(model);
    const side = this._width && this._width < 520 ? 70 : 124;
    const alert = sum.problems.length ? `background:${TONE[sum.tone]}` : `background:${LCARS.blue}`;
    const block = (label, value, style, cls = "") =>
      `<div class="lc-block ${cls}" style="${style}"><span class="lc-label">${label}</span><span class="lc-value">${smallUnit(value)}</span></div>`;
    const fc = this._forecastSummary(model);
    const fcBlock = fc
      ? `<div class="lc-block forecast" style="background:${LCARS.blue}" data-action="forecast" tabindex="0" role="button"
           aria-expanded="${Boolean(this._noteOpen)}">
           <span class="lc-label">${fc.label}</span><span class="lc-value">${smallUnit(fc.value)}</span>
           ${fc.sub ? `<span class="lc-sub">${esc(fc.sub)}</span>` : ""}</div>`
      : "";
    const blocks = model.today
      ? [
          block("Energy today", this._energyText(model), `background:${LCARS.orange}`, "lead"),
          fcBlock,
          block("Output now", formatPower(sum.total), `background:${LCARS.lavender}`),
          block("Producing", `${sum.producing}/${model.items.length}`, `background:${LCARS.peach}`),
          block("Problems", sum.problems.length, alert, sum.tone === "critical" ? "alert" : ""),
          block("Last report", relativeTime(sum.latest), `background:${LCARS.tan}`, "small"),
        ]
      : [
          block(`Energy · ${esc(this._dayLabel(model))}`, this._energyText(model), `background:${LCARS.orange}`, "lead"),
          fcBlock,
          block("Peak output", model.peak === null ? "–" : formatPower(model.peak), `background:${LCARS.lavender}`),
          block("Produced", model.ready ? `${sum.produced}/${model.items.length}` : "…", `background:${LCARS.peach}`),
        ];
    return `<div class="lc" style="--side:${side}px">
      <div class="lc-corner"></div>
      <div class="lc-top"><span class="lc-bar"></span>${this._config.title ? `<h1 class="lc-title">${esc(this._config.title)}</h1>` : ""}<span class="lc-cap"></span></div>
      <div class="lc-side">
        ${blocks.join("")}
        <div class="lc-block lc-fill" style="background:${LCARS.violet}"></div>
      </div>
      <div class="lc-main">
        ${this._renderNav(model)}
        ${this._renderForecastNote(model)}
        ${this._config.show_history ? this._renderHistory(model, LCARS.orange, LCARS.lavender, this._width - side - 46) : ""}
        ${this._renderMap(model, ramp)}
        ${this._renderWeakest(model, ramp)}
      </div>
      <div class="lc-corner-b"></div>
      <div class="lc-bottom"><span class="lc-bar"></span>
        <span class="lc-code">${esc(this._dayLabel(model, true))} · ${model.items.length} optimizers · ${model.strings.length} ${model.strings.length === 1 ? "string" : "strings"}</span>
        <span class="lc-cap"></span></div>
    </div>`;
  }

  _renderStats(model) {
    const { total, producing, produced, problems, tone: problemTone, latest } = this._summary(model);
    const n = model.items.length;
    const stat = (label, value, cls = "") => `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${smallUnit(value)}</div></div>`;
    const fc = this._forecastSummary(model);
    const fcStat = fc
      ? `<div class="stat forecast" data-action="forecast" tabindex="0" role="button" aria-expanded="${Boolean(this._noteOpen)}">
           <div class="label">${fc.label}<ha-icon icon="mdi:information-outline"></ha-icon></div>
           <div class="value">${smallUnit(fc.value)}</div>${fc.sub ? `<div class="sub">${esc(fc.sub)}</div>` : ""}</div>`
      : "";
    const stats = model.today
      ? [
          stat("Energy today", this._energyText(model), "lead"),
          fcStat,
          stat("Output now", formatPower(total)),
          stat("Producing", `${producing}<span class="of"> / ${n}</span>`),
          stat("Problems", `<ha-icon class="tone-${problemTone}" icon="${problems.length ? "mdi:alert-circle" : "mdi:check-circle"}"></ha-icon>${problems.length}`),
          `<div class="stat"><div class="label">Last report</div><div class="value small">${relativeTime(latest)}</div></div>`,
        ]
      : [
          stat(`Energy · ${esc(this._dayLabel(model))}`, this._energyText(model), "lead"),
          fcStat,
          stat("Peak output", model.peak === null ? "–" : formatPower(model.peak)),
          stat("Produced", model.ready ? `${produced}<span class="of"> / ${n}</span>` : "…"),
        ];
    return `<div class="stats">${stats.join("")}</div>`;
  }

  _stringTitle(name, count) {
    if (name === "Unassigned") return count > 1 ? "Not in a string" : "Optimizers";
    return /^string/i.test(name) ? name : `String ${name}`;
  }

  _renderMap(model, ramp) {
    const { strings, scaleMax, today } = model;
    const sections = strings.map((group) => {
      const tiles = group.list.map((item) => {
        const index = this._items.indexOf(item);
        const status = STATUS[item.status];
        const value = today ? item.watts : item.energy;
        const lit = value !== null && value > 0;
        let fill = lit ? rampColor(ramp, value / (scaleMax || 1)) : null;
        if (this._lcars && status.problem) fill = TONE[status.tone];
        const ink = fill ? (isLight(fill) ? "#0b0b0b" : "#ffffff") : null;
        const style = fill ? `background:${fill};color:${ink}` : "";
        const badge = status.problem
          ? `<span class="badge tone-bg-${status.tone}"><ha-icon icon="${status.icon}"></ha-icon></span>`
          : "";
        const energy = item.energy === null ? "–" : (item.energy / 1000).toFixed(2);
        const main = today
          ? `<span class="watts">${item.watts === null ? "–" : Math.round(item.watts)}<small> W</small></span>
             <span class="kwh">${energy}<small> kWh</small></span>`
          : `<span class="watts">${energy}<small> kWh</small></span>`;
        const label = today
          ? `${item.fullName}: ${formatPower(item.watts)} now, ${formatEnergy(item.energy)} today, ${item.statusLabel}`
          : `${item.fullName}: ${formatEnergy(item.energy)}`;
        return `<div class="tile ${lit ? "" : "dim"} ${status.problem ? `problem ring-${status.tone}` : ""} ${today ? "" : "past"}"
            style="${style}" data-index="${index}" tabindex="0" role="button" aria-label="${esc(label)}">
          ${badge}
          <span class="name">${esc(item.name)}</span>
          ${status.problem ? `<span class="state">${esc(item.statusLabel)}</span>` : ""}
          ${main}
        </div>`;
      });
      let figures = today
        ? `<span class="fig"><span class="fig-label">now</span>${formatPower(group.watts)}</span>
           <span class="fig"><span class="fig-label">today</span>${group.energy === null ? "…" : formatEnergy(group.energy)}</span>`
        : `<span class="fig"><span class="fig-label">energy</span>${group.energy === null ? "…" : formatEnergy(group.energy)}</span>
           <span class="fig"><span class="fig-label">peak</span>${group.peak === null ? "–" : formatPower(group.peak)}</span>`;
      if (group.forecast) {
        const total = group.forecast.total === null ? "–" : formatEnergy(group.forecast.total);
        const ratio = group.forecast.ratio === null ? "" : ` · ${pct(group.forecast.ratio)}`;
        figures += `<span class="fig" title="${esc(group.forecastTitle || "Forecast.Solar")}"><span class="fig-label">forecast</span>${total}${ratio}</span>`;
      }
      return `<section class="string">
        <div class="string-head"><span class="string-name">${esc(this._stringTitle(group.name, strings.length))}
          <span class="muted count">${group.list.length}</span></span>
          <span class="rule"></span><span class="figs">${figures}</span></div>
        <div class="grid">${tiles.join("")}</div>
      </section>`;
    });
    const gradient = ramp.map((c, i) => `${c} ${Math.round((i / (ramp.length - 1)) * 100)}%`).join(",");
    const scale = scaleMax > 0
      ? `<span class="scale"><span class="muted">0 ${today ? "W" : "kWh"}</span><span class="bar" style="background:linear-gradient(90deg,${gradient})"></span><span class="muted">${today ? formatPower(scaleMax) : formatEnergy(scaleMax)}</span></span>`
      : "";
    const keys = today
      ? `<span class="key"><span class="dot tone-bg-serious"></span>Low output</span>
         <span class="key"><span class="dot tone-bg-critical"></span>No output / not reporting / safe mode</span>`
      : `<span class="key muted">Shaded by each optimizer's energy for the day.</span>`;
    return `<div class="map">${sections.join("")}</div><div class="legend">${scale}${keys}</div>`;
  }

  _renderWeakest(model, ramp) {
    const count = Number(this._config.show_weakest) || 0;
    if (!count) return "";
    const { items, today } = model;
    const key = today ? "ratio" : "energyRatio";
    const compared = items.filter((i) => i[key] !== null).sort((a, b) => a[key] - b[key]).slice(0, count);
    const head = `<h2 class="sub">${today ? "Lowest output vs peers" : "Lowest energy vs peers"}</h2>`;
    if (!compared.length) {
      const why = today
        ? "Comparisons start once the panels produce enough power to judge."
        : model.ready ? "No recorded energy to compare for this day." : "Loading…";
      return `${head}<p class="muted note">${why}</p>`;
    }
    const scaleMax = Math.max(150, ...compared.map((i) => i[key]));
    const rows = compared.map((item) => {
      const index = this._items.indexOf(item);
      const status = STATUS[item.status];
      const width = Math.max((item[key] / scaleMax) * 100, 0.5);
      const extra = today
        ? status.problem ? `<ha-icon class="tone-${status.tone}" icon="${status.icon}"></ha-icon><span class="row-label">${esc(item.statusLabel)}</span>` : ""
        : `<span class="row-label">${formatEnergy(item.energy)}</span>`;
      return `<div class="row" data-index="${index}" tabindex="0" role="button">
        <span class="row-name">${esc(item.name)}</span>
        <span class="track"><span class="fill" style="width:${width}%;background:${ramp[4]}"></span>
          <span class="ref" style="left:${(100 / scaleMax) * 100}%"></span></span>
        <span class="row-val">${Math.round(item[key])}%</span>
        <span class="row-status">${extra}</span>
      </div>`;
    });
    const note = today
      ? "The tick marks 100%, the median of each optimizer's string."
      : "The tick marks 100%, the median energy of each optimizer's string that day.";
    return `${head}<div class="rows">${rows.join("")}</div><p class="muted note">${note}</p>`;
  }

  _renderHistory(model, stroke, forecastStroke, available) {
    const fcurve = model.forecast?.curve;
    const legend = fcurve
      ? `<span class="chart-legend"><span class="key"><span class="swatch" style="background:${stroke}"></span>Actual</span>
         <span class="key"><span class="swatch dashed" style="border-color:${forecastStroke}"></span>Forecast</span></span>`
      : "";
    const head = `<h2 class="sub">Output · ${esc(this._dayLabel(model))}${legend}</h2>`;
    const points = model.curve;
    if (!points) return `${head}<div class="chart placeholder muted">${model.error ? "Statistics unavailable." : "Loading…"}</div>`;
    if (!points.length || (points.length === 1 && !points[0].v)) {
      return `${head}<div class="chart placeholder muted">No recorded output for this day.</div>`;
    }
    const width = Math.max(available || 0, 220);
    const height = 140;
    const pad = { l: 44, r: 8, t: 8, b: 22 };
    const innerW = width - pad.l - pad.r;
    const innerH = height - pad.t - pad.b;
    const dayStart = model.day.getTime();
    const dayEnd = addDays(model.day, 1).getTime();
    const peak = Math.max(...points.map((p) => p.v));
    const fpoints = fcurve ? fcurve.points.map((p) => ({ t: p.t + fcurve.step / 2, v: p.v })) : [];
    const yMax = niceMax(Math.max(peak, ...fpoints.map((p) => p.v)) * 1.05);
    const step = model.period === "hour" ? 3600000 : 300000;
    // Each statistic covers [t, t + step); plot it at the middle.
    const plotted = points.map((p, i) => ({ t: model.today && i === points.length - 1 ? p.t : p.t + step / 2, v: p.v }));
    const x = (t) => pad.l + ((t - dayStart) / (dayEnd - dayStart)) * innerW;
    const y = (v) => pad.t + innerH - (v / yMax) * innerH;
    const line = plotted.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${line}L${x(plotted.at(-1).t).toFixed(1)},${y(0)}L${x(plotted[0].t).toFixed(1)},${y(0)}Z`;
    const grid = [0, 0.5, 1]
      .map((f) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(yMax * f)}" y2="${y(yMax * f)}" class="${f ? "gridline" : "baseline"}"/>
        <text x="${pad.l - 6}" y="${y(yMax * f) + 4}" text-anchor="end" class="axis">${formatPower(yMax * f)}</text>`)
      .join("");
    const ticks = [0, 6, 12, 18, 24]
      .map((h) => `<text x="${x(dayStart + h * 3600 * 1000)}" y="${height - 6}" text-anchor="middle" class="axis">${String(h % 24).padStart(2, "0")}:00</text>`)
      .join("");
    const fline = fpoints.length
      ? `<path d="${fpoints.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}"
           fill="none" stroke="${forecastStroke}" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>`
      : "";
    const limit = model.forecast?.limit;
    const limitLine = limit && limit < yMax
      ? `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(limit)}" y2="${y(limit)}" class="limit"/>
         <text x="${width - pad.r}" y="${y(limit) - 4}" text-anchor="end" class="axis">Inverter limit</text>`
      : "";
    this._chartGeom = { points: plotted, fpoints, fstep: fcurve?.step, x, y, pad, dayStart, dayEnd, innerW, step };
    const note = model.period === "hour" ? `<p class="muted note">Hourly averages: five-minute detail is no longer kept for this day.</p>` : "";
    return `${head}<div class="chart" data-chart="1">
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Total optimizer output, peak ${formatPower(peak)}">
        ${grid}${ticks}
        <path d="${area}" fill="${stroke}" opacity="0.16"/>
        ${limitLine}${fline}
        <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
        <line class="cross" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + innerH}" visibility="hidden"/>
        <circle class="cross-dot" r="4" fill="${stroke}" visibility="hidden"/>
      </svg></div>${note}`;
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
    const row = (label, value) => `<div class="tip-row"><span>${label}</span><span>${value}</span></div>`;
    const rows = this._model_.today
      ? [
          row("String", esc(item.string)),
          row("Power", formatPower(item.watts)),
          row("Energy today", formatEnergy(item.energy)),
          row("vs peers", item.ratio === null ? "–" : `${Math.round(item.ratio)}%`),
          row("Module", item.volts === null ? "–" : `${item.volts.toFixed(1)} V`),
          row("Health", `${status.problem ? `<ha-icon class="tone-${status.tone}" icon="${status.icon}"></ha-icon>` : ""}${esc(item.statusLabel)}`),
          row("Reported", relativeTime(item.lastAt)),
        ]
      : [
          row("String", esc(item.string)),
          row("Energy", formatEnergy(item.energy)),
          row("Peak", item.peak === null ? "–" : formatPower(item.peak)),
          row("vs peers", item.energyRatio === null ? "–" : `${Math.round(item.energyRatio)}%`),
        ];
    this._showTip(ev, `<strong>${esc(item.fullName)}</strong>${rows.join("")}`);
  }

  _hoverChart(ev, chart) {
    const g = this._chartGeom;
    const svg = chart.querySelector("svg");
    const rect = svg.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = g.dayStart + ((px - g.pad.l) / g.innerW) * (g.dayEnd - g.dayStart);
    const lastT = Math.max(g.points.at(-1).t, g.fpoints.at(-1)?.t ?? 0);
    if (px < g.pad.l || t > lastT + g.step || t < g.dayStart) {
      this._hideTip();
      return;
    }
    const nearest = (pts) => pts.reduce((a, p) => (!a || Math.abs(p.t - t) < Math.abs(a.t - t) ? p : a), null);
    let best = nearest(g.points);
    const fc = g.fpoints.length ? nearest(g.fpoints) : null;
    const actualHere = best && Math.abs(best.t - t) <= g.step;
    if (!actualHere && fc) best = { t: fc.t, v: null };
    const cx = g.x(best.t);
    const cross = svg.querySelector(".cross");
    const dot = svg.querySelector(".cross-dot");
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", g.y(best.v ?? 0));
    dot.setAttribute("visibility", best.v === null ? "hidden" : "visible");
    const time = new Date(best.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const fcHere = fc && Math.abs(fc.t - best.t) <= (g.fstep || g.step) / 2 + 1 ? fc : null;
    this._showTip(ev, `<strong>${time}</strong>
      ${best.v === null ? "" : `<div class="tip-row"><span>Actual</span><span>${formatPower(best.v)}</span></div>`}
      ${fcHere ? `<div class="tip-row"><span>Forecast</span><span>${formatPower(fcHere.v)}</span></div>` : ""}`);
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
    const action = ev.target.closest?.("[data-action]");
    if (action?.dataset.action === "forecast") {
      if (ev.target.closest("a")) return;
      this._noteOpen = !this._noteOpen;
      this._schedule();
      return;
    }
    const nav = ev.target.closest?.("[data-nav]");
    if (nav) {
      if (nav.disabled) return;
      const day = this._selectedDay();
      if (nav.dataset.nav === "prev") this._setDay(addDays(day, -1));
      if (nav.dataset.nav === "next") this._setDay(addDays(day, 1));
      if (nav.dataset.nav === "today") this._setDay(null);
      return;
    }
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
  .head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin-bottom: 12px; }
  .title { margin: 0; font-size: 1.25rem; font-weight: 500; color: var(--primary-text-color); }
  .nav { display: flex; align-items: center; gap: 4px; }
  .nav-btn { font: inherit; font-size: 0.9rem; min-width: 32px; height: 32px; padding: 0 10px; border-radius: 16px; cursor: pointer;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color); }
  .nav-btn[data-nav="prev"], .nav-btn[data-nav="next"] { font-size: 1.2rem; line-height: 1; padding: 0; }
  .nav-btn:disabled { opacity: 0.4; cursor: default; }
  .nav-btn:not(:disabled):hover { border-color: var(--primary-text-color); }
  .nav-date { font: inherit; font-size: 0.9rem; height: 32px; box-sizing: border-box; padding: 0 8px; border-radius: 16px;
    border: 1px solid var(--divider-color); background: var(--secondary-background-color); color: var(--primary-text-color);
    color-scheme: light dark; }
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
  .stat.lead { background: color-mix(in srgb, var(--primary-color) 14%, var(--secondary-background-color)); }
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
  .tile .kwh { font-size: 0.68rem; font-variant-numeric: tabular-nums; opacity: 0.9; margin-top: -4px; white-space: nowrap; }
  .tile .kwh small { font-size: 0.6rem; }
  .tile.past .watts { font-size: 0.95rem; }
  .string-head { align-items: baseline; gap: 8px; }
  .string-name .count { font-size: 0.75rem; margin-left: 4px; }
  .figs { display: inline-flex; gap: 12px; font-variant-numeric: tabular-nums; }
  .fig-label { color: var(--secondary-text-color); margin-right: 4px; font-size: 0.75rem; }
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
  .limit { stroke: var(--secondary-text-color); stroke-width: 1; stroke-dasharray: 1 3; }
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

  .stat.forecast { cursor: pointer; outline: none; }
  .stat.forecast:hover, .stat.forecast:focus-visible { box-shadow: inset 0 0 0 2px var(--divider-color); }
  .stat .label ha-icon { --mdc-icon-size: 14px; margin-left: 4px; vertical-align: -2px; opacity: 0.7; }
  .stat .sub { font-size: 0.75rem; color: var(--secondary-text-color); }
  .note-panel { position: relative; margin: 12px 0 0; padding: 12px 36px 12px 14px; border-radius: 12px; font-size: 0.85rem;
    line-height: 1.45; background: var(--secondary-background-color); color: var(--primary-text-color); }
  .note-panel p { margin: 6px 0 0; }
  .note-panel ul { margin: 6px 0 0; padding-left: 18px; }
  .note-panel a { color: var(--primary-color); font-weight: 500; }
  .note-close { position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; border: none; border-radius: 14px;
    background: transparent; color: var(--secondary-text-color); font-size: 1.2rem; cursor: pointer; }
  .note-close:hover { background: var(--divider-color); }
  .chart-legend { display: inline-flex; gap: 12px; margin-left: 12px; font-size: 0.75rem; font-weight: 400; color: var(--secondary-text-color); }
  .chart-legend .key { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { display: inline-block; width: 16px; height: 2px; border-radius: 1px; }
  .swatch.dashed { height: 0; border-top: 2px dashed; background: none; }
  .narrow .row { grid-template-columns: minmax(40px, auto) 1fr 40px 18px; }
  .narrow .row-label { display: none; }
  .narrow .lc-title { font-size: 1.35rem; margin-top: -1px; }
  .narrow .lc-top .lc-cap, .narrow .lc-bottom .lc-cap { width: 24px; }
  .narrow .lc-block { min-height: 54px; padding: 4px 6px; }
  .narrow .lc-value, .narrow .lc-block.lead .lc-value { font-size: 1.15rem; }
  .narrow .figs { gap: 8px; font-size: 0.8rem; }
  .narrow .string-head .rule { display: none; }
  .narrow .string-head { flex-wrap: wrap; row-gap: 2px; }
  .narrow .figs { flex-basis: 100%; }
  .fig { white-space: nowrap; }
  .nav { flex-wrap: wrap; }
  .narrow .nav-date { flex: 1 1 120px; min-width: 0; }
  .lcars .narrow .nav-btn[data-nav] { width: auto; min-width: 32px; }
  .lcars .narrow .nav-today { padding: 0 10px; }
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
  .lc-block.lead { min-height: 78px; }
  .lc-block.lead .lc-value { font-size: 1.9rem; }
  .lc-value small { font-size: 0.6em; font-weight: 400; }
  .stat .value small { font-size: 0.6em; font-weight: 400; color: var(--secondary-text-color); }
  .lcars .nav { gap: 6px; margin-bottom: 4px; }
  .lcars .nav-btn, .lcars .nav-date { font-family: inherit; text-transform: uppercase; letter-spacing: 0.04em; border: none;
    height: 30px; border-radius: 15px; color: #000; font-weight: 700; }
  .lcars .nav-btn[data-nav="prev"] { background: var(--lc-lavender); border-radius: 15px 4px 4px 15px; width: 44px; }
  .lcars .nav-btn[data-nav="next"] { background: var(--lc-lavender); border-radius: 4px 15px 15px 4px; width: 44px; }
  .lcars .nav-date { background: var(--lc-peach); border-radius: 4px; padding: 0 10px; color-scheme: light; }
  .lcars .nav-today { background: var(--lc-blue); padding: 0 16px; }
  .lcars .nav-btn:not(:disabled):hover { filter: brightness(1.15); }
  .lcars .figs { color: var(--lc-peach); }
  .lcars .fig-label { color: var(--lc-lavender); font-size: 0.75rem; }
  .lcars .tile .kwh { font-size: 0.7rem; margin-top: 0; line-height: 1; }
  .lcars .tile.past .watts { font-size: 1rem; }
  .lc-fill { flex: 1; min-height: 24px; }
  .lc-block.forecast { cursor: pointer; outline: none; }
  .lc-block.forecast:hover, .lc-block.forecast:focus-visible { filter: brightness(1.12); }
  .lc-sub { font-size: 0.68rem; line-height: 1.1; text-align: right; }
  .lcars .note-panel { background: #000; border: 2px solid var(--lc-blue); border-radius: 0 16px 16px 0; color: var(--lc-peach); }
  .lcars .note-panel strong { color: var(--lc-blue); font-weight: 400; }
  .lcars .note-panel a { color: var(--lc-orange); }
  .lcars .note-close { color: var(--lc-blue); }
  .lcars .chart-legend { color: var(--lc-lavender); }
  .lcars .sub { flex-wrap: wrap; }
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

/**
 * Visual editor. Uses plain form controls so it doesn't depend on Home
 * Assistant's internal editor components.
 */
class SolarEdgeOptimizersCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._strings = discoverStrings(hass);
      this._forecasts = discoverForecasts(hass);
      loadForecastTitles(hass).then(async (titles) => {
        this._titles = titles;
        // New Forecast.Solar entries have no name. Describe those by their
        // planes ("30° / 180° / 4600W") so they can still be told apart.
        this._planes = new Map();
        for (const id of this._forecasts.keys()) {
          if (titles.get(id)) continue;
          const subentries = await hass.callWS({ type: "config_entries/subentries/list", entry_id: id }).catch(() => []);
          const planes = subentries.filter((sub) => sub.subentry_type === "plane").map((sub) => sub.title);
          if (planes.length) this._planes.set(id, planes.join(" + "));
        }
        this._render();
      });
      this._render();
    }
  }

  /** Placeholder text describing the inverter rating the card would use. */
  _detectedLimit() {
    const hass = this._hass;
    const inverters = new Set();
    for (const entry of Object.values(hass.entities || {})) {
      if (entry.platform !== DOMAIN || entry.translation_key !== "health") continue;
      const parent = hass.devices?.[entry.device_id]?.via_device_id;
      if (parent) inverters.add(parent);
    }
    const models = [...inverters].map((id) => hass.devices?.[id]?.model);
    if (models.length === 1) {
      const rating = inverterRating(models[0]);
      return rating ? `Detected ${rating} W from ${models[0]}` : "Couldn't read the rating; enter it";
    }
    return models.length ? "Read from each inverter's model" : "";
  }

  _update(patch) {
    const config = { ...this._config, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete config[key];
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }

  _render() {
    if (!this._hass) return;
    const c = this._config;
    const forecasts = [...(this._forecasts || new Map()).keys()];
    const titles = this._titles || new Map();
    const label = (id) => titles.get(id) || (this._planes?.get(id) ? `Unnamed: ${this._planes.get(id)}` : "Unnamed Forecast.Solar entry");
    const unnamed = forecasts.some((id) => !titles.get(id));
    const mapping = c.forecast_strings || {};
    const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? "selected" : ""}>${esc(label)}</option>`;
    const stringRows = (this._strings || []).map((name) => {
      const current = mapping[name] || "";
      const options = [option("", "No forecast", !current), ...forecasts.map((id) =>
        option(id, label(id), current === id || Boolean(current && titles.get(id) && titles.get(id).toLowerCase() === String(current).toLowerCase())))];
      return `<label class="row"><span>String ${esc(name)}</span><select data-string="${esc(name)}">${options.join("")}</select></label>`;
    });
    const forecastSection = forecasts.length
      ? `<label class="check"><input type="checkbox" data-key="forecast" ${c.forecast !== false ? "checked" : ""}> Show predicted generation</label>
         <p class="hint">Match each string to the Forecast.Solar entry for the roof face it's on. Leave them all on
         "No forecast" to add up every entry as a site total.</p>
         ${unnamed ? `<p class="hint">Some Forecast.Solar entries have no name, so they're shown as tilt / direction /
         size. To name one, open Settings → Devices &amp; services → Forecast.Solar, choose ⋮ next to the entry,
         then Rename.</p>` : ""}
         ${stringRows.join("")}`
      : `<p class="hint">Predicted generation uses Home Assistant's Forecast.Solar integration, which needs an internet
         connection. Add one entry per roof face, then come back here to match them to strings.
         <a href="${SETUP_FORECAST_URL}" target="_blank" rel="noreferrer">Set up Forecast.Solar</a></p>`;
    this.shadowRoot.innerHTML = `<style>
        :host { display: block; }
        .row, .field { display: grid; grid-template-columns: 1fr 1.4fr; align-items: center; gap: 12px; margin: 8px 0; }
        .check { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
        h3 { margin: 18px 0 4px; font-size: 1rem; font-weight: 500; }
        input[type=text], input[type=number], select { font: inherit; padding: 8px; border-radius: 6px; min-width: 0;
          border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color); }
        .hint { margin: 4px 0 8px; font-size: 0.85rem; color: var(--secondary-text-color); }
        .hint a { color: var(--primary-color); }
      </style>
      <label class="field"><span>Title</span><input type="text" data-key="title" value="${esc(c.title ?? "Solar optimizers")}"></label>
      <label class="field"><span>Style</span><select data-key="style">
        ${option("default", "Follow my theme", (c.style || "default") === "default")}${option("lcars", "LCARS", c.style === "lcars")}
      </select></label>
      <label class="field"><span>Optimizers in "lowest" list</span><input type="number" min="0" max="20" data-key="show_weakest" value="${esc(c.show_weakest ?? 5)}"></label>
      <label class="check"><input type="checkbox" data-key="show_history" ${c.show_history !== false ? "checked" : ""}> Show the output curve</label>
      <h3>Predicted generation</h3>
      ${forecastSection}
      ${forecasts.length ? `<label class="field"><span>Inverter AC limit (W)</span>
        <input type="number" min="0" step="100" data-key="inverter_power" value="${esc(typeof c.inverter_power === "number" ? c.inverter_power : "")}"
          placeholder="${esc(this._detectedLimit())}"></label>
        <p class="hint">Strings on one inverter can't produce more than it can deliver, so their combined forecast is
        capped at its AC rating. Leave this empty to use the rating read from the inverter's model.</p>` : ""}`;
    this.shadowRoot.querySelectorAll("[data-key]").forEach((el) => {
      el.addEventListener("change", () => {
        const key = el.dataset.key;
        let value = el.type === "checkbox" ? el.checked : el.value;
        if (key === "show_weakest") value = Number(value);
        if (key === "inverter_power") value = Number(value) > 0 ? Number(value) : undefined;
        // Keep the YAML short: leave defaults out.
        const defaults = { show_history: true, forecast: true, style: "default", show_weakest: 5, inverter_power: undefined };
        this._update({ [key]: defaults[key] === value ? undefined : value });
      });
    });
    this.shadowRoot.querySelectorAll("[data-string]").forEach((el) => {
      el.addEventListener("change", () => {
        const next = { ...(this._config.forecast_strings || {}) };
        if (el.value) next[el.dataset.string] = el.value;
        else delete next[el.dataset.string];
        this._update({ forecast_strings: Object.keys(next).length ? next : undefined });
      });
    });
  }
}

customElements.define("solaredge-optimizers-card-editor", SolarEdgeOptimizersCardEditor);
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
