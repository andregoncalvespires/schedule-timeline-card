/*!
 * schedule-timeline-card v1.0.0
 * Card customizado para entidades `schedule` do Home Assistant.
 * Modos: simple | next | calendar
 */

const CARD_VERSION = "1.0.1";
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const REFETCH_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;

const I18N = {
  pt: {
    on: "Ligado",
    off: "Desligado",
    unavailable: "Indispon\u00edvel",
    turnsOn: "Liga",
    turnsOff: "Desliga",
    at: "\u00e0s",
    tomorrow: "amanh\u00e3",
    in: "em",
    now: "Agora",
    noNext: "Sem pr\u00f3ximo evento",
    loading: "Carregando hor\u00e1rios\u2026",
    noConfig:
      "Hor\u00e1rios n\u00e3o encontrados. Schedules definidos em YAML n\u00e3o s\u00e3o expostos pela API do helper.",
    missing: "Entidade n\u00e3o encontrada:",
  },
  en: {
    on: "On",
    off: "Off",
    unavailable: "Unavailable",
    turnsOn: "Turns on",
    turnsOff: "Turns off",
    at: "at",
    tomorrow: "tomorrow",
    in: "in",
    now: "Now",
    noNext: "No upcoming event",
    loading: "Loading schedule\u2026",
    noConfig:
      "Schedule not found. Schedules defined in YAML are not exposed by the helper API.",
    missing: "Entity not found:",
  },
};

const pad = (n) => String(n).padStart(2, "0");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const clamp = (v, a, b) => {
  const n = Number(v);
  if (Number.isNaN(n)) return a;
  return Math.min(b, Math.max(a, n));
};

const fmtHM = (min) => (min >= 1440 ? "24:00" : `${pad(Math.floor(min / 60))}:${pad(min % 60)}`);

const fmtDuration = (min) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}min`;
  return m ? `${h}h ${pad(m)}min` : `${h}h`;
};

const fmtUntil = (minutes) => {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return "<1min";
  if (m < 60) return `${m}min`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${pad(m % 60)}min`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
};

const parseTime = (s) => {
  const [h, m] = String(s).split(":");
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
};

const dtfCache = {};
function tzParts(date, tz) {
  let key = tz || "local";
  let f = dtfCache[key];
  if (!f) {
    const opts = {
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    };
    try {
      f = new Intl.DateTimeFormat("en-US", tz ? { ...opts, timeZone: tz } : opts);
    } catch (e) {
      f = new Intl.DateTimeFormat("en-US", opts);
    }
    dtfCache[key] = f;
  }
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute };
}

class ScheduleTimelineCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._list = null;
    this._loading = false;
    this._lastFetch = 0;
    this._key = "";
  }

  static getConfigElement() {
    return document.createElement("schedule-timeline-card-editor");
  }

  static getStubConfig(hass) {
    const entity = Object.keys((hass && hass.states) || {}).find((id) => id.startsWith("schedule."));
    return { entity: entity || "schedule.exemplo", mode: "calendar", days: 5 };
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error("Defina 'entity' (ex.: schedule.irrigacao)");
    const days = Math.round(clamp(config.days ?? 5, 1, 7));
    let start = Math.round(clamp(config.start_hour ?? 0, 0, 23));
    let end = Math.round(clamp(config.end_hour ?? 24, 1, 24));
    if (end <= start) {
      start = 0;
      end = 24;
    }
    this._config = {
      mode: "simple",
      show_icon: true,
      show_next: true,
      show_now_marker: true,
      show_total: false,
      show_legend: true,
      tap_action: "more-info",
      ...config,
      days,
      start_hour: start,
      end_hour: end,
    };
    this._lastFetch = 0;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const st = hass.states[this._config.entity];
    const a = (st && st.attributes) || {};
    const key = st ? `${st.state}|${a.next_event}|${st.last_updated}` : "none";
    const changed = st !== this._stateObj;
    this._stateObj = st;
    if (key !== this._key) {
      this._key = key;
      this._lastFetch = 0;
    }
    if (this._needsConfig() && !this._loading && Date.now() - this._lastFetch > REFETCH_MS) {
      this._fetch();
    }
    if (changed || !this._shown) {
      this._shown = true;
      this._render();
    }
  }

  connectedCallback() {
    this._timer = setInterval(() => this._render(), TICK_MS);
    this._render();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  getCardSize() {
    const c = this._config || {};
    if (c.mode === "calendar") return 2 + (c.days || 5) * 0.6;
    return c.mode === "next" ? 2 : 1;
  }

  getGridOptions() {
    const c = this._config || {};
    return { columns: 12, rows: c.mode === "calendar" ? "auto" : 2, min_columns: 4 };
  }

  _needsConfig() {
    const c = this._config;
    if (!c) return false;
    const a = (this._stateObj && this._stateObj.attributes) || {};
    return c.mode === "calendar" || (c.mode === "next" && !a.next_event);
  }

  async _fetch() {
    if (this._loading || !this._hass || !this._hass.callWS) return;
    this._loading = true;
    try {
      const list = await this._hass.callWS({ type: "schedule/list" });
      this._list = Array.isArray(list) ? list : [];
    } catch (e) {
      this._list = [];
    }
    this._lastFetch = Date.now();
    this._loading = false;
    this._render();
  }

  _findSchedule() {
    if (!this._list) return null;
    const id = this._config.entity.split(".")[1];
    const fn = this._stateObj && this._stateObj.attributes.friendly_name;
    return this._list.find((i) => i.id === id) || this._list.find((i) => i.name === fn) || null;
  }

  _t() {
    const lang = (this._hass && this._hass.locale && this._hass.locale.language) || navigator.language || "pt";
    return String(lang).toLowerCase().startsWith("pt") ? I18N.pt : I18N.en;
  }

  _lang() {
    return (this._hass && this._hass.locale && this._hass.locale.language) || "pt-BR";
  }

  _wd(dt) {
    let s;
    try {
      s = new Intl.DateTimeFormat(this._lang(), { weekday: "short", timeZone: "UTC" }).format(dt);
    } catch (e) {
      s = DAY_KEYS[dt.getUTCDay()].slice(0, 3);
    }
    s = s.replace(/\.$/, "");
    return `${s.charAt(0).toUpperCase()}${s.slice(1)} ${pad(dt.getUTCDate())}`;
  }

  _icon(isOn) {
    const c = this._config;
    const entIcon = this._stateObj && this._stateObj.attributes.icon;
    const base = c.icon || entIcon || "mdi:calendar-clock";
    return isOn ? base : c.icon_off || base;
  }

  _next(np, nowMin, now, sch) {
    const st = this._stateObj;
    const tz = this._hass.config && this._hass.config.time_zone;
    const na = st.attributes.next_event;
    if (na) {
      const d = new Date(na);
      if (!Number.isNaN(d.getTime())) {
        const p = tzParts(d, tz);
        return {
          dayDiff: Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(np.y, np.m - 1, np.d)) / 864e5),
          min: p.h * 60 + p.min,
          until: (d.getTime() - now.getTime()) / 60000,
        };
      }
    }
    if (!sch) return null;
    const ivs = [];
    for (let off = 0; off <= 7; off++) {
      const key = DAY_KEYS[new Date(Date.UTC(np.y, np.m - 1, np.d + off)).getUTCDay()];
      for (const it of sch[key] || []) {
        ivs.push([off * 1440 + parseTime(it.from), off * 1440 + parseTime(it.to)]);
      }
    }
    ivs.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const iv of ivs) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([...iv]);
    }
    let target = null;
    for (const iv of merged) {
      if (nowMin >= iv[0] && nowMin < iv[1]) {
        target = iv[1];
        break;
      }
      if (iv[0] > nowMin) {
        target = iv[0];
        break;
      }
    }
    if (target === null) return null;
    return { dayDiff: Math.floor(target / 1440), min: target % 1440, until: target - nowMin };
  }

  _nextLabel(n, isOn, np, t) {
    if (!n) return t.noNext;
    const verb = isOn ? t.turnsOff : t.turnsOn;
    const time = fmtHM(n.min);
    if (n.dayDiff <= 0) return `${verb} ${t.at} ${time}`;
    if (n.dayDiff === 1) return `${verb} ${t.tomorrow} ${time}`;
    const dt = new Date(Date.UTC(np.y, np.m - 1, np.d + n.dayDiff));
    return `${verb} ${this._wd(dt)} ${time}`;
  }

  _calendar(np, nowMin, t, sch) {
    const c = this._config;
    if (!this._list) return `<div class="msg">${t.loading}</div>`;
    if (!sch) return `<div class="msg">${t.noConfig}</div>`;

    const S = c.start_hour * 60;
    const E = c.end_hour * 60;
    const span = E - S;
    const pct = (m) => ((m - S) / span) * 100;
    const nowPct = pct(nowMin);
    const showNow = c.show_now_marker && nowMin >= S && nowMin <= E;

    const spanH = span / 60;
    const step = spanH > 12 ? 6 : spanH > 6 ? 2 : 1;
    let ticksHtml = "";
    for (let h = Math.ceil(S / 60 / step) * step; h * 60 <= E; h += step) {
      const p = pct(h * 60);
      const tf = p <= 0 ? "none" : p >= 100 ? "translateX(-100%)" : "translateX(-50%)";
      ticksHtml += `<span class="tick" style="left:${p.toFixed(2)}%;transform:${tf}">${h}h</span>`;
    }
    const totSpacer = c.show_total ? `<div class="tot"></div>` : "";
    let html = `<div class="grid"><div class="day axis"><div class="lbl"></div><div class="ticks">${ticksHtml}</div>${totSpacer}</div>`;

    for (let i = 0; i < c.days; i++) {
      const dt = new Date(Date.UTC(np.y, np.m - 1, np.d + i));
      const items = sch[DAY_KEYS[dt.getUTCDay()]] || [];
      let blocks = "";
      let total = 0;
      for (const it of items) {
        const from = parseTime(it.from);
        const to = parseTime(it.to);
        total += Math.max(0, to - from);
        const a = Math.max(from, S);
        const b = Math.min(to, E);
        if (b <= a) continue;
        let tip = `${fmtHM(from)} \u2192 ${fmtHM(to)} (${fmtDuration(to - from)})`;
        if (it.data && typeof it.data === "object") {
          const extra = Object.entries(it.data).map(([k, v]) => `${k}: ${v}`).join(", ");
          if (extra) tip += `\n${extra}`;
        }
        blocks += `<div class="blk" title="${esc(tip)}" style="left:${pct(a).toFixed(2)}%;width:${(((b - a) / span) * 100).toFixed(2)}%"></div>`;
      }
      const today = i === 0;
      const marker = today && showNow ? `<div class="now" style="left:${nowPct.toFixed(2)}%"></div>` : "";
      const tot = c.show_total ? `<div class="tot">${total ? fmtDuration(total) : "\u2013"}</div>` : "";
      html += `<div class="day${today ? " today" : ""}"><div class="lbl">${esc(this._wd(dt))}</div><div class="track">${blocks}${marker}</div>${tot}</div>`;
    }
    html += `</div>`;

    if (c.show_legend) {
      html += `<div class="legend"><span><i class="dot"></i>${t.on}</span>`;
      if (showNow) html += `<span><i class="bar"></i>${t.now} (${fmtHM(nowMin)})</span>`;
      html += `</div>`;
    }
    return html;
  }

  _render() {
    if (!this._config || !this._hass) return;
    const c = this._config;
    const st = this._stateObj;
    const t = this._t();
    const root = this.shadowRoot;

    if (!st) {
      root.innerHTML = `<style>${STYLE}</style><ha-card><div class="msg">${t.missing} ${esc(c.entity)}</div></ha-card>`;
      return;
    }

    const now = new Date();
    const tz = this._hass.config && this._hass.config.time_zone;
    const np = tzParts(now, tz);
    const nowMin = np.h * 60 + np.min;
    const isOn = st.state === "on";
    const unavailable = st.state === "unavailable" || st.state === "unknown";
    const name = c.name || st.attributes.friendly_name || c.entity;
    const sch = this._findSchedule();

    const stateText = unavailable ? t.unavailable : isOn ? t.on : t.off;
    const needNext = c.mode === "next" || (c.mode === "calendar" && c.show_next);
    const n = needNext && !unavailable ? this._next(np, nowMin, now, sch) : null;
    const nextLabel = needNext ? (unavailable ? t.unavailable : this._nextLabel(n, isOn, np, t)) : "";
    const countdown = n ? `${t.in} ${fmtUntil(n.until)}` : "";

    let info;
    let chip = `<span class="chip${isOn ? " on" : ""}">${stateText}</span>`;
    if (c.mode === "simple") {
      info = `<div class="name">${esc(name)}</div><div class="sub${isOn ? " on" : ""}">${stateText}</div>`;
      chip = "";
    } else if (c.mode === "next") {
      info = `<div class="name">${esc(name)}</div><div class="main">${esc(nextLabel)}</div><div class="sub">${esc(countdown)}</div>`;
    } else {
      const line = [nextLabel, countdown].filter(Boolean).join(" \u00b7 ");
      info = `<div class="name">${esc(name)}</div>${c.show_next ? `<div class="sub">${esc(line)}</div>` : ""}`;
    }

    const icon = c.show_icon
      ? `<div class="ico${isOn ? " on" : ""}"><ha-icon icon="${esc(this._icon(isOn))}"></ha-icon></div>`
      : "";
    const onColor = c.on_color || "var(--success-color, #43a047)";
    const nowColor = c.now_color || "var(--error-color, #db4437)";
    const tap = typeof c.tap_action === "object" ? c.tap_action.action : c.tap_action;
    const clickable = tap !== "none";
    const body = c.mode === "calendar" ? this._calendar(np, nowMin, t, sch) : "";

    root.innerHTML = `<style>${STYLE}</style><ha-card class="${clickable ? "click" : ""}" style="--on:${esc(onColor)};--nowc:${esc(nowColor)}"><div class="head">${icon}<div class="info">${info}</div>${chip}</div>${body}</ha-card>`;

    if (clickable) {
      const card = root.querySelector("ha-card");
      if (card) {
        card.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("hass-more-info", { detail: { entityId: c.entity }, bubbles: true, composed: true })
          );
        });
      }
    }
  }
}

