// Quick check of the Meta Model API settings in .env, independent of the app:
//   npm run check-muse
require('dotenv').config();
const OpenAI = require('openai');

const KEY = process.env.META_API_KEY?.trim();
const BASE_URL = process.env.META_BASE_URL || 'https://api.meta.ai/v1';
const SPARK = process.env.MUSE_SPARK_MODEL || 'muse-spark-1.3';
const IMAGE = process.env.MUSE_IMAGE_MODEL || 'muse-image-1.0';

(async () => {
  if (!KEY) {
    console.log('META_API_KEY is empty in .env, so the app runs in DEMO MODE. Nothing to check.');
    return;
  }
  console.log(`Base URL: ${BASE_URL}\nSpark model: ${SPARK}\nImage model: ${IMAGE}\nKey: ${KEY.slice(0, 4)}…${KEY.slice(-4)} (${KEY.length} chars)\n`);

  // Which model ids does this key see?
  try {
    const r = await fetch(`${BASE_URL.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
    const j = await r.json().catch(() => null);
    const ids = (j?.data ?? []).map((m) => m.id);
    if (ids.length) {
      console.log(`Models available to this key: ${ids.join(', ')}`);
      for (const [name, id] of [['MUSE_SPARK_MODEL', SPARK], ['MUSE_IMAGE_MODEL', IMAGE]]) {
        if (!ids.includes(id)) console.log(`  -> ${name}=${id} is not in that list. Set it to one of the ids above in .env.`);
      }
      console.log('');
    } else {
      console.log(`GET /models: HTTP ${r.status}, no model list returned\n`);
    }
  } catch (err) {
    console.log(`GET /models failed: ${err.message}\n`);
  }

  // Raw request first, so an HTML page or a wrong path is visible as-is.
  try {
    const r = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SPARK, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] })
    });
    const body = await r.text();
    console.log(`Spark: HTTP ${r.status}, content-type ${r.headers.get('content-type')}`);
    console.log(`  body: ${body.slice(0, 300).replace(/\s+/g, ' ')}\n`);
    if (/^\s*</.test(body)) console.log('  -> This is a web page, not an API response. META_BASE_URL is probably wrong.\n');
    if (/model_not_found/.test(body)) console.log(`  -> "${SPARK}" isn't a model id this key can use. Meta's docs list Spark as "muse-spark-1.3" (no "meta/" prefix).\n`);
  } catch (err) {
    console.log(`Spark: request failed: ${err.message}\n`);
  }

  try {
    const client = new OpenAI({ apiKey: KEY, baseURL: BASE_URL, maxRetries: 0 });
    const t0 = Date.now();
    const res = await client.images.generate({ model: IMAGE, prompt: 'a small blue circle on white', n: 1 }, { timeout: 75000 });
    const d = res.data?.[0] ?? {};
    console.log(`Image: OK in ${Date.now() - t0} ms (${d.b64_json ? 'base64 image' : d.url ? 'url ' + d.url : 'no image in response'})`);
  } catch (err) {
    console.log(`Image: failed: ${err.status ?? ''} ${String(err.message).slice(0, 300)}`);
  }
})();
