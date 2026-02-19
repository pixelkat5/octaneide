// ── Editor ────────────────────────────────────────────────────
const Editor = (() => {
  const tabsEl = document.getElementById('editor-tabs');

  function init() {
    const MONACO_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs';
    require.config({ paths: { vs: MONACO_CDN } });
    window.MonacoEnvironment = {
      getWorkerUrl: function(_moduleId, _label) {
        return URL.createObjectURL(new Blob([`
          self.MonacoEnvironment = { baseUrl: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/' };
          importScripts('https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/base/worker/workerMain.js');
        `], { type: 'application/javascript' }));
      }
    };
    require(['vs/editor/editor.main'], () => {
      document.getElementById('editor-placeholder').style.display = 'none';

      State.editor = monaco.editor.create(document.getElementById('monaco-container'), {
        theme:           State.settings.theme,
        fontSize:        State.settings.fontSize,
        fontFamily:      "'JetBrains Mono', monospace",
        fontLigatures:   true,
        lineNumbers:     'on',
        minimap:         { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize:         4,
        padding:         { top: 8 },
        wordWrap:        State.settings.wordWrap ? 'on' : 'off',
        quickSuggestions:{ other: true, comments: false, strings: false },
      });

      // TypeScript strict defaults
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        strict: true,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      });

      State.editor.onDidChangeModelContent(() => {
        if (State.activeFile) {
          State.files[State.activeFile] = State.editor.getValue();
          updateRunInfo();
        }
        // live reload for web files
        if (['web','css','js','ts'].includes(detectLang(State.activeFile || '')) && State.settings.liveReload) {
          clearTimeout(State.liveReloadTimer);
          State.liveReloadTimer = setTimeout(() => Preview.refresh(), State.settings.reloadDelay);
        }
        Persist.save();
      });

      if (State.activeFile) _load(State.activeFile);
      renderTabs();
      document.dispatchEvent(new Event('editor-ready'));
    });
  }

  function open(path) {
    if (!path || State.files[path] === undefined) return;
    if (State.activeFile && State.editor) State.files[State.activeFile] = State.editor.getValue();
    State.activeFile = path;
    if (!State.openTabs.includes(path)) State.openTabs.push(path);
    _load(path);
    renderTabs();
    FileTree.render();
    updateRunInfo();
    // Auto-show preview for web files
    const lang = detectLang(path);
    if (lang === 'web' || lang === 'css' || lang === 'js') {
      showPanel('preview');
      Preview.refresh();
    }
    Persist.save();
  }

  function _load(path) {
    if (!State.editor) return;
    if (!State.editorModels[path]) {
      State.editorModels[path] = monaco.editor.createModel(State.files[path] || '', monacoLang(path));
    }
    State.editor.setModel(State.editorModels[path]);
  }

  function closeTab(path) {
    State.openTabs = State.openTabs.filter(t => t !== path);
    if (State.editorModels[path]) { State.editorModels[path].dispose(); delete State.editorModels[path]; }
    if (State.activeFile === path) {
      const next = State.openTabs[State.openTabs.length - 1];
      if (next) open(next);
      else { State.activeFile = null; State.editor && State.editor.setModel(null); renderTabs(); FileTree.render(); }
    } else renderTabs();
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const path of State.openTabs) {
      if (State.files[path] === undefined) continue;
      const name = FileTree.basename(path);
      const tab = document.createElement('div');
      tab.className = 'etab' + (path === State.activeFile ? ' active' : '');
      tab.innerHTML = `<span>${name}</span><span class="ex" data-close="${path}">✕</span>`;
      tab.addEventListener('click', e => { if (e.target.dataset.close) { closeTab(e.target.dataset.close); return; } open(path); });
      tabsEl.appendChild(tab);
    }
  }

  function flush() { if (State.activeFile && State.editor) State.files[State.activeFile] = State.editor.getValue(); }

  function applySettings() {
    if (!State.editor) return;
    State.editor.updateOptions({
      fontSize: State.settings.fontSize,
      wordWrap: State.settings.wordWrap ? 'on' : 'off',
    });
    monaco.editor.setTheme(State.settings.theme);
  }

  return { init, open, renderTabs, flush, applySettings };
})();

function updateRunInfo() {
  const el = document.getElementById('run-info');
  if (!State.activeFile) { el.textContent = ''; return; }
  const label = langLabel(State.activeFile);
  el.textContent = label ? label : '';
}

function showPanel(name) {
  document.querySelectorAll('.o-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  document.getElementById('panel-terminal').classList.toggle('hidden', name !== 'terminal');
  document.getElementById('panel-preview').classList.toggle('hidden', name !== 'preview');
  document.getElementById('panel-stdin').classList.toggle('hidden', name !== 'stdin');
  State.activePanel = name;
  if (name === 'terminal' && State.fitAddon) State.fitAddon.fit();
}