const STYLE = `
:host{display:block}
ha-card{padding:12px 16px;overflow:hidden}
ha-card.click{cursor:pointer}
.head{display:flex;align-items:center;gap:12px}
.ico{flex:none;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--secondary-text-color) 15%,transparent);color:var(--secondary-text-color)}
.ico.on{background:color-mix(in srgb,var(--on) 18%,transparent);color:var(--on)}
.info{flex:1;min-width:0}
.name{font-size:14px;font-weight:500;color:var(--primary-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.main{font-size:16px;font-weight:500;color:var(--primary-text-color);line-height:1.35}
.sub{font-size:12px;color:var(--secondary-text-color);line-height:1.4}
.sub.on{color:var(--on)}
.chip{flex:none;font-size:12px;padding:2px 10px;border-radius:12px;background:color-mix(in srgb,var(--secondary-text-color) 15%,transparent);color:var(--secondary-text-color)}
.chip.on{background:color-mix(in srgb,var(--on) 18%,transparent);color:var(--on)}
.grid{margin-top:12px}
.day{display:flex;align-items:center;gap:8px;padding:4px 6px;margin:0 -6px;border-radius:8px}
.day.today{background:color-mix(in srgb,var(--primary-color) 12%,transparent)}
.day.axis{padding-top:0;padding-bottom:2px}
.lbl{flex:none;width:50px;font-size:12px;color:var(--secondary-text-color)}
.today .lbl{color:var(--primary-color);font-weight:500}
.track{flex:1;position:relative;height:20px;border-radius:4px;background:color-mix(in srgb,var(--secondary-text-color) 15%,transparent)}
.blk{position:absolute;top:0;bottom:0;border-radius:3px;background:var(--on);opacity:.85}
.today .blk{opacity:1}
.now{position:absolute;top:-3px;bottom:-3px;width:2px;margin-left:-1px;border-radius:1px;background:var(--nowc)}
.ticks{flex:1;position:relative;height:14px;font-size:11px;color:var(--secondary-text-color)}
.tick{position:absolute;top:0;white-space:nowrap}
.tot{flex:none;width:48px;text-align:right;font-size:11px;color:var(--secondary-text-color)}
.legend{display:flex;gap:14px;margin-top:10px;font-size:11px;color:var(--secondary-text-color)}
.legend span{display:inline-flex;align-items:center;gap:5px}
.dot{width:10px;height:10px;border-radius:2px;background:var(--on);display:inline-block}
.bar{width:2px;height:10px;background:var(--nowc);display:inline-block}
.msg{padding:8px 0;font-size:13px;color:var(--secondary-text-color)}
`;

