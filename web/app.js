/* whoopfree v0.2 — dashboard front-end */

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) =>
  v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))
    ? "—"
    : (typeof v === "number" ? v.toFixed(d) : v);
const fmtInt = (v) => v === null || v === undefined ? "—" : Math.round(v).toString();
const fmtHM = (mins) => {
  if (mins == null) return "—";
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${h}h ${m}m`;
};

const COLORS = {
  recGood: getCss("--rec-good"),
  recMid:  getCss("--rec-mid"),
  recBad:  getCss("--rec-bad"),
  strain:  getCss("--strain"),
  strain2: getCss("--strain-2"),
  sleep:   getCss("--sleep"),
  muted:   getCss("--muted"),
  fg:      getCss("--fg"),
  fg2:     getCss("--fg-2"),
  border:  getCss("--border"),
  stage: {
    wake:  getCss("--stage-wake"),
    light: getCss("--stage-light"),
    deep:  getCss("--stage-deep"),
    rem:   getCss("--stage-rem"),
  },
  zone: [getCss("--zone-1"), getCss("--zone-2"), getCss("--zone-3"), getCss("--zone-4"), getCss("--zone-5")],
};

function getCss(varName) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

function recoveryColor(score) {
  if (score == null) return COLORS.muted;
  if (score >= 67) return COLORS.recGood;
  if (score >= 34) return COLORS.recMid;
  return COLORS.recBad;
}

function recoveryLabel(score) {
  if (score == null) return "needs more data";
  if (score >= 67) return "Primed";
  if (score >= 34) return "Adequate";
  return "Low — rest day";
}

function strainLabel(s) {
  if (s == null) return "—";
  if (s < 6) return "Light";
  if (s < 11) return "Moderate";
  if (s < 15) return "Strenuous";
  if (s < 18) return "Hard";
  return "All-out";
}

/**
 * One-line coach recommendation for a given recovery score.
 * Returns null when score is unavailable.
 */
function recoveryCoach(score) {
  if (score == null) return null;
  if (score >= 85) return "Peak readiness — push hard today · Target strain 16–20";
  if (score >= 67) return "Ready for high intensity · Target strain 14–18";
  if (score >= 50) return "Good capacity — moderate efforts · Target strain 10–13";
  if (score >= 34) return "Reduced capacity — easier efforts · Target strain 7–11";
  return "Rest day recommended · Keep strain below 9";
}

/* ───────────────────────────── Date navigation ─────────────────────── */
// null = "today" (live data). YYYY-MM-DD string = historical view.
let _browseDate = null;

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetDate(iso, deltaDays) {
  const d = new Date(iso + "T12:00:00");
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function renderDateNav(elId, iso) {
  const el = $(elId);
  if (!el) return;
  const todayStr = todayIso();
  const isToday = iso === todayStr;
  el.innerHTML = `
    <span style="display:inline-flex;gap:4px;align-items:center;">
      <button class="date-nav-btn" data-delta="-1" style="font-size:13px;padding:1px 6px;line-height:1.4;" title="Previous day">‹</button>
      <span style="font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;">${new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span>
      <button class="date-nav-btn" data-delta="+1" ${isToday ? "disabled" : ""} style="font-size:13px;padding:1px 6px;line-height:1.4;" title="Next day">›</button>
    </span>`;
  el.querySelectorAll(".date-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const delta = parseInt(btn.dataset.delta, 10);
      const next = offsetDate(iso, delta);
      if (next > todayStr) return; // never go into the future
      _browseDate = next;
      loadActiveTab().catch((e) => setStatus("error: " + e.message));
    });
  });
}

async function fetchJSON(url, opts) {
  // Try the in-browser IndexedDB shim first (v0.3). If it returns null,
  // the path isn't routed — fall back to network fetch for compatibility.
  if (window.whoopApi) {
    const shimResult = await window.whoopApi.handle(url, opts);
    if (shimResult !== null) return shimResult;
  }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

/* ───────────────────────────── Tab routing ─────────────────────────── */

const TABS = ["overview", "recovery", "sleep", "strain", "trends", "live"];
let activeTab = "overview";

function setTab(name) {
  if (!TABS.includes(name)) name = "overview";
  // Reset date navigation when the user explicitly switches tabs.
  if (name !== activeTab) _browseDate = null;
  activeTab = name;
  // Sidebar tabs + mobile bottom-nav tabs share .active styling
  document.querySelectorAll(".tab, .mtab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.dataset.panel === name));
  history.replaceState(null, "", "#" + name);
  // Scroll to top on tab switch (especially helpful on mobile)
  window.scrollTo({ top: 0, behavior: "instant" });
  loadActiveTab().catch((e) => setStatus("error: " + e.message));
}

function initTabs() {
  document.querySelectorAll(".tab, .mtab").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  const initial = (location.hash || "#overview").slice(1);
  setTab(initial);
}

async function loadActiveTab() {
  switch (activeTab) {
    case "overview": return loadOverview();
    case "recovery": return loadRecovery();
    case "sleep":    return loadSleep();
    case "strain":   return loadStrain();
    case "trends":   return loadTrends();
    case "live":     return loadLive();
  }
}

/* ───────────────────────────── Status line ─────────────────────────── */

function setStatus(text) { $("status-line").textContent = text; }

async function refreshStatus() {
  try {
    const s = await fetchJSON("/api/status");
    let line = `samples: ${s.sample_count.toLocaleString()}\ndays: ${s.days_recorded}`;
    if (s.latest_sample) {
      const ago = Math.round((Date.now() - new Date(s.latest_sample.ts_utc)) / 1000);
      line += `\nlast: ${ago < 60 ? ago + "s" : Math.round(ago / 60) + "m"} ago`;
    } else {
      line += "\nno samples yet";
    }
    if (s.latest_battery) line += `\nbattery ${s.latest_battery.detail}`;
    setStatus(line);
  } catch (e) {
    setStatus("error: " + e.message);
  }
}

/* ───────────────────────────── Charts cache ────────────────────────── */

const charts = {};
function makeOrUpdate(id, cfg) {
  if (charts[id]) charts[id].destroy();
  // Auto-hide legend on single-series charts
  cfg.options = autoHideLegend(cfg.options, cfg.data);
  charts[id] = new Chart($(id), cfg);
}

/**
 * Auto-disable the legend on single-series charts (visual noise).
 * Adapts a Chart.js options block based on its data.
 */
function autoHideLegend(opts, data) {
  const n = (data?.datasets?.length) || 0;
  if (n <= 1) {
    opts = opts || {};
    opts.plugins = opts.plugins || {};
    opts.plugins.legend = { ...(opts.plugins.legend || {}), display: false };
  }
  return opts;
}
function commonOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        labels: {
          color: COLORS.fg2,
          usePointStyle: true,
          pointStyle: "circle",
          boxWidth: 6,
          boxHeight: 6,
          padding: 14,
          font: { size: 11, weight: "600", family: "Inter, system-ui, sans-serif" },
        },
        align: "end",
      },
      tooltip: {
        backgroundColor: "rgba(15,15,20,0.95)",
        borderColor: "rgba(255,255,255,0.06)",
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        titleFont: { size: 11, weight: "600" },
        bodyFont: { size: 12 },
        displayColors: true,
        boxPadding: 4,
      },
    },
    scales: {
      x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
      y: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
    },
    ...extra,
  };
}

/* ───────────────────────────── Recovery ring (SVG) ─────────────────── */

/**
 * Draw a thin Whoop-style ring (270° arc) into an SVG element.
 *
 * The ring is purely visual — numeric value and label are rendered in
 * HTML overlay siblings so they get crisp web typography. The arc itself
 * gets a soft glow via SVG <filter>, plus a subtle pulse animation on
 * the head cap when the value is non-zero.
 *
 * @param {SVGElement} svg
 * @param {number|null} score  value (or null for empty ring)
 * @param {string}      color  primary stroke color (gradient endpoint)
 * @param {number}      maxVal scale ceiling (e.g. 100 for %, 21 for strain)
 * @param {Object}      [opts]
 * @param {number}      [opts.stroke=18]
 * @param {string}      [opts.colorTo] optional gradient endpoint
 * @param {boolean}     [opts.glow=true]
 */
function drawRing(svg, score, color, maxVal = 100, opts = {}) {
  if (!svg) return;
  const stroke = opts.stroke ?? 18;
  const colorTo = opts.colorTo ?? color;
  const glow = opts.glow ?? true;

  const size = 300;
  const cx = size / 2, cy = size / 2;
  const r = (size - stroke) / 2 - 4;
  const startAngle = -225, endAngle = 45; // 270° arc
  const total = endAngle - startAngle;
  const pct = score == null ? 0 : Math.max(0, Math.min(maxVal, score)) / maxVal;

  const pt = (angleDeg, radius) => {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
  };
  const arcPath = (a0, a1, radius) => {
    const [x0, y0] = pt(a0, radius);
    const [x1, y1] = pt(a1, radius);
    const largeArc = (a1 - a0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1}`;
  };

  const trackPath = arcPath(startAngle, endAngle, r);
  const fillEnd = startAngle + total * pct;
  const fillPath = pct > 0 ? arcPath(startAngle, fillEnd, r) : "";
  const [headX, headY] = pt(fillEnd, r);
  const gid = "g" + Math.random().toString(36).slice(2, 8);
  const fid = "f" + Math.random().toString(36).slice(2, 8);

  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%"  stop-color="${color}"/>
        <stop offset="100%" stop-color="${colorTo}"/>
      </linearGradient>
      ${glow ? `<filter id="${fid}" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="6" result="blur"/>
        <feMerge><feMerge node-in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>` : ""}
    </defs>
    <path d="${trackPath}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="${stroke}" stroke-linecap="round" />
    ${pct > 0 ? `
      <path d="${fillPath}" fill="none" stroke="url(#${gid})" stroke-width="${stroke}" stroke-linecap="round" ${glow ? `filter="url(#${fid})"` : ""} />
      <circle cx="${headX}" cy="${headY}" r="${stroke / 2}" fill="${colorTo}" />
    ` : ""}
  `;
}

// Legacy wrappers kept for callers in app.js — the new HTML overlays the value separately.
function drawRecoveryRing(svg, score /*, big = false */) {
  drawRing(svg, score, recoveryColor(score), 100, { stroke: 20 });
}
function drawGaugeRing(svg, score, color /*, formatFn, maxVal=100 */, formatFn, maxVal = 100) {
  drawRing(svg, score, color, maxVal, { stroke: 18 });
}

/* ───────────────────────────── Hypnogram (SVG) ─────────────────────── */

const STAGE_ORDER = ["wake", "rem", "light", "deep"]; // top→bottom

function drawHypnogram(svg, stages) {
  // Empty state: friendly moon illustration + caption
  if (!stages || !stages.length) {
    svg.setAttribute("viewBox", "0 0 1000 220");
    svg.innerHTML = `
      <defs>
        <radialGradient id="moonGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#2547D4" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#2547D4" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <circle cx="500" cy="100" r="80" fill="url(#moonGrad)"/>
      <path d="M 530 70 A 38 38 0 1 0 530 130 A 28 28 0 1 1 530 70 Z" fill="#4D7CFF" opacity="0.85"/>
      <circle cx="430" cy="55" r="1.5" fill="#4D7CFF" opacity="0.6"/>
      <circle cx="570" cy="40" r="1.5" fill="#4D7CFF" opacity="0.6"/>
      <circle cx="600" cy="160" r="1.2" fill="#4D7CFF" opacity="0.5"/>
      <circle cx="410" cy="170" r="1.2" fill="#4D7CFF" opacity="0.5"/>
      <text x="500" y="200" text-anchor="middle" fill="${COLORS.muted}" style="font-size:13px;font-weight:500;font-family:Inter,system-ui,sans-serif;">No sleep recorded for this night</text>
    `;
    return;
  }
  return _drawHypnogramReal(svg, stages);
}

function _drawHypnogramReal(svg, stages) {
  const width = 1000, height = 220, padTop = 20, padBottom = 30, padLR = 8;
  const rowH = (height - padTop - padBottom) / STAGE_ORDER.length;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  if (!stages.length) {
    svg.innerHTML = `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:13px;">No sleep detected for this night.</text>`;
    return;
  }
  const t0 = new Date(stages[0].start).getTime();
  const t1 = new Date(stages[stages.length - 1].end).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (t) => padLR + ((new Date(t).getTime() - t0) / span) * (width - padLR * 2);
  const rowY = (stage) => padTop + STAGE_ORDER.indexOf(stage) * rowH + 4;

  const labels = STAGE_ORDER.map((s, i) => `
    <line x1="${padLR}" x2="${width - padLR}" y1="${padTop + i * rowH + rowH / 2}" y2="${padTop + i * rowH + rowH / 2}" stroke="${COLORS.border}" stroke-dasharray="2 4" />
    <text x="${padLR}" y="${padTop + i * rowH + 14}" fill="${COLORS.muted}" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;">${s}</text>
  `).join("");

  const blocks = stages.map((s) => {
    const x0 = x(s.start), x1 = x(s.end);
    const w = Math.max(1, x1 - x0);
    return `<rect x="${x0}" y="${rowY(s.stage)}" width="${w}" height="${rowH - 8}" rx="3" fill="${COLORS.stage[s.stage] || COLORS.muted}" opacity="0.92" />`;
  }).join("");

  // Time ticks (start, mid, end)
  const fmtT = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const ticks = `
    <text x="${padLR}" y="${height - 8}" fill="${COLORS.muted}" style="font-size:11px;">${fmtT(stages[0].start)}</text>
    <text x="${width / 2}" y="${height - 8}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:11px;">${fmtT(stages[Math.floor(stages.length / 2)].start)}</text>
    <text x="${width - padLR}" y="${height - 8}" text-anchor="end" fill="${COLORS.muted}" style="font-size:11px;">${fmtT(stages[stages.length - 1].end)}</text>
  `;

  svg.innerHTML = labels + blocks + ticks;
}

