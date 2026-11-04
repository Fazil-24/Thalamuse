// Meta Model API client (OpenAI-compatible). All Muse calls go through here so
// the API key never reaches the browser.
const OpenAI = require('openai');
const { DEMO_PREFIX, demoText, demoImage } = require('./demo');

const KEY = process.env.META_API_KEY?.trim();
const DEMO = !KEY || process.env.DEMO_MODE === '1';
const SPARK = process.env.MUSE_SPARK_MODEL || 'muse-spark-1.3';
const IMAGE = process.env.MUSE_IMAGE_MODEL || 'muse-image-1.0';
const BASE_URL = process.env.META_BASE_URL || 'https://api.meta.ai/v1';

const client = DEMO ? null : new OpenAI({ apiKey: KEY, baseURL: BASE_URL, maxRetries: 0 });

// Every Muse call has to finish well inside the HTTPS tunnel's ~100 s limit,
// otherwise the tunnel answers the phone with an HTML error page.
// Measured live on 2026-11-04: explain 12-18 s, rewrite 26-40 s, image 8-22 s.
const TIMEOUTS = { explain: 45000, text: 85000, image: 85000, plan: 45000 };

// Turn SDK/network errors into a message a person can act on.
function describe(err, what) {
  const raw = String(err?.message ?? err).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (err?.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(raw)) return `${what} didn't answer in time`;
  if (err?.name === 'APIConnectionError') return `couldn't reach ${BASE_URL} (${raw})`;
  if (err?.status === 401 || err?.status === 403) return `the Meta API rejected the key (HTTP ${err.status}); check META_API_KEY`;
  if (err?.status === 404) return `HTTP 404 from ${BASE_URL}; check META_BASE_URL and the model name (${what === 'Muse Image' ? IMAGE : SPARK})`;
  if (/Unexpected token '<'|is not valid JSON/.test(raw)) return `${BASE_URL} sent back a web page instead of JSON, so META_BASE_URL is probably wrong`;
  if (err?.status) return `HTTP ${err.status} from the Meta API: ${raw}`;
  return raw;
}

const wrap = (what, fn) =>
  fn().catch((err) => {
    const e = new Error(describe(err, what));
    e.status = err?.status;
    throw e;
  });

if (DEMO) {
  console.warn(`\n⚠  ${DEMO_PREFIX} Muse calls will return simulated, clearly-labelled content.\n`);
}

// Which rewrite fits which inferred state.
const STYLE_FOR_STATE = {
  overloaded: 'simplify',
  fatigued: 'simplify',
  distracted: 'condense',
  focused: 'simplify'
};

const STYLE_INSTRUCTIONS = {
  simplify:
    'The reader appears overloaded. Rewrite the passage in plain, short sentences, using no more than about 60% of the word count of the original. Keep every fact, name, number and cause-and-effect relationship from the original, because the reader will be quizzed on it. One idea per bullet. Bold the key terms with **double asterisks**.',
  visual:
    'The reader appears to be losing the thread of a long passage. Give a very short text scaffold (3 to 5 bullets of a few words each) that labels the parts of a diagram, keeping every named concept, number and comparison (which option is best or worst at what) from the original because the reader will be quizzed on it. The diagram will carry most of the explanation. Bold the key terms with **double asterisks**.',
  condense:
    'The reader appears distracted. Condense the passage to its essential points, as few words as possible, but keep every named concept, number, trade-off and comparison (which option is best or worst at what) from the original, because the reader will be quizzed on it. Bold the key terms with **double asterisks**.'
};

function buildMessages(segment, style) {
  return [
    {
      role: 'system',
      content:
        'You reformat dense study material for a phone screen. You never add facts that are not in the source and never drop facts that are. Reply with JSON only, no code fences.'
    },
    {
      role: 'user',
      content: `${STYLE_INSTRUCTIONS[style]}

Return exactly this JSON shape:
{"summary": "<one sentence overview>", "points": ["<bullet>", "..."], "image_prompt": "<a prompt for an image model to draw ONE clear diagram or infographic that summarizes this passage; describe layout and labels, flat style, white background>"}

Section heading: ${segment.heading}
Passage:
${segment.text}`
    }
  ];
}

function parseSpark(raw) {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    const j = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
    if (typeof j.summary === 'string' && Array.isArray(j.points)) return j;
  } catch {}
  // Model ignored the format; show its text rather than failing the demo.
  return { summary: '', points: cleaned.split(/\n+/).map((l) => l.replace(/^[-*•]\s*/, '')).filter(Boolean), image_prompt: null };
}

