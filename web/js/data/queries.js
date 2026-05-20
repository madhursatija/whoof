// Promise-wrapped query helpers over IndexedDB.
// Each function manages its own transaction and resolves on tx.oncomplete
// so callers don't have to think about IDB's request/transaction lifecycle.

function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------- samples ---------------------------------------------------------

export async function insertSample(db, sample) {
  const tx = db.transaction('samples', 'readwrite');
  tx.objectStore('samples').add(sample);
  await txDone(tx);
}

// ---------- captures (persisted raw-packet recordings) ----------------------

export async function saveCapture(db, capture) {
  // capture = { label, created_at (ISO), duration_ms, row_count, ndjson_text }
  const tx = db.transaction('captures', 'readwrite');
  tx.objectStore('captures').add(capture);
  await txDone(tx);
}

export async function listCaptures(db) {
  const tx = db.transaction('captures');
  const all = await req2promise(tx.objectStore('captures').getAll());
  // Newest first by created_at; strip ndjson_text from the list to keep it light.
  return all
    .map(({ ndjson_text: _, ...rest }) => rest)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function getCapture(db, id) {
  const tx = db.transaction('captures');
  return await req2promise(tx.objectStore('captures').get(id));
}

export async function deleteCapture(db, id) {
  const tx = db.transaction('captures', 'readwrite');
  tx.objectStore('captures').delete(id);
  await txDone(tx);
}

export async function insertSamplesBatch(db, samples) {
  if (!samples.length) return;
  const tx = db.transaction('samples', 'readwrite');
  const store = tx.objectStore('samples');
  for (const s of samples) store.add(s);
  await txDone(tx);
}

export async function samplesInRange(db, isoFrom, isoTo) {
  const tx = db.transaction('samples');
  const idx = tx.objectStore('samples').index('ts_utc');
  return await req2promise(idx.getAll(IDBKeyRange.bound(isoFrom, isoTo)));
}

export async function samplesForSession(db, sessionId) {
  const tx = db.transaction('samples');
  const idx = tx.objectStore('samples').index('session_id');
  return await req2promise(idx.getAll(sessionId));
}

export async function latestSample(db) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('samples');
    const idx = tx.objectStore('samples').index('ts_utc');
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

// ---------- sessions --------------------------------------------------------

export async function startSession(db, label = null) {
  const tx = db.transaction('sessions', 'readwrite');
  const id = await req2promise(tx.objectStore('sessions').add({
    started_at: new Date().toISOString(),
    ended_at: null,
    label,
    notes: null,
    sample_count: 0,
  }));
  await txDone(tx);
  return id;
}

export async function endSession(db, id, sampleCount) {
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  const sess = await req2promise(store.get(id));
  if (sess) {
    sess.ended_at = new Date().toISOString();
    sess.sample_count = sampleCount;
    store.put(sess);
  }
  await txDone(tx);
}

// ---------- device_events ---------------------------------------------------

export async function logEvent(db, kind, detail = null) {
  const tx = db.transaction('device_events', 'readwrite');
  tx.objectStore('device_events').add({
    ts_utc: new Date().toISOString(),
    kind,
    detail,
  });
  await txDone(tx);
}

export async function recentEvents(db, limit = 50) {
  const tx = db.transaction('device_events');
  const idx = tx.objectStore('device_events').index('ts_utc');
  return await new Promise((resolve, reject) => {
    const out = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------- profile ---------------------------------------------------------

export async function getProfile(db) {
  const tx = db.transaction('profile');
  return await req2promise(tx.objectStore('profile').get(1));
}

export async function putProfile(db, fields) {
  const tx = db.transaction('profile', 'readwrite');
  tx.objectStore('profile').put({ ...fields, id: 1, updated_at: new Date().toISOString() });
  await txDone(tx);
}

// ---------- daily_metrics ---------------------------------------------------

export async function getDailyMetric(db, date) {
  const tx = db.transaction('daily_metrics');
  return await req2promise(tx.objectStore('daily_metrics').get(date));
}

export async function upsertDailyMetric(db, dm) {
  const tx = db.transaction('daily_metrics', 'readwrite');
  tx.objectStore('daily_metrics').put({ ...dm, computed_at: new Date().toISOString() });
  await txDone(tx);
}

export async function recentDailyMetrics(db, days) {
  const tx = db.transaction('daily_metrics');
  const all = await req2promise(tx.objectStore('daily_metrics').getAll());
  return all.sort((a, b) => (a.date > b.date ? -1 : 1)).slice(0, days);
}

export async function dailyMetricsBefore(db, dateIso, limit) {
  const tx = db.transaction('daily_metrics');
  const all = await req2promise(tx.objectStore('daily_metrics').getAll());
  return all
    .filter((m) => m.date < dateIso)
    .sort((a, b) => (a.date > b.date ? -1 : 1))
    .slice(0, limit);
}

// ---------- workouts --------------------------------------------------------

export async function replaceWorkoutsForDate(db, dateIso, workouts) {
  const tx = db.transaction('workouts', 'readwrite');
  const store = tx.objectStore('workouts');
  // Delete existing workouts for this date
  const existing = await req2promise(store.index('date').getAllKeys(dateIso));
  for (const k of existing) store.delete(k);
  // Insert fresh
  for (const w of workouts) store.add({ ...w, date: dateIso });
  await txDone(tx);
}

export async function workoutsForDate(db, dateIso) {
  const tx = db.transaction('workouts');
  return await req2promise(tx.objectStore('workouts').index('date').getAll(dateIso));
}

// ---------- sleep_stages ----------------------------------------------------

export async function replaceSleepStagesForDate(db, dateIso, stages) {
  const tx = db.transaction('sleep_stages', 'readwrite');
  const store = tx.objectStore('sleep_stages');
  const existing = await req2promise(store.index('date').getAllKeys(dateIso));
  for (const k of existing) store.delete(k);
  for (const s of stages) store.add({ ...s, date: dateIso });
  await txDone(tx);
}

export async function sleepStagesForDate(db, dateIso) {
  const tx = db.transaction('sleep_stages');
  return await req2promise(tx.objectStore('sleep_stages').index('date').getAll(dateIso));
}

// ---------- journal ---------------------------------------------------------

/**
 * Upsert a journal entry for the given date. One entry per date; existing
 * entry is replaced if the date already exists.
 * @param {IDBDatabase} db
 * @param {{ date: string, text: string, tags: string[] }} entry
 * @returns {Promise<number>} id of the saved entry
 */
export async function upsertJournalEntry(db, entry) {
  const tx = db.transaction('journal', 'readwrite');
  const store = tx.objectStore('journal');
  // Remove existing entries for this date first (one-per-day semantics).
  const existing = await req2promise(store.index('date').getAllKeys(entry.date));
  for (const k of existing) store.delete(k);
  const id = await req2promise(store.add({
    date: entry.date,
    text: entry.text ?? '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    created_at: new Date().toISOString(),
  }));
  await txDone(tx);
  return id;
}

export async function journalForDate(db, dateIso) {
  const tx = db.transaction('journal');
  const results = await req2promise(tx.objectStore('journal').index('date').getAll(dateIso));
  return results[0] ?? null;
}

export async function recentJournalEntries(db, days = 30) {
  const tx = db.transaction('journal');
  const all = await req2promise(tx.objectStore('journal').getAll());
  return all.sort((a, b) => (a.date > b.date ? -1 : 1)).slice(0, days);
}