/* ───────────────────────────── Zones donut (SVG) ───────────────────── */

function drawZonesDonut(svg, zoneMinutes) {
  const size = 200, cx = 100, cy = 100, r = 78, stroke = 22;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  const total = zoneMinutes.reduce((a, b) => a + b, 0);
  if (!total) {
    svg.innerHTML = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.border}" stroke-width="${stroke}" />
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:12px;">no zone data</text>
    `;
    return;
  }
  const circ = 2 * Math.PI * r;
  let offset = 0;
  let parts = "";
  zoneMinutes.forEach((m, i) => {
    if (!m) return;
    const len = (m / total) * circ;
    parts += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.zone[i]}"
      stroke-width="${stroke}" stroke-dasharray="${len} ${circ - len}"
      stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += len;
  });
  const totalH = total / 60;
  svg.innerHTML = `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.border}" stroke-width="${stroke}" />
    ${parts}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${COLORS.fg}" style="font-size:24px;font-weight:600;">${totalH.toFixed(1)}h</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:11px;text-transform:uppercase;letter-spacing:1px;">in zones</text>
  `;
}

/* ───────────────────────────── Overview tab ────────────────────────── */

async function loadOverview() {
  const [overview, today] = await Promise.all([
    fetchJSON("/api/overview"),
    fetchJSON("/api/today?downsample=20"),
  ]);

  const today_d = new Date();
  const dateStr = today_d.toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });
  if ($("overview-date")) $("overview-date").textContent = dateStr;
  if ($("topbar-date"))   $("topbar-date").textContent   = `Today · ${today_d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  // Time-aware greeting
  const hour = today_d.getHours();
  const greeting = hour < 5 ? "Late night" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : hour < 22 ? "Good evening" : "Good night";
  const welcomeEl = document.querySelector(".welcome-text");
  if (welcomeEl) welcomeEl.textContent = `${greeting}, Madhur`;

  const m = overview.metrics || {};
  const trend7 = overview.trend7 || [];

  // ─── Sleep ring (blue) ─────────────────────────────────────────
  if ($("sleep-ring")) {
    // Treat 0 sleep minutes as "no data" — rollup writes zeros when no sleep window detected
    const hasSleep = m.sleep_minutes != null && m.sleep_minutes > 0;
    const sleepPerf = hasSleep ? m.sleep_performance_pct : null;
    drawRing($("sleep-ring"), sleepPerf, "#819BFF", 100, { stroke: 18, colorTo: "#4D7CFF" });
    const asleep = m.sleep_minutes || 0;
    const hours = Math.floor(asleep / 60), mins = asleep % 60;
    if ($("sleep-ring-num")) {
      $("sleep-ring-num").textContent = hasSleep ? Math.round(sleepPerf) : "—";
      $("sleep-ring-num").style.color = hasSleep ? "var(--text)" : "var(--text-faint)";
    }
    if ($("sleep-perf")) {
      $("sleep-perf").textContent = hasSleep ? "of sleep need met" : "no sleep recorded";
    }
    if ($("sleep-ring-foot")) {
      $("sleep-ring-foot").innerHTML = hasSleep
        ? `<span><strong>${hours}h ${mins}m</strong> asleep</span>`
        : `<span>Wear strap overnight to record sleep</span>`;
    }
  }

  // ─── Recovery ring (green/yellow/red) ──────────────────────────
  if ($("recovery-ring")) {
    // Treat recovery_score=0 with no HRV as "no data" (rollup writes 0 when no overnight HRV)
    const hasRec = m.recovery_score != null && m.recovery_score > 0 && m.rmssd_ms != null;
    const recScore = hasRec ? m.recovery_score : null;
    const color = recoveryColor(recScore);
    drawRing($("recovery-ring"), recScore, color, 100, { stroke: 22 });
    if ($("recovery-ring-num")) {
      $("recovery-ring-num").textContent = hasRec ? Math.round(recScore) : "—";
      $("recovery-ring-num").style.color = hasRec ? "var(--text)" : "var(--text-faint)";
    }
    if ($("recovery-meta")) {
      if (!hasRec) {
        $("recovery-meta").textContent = "needs overnight HRV";
        $("recovery-meta").style.color = "var(--text-faint)";
      } else {
        const labels = { good: "OPTIMAL", mid: "ADEQUATE", bad: "LOW" };
        const tier = recScore >= 67 ? "good" : recScore >= 33 ? "mid" : "bad";
        $("recovery-meta").textContent = labels[tier];
        $("recovery-meta").style.color = color;
      }
    }
    if ($("recovery-ring-foot")) {
      if (hasRec) {
        const prior = trend7.slice(0, -1);
        const hrvBase = (() => {
          const vs = prior.map((r) => r.rmssd_ms).filter((v) => v != null);
          return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
        })();
        const hrvDelta = (m.rmssd_ms != null && hrvBase != null) ? m.rmssd_ms - hrvBase : null;
        const arrow = (d) => d == null ? "" : `<span style="color:${d > 0 ? "var(--recovery)" : "var(--bad)"}">${d > 0 ? "↑" : d < 0 ? "↓" : "·"} ${d > 0 ? "+" : ""}${Math.round(d)}</span>`;
        $("recovery-ring-foot").innerHTML =
          `<span>HRV <strong>${fmtInt(m.rmssd_ms)} ms</strong> ${arrow(hrvDelta)}</span><span>RHR <strong>${fmtInt(m.resting_hr)} bpm</strong></span>`;
      } else {
        $("recovery-ring-foot").innerHTML = `<span>Wear your strap overnight to compute recovery</span>`;
      }
    }
  }

  // ─── Strain ring (cyan) ────────────────────────────────────────
  if ($("strain-ring")) {
    const strain = m.strain_score ?? 0;
    drawRing($("strain-ring"), m.strain_score, "#03B5F3", 21, { stroke: 18, colorTo: "#00D4FF" });
    if ($("strain-ring-num")) {
      $("strain-ring-num").textContent = m.strain_score != null ? strain.toFixed(1) : "—";
    }
    if ($("strain-meta")) {
      $("strain-meta").textContent = m.strain_score == null
        ? "no activity yet"
        : `${strainLabel(strain).toUpperCase()}`;
      $("strain-meta").style.color = "var(--strain)";
    }
    if ($("strain-ring-foot")) {
      $("strain-ring-foot").innerHTML = m.strain_score != null
        ? `<span><strong>${fmtInt(m.calories)}</strong> kcal burned</span><span>scale 0–21</span>`
        : `<span>Start moving — strain will update through the day</span>`;
    }
  }

  // Now card
  const ls = overview.latest_sample;
  if (ls) {
    $("now-hr").textContent = fmtInt(ls.heart_rate_bpm);
    $("now-spo2").textContent = (ls.spo2_pct ?? "—") + "%";
    $("now-temp").textContent = ls.skin_temp_c != null ? ls.skin_temp_c.toFixed(1) + "°C" : "—";
    const ago = Math.round((Date.now() - new Date(ls.ts_utc)) / 1000);
    $("now-ago").textContent = ago < 60 ? ago + "s" : Math.round(ago / 60) + "m";
  } else {
    $("now-hr").textContent = "—";
  }
  $("now-battery").textContent = overview.battery ? overview.battery.detail : "—";

  // 7-day sparklines (recovery, sleep, strain) — symmetric trends in the three rings
  const sparkOpts = (yMin, yMax) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { display: false },
      y: { display: false, min: yMin, max: yMax },
    },
  });
  if (trend7.length > 1) {
    const labels = trend7.map((r) => r.date.slice(5));
    if ($("recovery-sparkline")) {
      makeOrUpdate("recovery-sparkline", {
        type: "line",
        data: { labels, datasets: [{
          data: trend7.map((r) => r.recovery_score),
          borderColor: recoveryColor(m.recovery_score),
          backgroundColor: "transparent",
          borderWidth: 1.5,
          pointRadius: 2,
          pointBackgroundColor: trend7.map((r) => recoveryColor(r.recovery_score)),
          tension: 0.3,
        }] },
        options: sparkOpts(0, 100),
      });
    }
    if ($("sleep-sparkline")) {
      makeOrUpdate("sleep-sparkline", {
        type: "line",
        data: { labels, datasets: [{
          data: trend7.map((r) => r.sleep_performance_pct),
          borderColor: COLORS.sleep,
          backgroundColor: "transparent",
          borderWidth: 1.5,
          pointRadius: 2,
          pointBackgroundColor: COLORS.sleep,
          tension: 0.3,
        }] },
        options: sparkOpts(0, 100),
      });
    }
    if ($("strain-sparkline")) {
      // Strain is 0–21 on Whoop's Borg-derived scale
      makeOrUpdate("strain-sparkline", {
        type: "bar",
        data: { labels, datasets: [{
          data: trend7.map((r) => r.strain_score),
          backgroundColor: COLORS.strain,
          borderWidth: 0,
        }] },
        options: sparkOpts(0, 21),
      });
    }
  }

  // Recent workouts
  renderWorkoutList($("overview-workouts"), overview.recent_workouts || []);

  // HR-today chart
  const labels = today.points.map((p) => p.t.slice(11, 16));
  const data = today.points.map((p) => p.hr);
  makeOrUpdate("hr-today", {
    type: "line",
    data: { labels, datasets: [{
      label: "HR",
      data,
      borderColor: COLORS.recGood,
      backgroundColor: COLORS.recGood + "22",
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.25,
      fill: true,
    }] },
    options: commonOpts(),
  });
}

