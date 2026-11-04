import { loadConfig, saveConfig, resetConfig } from './config.js';
import { Sensors, extractFeatures } from './sensors.js';
import { ContentGraph } from './graph.js';
import { transformSegment, prefetch, fetchExplanation } from './transform.js';
import { mountViz, STATE_COPY, STATE_COLOR } from './viz.js';
import { mountQuiz } from './quiz.js';
import { mountOwn, savedArticle } from './own.js';
import { postJson } from './transform.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const ownId = new URLSearchParams(location.search).get('a');
const [status, quiz] = await Promise.all(['/api/status', '/api/quiz'].map((u) => fetch(u).then((r) => r.json())));
// Your own text (?a=<id>): ask the server, and if it was restarted and forgot
// it, re-register the copy this phone kept.
async function loadArticle() {
  if (ownId) {
    const r = await fetch(`/api/article/${encodeURIComponent(ownId)}`);
    if (r.ok) return r.json();
    const saved = savedArticle(ownId);
    if (saved) {
      try {
        return await postJson('/api/article/restore', saved);
      } catch {}
    }
    history.replaceState(null, '', '/');
  }
  return fetch('/api/article').then((r) => r.json());
}
const article = await loadArticle();
const own = !!article.custom;

const cfg = loadConfig();
const sensors = new Sensors();
const graph = new ContentGraph(article.segments, cfg);

// ---- Banners: never fail silently ----
function banner(cls, html) {
  $('#banners').insertAdjacentHTML('beforeend', `<div class="banner ${cls}">${html}</div>`);
}
const pill = $('#muse-status');
pill.hidden = false;
if (status.mode === 'live') {
  pill.classList.add('live');
  pill.textContent = `Muse connected · ${status.sparkModel}`;
} else {
  pill.classList.add('off');
  pill.textContent = 'Muse not connected · add META_API_KEY to .env and restart';
}
if (status.mode === 'demo') banner('demo', 'DEMO MODE · no Muse API key on the server. Reshaped text and images are simulated and labelled.');
if (!window.isSecureContext) {
  banner('error', `Sensors off · this page isn't on HTTPS, so motion sensors are hidden. Open the tunnel URL (<code>npm run tunnel</code>) instead of <code>http://&lt;laptop-ip&gt;</code>.`);
}

