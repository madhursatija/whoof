// HRV time-domain metrics ported from whoopfree/metrics.py.
//
// Standard published methods (Malik 1996, ESC/NASPE Task Force) so the
// numbers are interpretable on their own even though they won't match
// Whoop's proprietary scores exactly.

const MIN_BEATS_FOR_HRV = 5;

/**
 * Drop ectopic / artifact RR intervals.
 *
 * Standard guideline: discard any beat that differs from its predecessor
 * by more than 20%.
 *
 * @param {Iterable<number>} rrMs - RR intervals in milliseconds.
 * @returns {number[]} filtered RR intervals.
 */
export function filterRr(rrMs) {
  const arr = Array.from(rrMs ?? []);
  if (arr.length === 0) return [];
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) {
    const r = arr[i];
    const prev = out[out.length - 1];
    if (Math.abs(r - prev) / Math.max(prev, 1) <= 0.2) {
      out.push(r);
    }
  }
  return out;
}

/**
 * Root mean square of successive RR differences (ms).
 * The single most reported time-domain HRV index.
 *
 * @param {Iterable<number>} rrMs
 * @returns {number|null}
 */
export function rmssd(rrMs) {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  let sumSq = 0;
  const n = rr.length - 1;
  for (let i = 0; i < n; i++) {
    const d = rr[i + 1] - rr[i];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

/**
 * Standard deviation of NN intervals (ms). Population stdev to match
 * Python's `statistics.pstdev`.
 *
 * @param {Iterable<number>} rrMs
 * @returns {number|null}
 */
export function sdnn(rrMs) {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  const n = rr.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += rr[i];
  const mean = sum / n;
  let sqAcc = 0;
  for (let i = 0; i < n; i++) {
    const dev = rr[i] - mean;
    sqAcc += dev * dev;
  }
  return Math.sqrt(sqAcc / n);
}

/**
 * Percentage of successive RR intervals differing by > 50 ms.
 *
 * @param {Iterable<number>} rrMs
 * @returns {number|null}
 */
export function pnn50(rrMs) {
  const rr = filterRr(rrMs);
  if (rr.length < MIN_BEATS_FOR_HRV) return null;
  const n = rr.length - 1;
  let over = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(rr[i + 1] - rr[i]) > 50) over++;
  }
  return (100.0 * over) / n;
}
