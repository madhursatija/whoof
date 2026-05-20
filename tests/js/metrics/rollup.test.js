import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import { insertSamplesBatch, getDailyMetric, putProfile } from '../../../web/js/data/queries.js';
import { rollupDay, rollupMissing } from '../../../web/js/metrics/rollup.js';

const TEST_DB = 'whoopfree-rollup-test';

function freshDb() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(TEST_DB);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

let db;
beforeEach(async () => {
  if (db) { try { db.close(); } catch {} db = null; }
  await freshDb();
  db = await openDb(TEST_DB);
});

// Build one synthetic day at 1-minute resolution (1,440 samples).
// medianDt picks 60s and scales zones/calories accordingly. The rollup
// orchestration is the unit under test; per-sample fidelity isn't needed.
function syntheticDay(dateIso, { restingHr = 60, peakHr = 140, peakHourLocal = 18, restRr = 1000 } = {}) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
  const SAMPLE_INTERVAL_S = 60;
  const out = [];
  const N = 24 * 60; // 1 sample per minute
  for (let i = 0; i < N; i++) {
    const t = new Date(startLocal.getTime() + i * SAMPLE_INTERVAL_S * 1000);
    const hour = t.getHours();
    let hr;
    if (hour < 7) hr = restingHr + 5;
    else if (hour === peakHourLocal) hr = peakHr;
    else hr = restingHr + 20;
    out.push({
      ts_utc: t.toISOString(),
      session_id: 1,
      sequence: i,
      heart_rate_bpm: hr,
      rr_interval_ms: hour < 7 ? restRr + (i % 2 ? 10 : -10) : null,
      spo2_pct: 98,
      skin_temp_c: 33.2,
      accel_x: 0, accel_y: 0, accel_z: 0,
      motion: hour < 7 ? 10 : 80,
      ppg_amp: 0, ambient_light: 0, ppg_quality: 0,
      crc_ok: 1,
    });
  }
  return out;
}

describe('rollupDay', () => {
  it('returns null for a date with no samples', async () => {
    const result = await rollupDay(db, '2026-05-20');
    expect(result).toBeNull();
  });

  it('produces a populated daily_metrics row from a synthetic day', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 75 });
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));

    const dm = await rollupDay(db, '2026-05-20');
    expect(dm).not.toBeNull();
    expect(dm.date).toBe('2026-05-20');
    expect(dm.sample_count).toBe(24 * 60);
    expect(dm.avg_hr).toBeGreaterThan(60);
    expect(dm.avg_hr).toBeLessThan(140);
    expect(dm.max_hr).toBeGreaterThanOrEqual(140);
    expect(dm.resting_hr).toBeGreaterThan(0);
    expect(dm.avg_spo2).toBeCloseTo(98, 0);
    expect(dm.avg_skin_temp_c).toBeCloseTo(33.2, 1);
    expect(dm.strain_score).toBeGreaterThanOrEqual(0);
    expect(dm.strain_score).toBeLessThanOrEqual(21);
  });

  it('persists the metric so getDailyMetric returns it', async () => {
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));
    await rollupDay(db, '2026-05-20');
    const persisted = await getDailyMetric(db, '2026-05-20');
    expect(persisted).toBeTruthy();
    expect(persisted.date).toBe('2026-05-20');
    expect(persisted.computed_at).toBeTruthy();
  });

  it('uses ageOverride when profile lacks age', async () => {
    await insertSamplesBatch(db, syntheticDay('2026-05-20'));
    const dm = await rollupDay(db, '2026-05-20', { ageOverride: 25 });
    expect(dm).not.toBeNull();
    // max_hr depends on age via max_hr_from_age; with younger age max is higher,
    // so strain calibration is different. Just confirm we got a value.
    expect(dm.strain_score).toBeGreaterThanOrEqual(0);
  });
});

describe('rollupMissing', () => {
  it('only computes for dates that have samples and no existing metric', async () => {
    // Seed only one day
    await insertSamplesBatch(db, syntheticDay('2026-05-19'));
    const computed = await rollupMissing(db, 7);
    // Should compute at least 2026-05-19 (other dates have no samples so they're skipped)
    const dates = computed.map((m) => m.date);
    expect(dates).toContain('2026-05-19');
    const firstCount = computed.length;

    // Running again should compute nothing more (already persisted)
    const again = await rollupMissing(db, 7);
    expect(again.length).toBe(0);
    // First-pass count was stable
    expect(firstCount).toBeGreaterThanOrEqual(1);
  });
});
