// Every classifier threshold lives here so it can be tuned live from the Debug
// tab on the test phone. Ranges are [lo, hi]: a feature at or below lo scores 0,
// at or above hi scores 1, linear in between.
export const DEFAULT_CONFIG = {
  windowMs: 2500, // rolling feature window
  tickMs: 250, // how often features are recomputed
  readingWpm: 200, // expected reading speed, sets each segment's expected dwell

  distracted: {
    scrollVel: [350, 1600], // px/s, total scroll path over the window
    reversals: [1, 4], // direction changes in the window
    jitter: [0.35, 1.8], // m/s², std-dev of linear acceleration magnitude
    weights: { scrollVel: 0.45, reversals: 0.3, jitter: 0.25 }
  },
  overloaded: {
    dwellRatio: [0.25, 1.5], // time on segment / expected reading time at readingWpm
    rereadPx: [40, 400], // slow upward scroll (re-reading) over rereadWindowMs
    rereadWindowMs: 8000, // re-reading is bursty, so it gets a longer window
    rereadMaxVel: 700, // upward scroll faster than this (px/s) is skimming, not re-reading
    pressureVar: [0.002, 0.03], // variance of touch force (or contact radius proxy)
    weights: { dwellRatio: 0.25, rereadPx: 0.55, pressureVar: 0.2 }
  },
  fatigued: {
    idleMs: [7000, 20000], // no scroll or touch for this long
    stillJitter: 0.3 // phone is resting if jitter is below this
  },

  stateThreshold: 0.45, // a non-focused state needs at least this score to win
  smoothing: 0.12, // EMA factor for per-segment scores (0..1, higher = jumpier)
  atRisk: {
    threshold: 0.5, // smoothed risk score that marks a segment at risk
    sustainMs: 1500, // ...held for at least this long
    minDwellMs: 4000, // ...and only after the reader has been on it this long
    earlyThreshold: 0.3, // on a hard section, ask Muse Spark for its explanation this early...
    explainWaitMs: 3500 // ...and during the reshape wait at most this long for it before going on
  }
};

const KEY = 'thalamuse.config';

export function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) return merge(structuredClone(DEFAULT_CONFIG), saved);
  } catch {}
  return structuredClone(DEFAULT_CONFIG);
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {}
}

export function resetConfig() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
  return structuredClone(DEFAULT_CONFIG);
}

// Saved tuning wins, but keys added to the defaults later still get filled in.
function merge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] ? merge(base[k], v) : v;
  }
  return base;
}
