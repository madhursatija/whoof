// Daily-metrics rollup orchestrator.
// Reads the day's samples from IndexedDB, runs every per-module metric,
// writes the resulting daily_metrics row + per-day workouts + sleep_stages.
//
// Port of whoopfree/metrics.py::compute_daily (~lines 240-434).

import {
  samplesInRange,
  getProfile,
  getDailyMetric,
  upsertDailyMetric,
  dailyMetricsBefore,
  replaceWorkoutsForDate,
  replaceSleepStagesForDate,
  recentDailyMetrics,
} from '../data/queries.js';
import { rmssd, sdnn, pnn50 } from './hrv.js';
import { strainScore } from './strain.js';
import {
  detectSleepWindow, classifyStages, stageTotals,
  sleepNeedMinutes, sleepPerformance, sleepDebtMinutes7d, sleepConsistencyPct,
  respiratoryRate, bedWakeTimesLocal,
} from './sleep.js';
import {
  maxHr, zoneSecondsFromHrSeries, caloriesFromHrSeries, stressSamples,
} from './zones.js';
import { detectWorkouts } from './workouts.js';
import { recoveryBreakdown, RECOVERY_BASELINE_DAYS } from './recovery.js';

const DEFAULT_AGE = 30;

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function round(v, n = 1) {
  if (v == null || !Number.isFinite(v)) return null;
  const m = 10 ** n;
  return Math.round(v * m) / m;
}

// Local-day UTC boundaries for an ISO date "YYYY-MM-DD".
function dayBoundsUtc(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);     // local 00:00
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);   // next local 00:00
  return { startUtc: start.toISOString(), endUtc: end.toISOString() };
}

