import { describe, it, expect } from 'vitest';
import { strainScore } from '../../../web/js/metrics/strain.js';

describe('strainScore', () => {
  it('is near zero at rest', () => {
    // 1 hour at perfect rest HR
    const hr = new Array(3600).fill(60.0);
    const score = strainScore(hr, 30, 60.0);
    expect(score).toBeLessThan(1.0);
  });

  it('grows with intensity and is bounded by 21', () => {
    // 1 hour at rest vs 1 hour at near-max
    const rest = new Array(3600).fill(60.0);
    const hard = new Array(3600).fill(180.0);
    const sRest = strainScore(rest, 30, 60.0);
    const sHard = strainScore(hard, 30, 60.0);
    expect(sHard).toBeGreaterThan(sRest);
    expect(sHard).toBeLessThanOrEqual(21.0);
  });

  it('is bounded between 0 and 21 even at sustained max HR', () => {
    // 6 hours at max HR shouldn't exceed Whoop's 21.
    const hr = new Array(6 * 3600).fill(200.0);
    const score = strainScore(hr, 30, 50.0);
    expect(score).toBeGreaterThanOrEqual(0.0);
    expect(score).toBeLessThanOrEqual(21.0);
  });
});