function drawSleepBarsMini(el, m) {
  const stages = [
    { k: "deep",  v: m.deep_sleep_minutes  || 0, c: COLORS.stage.deep },
    { k: "rem",   v: m.rem_sleep_minutes   || 0, c: COLORS.stage.rem },
    { k: "light", v: m.light_sleep_minutes || 0, c: COLORS.stage.light },
    { k: "wake",  v: m.wake_minutes        || 0, c: COLORS.stage.wake },
  ];
  const total = stages.reduce((a, b) => a + b.v, 0) || 1;
  el.innerHTML = stages.map((s) =>
    `<span style="flex: ${s.v / total}; background:${s.c};"></span>`
  ).join("");
}

function renderWorkoutList(el, workouts) {
  if (!workouts.length) {
    el.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 L 10 14 L 14 17 L 19 8"/><circle cx="6" cy="18" r="1.5" fill="currentColor"/><circle cx="10" cy="14" r="1.5" fill="currentColor"/><circle cx="14" cy="17" r="1.5" fill="currentColor"/><circle cx="19" cy="8" r="1.5" fill="currentColor"/></svg>
      No workouts detected yet
    </div>`;
    return;
  }
  el.innerHTML = workouts.map((w) => {
    const start = new Date(w.start_utc);
    const dur = Math.round((w.duration_seconds || 0) / 60);
    const labelTxt = w.label || "Workout";
    return `<div class="workout-row" data-workout-id="${w.id}">
      <div class="wo-time">${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}<br><span style="opacity:0.6">${dur} min</span></div>
      <div>
        <div class="wo-name workout-label" style="cursor:pointer;" title="Click to rename">${labelTxt}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">avg ${fmtInt(w.avg_hr)} · max ${fmtInt(w.max_hr)} bpm · ${fmtInt(w.calories)} kcal</div>
      </div>
      <div class="wo-strain">${(w.strain ?? 0).toFixed(1)}</div>
    </div>`;
  }).join("");

  // Wire inline label editing.
  el.querySelectorAll(".workout-label").forEach((trigger) => {
    trigger.addEventListener("click", (ev) => {
      const row = ev.target.closest("[data-workout-id]");
      if (!row) return;
      const id = parseInt(row.dataset.workoutId, 10);
      const current = trigger.textContent === "Workout" ? "" : trigger.textContent;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = current;
      inp.placeholder = "e.g. Running";
      inp.style.cssText = "font-size:10px;padding:2px 5px;border-radius:4px;border:1px solid var(--border);background:var(--bg-3);color:var(--fg);width:90px;";
      trigger.replaceWith(inp);
      inp.focus();
      inp.select();
      const save = async () => {
        const label = inp.value.trim();
        try {
          await fetchJSON("/api/workout-label", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, label }),
          });
        } catch {}
        // Re-render by reloading the active tab.
        if (location.hash === "#strain") loadStrain();
        else if (location.hash === "" || location.hash === "#overview") loadOverview();
      };
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); inp.blur(); } else if (e.key === "Escape") inp.blur(); });
    });
  });
}

/* ───────────────────────────── Recovery tab ────────────────────────── */

async function loadRecovery() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/recovery?date=${dateParam}`);
  renderDateNav("recovery-date", data.date ?? dateParam);

  const m = data.summary || {};
  // recovery_score=0 with no HRV is "no data", same as in Overview
  const hasRec = data.summary != null && m.recovery_score != null && m.recovery_score > 0 && m.rmssd_ms != null;
  const recScore = hasRec ? m.recovery_score : null;
  const recColor = recoveryColor(recScore);
  drawRing($("recovery-ring-big"), recScore, recColor, 100, { stroke: 26 });
  if ($("recovery-ring-big-num")) {
    $("recovery-ring-big-num").innerHTML = hasRec
      ? `${Math.round(recScore)}<span class="unit">%</span>`
      : `—<span class="unit">%</span>`;
    $("recovery-ring-big-num").style.color = hasRec ? "var(--text)" : "var(--text-faint)";
  }
  if ($("recovery-state-big")) {
    $("recovery-state-big").textContent = hasRec ? recoveryLabel(recScore).toUpperCase() : "No data yet";
    $("recovery-state-big").style.color = hasRec ? recColor : "var(--text-faint)";
  }
  if ($("recovery-coach")) {
    const coach = hasRec ? (recoveryCoach(recScore) ?? "") : "Wear your strap overnight to compute recovery.";
    $("recovery-coach").textContent = coach;
  }

  // Components
  const comps = [
    { name: "HRV",       v: m.recovery_hrv_component   },
    { name: "Resting HR",v: m.recovery_rhr_component   },
    { name: "Sleep",     v: m.recovery_sleep_component },
    { name: "Prior strain", v: m.recovery_strain_component },
  ];
  // HRV baseline tag line (today vs. 14-day baseline)
  let hrvTagLine = "";
  if (m.rmssd_ms != null && m.hrv_baseline_ms != null) {
    const delta = m.rmssd_ms - m.hrv_baseline_ms;
    const pct = Math.abs(delta / m.hrv_baseline_ms * 100).toFixed(0);
    const sign = delta >= 0 ? "+" : "−";
    const color = delta >= 0 ? COLORS.recGood : COLORS.recBad;
    hrvTagLine = `<div style="font-size:10px;color:var(--muted);margin-bottom:4px;">
      HRV today <strong style="color:var(--fg)">${m.rmssd_ms.toFixed(0)} ms</strong>
      vs. 14-day baseline <strong style="color:var(--fg)">${m.hrv_baseline_ms.toFixed(0)} ms</strong>
      <span style="color:${color}">(${sign}${pct}%)</span>
    </div>`;
  }
  // Resting HR baseline tag line — computed from trend data (prior days only)
  let rhrTagLine = "";
  if (m.resting_hr != null) {
    const trend = data.trend || [];
    const rhrHist = trend.slice(0, -1).map((r) => r.resting_hr).filter((v) => v != null);
    if (rhrHist.length >= 3) {
      const rhrBase = rhrHist.reduce((a, b) => a + b, 0) / rhrHist.length;
      const delta = m.resting_hr - rhrBase;
      const sign = delta >= 0 ? "+" : "−";
      // Elevated RHR is a bad sign; lower is good.
      const color = delta > 3 ? COLORS.recBad : delta < -3 ? COLORS.recGood : COLORS.muted;
      rhrTagLine = `<div style="font-size:10px;color:var(--muted);margin-bottom:4px;">
        RHR today <strong style="color:var(--fg)">${Math.round(m.resting_hr)} bpm</strong>
        vs. 14-day baseline <strong style="color:var(--fg)">${Math.round(rhrBase)} bpm</strong>
        <span style="color:${color}">(${sign}${Math.abs(delta).toFixed(1)} bpm)</span>
      </div>`;
    }
  }
  // Skin temp baseline tag line (today vs. 14-day baseline)
  let skinTagLine = "";
  if (m.avg_skin_temp_c != null && m.skin_temp_deviation_c != null) {
    const dev = m.skin_temp_deviation_c;
    const sign = dev >= 0 ? "+" : "−";
    const color = Math.abs(dev) > 0.5 ? (dev > 0 ? COLORS.recMid : COLORS.strain) : COLORS.muted;
    skinTagLine = `<div style="font-size:10px;color:var(--muted);margin-bottom:8px;">
      Skin temp <strong style="color:var(--fg)">${m.avg_skin_temp_c.toFixed(1)}°C</strong>
      (<span style="color:${color}">${sign}${Math.abs(dev).toFixed(2)}°C vs. baseline</span>)
    </div>`;
  }
  $("recovery-components").innerHTML = hrvTagLine + rhrTagLine + skinTagLine + comps.map((c) => `
    <div class="component-row">
      <div class="name">${c.name}</div>
      <div class="barwrap"><div class="bar" style="width:${c.v == null ? 0 : Math.max(0, Math.min(100, c.v))}%;background:${recoveryColor(c.v)}"></div></div>
      <div class="val">${c.v == null ? "—" : Math.round(c.v)}</div>
    </div>
  `).join("");

  // Trend charts
  const trend = data.trend || [];
  const labels = trend.map((r) => r.date.slice(5));

  // 30-day recovery score chart with color-coded bars (green/yellow/red zones)
  const recScores = trend.map((r) => r.recovery_score);
  makeOrUpdate("recovery-30d", {
    type: "bar",
    data: { labels, datasets: [{
      label: "Recovery %",
      data: recScores,
      backgroundColor: recScores.map((v) =>
        v == null ? "transparent"
        : v >= 67 ? COLORS.recGood
        : v >= 33 ? COLORS.recMid
        : COLORS.recBad
      ),
      borderWidth: 0,
    }] },
    options: commonOpts({
      scales: {
        x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
        y: { min: 0, max: 100, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
      },
    }),
  });

  makeOrUpdate("hrv-30d", {
    type: "line",
    data: { labels, datasets: [{
      label: "RMSSD (ms)", data: trend.map((r) => r.rmssd_ms),
      borderColor: COLORS.recGood, backgroundColor: COLORS.recGood + "22",
      tension: 0.3, pointRadius: 2, borderWidth: 1.5, fill: true,
    }] },
    options: commonOpts(),
  });
  makeOrUpdate("rhr-30d", {
    type: "line",
    data: { labels, datasets: [{
      label: "Resting HR (bpm)", data: trend.map((r) => r.resting_hr),
      borderColor: COLORS.strain, backgroundColor: COLORS.strain + "22",
      tension: 0.3, pointRadius: 2, borderWidth: 1.5, fill: true,
    }] },
    options: commonOpts(),
  });
  makeOrUpdate("temp-30d", {
    type: "bar",
    data: { labels, datasets: [{
      label: "Δ°C vs baseline",
      data: trend.map((r) => r.skin_temp_deviation_c),
      backgroundColor: trend.map((r) => (r.skin_temp_deviation_c ?? 0) > 0 ? COLORS.recMid : COLORS.strain),
    }] },
    options: commonOpts(),
  });

  // Poincaré plot is rendered by app-mvp.js — notify it to refresh.
  window.dispatchEvent(new CustomEvent("whoop-tab-recovery"));
}

/* ───────────────────────────── Sleep tab ───────────────────────────── */

async function loadSleep() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/sleep?date=${dateParam}`);
  renderDateNav("sleep-date", data.date ?? dateParam);

  const m = data.summary || {};
  drawHypnogram($("hypnogram"), data.stages);
  $("hypnogram-legend").innerHTML = ["wake", "light", "rem", "deep"].map((s) =>
    `<span><span class="swatch" style="background:${COLORS.stage[s]}"></span>${s}</span>`
  ).join("");

  // Treat sleep_minutes ≤ 0 as "no real sleep data" (rollup writes zeros)
  const hasSleep = m.sleep_minutes != null && m.sleep_minutes > 0;

  $("sleep-total").textContent = hasSleep ? fmtHM(m.sleep_minutes) : "—";
  $("sleep-performance").textContent = hasSleep ? (m.sleep_performance_pct ?? "—") : "—";
  $("sleep-need-line").textContent = (hasSleep && m.sleep_need_minutes)
    ? `need ${fmtHM(m.sleep_need_minutes)}`
    : (m.sleep_need_minutes ? `need ${fmtHM(m.sleep_need_minutes)}` : "");
  const debt = m.sleep_debt_minutes;
  $("sleep-debt").textContent = debt == null ? "—" : (debt / 60).toFixed(1);
  $("sleep-consistency").textContent = hasSleep ? (m.sleep_consistency_pct ?? "—") : "—";
  $("sleep-resp").textContent = hasSleep ? (m.respiratory_rate ?? "—") : "—";
  $("sleep-spo2").textContent = hasSleep ? (m.avg_spo2 ?? "—") : "—";

  // Quality score (composite) — suppress when no sleep
  const quality = hasSleep ? (data.quality || {}) : {};
  if ($("sleep-quality")) {
    $("sleep-quality").textContent = quality.score ?? "—";
    if (quality.score != null) {
      const colorFor = (v) => v >= 80 ? COLORS.recGood : v >= 60 ? COLORS.recMid : COLORS.recBad;
      $("sleep-quality").style.color = colorFor(quality.score);
    } else {
      $("sleep-quality").style.color = "var(--text-faint)";
    }
    const labels = {
      performance: "Need fulfillment",
      efficiency:  "Efficiency",
      restorative: "Restorative",
      consistency: "Consistency",
      debt:        "Debt",
    };
    $("sleep-quality-breakdown").innerHTML = Object.entries(quality.breakdown || {})
      .map(([k, v]) => `<div>${labels[k] || k}</div><div style="text-align:right; font-weight:600; color:var(--fg2);">${v}</div>`)
      .join("");
  }

  // Bedtime / wake time: stored as local ISO 'YYYY-MM-DDTHH:MM', display as HH:MM.
  function fmtLocalIso(iso) {
    if (!iso) return "—";
    const t = iso.slice(11, 16); // HH:MM part
    if (!t) return "—";
    try {
      const [h, min] = t.split(":").map(Number);
      const d = new Date(2000, 0, 1, h, min);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch { return t; }
  }
  if ($("sleep-bedtime")) $("sleep-bedtime").textContent = fmtLocalIso(m.bedtime_local);
  if ($("sleep-wake"))    $("sleep-wake").textContent    = fmtLocalIso(m.wake_local);

  // Stage breakdown bars
  const stages = [
    { k: "Deep",  v: m.deep_sleep_minutes  || 0, c: COLORS.stage.deep },
    { k: "REM",   v: m.rem_sleep_minutes   || 0, c: COLORS.stage.rem },
    { k: "Light", v: m.light_sleep_minutes || 0, c: COLORS.stage.light },
    { k: "Wake",  v: m.wake_minutes        || 0, c: COLORS.stage.wake },
  ];
  const tot = stages.reduce((a, b) => a + b.v, 0) || 1;
  $("stage-bars").innerHTML = stages.map((s) => `
    <div class="row">
      <div class="lbl">${s.k}</div>
      <div class="barwrap"><div class="bar" style="width:${s.v / tot * 100}%;background:${s.c}"></div></div>
      <div class="v">${fmtHM(s.v)}</div>
    </div>
  `).join("");

  // Sleep trend charts
  const trend = data.trend || [];
  const tLabels = trend.map((r) => r.date.slice(5));
  makeOrUpdate("sleep-trend", {
    type: "bar",
    data: {
      labels: tLabels,
      datasets: [
        { label: "Deep",  data: trend.map((r) => r.deep_sleep_minutes  ?? 0), backgroundColor: COLORS.stage.deep,  stack: "s" },
        { label: "REM",   data: trend.map((r) => r.rem_sleep_minutes   ?? 0), backgroundColor: COLORS.stage.rem,   stack: "s" },
        { label: "Light", data: trend.map((r) => r.light_sleep_minutes ?? 0), backgroundColor: COLORS.stage.light, stack: "s" },
      ],
    },
    options: commonOpts({
      scales: {
        x: { stacked: true, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
        y: { stacked: true, ticks: { color: COLORS.muted, callback: (v) => fmtHM(v) }, grid: { color: COLORS.border } },
      },
    }),
  });
  makeOrUpdate("sleep-rr-trend", {
    type: "line",
    data: { labels: tLabels, datasets: [{
      label: "RR (breaths/min)", data: trend.map((r) => r.respiratory_rate),
      borderColor: COLORS.recMid, backgroundColor: COLORS.recMid + "22",
      tension: 0.3, pointRadius: 2, borderWidth: 1.5, fill: true,
    }] },
    options: commonOpts(),
  });

  // 30-day quality-score bars (same color zones as Quality card)
  const qScores = trend.map((r) => r.quality_score);
  makeOrUpdate("sleep-quality-trend", {
    type: "bar",
    data: { labels: tLabels, datasets: [{
      label: "Quality /100",
      data: qScores,
      backgroundColor: qScores.map((v) =>
        v == null ? "transparent"
        : v >= 80 ? COLORS.recGood
        : v >= 60 ? COLORS.recMid
        : COLORS.recBad
      ),
      borderWidth: 0,
    }] },
    options: commonOpts({
      scales: {
        x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
        y: { min: 0, max: 100, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
      },
    }),
  });
}

/* ───────────────────────────── Strain tab ──────────────────────────── */

async function loadStrain() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/strain?date=${dateParam}`);
  renderDateNav("strain-date", data.date ?? dateParam);
  const m = data.summary || {};
  // Hero ring
  if ($("strain-hero-ring")) {
    drawRing($("strain-hero-ring"), m.strain_score, "#03B5F3", 21, { stroke: 22, colorTo: "#00D4FF" });
  }
  $("strain-big").textContent = m.strain_score == null ? "—" : m.strain_score.toFixed(1);
  $("strain-label").textContent = m.strain_score == null ? "no activity yet" : strainLabel(m.strain_score).toUpperCase();
  if ($("strain-label")) $("strain-label").style.color = m.strain_score == null ? "var(--text-faint)" : "var(--strain)";
  if ($("strain-target")) {
    const coach = recoveryCoach(m.recovery_score);
    $("strain-target").textContent = coach ? `Based on recovery: ${coach.split("·")[1]?.trim() ?? ""}` : "";
  }
  $("strain-cals").textContent = fmtInt(m.calories);

  // Zones row — modernised with vertical bars + labels
  const zoneMins = (m && m.zone_minutes) || [0, 0, 0, 0, 0];
  const maxZ = Math.max(...zoneMins, 1);
  const zoneColors = [COLORS.zone[0], COLORS.zone[1], COLORS.zone[2], COLORS.zone[3], COLORS.zone[4]];
  const zoneRow = $("zones-row");
  zoneRow.innerHTML = ["Z1", "Z2", "Z3", "Z4", "Z5"].map((nm, i) => `
    <div class="zone-cell">
      <div style="height:60px; display:flex; align-items:end; justify-content:center; margin-bottom:8px;">
        <div style="width:18px; height:${Math.max(4, (zoneMins[i] / maxZ) * 60)}px; background:${zoneColors[i]}; border-radius:4px; box-shadow:0 0 12px ${zoneColors[i]}66;"></div>
      </div>
      <div class="zlbl">${nm}</div>
      <div class="zval">${fmtHM(zoneMins[i])}</div>
      <div style="font-size:9px; color:var(--text-faint); margin-top:2px;">${zonePctLabel(i)}</div>
    </div>
  `).join("");

  drawZonesDonut($("zones-donut"), zoneMins);

  // Strain curve
  const curve = data.curve || [];
  const labels = curve.map((p) => p.t.slice(11, 16));
  makeOrUpdate("strain-curve", {
    type: "line",
    data: { labels, datasets: [{
      label: "Cumulative strain",
      data: curve.map((p) => p.strain),
      borderColor: COLORS.strain,
      backgroundColor: COLORS.strain + "22",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.2,
      fill: true,
    }] },
    options: commonOpts({ scales: { x: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } }, y: { min: 0, max: 21, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } } } }),
  });

  renderWorkoutList($("strain-workouts"), data.workouts || []);

  // 30-day strain trend bars
  const trend = data.trend || [];
  if (trend.length && $("strain-30d")) {
    const tLabels = trend.map((r) => r.date.slice(5));
    const tData = trend.map((r) => r.strain_score);
    makeOrUpdate("strain-30d", {
      type: "bar",
      data: { labels: tLabels, datasets: [{
        label: "Strain /21",
        data: tData,
        backgroundColor: tData.map((v) => v == null ? "transparent" : COLORS.strain),
        borderWidth: 0,
      }] },
      options: commonOpts({
        scales: {
          x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
          y: { min: 0, max: 21, ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
        },
      }),
    });
  }

  // ACWR card
  const acwr = data.acwr;
  if ($("acwr-ratio")) {
    if (acwr) {
      $("acwr-ratio").textContent = acwr.ratio.toFixed(2);
      const bandStyles = {
        'sweet-spot': { label: "SWEET SPOT", color: COLORS.recGood },
        'elevated':   { label: "ELEVATED",   color: COLORS.recMid  },
        'high-risk':  { label: "HIGH RISK",  color: COLORS.recBad  },
        'detraining': { label: "DETRAINING", color: COLORS.muted   },
      };
      const b = bandStyles[acwr.band] || bandStyles['sweet-spot'];
      $("acwr-band").textContent = b.label;
      $("acwr-band").style.color = b.color;
      $("acwr-ratio").style.color = b.color;
      $("acwr-detail").textContent =
        `acute ${acwr.acute.toFixed(1)} · chronic ${acwr.chronic.toFixed(1)} · target 0.8–1.3`;
    } else {
      $("acwr-ratio").textContent = "—";
      $("acwr-band").textContent = "need 10+ days of strain data";
      $("acwr-band").style.color = "var(--muted)";
      $("acwr-detail").textContent = "";
    }
  }
}

