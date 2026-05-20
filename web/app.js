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
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) =>
    p.classList.toggle("active", p.dataset.panel === name));
  history.replaceState(null, "", "#" + name);
  loadActiveTab().catch((e) => setStatus("error: " + e.message));
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((b) =>
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
  charts[id] = new Chart($(id), cfg);
}
function commonOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: { legend: { labels: { color: COLORS.fg2 } } },
    scales: {
      x: { ticks: { color: COLORS.muted, maxRotation: 0, autoSkip: true }, grid: { color: COLORS.border } },
      y: { ticks: { color: COLORS.muted }, grid: { color: COLORS.border } },
    },
    ...extra,
  };
}

/* ───────────────────────────── Recovery ring (SVG) ─────────────────── */

function drawRecoveryRing(svg, score, big = false) {
  const color = recoveryColor(score);
  const size = big ? 280 : 200;
  const cx = size / 2, cy = size / 2;
  const r = big ? 110 : 78;
  const stroke = big ? 22 : 16;
  const startAngle = -225, endAngle = 45; // 270° arc
  const total = endAngle - startAngle;
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score)) / 100;

  function pt(angleDeg, radius) {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
  }
  function arcPath(a0, a1, radius) {
    const [x0, y0] = pt(a0, radius);
    const [x1, y1] = pt(a1, radius);
    const largeArc = (a1 - a0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1}`;
  }

  const trackPath = arcPath(startAngle, endAngle, r);
  const fillPath = arcPath(startAngle, startAngle + total * pct, r);

  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.innerHTML = `
    <path d="${trackPath}" fill="none" stroke="${COLORS.border}" stroke-width="${stroke}" stroke-linecap="round" />
    ${pct > 0 ? `<path d="${fillPath}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" />` : ""}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${COLORS.fg}" style="font-size:${big ? 64 : 48}px;font-weight:600;font-family:inherit;dominant-baseline:middle;">
      ${score == null ? "—" : Math.round(score)}
    </text>
    <text x="${cx}" y="${cy + (big ? 42 : 30)}" text-anchor="middle" fill="${COLORS.muted}" style="font-size:${big ? 13 : 11}px;letter-spacing:1.5px;text-transform:uppercase;">
      Recovery
    </text>
  `;
}

function drawGaugeRing(svg, score, color, formatFn = (x) => Math.round(x).toString(), maxVal = 100) {
  if (!svg) return;
  const size = 150;
  const cx = size / 2, cy = size / 2;
  const r = 56;
  const stroke = 10;
  const startAngle = -225, endAngle = 45; // 270° arc
  const total = endAngle - startAngle;
  const pct = score == null ? 0 : Math.max(0, Math.min(maxVal, score)) / maxVal;

  function pt(angleDeg, radius) {
    const a = (angleDeg * Math.PI) / 180;
    return [cx + Math.cos(a) * radius, cy + Math.sin(a) * radius];
  }
  function arcPath(a0, a1, radius) {
    const [x0, y0] = pt(a0, radius);
    const [x1, y1] = pt(a1, radius);
    const largeArc = (a1 - a0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${largeArc} 1 ${x1} ${y1}`;
  }

  const trackPath = arcPath(startAngle, endAngle, r);
  const fillPath = arcPath(startAngle, startAngle + total * pct, r);

  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.innerHTML = `
    <path d="${trackPath}" fill="none" stroke="${COLORS.border}" stroke-width="${stroke}" stroke-linecap="round" opacity="0.3" />
    ${pct > 0 ? `<path d="${fillPath}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" />` : ""}
    <text x="${cx}" y="${cy}" text-anchor="middle" fill="${COLORS.fg}" style="font-size:32px;font-weight:700;font-family:inherit;dominant-baseline:central;">
      ${score == null ? "—" : formatFn(score)}
    </text>
  `;
}

/* ───────────────────────────── Hypnogram (SVG) ─────────────────────── */

const STAGE_ORDER = ["wake", "rem", "light", "deep"]; // top→bottom

