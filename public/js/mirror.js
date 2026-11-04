// Laptop mirror: polls the phone's latest graph snapshot (GET /api/graph) and
// shows the same live state large enough to film next to the phone.
import { traceSvg, TRACE_LEGEND, STATE_COPY } from './viz.js';
import { rewriteHtml } from './transform.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
let articleId;
let segEls = {};
let shownReshape = null;
let rendering = false;

// The phone may be reading the sample article or your own text; follow it.
async function render(id) {
  articleId = id;
  const article = await fetch(id ? `/api/article/${encodeURIComponent(id)}` : '/api/article').then((r) => (r.ok ? r.json() : fetch('/api/article').then((x) => x.json())));
  $('#m-article').innerHTML = article.segments
    .map(
      (s, i) => `<section class="seg" data-id="${s.id}">
      <p class="seg-meta"><span class="seg-num">${roman[i] ?? i + 1}</span><span>${esc(s.difficulty)}</span></p>
      <h2>${esc(s.heading)}</h2>
      <div class="seg-body">${s.text.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
    </section>`
    )
    .join('');
  $('#m-map').innerHTML = article.segments.map((s, i) => `${i ? '<i></i>' : ''}<span data-n="${s.id}">${i + 1}</span>`).join('');
  segEls = Object.fromEntries([...document.querySelectorAll('.seg')].map((el) => [el.dataset.id, el]));
  $('#m-card').innerHTML = '';
  shownReshape = null;
}
await render(null);
fetch('/api/status').then((r) => r.json()).then((st) => {
  const el = $('#m-muse');
  el.classList.add(st.mode === 'live' ? 'on' : 'off');
  el.textContent = st.mode === 'live' ? `● Muse connected · ${st.sparkModel}` : '● Muse not connected (demo mode)';
}).catch(() => {});
$('#m-legend').innerHTML = TRACE_LEGEND;

async function tick() {
  if (rendering) return;
  let snap;
  try {
    snap = await fetch('/api/graph').then((r) => r.json());
  } catch {
    return;
  }
  const age = Date.now() - (snap.receivedAt ?? 0);
  $('#live').classList.toggle('stale', !snap.receivedAt || age > 3000);
  $('#live-txt').textContent = !snap.receivedAt ? 'waiting for phone' : age > 3000 ? `phone quiet for ${Math.round(age / 1000)} s` : 'live';
  if (!snap.nodes?.length) return;
  if ((snap.articleId ?? null) !== articleId) {
    rendering = true;
    await render(snap.articleId ?? null).finally(() => (rendering = false));
  }

  for (const n of snap.nodes) {
    const el = segEls[n.id];
    if (!el) continue;
    el.dataset.state = n.state;
    el.style.setProperty('--risk', n.risk.toFixed(2));
    el.classList.toggle('cur', n.id === snap.currentId);
    el.classList.toggle('transformed', n.transformed);
    const dot = document.querySelector(`[data-n="${n.id}"]`);
    dot.dataset.state = n.transformed ? 'reshaped' : n.atRisk ? 'risk' : n.state;
    dot.classList.toggle('cur', n.id === snap.currentId);
  }
  const cur = snap.nodes.find((n) => n.id === snap.currentId);
  if (cur && cur.state !== 'unread') {
    $('#m-att').textContent = Math.round(cur.attention * 100);
    $('#m-state').textContent = STATE_COPY[cur.state];
    $('#m-where').textContent = cur.heading;
  }
  $('#m-trace').innerHTML = traceSvg((snap.trace ?? []).filter((t) => t.segment === snap.currentId));

  const r = snap.reshape;
  const key = r ? `${r.segmentId}:${r.beat}:${r.why ? 1 : 0}` : null;
  if (r && key !== shownReshape && Date.now() - r.at < 60000) {
    shownReshape = key;
    const el = segEls[r.segmentId];
    if (!el) return;
    el.classList.toggle('flare', r.beat < 3);
    $('#m-card').innerHTML = `<div class="spark-card ${r.mode === 'demo' ? 'demo' : ''}">
      <p class="lens-label"><span>${r.why ? 'Muse Spark' : 'Quick read'} · ${r.beat < 3 ? 'reading the signal' : 'reshaped'}</span><span>inferred ${esc(r.state)}</span></p>
      <p class="why ${r.why ? '' : 'wait'}">${r.why ? esc(r.why) : r.beat === 3 ? 'Reshaped. Muse Spark is still writing its explanation<span class="cursor"></span>' : 'Attention on this section looks low. Reading the last few seconds<span class="cursor"></span>'}</p>
      <small>${r.mode === 'demo' ? 'DEMO MODE · ' : ''}${esc(r.heading)}${r.strategy ? ` · strategy: ${esc(r.strategy)}` : ''}</small>
    </div>`;
    if (r.beat === 3 && r.text) {
      el.querySelector('.seg-body').innerHTML = `<div class="t-badge ${r.mode === 'demo' ? 'demo' : ''}"><b>✦ Reshaped by Muse</b></div>${rewriteHtml(r.text)}`;
    }
  }
}

setInterval(tick, 400);
tick();
