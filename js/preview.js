// ── Preview ─────────────────────────────────────────────
const Preview = (() => {
  const frame         = document.getElementById('preview-frame');
  const devFrame      = document.getElementById('devtools-frame');
  const devHandle     = document.getElementById('devtools-resize-handle');
  const urlInput      = document.getElementById('preview-url');
  const urlScheme     = document.getElementById('preview-url-scheme');
  const liveBadge     = document.getElementById('live-badge');
  const btnDevtools   = document.getElementById('btn-devtools');

  let devtoolsOpen = false;
  let isExternal   = false;

  // ── Chii DevTools glue ──
  // We inject chobitsu into the preview iframe and open the Chii frontend
  // in devtools-frame. They talk via postMessage bridged through this parent.
  const CHII_DEVTOOLS = 'https://chii.liriliri.io/front_end/inspector.html?experiments=true&v8only=false&ws=localhost';

  function setupChiiBridge() {
    // Bridge messages between preview-frame (chobitsu) and devtools-frame (chii frontend)
    window.addEventListener('message', e => {
      if (!devtoolsOpen) return;
      if (e.source === frame.contentWindow) {
        // preview → devtools
        try { devFrame.contentWindow.postMessage(e.data, '*'); } catch {}
      } else if (e.source === devFrame.contentWindow) {
        // devtools → preview
        try { frame.contentWindow.postMessage(e.data, '*'); } catch {}
      }
    });
  }

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

    const flavor = (State.settings.devtoolsFlavor) || 'chii';

    if (flavor === 'eruda') {
      // Inject Eruda — self-contained floating devtools
      html = html.replace('</body>',
        `<script src="https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js"><\/script>` +
        `<script>eruda.init();if(!window.__erudaVisible)eruda.hide();<\/script>\n</body>`);
    } else {
      // Inject chobitsu for Chii — tiny CDP bridge, no UI in the page
      html = html.replace('</head>',
        `<script src="https://cdn.jsdelivr.net/npm/chobitsu"><\/script>` +
        `<script>
          // Bridge chobitsu ↔ parent window (Chii frontend)
          chobitsu.setOnMessage(msg => window.parent.postMessage({ type:'cdp', data: msg }, '*'));
          window.addEventListener('message', e => {
            if (e.data && e.data.type === 'cdp') chobitsu.sendMessage(e.data.data);
          });
        <\/script>\n</head>`);
    }

    return html;
  }

  // ── Open/close devtools panel ──
  function openDevtools() {
    const flavor = (State.settings.devtoolsFlavor) || 'chii';
    devtoolsOpen = true;
    btnDevtools.classList.add('active');

    if (flavor === 'eruda') {
      // Eruda lives inside the iframe — just show it
      devFrame.classList.add('hidden');
      devHandle.classList.add('hidden');
      try {
        const w = frame.contentWindow;
        if (w && w.eruda) { w.__erudaVisible = true; w.eruda.show(); }
      } catch {}
    } else {
      // Chii: show the devtools iframe panel
      devFrame.classList.remove('hidden');
      devHandle.classList.remove('hidden');
      // Point devtools frame at chii hosted frontend
      // Use a blob URL approach so it can communicate via parent postMessage
      if (!devFrame.src || devFrame.src === 'about:blank') {
        // Use chii's public hosted DevTools UI
        devFrame.src = 'https://chii.liriliri.io/front_end/inspector.html?experiments=true';
      }
    }
  }

  function closeDevtools() {
    const flavor = (State.settings.devtoolsFlavor) || 'chii';
    devtoolsOpen = false;
    btnDevtools.classList.remove('active');

    if (flavor === 'eruda') {
      try {
        const w = frame.contentWindow;
        if (w && w.eruda) { w.__erudaVisible = false; w.eruda.hide(); }
      } catch {}
    } else {
      devFrame.classList.add('hidden');
      devHandle.classList.add('hidden');
    }
  }

  btnDevtools.onclick = () => {
    if (isExternal) {
      // Flash warning
      btnDevtools.style.color = 'var(--warn)';
      btnDevtools.title = 'DevTools unavailable for external URLs (cross-origin)';
      setTimeout(() => { btnDevtools.style.color = ''; btnDevtools.title = 'Toggle DevTools (Ctrl+Shift+I)'; }, 1200);
      return;
    }
    devtoolsOpen ? closeDevtools() : openDevtools();
  };

  // Keyboard shortcut Ctrl+Shift+I
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'I') {
      e.preventDefault();
      if (State.activePanel === 'preview') btnDevtools.click();
    }
  });

  // ── Devtools panel resize ──
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
      const delta = startY - e.clientY; // drag up = bigger
      const newH = Math.max(80, Math.min(startH + delta, window.innerHeight * 0.8));
      devFrame.style.height = newH + 'px';
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
    btnDevtools.title = 'Toggle DevTools (Ctrl+Shift+I)';

    // Reset chii devtools frame so it reconnects to new page
    if (!devFrame.classList.contains('hidden') && ((State.settings.devtoolsFlavor || 'chii') === 'chii')) {
      devFrame.src = devFrame.src; // reload devtools ui
    }

    frame.removeAttribute('src');
    frame.srcdoc = build();

    frame.onload = () => {
      // re-apply eruda state
      if (devtoolsOpen && (State.settings.devtoolsFlavor || 'chii') === 'eruda') {
        try { const w = frame.contentWindow; if (w && w.eruda) { w.__erudaVisible = true; w.eruda.show(); } } catch {}
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
    btnDevtools.title = 'DevTools unavailable for external URLs (cross-origin)';

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

  // ── Init ──
  setupChiiBridge();

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