// ---- Article ----
const words = (t) => t.trim().split(/\s+/).length;
const minutes = (w) => Math.max(1, Math.round(w / cfg.readingWpm));
const totalWords = article.segments.reduce((a, s) => a + words(s.text), 0);
const roman = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
$('#article').innerHTML = `
  <header class="hero">
    <p class="mono">${esc(article.subtitle)} · ${article.segments.length} sections · ${minutes(totalWords)} min${own ? ` · sections by ${article.planner === 'muse' ? 'Muse Spark' : 'even split'}` : ''}</p>
    ${own ? `<h1>${esc(article.title)}</h1>` : `<h1>${esc(article.title.replace(/^(Module \d+:)\s*/, ''))}<br/><em>${esc((article.title.match(/^Module \d+/) || [''])[0])}</em></h1>`}
    <p class="hero-meta">This text listens to how you read it.</p>
    <p class="hero-hint">The line beside each section is your inferred attention. Read normally; if a section gets heavy, scroll back and re-read it.</p>
    ${article.truncated ? '<p class="hero-hint">Long text: only the first ~3000 words were kept.</p>' : ''}
  </header>
  ${article.segments
    .map(
      (s, i) => `<section class="seg" data-id="${s.id}">
        <p class="seg-meta"><span class="seg-num">${roman[i] ?? i + 1}</span><span>${minutes(words(s.text))} min</span></p>
        <h2>${esc(s.heading)}</h2>
        <div class="seg-body">${s.text.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>
      </section>`
    )
    .join('')}
  <section class="chapter-end" id="chapter-end">
    <p class="mono">Your reading, replayed</p>
    <h2>Where your attention went</h2>
    <div class="replay" id="replay"></div>
    <div class="legend">
      <span><i style="background:var(--sig-focus)"></i>focused</span><span><i style="background:var(--sig-distract)"></i>distracted</span>
      <span><i style="background:var(--sig-load)"></i>overloaded</span><span><i style="background:var(--sig-fatigue)"></i>fatigued</span>
      <span><i style="background:var(--muse)"></i>reshaped by Muse</span>
    </div>
    <p class="fine">Each strip is one section, one mark per second you spent on it. All states are inferred from scroll, touch and motion.</p>
    <hr class="section-rule"/>
    ${own
      ? `<div class="own-end"><p class="mono">Your text</p><h2>Read something else</h2>
    <p>The comprehension check needs questions written for the text, so it runs on the sample article.</p>
    <a class="ink-btn" href="/" style="display:block;text-align:center;text-decoration:none">Back to the sample article</a></div>`
      : `<p class="mono">Final chapter</p>
    <h2>Did the reshaping help?</h2>
    <p>Measure it. Read the dense section as written and as Muse reshaped it, and answer three questions after each.</p>
    <button class="ink-btn" id="go-proof">Take the comprehension check</button>`}
  </section>`;
const segEls = Object.fromEntries([...document.querySelectorAll('.seg')].map((el) => [el.dataset.id, el]));

function currentSegmentId() {
  const line = window.innerHeight * 0.4;
  let best = null;
  let bestDist = Infinity;
  for (const [id, el] of Object.entries(segEls)) {
    const r = el.getBoundingClientRect();
    if (r.top <= line && r.bottom >= line) return id;
    const d = Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
    if (d < bestDist) [best, bestDist] = [id, d];
  }
  return best;
}

function renderReplay() {
  $('#replay').innerHTML = graph.nodes
    .map(
      (n, i) => `<div class="replay-row"><span class="n">${roman[i]}</span><div>
        <div class="t"><span>${esc(n.heading)}</span>${n.transformed ? '<b>✦ reshaped</b>' : ''}</div>
        <div class="strip">${n.history.length ? n.history.map((h) => `<i data-s="${h}"></i>`).join('') : ''}</div>
      </div></div>`
    )
    .join('');
}

// ---- Graph events → Muse ----
graph.addEventListener('atrisk', async (e) => {
  const n = e.detail;
  const seg = article.segments.find((s) => s.id === n.id);
  const el = segEls[n.id];
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) toast(`${esc(seg.heading)} · attention looks low (inferred). Reshaping…`, () => el.scrollIntoView({ behavior: 'smooth' }));
  const mode = await transformSegment(el, seg, n.state, graph.evidence(n.id), (beat, info) => {
    graph.lastReshape = { segmentId: n.id, heading: seg.heading, beat, state: info.state, strategy: info.strategy ?? null, why: info.why?.explanation ?? null, mode: info.why?.mode ?? status.mode, text: info.text ? { summary: info.text.summary, points: info.text.points } : graph.lastReshape?.text ?? null, at: Date.now() };
    pushSnapshot();
  }, { explainP: earlyExplain[n.id], waitMs: cfg.atRisk.explainWaitMs ?? 3500 });
  n.transformed = !!mode;
});
graph.addEventListener('prefetch', (e) => prefetch(e.detail.id));
const earlyExplain = {};
graph.addEventListener('early', (e) => {
  earlyExplain[e.detail.id] = fetchExplanation(graph.evidence(e.detail.id));
  earlyExplain[e.detail.id].catch(() => {});
});