function zonePctLabel(i) {
  return ["50-60%", "60-70%", "70-80%", "80-90%", "90+%"][i];
}

/* ───────────────────────────── Trends tab ──────────────────────────── */

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function loadTrends() {
  const metric = $("trend-metric").value;
  const days = parseInt($("trend-days").value, 10);
  const [trend, history] = await Promise.all([
    fetchJSON(`/api/trends?metric=${metric}&days=${days}`),
    fetchJSON(`/api/history?days=${days}`),
  ]);
  $("trend-title").textContent = `${metricLabel(metric)} · ${days} days`;

  const labels = trend.series.map((r) => r.date.slice(5));
  const rawValues = trend.series.map((r) => r.value);

  // 7-day centred rolling average overlay.
  const W = 7;
  const rolling = rawValues.map((_, i) => {
    const half = Math.floor(W / 2);
    const lo = Math.max(0, i - half);
    const hi = Math.min(rawValues.length, i + half + 1);
    const window = rawValues.slice(lo, hi).filter((v) => v != null);
    return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
  });

  makeOrUpdate("trend-main", {
    type: "line",
    data: { labels, datasets: [
      {
        label: metricLabel(metric),
        data: rawValues,
        borderColor: metricColor(metric),
        backgroundColor: metricColor(metric) + "22",
        borderWidth: 1.5,
        pointRadius: 1.5,
        tension: 0.2,
        fill: true,
        order: 2,
      },
      {
        label: "7-day avg",
        data: rolling,
        borderColor: metricColor(metric),
        backgroundColor: "transparent",
        borderWidth: 2.5,
        borderDash: [4, 3],
        pointRadius: 0,
        tension: 0.4,
        fill: false,
        order: 1,
      },
    ] },
    options: commonOpts(),
  });

  const wd = trend.weekday_averages || {};
  makeOrUpdate("trend-weekday", {
    type: "bar",
    data: {
      labels: WEEKDAY_LABELS,
      datasets: [{
        label: metricLabel(metric),
        data: WEEKDAY_LABELS.map((_, i) => wd[i]),
        backgroundColor: metricColor(metric),
      }],
    },
    options: commonOpts(),
  });

  renderTrendsTable(history.days || []);
  renderPersonalRecords();
}

