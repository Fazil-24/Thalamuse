// "Read your own text": turns pasted or PDF-extracted text into an article the
// rest of the app treats exactly like the built-in one. Kept in memory only,
// like the graph snapshot; restarting the server forgets them (the phone keeps
// a copy and can re-register it).
const MAX_WORDS = 3000;
const MIN_WORDS = 120;
const BLOCK_WORDS = 140;

const store = new Map(); // id -> article

const words = (t) => t.trim().split(/\s+/).filter(Boolean).length;
const sentences = (t) => t.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];

function clean(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/(\w)-\n(\w)/g, '$1$2') // hyphenated line breaks from PDFs
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Paragraphs (a line starting with "#" is a heading, which the phone's PDF
// reader marks from text size; pasted Markdown works too), then split any long
// paragraph by sentences so every block is a chunk of at most ~BLOCK_WORDS words.
// Returns [{ heading?, text }] plus a title if the text opened with one.
function toBlocks(text) {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  const blocks = [];
  let heading = null;
  let title = null;
  for (const p of paras) {
    const h = p.match(/^#{1,6}\s+(.+)$/);
    if (h && words(h[1]) <= 14) {
      if (heading && !blocks.length && !title) title = heading; // two headings before any text: the first is the title
      heading = h[1].trim();
      continue;
    }
    const chunks = [];
    if (words(p) <= BLOCK_WORDS * 1.4) chunks.push(p);
    else {
      let cur = '';
      for (const s of sentences(p)) {
        if (cur && words(cur) + words(s) > BLOCK_WORDS) {
          chunks.push(cur);
          cur = s;
        } else cur = cur ? `${cur} ${s}` : s;
      }
      if (cur) chunks.push(cur);
    }
    chunks.forEach((c, i) => blocks.push(i === 0 && heading ? { heading, text: c } : { text: c }));
    heading = null;
  }
  // Merge tiny fragments (captions, stray lines) into a neighbour, never across a heading.
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && words(last.text) < 25 && !b.heading) last.text += ` ${b.text}`;
    else if (last && words(b.text) < 25 && !b.heading) last.text += ` ${b.text}`;
    else merged.push({ ...b });
  }
  return { blocks: merged, title };
}

function truncate(blocks) {
  const out = [];
  let total = 0;
  for (const b of blocks) {
    if (total + words(b.text) > MAX_WORDS && out.length) return { blocks: out, truncated: true };
    out.push(b);
    total += words(b.text);
  }
  return { blocks: out, truncated: false };
}

// How dense a passage looks without any model: long sentences, long words,
// numbers and parentheses.
function density(t) {
  const w = t.split(/\s+/);
  const long = w.filter((x) => x.replace(/\W/g, '').length >= 9).length / w.length;
  const perSentence = w.length / sentences(t).length;
  const nums = (t.match(/\d/g) ?? []).length / w.length;
  const parens = (t.match(/[()]/g) ?? []).length / w.length;
  return perSentence / 25 + long * 3 + nums * 4 + parens * 4;
}

const firstWords = (t) => `${sentences(t)[0].split(/\s+/).slice(0, 6).join(' ').replace(/[,;:.]+$/, '')}…`;

// Fallback planner (demo mode, or Spark failed): split at the text's own
// headings when it has them, otherwise into even groups of blocks.
function rulesPlan(blocks) {
  let starts = blocks.map((b, i) => (b.heading ? i : -1)).filter((i) => i >= 0);
  if (starts.length >= 2) {
    if (starts[0] !== 0) starts.unshift(0);
    // Too many headings: merge the smallest neighbouring sections until there are 6.
    const size = (k) => (starts[k + 1] ?? blocks.length) - starts[k];
    while (starts.length > 6) {
      let best = 1;
      for (let k = 1; k < starts.length; k++) if (size(k - 1) + size(k) < size(best - 1) + size(best)) best = k;
      starts.splice(best, 1);
    }
  } else {
    const n = Math.min(6, Math.max(2, Math.round(blocks.length / 2)));
    const per = Math.ceil(blocks.length / n);
    starts = [];
    for (let i = 0; i < blocks.length; i += per) starts.push(i);
  }
  return { sections: starts.map((i, k) => ({ heading: blocks[i].heading || (k === 0 && !blocks[i].heading ? firstWords(blocks[i].text) : `Part ${k + 1}`), start: i + 1, difficulty: 'medium' })) };
}