function previousDateIso(dateIso) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const prev = new Date(y, m - 1, d - 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}-${String(prev.getDate()).padStart(2, '0')}`;
}

/**
 * Compute and persist one daily_metrics row for `dateIso` (YYYY-MM-DD local).
 * Returns the assembled metric object, or null if there are no samples for that day.
 */
export async function rollupDay(db, dateIso, { ageOverride = null } = {}) {
  const profile = (await getProfile(db)) || {};
  const age = ageOverride ?? profile.age ?? DEFAULT_AGE;
  const sex = profile.sex ?? null;
  const weightKg = profile.weight_kg ?? null;
  const maxHrOverride = profile.max_hr_override ?? null;

  const { startUtc, endUtc } = dayBoundsUtc(dateIso);
  const rows = await samplesInRange(db, startUtc, endUtc);
  if (rows.length === 0) return null;

  // ---- Basic series --------------------------------------------------------
  const hrs   = rows.map((r) => r.heart_rate_bpm).filter((v) => v != null);
  const spo2s = rows.map((r) => r.spo2_pct).filter((v) => v != null);
  const temps = rows.map((r) => r.skin_temp_c).filter((v) => v != null);

  // ---- Sleep ---------------------------------------------------------------
  // The night ending on `dateIso` spans yesterday-evening through this morning,
  // so pull a wider range than the calendar day for sleep detection only.
  const [y, m, d] = dateIso.split('-').map(Number);
  const sleepStartLocal = new Date(y, m - 1, d - 1, 18, 0, 0, 0);
  const sleepEndLocal   = new Date(y, m - 1, d, 14, 0, 0, 0);
  const nightRows = await samplesInRange(
    db,
    sleepStartLocal.toISOString(),
    sleepEndLocal.toISOString(),
  );
  const sleepWindow = detectSleepWindow(nightRows, dateIso);
  const stages = sleepWindow ? classifyStages(nightRows, sleepWindow) : [];
  const totals = stageTotals(stages);
  const asleepMinutes = (totals.light || 0) + (totals.deep || 0) + (totals.rem || 0);
  const respiratory = respiratoryRate(nightRows, sleepWindow);

  // RR intervals inside the sleep window drive HRV.
  let sleepRrs = [];
  if (sleepWindow) {
    const [winStart, winEnd] = sleepWindow;
    const startMs = +new Date(winStart);
    const endMs = +new Date(winEnd);
    sleepRrs = nightRows
      .filter((r) => {
        const t = +new Date(r.ts_utc);
        return r.rr_interval_ms != null && t >= startMs && t < endMs;
      })
      .map((r) => r.rr_interval_ms);
  } else {
    // Fallback: fixed 02:00-06:00 local window
    const fbStart = new Date(`${dateIso}T02:00:00`).toISOString();
    const fbEnd   = new Date(`${dateIso}T06:00:00`).toISOString();
    const sMs = +new Date(fbStart), eMs = +new Date(fbEnd);
    sleepRrs = rows
      .filter((r) => {
        const t = +new Date(r.ts_utc);
        return r.rr_interval_ms != null && t >= sMs && t < eMs;
      })
      .map((r) => r.rr_interval_ms);
  }
  const todayRmssd = rmssd(sleepRrs);

  // ---- History baselines ---------------------------------------------------
  const history = await dailyMetricsBefore(db, dateIso, RECOVERY_BASELINE_DAYS);
  const rmssdHist = history.map((h) => h.rmssd_ms).filter((v) => v != null);
  const rhrHist = history.map((h) => h.resting_hr).filter((v) => v != null);
  const skinTempHist = history.map((h) => h.avg_skin_temp_c).filter((v) => v != null);

  const yesterday = await getDailyMetric(db, previousDateIso(dateIso));
  const yesterdayStrain = yesterday?.strain_score ?? null;

  // ---- Resting HR (5th percentile) -----------------------------------------
  let resting = null;
  if (hrs.length) {
    const sorted = [...hrs].sort((a, b) => a - b);
    resting = sorted[Math.max(0, Math.floor(sorted.length * 0.05) - 1)];
  }

  // ---- Sleep need / debt / consistency -------------------------------------
  const recent7 = await dailyMetricsBefore(db, dateIso, 7);
  const asleepHist = recent7.map((m) => m.sleep_minutes ?? 0);
  const needHist   = recent7.map((m) => m.sleep_need_minutes ?? 0);
  // bedtime_local / wake_local are stored as ISO strings ('2026-05-19T22:34')
  // but sleepConsistencyPct expects Date objects. Convert and discard
  // anything unparseable.
  const toDateOrNull = (s) => {
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const bedHist  = recent7.map((m) => toDateOrNull(m.bedtime_local)).filter(Boolean);
  const wakeHist = recent7.map((m) => toDateOrNull(m.wake_local)).filter(Boolean);

  const debtPrior = sleepDebtMinutes7d(asleepHist, needHist);
  const needMinutes = sleepNeedMinutes(debtPrior, yesterdayStrain ?? 0);
  const performance = sleepPerformance(asleepMinutes, needMinutes);

  const debt = sleepDebtMinutes7d(
    [asleepMinutes, ...asleepHist].slice(0, 7),
    [needMinutes, ...needHist].slice(0, 7),
  );
  const consistency = sleepConsistencyPct(bedHist, wakeHist);

  // ---- HR zones + calories -------------------------------------------------
  const maxBpm = maxHr(age, maxHrOverride);
  const zoneSeconds = zoneSecondsFromHrSeries(hrs, maxBpm);

  // Scale by median sample interval if it's not exactly 1 s.
  let medianDt = 1.0;
  if (rows.length >= 2) {
    const intervals = [];
    for (let i = 1; i < Math.min(rows.length, 200); i++) {
      intervals.push(
        (+new Date(rows[i].ts_utc) - +new Date(rows[i - 1].ts_utc)) / 1000
      );
    }
    intervals.sort((a, b) => a - b);
    if (intervals.length) {
      const mid = Math.floor(intervals.length / 2);
      medianDt = intervals.length % 2
        ? intervals[mid]
        : (intervals[mid - 1] + intervals[mid]) / 2;
    }
  }
  medianDt = Math.max(0.5, Math.min(10.0, medianDt));
  const zoneMinutes = zoneSeconds.map((c) => round((c * medianDt) / 60, 1));
  const caloriesTotal = round(caloriesFromHrSeries(hrs, age, weightKg, sex) * medianDt, 1);

  // ---- Strain + workouts ---------------------------------------------------
  const todayStrain = strainScore(hrs, age, resting);
  const detected = detectWorkouts(rows, {
    age, maxHrOverride, sleepWindow, weightKg, sex,
  });
  await replaceWorkoutsForDate(db, dateIso, detected);
  await replaceSleepStagesForDate(db, dateIso, stages);

  // ---- Skin-temp deviation -------------------------------------------------
  const todaySkinTemp = mean(temps);
  const baselineSkinTemp = mean(skinTempHist);
  const skinDeviation = (todaySkinTemp != null && baselineSkinTemp != null)
    ? round(todaySkinTemp - baselineSkinTemp, 2)
    : null;

  // ---- Stress (average only) -----------------------------------------------
  const baselineRmssd = rmssdHist.length ? mean(rmssdHist) : (todayRmssd ?? 0);
  const stress = stressSamples(rows, baselineRmssd, sleepWindow);
  const stressAvg = stress.length
    ? round(mean(stress.map((s) => s.stress)), 1)
    : null;

  // ---- Recovery breakdown --------------------------------------------------
  const breakdown = recoveryBreakdown({
    todayRmssd,
    rmssdHistory: rmssdHist,
    todayRhr: resting,
    rhrHistory: rhrHist,
    sleepPerformancePct: performance,
    yesterdayStrain,
  });

  // ---- Bed / wake local times ----------------------------------------------
  // bedWakeTimesLocal returns [bed, wake] as Date objects. We persist as
  // local ISO strings (YYYY-MM-DDTHH:MM) so downstream consistency
  // calculations can parse them back the same way regardless of run timezone.
  const [bedDate, wakeDate] = bedWakeTimesLocal(stages);
  const fmtLocalIsoMinutes = (d) => {
    if (!d) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const bedLocal  = fmtLocalIsoMinutes(bedDate);
  const wakeLocal = fmtLocalIsoMinutes(wakeDate);

  const dm = {
    date: dateIso,
    avg_hr: round(mean(hrs), 1),
    min_hr: hrs.length ? round(Math.min(...hrs), 1) : null,
    max_hr: hrs.length ? round(Math.max(...hrs), 1) : null,
    resting_hr: round(resting, 1),
    rmssd_ms: round(todayRmssd, 1),
    sdnn_ms: sleepRrs.length ? round(sdnn(sleepRrs) ?? 0, 1) : null,
    pnn50_pct: sleepRrs.length ? round(pnn50(sleepRrs) ?? 0, 1) : null,
    avg_spo2: round(mean(spo2s), 1),
    avg_skin_temp_c: round(todaySkinTemp, 2),
    sample_count: rows.length,
    strain_score: todayStrain,
    recovery_score: breakdown.total,
    sleep_minutes: asleepMinutes,
    deep_sleep_minutes:  totals.deep  ?? 0,
    rem_sleep_minutes:   totals.rem   ?? 0,
    light_sleep_minutes: totals.light ?? 0,
    wake_minutes:        totals.wake  ?? 0,
    sleep_need_minutes:    needMinutes,
    sleep_performance_pct: performance,
    sleep_debt_minutes:    debt,
    sleep_consistency_pct: consistency,
    respiratory_rate: respiratory,
    skin_temp_deviation_c: skinDeviation,
    calories: caloriesTotal,
    zone_minutes: zoneMinutes,
    recovery_hrv_component:    breakdown.hrv,
    recovery_rhr_component:    breakdown.rhr,
    recovery_sleep_component:  breakdown.sleep,
    recovery_strain_component: breakdown.strain,
    stress_avg: stressAvg,
    bedtime_local: bedLocal,
    wake_local:    wakeLocal,
  };

  await upsertDailyMetric(db, dm);
  return dm;
}

/**
 * Catch-up rollup: scan `days` recent dates, recompute any that don't have a
 * daily_metrics row. Called from the dashboard on load.
 */
export async function rollupMissing(db, days = 14, opts = {}) {
  const today = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const existing = await getDailyMetric(db, iso);
    if (existing) continue;
    const dm = await rollupDay(db, iso, opts);
    if (dm) out.push(dm);
  }
  return out;
}

/**
 * Force-recompute the most recent `days` of daily_metrics (used after profile
 * edits or to refresh stale data).
 */
export async function recomputeRecent(db, days = 7, opts = {}) {
  const today = new Date();
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dm = await rollupDay(db, iso, opts);
    if (dm) out.push(dm);
  }
  return out;
}
