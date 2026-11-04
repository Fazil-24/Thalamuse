// "Read your own text": PDF text is extracted on the phone with pdf.js, so the
// file itself never leaves the device. Only the extracted text goes to the
// server, which asks Muse Spark to group it into sections.
import { postJson } from './transform.js';

const MAX_PAGES = 30;
const SAVED = 'thalamuse.ownArticle';

let pdfjs;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjs;
}

// Rebuild paragraphs from positioned text: a vertical gap clearly bigger than
// the usual line spacing starts a new paragraph. Lines that repeat on most
// pages (running headers, footers) and bare page numbers are dropped.
export async function extractPdf(file, onProgress) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  const pages = [];
  for (let p = 1; p <= n; p++) {
    onProgress?.(p, n);
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (!('str' in it)) continue;
      const y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      if (!cur || Math.abs(cur.y - y) > h * 0.5) {
        if (cur) lines.push(cur);
        cur = { y, h, text: '' };
      }
      cur.text += it.str;
      if (it.hasEOL) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);
    pages.push(lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter((l) => l.text));
  }
  const freq = new Map();
  for (const lines of pages) for (const t of new Set(lines.map((l) => l.text.replace(/\d+/g, '#')))) freq.set(t, (freq.get(t) ?? 0) + 1);
  const repeated = (t) => n >= 3 && (freq.get(t.replace(/\d+/g, '#')) ?? 0) >= Math.max(3, n * 0.5);

  // Body text size = the most common line height; clearly bigger short lines are headings.
  const sizes = new Map();
  for (const lines of pages) for (const l of lines) sizes.set(Math.round(l.h), (sizes.get(Math.round(l.h)) ?? 0) + l.text.length);
  const body = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const isHead = (l) => l.h > body * 1.15;

  const paras = [];
  for (const lines of pages) {
    const keep = lines.filter((l) => !/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d+)?$/i.test(l.text) && !repeated(l.text));
    const gaps = keep.slice(1).map((l, i) => Math.abs(keep[i].y - l.y)).filter((g) => g > 0).sort((a, b) => a - b);
    const typical = gaps[Math.floor(gaps.length / 2)] ?? body * 1.4;
    let para = null;
    const flush = () => {
      if (para) paras.push(para.head && para.text.split(/\s+/).length <= 14 ? `# ${para.text}` : para.text);
      para = null;
    };
    keep.forEach((l, i) => {
      const prev = keep[i - 1];
      const gap = prev ? Math.abs(prev.y - l.y) : 0;
      // New paragraph on a clearly bigger gap than this text size's normal line
      // spacing, or when the text size switches between heading and body.
      if (para && (gap > Math.max(typical, l.h * 1.25) * 1.45 || isHead(l) !== para.head)) flush();
      if (!para) para = { head: isHead(l), text: l.text };
      else para.text = para.text.endsWith('-') ? para.text.slice(0, -1) + l.text : `${para.text} ${l.text}`;
    });
    flush();
  }
  return {
    text: paras.join('\n\n'),
    title: ((await doc.getMetadata().catch(() => null))?.info?.Title ?? '').trim(),
    pages: doc.numPages,
    usedPages: n
  };
}

export const savedArticle = (id) => {
  try {
    const a = JSON.parse(sessionStorage.getItem(SAVED));
    return a?.id === id ? a : null;
  } catch {
    return null;
  }
};

export function mountOwn(root) {
  let fileTitle = '';
  const $ = (s) => root.querySelector(s);
  const msg = (t, bad = false) => {
    $('#own-msg').textContent = t;
    $('#own-msg').classList.toggle('bad', bad);
  };

  $('#own-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileTitle = file.name.replace(/\.\w+$/, '');
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        msg('Reading the PDF on this phone…');
        const r = await extractPdf(file, (p, n) => msg(`Reading page ${p} of ${n} on this phone…`));
        $('#own-text').value = r.text;
        if (!$('#own-title').value) $('#own-title').value = r.title;
        const w = r.text.replace(/^# /gm, '').split(/\s+/).filter(Boolean).length;
        msg(w < 120 ? 'Found almost no text. Scanned PDFs (images of pages) have no text layer, so paste the text instead.' : `Found ${w} words on ${r.usedPages}${r.pages > r.usedPages ? ` of ${r.pages}` : ''} pages. Check it below, then shape it.`, w < 120);
      } else {
        $('#own-text').value = await file.text();
        msg('Loaded. Check it below, then shape it.');
      }
    } catch (err) {
      msg(`Couldn't read that file: ${err.message}`, true);
    }
  };

  $('#own-go').onclick = async () => {
    const text = $('#own-text').value.trim();
    if (!text) return msg('Pick a PDF or paste some text first.', true);
    $('#own-go').disabled = true;
    msg('Muse Spark is dividing it into sections…');
    try {
      const a = await postJson('/api/article/custom', { title: $('#own-title').value.trim(), fileTitle, text });
      try {
        sessionStorage.setItem(SAVED, JSON.stringify(a));
      } catch {}
      location.href = `/?a=${encodeURIComponent(a.id)}`;
    } catch (err) {
      msg(err.message, true);
      $('#own-go').disabled = false;
    }
  };
}
