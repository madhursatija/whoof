// Synthetic-data generator: 14 (configurable) days of realistic-looking
// nights + daytime + workouts. Port of whoopfree/cli.py::seed_demo.
//
// Triggered via the MVP panel button (Phase 1 scaffold). On click we
// insert samples into IndexedDB, then rollupMissing fills daily metrics
// so every tab in the v0.2 dashboard has data.

import { openDb } from '../data/db.js';
import { insertSamplesBatch, startSession, endSession, putProfile, upsertJournalEntry } from '../data/queries.js';
import { rollupMissing, recomputeRecent } from '../metrics/rollup.js';

// ----- seeded random + Box-Muller Gaussian ---------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGauss(rand) {
  let cache = null;
  return function gauss(mu = 0, sigma = 1) {
    if (cache !== null) { const v = cache; cache = null; return mu + sigma * v; }
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = rand();
    while (u2 === 0) u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    cache = r * Math.sin(theta);
    return mu + sigma * r * Math.cos(theta);
  };
}

function randInt(rand, lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}

// ----- one day's samples ---------------------------------------------------

function* generateDaySamples({
  date, dayStartLocal, dayEndLocal, sessionId, rand, gauss,
  workoutToday,
}) {
  // Daytime: 10s sample interval. Sleep periods: 2s interval (5× denser) so
  // RR-interval samples capture the ~4s respiratory cycle (Nyquist requires
  // sampling at ≥ 2× the breath frequency). With 2s sleep sampling the
  // respiratory-rate detector can find the RSA modulation we add below.
  // Total seed size: ~14 days × (~16h daytime / 10s + ~8h sleep / 2s) ≈ 280k samples.
  const DAY_SAMPLE_INTERVAL   = 10; // seconds
  const SLEEP_SAMPLE_INTERVAL = 2;  // seconds
  const daySeconds = Math.floor((dayEndLocal - dayStartLocal) / 1000);
  if (daySeconds <= 0) return;

  const bedtimeHour      = 22 + gauss(0, 0.6);
  const wakeHour         = 6.5 + gauss(0, 0.4);
  const sleepBaselineHr  = 52 + gauss(0, 3);
  const rrJitter         = Math.max(8, gauss(28, 6));
  const workoutStart     = 17 + gauss(0, 0.5);
  const workoutDurMin    = 35 + randInt(rand, 0, 25);
  const workoutPeakHr    = 155 + randInt(rand, -10, 10);
  const dayAvgHr         = 76 + gauss(0, 4);
  // Respiratory sinus arrhythmia (RSA) — adds a sinusoidal modulation to
  // RR intervals at the breathing frequency so the respiratory-rate
  // detector finds a real signal. ~15 bpm ± per-night variance.
  const breathsPerMin    = 14 + gauss(0, 1.5);
  const breathPeriodSec  = 60 / Math.max(8, Math.min(22, breathsPerMin));

  let seq = 0;
  let s = 0;
  while (s < daySeconds) {
    const tsLocal = new Date(dayStartLocal.getTime() + s * 1000);
    const t = tsLocal.getHours() + tsLocal.getMinutes() / 60 + tsLocal.getSeconds() / 3600;

    const inSleep    = (t >= bedtimeHour) || (t < wakeHour);
    const inWorkout  = workoutToday && (t >= workoutStart) && (t < workoutStart + workoutDurMin / 60);
    const inWinddown = (t >= bedtimeHour - 1) && (t < bedtimeHour);
    const SAMPLE_INTERVAL = inSleep ? SLEEP_SAMPLE_INTERVAL : DAY_SAMPLE_INTERVAL;

    let hr, rr, motion, accelAmp;
    if (inSleep) {
      // Model ~90-min sleep cycles so the hypnogram shows all four stages.
      // sleepElapsed = minutes since bedtime (wrapping past midnight).
      let sleepElapsedH = t - bedtimeHour;
      if (sleepElapsedH < 0) sleepElapsedH += 24;
      const cyclePos = (sleepElapsedH * 60) % 90 / 90;       // 0..1 within current 90-min cycle
      const cycleIdx = Math.floor((sleepElapsedH * 60) / 90); // 0,1,2,3...

      // Stage targets within each cycle:
      //   0.00-0.20  deep  (low HR, low HRV)
      //   0.20-0.65  light (medium)
      //   0.65-0.95  REM   (elevated HR, high HRV) — first cycle has shorter REM
      //   0.95-1.00  brief transition / micro-wake
      let hrOffset = 0;
      let hrvMultiplier = 1.0;
      let motionBase = 6;
      const remBoost = Math.min(1, 0.4 + cycleIdx * 0.2); // later cycles → longer/stronger REM

      if (cyclePos < 0.20) {
        // deep
        hrOffset = -2.5;
        hrvMultiplier = 0.55;
        motionBase = 3;
      } else if (cyclePos < 0.65) {
        // light
        hrOffset = 0;
        hrvMultiplier = 0.85;
        motionBase = 7;
      } else if (cyclePos < 0.95) {
        // REM — needs HR ≥ hrMin+6 AND RMSSD > baseline*1.1 in the classifier
        hrOffset = 7 + 2 * remBoost;
        hrvMultiplier = 1.45 + 0.15 * remBoost;
        motionBase = 9;
      } else {
        // brief transition
        hrOffset = 3;
        hrvMultiplier = 1.05;
        motionBase = 14;
      }

      hr = sleepBaselineHr + hrOffset + gauss(0, 1.8);
      // RSA amplitude varies by stage — strongest in deep (parasympathetic
      // dominance), weaker in REM (mixed autonomic state).
      const rsaAmp = cyclePos < 0.20 ? 35 : cyclePos < 0.65 ? 25 : 12;
      const rsa = rsaAmp * Math.sin(2 * Math.PI * s / breathPeriodSec);
      rr = Math.round(60000 / hr + rsa + gauss(0, rrJitter * hrvMultiplier * 0.4));
      motion = Math.abs(gauss(0, motionBase));
      accelAmp = Math.max(1, Math.floor(motion / 3) + randInt(rand, 0, 4));
    } else if (inWorkout) {
      const phase = (t - workoutStart) / (workoutDurMin / 60);
      if (phase < 0.15) {
        hr = dayAvgHr + (workoutPeakHr - dayAvgHr) * (phase / 0.15);
      } else if (phase > 0.85) {
        hr = workoutPeakHr * (1 - (phase - 0.85) / 0.15 * 0.4);
      } else {
        hr = workoutPeakHr + gauss(0, 6);
      }
      rr = Math.round(60000 / hr + gauss(0, 5));
      motion = 120 + gauss(0, 30);
      accelAmp = Math.max(1, Math.floor(motion));
    } else if (inWinddown) {
      hr = dayAvgHr - 6 + gauss(0, 4);
      rr = Math.round(60000 / hr + gauss(0, 18));
      motion = 20 + gauss(0, 8);
      accelAmp = Math.max(1, Math.floor(motion));
    } else {
      hr = dayAvgHr + gauss(0, 8);
      rr = Math.round(60000 / hr + gauss(0, 16));
      motion = 60 + gauss(0, 30);
      accelAmp = Math.max(1, Math.floor(motion));
    }

    hr = Math.max(40, Math.min(200, hr));
    rr = Math.max(300, Math.min(1500, rr));

    yield {
      ts_utc: tsLocal.toISOString(),
      session_id: sessionId,
      sequence: seq++,
      heart_rate_bpm: Math.round(hr * 10) / 10,
      rr_interval_ms: rr,
      spo2_pct: inSleep ? 97 + randInt(rand, -1, 1) : 98,
      skin_temp_c: Math.round((33.2 + gauss(0, 0.4)) * 100) / 100,
      accel_x: randInt(rand, -accelAmp, accelAmp),
      accel_y: randInt(rand, -accelAmp, accelAmp),
      accel_z: randInt(rand, -accelAmp, accelAmp),
      motion: Math.max(0, Math.floor(motion)),
      ppg_amp: randInt(rand, 800, 1500),
      ambient_light: inSleep ? 0 : randInt(rand, 50, 600),
      ppg_quality: randInt(rand, 180, 250),
      crc_ok: 1,
    };
    s += SAMPLE_INTERVAL;
  }
}

