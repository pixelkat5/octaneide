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
    } catch(e) {
      Terminal.print('✗ Unexpected error: ' + e.message, 'stderr');
      if (State.settings.showDevErrors) console.error(e);
      setExit(1); setStatus('err', 'error');
    } finally {
      btn.disabled = false; btn.textContent = '▶ Run';
    }
  }

  // ── Load Wasmer SDK (lazy, once) ──
  // Uses the locally-vendored copy — no CDN or registry needed.
  const WASMER_URL = '/vendor/wasmer/WasmerSDKBundled.js';

  async function ensureWasmer() {
    if (_wasmerReady)  return true;
    if (_wasmerFailed) return false;

    Terminal.print('⟳ Loading Wasmer SDK…', 'info');
    setStatus('spin', 'loading Wasmer…');

    try {
      const mod = await import(WASMER_URL);
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

  // ── Load clang package from local vendor file ──
  // Requires vendor/wasmer/clang.webc — run download_deps.py to fetch it.
  async function ensureClang() {
    if (_clang) return _clang;
    Terminal.print('⟳ Loading clang from vendor…', 'info');
    setStatus('spin', 'loading clang…');

    try {
      const { Wasmer } = window._WasmerSDK;

      // clang.webc is too large for the git repo / Cloudflare Pages.
      // It is hosted as a GitHub Release asset and cached in the browser after first load.
      const CLANG_WEBC_URL = 'https://github.com/pixelkat5/octaneide/releases/download/clang-webc/clang.webc';
      const resp = await fetch(CLANG_WEBC_URL);
      if (!resp.ok) {
        throw new Error(
          'clang.webc not found (HTTP ' + resp.status + '). ' +
          'Run  python download_deps.py  to download it (~100 MB, one-time).'
        );
      }

      Terminal.print('  clang.webc found — loading (~100 MB, please wait)…', 'info');

      // Animate a progress indicator while the file is parsed
      const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      let fi = 0, elapsed = 0;
      const timer = setInterval(() => {
        elapsed++;
        const mins = String(Math.floor(elapsed / 60)).padStart(1,'0');
        const secs = String(elapsed % 60).padStart(2,'0');
        Terminal.write(`\r\x1b[38;5;69m  ${frames[fi++ % frames.length]} loading clang… ${mins}:${secs}\x1b[0m`);
      }, 1000);

      try {
        const blob = await resp.blob();
        const file = new File([blob], 'clang.webc');
        _clang = await Wasmer.fromFile(file);
      } finally {
        clearInterval(timer);
        Terminal.write('\r\x1b[2K');
      }
    } catch(e) {
      Terminal.print('✗ Failed to load clang: ' + e.message, 'stderr');
      throw e;
    }

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
    if (!entry) { Terminal.print('✗ No .cpp or .c file found.', 'stderr'); setExit(1); return; }

    const isCpp = entry.endsWith('.cpp') || entry.endsWith('.cc');
    setStatus('spin', 'compiling…');

    try {
      // Try local server first (fast, works offline)
      const serverOk = await runCppServer(entry, isCpp);
      if (serverOk) return;

      // Fall back to Wasmer in-browser compile
      Terminal.print('⟳ No local server — trying in-browser compile…', 'info');
      Terminal.print(`$ ${isCpp ? 'clang++' : 'clang'} ${entry} ${State.settings.std} ${State.settings.opt}`, 'cmd');
      const wasmerOk = await ensureWasmer();
      if (!wasmerOk) {
        Terminal.print('✗ Could not load Wasmer SDK. Check the browser console for details.', 'stderr');
        setExit(1); setStatus('err', 'error'); return;
      }
      await runCppWasmer(entry, isCpp);
    } catch(e) {
      Terminal.print('✗ C++ runner error: ' + e.message, 'stderr');
      if (State.settings.showDevErrors) console.error(e);
      setExit(1); setStatus('err', 'error');
    }
  }

  // ── Wasmer in-browser compile ──
  async function runCppWasmer(entry, isCpp) {
    try {
      const clang = await ensureClang();
      const { Directory, Wasmer } = window._WasmerSDK;

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
        '-o', '/project/a.out',
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
      Terminal.print('  compiling…', 'info');

      // Stream stderr live while clang runs, with a 5-minute timeout
      const compileInstance = await clang.entrypoint.run({ args, mount: { '/project': project } });

      // Pipe stderr live to terminal
      const dec = new TextDecoder();
      const stderrPipe = compileInstance.stderr.pipeTo(new WritableStream({
        write(chunk) {
          const text = dec.decode(chunk).replace(/\n/g, '\r\n');
          Terminal.write('\x1b[38;5;203m' + text + '\x1b[0m');
        }
      })).catch(() => {});

      // Wait with timeout
      const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      let compileOutput;
      try {
        compileOutput = await Promise.race([
          compileInstance.wait(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Compilation timed out after 5 minutes')), TIMEOUT_MS))
        ]);
      } catch (e) {
        Terminal.print('✗ ' + e.message, 'stderr');
        setExit(1); setStatus('ok', 'ready');
        return true;
      }

      // Also print any stdout from clang (warnings etc.)
      if (compileOutput.stdout && compileOutput.stdout.trim()) {
        Terminal.write('\x1b[38;5;203m' + compileOutput.stdout.trim().replace(/\n/g, '\r\n') + '\x1b[0m\r\n');
      }

      if (!compileOutput.ok) {
        Terminal.print(`✗ Compilation failed (exit ${compileOutput.code})`, 'stderr');
        setExit(compileOutput.code || 1); setStatus('ok', 'ready');
        return true;
      }

      Terminal.print('✓ Compiled — running…', 'success');
      setStatus('spin', 'running…');

      // Read the compiled WASM and run it via our own WASI shim
      // (clang/clang on Wasmer compiles to WASI-compatible output)
      let wasmBytes;
      try {
        wasmBytes = await project.readFile('a.out');
      } catch(e) {
        Terminal.print('✗ Could not read compiled output: ' + e.message, 'stderr');
        Terminal.print('  (compilation may have succeeded but output file not found)', 'warn');
        setExit(1); setStatus('ok', 'ready');
        return true;
      }

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
      console.error('Wasmer compile error:', e);
      return false; // not handled — try fallback
    }
  }

  // ── Local server (primary offline path) ──
  // Returns true if server handled the request (success or compile error),
  // false if the server isn't running at all.
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
      // Server not running — signal caller to try Wasmer
      return false;
    }
    Terminal.print('$ (server.py) ' + (isCpp ? 'clang++' : 'clang') + ' ' + entry, 'cmd');

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
    return true;
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

    // Redirect stdout/stderr to StringIO so we can flush them between input() calls.
    // input() is patched to: flush pending output → print prompt → read a line from
    // the terminal interactively (same mechanism C++ uses).
    py.runPython(`import sys, io, builtins
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()`);

    // Helper: flush Python's StringIO stdout to the terminal right now.
    const flushOut = () => {
      try {
        const out = py.runPython('sys.stdout.getvalue()');
        if (out) {
          py.runPython('sys.stdout.truncate(0); sys.stdout.seek(0)');
          Terminal.write(out.replace(/\n/g, '\r\n'));
        }
      } catch(_) {}
    };

    // Each call to _pyInputFn returns a Promise that resolves with the typed line.
    // Pyodide's runPythonAsync will await JS promises returned from Python via js.globalThis,
    // so this gives us true async terminal input without blocking the main thread.
    window._pyInputFn = (prompt) => new Promise(resolve => {
      flushOut();
      if (prompt) Terminal.write(String(prompt));
      Terminal.readLine(resolve);
    });

    // Pyodide's runPythonAsync can await JS Promises returned from async Python functions.
    // We define input() as an async def so that 'await input()' works in user code,
    // and plain 'input()' also works because runPythonAsync handles top-level awaits.
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

  // ── init ──
  async function init() {
    setStatus('ok', 'ready');
  }

  return { run, init };
})();