// ---- Toast ----
let toastTimer;
function toast(html, onTap) {
  const t = $('#toast');
  t.innerHTML = `<span class="toast-dot"></span><span>${html}</span>`;
  t.onclick = () => {
    onTap?.();
    t.classList.remove('show');
  };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

// ---- Lens (pull-down signal panel) ----
const updateViz = mountViz($('#viz'), graph.nodes);
const lens = $('#lens');
function setLens(open) {
  lens.classList.toggle('open', open);
  lens.setAttribute('aria-hidden', String(!open));
  $('#signal-chip').setAttribute('aria-expanded', String(open));
}
$('#signal-chip').onclick = () => setLens(!lens.classList.contains('open'));
$('#lens-close').onclick = () => setLens(false);
$('#lens-scrim').onclick = () => setLens(false);

// ---- Views: reading ↔ proof ----
let view = 'read';
let quizMounted = false;
function show(next) {
  view = next;
  $('#view-read').hidden = next !== 'read';
  $('#view-quiz').hidden = next !== 'quiz';
  $('#back').hidden = next === 'read';
  $('#signal-chip').hidden = next !== 'read';
  if (next === 'quiz') {
    if (!quizMounted) mountQuiz($('#view-quiz'), { article, quiz });
    quizMounted = true;
    window.scrollTo(0, 0);
  } else {
    $('#chapter-end').scrollIntoView();
  }
}
if (!own) $('#go-proof').onclick = () => show('quiz');
$('#back').onclick = () => show('read');

// ---- Cover: sample article or your own text ----
mountOwn($('#own'));
$('#own-open').onclick = () => {
  $('#own').hidden = false;
  $('#own-open').hidden = true;
  $('#own').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
if (own) {
  $('#own-now').hidden = false;
  $('#own-now').textContent = `Ready: ${article.title} · ${article.segments.length} sections`;
  $('#own-back').hidden = false;
  $('#own-open').textContent = 'Use a different PDF or text';
}

// ---- Start: permission must come from a tap ----
$('#start').onclick = async () => {
  const p = await sensors.requestPermission();
  sensors.start();
  const gate = $('#gate');
  gate.style.transition = 'opacity 0.5s, transform 0.5s';
  gate.style.opacity = '0';
  gate.style.transform = 'translateY(-12px)';
  setTimeout(() => (gate.hidden = true), 500);
  if (p === 'denied') banner('error', 'Motion permission denied · scroll and touch still work; motion jitter will read as 0.');
  setTimeout(() => {
    if (sensors.motionEvents === 0 && window.isSecureContext && 'ontouchstart' in window) {
      banner('error', 'No motion events received · check that the browser has motion-sensor access (Chrome: Site settings → Motion sensors).');
    }
  }, 3000);
  fetch('/api/prewarm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ articleId: own ? article.id : null }) }).catch(() => {});
  loop();
};

// ---- Main loop ----
let last = performance.now();
let lastPush = 0;
let lastReplay = 0;
let features = null;
function pushSnapshot() {
  fetch('/api/graph', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...graph.snapshot(), mode: status.mode, articleId: own ? article.id : null }) }).catch(() => {});
}
function paintSignal() {
  const node = graph.current();
  const chip = $('#signal-chip');
  if (node && node.state !== 'unread') {
    chip.querySelector('[data-r=attention]').textContent = Math.round(node.attention * 100);
    chip.querySelector('[data-r=state]').textContent = STATE_COPY[node.state];
    chip.style.setProperty('--sig', STATE_COLOR[node.state]);
  }
  for (const n of graph.nodes) {
    const el = segEls[n.id];
    el.dataset.state = n.state;
    el.style.setProperty('--risk', n.risk.toFixed(2));
  }
  const max = document.documentElement.scrollHeight - innerHeight;
  $('#progress i').style.width = `${max > 0 ? Math.min(100, (scrollY / max) * 100) : 0}%`;
}
function loop() {
  const now = performance.now();
  const dt = now - last;
  last = now;
  features = extractFeatures(sensors, cfg);
  const open = lens.classList.contains('open');
  if (view === 'read' && !open) {
    graph.setCurrent(currentSegmentId());
    graph.update(features, dt, now);
  }
  if (view === 'read') {
    paintSignal();
    updateViz(graph, open);
    if (now - lastReplay > 1500) {
      lastReplay = now;
      renderReplay();
    }
  }
  if (open && $('.raw').open) renderDebug();
  if (now - lastPush > 700) {
    lastPush = now;
    pushSnapshot();
  }
  setTimeout(loop, cfg.tickMs);
}

