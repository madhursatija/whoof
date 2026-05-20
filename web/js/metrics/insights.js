// Trend-insights engine. Analyses recent daily_metrics rows and surfaces
// actionable health insights. Completely pure (no DB access) — the caller
// fetches metrics and passes them in.
//
// Each insight:
//   { id, severity, title, body, metric, trend }
//   severity: 'info' | 'warn' | 'critical'
//   trend:    'up' | 'down' | 'stable' | null

const MIN_DAYS = 3; // minimum days before generating trend insights

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Ordinary least-squares slope over indices 0…n-1.
 * values: ordered oldest → newest.
 * Returns slope in [value units / day]. Positive = rising.
 */
function trendSlope(values) {
  const n = values.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den ? num / den : 0;
}

// ---- Individual insight generators ----------------------------------------
// Each returns an insight object or null.

function hrvTrend(chrono) {
  const vals = chrono.map((m) => m.rmssd_ms).filter((v) => v != null);
  if (vals.length < MIN_DAYS) return null;
  const base = mean(vals);
  if (!base) return null;
  const slope = trendSlope(vals);
  const slopePctPerDay = (slope / base) * 100; // % change per day
  if (slopePctPerDay < -2.5) {
    return {
      id: 'hrv-declining',
      severity: slopePctPerDay < -5 ? 'warn' : 'info',
      title: 'HRV declining',
      body: `HRV has been trending down over the past ${vals.length} days — a common sign of accumulated fatigue. Consider reducing training load or prioritising sleep.`,
      metric: 'rmssd_ms',
      trend: 'down',
    };
  }
  if (slopePctPerDay > 2.5) {
    return {
      id: 'hrv-rising',
      severity: 'info',
      title: 'HRV improving',
      body: `HRV has been trending up for ${vals.length} days — your body is adapting well and recovery is improving.`,
      metric: 'rmssd_ms',
      trend: 'up',
    };
  }
  return null;
}

function rhrTrend(chrono) {
  const vals = chrono.map((m) => m.resting_hr).filter((v) => v != null);
  if (vals.length < MIN_DAYS) return null;
  const half = Math.ceil(vals.length / 2);
  const base = mean(vals.slice(0, half));
  const recent = mean(vals.slice(half));
  if (base == null || recent == null) return null;
  const delta = recent - base;
  if (delta > 5) {
    return {
      id: 'rhr-elevated',
      severity: delta > 8 ? 'warn' : 'info',
      title: 'Resting HR elevated',
      body: `Resting HR is ${delta.toFixed(0)} bpm above its recent baseline. This can indicate fatigue, dehydration, or the onset of illness.`,
      metric: 'resting_hr',
      trend: 'up',
    };
  }
  if (delta < -5) {
    return {
      id: 'rhr-improving',
      severity: 'info',
      title: 'Resting HR improving',
      body: `Resting HR has dropped by ${Math.abs(delta).toFixed(0)} bpm — cardiovascular fitness is trending in the right direction.`,
      metric: 'resting_hr',
      trend: 'down',
    };
  }
  return null;
}

function sleepDebt(latest) {
  if (latest?.sleep_debt_minutes == null) return null;
  const debtH = latest.sleep_debt_minutes / 60;
  if (debtH >= 4) {
    return {
      id: 'sleep-debt-high',
      severity: 'warn',
      title: `${debtH.toFixed(1)}h sleep debt`,
      body: `You've accumulated ${debtH.toFixed(1)} hours of sleep debt over the past 7 days. Extra sleep tonight will meaningfully restore recovery capacity.`,
      metric: 'sleep_debt_minutes',
      trend: 'up',
    };
  }
  if (debtH >= 2) {
    return {
      id: 'sleep-debt-moderate',
      severity: 'info',
      title: `${debtH.toFixed(1)}h sleep debt`,
      body: `A moderate ${debtH.toFixed(1)}-hour deficit has built up this week. Aim for a full night's sleep to clear it.`,
      metric: 'sleep_debt_minutes',
      trend: 'up',
    };
  }
  return null;
}

function sleepConsistency(slice) {
  const vals = slice.map((m) => m.sleep_consistency_pct).filter((v) => v != null);
  if (vals.length < MIN_DAYS) return null;
  const avg = mean(vals);
  if (avg < 70) {
    return {
      id: 'sleep-inconsistent',
      severity: 'info',
      title: 'Irregular sleep schedule',
      body: `Bedtime and wake-up times are varying significantly (consistency ${avg.toFixed(0)}%). A consistent schedule strengthens circadian rhythm and improves sleep quality.`,
      metric: 'sleep_consistency_pct',
      trend: null,
    };
  }
  return null;
}

function recoveryStreak(chrono) {
  const vals = chrono.map((m) => m.recovery_score).filter((v) => v != null);
  if (vals.length < MIN_DAYS) return null;
  const last3 = vals.slice(-3);
  if (last3.every((r) => r < 33)) {
    return {
      id: 'recovery-low-streak',
      severity: 'warn',
      title: '3+ days low recovery',
      body: `Recovery has been in the red zone for 3 or more consecutive days. Cut training intensity and prioritise rest until scores rebound.`,
      metric: 'recovery_score',
      trend: 'down',
    };
  }
  if (last3.every((r) => r >= 67)) {
    return {
      id: 'recovery-high-streak',
      severity: 'info',
      title: 'Peak recovery window',
      body: `3+ green recovery days in a row — your body is primed for high-intensity training right now.`,
      metric: 'recovery_score',
      trend: 'up',
    };
  }
  return null;
}

