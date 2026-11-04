// Validation loop: read segment 3 unadapted, answer 3 questions; read the Muse
// version, answer 3 parallel questions; show both scores side by side. Every
// run is stored so the on-screen comparison can also show the pilot average.
import { fetchText, fetchImage, rewriteHtml, chosenStrategy } from './transform.js';

const HISTORY_KEY = 'thalamuse.quizRuns';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}
function saveHistory(runs) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(runs));
  } catch {}
}

const STRAT_LABEL = { simplify: 'simplified', condense: 'condensed', visual: 'diagram first' };

// Counterbalancing across runs on this phone: order alternates every run, and
// which question set goes with which version alternates every two runs, so
// after 4 runs each order and each set/version pairing has appeared equally.
function plan(k, override) {
  const order = override !== 'auto' ? override : k % 2 === 0 ? 'baseline-first' : 'adapted-first';
  const swapSets = Math.floor(k / 2) % 2 === 1;
  const conds = order === 'baseline-first' ? ['baseline', 'adapted'] : ['adapted', 'baseline'];
  const sets = swapSets ? ['B', 'A'] : ['A', 'B'];
  return { order, passes: conds.map((condition, i) => ({ condition, set: sets[i] })) };
}

export function mountQuiz(root, { article, quiz }) {
  const segment = article.segments.find((s) => s.id === quiz.segmentId);
  let run;

  function stepper(active) {
    const labels = run.passes.flatMap((p) => [p.condition === 'baseline' ? 'Original' : 'Reshaped', 'Questions']).concat('Result');
    return `<ol class="stepper">${labels.map((l, i) => `<li class="${i < active ? 'done' : i === active ? 'on' : ''}"><i></i><small>${l}</small></li>`).join('')}</ol>`;
  }

  function intro() {
    const runs = loadHistory();
    const next = plan(runs.length, 'auto');
    root.innerHTML = `
      <section class="proof-hero">
        <p class="mono">Final chapter · the proof</p>
        <h1>Does reshaping <em>actually</em> help you understand?</h1>
        <p>You'll read <b>“${esc(segment.heading)}”</b> twice, once as written and once as Muse reshaped it. After each read the passage disappears and you answer three questions. The two question sets are different but cover the same material.</p>
      </section>
      <label class="row"><span>Order</span>
        <select id="q-order">
          <option value="auto">Automatic, counterbalanced (next: ${next.order === 'baseline-first' ? 'original first' : 'reshaped first'})</option>
          <option value="baseline-first">Original first, then reshaped</option>
          <option value="adapted-first">Reshaped first, then original</option>
        </select>
      </label>
      <div class="sticky-cta"><button class="ink-btn" id="q-start">Start the check</button>
        <small>${runs.length ? `${runs.length} run${runs.length > 1 ? 's' : ''} saved on this phone` : 'Runs are saved on this phone only'}</small></div>
      ${runs.length ? `<p class="center"><button class="link-btn" id="q-export">Export runs (JSON)</button> · <button class="link-btn" id="q-clear">Clear runs</button></p>` : ''}`;
    // Warm the reshaped version so that pass doesn't wait on the API.
    fetchText(segment.id, chosenStrategy(segment.id)).catch(() => {});
    fetchImage(segment.id, chosenStrategy(segment.id)).catch(() => {});
    root.querySelector('#q-start').onclick = () => {
      run = { ...plan(runs.length, root.querySelector('#q-order').value), step: 0, strategy: chosenStrategy(segment.id) };
      read();
    };
    root.querySelector('#q-export')?.addEventListener('click', exportRuns);
    root.querySelector('#q-clear')?.addEventListener('click', () => {
      if (!confirm('Delete all saved runs on this phone?')) return;
      saveHistory([]);
      intro();
    });
  }

  function exportRuns() {
    const runs = loadHistory();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), segment: segment.id, runs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `thalamuse-runs-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function read() {
    const pass = run.passes[run.step];
    const adapted = pass.condition === 'adapted';
    root.innerHTML = `
      ${stepper(run.step * 2)}
      <section class="reading ${adapted ? 'is-adapted' : ''}">
        <p class="eyebrow">${adapted ? '✦ Reshaped by Muse' : 'As written'}</p>
        <h2>${esc(segment.heading)}</h2>
        <div class="q-passage">${adapted ? '<div class="t-skel"><i></i><i></i><i></i><i class="short"></i></div>' : `<p>${esc(segment.text)}</p>`}</div>
      </section>
      <div class="sticky-cta"><button class="ink-btn" id="q-done">I'm done reading</button><small>The passage will be hidden for the questions</small></div>`;
    window.scrollTo(0, 0);
    const passage = root.querySelector('.q-passage');
    if (adapted) {
      try {
        const text = await fetchText(segment.id, run.strategy);
        const fig = '<figure class="t-figure"><div class="t-img-loading">Loading visual summary…</div></figure>';
        passage.innerHTML = `<div class="t-badge ${text.mode === 'demo' ? 'demo' : ''}"><b>✦ Reshaped by Muse</b><span>${esc(STRAT_LABEL[text.style] ?? text.style)}${text.mode === 'demo' ? ' · DEMO MODE, simulated' : ''}</span></div>
          ${text.style === 'visual' ? fig + rewriteHtml(text) : rewriteHtml(text) + fig}`;
        pass.mode = text.mode;
        pass.strategy = text.style;
        fetchImage(segment.id, run.strategy)
          .then((img) => (passage.querySelector('.t-figure').innerHTML = `<img src="${esc(img.src)}" alt="Visual summary"/>`))
          .catch(() => passage.querySelector('.t-figure')?.remove());
      } catch (err) {
        passage.innerHTML = `<p class="t-error">Couldn't load the Muse version: ${esc(err.message)}</p>`;
        root.querySelector('#q-done').disabled = true;
        return;
      }
    }
    const t0 = performance.now();
    root.querySelector('#q-done').onclick = () => {
      pass.readMs = performance.now() - t0;
      ask();
    };
  }

  function ask() {
    const pass = run.passes[run.step];
    const qs = quiz.sets[pass.set];
    root.innerHTML = `
      ${stepper(run.step * 2 + 1)}
      <form id="q-form">
        ${qs
          .map(
            (q, i) => `<fieldset><legend><span class="q-n">Q${i + 1}</span>${esc(q.q)}</legend>
            ${q.options.map((o, j) => `<label class="opt"><input type="radio" name="q${i}" value="${j}" required/><span>${esc(o)}</span></label>`).join('')}
          </fieldset>`
          )
          .join('')}
        <div class="sticky-cta"><button class="ink-btn" type="submit">Submit answers</button></div>
      </form>`;
    window.scrollTo(0, 0);
    root.querySelector('#q-form').onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      pass.answers = qs.map((q, i) => Number(fd.get(`q${i}`)));
      pass.score = qs.reduce((acc, q, i) => acc + (pass.answers[i] === q.answer ? 1 : 0), 0);
      pass.total = qs.length;
      run.step++;
      if (run.step < run.passes.length) read();
      else results();
    };
  }

  function review(pass) {
    return quiz.sets[pass.set]
      .map((q, i) => {
        const ok = pass.answers[i] === q.answer;
        return `<li class="${ok ? 'ok' : 'no'}"><span>${ok ? '✓' : '✗'}</span><div>${esc(q.q)}<small>${ok ? '' : `You chose “${esc(q.options[pass.answers[i]])}”. `}Answer: ${esc(q.options[q.answer])}</small></div></li>`;
      })
      .join('');
  }

  function results() {
    const byCond = Object.fromEntries(run.passes.map((p) => [p.condition, p]));
    const history = loadHistory();
    history.push({
      at: new Date().toISOString(),
      order: run.order,
      baseline: byCond.baseline.score,
      adapted: byCond.adapted.score,
      total: byCond.baseline.total,
      baselineSet: byCond.baseline.set,
      adaptedSet: byCond.adapted.set,
      baselineReadMs: Math.round(byCond.baseline.readMs),
      adaptedReadMs: Math.round(byCond.adapted.readMs),
      strategy: byCond.adapted.strategy,
      adaptedMode: byCond.adapted.mode
    });
    saveHistory(history);
    const live = history.filter((h) => h.adaptedMode === 'live');
    const demoRuns = history.length - live.length;
    const avg = (k) => live.reduce((a, h) => a + h[k], 0) / live.length;
    const delta = byCond.adapted.score - byCond.baseline.score;
    const total = byCond.baseline.total;
    const bar = (label, v, cls) =>
      `<div class="bar-row"><span>${label}</span><div class="bar ${cls}"><div style="--w:${(v / total) * 100}%"></div></div><b>${v.toFixed(2)}</b></div>`;
    root.innerHTML = `
      ${stepper(4)}
      <section class="verdict">
        <p class="mono">Comprehension · “${esc(segment.heading)}”</p>
        ${byCond.adapted.mode === 'demo' ? '<p class="warn">The reshaped passage was DEMO MODE text, not real Muse output. Don\'t present this run as a Muse result.</p>' : ''}
        <div class="vs">
          <div><b>${byCond.baseline.score}<small>/${total}</small></b><span>As written</span></div>
          <div class="arrow">→</div>
          <div class="with"><b>${byCond.adapted.score}<small>/${total}</small></b><span>Reshaped by Muse</span></div>
        </div>
        <p class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta} correct answer${Math.abs(delta) === 1 ? '' : 's'} with reshaping</p>
        <p class="fine">Read time ${(byCond.baseline.readMs / 1000).toFixed(0)} s as written · ${(byCond.adapted.readMs / 1000).toFixed(0)} s reshaped · ${run.order === 'baseline-first' ? 'original read first' : 'reshaped read first'}</p>
      </section>
      <hr class="section-rule"/>
      <h3>All live runs on this phone</h3>
      ${
        live.length
          ? `<div class="bars">${bar('As written', avg('baseline'), '')}${bar('Reshaped', avg('adapted'), 'with')}</div>
             <p class="fine">Mean correct out of ${total}, n = ${live.length} run${live.length > 1 ? 's' : ''}.</p>`
          : '<p class="fine">No live Muse runs yet. Averages appear here once the server has an API key.</p>'
      }
      <p class="fine">${demoRuns ? `${demoRuns} demo-mode run${demoRuns > 1 ? 's' : ''} excluded. ` : ''}Small pilot, order and question sets counterbalanced across runs. Treat it as a demo check, not a study.</p>
      <details class="review"><summary>Review answers</summary>
        <h3>As written</h3><ul class="answers">${review(byCond.baseline)}</ul>
        <h3>Reshaped by Muse</h3><ul class="answers">${review(byCond.adapted)}</ul>
      </details>
      <div class="sticky-cta"><button class="ink-btn" id="q-again">Next reader</button>
        <small><button class="link-btn" id="q-export">Export all runs (JSON)</button></small></div>`;
    window.scrollTo(0, 0);
    requestAnimationFrame(() => requestAnimationFrame(() => root.querySelector('.bars')?.classList.add('grow')));
    root.querySelector('#q-again').onclick = intro;
    root.querySelector('#q-export').onclick = exportRuns;
  }

  intro();
}
