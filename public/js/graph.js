// Attention-aware content graph. One node per article segment, each carrying
// its own smoothed inferred scores; edges are reading order. The graph — not a
// single running number — decides when a segment is at risk, and looks one
// edge ahead so a hard segment's rewrite can be fetched before it is reached.
import { classify } from './classifier.js';

const words = (t) => t.trim().split(/\s+/).length;

export class ContentGraph extends EventTarget {
  constructor(segments, cfg) {
    super();
    this.cfg = cfg;
    this.nodes = segments.map((s) => ({
      id: s.id,
      heading: s.heading,
      difficulty: s.difficulty,
      expectedMs: (words(s.text) / cfg.readingWpm) * 60000,
      dwellMs: 0,
      visits: 0,
      attention: 1,
      distraction: 0,
      load: 0,
      fatigue: 0,
      risk: 0,
      peakRisk: 0,
      state: 'unread',
      atRisk: false,
      aboveSince: null,
      transformed: false,
      history: [], // one state sample per second while this node is being read
      lastHistAt: 0
    }));
    this.edges = this.nodes.slice(1).map((n, i) => ({ from: this.nodes[i].id, to: n.id, type: 'reading-order' }));
    this.currentId = null;
    this.instant = null; // latest un-smoothed classification
    this.trace = []; // recent feature rows, sent to Muse Spark when a node goes at risk
    this._lastTraceAt = 0;
  }

  node(id) {
    return this.nodes.find((n) => n.id === id);
  }

  next(id) {
    const e = this.edges.find((x) => x.from === id);
    return e ? this.node(e.to) : null;
  }

  setCurrent(id) {
    if (id === this.currentId) return;
    this.currentId = id;
    const n = this.node(id);
    if (!n) return;
    n.visits++;
    const ahead = this.next(id);
    if (ahead && ahead.difficulty === 'hard' && !ahead.transformed) {
      this.dispatchEvent(new CustomEvent('prefetch', { detail: ahead }));
    }
  }

  // Called every tick with fresh rolling-window features.
  update(features, dtMs, now = performance.now()) {
    const n = this.node(this.currentId);
    if (!n) return;
    n.dwellMs += dtMs;
    const r = classify(features, n.dwellMs / n.expectedMs, this.cfg);
    this.instant = r;
    if (now - this._lastTraceAt >= 500) {
      this._lastTraceAt = now;
      const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
      this.trace.push({
        segment: n.id,
        scrollVel: Math.round(features.scrollVel),
        reversals: features.reversals,
        rereadPx: Math.round(features.rereadPx),
        jitter: round(features.jitter),
        pressureVar: round(features.pressureVar, 4),
        idleMs: Math.round(features.idleMs),
        distraction: round(r.distraction),
        load: round(r.load),
        fatigue: round(r.fatigue)
      });
      if (this.trace.length > 24) this.trace.shift();
    }

    const a = this.cfg.smoothing;
    for (const k of ['attention', 'distraction', 'load', 'fatigue']) n[k] += a * (r[k] - n[k]);
    n.risk = Math.max(n.distraction, n.load, n.fatigue);
    n.peakRisk = Math.max(n.peakRisk, n.risk);
    n.state = n.risk >= this.cfg.stateThreshold ? dominant(n) : 'focused';
    if (now - n.lastHistAt >= 1000) {
      n.lastHistAt = now;
      n.history.push(n.transformed ? 'reshaped' : n.state);
      if (n.history.length > 240) n.history.shift();
    }

    const ar = this.cfg.atRisk;
    // Muse Spark takes several seconds to answer, so on a hard section the
    // explanation is requested as soon as risk starts climbing.
    if (!n.earlyFired && n.difficulty === 'hard' && n.risk >= (ar.earlyThreshold ?? 1) && n.dwellMs >= ar.minDwellMs / 2) {
      n.earlyFired = true;
      this.dispatchEvent(new CustomEvent('early', { detail: n }));
    }
    if (n.risk >= ar.threshold) n.aboveSince ??= now;
    else n.aboveSince = null;

    if (!n.atRisk && n.aboveSince != null && now - n.aboveSince >= ar.sustainMs && n.dwellMs >= ar.minDwellMs) {
      n.atRisk = true;
      this.dispatchEvent(new CustomEvent('atrisk', { detail: n }));
    }
  }

  forceAtRisk(id = this.currentId) {
    const n = this.node(id);
    if (!n || n.atRisk) return;
    n.atRisk = true;
    if (n.state === 'unread' || n.state === 'focused') n.state = 'overloaded';
    this.dispatchEvent(new CustomEvent('atrisk', { detail: n }));
  }

  // What Muse Spark gets to reason over for one node.
  evidence(id) {
    const n = this.node(id);
    const round = (x) => Math.round(x * 100) / 100;
    return {
      segmentId: id,
      node: {
        state: n.state,
        attention: round(n.attention),
        distraction: round(n.distraction),
        load: round(n.load),
        fatigue: round(n.fatigue),
        dwellRatio: round(n.dwellMs / n.expectedMs)
      },
      trace: this.trace.filter((t) => t.segment === id)
    };
  }

  current() {
    return this.node(this.currentId);
  }

  snapshot() {
    return {
      currentId: this.currentId,
      nodes: this.nodes.map(({ aboveSince, lastHistAt, ...rest }) => rest),
      trace: this.trace,
      reshape: this.lastReshape ?? null,
      edges: this.edges
    };
  }
}

function dominant(n) {
  const pairs = [
    ['distracted', n.distraction],
    ['overloaded', n.load],
    ['fatigued', n.fatigue]
  ].sort((a, b) => b[1] - a[1]);
  return pairs[0][0];
}
