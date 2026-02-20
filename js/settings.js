// ── Settings ──────────────────────────────────────────────────
const Settings = (() => {
  const overlay = document.getElementById('settings-overlay');

  function open()  { overlay.classList.remove('hidden'); renderLibs(); renderPyPackages(); renderRuntimes(); }
  function close() { overlay.classList.add('hidden'); }

  let _activeCategory = 'editor';

  function _activateCategory(cat) {
    _activeCategory = cat;
    document.querySelectorAll('.snav-item').forEach(el => el.classList.toggle('active', el.dataset.cat === cat));
    document.querySelectorAll('#settings-body .sg[data-cat]').forEach(el => {
      el.style.display = el.dataset.cat === cat ? '' : 'none';
    });
    // clear search when switching category manually
    const s = document.getElementById('settings-search');
    if (s) s.value = '';
    _applySearch('');
  }

  function _applySearch(q) {
    q = q.toLowerCase().trim();
    if (!q) {
      // restore normal category view
      document.querySelectorAll('#settings-body .sg[data-cat]').forEach(el => {
        el.style.display = el.dataset.cat === _activeCategory ? '' : 'none';
      });
      document.querySelectorAll('.snav-item').forEach(el => el.classList.remove('hidden-cat'));
      return;
    }
    // Search mode: show all matching rows across all categories
    const catsWithMatches = new Set();
    document.querySelectorAll('#settings-body .sg[data-cat]').forEach(sg => {
      let sgHasMatch = false;
      sg.querySelectorAll('.sr[data-label]').forEach(sr => {
        const lbl = sr.dataset.label || '';
        const text = sr.innerText || '';
        const match = lbl.includes(q) || text.toLowerCase().includes(q);
        sr.style.display = match ? '' : 'none';
        if (match) { sgHasMatch = true; catsWithMatches.add(sg.dataset.cat); }
      });
      sg.style.display = sgHasMatch ? '' : 'none';
    });
    // Update nav: dim categories with no matches
    document.querySelectorAll('.snav-item').forEach(el => {
      el.classList.toggle('hidden-cat', !catsWithMatches.has(el.dataset.cat));
    });
  }

  function init() {
    // apply saved values
    document.getElementById('s-fontsize').value = State.settings.fontSize;
    document.getElementById('s-fontsize-val').textContent = State.settings.fontSize + 'px';
    document.getElementById('s-theme').value = State.settings.theme;
    document.getElementById('s-cpp-backend').value = State.settings.cppBackend || 'browsercc';
    document.getElementById('s-std').value = State.settings.std;
    document.getElementById('s-opt').value = State.settings.opt;
    document.getElementById('s-flags').value = State.settings.flags;
    document.getElementById('s-livereload').checked = State.settings.liveReload;
    document.getElementById('s-delay').value = State.settings.reloadDelay;
    document.getElementById('s-delay-val').textContent = State.settings.reloadDelay + 'ms';
    document.getElementById('s-interactive-stdin').checked = State.settings.interactiveStdin;
    document.getElementById('s-wordwrap').checked = State.settings.wordWrap;
    document.getElementById('s-deverrors').checked = State.settings.showDevErrors;

    document.getElementById('s-fontsize').oninput = e => {
      State.settings.fontSize = parseInt(e.target.value);
      document.getElementById('s-fontsize-val').textContent = e.target.value + 'px';
      Editor.applySettings(); Persist.saveSettings();
    };
    document.getElementById('s-theme').onchange      = e => { State.settings.theme      = e.target.value; Editor.applySettings(); Persist.saveSettings(); };
    document.getElementById('s-cpp-backend').onchange = e => { State.settings.cppBackend = e.target.value; Persist.saveSettings(); };
    document.getElementById('s-std').onchange    = e => { State.settings.std   = e.target.value; Persist.saveSettings(); };
    document.getElementById('s-opt').onchange    = e => { State.settings.opt   = e.target.value; Persist.saveSettings(); };
    document.getElementById('s-flags').oninput   = e => { State.settings.flags = e.target.value; Persist.saveSettings(); };
    document.getElementById('s-livereload').onchange = e => { State.settings.liveReload = e.target.checked; Persist.saveSettings(); };
    document.getElementById('s-delay').oninput = e => {
      State.settings.reloadDelay = parseInt(e.target.value);
      document.getElementById('s-delay-val').textContent = e.target.value + 'ms';
      Persist.saveSettings();
    };
    document.getElementById('s-interactive-stdin').onchange = e => { State.settings.interactiveStdin = e.target.checked; Persist.saveSettings(); };
    document.getElementById('s-wordwrap').onchange = e => { State.settings.wordWrap = e.target.checked; Editor.applySettings(); Persist.saveSettings(); };
    document.getElementById('s-deverrors').onchange = e => { State.settings.showDevErrors = e.target.checked; Persist.saveSettings(); };

    // Sidebar nav
    document.querySelectorAll('.snav-item').forEach(el => {
      el.addEventListener('click', () => _activateCategory(el.dataset.cat));
    });

    // Search
    document.getElementById('settings-search').addEventListener('input', e => _applySearch(e.target.value));

    // Init to first category
    _activateCategory('editor');

    document.getElementById('btn-settings').onclick = open;
    document.getElementById('btn-close-settings').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  }

  function renderLibs() {
    const el = document.getElementById('lib-list');
    el.innerHTML = '';
    for (const lib of LIBRARIES) {
      const done = State.settings.downloadedLibs.includes(lib.id);
      const row  = document.createElement('div'); row.className = 'lib-row';
      row.innerHTML = `
        <div class="lib-info"><div class="lib-name">${lib.name}</div><div class="lib-desc">${lib.desc}</div></div>
        <span class="lib-size">${lib.size}</span>
        <button class="lib-btn ${done?'done':''}" data-id="${lib.id}">${done ? '✓ cached' : '↓ download'}</button>`;
      row.querySelector('.lib-btn').onclick = () => downloadLib(lib.id, row);
      el.appendChild(row);
    }
  }

  function renderPyPackages() {
    const el = document.getElementById('pypackage-list');
    if (!el) return;
    el.innerHTML = '';

    // Custom package install row
    const custom = document.createElement('div');
    custom.className = 'lib-row py-custom-row';
    custom.innerHTML = `
      <input class="py-custom-input" type="text" placeholder="package name (e.g. flask)" spellcheck="false" autocomplete="off"/>
      <button class="lib-btn py-custom-btn">↓ install</button>`;
    const input = custom.querySelector('.py-custom-input');
    const btn   = custom.querySelector('.py-custom-btn');
    const doInstall = async () => {
      const name = input.value.trim();
      if (!name) return;
      if (!window._pyodide) { Terminal.print('⚠  Load the Python runtime first (Runtimes section).', 'warn'); return; }
      btn.textContent = '⟳ installing…'; btn.className = 'lib-btn loading'; btn.disabled = true;
      try {
        await window._pyodide.loadPackagesFromImports('import micropip');
        await window._pyodide.runPythonAsync(`import micropip\nawait micropip.install('${name.replace(/'/g, '')}')`);
        btn.textContent = '✓ installed'; btn.className = 'lib-btn done';
        Terminal.print(`✓ ${name} installed.`, 'success');
        setTimeout(() => { btn.textContent = '↓ install'; btn.className = 'lib-btn'; btn.disabled = false; input.value = ''; }, 2000);
      } catch(e) {
        btn.textContent = '✗ failed'; btn.className = 'lib-btn';
        Terminal.print(`✗ Failed to install ${name}: ${e.message}`, 'stderr');
        setTimeout(() => { btn.textContent = '↓ install'; btn.className = 'lib-btn'; btn.disabled = false; }, 2000);
      }
    };
    btn.onclick = doInstall;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') doInstall(); });
    el.appendChild(custom);

    for (const pkg of PYTHON_PACKAGES) {
      const done = State.settings.installedPyPackages && State.settings.installedPyPackages.includes(pkg.id);
      const row  = document.createElement('div'); row.className = 'lib-row';
      row.innerHTML = `
        <div class="lib-info"><div class="lib-name">${pkg.name}</div><div class="lib-desc">${pkg.desc}</div></div>
        <span class="lib-size">${pkg.size}</span>
        <button class="lib-btn ${done?'done':''}" data-id="${pkg.id}">${done ? '✓ installed' : '↓ install'}</button>`;
      row.querySelector('.lib-btn').onclick = () => installPyPackage(pkg, row);
      el.appendChild(row);
    }
  }

  async function installPyPackage(pkg, row) {
    if (!window._pyodide) {
      Terminal.print('⚠  Load the Python runtime first (Runtimes section below).', 'warn');
      return;
    }
    const btn = row.querySelector('.lib-btn');
    btn.textContent = '⟳ installing…'; btn.className = 'lib-btn loading';
    try {
      await window._pyodide.loadPackagesFromImports('import micropip');
      await window._pyodide.runPythonAsync(`import micropip\nawait micropip.install('${pkg.pkg}')`);
      btn.textContent = '✓ installed'; btn.className = 'lib-btn done';
      Terminal.print(`✓ ${pkg.name} installed.`, 'success');
      if (!State.settings.installedPyPackages) State.settings.installedPyPackages = [];
      if (!State.settings.installedPyPackages.includes(pkg.id)) {
        State.settings.installedPyPackages.push(pkg.id);
        Persist.saveSettings();
      }
    } catch(e) {
      btn.textContent = '✗ failed'; btn.className = 'lib-btn';
      Terminal.print(`✗ Failed to install ${pkg.name}: ${e.message}`, 'stderr');
    }
  }

  async function downloadLib(id, row) {
    const lib = LIBRARIES.find(l => l.id === id);
    if (!lib) return;
    const btn = row.querySelector('.lib-btn');
    btn.textContent = '⟳ downloading…'; btn.className = 'lib-btn loading';
    try {
      const r = await fetch(lib.url);
      if (!r.ok) throw new Error(r.statusText);
      await Persist.saveLib(id, await r.text());
      btn.textContent = '✓ cached'; btn.className = 'lib-btn done';
      Terminal.print(`✓ ${lib.name} cached for offline use.`, 'success');
    } catch(e) {
      btn.textContent = '✗ failed'; btn.className = 'lib-btn';
      Terminal.print(`✗ Failed: ${e.message}`, 'stderr');
    }
  }

  function renderRuntimes() {
    const el = document.getElementById('runtime-list');
    el.innerHTML = '';
    for (const rt of RUNTIMES) {
      const done = rt.id === 'python' ? !!window._pyodide : State.settings.downloadedRuntimes.includes(rt.id);
      const row  = document.createElement('div'); row.className = 'lib-row';
      row.innerHTML = `
        <div class="lib-info"><div class="lib-name">${rt.name}</div><div class="lib-desc">${rt.desc}</div></div>
        <span class="lib-size">${rt.size}</span>
        <button class="lib-btn ${done?'done':''}" data-id="${rt.id}">${done ? '✓ loaded' : '↓ download'}</button>`;
      row.querySelector('.lib-btn').onclick = () => loadRuntime(rt.id, row);
      el.appendChild(row);
    }
  }

  async function loadRuntime(id, row) {
    if (id !== 'python') { Terminal.print('Runtime not yet supported.', 'warn'); return; }
    const btn = row.querySelector('.lib-btn');
    btn.textContent = '⟳ loading…'; btn.className = 'lib-btn loading';
    try {
      if (!window.loadPyodide) {
        await new Promise((res,rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
          s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
      }
      window._pyodide = await window.loadPyodide({
        stdout: s => Terminal.write(s+'\r\n'),
        stderr: s => Terminal.write('\x1b[38;5;203m'+s+'\x1b[0m\r\n'),
      });
      btn.textContent = '✓ loaded'; btn.className = 'lib-btn done';
      Terminal.print('✓ Python (Pyodide) ready.', 'success');
      if (!State.settings.downloadedRuntimes.includes(id)) { State.settings.downloadedRuntimes.push(id); Persist.saveSettings(); }
    } catch(e) {
      btn.textContent = '✗ failed'; btn.className = 'lib-btn';
      Terminal.print('✗ Pyodide failed: '+e.message, 'stderr');
    }
  }

  return { init, open, close };
})();
