import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../web/js/data/db.js';
import {
  insertSample, insertSamplesBatch, samplesInRange, latestSample,
  startSession, endSession,
  logEvent, recentEvents,
  getProfile, putProfile,
  upsertDailyMetric, getDailyMetric, recentDailyMetrics,
} from '../../../web/js/data/queries.js';

const TEST_DB = 'whoopfree-queries-test';

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

function sampleAt(ts, hr, sessionId, sequence = 0) {
  return {
    ts_utc: ts, session_id: sessionId, sequence,
    heart_rate_bpm: hr, rr_interval_ms: 800,
    spo2_pct: 98, skin_temp_c: 33,
    accel_x: 0, accel_y: 0, accel_z: 0,
    motion: 0, ppg_amp: 0, ambient_light: 0, ppg_quality: 0,
    crc_ok: 1,
  };
}

describe('samples', () => {
  it('insertSample + samplesInRange', async () => {
    const sess = await startSession(db, 'test');
    const base = Date.parse('2026-05-20T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      await insertSample(db, sampleAt(new Date(base + i * 1000).toISOString(), 70 + i, sess, i));
    }
    const rows = await samplesInRange(db,
      new Date(base + 1000).toISOString(),
      new Date(base + 3000).toISOString());
    expect(rows).toHaveLength(3);
    expect(rows[0].heart_rate_bpm).toBe(71);
  });

  it('insertSamplesBatch is atomic', async () => {
    const sess = await startSession(db);
    const base = Date.parse('2026-05-20T11:00:00Z');
    const batch = Array.from({ length: 10 }, (_, i) =>
      sampleAt(new Date(base + i * 1000).toISOString(), 60 + i, sess, i));
    await insertSamplesBatch(db, batch);
    const rows = await samplesInRange(db,
      new Date(base).toISOString(),
      new Date(base + 9000).toISOString());
    expect(rows).toHaveLength(10);
  });

  it('latestSample returns the most-recent row', async () => {
    const sess = await startSession(db);
    await insertSample(db, sampleAt('2026-05-20T10:00:00Z', 70, sess, 1));
    await insertSample(db, sampleAt('2026-05-20T10:00:05Z', 80, sess, 2));
    await insertSample(db, sampleAt('2026-05-20T10:00:03Z', 75, sess, 3));
    const last = await latestSample(db);
    expect(last.heart_rate_bpm).toBe(80);
  });
});

describe('sessions', () => {
  it('startSession returns numeric id and endSession sets sample_count', async () => {
    const id = await startSession(db, 'morning');
    expect(typeof id).toBe('number');
    await endSession(db, id, 100);
    const tx = db.transaction('sessions');
    const sess = await new Promise((r) =>
      (tx.objectStore('sessions').get(id).onsuccess = (e) => r(e.target.result)));
    expect(sess.sample_count).toBe(100);
    expect(sess.ended_at).toBeTruthy();
  });
});

describe('device_events', () => {
  it('logEvent + recentEvents (newest first)', async () => {
    await logEvent(db, 'connect', 'aa:bb');
    await logEvent(db, 'battery', '88%');
    const evts = await recentEvents(db, 10);
    expect(evts).toHaveLength(2);
    expect(evts[0].kind).toBe('battery'); // newest first
  });
});

describe('profile', () => {
  it('round-trips a profile', async () => {
    await putProfile(db, { age: 30, sex: 'M', weight_kg: 75 });
    const p = await getProfile(db);
    expect(p.age).toBe(30);
    expect(p.sex).toBe('M');
    expect(p.id).toBe(1);
  });
});

describe('daily_metrics', () => {
  it('upsert + get', async () => {
    await upsertDailyMetric(db, { date: '2026-05-19', avg_hr: 72, recovery_score: 80 });
    const m = await getDailyMetric(db, '2026-05-19');
    expect(m.avg_hr).toBe(72);
    expect(m.recovery_score).toBe(80);
    expect(m.computed_at).toBeTruthy();
  });

  it('recentDailyMetrics sorts newest first and respects limit', async () => {
    for (const d of ['2026-05-15', '2026-05-16', '2026-05-17', '2026-05-18', '2026-05-19']) {
      await upsertDailyMetric(db, { date: d, avg_hr: 70 });
    }
    const rows = await recentDailyMetrics(db, 3);
    expect(rows.map((r) => r.date)).toEqual(['2026-05-19', '2026-05-18', '2026-05-17']);
  });
});
