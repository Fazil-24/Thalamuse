// Rules-based classifier: thresholds only, no trained model. Every number it
// uses comes from the config object so it can be tuned live.

const norm = (x, [lo, hi]) => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));

// features: output of extractFeatures(); dwellRatio: time on the current
// segment divided by its expected reading time.
export function classify(features, dwellRatio, cfg) {
  const d = cfg.distracted;
  const distraction =
    d.weights.scrollVel * norm(features.scrollVel, d.scrollVel) +
    d.weights.reversals * norm(features.reversals, d.reversals) +
    d.weights.jitter * norm(features.jitter, d.jitter);

  const o = cfg.overloaded;
  const load =
    o.weights.dwellRatio * norm(dwellRatio, o.dwellRatio) +
    o.weights.rereadPx * norm(features.rereadPx, o.rereadPx) +
    o.weights.pressureVar * norm(features.pressureVar, o.pressureVar);

  const f = cfg.fatigued;
  const fatigue = norm(features.idleMs, f.idleMs) * (features.jitter < f.stillJitter ? 1 : 0.5);

  const candidates = [
    ['distracted', distraction],
    ['overloaded', load],
    ['fatigued', fatigue]
  ].sort((a, b) => b[1] - a[1]);
  const [top, topScore] = candidates[0];
  const state = topScore >= cfg.stateThreshold ? top : 'focused';

  return {
    state,
    distraction,
    load,
    fatigue,
    attention: 1 - Math.max(distraction, load, fatigue)
  };
}