async function renderPersonalRecords() {
  const el = $("personal-records");
  if (!el) return;
  try {
    const prs = await fetchJSON("/api/personal-records");
    const items = [
      { label: "Best HRV",         pr: prs.hrv_max,        fmt: (v) => v.toFixed(0) + " ms",  color: COLORS.recGood  },
      { label: "Lowest RHR",       pr: prs.rhr_min,        fmt: (v) => v.toFixed(0) + " bpm", color: COLORS.strain   },
      { label: "Peak recovery",    pr: prs.recovery_max,   fmt: (v) => v.toFixed(0) + "%",     color: COLORS.recGood  },
      { label: "Longest sleep",    pr: prs.sleep_max_min,  fmt: (v) => fmtHM(v),               color: COLORS.stage.deep },
      { label: "Peak strain",      pr: prs.strain_max,     fmt: (v) => v.toFixed(1) + "/21",   color: COLORS.recMid   },
      { label: "Best sleep perf",  pr: prs.sleep_perf_max, fmt: (v) => v.toFixed(0) + "%",     color: COLORS.recGood  },
    ];
    el.innerHTML = items.map(({ label, pr, fmt, color }) => {
      if (!pr) return `<div style="background:var(--card-bg2);border-radius:8px;padding:10px 12px;"><div style="font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;">${label}</div><div style="font-size:20px;font-weight:700;color:var(--muted);margin-top:2px;">—</div></div>`;
      return `<div style="background:var(--card-bg2);border-radius:8px;padding:10px 12px;">
        <div style="font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase;">${label}</div>
        <div style="font-size:20px;font-weight:700;color:${color};margin-top:2px;">${fmt(pr.value)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:1px;">${pr.date}</div>
      </div>`;
    }).join("");
  } catch (e) {
    console.warn("[personal-records]", e);
  }
}