const cache = new Map(); // key -> Promise<result>

function cached(key, fn) {
  if (!cache.has(key)) {
    const p = fn().catch((err) => {
      cache.delete(key); // allow a retry after a failure
      throw err;
    });
    cache.set(key, p);
  }
  return cache.get(key);
}

const STRATEGIES = Object.keys(STYLE_INSTRUCTIONS);
const resolveStyle = (x) => (STRATEGIES.includes(x) ? x : STYLE_FOR_STATE[x] || 'simplify');

function transformText(segment, stateOrStrategy) {
  const style = resolveStyle(stateOrStrategy);
  return cached(`text:${segment.id}:${style}`, async () => {
    const t0 = Date.now();
    if (DEMO) {
      console.log(`[demo] simulated Muse Spark rewrite for ${segment.id} (${style})`);
      await new Promise((r) => setTimeout(r, 600));
      return { mode: 'demo', model: SPARK, style, ...demoText(segment, style), latencyMs: Date.now() - t0 };
    }
    const res = await wrap('Muse Spark', () =>
      client.chat.completions.create({ model: SPARK, messages: buildMessages(segment, style), temperature: 0.2 }, { timeout: TIMEOUTS.text })
    );
    const out = parseSpark(res.choices?.[0]?.message?.content ?? '');
    console.log(`[muse] Spark ${segment.id} (${style}) in ${Date.now() - t0} ms`);
    return { mode: 'live', model: SPARK, style, ...out, latencyMs: Date.now() - t0 };
  });
}

function transformImage(segment, state) {
  return cached(`image:${segment.id}`, async () => {
    const t0 = Date.now();
    if (DEMO) {
      console.log(`[demo] simulated Muse Image result for ${segment.id}`);
      await new Promise((r) => setTimeout(r, 900));
      return { mode: 'demo', model: IMAGE, src: demoImage(segment), latencyMs: Date.now() - t0 };
    }
    // Let Spark's rewrite supply the image prompt when it is available.
    let prompt = `A clear, flat, labeled infographic summarizing "${segment.heading}": ${segment.text.slice(0, 600)}`;
    try {
      // Use Spark's prompt if it is ready soon; don't let it eat the image's time budget.
      const text = await Promise.race([transformText(segment, state), new Promise((_, rej) => setTimeout(rej, 8000))]);
      if (text.image_prompt) prompt = text.image_prompt;
    } catch {}
    const res = await wrap('Muse Image', () => client.images.generate({ model: IMAGE, prompt, n: 1 }, { timeout: TIMEOUTS.image }));
    const d = res.data?.[0] ?? {};
    const src = d.b64_json ? `data:image/png;base64,${d.b64_json}` : d.url;
    if (!src) throw new Error('Muse Image returned no image');
    console.log(`[muse] Image ${segment.id} in ${Date.now() - t0} ms`);
    return { mode: 'live', model: IMAGE, src, prompt, latencyMs: Date.now() - t0 };
  });
}

// Words the UI must never show. If Spark uses one, its explanation is dropped
// in favour of the rules-based one.
const BANNED = /brain|neural|neuron|mind|eeg|scan|breakthrough/i;

function ruleExplanation(node, trace) {
  const last = trace[trace.length - 1] ?? {};
  const bits = [];
  if (last.rereadPx > 40) bits.push(`scrolled back over about ${Math.round(last.rereadPx)} px of this section in the last few seconds`);
  if (node.dwellRatio > 0.5) bits.push(`stayed on it for ${Math.round(node.dwellRatio * 100)}% of its expected reading time`);
  if (last.scrollVel > 350) bits.push(`scrolled quickly (${Math.round(last.scrollVel)} px/s) with ${last.reversals} direction changes`);
  if (last.jitter > 0.35) bits.push('moved the phone around more than while reading earlier');
  if (last.idleMs > 7000) bits.push(`stopped scrolling or touching for ${Math.round(last.idleMs / 1000)} s`);
  return `The reader ${bits.length ? bits.join(', and ') : 'showed a mix of weak signals'}, so attention on this section was inferred to be dropping.`;
}

