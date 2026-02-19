// ── Preview ─────────────────────────────────────────────
const Preview = (() => {
  const frame       = document.getElementById('preview-frame');
  const devFrame    = document.getElementById('devtools-frame');
  const devHandle   = document.getElementById('devtools-resize-handle');
  const urlInput    = document.getElementById('preview-url');
  const urlScheme   = document.getElementById('preview-url-scheme');
  const liveBadge   = document.getElementById('live-badge');
  const btnDevtools = document.getElementById('btn-devtools');

  let devtoolsOpen = false;
  let isExternal   = false;

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

    // Inject devtools — always inject but hide until toggled
    const flavor = State.settings.devtoolsFlavor || 'eruda';
    const devSnippet = flavor === 'eruda'
      ? `<script src="https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js"><\/script><script>eruda.init();eruda.hide();<\/script>`
      : `<script src="https://cdn.jsdelivr.net/npm/vconsole/dist/vconsole.min.js"><\/script><script>var _vc=new VConsole();_vc.hide();<\/script>`;

    if (html.includes('</body>')) {
      html = html.replace('</body>', devSnippet + '\n</body>');
    } else {
      html += devSnippet;
    }

    return html;
  }

  // ── Toggle devtools inside the iframe ──
  function setDevtools(open) {
    devtoolsOpen = open;
    btnDevtools.classList.toggle('active', open);

    if (isExternal) {
      if (open) {
        btnDevtools.style.color = 'var(--warn)';
        setTimeout(() => { btnDevtools.style.color = ''; }, 1000);
      }
      return;
    }

    try {
      const w = frame.contentWindow;
      if (!w) return;
      const flavor = State.settings.devtoolsFlavor || 'eruda';
      if (flavor === 'eruda' && w.eruda) {
        open ? w.eruda.show() : w.eruda.hide();
      } else if (flavor === 'vconsole' && w._vc) {
        open ? w._vc.show() : w._vc.hide();
      }
    } catch (e) { /* cross-origin */ }
  }

  btnDevtools.onclick = () => setDevtools(!devtoolsOpen);

  // Ctrl+Shift+I
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'I') {
      e.preventDefault();
      if (State.activePanel === 'preview') setDevtools(!devtoolsOpen);
    }
  });

  // ── Devtools panel resize (for future use when chii works) ──
  (() => {
    let dragging = false, startY = 0, startH = 0;
    devHandle.addEventListener('mousedown', e => {
      dragging = true; startY = e.clientY;
      startH = devFrame.getBoundingClientRect().height;
      devHandle.classList.add('dragging');
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = startY - e.clientY;
      devFrame.style.height = Math.max(80, Math.min(startH + delta, window.innerHeight * 0.8)) + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      devHandle.classList.remove('dragging');
      document.body.style.userSelect = '';
    });
  })();

  // ── Refresh local preview ──
  function refresh() {
    isExternal = false;
    urlScheme.textContent = 'about:';
    urlInput.value = '';
    liveBadge.style.display = '';

    frame.removeAttribute('src');
    frame.srcdoc = build();

    // Re-apply devtools state after the new page loads
    frame.onload = () => {
      if (devtoolsOpen) {
        // Small delay to let eruda/vconsole init inside the iframe
        setTimeout(() => setDevtools(true), 100);
      }
      frame.onload = null;
    };
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

    frame.removeAttribute('srcdoc');
    frame.src = full;
  }

  // ── URL bar ──
  urlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const val = urlInput.value.trim();
      val ? navigateTo(val) : refresh();
      urlInput.blur();
    }
    if (e.key === 'Escape') { urlInput.blur(); if (isExternal) refresh(); }
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