function metricLabel(m) {
  return {
    recovery_score: "Recovery",
    rmssd_ms: "HRV (RMSSD ms)",
    resting_hr: "Resting HR",
    strain_score: "Strain",
    sleep_minutes: "Sleep (min)",
    sleep_performance_pct: "Sleep performance %",
    sleep_debt_minutes: "Sleep debt (min)",
    avg_hr: "Avg HR",
    avg_spo2: "SpO₂",
    skin_temp_deviation_c: "Skin temp Δ°C",
    respiratory_rate: "Respiratory rate",
    calories: "Calories",
    stress_avg: "Stress avg",
  }[m] || m;
}
function metricColor(m) {
  if (m.includes("recovery") || m.includes("rmssd") || m.includes("sleep_performance")) return COLORS.recGood;
  if (m.includes("strain") || m.includes("calories")) return COLORS.strain;
  if (m.includes("sleep")) return COLORS.sleep;
  if (m.includes("stress")) return COLORS.recBad;
  return COLORS.fg2;
}

function renderTrendsTable(days) {
  const cols = [
    ["date", "Date"], ["recovery_score", "Rec"], ["strain_score", "Strain"],
    ["rmssd_ms", "HRV"], ["resting_hr", "RHR"], ["sleep_minutes", "Sleep"],
    ["sleep_performance_pct", "Sleep %"], ["sleep_debt_minutes", "Debt"],
    ["respiratory_rate", "Resp"], ["avg_spo2", "SpO₂"],
    ["skin_temp_deviation_c", "Δ°C"], ["calories", "kcal"],
  ];
  const head = `<thead><tr>${cols.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead>`;
  const body = `<tbody>${days.map((d) => `
    <tr>${cols.map(([k]) => {
      let v = d[k];
      if (k === "date") v = v;
      else if (k === "sleep_minutes") v = v ? fmtHM(v) : "—";
      else if (k === "sleep_debt_minutes") v = v != null ? fmtHM(v) : "—";
      else if (typeof v === "number") v = k === "rmssd_ms" || k === "resting_hr" || k === "calories" ? Math.round(v) : v.toFixed(1);
      else if (v == null) v = "—";
      return `<td>${v}</td>`;
    }).join("")}</tr>
  `).join("")}</tbody>`;
  $("trends-table").innerHTML = head + body;
}