function strainRecoveryBalance(slice) {
  const strain = mean(slice.slice(0, 3).map((m) => m.strain_score).filter((v) => v != null));
  const recovery = mean(slice.slice(0, 3).map((m) => m.recovery_score).filter((v) => v != null));
  if (strain == null || recovery == null) return null;
  if (strain > 14 && recovery < 50) {
    return {
      id: 'overreaching',
      severity: 'warn',
      title: 'Overreaching risk',
      body: `3-day avg strain (${strain.toFixed(1)}) is high while recovery (${recovery.toFixed(0)}%) is below average. A rest day today would help prevent injury and burnout.`,
      metric: 'strain_score',
      trend: null,
    };
  }
  if (strain < 6 && recovery >= 67) {
    return {
      id: 'undertrained',
      severity: 'info',
      title: 'Low training load',
      body: `Recovery is green but strain has been low (${strain.toFixed(1)}/21) for 3 days. Good time to add a challenging workout.`,
      metric: 'strain_score',
      trend: null,
    };
  }
  return null;
}

function skinTempAlert(slice) {
  const vals = slice.slice(0, 3).map((m) => m.skin_temp_deviation_c).filter((v) => v != null);
  if (vals.length < 2) return null;
  const avg = mean(vals);
  if (avg > 0.5) {
    return {
      id: 'skin-temp-elevated',
      severity: avg > 1.0 ? 'warn' : 'info',
      title: `Skin temp +${avg.toFixed(1)}°C`,
      body: `Skin temperature has been ${avg.toFixed(1)}°C above baseline for the past ${vals.length} nights. This can be an early warning of illness, inflammation, or hormonal shifts.`,
      metric: 'avg_skin_temp_c',
      trend: 'up',
    };
  }
  return null;
}

function respiratoryRateAlert(slice) {
  const recent = slice.slice(0, 3).map((m) => m.respiratory_rate).filter((v) => v != null);
  const baseline = slice.slice(3, 14).map((m) => m.respiratory_rate).filter((v) => v != null);
  if (recent.length < 2 || baseline.length < MIN_DAYS) return null;
  const delta = mean(recent) - mean(baseline);
  if (delta > 1.5) {
    return {
      id: 'respiratory-rate-elevated',
      severity: 'info',
      title: `RR +${delta.toFixed(1)} breaths/min`,
      body: `Respiratory rate during sleep is ${delta.toFixed(1)} breaths/min above your baseline. Elevated RR often precedes illness by 1–2 days.`,
      metric: 'respiratory_rate',
      trend: 'up',
    };
  }
  return null;
}

function sleepDurationTrend(chrono) {
  const vals = chrono.map((m) => m.sleep_minutes).filter((v) => v != null);
  if (vals.length < MIN_DAYS) return null;
  const avgH = mean(vals) / 60;
  if (avgH < 6) {
    return {
      id: 'sleep-short',
      severity: 'warn',
      title: `Averaging ${avgH.toFixed(1)}h sleep`,
      body: `Average sleep duration over the past ${vals.length} days is ${avgH.toFixed(1)} hours — well below the 7-9h recommendation. Chronic short sleep impairs HRV and recovery.`,
      metric: 'sleep_minutes',
      trend: 'down',
    };
  }
  return null;
}

function spo2Alert(slice) {
  const vals = slice.slice(0, 3).map((m) => m.avg_spo2).filter((v) => v != null);
  if (vals.length < 2) return null;
  const avg = mean(vals);
  if (avg < 93) {
    return {
      id: 'spo2-low',
      severity: 'warn',
      title: `SpO₂ ${avg.toFixed(0)}% (low)`,
      body: `Average blood oxygen during sleep has been ${avg.toFixed(0)}% — below the 95% threshold. Consistently low SpO₂ may indicate sleep apnoea or respiratory issues.`,
      metric: 'avg_spo2',
      trend: 'down',
    };
  }
  if (avg < 95) {
    return {
      id: 'spo2-borderline',
      severity: 'info',
      title: `SpO₂ ${avg.toFixed(0)}% (borderline)`,
      body: `Average sleep SpO₂ of ${avg.toFixed(0)}% is slightly below the ideal 95%+ range. Monitor for trends.`,
      metric: 'avg_spo2',
      trend: 'down',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

const SORDER = { critical: 0, warn: 1, info: 2 };

/**
 * Generate insights from recent daily_metrics.
 *
 * @param {Array}  metrics  - sorted newest → oldest (from recentDailyMetrics)
 * @param {Object} opts
 * @param {number} opts.days  - how many days to analyse (default 14)
 * @returns {Array<{id,severity,title,body,metric,trend}>}
 */
export function generateInsights(metrics, { days = 14 } = {}) {
  const slice = metrics.slice(0, days);
  if (slice.length < MIN_DAYS) return [];

  // Chronological order (oldest→newest) for trend functions
  const chrono = [...slice].reverse();

  const candidates = [
    recoveryStreak(chrono),
    strainRecoveryBalance(slice),
    hrvTrend(chrono),
    rhrTrend(chrono),
    sleepDebt(slice[0]),
    sleepDurationTrend(chrono),
    sleepConsistency(slice),
    skinTempAlert(slice),
    respiratoryRateAlert(slice),
    spo2Alert(slice),
  ];

  return candidates
    .filter(Boolean)
    .sort((a, b) => SORDER[a.severity] - SORDER[b.severity]);
}
