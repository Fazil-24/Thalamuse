// Signal panel. The stylized diagram is a visual metaphor, not anatomy: each
// region is bound to one of the content graph's own scores for the current
// segment, so it is a second rendering of the same signal the graph uses —
// never an extra or separate one. The caption sits directly under it.

export const CAPTION = 'Illustrative visualization of inferred attention state — not a measurement of brain activity.';

const REGIONS = [
  { key: 'attention', color: 'var(--sig-focus)', cx: 78, cy: 52, r: 34 },
  { key: 'distraction', color: 'var(--sig-distract)', cx: 128, cy: 46, r: 32 },
  { key: 'load', color: 'var(--sig-load)', cx: 150, cy: 88, r: 30 },
  { key: 'fatigue', color: 'var(--sig-fatigue)', cx: 96, cy: 96, r: 30 }
];

// Deliberately soft and cartoonish: a cloud outline, no folds, no lobes.
const OUTLINE =
  'M40 80 C30 40 70 14 104 22 C128 6 176 16 182 52 C204 70 192 112 162 118 C146 136 110 134 96 124 C66 132 34 116 40 80 Z';

export const STATE_COPY = {
  unread: 'listening',
  focused: 'focused',
  distracted: 'distracted',
  overloaded: 'overloaded',
  fatigued: 'fatigued'
};
export const STATE_COLOR = {
  focused: 'var(--sig-focus)',
  distracted: 'var(--sig-distract)',
  overloaded: 'var(--sig-load)',
  fatigued: 'var(--sig-fatigue)'
};

// Two normalised polylines (re-reading and scroll speed) from trace rows.
export function traceSvg(trace, cls = 'trace-svg') {
  const W = 300;
  const H = 64;
  const rows = trace.slice(-24);
  const line = (k, max) => {
    if (rows.length < 2) return '';
    return rows
      .map((r, i) => `${((i / (rows.length - 1)) * W).toFixed(1)},${(H - 4 - Math.min(1, r[k] / max) * (H - 8)).toFixed(1)}`)
      .join(' ');
  };
  return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Recent scroll and re-reading signal">
    <line x1="0" y1="${H - 4}" x2="${W}" y2="${H - 4}" stroke="#3d382f" stroke-width="1"/>
    <polyline points="${line('scrollVel', 1600)}" fill="none" stroke="var(--sig-distract)" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity="0.8"/>
    <polyline points="${line('rereadPx', 400)}" fill="none" stroke="var(--sig-load)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <polyline points="${line('jitter', 1.8)}" fill="none" stroke="var(--sig-fatigue)" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0.7"/>
  </svg>`;
}
export const TRACE_LEGEND = `<div class="trace-legend"><span><i style="background:var(--sig-load)"></i>re-reading</span><span><i style="background:var(--sig-distract)"></i>scroll speed</span><span><i style="background:var(--sig-fatigue)"></i>phone motion</span></div>`;

export function mountViz(root, nodes) {
  root.innerHTML = `
    <div class="lens-head">
      <svg viewBox="20 0 190 140" class="viz-svg" role="img" aria-label="Stylized diagram of inferred attention state">
        <defs>
          ${REGIONS.map(
            (r) => `<radialGradient id="g-${r.key}">
              <stop offset="0" stop-color="${r.color}" stop-opacity="0.95"/>
              <stop offset="1" stop-color="${r.color}" stop-opacity="0"/>
            </radialGradient>`
          ).join('')}
          <clipPath id="viz-clip"><path d="${OUTLINE}"/></clipPath>
        </defs>
        <path d="${OUTLINE}" class="viz-outline"/>
        <g clip-path="url(#viz-clip)">
          ${REGIONS.map((r) => `<circle data-k="${r.key}" cx="${r.cx}" cy="${r.cy}" r="${r.r}" fill="url(#g-${r.key})" opacity="0.15"/>`).join('')}
        </g>
      </svg>
      <div class="lens-state">
        <p class="mono">Attention · inferred</p>
        <p class="lens-big"><span data-r="attention2">—</span><small data-r="state2">listening</small></p>
        <p class="mono" data-r="where">—</p>
      </div>
    </div>
    <p class="viz-caption">${CAPTION}</p>
    <dl class="meters">
      ${[
        ['attention', 'Attention', 'var(--sig-focus)'],
        ['distraction', 'Distraction', 'var(--sig-distract)'],
        ['load', 'Load', 'var(--sig-load)'],
        ['fatigue', 'Fatigue', 'var(--sig-fatigue)']
      ]
        .map(
          ([k, label, c]) => `<div><dt><span>${label} <em>inferred</em></span><span data-v="${k}">—</span></dt><dd><i data-m="${k}" style="background:${c}"></i></dd></div>`
        )
        .join('')}
    </dl>
    <p class="lens-label"><span>Content graph</span><span>one node per section</span></p>
    <div class="graph-map">${nodes.map((n, i) => `${i ? '<i></i>' : ''}<span data-n="${n.id}">${i + 1}</span>`).join('')}</div>
    <p class="lens-label"><span>Live signal</span><span>last ~12 s</span></p>
    <div data-trace></div>
    ${TRACE_LEGEND}`;

  const circles = Object.fromEntries([...root.querySelectorAll('circle[data-k]')].map((c) => [c.dataset.k, c]));
  const out = Object.fromEntries([...root.querySelectorAll('[data-r]')].map((d) => [d.dataset.r, d]));
  const vals = Object.fromEntries([...root.querySelectorAll('[data-v]')].map((d) => [d.dataset.v, d]));
  const meters = Object.fromEntries([...root.querySelectorAll('[data-m]')].map((d) => [d.dataset.m, d]));
  const dots = Object.fromEntries([...root.querySelectorAll('[data-n]')].map((d) => [d.dataset.n, d]));
  const traceEl = root.querySelector('[data-trace]');

  return function update(graph, open) {
    for (const n of graph.nodes) {
      const d = dots[n.id];
      d.dataset.state = n.transformed ? 'reshaped' : n.atRisk ? 'risk' : n.state;
      d.classList.toggle('cur', n.id === graph.currentId);
    }
    const node = graph.current();
    if (!node || node.state === 'unread') return;
    for (const r of REGIONS) {
      const v = node[r.key];
      circles[r.key].setAttribute('opacity', (0.12 + 0.88 * v).toFixed(2));
      circles[r.key].setAttribute('r', (r.r * (0.75 + 0.45 * v)).toFixed(1));
      meters[r.key].style.width = `${Math.round(v * 100)}%`;
      vals[r.key].textContent = Math.round(v * 100);
    }
    out.attention2.textContent = Math.round(node.attention * 100);
    out.state2.textContent = STATE_COPY[node.state] ?? node.state;
    out.where.textContent = `Section ${graph.nodes.indexOf(node) + 1} · ${node.heading}`;
    if (open) traceEl.innerHTML = traceSvg(graph.trace);
  };
}