/* ───────────────────────────── Live tab ────────────────────────────── */

async function loadLive() {
  const data = await fetchJSON("/api/live?seconds=300");
  const last = data.latest_sample;
  if (last) {
    $("live-hr").textContent = fmtInt(last.heart_rate_bpm);
    $("live-spo2").textContent = last.spo2_pct ?? "—";
    $("live-temp").textContent = last.skin_temp_c != null ? last.skin_temp_c.toFixed(1) : "—";
    const ago = Math.round((Date.now() - new Date(last.ts_utc)) / 1000);
    $("live-status").textContent = ago < 60 ? `last sample ${ago}s ago` : `last sample ${Math.round(ago / 60)}m ago`;
  } else {
    $("live-status").textContent = "no samples yet";
  }
  $("live-battery").textContent = data.battery ? data.battery.detail : "—";

  const labels = data.points.map((p) => p.t.slice(11, 19));
  makeOrUpdate("live-chart", {
    type: "line",
    data: { labels, datasets: [{
      label: "HR",
      data: data.points.map((p) => p.hr),
      borderColor: COLORS.recGood,
      backgroundColor: COLORS.recGood + "22",
      pointRadius: 0,
      borderWidth: 1.5,
      tension: 0.25,
      fill: true,
    }] },
    options: commonOpts(),
  });

  $("live-events").innerHTML = (data.events || []).map((e) => {
    const t = new Date(e.ts_utc).toLocaleTimeString();
    return `<div class="ev"><span class="kind">${e.kind}</span> ${e.detail || ""}<span style="float:right;color:${COLORS.muted}">${t}</span></div>`;
  }).join("") || `<div class="muted">no events</div>`;

  const sampleRate = data.points.length / 300;
  $("live-stats").innerHTML = `
    <div class="row"><span class="k">Points in window</span><span class="v">${data.points.length}</span></div>
    <div class="row"><span class="k">Effective rate</span><span class="v">${sampleRate.toFixed(2)} Hz</span></div>
    <div class="row"><span class="k">Server time</span><span class="v">${new Date(data.now_utc).toLocaleTimeString()}</span></div>
  `;
}