function drawHypnogram(svg, stages) {
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

  $("overview-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric",
  });

  const m = overview.metrics || {};
  
  // Sleep Ring
  if ($("sleep-ring")) {
    drawGaugeRing($("sleep-ring"), m.sleep_performance_pct, "#ff9f0a", (x) => Math.round(x) + "%", 100);
    const asleep = m.sleep_minutes || 0;
    const hours = Math.floor(asleep / 60), mins = asleep % 60;
    $("sleep-perf").textContent = m.sleep_performance_pct != null
      ? `${hours}h ${mins}m · ${m.sleep_performance_pct}% need`
      : "no sleep recorded";
  }

  // Recovery Ring
  if ($("recovery-ring")) {
    drawGaugeRing($("recovery-ring"), m.recovery_score, recoveryColor(m.recovery_score), (x) => Math.round(x) + "%", 100);
    $("recovery-meta").textContent = m.recovery_score == null
      ? "needs overnight data"
      : `HRV ${fmtInt(m.rmssd_ms)}ms · RHR ${fmtInt(m.resting_hr)} bpm`;
  }

  // Strain Ring
  if ($("strain-ring")) {
    const strain = m.strain_score ?? 0;
    drawGaugeRing($("strain-ring"), m.strain_score, "#0a84ff", (x) => (x ?? 0).toFixed(1), 21);
    $("strain-meta").textContent = m.strain_score == null
      ? "no activity yet"
      : `${strainLabel(strain)} · ${fmtInt(m.calories)} kcal`;
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
    el.innerHTML = `<div class="empty-row">No workouts detected yet.</div>`;
    return;
  }
  el.innerHTML = workouts.map((w) => {
    const start = new Date(w.start_utc);
    const dur = Math.round((w.duration_seconds || 0) / 60);
    const labelHtml = w.label
      ? `<span class="pill workout-label" style="cursor:pointer;" title="Click to rename">${w.label}</span>`
      : `<span class="workout-label-add" data-id="${w.id}" style="font-size:10px;color:var(--muted);cursor:pointer;" title="Add label">✎ label</span>`;
    return `<div class="workout-row" data-workout-id="${w.id}">
      <div>
        <div>${start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</div>
        <div class="when">${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${dur} min</div>
        ${labelHtml}
      </div>
      <div class="pill">avg ${fmtInt(w.avg_hr)} bpm</div>
      <div class="pill">max ${fmtInt(w.max_hr)}</div>
      <div class="pill">${fmtInt(w.calories)} kcal</div>
      <div class="strain-num">${(w.strain ?? 0).toFixed(1)}</div>
    </div>`;
  }).join("");

  // Wire inline label editing.
  el.querySelectorAll(".workout-label, .workout-label-add").forEach((trigger) => {
    trigger.addEventListener("click", (ev) => {
      const row = ev.target.closest("[data-workout-id]");
      if (!row) return;
      const id = parseInt(row.dataset.workoutId, 10);
      const current = trigger.classList.contains("pill") ? trigger.textContent : "";
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
  const noData = data.summary == null;
  drawRecoveryRing($("recovery-ring-big"), m.recovery_score, true);
  $("recovery-state-big").textContent = noData ? "No data for this date" : recoveryLabel(m.recovery_score);

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

  $("sleep-total").textContent = fmtHM(m.sleep_minutes);
  $("sleep-performance").textContent = m.sleep_performance_pct ?? "—";
  $("sleep-need-line").textContent = m.sleep_need_minutes
    ? `need ${fmtHM(m.sleep_need_minutes)}`
    : "";
  const debt = m.sleep_debt_minutes;
  $("sleep-debt").textContent = debt == null ? "—" : (debt / 60).toFixed(1);
  $("sleep-consistency").textContent = m.sleep_consistency_pct ?? "—";
  $("sleep-resp").textContent = m.respiratory_rate ?? "—";
  $("sleep-spo2").textContent = m.avg_spo2 ?? "—";

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
}

/* ───────────────────────────── Strain tab ──────────────────────────── */

async function loadStrain() {
  const dateParam = _browseDate ?? todayIso();
  const data = await fetchJSON(`/api/strain?date=${dateParam}`);
  renderDateNav("strain-date", data.date ?? dateParam);
  const m = data.summary || {};
  $("strain-big").textContent = m.strain_score == null ? "—" : m.strain_score.toFixed(1);
  $("strain-label").textContent = strainLabel(m.strain_score);
  $("strain-cals").textContent = fmtInt(m.calories);

  // Zones row
  const zoneMins = (m && m.zone_minutes) || [0, 0, 0, 0, 0];
  const zoneRow = $("zones-row");
  zoneRow.innerHTML = ["Z1", "Z2", "Z3", "Z4", "Z5"].map((nm, i) => `
    <div class="z z${i + 1}">
      <div class="name">${nm}</div>
      <div class="v">${fmtHM(zoneMins[i])}</div>
      <div class="sub">${zonePctLabel(i)}</div>
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
  makeOrUpdate("trend-main", {
    type: "line",
    data: { labels, datasets: [{
      label: metricLabel(metric),
      data: trend.series.map((r) => r.value),
      borderColor: metricColor(metric),
      backgroundColor: metricColor(metric) + "22",
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.3,
      fill: true,
    }] },
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
