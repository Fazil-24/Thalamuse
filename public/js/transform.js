// Client side of the Muse proxy, plus the three-beat reshape of a segment.
import { traceSvg, TRACE_LEGEND } from './viz.js';

const pending = new Map();

// POST to our own server. If something between the phone and the server (the
// HTTPS tunnel, a crashed server) answers with an HTML page instead of JSON,
// say that plainly rather than surfacing a JSON parse error.
export async function postJson(url, body) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error("can't reach the Thalamuse server. Is `npm start` still running, and is the tunnel up?");
  }
  const raw = await r.text();
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    const hint =
      r.status === 524 || r.status === 504
        ? 'the server took longer than the tunnel allows (about 100 s)'
        : r.status === 502 || r.status === 530
          ? "the tunnel couldn't reach the server. Check that `npm start` is still running on the laptop"
          : 'something other than the Thalamuse server answered';
    throw new Error(`HTTP ${r.status}: ${hint}. Check the server terminal for an [api] or [muse] line.`);
  }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function post(kind, segmentId, state) {
  const key = `${kind}:${segmentId}:${state}`;
  if (!pending.has(key)) {
    const p = postJson(`/api/transform/${kind}`, { segmentId, state });
    p.catch(() => pending.delete(key));
    pending.set(key, p);
  }
  return pending.get(key);
}

export const fetchExplanation = (evidence) => postJson('/api/explain', evidence);

// The strategy Spark picked for each segment during live reading, so the quiz
// tests the same version the reader actually got.
const chosen = {};
export const chosenStrategy = (id) => chosen[id] ?? 'simplify';

export const fetchText = (id, state) => post('text', id, state);
export const fetchImage = (id, state) => post('image', id, state);