/* ───────────────────────────── Settings drawer ─────────────────────── */

function initDrawer() {
  const drawer = $("settings-drawer");
  const backdrop = $("drawer-backdrop");
  function open() {
    drawer.classList.add("open");
    backdrop.classList.add("open");
    loadProfile();
  }
  function close() {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
  }
  $("open-settings").addEventListener("click", open);
  $("close-settings").addEventListener("click", close);
  backdrop.addEventListener("click", close);

  $("settings-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const payload = {};
    for (const [k, v] of f.entries()) {
      payload[k] = v === "" ? null : v;
    }
    await fetchJSON("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    close();
    refreshAll();
  });

  $("recompute-btn").addEventListener("click", async () => {
    $("recompute-btn").textContent = "Recomputing…";
    try {
      await fetchJSON("/api/recompute", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      $("recompute-btn").textContent = "Done";
    } catch (e) {
      $("recompute-btn").textContent = "Error: " + e.message;
    }
    setTimeout(() => { $("recompute-btn").textContent = "Recompute last 7 days"; }, 1800);
    refreshAll();
  });
}

async function loadProfile() {
  const p = await fetchJSON("/api/profile");
  const form = $("settings-form");
  form.age.value = p.age ?? "";
  form.sex.value = p.sex ?? "";
  form.weight_kg.value = p.weight_kg ?? "";
  form.height_cm.value = p.height_cm ?? "";
  form.max_hr_override.value = p.max_hr_override ?? "";
}

/* ───────────────────────────── Trends control ──────────────────────── */

function initTrendsControls() {
  ["trend-metric", "trend-days"].forEach((id) =>
    $(id).addEventListener("change", () => loadTrends().catch((e) => setStatus("error: " + e.message))));
  const btn = $("export-csv");
  if (btn) btn.addEventListener("click", () => exportDailyMetricsCsv().catch((e) => setStatus("export failed: " + e.message)));

  // Copy weekly summary text to clipboard
  const copyBtn = $("copy-weekly");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = $("weekly-summary-text")?.textContent?.trim();
      if (!text || text === "Loading…") {
        setStatus("nothing to copy yet");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        const original = copyBtn.textContent;
        copyBtn.textContent = "✓ Copied";
        setTimeout(() => { copyBtn.textContent = original; }, 1500);
      } catch (e) {
        setStatus("clipboard failed: " + e.message);
      }
    });
  }
}

/**
 * Fetch all daily_metrics rows and download them as a CSV file.
 * Pure client-side — no upload anywhere.
 */
async function exportDailyMetricsCsv() {
  const { days } = await fetchJSON("/api/history?days=3650");
  if (!days || !days.length) {
    setStatus("no data to export");
    return;
  }
  // Union of all keys across rows, sorted with 'date' first.
  const keySet = new Set();
  for (const row of days) Object.keys(row).forEach((k) => keySet.add(k));
  const keys = ["date", ...Array.from(keySet).filter((k) => k !== "date").sort()];

  function escapeCell(v) {
    if (v == null) return "";
    const s = Array.isArray(v) ? v.join("|") : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  const header = keys.join(",");
  const rows = days.map((row) => keys.map((k) => escapeCell(row[k])).join(","));
  const csv = [header, ...rows].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `whoopfree-daily-metrics-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus(`exported ${days.length} day${days.length === 1 ? "" : "s"} to CSV`);
}

/* ───────────────────────────── Boot ────────────────────────────────── */

async function refreshAll() {
  await refreshStatus();
  await loadActiveTab().catch((e) => setStatus("error: " + e.message));
}

function init() {
  initTabs();
  initDrawer();
  initTrendsControls();
  // Persistent topbar date (independent of which tab the user is on)
  const td = new Date();
  if ($("topbar-date")) {
    $("topbar-date").textContent = `Today · ${td.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  refreshAll();
  setInterval(refreshAll, 10000);
  // Allow other modules (app-mvp.js, etc.) to trigger a re-render when they
  // mutate IndexedDB.
  window.addEventListener("whoop-data-changed", () => refreshAll());
  // Recovery calendar cell click: jump to Recovery tab for that date.
  // Set _browseDate AFTER setTab because setTab resets it on tab switch.
  window.addEventListener("whoop-browse-recovery", (e) => {
    setTab("recovery");          // switches tab (resets _browseDate to null)
    _browseDate = e.detail.date; // override with the clicked date
    loadRecovery().catch(() => {}); // re-render with the overridden date
  });
}

// Expose so the BLE/seed module can poke us after writing data.
window.refreshAll = refreshAll;

document.addEventListener("DOMContentLoaded", init);
