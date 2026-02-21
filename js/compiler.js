// ── Compiler ──────────────────────────────────────────────────
const Compiler = (() => {

  const BROWSERCC_BASE = 'https://cdn.jsdelivr.net/npm/browsercc@0.1.1/dist';
  const WASI_SHIM_URL  = 'https://esm.sh/@bjorn3/browser_wasi_shim@0.4.2/es2022/browser_wasi_shim.mjs';

  function setStatus(s, msg) {
    document.getElementById('status-dot').className = 'dot ' + s;
    document.getElementById('status-text').textContent = msg;
  }

  function setExit(code) {
    const el = document.getElementById('exit-badge');
    if (code === null) { el.textContent = ''; el.className = ''; return; }
    el.textContent = 'exit ' + code;
    el.className = code === 0 ? 'ok' : 'err';
  }

  // ── Run dispatcher ────────────────────────────────────────
  async function run() {
    Editor.flush();
    if (!State.activeFile) return;

    const lang = detectLang(State.activeFile);
    const btn  = document.getElementById('btn-run');
    btn.disabled = true; btn.textContent = '⟳';
    Terminal.clear();
    setExit(null);

    try {
      if (lang === 'cpp' || lang === 'c') { showPanel('terminal'); await runCpp(); }
      else if (lang === 'web')            { showPanel('preview');  await runWeb(); }
      else if (lang === 'js')             { showPanel('terminal'); await runJS(); }
      else if (lang === 'ts')             { showPanel('terminal'); await runTS(); }
      else if (lang === 'python')         { showPanel('terminal'); await runPython(); }
      else if (lang === 'css')            { showPanel('preview');  await runWeb(); }
      else { Terminal.print('No runner for this file type.', 'warn'); }
    } catch(e) {
      Terminal.print('✗ Unexpected error: ' + e.message, 'stderr');
      if (State.settings.showDevErrors) console.error(e);
      setExit(1); setStatus('err', 'error');
    } finally {
      btn.disabled = false; btn.textContent = '▶ Run';
    }
  }

  // ── C / C++ ───────────────────────────────────────────────
  async function runCpp() {
    const entry =
      Object.keys(State.files).find(f => FileTree.basename(f) === 'main.cpp') ||
      Object.keys(State.files).find(f => FileTree.basename(f) === 'main.c')   ||
      Object.keys(State.files).find(f => f.endsWith('.cpp') || f.endsWith('.cc')) ||
      Object.keys(State.files).find(f => f.endsWith('.c'));

    if (!entry) {
      Terminal.print('✗ No .cpp or .c file found in project.', 'stderr');
      setExit(1); setStatus('err', 'error'); return;
    }

    const isCpp = entry.endsWith('.cpp') || entry.endsWith('.cc');
    setStatus('spin', 'compiling…');

    try {
      await runCppBrowsercc(entry, isCpp);
    } catch(e) {
      Terminal.print('✗ C++ runner error: ' + e.message, 'stderr');
      if (State.settings.showDevErrors) console.error(e);
      setExit(1); setStatus('err', 'error');
    }
  }

  // ── browsercc pipeline (Web Worker, fully in-browser) ─────
  function runCppBrowsercc(entry, isCpp) {
    return new Promise((resolve, reject) => {
      const files = {};
      for (const [name, src] of Object.entries(State.files)) {
        files[name] = src;
      }

      const std   = State.settings.std   || (isCpp ? '-std=c++17' : '-std=c11');
      const opt   = State.settings.opt   || '-O1';
      const flags = State.settings.flags || '';

      Terminal.print(
        `$ ${isCpp ? 'clang++' : 'clang'} ${entry} ${std} ${opt}${flags ? ' ' + flags : ''}`,
        'cmd'
      );
      setStatus('spin', 'compiling (browsercc)…');

      const workerSrc = `(${_browserccWorker.toString()})()`;
      const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
      const workerUrl  = URL.createObjectURL(workerBlob);
      const worker     = new Worker(workerUrl);

      let sharedBuf = null;
      if (typeof SharedArrayBuffer !== 'undefined') {
        sharedBuf = new SharedArrayBuffer(64 * 1024);
      }

      worker.onmessage = ({ data }) => {
        switch (data.type) {
          case 'status':
            setStatus('spin', data.text);
            break;
          case 'stdout':
            Terminal.write('\x1b[0m' + data.text.replace(/\n/g, '\r\n'));
            break;
          case 'stderr': {
            data.text.split('\n').forEach(line => {
              if (!line) return;
              if (/\berror\b/i.test(line))        Terminal.write('\x1b[38;5;203m' + line + '\x1b[0m\r\n');
              else if (/\bwarning\b/i.test(line)) Terminal.write('\x1b[38;5;220m' + line + '\x1b[0m\r\n');
              else                                Terminal.write('\x1b[38;5;244m' + line + '\x1b[0m\r\n');
            });
            break;
          }
          case 'waiting-stdin':
            if (sharedBuf) Terminal.startInteractiveInput(sharedBuf);
            break;
          case 'stdin-done':
            Terminal.stopInteractiveInput();
            break;
          case 'compile-ok':
            Terminal.print('✓ Compiled — running…', 'success');
            setStatus('spin', 'running…');
            break;
          case 'compile-error':
            Terminal.print(`✗ Compilation failed (exit ${data.exitCode}).`, 'stderr');
            setExit(data.exitCode || 1);
            setStatus('ok', 'ready');
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve();
            break;
          case 'done':
            Terminal.print(
              `─── exit ${data.exitCode} ───`,
              data.exitCode === 0 ? 'info' : 'warn'
            );
            setExit(data.exitCode);
            setStatus('ok', 'ready');
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve();
            break;
          case 'error':
            Terminal.print('✗ browsercc error: ' + data.message, 'stderr');
            if (data.stack && State.settings.showDevErrors) console.error(data.stack);
            setExit(1); setStatus('err', 'error');
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve();
            break;
        }
      };

      worker.onerror = (e) => {
        Terminal.print('✗ Worker error: ' + (e.message || String(e)), 'stderr');
        setExit(1); setStatus('err', 'error');
        URL.revokeObjectURL(workerUrl);
        reject(e);
      };

      worker.postMessage({
        files, entry, isCpp, std, opt, flags, sharedBuf,
        browserccBase: BROWSERCC_BASE,
        wasiShimUrl:   WASI_SHIM_URL,
      });
    });
  }

  // ── Web Worker source ─────────────────────────────────────
  function _browserccWorker() {
    let browserccBase, wasiShimUrl;

    function post(type, extra = {}) { self.postMessage({ type, ...extra }); }

    function parseTar(data) {
      const files = {};
      const dec = new TextDecoder();
      let offset = 0;
      while (offset + 512 <= data.length) {
        const header = data.slice(offset, offset + 512);
        if (header.every(b => b === 0)) { offset += 512; continue; }
        const name = dec.decode(header.slice(0, 100)).replace(/\0.*$/, '');
        if (!name) { offset += 512; continue; }
        const sizeStr = dec.decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
        const size    = parseInt(sizeStr, 8) || 0;
        const type    = String.fromCharCode(header[156]);
        const prefix  = dec.decode(header.slice(345, 500)).replace(/\0.*$/, '');
        const fullName = prefix ? prefix + '/' + name : name;
        offset += 512;
        if (type === '0' || type === '' || type === '\0') {
          files['/' + fullName.replace(/^\//, '')] = data.slice(offset, offset + size);
        }
        offset += Math.ceil(size / 512) * 512;
      }
      return files;
    }

    async function runTool(moduleFactory, args, inputFiles, outputPath) {
      return new Promise((resolve) => {
        let stderr = '', exitCode = 0;
        const Module = moduleFactory({
          noInitialRun: true,
          print:    () => {},
          printErr: (text) => { stderr += text + '\n'; },
          quit: (code) => { exitCode = code; },
          preRun: [(m) => {
            for (const [path, data] of Object.entries(inputFiles)) {
              const parts = path.split('/').filter(Boolean);
              let cur = '';
              for (let i = 0; i < parts.length - 1; i++) {
                cur += '/' + parts[i];
                try { m.FS.mkdir(cur); } catch(_) {}
              }
              m.FS.writeFile(path, data);
            }
          }],
        });
        Module.then(m => {
          try { m.callMain(args); } catch(e) {
            if (typeof e === 'number') exitCode = e;
            else if (e && e.status !== undefined) exitCode = e.status;
            else exitCode = 1;
          }
          let output = null;
          if (outputPath) { try { output = m.FS.readFile(outputPath); } catch(_) {} }
          resolve({ exitCode, stderr: stderr.trim(), output });
        }).catch(e => resolve({ exitCode: 1, stderr: e.message, output: null }));
      });
    }

    self.onmessage = async ({ data }) => {
      const { files, entry, isCpp, std, opt, flags, sharedBuf } = data;
      browserccBase = data.browserccBase;
      wasiShimUrl   = data.wasiShimUrl;

      try {
        post('status', { text: 'loading clang…' });
        const [clangMod, lldMod] = await Promise.all([
          import(`${browserccBase}/clang.js`).then(m => m.default || m),
          import(`${browserccBase}/lld.js`).then(m => m.default || m),
        ]);

        post('status', { text: 'loading sysroot…' });
        const resp = await fetch(`${browserccBase}/sysroot.tar`);
        if (!resp.ok) throw new Error('Failed to fetch sysroot.tar: HTTP ' + resp.status);
        const sysroot = parseTar(new Uint8Array(await resp.arrayBuffer()));

        post('status', { text: 'compiling…' });
        const clangFS = {};
        for (const [p, d] of Object.entries(sysroot)) clangFS[p] = d;
        const enc = new TextEncoder();
        for (const [name, src] of Object.entries(files)) {
          clangFS['/src/' + name] = enc.encode(src);
        }
        try {
          const pchResp = await fetch(`${browserccBase}/stdc++.h.pch`);
          if (pchResp.ok) clangFS['/usr/include/c++/v1/stdc++.h.pch'] = new Uint8Array(await pchResp.arrayBuffer());
        } catch(_) {}

        const clangArgs = [
          isCpp ? 'clang++' : 'clang',
          `/src/${entry}`, '-o', '/out/output.o', '-c',
          std, opt,
          '-isysroot', '/', '-I/usr/include', '-I/usr/include/c++/v1', '-I/src',
          '--target=wasm32-wasi', '-fno-exceptions',
        ];
        if (flags) clangArgs.push(...flags.split(/\s+/).filter(Boolean));
        clangFS['/out/.keep'] = new Uint8Array(0);

        const compile = await runTool(clangMod, clangArgs, clangFS, '/out/output.o');
        if (compile.stderr) post('stderr', { text: compile.stderr });
        if (compile.exitCode !== 0 || !compile.output) {
          post('compile-error', { exitCode: compile.exitCode || 1 }); return;
        }
        post('compile-ok');

        post('status', { text: 'linking…' });
        const lldFS = {};
        for (const [p, d] of Object.entries(sysroot)) lldFS[p] = d;
        lldFS['/out/output.o'] = compile.output;
        const lldArgs = [
          'wasm-ld', '/out/output.o', '-o', '/out/a.wasm',
          '--no-entry', '--export-dynamic', '--allow-undefined',
          '-L/usr/lib/wasm32-wasi',
          isCpp ? '-lc++ -lc++abi -lc' : '-lc',
          '-lwasi-emulated-mman',
        ];
        const link = await runTool(lldMod, lldArgs, lldFS, '/out/a.wasm');
        if (link.stderr) post('stderr', { text: link.stderr });
        if (link.exitCode !== 0 || !link.output) {
          post('compile-error', { exitCode: link.exitCode || 1 }); return;
        }

        post('status', { text: 'running…' });
        const { WASI, File, OpenFile, ConsoleStdout } = await import(wasiShimUrl);

        let stdinFile;
        if (sharedBuf) {
          const ctrl = new Int32Array(sharedBuf, 0, 2);
          const dataBuf = new Uint8Array(sharedBuf, 8);
          let pending = false;
          stdinFile = new File([], {
            read(len) {
              if (!pending) {
                pending = true;
                Atomics.store(ctrl, 0, 1);
                post('waiting-stdin', { sharedBuf });
                Atomics.wait(ctrl, 0, 1);
                pending = false;
              }
              const n = Atomics.load(ctrl, 1);
              const chunk = dataBuf.slice(0, n);
              Atomics.store(ctrl, 0, 0);
              Atomics.notify(ctrl, 0);
              post('stdin-done');
              return chunk;
            }
          });
        } else {
          stdinFile = new File([]);
        }

        const fds = [
          new OpenFile(stdinFile),
          ConsoleStdout.lineBuffered(line => post('stdout', { text: line + '\n' })),
          ConsoleStdout.lineBuffered(line => post('stderr', { text: line })),
        ];
        const wasi = new WASI(['program'], [], fds, { debug: false });

        let exitCode = 0;
        try {
          const wasmBuf = link.output.buffer || link.output;
          const wasmModule = await WebAssembly.compile(wasmBuf instanceof ArrayBuffer ? wasmBuf : link.output.buffer);
          const instance = await WebAssembly.instantiate(wasmModule, {
            wasi_snapshot_preview1: wasi.wasiImport,
          });
          exitCode = wasi.start(instance) ?? 0;
        } catch(e) {
          if (e && e.message && e.message.includes('exit')) {
            const m = e.message.match(/(\d+)/);
            exitCode = m ? parseInt(m[1]) : 0;
          } else {
            post('stderr', { text: 'Runtime error: ' + (e?.message || String(e)) });
            exitCode = 1;
          }
        }
        post('done', { exitCode });

      } catch(e) {
        post('error', { message: e.message || String(e), stack: e.stack });
      }
    };
  }

  // ── Web preview ───────────────────────────────────────────
  async function runWeb() { Preview.refresh(); Terminal.print('⚡ Preview refreshed.', 'success'); }

  // ── JavaScript ────────────────────────────────────────────
  async function runJS() {
    Terminal.print('$ node ' + State.activeFile, 'cmd');
    Terminal.print('─────────────────────────────', 'info');
    const fakeConsole = {
      log:  (...a) => Terminal.write('\x1b[0m'        + a.map(String).join(' ') + '\r\n'),
      error:(...a) => Terminal.write('\x1b[38;5;203m' + a.map(String).join(' ') + '\x1b[0m\r\n'),
      warn: (...a) => Terminal.write('\x1b[38;5;220m' + a.map(String).join(' ') + '\x1b[0m\r\n'),
      info: (...a) => Terminal.write('\x1b[38;5;69m'  + a.map(String).join(' ') + '\x1b[0m\r\n'),
    };
    try { new Function('console', State.files[State.activeFile])(fakeConsole); setExit(0); }
    catch(e) { Terminal.write('\x1b[38;5;203m' + e.toString() + '\x1b[0m\r\n'); setExit(1); }
    setStatus('ok', 'ready');
  }

  // ── TypeScript ────────────────────────────────────────────
  async function runTS() {
    Terminal.print('$ tsc ' + State.activeFile, 'cmd');
    setStatus('spin', 'transpiling…');
    try {
      const model = State.editorModels[State.activeFile] ||
        monaco.editor.createModel(State.files[State.activeFile], 'typescript');
      const worker = await monaco.languages.typescript.getTypeScriptWorker();
      const client = await worker(model.uri);
      const out    = await client.getEmitOutput(model.uri.toString());
      if (!out.outputFiles?.length) { Terminal.print('No TS output.', 'stderr'); setStatus('ok','ready'); return; }
      Terminal.print('✓ Transpiled', 'success');
      Terminal.print('─────────────────────────────', 'info');
      const fakeConsole = {
        log:  (...a) => Terminal.write('\x1b[0m'        + a.map(String).join(' ') + '\r\n'),
        error:(...a) => Terminal.write('\x1b[38;5;203m' + a.map(String).join(' ') + '\x1b[0m\r\n'),
        warn: (...a) => Terminal.write('\x1b[38;5;220m' + a.map(String).join(' ') + '\x1b[0m\r\n'),
      };
      try { new Function('console', out.outputFiles[0].text)(fakeConsole); setExit(0); }
      catch(e) { Terminal.write('\x1b[38;5;203m' + e.toString() + '\x1b[0m\r\n'); setExit(1); }
    } catch(e) { Terminal.print('TS error: ' + e.message, 'stderr'); }
    setStatus('ok','ready');
  }

  // ── Python (Pyodide) ──────────────────────────────────────
  async function runPython() {
    if (!window._pyodide) {
      Terminal.print('⚠  Python runtime not loaded.', 'warn');
      Terminal.print('   Open ⚙ Settings → Runtimes → load Python.', 'info');
      return;
    }
    Terminal.print('$ python ' + State.activeFile, 'cmd');
    Terminal.print('─────────────────────────────', 'info');
    setStatus('spin', 'running…');
    const py = window._pyodide;
    py.runPython(`import sys, io\nsys.stdout = io.StringIO()\nsys.stderr = io.StringIO()`);
    const flushOut = () => {
      try {
        const out = py.runPython('sys.stdout.getvalue()');
        if (out) { py.runPython('sys.stdout.truncate(0); sys.stdout.seek(0)'); Terminal.write(out.replace(/\n/g, '\r\n')); }
      } catch(_) {}
    };
    window._pyInputFn = (prompt) => new Promise(resolve => {
      flushOut();
      if (prompt) Terminal.write(String(prompt));
      Terminal.readLine(resolve);
    });
    py.runPython(`import js, builtins
async def _js_input(prompt=''):
    result = await js.globalThis._pyInputFn(str(prompt) if prompt else '')
    return str(result).rstrip('\\n')
builtins.input = _js_input`);
    try {
      await py.runPythonAsync(State.files[State.activeFile]);
      flushOut();
      const err = py.runPython('sys.stderr.getvalue()');
      if (err) Terminal.write('\x1b[38;5;203m' + err.replace(/\n/g, '\r\n') + '\x1b[0m');
      setExit(0);
    } catch(e) {
      flushOut();
      Terminal.write('\x1b[38;5;203m' + e.message + '\x1b[0m\r\n');
      setExit(1);
    }
    setStatus('ok', 'Python ready');
  }

  function init() { setStatus('ok', 'ready'); }

  return { run, init };
})();
