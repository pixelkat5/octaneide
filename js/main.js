// ── Main ──────────────────────────────────────────────────────

// Default project if nothing saved
const DEFAULT = {
  'main.cpp': '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n',
  'utils.h':  '#pragma once\n#include <string>\n\ninline std::string greet(const std::string& name) {\n    return "Hello, " + name + "!";\n}\n',
};

async function boot() {
  // 1. Load persisted state
  const hadSaved = await Persist.load();
  if (!hadSaved) {
    State.files      = { ...DEFAULT };
    State.openTabs   = Object.keys(DEFAULT);
    State.activeFile = 'main.cpp';
  }

  // 2. Terminal
  Terminal.init();

  // 3. Monaco
  Editor.init();

  // 4. Settings panel
  Settings.init();

  // 5. File tree
  FileTree.render();

  // 6. Ping compile server
  Compiler.init();

  // 7a. Git panel
  Git.init();

  // 7. Output panel tab switching
  document.querySelectorAll('.o-tab').forEach(tab => {
    tab.addEventListener('click', () => showPanel(tab.dataset.panel));
  });

  // 8. After editor loads, open active file + auto-preview for web
  document.addEventListener('editor-ready', () => {
    updateRunInfo();
    const lang = detectLang(State.activeFile || '');
    if (lang === 'web' || lang === 'css' || lang === 'js') {
      showPanel('preview');
      Preview.refresh();
    }
  });

  // 9. Auto-load Python runtime in background (silent, so it's ready offline)
  _autoLoadPython();
}

async function _autoLoadPython() {
  if (window._pyodide) return; // already loaded
  try {
    if (!window.loadPyodide) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    window._pyodide = await window.loadPyodide({
      stdout: s => Terminal.write(s + '\r\n'),
      stderr: s => Terminal.write('\x1b[38;5;203m' + s + '\x1b[0m\r\n'),
    });
    setStatus('ok', 'ready');
  } catch(e) {
    // Silently fail — user can manually load from Settings if offline on first visit
  }
}

// ── Global bindings ──────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', () => Compiler.run());
document.getElementById('btn-clear').addEventListener('click', () => Terminal.clear());

document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key === 'Enter') { e.preventDefault(); Compiler.run(); }
  if ((e.ctrlKey||e.metaKey) && e.key === ',')     { e.preventDefault(); Settings.open(); }
  if (e.key === 'Escape') { Settings.close(); document.getElementById('modal-overlay').classList.add('hidden'); }
});

// ── Service Worker ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  const sw = `
const C='octaneide-v3';
const PRECACHE=['./','./index.html','./manifest.json','./css/main.css','./vendor/fonts/fonts.css','./vendor/fonts/jetbrains-mono-400.woff2','./vendor/fonts/jetbrains-mono-600.woff2','./vendor/fonts/outfit-700.woff2','./vendor/fonts/outfit-900.woff2','./vendor/xterm/xterm.css','./vendor/xterm/xterm.js','./vendor/xterm/xterm-addon-fit.js','./vendor/monaco/loader.js','./vendor/monaco/editor/editor.main.js','./vendor/monaco/editor/editor.main.css','./vendor/monaco/base/worker/workerMain.js','./js/state.js','./js/persist.js','./js/filetree.js','./js/editor.js','./js/terminal.js','./js/preview.js','./js/compiler.js','./js/settings.js','./js/git.js','./js/main.js'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(cache=>Promise.allSettled(PRECACHE.map(u=>cache.add(u)))));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>{if(r)return r;return fetch(e.request).then(resp=>{if(resp.ok&&(e.request.url.includes('cdnjs')||e.request.url.includes('jsdelivr')||e.request.url.includes('esm.sh')||e.request.url.includes('pyodide'))){const cl=resp.clone();caches.open(C).then(c=>c.put(e.request,cl));}return resp;}).catch(()=>new Response('Offline',{status:503}));})});});
`;
  const blob = new Blob([sw], { type:'application/javascript' });
  navigator.serviceWorker.register(URL.createObjectURL(blob)).catch(()=>{});
}

// ── Resize handle (output panel) ─────────────────────────────
(function() {
  const handle = document.getElementById('resize-handle');
  const outputCol = document.getElementById('output-col');
  let dragging = false, startX, startW;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = outputCol.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const newW = Math.max(180, Math.min(window.innerWidth * 0.8, startW + delta));
    outputCol.style.width = newW + 'px';
    if (State.fitAddon) State.fitAddon.fit();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (State.editor) State.editor.layout();
  });
})();

// ── Sidebar resize handle ─────────────────────────────────────
(function() {
  const handle   = document.getElementById('sidebar-resize-handle');
  const sidebar  = document.getElementById('sidebar');
  let dragging = false, startX, startW;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.max(120, Math.min(window.innerWidth * 0.5, startW + (e.clientX - startX)));
    sidebar.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (State.editor) State.editor.layout();
  });
})();

boot();