// Make whatever came back cover every block once, in order.
function normalise(plan, blocks) {
  let secs = (plan?.sections ?? [])
    .map((s) => ({ heading: String(s.heading ?? '').trim().slice(0, 80), start: Math.round(Number(s.start)), difficulty: s.difficulty }))
    .filter((s) => s.start >= 1 && s.start <= blocks.length)
    .sort((a, b) => a.start - b.start)
    .filter((s, i, a) => i === 0 || s.start !== a[i - 1].start);
  if (secs.length < 1) return null;
  secs[0].start = 1;
  return secs.slice(0, 8).map((s, i, a) => {
    const end = i + 1 < a.length ? a[i + 1].start - 1 : blocks.length;
    const part = blocks.slice(s.start - 1, end);
    return {
      heading: s.heading || part[0].heading || firstWords(part[0].text),
      difficulty: ['easy', 'medium', 'hard'].includes(s.difficulty) ? s.difficulty : 'medium',
      text: part.map((b) => b.text).join('\n\n')
    };
  });
}

function ensureOneHard(segs) {
  const hard = segs.filter((s) => s.difficulty === 'hard');
  if (hard.length === 1) return segs;
  const pool = hard.length ? hard : segs;
  const densest = pool.reduce((a, b) => (density(b.text) > density(a.text) ? b : a));
  for (const s of segs) if (s.difficulty === 'hard' && s !== densest) s.difficulty = 'medium';
  densest.difficulty = 'hard';
  return segs;
}

async function createArticle({ title, fileTitle, text }, muse) {
  title = String(title ?? '').trim();
  const cleaned = clean(text);
  const total = words(cleaned.replace(/^#+\s/gm, ''));
  if (total < MIN_WORDS) {
    const e = new Error(`That's only ${total} words. Give it at least ${MIN_WORDS} so there's something to reshape.`);
    e.status = 400;
    throw e;
  }
  const parsed = toBlocks(cleaned);
  const { blocks, truncated } = truncate(parsed.blocks);
  title = title || parsed.title || String(fileTitle ?? '').trim().slice(0, 90);
  let plan = null;
  let planner = 'rules';
  try {
    plan = await muse.planSections(title, blocks.map((b) => (b.heading ? `# ${b.heading}\n${b.text}` : b.text)));
    if (plan) planner = 'muse';
  } catch (err) {
    console.warn(`[muse] section planning failed, using even split: ${err.message}`);
  }
  const segs = ensureOneHard(normalise(plan, blocks) ?? normalise(rulesPlan(blocks), blocks));
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const article = {
    id,
    custom: true,
    title: String(plan?.title || title || 'Your text').trim().slice(0, 90),
    subtitle: 'Your text',
    planner,
    truncated,
    words: segs.reduce((a, s) => a + words(s.text), 0),
    segments: segs.map((s, i) => ({ id: `${id}-s${i + 1}`, ...s }))
  };
  remember(article);
  return article;
}

function remember(article) {
  store.set(article.id, article);
  while (store.size > 10) store.delete(store.keys().next().value);
}

// The phone re-registers its saved copy if the server was restarted.
function restore(a) {
  const ok =
    a && /^c[a-z0-9]{4,16}$/.test(a.id) && Array.isArray(a.segments) && a.segments.length >= 1 && a.segments.length <= 8 &&
    a.segments.every((s, i) => s.id === `${a.id}-s${i + 1}` && typeof s.text === 'string' && typeof s.heading === 'string' && words(s.text) < MAX_WORDS);
  if (!ok) return null;
  const article = {
    id: a.id,
    custom: true,
    title: String(a.title ?? 'Your text').slice(0, 90),
    subtitle: 'Your text',
    planner: a.planner,
    truncated: !!a.truncated,
    words: a.segments.reduce((n, s) => n + words(s.text), 0),
    segments: a.segments.map((s) => ({ id: s.id, heading: s.heading.slice(0, 80), text: s.text, difficulty: ['easy', 'medium', 'hard'].includes(s.difficulty) ? s.difficulty : 'medium' }))
  };
  remember(article);
  return article;
}

const get = (id) => store.get(id) ?? null;
const segment = (segId) => get(String(segId).split('-')[0])?.segments.find((s) => s.id === segId) ?? null;

module.exports = { createArticle, restore, get, segment };
