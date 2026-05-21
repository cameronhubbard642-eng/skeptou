/* viewer.js — strategia document viewer logic */

(function () {
  'use strict';

  const slug = new URLSearchParams(location.search).get('slug');
  const status     = document.getElementById('status');
  const docTitle   = document.getElementById('doc-title');
  const docMeta    = document.getElementById('doc-meta');
  const mount      = document.getElementById('content-mount');
  const pdfControls = document.getElementById('pdf-controls');
  const pdfPrev    = document.getElementById('pdf-prev');
  const pdfNext    = document.getElementById('pdf-next');
  const pdfPageInfo = document.getElementById('pdf-page-info');

  if (!slug) {
    showError('No document slug provided. <a href="/">Return to list.</a>');
    return;
  }

  init();

  async function init() {
    let doc;
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(slug)}`);
      if (res.status === 404) { showError('Document not found.'); return; }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      doc = await res.json();
    } catch (err) {
      showError('Error loading document: ' + esc(err.message));
      return;
    }

    document.title = doc.title + ' — Strategia';
    docTitle.textContent = doc.title;

    document.getElementById('meta-team').textContent  = doc.source_team;
    document.getElementById('meta-type').textContent  = doc.content_type;
    document.getElementById('meta-actor').textContent = doc.source_actor;
    document.getElementById('meta-date').textContent  = doc.created_at ? doc.created_at.slice(0, 10) : '';
    document.getElementById('meta-size').textContent  = formatBytes(doc.byte_size);
    docMeta.hidden = false;

    status.hidden = true;

    const contentUrl = `/api/documents/${encodeURIComponent(slug)}/content`;
    const mime = doc.mime_type || '';

    if (mime === 'application/pdf') {
      await renderPdf(contentUrl);
    } else if (mime === 'text/markdown' || mime.startsWith('text/markdown')) {
      await renderMarkdown(contentUrl);
    } else if (mime === 'text/plain') {
      await renderPlainText(contentUrl);
    } else if (mime.startsWith('image/')) {
      renderImage(contentUrl, doc.title);
    } else {
      showError(`Cannot render mime type: ${esc(mime)}`);
    }
  }

  /* ── PDF ─────────────────────────────────────────────────────────────────── */
  async function renderPdf(url) {
    if (!window.pdfjsLib) { showError('PDF.js failed to load.'); return; }

    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

    let arrayBuffer;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      arrayBuffer = await res.arrayBuffer();
    } catch (err) {
      showError('Error fetching PDF: ' + esc(err.message));
      return;
    }

    let pdfDoc;
    try {
      pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    } catch (err) {
      showError('Error parsing PDF: ' + esc(err.message));
      return;
    }

    const numPages   = pdfDoc.numPages;
    let currentPage  = 1;

    const container = document.createElement('div');
    container.className = 'sk-pdf-container';
    mount.appendChild(container);

    pdfControls.hidden = numPages > 1 ? false : true;
    updatePdfNav();

    await renderPage(currentPage);

    pdfPrev.addEventListener('click', async () => {
      if (currentPage <= 1) return;
      currentPage--;
      updatePdfNav();
      container.innerHTML = '';
      await renderPage(currentPage);
      container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    pdfNext.addEventListener('click', async () => {
      if (currentPage >= numPages) return;
      currentPage++;
      updatePdfNav();
      container.innerHTML = '';
      await renderPage(currentPage);
      container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    function updatePdfNav() {
      pdfPageInfo.textContent = `Page ${currentPage} of ${numPages}`;
      pdfPrev.disabled = currentPage <= 1;
      pdfNext.disabled = currentPage >= numPages;
    }

    async function renderPage(pageNum) {
      const page     = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: getScale() });
      const canvas   = document.createElement('canvas');
      canvas.width   = viewport.width;
      canvas.height  = viewport.height;
      container.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }

    function getScale() {
      const maxWidth = Math.min(mount.clientWidth || 800, 1200);
      return maxWidth / 612; /* 612pt = standard US Letter width */
    }
  }

  /* ── Markdown ─────────────────────────────────────────────────────────────── */
  async function renderMarkdown(url) {
    let text;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      text = await res.text();
    } catch (err) {
      showError('Error fetching document: ' + esc(err.message));
      return;
    }

    const raw  = marked.parse(text);
    const safe = DOMPurify.sanitize(raw);

    const div = document.createElement('div');
    div.className   = 'sk-md-content';
    div.innerHTML   = safe;
    mount.appendChild(div);
  }

  /* ── Plain text ───────────────────────────────────────────────────────────── */
  async function renderPlainText(url) {
    let text;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      text = await res.text();
    } catch (err) {
      showError('Error fetching document: ' + esc(err.message));
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'sk-text-content';
    const pre = document.createElement('pre');
    pre.textContent = text;
    wrap.appendChild(pre);
    mount.appendChild(wrap);
  }

  /* ── Image ───────────────────────────────────────────────────────────────── */
  function renderImage(url, title) {
    const wrap = document.createElement('div');
    wrap.className = 'sk-img-content';
    const img = document.createElement('img');
    img.src = url;
    img.alt = title || '';
    wrap.appendChild(img);
    mount.appendChild(wrap);
  }

  /* ── Helpers ──────────────────────────────────────────────────────────────── */
  function showError(html) {
    status.innerHTML  = html;
    status.className  = 'sk-status sk-status--error';
    status.hidden     = false;
  }

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatBytes(n) {
    if (!n) return '';
    if (n < 1024)       return n + ' B';
    if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
})();
