require('dotenv').config();
const path = require('path');
const express = require('express');
const article = require('../data/article.json');
const quiz = require('../data/quiz.json');
const muse = require('./muse');
const custom = require('./custom');

const app = express();
// Log every API call so problems show up in this terminal, not only on the phone.
app.use('/api', (req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const url = req.originalUrl.split('?')[0];
    if (url === '/api/graph') return; // posted every second, too noisy
    const line = `[api] ${req.method} ${url} -> ${res.statusCode} in ${Date.now() - t0} ms`;
    res.statusCode >= 400 ? console.warn(line) : console.log(line);
  });
  next();
});
app.use(express.json({ limit: '600kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// pdf.js, served locally so PDF text extraction runs on the phone with no CDN.
app.use('/vendor/pdfjs', express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build')));
// Laptop view of the phone's live state, for filming side by side.
app.get('/mirror', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'mirror.html')));

const segmentById = (id) => article.segments.find((s) => s.id === id) ?? custom.segment(id);

app.get('/api/status', (req, res) => res.json(muse.status()));
app.get('/api/article', (req, res) => res.json(article));
app.get('/api/quiz', (req, res) => res.json(quiz));

// Read your own text (pasted, or extracted from a PDF on the phone).
app.post('/api/article/custom', async (req, res) => {
  try {
    res.json(await custom.createArticle({ title: req.body?.title, fileTitle: req.body?.fileTitle, text: req.body?.text }, muse));
  } catch (err) {
    if (err.status !== 400) console.error('[custom] failed:', err.message);
    res.status(err.status || 502).json({ error: err.message });
  }
});
app.post('/api/article/restore', (req, res) => {
  const a = custom.restore(req.body);
  a ? res.json(a) : res.status(400).json({ error: 'not a valid saved article' });
});
app.get('/api/article/:id', (req, res) => {
  const a = custom.get(req.params.id);
  a ? res.json(a) : res.status(404).json({ error: 'unknown article (the server may have restarted)' });
});

// Muse proxy. Text and image are separate calls so the rewrite can render
// while the (slower) image is still generating.
for (const kind of ['text', 'image']) {
  app.post(`/api/transform/${kind}`, async (req, res) => {
    const segment = segmentById(req.body?.segmentId);
    if (!segment) return res.status(404).json({ error: 'unknown segment' });
    const fn = kind === 'text' ? muse.transformText : muse.transformImage;
    try {
      res.json({ segmentId: segment.id, ...(await fn(segment, req.body.state)) });
    } catch (err) {
      console.error(`[muse] ${kind} ${segment.id} failed:`, err.status ?? '', err.message);
      res.status(502).json({ error: `Muse ${kind} call failed: ${err.message}` });
    }
  });
}

app.post('/api/explain', async (req, res) => {
  const segment = segmentById(req.body?.segmentId);
  const { node, trace } = req.body ?? {};
  if (!segment || !node || !Array.isArray(trace)) return res.status(400).json({ error: 'segmentId, node and trace required' });
  try {
    res.json({ segmentId: segment.id, ...(await muse.explainState(segment, { node, trace: trace.slice(-24) })) });
  } catch (err) {
    console.error(`[muse] explain ${segment.id} failed:`, err.status ?? '', err.message);
    res.status(502).json({ error: `Muse explanation failed: ${err.message}` });
  }
});

// Warm the cache for the demo article's hard segments so the on-stage
// transformation doesn't wait on API latency.
app.post('/api/prewarm', (req, res) => {
  const own = req.body?.articleId ? custom.get(req.body.articleId) : null;
  const hard = (own ?? article).segments.filter((s) => s.difficulty === 'hard');
  // Your own text: warm only the most likely rewrite, to spend fewer Muse calls.
  const strategies = own ? ['simplify'] : muse.STRATEGIES;
  for (const s of hard) {
    for (const strategy of strategies) muse.transformText(s, strategy).catch(() => {});
    muse.transformImage(s, 'overloaded').catch(() => {});
  }
  res.json({ warming: hard.map((s) => s.id) });
});

// Latest content-graph snapshot pushed by the phone, so a laptop can watch the
// same live state (GET /api/graph) while the phone is being read.
let graphSnapshot = null;
app.post('/api/graph', (req, res) => {
  graphSnapshot = { ...req.body, receivedAt: Date.now() };
  res.sendStatus(204);
});
app.get('/api/graph', (req, res) => res.json(graphSnapshot ?? { nodes: [] }));

// Anything under /api answers in JSON, even errors, so the phone never has to
// parse an HTML error page.
app.use('/api', (req, res) => res.status(404).json({ error: `No API route ${req.method} /api${req.path}` }));
app.use((err, req, res, next) => {
  console.error(`[api] ${req.method} ${req.originalUrl} crashed:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: `Server error: ${err.message}` });
});

process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  const s = muse.status();
  console.log(`Thalamuse on http://localhost:${PORT}  (Muse mode: ${s.mode})`);
  console.log(`Laptop mirror for filming: http://localhost:${PORT}/mirror`);
  console.log('Phone sensors need HTTPS: run `npm run tunnel` in another terminal and open the https URL it prints.');
});