// ----- public API -----------------------------------------------------------

export async function seedDemoData({
  days = 14, age = 30, sex = 'M', weightKg = 72, onProgress = null,
} = {}) {
  const db = await openDb();
  await putProfile(db, { age, sex, weight_kg: weightKg });

  const rand = mulberry32(42);
  const gauss = makeGauss(rand);
  const today = new Date();

  for (let offset = days; offset >= 0; offset--) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    const dayStartLocal = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const dayEndLocal = offset === 0
      ? new Date()
      : new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);

    const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const sessionId = await startSession(db, `demo ${dateIso}`);

    const samples = Array.from(generateDaySamples({
      date: dateIso, dayStartLocal, dayEndLocal, sessionId,
      rand, gauss, workoutToday: offset % 2 === 0,
    }));

    // Chunk to avoid one huge transaction.
    const CHUNK = 500;
    for (let i = 0; i < samples.length; i += CHUNK) {
      await insertSamplesBatch(db, samples.slice(i, i + CHUNK));
    }
    await endSession(db, sessionId, samples.length);
    if (onProgress) onProgress({ date: dateIso, sampleCount: samples.length });
  }

  // Seed representative journal entries so the tag-correlation panel has data.
  // Pattern: every 3rd day → alcohol (expect lower next-day recovery),
  //          workout days (offset%2=0) → hardworkout,
  //          every 5th day → goodsleep.
  for (let offset = days; offset >= 1; offset--) {
    const d = new Date(today);
    d.setDate(today.getDate() - offset);
    const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const tags = [];
    if (offset % 3 === 0) tags.push('alcohol');
    if (offset % 2 === 0) tags.push('hardworkout');
    if (offset % 5 === 0) tags.push('goodsleep');
    if (!tags.length) continue;
    await upsertJournalEntry(db, { date: dateIso, text: '', tags });
  }

  // Compute daily metrics for the seeded range.
  await recomputeRecent(db, days + 1, { ageOverride: age });
  return { days: days + 1 };
}
