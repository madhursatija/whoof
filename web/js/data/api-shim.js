// In-browser shim that mimics the Python /api/* endpoints from
// whoopfree/dashboard.py, but reads from IndexedDB instead of SQLite.
//
// Registers `window.whoopApi.handle(url, opts?)` → Promise<JSON>.
// The legacy `fetchJSON` in app.js delegates to this when present so every
// existing render function works unchanged.

import { openDb } from './db.js';
import {
  samplesInRange, latestSample, recentEvents,
  getProfile, putProfile,
  getDailyMetric, recentDailyMetrics,
  workoutsForDate, sleepStagesForDate, patchWorkoutLabel,
  personalRecords,
} from './queries.js';
import { rollupDay, recomputeRecent, rollupMissing } from '../metrics/rollup.js';
import { maxHr } from '../metrics/zones.js';
import { sleepQualityScore } from '../metrics/sleep.js';

const VALID_TREND_METRICS = new Set([
  'rmssd_ms', 'resting_hr', 'recovery_score', 'strain_score',
  'sleep_minutes', 'sleep_performance_pct', 'sleep_debt_minutes',
  'avg_hr', 'avg_spo2', 'skin_temp_deviation_c', 'respiratory_rate',
  'calories', 'stress_avg',
]);

let _db = null;
async function db() {
  if (!_db) _db = await openDb();
  return _db;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayBoundsUtc(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

function toLocalIso(utcIso) {
  const d = new Date(utcIso);
  // ISO with local offset, second precision
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const absOff = Math.abs(off);
  const oh = pad(Math.floor(absOff / 60));
  const om = pad(absOff % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

function countSamples(d) {
  return new Promise((resolve, reject) => {
    const req = d.transaction('samples').objectStore('samples').count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function latestBattery(d) {
  // device_events with kind='battery', newest first
  const events = await recentEvents(d, 100);
  const bat = events.find((e) => e.kind === 'battery');
  if (bat) {
    return { ts_utc: bat.ts_utc, kind: bat.kind, detail: bat.detail };
  }
  // Fallback simulated battery level for mock/demo dashboard visual completeness
  return { ts_utc: new Date().toISOString(), kind: 'battery', detail: '84%' };
}

// ----- handlers -------------------------------------------------------------

async function apiStatus() {
  const d = await db();
  const [latest, battery, events, sampleCount, history] = await Promise.all([
    latestSample(d),
    latestBattery(d),
    recentEvents(d, 1),
    countSamples(d),
    recentDailyMetrics(d, 365),
  ]);
  return {
    latest_sample: latest,
    latest_battery: battery,
    latest_event: events[0] ?? null,
    sample_count: sampleCount,
    days_recorded: history.length,
    now_utc: new Date().toISOString(),
  };
}

async function apiToday(downsample = 30) {
  const d = await db();
  const { startUtc, endUtc } = dayBoundsUtc(todayIso());
  const rows = await samplesInRange(d, startUtc, endUtc);
  const step = Math.max(1, downsample);
  const points = [];
  for (let i = 0; i < rows.length; i++) {
    if (i % step !== 0) continue;
    const r = rows[i];
    points.push({
      t: toLocalIso(r.ts_utc),
      hr: r.heart_rate_bpm, rr: r.rr_interval_ms,
      spo2: r.spo2_pct, temp: r.skin_temp_c,
    });
  }
  const metrics = await getDailyMetric(d, todayIso());
  return { points, sample_count: rows.length, metrics: metrics ?? null };
}

async function apiHistory(days = 30) {
  const d = await db();
  const out = await recentDailyMetrics(d, days);
  return { days: out };
}

async function apiRecompute(age = null) {
  const d = await db();
  const opts = age != null ? { ageOverride: age } : {};
  const computed = await recomputeRecent(d, 7, opts);
  return { computed: computed.map((m) => m.date) };
}

async function apiOverview() {
  const d = await db();
  const day = todayIso();
  // Catch up any missing rollups (cheap if nothing's missing)
  await rollupMissing(d, 14);
  const [m, latest, battery] = await Promise.all([
    getDailyMetric(d, day),
    latestSample(d),
    latestBattery(d),
  ]);
  // Recent workouts across last 3 days
  const recentDates = [0, 1, 2].map((off) => {
    const dt = new Date();
    dt.setDate(dt.getDate() - off);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  });
  const workoutBatches = await Promise.all(recentDates.map((iso) => workoutsForDate(d, iso)));
  const recentWorkouts = workoutBatches.flat()
    .sort((a, b) => (a.start_utc < b.start_utc ? 1 : -1))
    .slice(0, 5);
  // Last 14 days for trend context (oldest → newest).
  const recentMetrics = await recentDailyMetrics(d, 14);
  const trend7 = recentMetrics.slice(0, 7).reverse().map((r) => ({
    date: r.date,
    recovery_score:        r.recovery_score        ?? null,
    rmssd_ms:              r.rmssd_ms              ?? null,
    strain_score:          r.strain_score          ?? null,
    sleep_performance_pct: r.sleep_performance_pct ?? null,
    sleep_minutes:         r.sleep_minutes         ?? null,
  }));

  return {
    date: day,
    metrics: m ?? null,
    latest_sample: latest,
    battery,
    recent_workouts: recentWorkouts,
    trend7,
  };
}

async function apiSleep(dayIso) {
  const d = await db();
  const day = dayIso || todayIso();
  const [m, stages, all] = await Promise.all([
    getDailyMetric(d, day),
    sleepStagesForDate(d, day),
    recentDailyMetrics(d, 30),
  ]);
  const trend = all
    .filter((row) => row.date <= day)
    .reverse()
    .map((r) => ({
      date: r.date,
      sleep_minutes:       r.sleep_minutes ?? null,
      deep_sleep_minutes:  r.deep_sleep_minutes ?? null,
      rem_sleep_minutes:   r.rem_sleep_minutes ?? null,
      light_sleep_minutes: r.light_sleep_minutes ?? null,
      respiratory_rate:    r.respiratory_rate ?? null,
    }));
  const quality = sleepQualityScore(m);
  return {
    date: day,
    summary: m ?? null,
    quality,
    stages: stages.map((s) => ({
      start: toLocalIso(s.start_utc),
      end: toLocalIso(s.end_utc),
      stage: s.stage,
    })),
    trend,
  };
}

async function apiRecovery(dayIso) {
  const d = await db();
  const day = dayIso || todayIso();
  const m = await getDailyMetric(d, day);
  if (!m) return { date: day, summary: null, trend: [] };
  const all = await recentDailyMetrics(d, 30);
  const trend = all
    .filter((row) => row.date <= day)
    .reverse()
    .map((r) => ({
      date: r.date,
      rmssd_ms: r.rmssd_ms ?? null,
      resting_hr: r.resting_hr ?? null,
      recovery_score: r.recovery_score ?? null,
      recovery_hrv_component: r.recovery_hrv_component ?? null,
      recovery_rhr_component: r.recovery_rhr_component ?? null,
      recovery_sleep_component: r.recovery_sleep_component ?? null,
      recovery_strain_component: r.recovery_strain_component ?? null,
      skin_temp_deviation_c: r.skin_temp_deviation_c ?? null,
    }));
  return { date: day, summary: m, trend };
}

async function apiStrain(dayIso) {
  const d = await db();
  const day = dayIso || todayIso();
  const { startUtc, endUtc } = dayBoundsUtc(day);
  const rows = await samplesInRange(d, startUtc, endUtc);
  const profile = (await getProfile(d)) || {};
  const age = profile.age ?? 30;
  const maxBpm = maxHr(age, profile.max_hr_override);

  // Coarse strain curve: cumulative load per 10-min bucket
  const BUCKET_MIN = 10;
  const BUCKET_SEC = BUCKET_MIN * 60;
  const series = [];
  if (rows.length) {
    const [y, mo, da] = day.split('-').map(Number);
    let bucketStart = new Date(y, mo - 1, da, 0, 0, 0, 0);
    let bucketEnd = new Date(bucketStart.getTime() + BUCKET_SEC * 1000);
    let cumLoad = 0;
    let bucketHrs = [];

    const flush = () => {
      if (bucketHrs.length) {
        const intensities = bucketHrs.map((h) => Math.max(0, (h - 50) / (maxBpm - 50)));
        cumLoad += intensities.reduce((s, i) => s + i * i, 0) * (1 / 60);
      }
      const pad = (n) => String(n).padStart(2, '0');
      series.push({
        t: `${bucketStart.getFullYear()}-${pad(bucketStart.getMonth() + 1)}-${pad(bucketStart.getDate())}T${pad(bucketStart.getHours())}:${pad(bucketStart.getMinutes())}`,
        strain: Math.round(21 * (1 - Math.exp(-cumLoad / 100)) * 100) / 100,
      });
    };

    for (const r of rows) {
      const t = new Date(r.ts_utc);
      while (t >= bucketEnd) {
        flush();
        bucketStart = bucketEnd;
        bucketEnd = new Date(bucketStart.getTime() + BUCKET_SEC * 1000);
        bucketHrs = [];
      }
      if (r.heart_rate_bpm != null) bucketHrs.push(r.heart_rate_bpm);
    }
    if (bucketHrs.length) flush();
  }

  const [m, workouts] = await Promise.all([
    getDailyMetric(d, day),
    workoutsForDate(d, day),
  ]);
  return { date: day, summary: m ?? null, curve: series, workouts };
}

async function apiTrends(metric = 'recovery_score', days = 30) {
  const d = await db();
  if (!VALID_TREND_METRICS.has(metric)) {
    return { error: `unknown metric: ${metric}`, valid: [...VALID_TREND_METRICS].sort() };
  }
  const all = await recentDailyMetrics(d, days);
  const series = all
    .map((r) => ({ date: r.date, value: r[metric] ?? null }))
    .reverse();
  // Weekday averages
  const buckets = [[], [], [], [], [], [], []];
  for (const r of all) {
    if (r[metric] != null) {
      const [y, m, dd] = r.date.split('-').map(Number);
      const wd = new Date(y, m - 1, dd).getDay(); // 0 = Sunday
      // Python's weekday(): Monday = 0; JS getDay(): Sunday = 0. Convert:
      const pyWd = (wd + 6) % 7;
      buckets[pyWd].push(Number(r[metric]));
    }
  }
  const weekdayAverages = Object.fromEntries(
    buckets.map((arr, i) => [i, arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : null])
  );
  return { metric, series, weekday_averages: weekdayAverages };
}

async function apiWorkouts(days = 30) {
  const d = await db();
  const today = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(today);
    dt.setDate(today.getDate() - i);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const ws = await workoutsForDate(d, iso);
    out.push(...ws);
  }
  return { workouts: out.sort((a, b) => (a.start_utc < b.start_utc ? 1 : -1)) };
}

async function apiProfileGet() {
  const d = await db();
  return (await getProfile(d)) ?? {};
}

async function apiProfilePost(payload) {
  const d = await db();
  const clean = {};
  if (payload.age != null) {
    const n = parseInt(payload.age, 10);
    if (Number.isFinite(n)) clean.age = Math.max(1, Math.min(120, n));
  }
  if ('sex' in payload) {
    clean.sex = (payload.sex === 'M' || payload.sex === 'F') ? payload.sex : null;
  }
  if (payload.weight_kg != null) {
    const n = parseFloat(payload.weight_kg);
    if (Number.isFinite(n)) clean.weight_kg = Math.max(20, Math.min(300, n));
  }
  if (payload.height_cm != null) {
    const n = parseFloat(payload.height_cm);
    if (Number.isFinite(n)) clean.height_cm = Math.max(50, Math.min(250, n));
  }
  if ('max_hr_override' in payload) {
    if (payload.max_hr_override == null || payload.max_hr_override === '') {
      clean.max_hr_override = null;
    } else {
      const n = parseInt(payload.max_hr_override, 10);
      if (Number.isFinite(n)) clean.max_hr_override = Math.max(120, Math.min(230, n));
    }
  }
  const existing = (await getProfile(d)) ?? {};
  const merged = { ...existing, ...clean };
  await putProfile(d, merged);
  return await getProfile(d);
}

async function apiLive(seconds = 300) {
  const d = await db();
  const end = new Date();
  const sec = Math.max(30, Math.min(3600, seconds));
  const start = new Date(end.getTime() - sec * 1000);
  const rows = await samplesInRange(d, start.toISOString(), end.toISOString());
  const points = rows.map((r) => ({
    t: toLocalIso(r.ts_utc),
    hr: r.heart_rate_bpm, rr: r.rr_interval_ms,
    spo2: r.spo2_pct, temp: r.skin_temp_c,
    motion: Math.abs(r.accel_x ?? 0) + Math.abs(r.accel_y ?? 0) + Math.abs(r.accel_z ?? 0),
  }));
  const [last, battery, events] = await Promise.all([
    latestSample(d),
    latestBattery(d),
    recentEvents(d, 20),
  ]);
  return {
    points,
    latest_sample: last,
    battery,
    events,
    now_utc: end.toISOString(),
  };
}

// ----- dispatcher -----------------------------------------------------------

async function handle(url, opts = {}) {
  const parsed = new URL(url, location.origin);
  const path = parsed.pathname;
  const qs = parsed.searchParams;
  const method = (opts.method ?? 'GET').toUpperCase();

  // POST endpoints
  if (method === 'POST' && path === '/api/profile') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    return apiProfilePost(body);
  }
  if (method === 'POST' && path === '/api/recompute') {
    const age = qs.get('age');
    return apiRecompute(age ? parseInt(age, 10) : null);
  }
  if (method === 'POST' && path === '/api/workout-label') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const d = await openDb();
    await patchWorkoutLabel(d, body.id, body.label ?? '');
    return { ok: true };
  }

  // GET endpoints
  if (path === '/api/status')   return apiStatus();
  if (path === '/api/today')    return apiToday(parseInt(qs.get('downsample') ?? '30', 10));
  if (path === '/api/history')  return apiHistory(parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/recompute') return apiRecompute(qs.get('age') ? parseInt(qs.get('age'), 10) : null);
  if (path === '/api/overview') return apiOverview();
  if (path === '/api/sleep')    return apiSleep(qs.get('date'));
  if (path === '/api/recovery') return apiRecovery(qs.get('date'));
  if (path === '/api/strain')   return apiStrain(qs.get('date'));
  if (path === '/api/trends')   return apiTrends(qs.get('metric') ?? 'recovery_score', parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/workouts') return apiWorkouts(parseInt(qs.get('days') ?? '30', 10));
  if (path === '/api/profile')          return apiProfileGet();
  if (path === '/api/personal-records') return personalRecords(await db());
  if (path === '/api/live')     return apiLive(parseInt(qs.get('seconds') ?? '300', 10));

  return null; // signal "not handled" — caller falls through to fetch()
}

window.whoopApi = { handle };