// Spark reads the recent sensor-derived trace for the at-risk segment, says in
// one or two sentences why attention was inferred to drop, and picks how to
// reshape the segment.
async function explainState(segment, { node, trace }) {
  const t0 = Date.now();
  const fallbackStrategy = resolveStyle(node.state);
  if (DEMO) {
    console.log(`[demo] simulated Muse Spark explanation for ${segment.id}`);
    return {
      mode: 'demo',
      model: SPARK,
      explanation: `${DEMO_PREFIX} ${ruleExplanation(node, trace)}`,
      strategy: fallbackStrategy,
      latencyMs: Date.now() - t0
    };
  }
  const res = await wrap('Muse Spark', () => client.chat.completions.create(
    {
      model: SPARK,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You interpret behavioural reading signals from a phone (scroll, touch, phone motion) for a reading app. These are indirect signals, so describe them as inferred. Never mention the brain, neurons, the mind, scans or EEG. Reply with JSON only, no code fences.'
        },
        {
          role: 'user',
          content: `A reader is on the section "${segment.heading}" (difficulty: ${segment.difficulty}). A rules-based classifier flagged it as at risk with inferred state "${node.state}".

Segment summary scores (0..1, inferred): ${JSON.stringify({ attention: node.attention, distraction: node.distraction, load: node.load, fatigue: node.fatigue, dwellRatio: node.dwellRatio })}

Feature trace, oldest first, one row every ~0.5 s. Fields: scrollVel px/s, reversals (scroll direction changes in 2.5 s), rereadPx (slow upward scroll in 8 s), jitter (std-dev of phone acceleration, m/s²), pressureVar (touch pressure variance), idleMs (time since last scroll/touch), plus the instant distraction/load/fatigue scores:
${JSON.stringify(trace)}

1. In at most two short sentences for the reader, explain which signals changed and why that suggests attention dropped. Cite concrete numbers from the trace.
2. Pick one reshaping strategy: "simplify" (plain short sentences, for overload), "condense" (fewest words, for distraction), or "visual" (diagram first with a minimal text scaffold, for a reader losing the thread of a long passage).

Return exactly: {"explanation": "...", "strategy": "simplify|condense|visual"}`
        }
      ]
    },
    { timeout: TIMEOUTS.explain }
  ));
  const raw = (res.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let out = {};
  try {
    out = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {}
  const strategy = STRATEGIES.includes(out.strategy) ? out.strategy : fallbackStrategy;
  let explanation = typeof out.explanation === 'string' ? out.explanation.trim() : '';
  let source = 'muse';
  if (!explanation || BANNED.test(explanation)) {
    console.warn('[muse] Spark explanation missing or used banned wording; using rules-based explanation');
    explanation = ruleExplanation(node, trace);
    source = 'rules';
  }
  console.log(`[muse] Spark explain ${segment.id} -> ${strategy} in ${Date.now() - t0} ms`);
  return { mode: 'live', model: SPARK, explanation, explanationSource: source, strategy, latencyMs: Date.now() - t0 };
}

// Your own text: Spark groups numbered blocks of the reader's text into a few
// titled sections and marks the densest one. It only returns block numbers, so
// the reader's words are never rewritten at this step.
async function planSections(title, blocks) {
  const t0 = Date.now();
  if (DEMO) return null;
  const res = await wrap('Muse Spark', () =>
    client.chat.completions.create(
      {
        model: SPARK,
        temperature: 0.1,
        messages: [
          { role: 'system', content: 'You organise study material into sections for a phone reading app. Reply with JSON only, no code fences.' },
          {
            role: 'user',
            content: `Below is a text split into ${blocks.length} numbered blocks. Group consecutive blocks into ${Math.min(6, Math.max(2, Math.round(blocks.length / 2)))} sections (between 2 and 6). Every block must belong to exactly one section, in order. Lines starting with # are headings from the original document; prefer starting sections at them and reuse their wording.
For each section give a short heading (at most 7 words, taken from its content) and a difficulty: "easy", "medium" or "hard". Mark exactly one section "hard": the densest one, with the most new terms, numbers or steps.
Also give the whole text a short title (at most 8 words)${title ? `; the reader called it "${title}"` : ''}.

Return exactly: {"title": "...", "sections": [{"heading": "...", "start": <first block number>, "end": <last block number>, "difficulty": "easy|medium|hard"}]}

${blocks.map((b, i) => `[${i + 1}] ${b}`).join('\n\n')}`
          }
        ]
      },
      { timeout: TIMEOUTS.plan }
    )
  );
  const raw = (res.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  console.log(`[muse] Spark planned ${j.sections?.length} sections in ${Date.now() - t0} ms`);
  return j;
}

module.exports = {
  planSections,
  describe,
  explainState,
  STRATEGIES,
  transformText,
  transformImage,
  status: () => ({ mode: DEMO ? 'demo' : 'live', sparkModel: SPARK, imageModel: IMAGE, baseURL: BASE_URL, demoPrefix: DEMO_PREFIX })
};
