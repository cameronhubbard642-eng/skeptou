/* viewer.js — Strategia in-app document viewer */

const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function el(id) { return document.getElementById(id); }

function fmtSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function showError(msg) {
  el('err-state').textContent = msg;
  el('err-state').style.display = '';
}

function setBadge(label, value) {
  const span = document.createElement('span');
  span.className = 'sk-badge';
  span.textContent = `${label}: ${value}`;
  el('doc-meta').appendChild(span);
}

async function renderPDF(slug) {
  if (typeof pdfjsLib === 'undefined') {
    showError('PDF renderer failed to load.');
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

  el('pdf-loading').style.display = '';

  const res = await fetch(`/api/documents/${encodeURIComponent(slug)}/content`, {
    credentials: 'include',
  });
  if (!res.ok) { showError(`Failed to load document (${res.status})`); return; }

  const buf = await res.arrayBuffer();
  el('pdf-loading').style.display = 'none';

  const pdf       = await pdfjsLib.getDocument({ data: buf }).promise;
  const container = el('pdf-container');

  for (let i = 1; i <= pdf.numPages; i++) {
    const page   = await pdf.getPage(i);
    const vp     = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.height = vp.height;
    canvas.width  = vp.width;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    container.appendChild(canvas);
  }
}

async function renderMarkdown(slug) {
  const res = await fetch(`/api/documents/${encodeURIComponent(slug)}/content`, {
    credentials: 'include',
  });
  if (!res.ok) { showError(`Failed to load document (${res.status})`); return; }

  const text = await res.text();
  const html = DOMPurify.sanitize(marked.parse(text));
  el('content').innerHTML = html;
}

async function renderPlain(slug) {
  const res = await fetch(`/api/documents/${encodeURIComponent(slug)}/content`, {
    credentials: 'include',
  });
  if (!res.ok) { showError(`Failed to load document (${res.status})`); return; }

  const text = await res.text();
  const pre  = document.createElement('pre');
  pre.textContent = text;
  el('content').appendChild(pre);
}

function renderImage(slug) {
  const img = document.createElement('img');
  img.src = `/api/documents/${encodeURIComponent(slug)}/content`;
  img.alt = slug;
  img.crossOrigin = 'use-credentials';
  el('img-container').appendChild(img);
}

async function init() {
  const slug = new URLSearchParams(location.search).get('slug');
  if (!slug) { showError('No document slug specified.'); return; }

  let doc;
  try {
    const res = await fetch(`/api/documents/${encodeURIComponent(slug)}`, {
      credentials: 'include',
    });
    if (res.status === 404) { showError('Document not found.'); return; }
    if (!res.ok)             { showError(`Error loading document (${res.status}).`); return; }
    doc = await res.json();
  } catch (err) {
    showError('Network error loading document.');
    return;
  }

  document.title = `Strategia — ${doc.title}`;
  el('doc-title').textContent = doc.title;
  setBadge('team', doc.source_team);
  setBadge('type', doc.content_type.replace(/_/g, ' '));
  setBadge('size', fmtSize(doc.byte_size));
  setBadge('date', fmtDate(doc.created_at));
  if (doc.tags && doc.tags.length) {
    setBadge('tags', doc.tags.join(', '));
  }

  const mime = doc.mime_type;

  if (mime === 'application/pdf') {
    await renderPDF(slug);
  } else if (mime === 'text/markdown') {
    await renderMarkdown(slug);
  } else if (mime === 'text/plain') {
    await renderPlain(slug);
  } else if (mime.startsWith('image/')) {
    renderImage(slug);
  } else {
    el('unsupported').style.display = '';
  }
}

init();
