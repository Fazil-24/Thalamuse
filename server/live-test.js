// Live end-to-end test against the running app and the real Muse API.
//
//   npm start            (in one terminal, with META_API_KEY in .env)
//   npm run live-test    (in another)
//
// It drives the app's own endpoints the way the phone does, then uses Muse
// Spark once more per rewrite as a strict "reader" to check nothing the quiz
// needs was lost. Every Muse call is counted and the run stops at --budget
// (default 14). A full run uses 11 calls. Writes reports/live-<time>.html.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const article = require('../data/article.json');
const quiz = require('../data/quiz.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const APP = arg('app', `http://localhost:${process.env.PORT || 3000}`);
const BUDGET = Number(arg('budget', 14));
const SKIP_IMAGE = process.argv.includes('--no-image');
const SPARK = process.env.MUSE_SPARK_MODEL || 'muse-spark-1.3';
const KEY = process.env.META_API_KEY?.trim();

let used = 0;
const spend = (n, what) => {
  if (used + n > BUDGET) throw new Error(`budget: ${what} would use call ${used + n} of ${BUDGET}; stopping`);
  used += n;
};

const seg = article.segments.find((s) => s.id === 's3');
const words = (t) => t.trim().split(/\s+/).length;
const BANNED = /brain|neural|neuron|mind|eeg|scan|breakthrough/i;

// Facts from segment 3 that the quiz depends on. A rewrite must keep all of them.
const FACTS = [
  ['FCFS', /FCFS|first[- ]come/i],
  ['convoy effect', /convoy/i],
  ['SJF', /SJF|shortest[- ]job/i],
  ['lowest average wait', /(minim|lowest|shortest|smallest).{0,30}(average )?wait/i],
  ['SRTF (preemptive SJF)', /SRTF|shortest[- ]remaining/i],
  ['Priority', /priority/i],
  ['starvation', /starv/i],
  ['aging', /aging|ageing/i],
  ['Round Robin', /round[- ]robin|\bRR\b/i],
  ['time quantum', /quantum/i],
  ['big quantum = FCFS', /(large|big|huge).{0,60}(FCFS|first[- ]come)/i],
  ['MLFQ', /MLFQ|multilevel feedback/i],
  ['demoted after full quantum', /demot|lower[- ]priority queue|moves? down/i]
];

// Three synthetic readers, each a trace like the phone records (one row / 0.5 s).
const row = (o) => ({ segment: 's3', scrollVel: 0, reversals: 0, rereadPx: 0, jitter: 0.12, pressureVar: 0.0004, idleMs: 400, distraction: 0.1, load: 0.1, fatigue: 0.1, ...o });
const ramp = (n, f) => Array.from({ length: n }, (_, i) => row(f(i / (n - 1))));
const READERS = [
  {
    name: 'The re-reader',
    story: 'Reads slowly, then keeps scrolling back up over the same paragraph.',
    expect: ['simplify', 'visual'],
    node: { state: 'overloaded', attention: 0.38, distraction: 0.12, load: 0.71, fatigue: 0.2, dwellRatio: 1.4 },
    trace: ramp(16, (t) => ({ scrollVel: Math.round(60 + 40 * t), reversals: Math.round(1 + 4 * t), rereadPx: Math.round(40 + 560 * t), load: +(0.2 + 0.6 * t).toFixed(2) }))
  },
  {
    name: 'The skimmer',
    story: 'Flicks through fast, changes direction a lot, phone moving in the hand.',
    expect: ['condense'],
    node: { state: 'distracted', attention: 0.41, distraction: 0.68, load: 0.15, fatigue: 0.1, dwellRatio: 0.25 },
    trace: ramp(16, (t) => ({ scrollVel: Math.round(300 + 1300 * t), reversals: Math.round(2 + 6 * t), jitter: +(0.3 + 1.2 * t).toFixed(2), distraction: +(0.2 + 0.6 * t).toFixed(2) }))
  },
  {
    name: 'The fader',
    story: 'Stops scrolling, long pauses, phone slowly tilting away.',
    expect: ['simplify', 'visual', 'condense'],
    node: { state: 'fatigued', attention: 0.44, distraction: 0.2, load: 0.25, fatigue: 0.63, dwellRatio: 1.9 },
    trace: ramp(16, (t) => ({ scrollVel: Math.round(40 * (1 - t)), idleMs: Math.round(800 + 11000 * t), jitter: +(0.1 + 0.25 * t).toFixed(2), fatigue: +(0.2 + 0.55 * t).toFixed(2) }))
  }
];

async function post(url, body) {
  const t0 = Date.now();
  const r = await fetch(APP + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${url}: HTTP ${r.status}, not JSON: ${text.slice(0, 120)}`);
  }
  if (!r.ok) throw new Error(`${url}: ${json.error ?? r.status}`);
  return { ...json, wallMs: Date.now() - t0 };
}

const rewriteText = (t) => [t.summary, ...(t.points ?? [])].filter(Boolean).join('\n');

// Spark as a strict reader: answer only from the passage, or say "unknown".
async function readerCheck(client, passage) {
  spend(1, 'reader check');
  const qs = [...quiz.sets.A, ...quiz.sets.B];
  const t0 = Date.now();
  const res = await client.chat.completions.create(
    {
      model: SPARK,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a strict test-taker. Answer ONLY from the passage given. If the passage does not state the answer, reply -1 for that question even if you know it. Reply with JSON only.' },
        {
          role: 'user',
          content: `Passage:\n${passage}\n\nQuestions:\n${qs.map((q, i) => `${i + 1}. ${q.q}\n${q.options.map((o, j) => `   ${j}) ${o}`).join('\n')}`).join('\n')}\n\nReturn {"answers": [<option index or -1>, ... ${qs.length} numbers]}`
        }
      ]
    },
    { timeout: 90000 }
  );
  const raw = res.choices?.[0]?.message?.content ?? '';
  let answers = [];
  try {
    answers = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).answers ?? [];
  } catch {}
  return { correct: qs.filter((q, i) => Number(answers[i]) === q.answer).length, total: qs.length, answers, latencyMs: Date.now() - t0 };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

(async () => {
  const out = { startedAt: new Date().toISOString(), app: APP, readers: [], rewrites: [], image: null, errors: [] };
  const log = (...a) => console.log(...a);

  let status;
  try {
    status = await fetch(`${APP}/api/status`).then((r) => r.json());
  } catch {
    console.error(`Can't reach the app at ${APP}. Start it first with: npm start`);
    process.exit(1);
  }
  out.status = status;
  if (status.mode !== 'live' && !process.argv.includes('--allow-demo')) {
    console.error('The app is in DEMO MODE (no META_API_KEY in .env, or DEMO_MODE=1). Add the key, restart npm start, and run again.');
    process.exit(1);
  }
  if (!KEY) {
    console.error('META_API_KEY is empty in .env, so the reader check cannot call Muse Spark.');
    process.exit(1);
  }
  const client = new OpenAI({ apiKey: KEY, baseURL: process.env.META_BASE_URL || 'https://api.meta.ai/v1', maxRetries: 0 });
  log(`\nThalamuse live test · ${status.sparkModel} + ${status.imageModel} · budget ${BUDGET} Muse calls\n`);

  // 1. Three readers: does Spark read each trace differently, honestly, with numbers?
  log('1/4  Three readers, one dense section');
  for (const r of READERS) {
    try {
      spend(1, `explain (${r.name})`);
      const e = await post('/api/explain', { segmentId: 's3', node: r.node, trace: r.trace });
      const checks = {
        fromMuse: e.explanationSource === 'muse',
        citesNumber: /\d/.test(e.explanation),
        honest: !BANNED.test(e.explanation),
        strategyFits: r.expect.includes(e.strategy),
        fitsBeat: e.wallMs < 20000
      };
      out.readers.push({ ...r, trace: undefined, result: e, checks });
      log(`     ${r.name.padEnd(14)} → ${e.strategy.padEnd(9)} ${e.wallMs} ms  ${e.explanation}`);
    } catch (err) {
      out.errors.push(`${r.name}: ${err.message}`);
      log(`     ${r.name}: FAILED ${err.message}`);
      if (/budget/.test(err.message)) break;
    }
  }

  // 2 + 3. Each rewrite strategy: facts kept, words saved, and can a strict reader still pass the quiz?
  log('\n2/4  Rewrites: facts kept and words saved');
  log('3/4  Strict reader: answers the 6 quiz questions from the rewrite alone');
  let baseline;
  try {
    baseline = await readerCheck(client, seg.text);
    log(`     original text         reader ${baseline.correct}/${baseline.total}`);
  } catch (err) {
    out.errors.push(`baseline reader: ${err.message}`);
  }
  out.baseline = baseline;
  for (const strategy of ['simplify', 'condense', 'visual']) {
    try {
      spend(1, `rewrite (${strategy})`);
      const t = await post('/api/transform/text', { segmentId: 's3', state: strategy });
      const text = rewriteText(t);
      const kept = FACTS.filter(([, re]) => re.test(text)).map(([n]) => n);
      const missing = FACTS.filter(([, re]) => !re.test(text)).map(([n]) => n);
      const rec = { strategy, result: t, words: words(text), origWords: words(seg.text), kept, missing, honest: !BANNED.test(text) };
      try {
        rec.reader = await readerCheck(client, text);
      } catch (err) {
        out.errors.push(`reader ${strategy}: ${err.message}`);
      }
      out.rewrites.push(rec);
      log(`     ${strategy.padEnd(9)} ${t.wallMs} ms  ${rec.words}/${rec.origWords} words  facts ${kept.length}/${FACTS.length}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}  reader ${rec.reader?.correct ?? '?'}/${rec.reader?.total ?? 6}`);
    } catch (err) {
      out.errors.push(`${strategy}: ${err.message}`);
      log(`     ${strategy}: FAILED ${err.message}`);
      if (/budget/.test(err.message)) break;
    }
  }

  // Cache check: the reshape the phone triggers should come back instantly once prefetched.
  try {
    const again = await post('/api/transform/text', { segmentId: 's3', state: 'simplify' });
    out.cacheHitMs = again.wallMs;
    log(`     prefetched rewrite returned again in ${again.wallMs} ms (no Muse call)`);
  } catch {}

  // 4. Muse Image
  log('\n4/4  Muse Image visual summary');
  if (SKIP_IMAGE) log('     skipped (--no-image)');
  else {
    try {
      spend(1, 'image');
      const img = await post('/api/transform/image', { segmentId: 's3', state: 'overloaded' });
      out.image = { latencyMs: img.wallMs, prompt: img.prompt, src: img.src };
      log(`     image in ${img.wallMs} ms`);
    } catch (err) {
      out.errors.push(`image: ${err.message}`);
      log(`     image: FAILED ${err.message}`);
    }
  }

  out.museCalls = used;
  out.finishedAt = new Date().toISOString();
  const dir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = out.startedAt.replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(dir, `live-${stamp}.json`), JSON.stringify({ ...out, image: out.image && { ...out.image, src: out.image.src?.slice(0, 80) } }, null, 2));
  const file = path.join(dir, `live-${stamp}.html`);
  fs.writeFileSync(file, report(out));
  log(`\n${used} Muse calls used. ${out.errors.length ? `${out.errors.length} problem(s), see report.` : 'No errors.'}`);
  log(`Report: ${file}\n`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

function report(o) {
  const tick = (b) => (b ? '<span class="ok">✓</span>' : '<span class="no">✗</span>');
  const readers = o.readers
    .map(
      (r) => `<article class="card">
      <p class="k">${esc(r.name)} · inferred ${esc(r.node.state)}</p>
      <p class="story">${esc(r.story)}</p>
      <blockquote>${esc(r.result.explanation)}</blockquote>
      <p class="meta">strategy <b>${esc(r.result.strategy)}</b> · ${r.result.wallMs} ms</p>
      <ul class="checks">
        <li>${tick(r.checks.fromMuse)} written by Muse Spark (not the fallback)</li>
        <li>${tick(r.checks.citesNumber)} cites numbers from the trace</li>
        <li>${tick(r.checks.honest)} no banned wording</li>
        <li>${tick(r.checks.strategyFits)} strategy fits the reader</li>
        <li>${tick(r.checks.fitsBeat)} answered within 20 s (the app asks early and never waits on it)</li>
      </ul></article>`
    )
    .join('');
  const rewrites = o.rewrites
    .map(
      (w) => `<article class="card">
      <p class="k">${esc(w.strategy)} · ${w.result.wallMs} ms</p>
      <p class="big">${w.words}<small>/${w.origWords} words</small> · ${w.kept.length}<small>/${FACTS.length} facts</small> · ${w.reader?.correct ?? '?'}<small>/${w.reader?.total ?? 6} answerable</small></p>
      ${w.missing.length ? `<p class="miss">Missing: ${w.missing.map(esc).join(', ')}</p>` : '<p class="ok">Every quiz fact kept.</p>'}
      ${w.result.summary ? `<p class="sum">${md(w.result.summary)}</p>` : ''}
      <ol>${(w.result.points ?? []).map((p) => `<li>${md(p)}</li>`).join('')}</ol></article>`
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Thalamuse live test</title>
<style>
:root{--paper:#f4efe6;--ink:#1d1a16;--ink3:#7a7166;--rule:#d9d0c1;--muse:#6c4fd8;--ok:#10a08f;--no:#e2523f}
@media (prefers-color-scheme:dark){:root{--paper:#15130f;--ink:#eee6d8;--ink3:#8f8678;--rule:#2c2822}}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.55 Georgia,'Newsreader',serif}
main{max-width:1080px;margin:0 auto;padding:40px 20px 80px}
h1{font-weight:400;font-size:2.6rem;margin:.2em 0}h1 em{color:var(--muse)}
h2{font-weight:400;font-size:1.6rem;margin:48px 0 6px;border-top:1px solid var(--rule);padding-top:20px}
.k,.meta,.mono,.checks,small{font-family:ui-monospace,Menlo,monospace;font-size:.78rem;color:var(--ink3)}
.k{text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
.card{border:1px solid var(--rule);border-radius:14px;padding:18px}
blockquote{margin:10px 0;font-style:italic;font-size:1.1rem;border-left:3px solid var(--muse);padding-left:12px}
.checks{list-style:none;padding:0;line-height:1.9}.ok{color:var(--ok)}.no,.miss{color:var(--no)}
.big{font-size:1.4rem;margin:4px 0}.sum{font-style:italic}
ol{padding-left:1.2em}li{margin:4px 0}img{max-width:100%;border-radius:12px;border:1px solid var(--rule)}
.story{margin:0;color:var(--ink3)}
</style></head><body><main>
<p class="k">Live test · ${esc(o.startedAt)} · ${esc(o.status.sparkModel)} + ${esc(o.status.imageModel)} · ${o.museCalls} Muse calls</p>
<h1>Thala<em>muse</em>, tested live</h1>
<p>Synthetic reader traces sent through the app's own endpoints, exactly as the phone sends them. All states are inferred from scroll, touch and phone motion.</p>
${o.errors.length ? `<p class="miss">Problems: ${o.errors.map(esc).join(' · ')}</p>` : ''}
<h2>1 · Three readers, one dense section</h2>
<p>Same passage, three different sensor traces. Muse Spark reads each trace and explains, in its own words, why attention looks like it is dropping, then picks how to reshape.</p>
<div class="grid">${readers}</div>
<h2>2 · Three reshapes, nothing lost</h2>
<p>Each strategy's rewrite is checked for the ${FACTS.length} facts the quiz depends on. Then Muse Spark, acting as a strict reader told to answer <i>only</i> from the passage, takes all six quiz questions using the rewrite alone. On the original text it got <b>${o.baseline?.correct ?? '?'}/${o.baseline?.total ?? 6}</b>.</p>
<div class="grid">${rewrites}</div>
${o.cacheHitMs != null ? `<p class="mono">Prefetched rewrite served again in ${o.cacheHitMs} ms, so the reshape on the phone needs no wait.</p>` : ''}
<h2>3 · Muse Image visual summary</h2>
${o.image ? `<p class="mono">${o.image.latencyMs} ms · prompt written by Muse Spark</p><img src="${esc(o.image.src)}" alt="Muse Image summary of the section"><p class="mono">${esc(o.image.prompt)}</p>` : '<p class="mono">Not run.</p>'}
</main></body></html>`;
}