const EDITOR_LABELS = {
  entity: "Entidade (schedule)",
  name: "Nome (opcional)",
  icon: "\u00cdcone (ligado)",
  icon_off: "\u00cdcone (desligado)",
  mode: "Modo",
  days: "Dias exibidos",
  start_hour: "Hora inicial",
  end_hour: "Hora final",
  show_icon: "Mostrar \u00edcone",
  show_next: "Mostrar pr\u00f3ximo evento",
  show_now_marker: "Marcador de agora",
  show_total: "Total de horas por dia",
  show_legend: "Mostrar legenda",
  on_color: "Cor de ligado (CSS)",
  now_color: "Cor do marcador (CSS)",
};

const EDITOR_DEFAULTS = {
  mode: "simple",
  days: 5,
  start_hour: 0,
  end_hour: 24,
  show_icon: true,
  show_next: true,
  show_now_marker: true,
  show_total: false,
  show_legend: true,
};

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "schedule" } } },
  { name: "name", selector: { text: {} } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "icon", selector: { icon: {} } },
      { name: "icon_off", selector: { icon: {} } },
    ],
  },
  {
    name: "mode",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "simple", label: "Simples (ligado/desligado)" },
          { value: "next", label: "Pr\u00f3ximo evento" },
          { value: "calendar", label: "Calend\u00e1rio" },
        ],
      },
    },
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "days", selector: { number: { min: 1, max: 7, mode: "box" } } },
      { name: "start_hour", selector: { number: { min: 0, max: 23, mode: "box" } } },
      { name: "end_hour", selector: { number: { min: 1, max: 24, mode: "box" } } },
    ],
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "show_icon", selector: { boolean: {} } },
      { name: "show_next", selector: { boolean: {} } },
      { name: "show_now_marker", selector: { boolean: {} } },
      { name: "show_total", selector: { boolean: {} } },
      { name: "show_legend", selector: { boolean: {} } },
    ],
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "on_color", selector: { text: {} } },
      { name: "now_color", selector: { text: {} } },
    ],
  },
];

class ScheduleTimelineCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
        );
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = { ...EDITOR_DEFAULTS, ...this._config };
  }
}

customElements.define("schedule-timeline-card", ScheduleTimelineCard);
customElements.define("schedule-timeline-card-editor", ScheduleTimelineCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "schedule-timeline-card",
  name: "Schedule Timeline Card",
  description: "Exibe entidades schedule: estado, pr\u00f3ximo evento e calend\u00e1rio de horas por dia.",
});

console.info(`%c SCHEDULE-TIMELINE-CARD %c v${CARD_VERSION} `, "color:#fff;background:#43a047;font-weight:500", "color:#43a047");