// ---- Debug panel ----
const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '–' : typeof v === 'number' ? v.toFixed(d) : String(v));
function renderDebug() {
  const r = sensors.raw;
  const inst = graph.instant;
  $('#dbg-live').innerHTML = `
    <table>
      <tr><th colspan="2">Environment</th></tr>
      <tr><td>Secure context (HTTPS)</td><td>${window.isSecureContext ? 'yes' : '<b class="bad">NO — sensors blocked</b>'}</td></tr>
      <tr><td>Motion permission</td><td>${sensors.permission}</td></tr>
      <tr><td>Motion events</td><td>${sensors.motionEvents}${r.gravityFallback ? ' (gravity high-pass fallback)' : ''}</td></tr>
      <tr><td>Muse mode</td><td>${status.mode} · ${esc(status.sparkModel)} / ${esc(status.imageModel)}</td></tr>
      <tr><th colspan="2">Raw</th></tr>
      <tr><td>Accel x/y/z (m/s²)</td><td>${r.accel ? `${fmt(r.accel.x)} / ${fmt(r.accel.y)} / ${fmt(r.accel.z)}` : '–'}</td></tr>
      <tr><td>Orientation α/β/γ</td><td>${r.rotation ? `${fmt(r.rotation.alpha, 0)} / ${fmt(r.rotation.beta, 0)} / ${fmt(r.rotation.gamma, 0)}` : '–'}</td></tr>
      <tr><td>Touch force / radius</td><td>${fmt(r.touchForce, 3)} / ${fmt(r.touchRadius, 1)}</td></tr>
      <tr><td>Scroll Y</td><td>${fmt(window.scrollY, 0)}</td></tr>
      <tr><th colspan="2">Features (last ${cfg.windowMs} ms)</th></tr>
      <tr><td>Scroll velocity (px/s)</td><td>${fmt(features?.scrollVel, 0)}</td></tr>
      <tr><td>Direction reversals</td><td>${features?.reversals ?? '–'}</td></tr>
      <tr><td>Slow back-scroll (px)</td><td>${fmt(features?.rereadPx, 0)}</td></tr>
      <tr><td>Motion jitter (m/s²)</td><td>${fmt(features?.jitter, 3)} (${features?.motionSamples ?? 0} samples)</td></tr>
      <tr><td>Pressure variance</td><td>${fmt(features?.pressureVar, 4)} (${features?.pressureSource ?? '–'})</td></tr>
      <tr><td>Touches / mean duration</td><td>${features?.touchCount ?? 0} / ${fmt(features?.meanTouchMs, 0)} ms</td></tr>
      <tr><td>Idle (ms)</td><td>${fmt(features?.idleMs, 0)}</td></tr>
      <tr><th colspan="2">Instant classification (unsmoothed)</th></tr>
      <tr><td>State</td><td>${inst?.state ?? '–'}</td></tr>
      <tr><td>Distraction / load / fatigue</td><td>${inst ? `${fmt(inst.distraction)} / ${fmt(inst.load)} / ${fmt(inst.fatigue)}` : '–'}</td></tr>
    </table>
    <table class="nodes">
      <tr><th>Node</th><th>Dwell/exp</th><th>Risk</th><th>State</th><th></th></tr>
      ${graph.nodes
        .map(
          (n) => `<tr class="${n.id === graph.currentId ? 'cur' : ''}"><td>${n.id} ${n.difficulty === 'hard' ? '★' : ''}</td>
          <td>${fmt(n.dwellMs / 1000, 0)}/${fmt(n.expectedMs / 1000, 0)} s</td><td>${fmt(n.risk)}</td><td>${n.state}</td>
          <td>${n.atRisk ? (n.transformed ? '✦' : '⚠') : ''}</td></tr>`
        )
        .join('')}
    </table>`;
}

const cfgBox = $('#dbg-config');
cfgBox.value = JSON.stringify(cfg, null, 2);
$('#dbg-apply').onclick = () => {
  try {
    const next = JSON.parse(cfgBox.value);
    Object.assign(cfg, next);
    saveConfig(cfg);
    $('#dbg-msg').textContent = 'Applied and saved on this phone.';
  } catch (err) {
    $('#dbg-msg').textContent = `Invalid JSON: ${err.message}`;
  }
};
$('#dbg-reset').onclick = () => {
  Object.assign(cfg, resetConfig());
  cfgBox.value = JSON.stringify(cfg, null, 2);
  $('#dbg-msg').textContent = 'Defaults restored.';
};
$('#dbg-force').onclick = () => {
  const id = graph.currentId || article.segments.find((s) => s.difficulty === 'hard')?.id;
  setLens(false);
  graph.forceAtRisk(id);
  $('#dbg-msg').textContent = `Debug trigger fired on ${id}.`;
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