export function prefetch(id, state = 'overloaded') {
  fetchText(id, state).catch(() => {});
  fetchImage(id, state).catch(() => {});
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

export function rewriteHtml(text) {
  return `${text.summary ? `<p class="t-summary">${md(text.summary)}</p>` : ''}
    <ul class="t-points">${text.points.map((p) => `<li>${md(p)}</li>`).join('')}</ul>`;
}

const STRATEGY_LABEL = { simplify: 'simplified', condense: 'condensed', visual: 'diagram first' };
const STATE_DEFAULT = { overloaded: 'simplify', fatigued: 'simplify', distracted: 'condense', focused: 'simplify' };
const resolveLabel = (x) => (STRATEGY_LABEL[x] ? x : STATE_DEFAULT[x] ?? 'simplify');

function badge(mode, strategy) {
  const demo = mode === 'demo';
  return `<div class="t-badge ${demo ? 'demo' : ''}"><b>✦ Reshaped by Muse</b><span>${esc(STRATEGY_LABEL[strategy] ?? strategy)}${demo ? ' · DEMO MODE, simulated' : ''}</span></div>`;
}

function whyBlock(why, state) {
  if (why === 'pending') return `<details class="t-why"><summary>Why this changed (inferred ${esc(state)})</summary><p class="wait">Muse Spark is still reading your signal…</p></details>`;
  if (!why) return '';
  return `<details class="t-why"><summary>Why this changed (inferred ${esc(state)})</summary>
    <p>${esc(why.explanation)}</p>
    <small>${why.explanationSource === 'rules' ? 'Rules-based explanation (Muse reply was unusable)' : `${esc(why.model)}, from scroll, touch and motion signals`} · strategy: ${esc(why.strategy)}</small>
  </details>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same rules as the server's fallback, so the reshape never waits on Spark.
function quickExplanation({ node, trace }) {
  const last = trace[trace.length - 1] ?? {};
  const bits = [];
  if (last.rereadPx > 40) bits.push(`scrolled back over about ${Math.round(last.rereadPx)} px of this section`);
  if (node.dwellRatio > 0.5) bits.push(`stayed on it for ${Math.round(node.dwellRatio * 100)}% of its expected reading time`);
  if (last.scrollVel > 350) bits.push(`scrolled quickly (${Math.round(last.scrollVel)} px/s) with ${last.reversals} direction changes`);
  if (last.jitter > 0.35) bits.push('moved the phone around more than earlier');
  if (last.idleMs > 7000) bits.push(`stopped scrolling or touching for ${Math.round(last.idleMs / 1000)} s`);
  return `You ${bits.length ? bits.join(', and ') : 'showed a mix of weak signals'}, so attention here was inferred to be dropping.`;
}

async function typeInto(el, text, maxMs = 1600) {
  const step = Math.max(8, Math.min(28, maxMs / Math.max(1, text.length)));
  el.classList.remove('wait');
  el.innerHTML = '<span></span><span class="cursor"></span>';
  const span = el.firstChild;
  for (let i = 1; i <= text.length; i += 2) {
    span.textContent = text.slice(0, i);
    await sleep(step * 2);
  }
  span.textContent = text;
}

// The reshape, in three beats so it reads on camera:
//   1. the margin line flares and the paragraph recedes
//   2. a card shows the signal trace Muse Spark is reasoning over, then its "why"
//   3. the paragraph re-sets into the reshaped version; the diagram unfolds
// onBeat(beat, info) lets the app mirror each beat elsewhere.
export async function transformSegment(el, segment, state, evidence, onBeat = () => {}, { explainP: early = null, waitMs = 3500 } = {}) {
  const body = el.querySelector('.seg-body');
  const original = body.innerHTML;

  // Beat 1
  el.classList.add('flare', 'transforming');
  navigator.vibrate?.([25, 70, 25]);
  onBeat(1, { state });
  const explainP = (early ?? fetchExplanation(evidence)).catch((err) => {
    console.warn('Muse explanation failed', err);
    return null;
  });
  await sleep(1100);

  // Beat 2
  const card = document.createElement('div');
  card.className = 'spark-card';
  card.innerHTML = `<p class="lens-label"><span>Muse Spark · reading your signal</span><span>inferred ${esc(state)}</span></p>
    ${traceSvg(evidence.trace)}${TRACE_LEGEND}
    <p class="why wait">Looking at the last few seconds<span class="cursor"></span></p>
    <small>Scroll, re-reading and motion only. No camera, no microphone.</small>`;
  el.insertBefore(card, body);
  // Wait a moment for Spark; if it is still thinking, go on with a quick
  // rules-based reading and swap Spark's in when it arrives.
  let why = await Promise.race([Promise.all([explainP, sleep(900)]).then(([w]) => w), sleep(Math.max(900, waitMs)).then(() => 'late')]);
  let late = why === 'late';
  if (late) why = null;
  const strategy = why?.strategy ?? state;
  if (why?.strategy) chosen[segment.id] = why.strategy;
  if (why?.mode === 'demo') card.classList.add('demo');
  onBeat(2, { state, why, strategy });
  const textP = fetchText(segment.id, strategy);
  textP.catch(() => {});
  if (late) card.querySelector('.lens-label span').textContent = 'Quick read of your signal';
  await typeInto(card.querySelector('.why'), why ? why.explanation : quickExplanation(evidence));
  card.querySelector('small').textContent = why
    ? `${why.mode === 'demo' ? 'DEMO MODE · ' : ''}strategy chosen: ${STRATEGY_LABEL[resolveLabel(strategy)]}`
    : late
      ? "Rules-based, from scroll and motion. Muse Spark's own reading appears under “Why this changed”."
      : 'Explanation unavailable; using the default strategy for this state.';

  let text;
  try {
    [text] = await Promise.all([textP, sleep(900)]);
  } catch (err) {
    card.remove();
    el.classList.remove('flare', 'transforming');
    body.innerHTML = original;
    el.insertAdjacentHTML('beforeend', `<p class="t-error">Muse rewrite failed: ${esc(err.message)}</p>`);
    return null;
  }

  // Beat 3
  card.style.transition = 'opacity 0.35s, transform 0.35s';
  card.style.opacity = '0';
  card.style.transform = 'translateY(-6px)';
  await sleep(350);
  card.remove();

  let figHtml = '<div class="t-img-loading">Muse Image is drawing a visual summary…</div>';
  let showingOriginal = false;
  const render = () => {
    body.innerHTML = showingOriginal
      ? `${original}<button class="t-toggle" type="button">Show Muse version</button>`
      : `${badge(text.mode, text.style)}${
          text.style === 'visual'
            ? `<figure class="t-figure">${figHtml}</figure>${rewriteHtml(text)}`
            : `${rewriteHtml(text)}<figure class="t-figure">${figHtml}</figure>`
        }${whyBlock(late && !why ? 'pending' : why, state)}
         <button class="t-toggle" type="button">Show original text</button>`;
  };
  body.addEventListener('click', (e) => {
    if (!e.target.classList.contains('t-toggle')) return;
    showingOriginal = !showingOriginal;
    render();
  });
  el.classList.remove('flare', 'transforming');
  el.classList.add('transformed', 'reveal');
  setTimeout(() => el.classList.remove('reveal'), 1800);
  render();
  onBeat(3, { state, why, strategy, text });
  if (late) {
    explainP.then((w) => {
      why = w;
      late = false;
      if (!showingOriginal) render();
      if (w) onBeat(3, { state, why: w, strategy, text });
    });
  }

  fetchImage(segment.id, strategy)
    .then((img) => {
      figHtml = `<img src="${esc(img.src)}" alt="Visual summary of ${esc(segment.heading)}"/>
        <figcaption>${img.mode === 'demo' ? 'DEMO MODE placeholder — not generated by Muse Image' : `Drawn by ${esc(img.model)}`}</figcaption>`;
    })
    .catch((err) => {
      figHtml = `<p class="t-error">Muse Image unavailable: ${esc(err.message)}</p>`;
    })
    .finally(() => !showingOriginal && render());
  return text.mode;
}
