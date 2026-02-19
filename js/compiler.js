// ── Compiler ──────────────────────────────────────────────────
const Compiler = (() => {

  // Wasmer SDK state — loaded lazily on first C/C++ compile
  let _wasmerReady  = false;
  let _wasmerFailed = false;
  let _clang        = null;

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
    } finally {
      btn.disabled = false; btn.textContent = '▶ Run';
    }
  }

  // ── Load Wasmer SDK (lazy, once) ──
  async function ensureWasmer() {
    if (_wasmerReady)  return true;
    if (_wasmerFailed) return false;

    Terminal.print('⟳ Loading Wasmer SDK (first run only)…', 'info');
    setStatus('spin', 'loading Wasmer…');

    try {
      const mod = await import('https://unpkg.com/@wasmer/sdk@latest/dist/index.mjs');
      await mod.init();
      window._WasmerSDK = mod;
      _wasmerReady = true;
      Terminal.print('✓ Wasmer SDK ready.', 'success');
      return true;
    } catch (e) {
      _wasmerFailed = true;
      Terminal.print('✗ Failed to load Wasmer SDK: ' + e.message, 'stderr');
      return false;
    }
  }

  // ── Load clang package (lazy, cached by browser) ──
  async function ensureClang() {
    if (_clang) return _clang;
    Terminal.print('⟳ Fetching clang from Wasmer registry…', 'info');
    Terminal.print('  (first run downloads ~100 MB — cached afterwards)', 'info');
    setStatus('spin', 'downloading clang…');
    const { Wasmer } = window._WasmerSDK;
    _clang = await Wasmer.fromRegistry('clang/clang');
    Terminal.print('✓ clang ready.', 'success');
    return _clang;
  }

  // ── C / C++ ──
  async function runCpp() {
    const entry =
      Object.keys(State.files).find(f => FileTree.basename(f) === 'main.cpp') ||
      Object.keys(State.files).find(f => FileTree.basename(f) === 'main.c')   ||
      Object.keys(State.files).find(f => f.endsWith('.cpp') || f.endsWith('.cc')) ||
      Object.keys(State.files).find(f => f.endsWith('.c'));
    if (!entry) { Terminal.print('✗ No .cpp or .c file found.', 'stderr'); return; }

    const isCpp = entry.endsWith('.cpp') || entry.endsWith('.cc');
    Terminal.print(`$ ${isCpp ? 'clang++' : 'clang'} ${entry} ${State.settings.std} ${State.settings.opt}`, 'cmd');
    setStatus('spin', 'compiling…');

    const wasmerOk = await ensureWasmer();
    if (wasmerOk) {
      const handled = await runCppWasmer(entry, isCpp);
      if (handled) return;
    }

    // Fallback to local server
    Terminal.print('⚠ Falling back to local compile server…', 'warn');
    await runCppServer(entry, isCpp);
  }

  // ── Wasmer in-browser compile ──
  async function runCppWasmer(entry, isCpp) {
    try {
      const clang = await ensureClang();
      const { Directory } = window._WasmerSDK;

      const project = new Directory();
      const filesToSend = { ...State.files };
      for (const id of State.settings.downloadedLibs) {
        const lib = LIBRARIES.find(l => l.id === id);
        if (lib) { const data = await Persist.loadLib(id); if (data) filesToSend[lib.path] = data; }
      }
      for (const [name, content] of Object.entries(filesToSend)) {
        await project.writeFile(name, content);
      }

      const args = [
        `/project/${entry}`,
        '-o', '/project/output.wasm',
        State.settings.std,
        State.settings.opt,
        '-I/project',
      ];
      if (isCpp) {
        const userFlags = (State.settings.flags || '').split(/\s+/).filter(Boolean);
        if (!userFlags.includes('-fexceptions')) args.push('-fno-exceptions', '-fno-rtti');
        args.push('-lc++', '-lc++abi');
      }
      if (State.settings.flags) args.push(...State.settings.flags.split(/\s+/).filter(Boolean));

      setStatus('spin', 'compiling (Wasmer)…');
      const instance = await clang.entrypoint.run({ args, mount: { '/project': project } });
      const output = await instance.wait();

      const combined = [output.stdout, output.stderr].filter(Boolean).map(s => s.trim()).join('\n');
      if (combined) Terminal.write('\x1b[38;5;203m' + combined.replace(/\n/g, '\r\n') + '\x1b[0m\r\n');

      if (!output.ok) {
        Terminal.print(`✗ Compilation failed (exit ${output.code})`, 'stderr');
        setExit(output.code || 1); setStatus('ok', 'ready');
        return true; // handled — was a compile error, not an SDK error
      }

      Terminal.print('✓ Compiled — running…', 'success');
      setStatus('spin', 'running…');

      const wasmBytes = await project.readFile('output.wasm');
      const interactive = State.settings.interactiveStdin;
      let exitCode;
      if (interactive && typeof SharedArrayBuffer !== 'undefined') {
        exitCode = await runWasmInteractive(wasmBytes);
      } else {
        if (interactive) Terminal.print('⚠ Interactive stdin unavailable — using pre-collect mode.', 'warn');
        const stdin = await Terminal.promptStdin();
        exitCode = await runWasmInline(wasmBytes, stdin);
      }
      setExit(exitCode); setStatus('ok', 'ready');
      return true;

    } catch (e) {
      Terminal.print('✗ Wasmer error: ' + e.message, 'stderr');
      return false; // not handled — try fallback
    }
  }

  // ── Local server fallback ──
  async function runCppServer(entry, isCpp) {
    const filesToSend = { ...State.files };
    for (const id of State.settings.downloadedLibs) {
      const lib = LIBRARIES.find(l => l.id === id);
      if (lib) { const data = await Persist.loadLib(id); if (data) filesToSend[lib.path] = data; }
    }

    let result;
    try {
      const r = await fetch('/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesToSend, entry, std: State.settings.std, opt: State.settings.opt, flags: State.settings.flags }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      result = await r.json();
    } catch (e) {
      Terminal.print('✗ No compile server found either.', 'stderr');
      Terminal.print('  On Cloudflare/GitHub Pages, Wasmer handles compilation.', 'info');
      Terminal.print('  Locally, run: python server.py', 'info');
      setStatus('err', 'offline'); setExit(1); return;
    }

    if (result.stderr) Terminal.write('\x1b[38;5;203m' + result.stderr.replace(/\n/g, '\r\n') + '\x1b[0m\r\n');
    if (!result.success) {
      Terminal.print('✗ Compilation failed (exit ' + result.exit_code + ')', 'stderr');
      setExit(result.exit_code || 1); setStatus('ok', 'ready'); return;
    }

    Terminal.print('✓ Compiled — running…', 'success');
    setStatus('spin', 'running…');

    const wasmBytes = Uint8Array.from(atob(result.wasm), c => c.charCodeAt(0));
    const interactive = State.settings.interactiveStdin;
    let exitCode;
    if (interactive && typeof SharedArrayBuffer !== 'undefined') {
      exitCode = await runWasmInteractive(wasmBytes);
    } else {
      if (interactive) Terminal.print('⚠ Interactive stdin unavailable — using pre-collect mode.', 'warn');
      const stdin = await Terminal.promptStdin();
      exitCode = await runWasmInline(wasmBytes, stdin);
    }
    setExit(exitCode); setStatus('ok', 'ready');
  }

  // ── Interactive WASM via Web Worker + SharedArrayBuffer ──
  function runWasmInteractive(wasmBytes) {
    return new Promise(resolve => {
      const sharedBuf = new SharedArrayBuffer(1024 * 1024);
      const workerSrc = `(${workerFn.toString()})()`;
      const blob = new Blob([workerSrc], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));

      worker.onmessage = ({ data }) => {
        if (data.type === 'write') {
          const text = data.text.replace(/\n/g, '\r\n');
          if (data.fd === 2) Terminal.write('\x1b[38;5;203m' + text + '\x1b[0m');
          else               Terminal.write(text);
        } else if (data.type === 'waiting-stdin') {
          Terminal.startInteractiveInput(sharedBuf);
        } else if (data.type === 'done') {
          Terminal.stopInteractiveInput();
          worker.terminate();
          resolve(data.exitCode);
        }
      };

      worker.onerror = e => {
        Terminal.print('Worker error: ' + e.message, 'stderr');
        Terminal.stopInteractiveInput();
        worker.terminate();
        resolve(1);
      };

      worker.postMessage({ wasmBytes, interactive: true, sharedBuf }, [wasmBytes.buffer]);
    });
  }

  // ── Inline WASM (non-interactive fallback) ──
  async function runWasmInline(bytes, stdin = '') {
    let exitCode = 0, memory;
    const dec = new TextDecoder(), enc = new TextEncoder();
    const stdinB = enc.encode(stdin + (stdin.endsWith('\n') ? '' : '\n'));
    let stdinPos = 0;

    const wasi = { wasi_snapshot_preview1: {
      fd_write(fd, iovs, iovs_len, nw) {
        const v = new DataView(memory.buffer); let s = '', tot = 0;
        for (let i = 0; i < iovs_len; i++) { const b = v.getUint32(iovs+i*8,true), l = v.getUint32(iovs+i*8+4,true); s += dec.decode(new Uint8Array(memory.buffer,b,l)); tot += l; }
        v.setUint32(nw, tot, true);
        Terminal.write((fd===2?'\x1b[38;5;203m':'\x1b[0m') + s.replace(/\n/g,'\r\n') + '\x1b[0m');
        return 0;
      },
      fd_read(fd, iovs, iovs_len, nr) {
        const v = new DataView(memory.buffer); let tot = 0;
        for (let i = 0; i < iovs_len; i++) { const b = v.getUint32(iovs+i*8,true), l = v.getUint32(iovs+i*8+4,true); const chunk = stdinB.slice(stdinPos, stdinPos+l); new Uint8Array(memory.buffer).set(chunk,b); stdinPos += chunk.length; tot += chunk.length; }
        new DataView(memory.buffer).setUint32(nr, tot, true); return 0;
      },
      fd_close:()=>0, fd_seek:()=>70,
      fd_fdstat_get:(fd,p)=>{new DataView(memory.buffer).setUint8(p,fd<3?2:4);return 0;},
      fd_prestat_get:()=>8, fd_prestat_dir_name:()=>28, path_open:()=>8,
      environ_get:()=>0, environ_sizes_get:(c,b)=>{const v=new DataView(memory.buffer);v.setUint32(c,0,true);v.setUint32(b,0,true);return 0;},
      args_get:()=>0, args_sizes_get:(c,b)=>{const v=new DataView(memory.buffer);v.setUint32(c,0,true);v.setUint32(b,0,true);return 0;},
      proc_exit:(c)=>{exitCode=c;throw{__exit:true,c};},
      clock_time_get:(id,p,ptr)=>{new DataView(memory.buffer).setBigUint64(ptr,BigInt(Date.now())*1000000n,true);return 0;},
      clock_res_get:(id,ptr)=>{new DataView(memory.buffer).setBigUint64(ptr,1000000n,true);return 0;},
      sched_yield:()=>0,
      random_get:(p,l)=>{crypto.getRandomValues(new Uint8Array(memory.buffer,p,l));return 0;},
    }};

    try {
      const { instance } = await WebAssembly.instantiate(bytes, wasi);
      memory = instance.exports.memory;
      if (instance.exports._initialize) instance.exports._initialize();
      instance.exports._start();
    } catch(e) { if (!e?.__exit) { Terminal.write('\x1b[38;5;203mRuntime trap: '+(e?.message||e)+'\x1b[0m\r\n'); exitCode = 1; } }
    return exitCode;
  }

  // ── Worker source (inlined) ──
  function workerFn() {
    self.onmessage = async ({ data }) => {
      const { wasmBytes, sharedBuf } = data;
      const ctrl    = new Int32Array(sharedBuf, 0, 2);
      const dataBuf = new Uint8Array(sharedBuf, 8);
      const dec = new TextDecoder();
      let exitCode = 0, memory;

      const wasi = { wasi_snapshot_preview1: {
        fd_write(fd, iovs, iovs_len, nw) {
          const v = new DataView(memory.buffer); let out = '', tot = 0;
          for (let i = 0; i < iovs_len; i++) { const ptr = v.getUint32(iovs+i*8,true), len = v.getUint32(iovs+i*8+4,true); out += dec.decode(new Uint8Array(memory.buffer,ptr,len)); tot += len; }
          v.setUint32(nw, tot, true);
          self.postMessage({ type:'write', fd, text: out }); return 0;
        },
        fd_read(fd, iovs, iovs_len, nr) {
          if (fd !== 0) { new DataView(memory.buffer).setUint32(nr,0,true); return 0; }
          Atomics.store(ctrl, 0, 1);
          self.postMessage({ type:'waiting-stdin' });
          Atomics.wait(ctrl, 0, 1);
          const len = Atomics.load(ctrl, 1);
          const lineBytes = dataBuf.slice(0, len);
          Atomics.store(ctrl, 0, 0);
          const v = new DataView(memory.buffer), mem8 = new Uint8Array(memory.buffer);
          let written = 0;
          for (let i = 0; i < iovs_len && written < lineBytes.length; i++) {
            const ptr = v.getUint32(iovs+i*8,true), cap = v.getUint32(iovs+i*8+4,true);
            const chunk = lineBytes.slice(written, written+cap);
            mem8.set(chunk, ptr); written += chunk.length;
          }
          v.setUint32(nr, written, true); return 0;
        },
        fd_close:()=>0, fd_seek:()=>70,
        fd_fdstat_get:(fd,p)=>{new DataView(memory.buffer).setUint8(p,fd<3?2:4);return 0;},
        fd_prestat_get:()=>8, fd_prestat_dir_name:()=>28, path_open:()=>8,
        environ_get:()=>0,
        environ_sizes_get:(c,b)=>{const v=new DataView(memory.buffer);v.setUint32(c,0,true);v.setUint32(b,0,true);return 0;},
        args_get:()=>0,
        args_sizes_get:(c,b)=>{const v=new DataView(memory.buffer);v.setUint32(c,0,true);v.setUint32(b,0,true);return 0;},
        proc_exit:(c)=>{exitCode=c;throw{__exit:true,c};},
        clock_time_get:(id,p,ptr)=>{new DataView(memory.buffer).setBigUint64(ptr,BigInt(Date.now())*1000000n,true);return 0;},
        clock_res_get:(id,ptr)=>{new DataView(memory.buffer).setBigUint64(ptr,1000000n,true);return 0;},
        sched_yield:()=>0,
        random_get:(p,l)=>{crypto.getRandomValues(new Uint8Array(memory.buffer,p,l));return 0;},
      }};

      try {
        const { instance } = await WebAssembly.instantiate(wasmBytes, wasi);
        memory = instance.exports.memory;
        if (instance.exports._initialize) instance.exports._initialize();
        instance.exports._start();
      } catch(e) {
        if (!e?.__exit) { self.postMessage({ type:'write', fd:2, text:'Runtime trap: '+(e?.message||e)+'\n' }); exitCode=1; }
      }
      self.postMessage({ type:'done', exitCode });
    };
  }

  // ── Web ──
  async function runWeb() { Preview.refresh(); Terminal.print('⚡ Preview refreshed.', 'success'); }

  // ── JavaScript ──
  async function runJS() {
    Terminal.print('$ node ' + State.activeFile, 'cmd');
    Terminal.print('─────────────────────────────', 'info');
    const fakeConsole = {
      log:  (...a)=>Terminal.write('\x1b[0m'   +a.map(String).join(' ')+'\r\n'),
      error:(...a)=>Terminal.write('\x1b[38;5;203m'+a.map(String).join(' ')+'\x1b[0m\r\n'),
      warn: (...a)=>Terminal.write('\x1b[38;5;220m'+a.map(String).join(' ')+'\x1b[0m\r\n'),
      info: (...a)=>Terminal.write('\x1b[38;5;69m' +a.map(String).join(' ')+'\x1b[0m\r\n'),
    };
    try { new Function('console', State.files[State.activeFile])(fakeConsole); setExit(0); }
    catch(e) { Terminal.write('\x1b[38;5;203m'+e.toString()+'\x1b[0m\r\n'); setExit(1); }
  }

  // ── TypeScript ──
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
        log:  (...a)=>Terminal.write('\x1b[0m'   +a.map(String).join(' ')+'\r\n'),
        error:(...a)=>Terminal.write('\x1b[38;5;203m'+a.map(String).join(' ')+'\x1b[0m\r\n'),
        warn: (...a)=>Terminal.write('\x1b[38;5;220m'+a.map(String).join(' ')+'\x1b[0m\r\n'),
      };
      try { new Function('console', out.outputFiles[0].text)(fakeConsole); setExit(0); }
      catch(e) { Terminal.write('\x1b[38;5;203m'+e.toString()+'\x1b[0m\r\n'); setExit(1); }
    } catch(e) { Terminal.print('TS error: '+e.message, 'stderr'); }
    setStatus('ok','ready');
  }

  // ── Python ──
  async function runPython() {
    if (!window._pyodide) {
      Terminal.print('⚠  Python runtime not loaded.', 'warn');
      Terminal.print('   Open ⚙ Settings → Runtimes → download Python.', 'info');
      return;
    }
    Terminal.print('$ python ' + State.activeFile, 'cmd');
    Terminal.print('─────────────────────────────', 'info');
    setStatus('spin', 'running…');
    const py = window._pyodide;
    py.runPython(`import sys,io\nsys.stdout=io.StringIO()\nsys.stderr=io.StringIO()`);
    try {
      await py.runPythonAsync(State.files[State.activeFile]);
      const out = py.runPython('sys.stdout.getvalue()');
      const err = py.runPython('sys.stderr.getvalue()');
      if (out) Terminal.write(out.replace(/\n/g,'\r\n'));
      if (err) Terminal.write('\x1b[38;5;203m'+err.replace(/\n/g,'\r\n')+'\x1b[0m');
      setExit(0);
    } catch(e) { Terminal.write('\x1b[38;5;203m'+e.message+'\x1b[0m\r\n'); setExit(1); }
    setStatus('ok','Python ready');
  }

  // ── init ──
  async function init() {
    setStatus('ok', 'ready');
  }

  return { run, init };
})();
