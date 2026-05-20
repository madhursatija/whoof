/**
 * Strain (cardiac load) calculations.
 *
 * Ported from whoopfree/metrics.py. Reproduces the spirit of Whoop's
 * 0-21 strain scale from cardiovascular load without using the
 * proprietary algorithm.
 */

/**
 * Whoop-like 0-21 daily strain score.
 *
 * Methodology:
 *   load   = sum( max(0, (hr - rest) / (max - rest)) ^ 2 ) * minutes_per_sample
 *   strain = 21 * (1 - exp(-load / 100))
 *
 * The squared term emphasises higher intensities, matching the
 * qualitative behaviour of Whoop's published scale.
 *
 * @param {ReadonlyArray<number|null|undefined>} hrBpm  Heart-rate samples (bpm).
 * @param {number} [age=30]                              Age in years (for max HR estimate).
 * @param {number|null} [restingHr=null]                 Optional resting HR; defaults to min of samples.
 * @returns {number}                                     Strain score in [0, 21].
 */
export function strainScore(hrBpm, age = 30, restingHr = null) {
  if (!hrBpm || hrBpm.length === 0) {
    return 0.0;
  }
  const samples = [];
  for (const h of hrBpm) {
    if (h !== null && h !== undefined && h >= 30 && h <= 230) {
      samples.push(h);
    }
  }
  if (samples.length === 0) {
    return 0.0;
  }
  const maxHr = 220 - age;
  const rest = restingHr ? restingHr : Math.min(...samples);
  if (maxHr <= rest) {
    return 0.0;
  }
  // Each real-time packet is ~1 second; convert to minutes for load.
  const minutes = samples.length / 60.0;
  let sumSq = 0.0;
  for (const h of samples) {
    const intensity = Math.max(0.0, (h - rest) / (maxHr - rest));
    sumSq += intensity * intensity;
  }
  const load = sumSq * ((minutes / Math.max(samples.length, 1)) * 60);
  return Math.round(21.0 * (1.0 - Math.exp(-load / 100.0)) * 100) / 100;
}
