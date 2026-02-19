// ── Preview ─────────────────────────────────────────────
const Preview = (() => {
  const frame       = document.getElementById('preview-frame');
  const urlInput    = document.getElementById('preview-url');
  const urlScheme   = document.getElementById('preview-url-scheme');
  const liveBadge   = document.getElementById('live-badge');
  const btnDevtools = document.getElementById('btn-devtools');

  let devtoolsOn = false;
  let isExternal = false;

  // ── Build local preview HTML ──
  function build() {
    const htmlFile = Object.keys(State.files).find(f =>
      FileTree.basename(f) === 'index.html' || f === 'index.html' || f.endsWith('.html')
    );
    if (!htmlFile) return `<html><body style="background:#0c0c0f;color:#666680;font-family:monospace;padding:30px;font-size:13px"><p>No .html file found.</p></body></html>`;

    let html = State.files[htmlFile];

    // inline CSS
    html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*\/?>/gi, (_, href) => {
      const f = Object.keys(State.files).find(p => FileTree.basename(p) === href.replace(/^\.\//, '') || p === href.replace(/^\.\//, ''));
      return f ? `<style>${State.files[f]}</style>` : _;
    });

    // inline JS/TS
    html = html.replace(/<script([^>]*)src=["']([^"']+)["'][^>]*><\/script>/gi, (_, attrs, src) => {
      const name = src.replace(/^\.\//, '');
      const f = Object.keys(State.files).find(p => FileTree.basename(p) === name || p === name);
      if (!f) return _;
      let code = State.files[f];
      if (f.endsWith('.ts')) code = stripTypes(code);
      return `<script${attrs.replace(/src=["'][^"']*["']/, '')}>${code}<\/script>`;
    });

    // inject eruda devtools — hidden by default, shown via parent toggle
    html = html.replace('</body>',
      `<script src="https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js"><\/script>` +
      `<script>eruda.init();if(!window.__erudaVisible)eruda.hide();<\/script>\n</body>`);

    return html;
  }

  // ── Toggle Eruda inside the iframe ──
  function applyDevtools() {
    btnDevtools.classList.toggle('active', devtoolsOn);
    if (isExternal) return; // can't reach cross-origin iframes
    try {
      const w = frame.contentWindow;
      if (!w || !w.eruda) return;
      devtoolsOn ? w.eruda.show() : w.eruda.hide();
      w.__erudaVisible = devtoolsOn;
    } catch (e) { /* cross-origin guard */ }
  }

  btnDevtools.onclick = () => {
    devtoolsOn = !devtoolsOn;
    if (isExternal) {
      btnDevtools.classList.toggle('active', devtoolsOn);
      // Flash warning — can't inject into cross-origin pages
      btnDevtools.style.color = 'var(--warn)';
      btnDevtools.title = 'DevTools unavailable for external URLs (cross-origin restriction)';
      setTimeout(() => { btnDevtools.style.color = ''; }, 800);
      return;
    }
    applyDevtools();
  };

  // ── Refresh local preview ──
  function refresh() {
    isExternal = false;
    urlScheme.textContent = 'about:';
    urlInput.value = '';
    liveBadge.style.display = '';
    btnDevtools.title = 'Toggle DevTools';
    frame.removeAttribute('src');
    frame.srcdoc = build();
    frame.onload = () => { applyDevtools(); frame.onload = null; };
  }

  // ── Navigate to external URL ──
  function navigateTo(url) {
    if (!url) { refresh(); return; }
    let full = url.trim();
    if (!/^https?:\/\//i.test(full)) full = 'https://' + full;
    try { new URL(full); } catch { return; }

    isExternal = true;
    liveBadge.style.display = 'none';
    const u = new URL(full);
    urlScheme.textContent = u.protocol + '//';
    urlInput.value = u.host + u.pathname + u.search + u.hash;
    btnDevtools.title = 'DevTools unavailable for external URLs (cross-origin restriction)';

    frame.removeAttribute('srcdoc');
    frame.src = full;
  }

  // ── URL bar interactions ──
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = urlInput.value.trim();
      if (!val) { refresh(); }
      else { navigateTo(val); }
      urlInput.blur();
    }
    if (e.key === 'Escape') { urlInput.blur(); refresh(); }
  });

  urlInput.addEventListener('focus', () => {
    if (isExternal && frame.src && frame.src !== 'about:blank') {
      urlInput.value = frame.src;
      urlScheme.textContent = '';
    }
  });

  urlInput.addEventListener('blur', () => {
    if (isExternal && frame.src && frame.src !== 'about:blank') {
      try {
        const u = new URL(frame.src);
        urlScheme.textContent = u.protocol + '//';
        urlInput.value = u.host + u.pathname + u.search + u.hash;
      } catch {}
    }
  });

  document.getElementById('btn-refresh').onclick = () => {
    if (isExternal) {
      const src = frame.src;
      frame.src = 'about:blank';
      setTimeout(() => { frame.src = src; }, 50);
    } else {
      refresh();
    }
  };

  // Basic TS type stripping
  function stripTypes(code) {
    return code
      .replace(/import\s+type\s+.*?;\n?/g, '')
      .replace(/\binterface\s+\w+[\s\S]*?\n\}/g, '')
      .replace(/\btype\s+\w+\s*=\s*[^;]+;/g, '')
      .replace(/<[A-Z][A-Za-z0-9,\s\[\]|&?]*>/g, '')
      .replace(/(\w+)\s*:\s*[A-Za-z\[\]<>|&?]+(\s*[,)=])/g, '$1$2')
      .replace(/\)\s*:\s*[A-Za-z\[\]<>|&?]+\s*\{/g, ') {')
      .replace(/\b(readonly|public|private|protected)\s+/g, '');
  }

  return { refresh, navigateTo };
})();
