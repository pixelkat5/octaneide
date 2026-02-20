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

  // ─────────────────────────────────────────────────────────────
  // Godbolt (Compiler Explorer) — remote compile & execute API
  // ─────────────────────────────────────────────────────────────
  // Compiler IDs in priority order. We probe them once and cache the winner.
  const GODBOLT_CPP_COMPILERS = ['clang1900', 'clang1800', 'clang1700', 'clang1601', 'g132', 'g122', 'g112'];
  const GODBOLT_C_COMPILERS   = ['clang1900', 'clang1800', 'clang1700', 'clang1601', 'g132', 'g122'];

  // Cache the working compiler id so we don't probe on every run
  let _godboltCppCompiler = null;
  let _godboltCCompiler   = null;

  async function _probeGodboltCompiler(candidates) {
    // Probe with a trivial program to find first working compiler
    const probe = { source: 'int main(){}', options: { userArguments: '', executeParameters: { stdin: '', args: '' }, compilerOptions: { executorRequest: true }, filters: { execute: true }, tools: [] }, lang: 'c++', allowStoreCodeDebug: false };
    for (const id of candidates) {
      try {
        const r = await fetch(`https://godbolt.org/api/compiler/${id}/compile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ ...probe, compiler: id }),
          signal: AbortSignal.timeout(8000),
        });
        if (r.status !== 404 && r.ok) return id;
      } catch(_) {}
    }
    return null;
  }

  async function tryGodboltCompile(source, compilerId, isCpp, extraFlags, userStdin) {
    const body = {
      source,
      compiler: compilerId,
      options: {
        userArguments: [State.settings.std, State.settings.opt, ...extraFlags].join(' ').trim(),
        executeParameters: { stdin: userStdin || '', args: '' },
        compilerOptions: { executorRequest: true },
        filters: { execute: true },
        tools: [],
      },
      lang: isCpp ? 'c++' : 'c',
      allowStoreCodeDebug: false,
    };
    const resp = await fetch(
      `https://godbolt.org/api/compiler/${compilerId}/compile`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      }
    );
    return resp;
  }

  async function runCppGodbolt(entry, isCpp) {
    const source = State.files[entry];
    if (!source) { Terminal.print('✗ Source file not found: ' + entry, 'stderr'); setExit(1); return; }

    // Check multi-file: Godbolt only handles single files, warn if more
    const cppFiles = Object.keys(State.files).filter(f => f.endsWith('.cpp') || f.endsWith('.c') || f.endsWith('.h') || f.endsWith('.hpp'));
    if (cppFiles.length > 1) {
      Terminal.print('⚠ Godbolt only compiles single files. Using: ' + entry, 'warn');
      Terminal.print('  For multi-file projects, use the local server backend (server.py).', 'info');
    }

    // ── stdin: collect before compiling (Godbolt needs it upfront) ──
    let stdin = '';
    const needsInput = /\b(cin\s*>>|scanf\s*\(|getline\s*\(|gets\s*\(|fgets\s*\(|read\s*\(|getchar\s*\()/i.test(source);
    if (needsInput) {
      Terminal.print('⚠ This program reads stdin. Enter input below, then Ctrl+D when done.', 'warn');
      stdin = await Terminal.promptStdin();
    }

    setStatus('spin', 'compiling (Godbolt)…');
    Terminal.print(`$ (godbolt.org) ${isCpp ? 'clang++' : 'clang'} ${entry} ${State.settings.std} ${State.settings.opt}`, 'cmd');

    // Extra flags: strip -std and -O since we pass them separately
    const extraFlags = (State.settings.flags || '')
      .split(/\s+/).filter(f => f && !f.startsWith('-std') && !f.startsWith('-O'));

    // Find/cache working compiler
    const candidates = isCpp ? GODBOLT_CPP_COMPILERS : GODBOLT_C_COMPILERS;
    if (isCpp && !_godboltCppCompiler) {
      Terminal.print('  detecting available compiler…', 'info');
      _godboltCppCompiler = await _probeGodboltCompiler(candidates);
    }
    if (!isCpp && !_godboltCCompiler) {
      Terminal.print('  detecting available compiler…', 'info');
      _godboltCCompiler = await _probeGodboltCompiler(candidates);
    }
    const compilerId = isCpp ? _godboltCppCompiler : _godboltCCompiler;

    if (!compilerId) {
      Terminal.print('✗ Could not find a working Godbolt compiler. Check your internet connection.', 'stderr');
      Terminal.print('  Try switching to the local server backend in Settings → C/C++ → Compiler backend.', 'info');
      setExit(1); setStatus('err', 'error'); return;
    }

    try {
      setStatus('spin', `compiling (${compilerId})…`);
      const resp = await tryGodboltCompile(source, compilerId, isCpp, extraFlags, stdin);

      if (!resp.ok) {
        // Invalidate cached compiler on 404 (retired)
        if (resp.status === 404) {
          if (isCpp) _godboltCppCompiler = null;
          else       _godboltCCompiler   = null;
        }
        throw new Error('Godbolt API HTTP ' + resp.status);
      }

      const data = await resp.json();

      if (State.settings.showDevErrors) console.log('[Godbolt response]', JSON.stringify(data).slice(0, 2000));

      // ── Extract compile diagnostics ──
      // Godbolt executor mode puts diagnostics in buildResult.stderr
      // Non-executor mode puts them in data.stderr
      const buildStderr   = (data.buildResult?.stderr || []).map(l => l.text || '').join('\n').trim();
      const compileStderr = (data.stderr || []).map(l => l.text || '').join('\n').trim();
      const compileErrors = buildStderr || compileStderr;

      function printDiagnostics(text) {
        text.split('\n').forEach(line => {
          if (!line) return;
          const isError = /\berror\b/i.test(line);
          const isWarn  = /\bwarning\b/i.test(line);
          if (isError)     Terminal.write('\x1b[38;5;203m' + line + '\x1b[0m\r\n');
          else if (isWarn) Terminal.write('\x1b[38;5;220m' + line + '\x1b[0m\r\n');
          else             Terminal.write('\x1b[38;5;244m' + line + '\x1b[0m\r\n');
        });
      }

      // ── Determine build success ──
      // buildResult.exitCode is most reliable; fall back to data.code
      const buildCode = data.buildResult?.exitCode ?? data.code ?? 0;

      // In executor mode the response has an execResult block.
      // In some Godbolt versions it's at data.execResult, in others at data.buildResult.execResult
      const execResult = data.execResult ?? data.buildResult?.execResult ?? null;

      if (buildCode !== 0) {
        // Compile error
        if (compileErrors) printDiagnostics(compileErrors);
        else Terminal.print('✗ Compilation failed (exit ' + buildCode + ').', 'stderr');
        setExit(buildCode); setStatus('ok', 'ready'); return;
      }

      // Build succeeded — print any warnings
      if (compileErrors) printDiagnostics(compileErrors);

      if (!execResult) {
        // Compiled OK but Godbolt didn't execute (shouldn't happen with executorRequest:true,
        // but handle gracefully — show asm or just confirm compile success)
        Terminal.print('✓ Compiled successfully (no execution result returned by Godbolt).', 'success');
        Terminal.print('  If you expected output, check Settings → C/C++ → Compiler backend.', 'info');
        setExit(0); setStatus('ok', 'ready'); return;
      }

      const execExitCode = execResult.exitCode ?? 0;
      const stdout       = (execResult.stdout || []).map(l => l.text ?? '').join('\n');
      const execStderr   = (execResult.stderr || []).map(l => l.text ?? '').join('\n').trim();

      Terminal.print(compileErrors ? '⚠ Compiled with warnings — output:' : '✓ Compiled — output:', compileErrors ? 'warn' : 'success');

      if (stdout) {
        Terminal.write('\x1b[0m' + stdout.replace(/\n/g, '\r\n'));
        if (!stdout.endsWith('\n')) Terminal.write('\r\n');
      }
      if (execStderr) {
        Terminal.write('\x1b[38;5;203m' + execStderr.replace(/\n/g, '\r\n') + '\x1b[0m\r\n');
      }
      if (!stdout && !execStderr) {
        Terminal.print('(no output)', 'info');
      }

      Terminal.print(
        `─── exit ${execExitCode} · ran on godbolt.org${needsInput ? ' · stdin pre-collected' : ''} ───`,
        execExitCode === 0 ? 'info' : 'warn'
      );
      setExit(execExitCode); setStatus('ok', 'ready');

    } catch (e) {
      Terminal.print('✗ Godbolt error: ' + e.message, 'stderr');
      if (e.name === 'TimeoutError') {
        Terminal.print('  Request timed out. Godbolt may be slow or down.', 'info');
      }
      Terminal.print('  Tip: run  python server.py  locally for offline compilation.', 'info');
      setExit(1); setStatus('err', 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Wasmer in-browser compile (clang.webc)
  // ─────────────────────────────────────────────────────────────
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

  async function ensureClang() {
    if (_clang) return _clang;
    Terminal.print('⟳ Loading clang from vendor…', 'info');
    setStatus('spin', 'loading clang…');
    try {
      const { Wasmer } = window._WasmerSDK;
      const resp = await fetch('/clang-webc');
      if (!resp.ok) {
        throw new Error(
          'clang.webc not found (HTTP ' + resp.status + '). ' +
          'Run  python download_deps.py  to download it (~100 MB, one-time).'
        );
      }
      Terminal.print('  clang.webc found — loading (~100 MB, please wait)…', 'info');
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

  // ─────────────────────────────────────────────────────────────
  // C / C++ entry point — tries: server → Godbolt → Wasmer
  // ─────────────────────────────────────────────────────────────
  async function runCpp() {
    const entry =
      Object.keys(State.files).find(f => FileTree.basename(f) === 'main.cpp') ||
      Object.keys(State.files).find(f => FileTree.basename(f) === 'main.c')   ||
      Object.keys(State.files).find(f => f.endsWith('.cpp') || f.endsWith('.cc')) ||
      Object.keys(State.files).find(f => f.endsWith('.c'));
    if (!entry) { Terminal.print('✗ No .cpp or .c file found.', 'stderr'); setExit(1); return; }

    const isCpp = entry.endsWith('.cpp') || entry.endsWith('.cc');
    const backend = State.settings.cppBackend || 'browsercc';
    setStatus('spin', 'compiling…');

    try {
      if (backend === 'server') {
        const ok = await runCppServer(entry, isCpp);
        if (!ok) {
          Terminal.print('✗ Local server not running.', 'stderr');
          Terminal.print('  Start it with:  python server.py', 'info');
          Terminal.print('  Or switch to another backend in ⚙ Settings → C/C++.', 'info');
          setExit(1); setStatus('err', 'error');
        }
        return;
      }

      if (backend === 'wasmer') {
        const serverOk = await runCppServer(entry, isCpp);
        if (serverOk) return;
        Terminal.print('⟳ No local server — using Wasmer in-browser compile…', 'info');
        Terminal.print(`$ ${isCpp ? 'clang++' : 'clang'} ${entry} ${State.settings.std} ${State.settings.opt}`, 'cmd');
        if (!await ensureWasmer()) {
          Terminal.print('✗ Could not load Wasmer SDK.', 'stderr');
          setExit(1); setStatus('err', 'error'); return;
        }
        await runCppWasmer(entry, isCpp);
        return;
      }

      // Default (browsercc): server → Godbolt → Wasmer fallback
      const serverOk = await runCppServer(entry, isCpp);
      if (serverOk) return;

      Terminal.print('⟳ No local server — compiling via Godbolt…', 'info');
      await runCppGodbolt(entry, isCpp);

    } catch(e) {
      Terminal.print('✗ C++ runner error: ' + e.message, 'stderr');
      if (State.settings.showDevErrors) console.error(e);
      setExit(1); setStatus('err', 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Wasmer in-browser compile path
  // ─────────────────────────────────────────────────────────────
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

      const compileInstance = await clang.entrypoint.run({ args, mount: { '/project': project } });
      const dec = new TextDecoder();
      const stderrPipe = compileInstance.stderr.pipeTo(new WritableStream({
        write(chunk) {
          const text = dec.decode(chunk).replace(/\n/g, '\r\n');
          Terminal.write('\x1b[38;5;203m' + text + '\x1b[0m');
        }
      })).catch(() => {});

      const TIMEOUT_MS = 5 * 60 * 1000;
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

      let wasmBytes;
      try {
        wasmBytes = await project.readFile('a.out');
      } catch(e) {
        Terminal.print('✗ Could not read compiled output: ' + e.message, 'stderr');
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
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Local server (server.py) path
  // Returns true if server handled the request, false if server isn't running.
  // ─────────────────────────────────────────────────────────────
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
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      result = await r.json();
    } catch (e) {
      return false; // server not running
    }

    Terminal.print('$ (server.py) ' + (isCpp ? 'clang++' : 'clang') + ' ' + entry, 'cmd');
    if (result.stderr) {
      result.stderr.split('\n').forEach(line => {
        const isError = /\berror\b/i.test(line);
        const isWarn  = /\bwarning\b/i.test(line);
        if (isError)     Terminal.write('\x1b[38;5;203m' + line + '\x1b[0m\r\n');
        else if (isWarn) Terminal.write('\x1b[38;5;220m' + line + '\x1b[0m\r\n');
        else if (line)   Terminal.write('\x1b[38;5;244m' + line + '\x1b[0m\r\n');
      });
    }
    if (!result.success) {
      Terminal.print('✗ Compilation failed (exit ' + result.exit_code + ')', 'stderr');
      setExit(result.exit_code || 1); setStatus('ok', 'ready'); return true;
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

  // ─────────────────────────────────────────────────────────────
  // Interactive WASM via Web Worker + SharedArrayBuffer
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // Inline WASM runner — complete WASI shim
  // Handles: stdio, stdin, env, args, clock, random, exit, proc_raise,
  //          path ops (stubbed), fd_seek, fd_tell, fd_advise, poll_oneoff
  // ─────────────────────────────────────────────────────────────
  async function runWasmInline(bytes, stdin = '') {
    let exitCode = 0, memory;
    const dec = new TextDecoder(), enc = new TextEncoder();
    const stdinB = enc.encode(stdin + (stdin.endsWith('\n') ? '' : '\n'));
    let stdinPos = 0;

    // Helper: read u32/u64 from wasm memory
    const u32 = (ptr)      => new DataView(memory.buffer).getUint32(ptr, true);
    const setU32 = (ptr, v)=> new DataView(memory.buffer).setUint32(ptr, v, true);
    const setU64 = (ptr, v)=> new DataView(memory.buffer).setBigUint64(ptr, v, true);

    // Gather iov scatter/gather buffers → string
    function iov_read(iovs, iovs_len) {
      let out = '', total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const base = u32(iovs + i * 8), len = u32(iovs + i * 8 + 4);
        out += dec.decode(new Uint8Array(memory.buffer, base, len));
        total += len;
      }
      return { out, total };
    }

    const wasi = { wasi_snapshot_preview1: {
      // ── fd_write ──
      fd_write(fd, iovs, iovs_len, nwritten) {
        const { out, total } = iov_read(iovs, iovs_len);
        setU32(nwritten, total);
        if (fd === 1) Terminal.write('\x1b[0m' + out.replace(/\n/g, '\r\n') + '\x1b[0m');
        else if (fd === 2) Terminal.write('\x1b[38;5;203m' + out.replace(/\n/g, '\r\n') + '\x1b[0m');
        return 0; // ESUCCESS
      },

      // ── fd_read ──
      fd_read(fd, iovs, iovs_len, nread) {
        let total = 0;
        if (fd === 0) {
          const mem8 = new Uint8Array(memory.buffer);
          for (let i = 0; i < iovs_len; i++) {
            const base = u32(iovs + i * 8), len = u32(iovs + i * 8 + 4);
            const chunk = stdinB.slice(stdinPos, stdinPos + len);
            mem8.set(chunk, base);
            stdinPos += chunk.length;
            total += chunk.length;
            if (chunk.length < len) break; // EOF
          }
        }
        setU32(nread, total);
        return 0;
      },

      // ── fd_close ──
      fd_close: () => 0,

      // ── fd_seek (whence: 0=SET 1=CUR 2=END) ──
      fd_seek(fd, offset_lo, offset_hi, whence, newoffset) {
        // Stdin/stdout/stderr: not seekable → return ESPIPE (70)
        if (fd < 3) { setU64(newoffset, 0n); return 70; }
        setU64(newoffset, 0n); return 0;
      },

      // ── fd_tell ──
      fd_tell(fd, offset) {
        setU64(offset, 0n); return 0;
      },

      // ── fd_fdstat_get ──
      fd_fdstat_get(fd, stat) {
        // filetype: 0=unknown,1=block_device,2=char_device,3=dir,4=regular,5=socket_dgram,6=socket_stream,7=symlink
        const v = new DataView(memory.buffer);
        v.setUint8(stat, fd < 3 ? 2 : 4);  // char device for stdio, regular otherwise
        v.setUint16(stat + 2, 0, true);     // fs_flags
        v.setBigUint64(stat + 8, 0n, true); // fs_rights_base
        v.setBigUint64(stat + 16, 0n, true);// fs_rights_inheriting
        return 0;
      },

      // ── fd_fdstat_set_flags ──
      fd_fdstat_set_flags: () => 0,

      // ── fd_filestat_get ──
      fd_filestat_get(fd, buf) {
        // fill with zeros — size/times unknown
        new Uint8Array(memory.buffer, buf, 64).fill(0);
        return 0;
      },

      // ── fd_advise ──
      fd_advise: () => 0,

      // ── fd_allocate ──
      fd_allocate: () => 0,

      // ── fd_datasync / fd_sync ──
      fd_datasync: () => 0,
      fd_sync:     () => 0,

      // ── fd_prestat_get — we expose no preopened dirs ──
      fd_prestat_get: () => 8, // EBADF

      // ── fd_prestat_dir_name ──
      fd_prestat_dir_name: () => 28, // EINVAL

      // ── path_open — stub (no real FS) ──
      path_open: () => 8,

      // ── path_* stubs ──
      path_create_directory: () => 8,
      path_remove_directory: () => 8,
      path_unlink_file:      () => 8,
      path_rename:           () => 8,
      path_link:             () => 8,
      path_symlink:          () => 8,
      path_readlink:         () => 8,
      path_filestat_get:     () => 8,
      path_filestat_set_times: () => 8,

      // ── environ_get / environ_sizes_get ──
      environ_get: (environ, environ_buf) => {
        setU32(environ, 0); return 0;
      },
      environ_sizes_get: (count, buf_size) => {
        setU32(count, 0); setU32(buf_size, 0); return 0;
      },

      // ── args_get / args_sizes_get ──
      args_get: () => 0,
      args_sizes_get: (argc, argv_buf_size) => {
        setU32(argc, 0); setU32(argv_buf_size, 0); return 0;
      },

      // ── proc_exit ──
      proc_exit: (code) => { exitCode = code; throw { __exit: true, code }; },

      // ── proc_raise ──
      proc_raise: (sig) => { exitCode = 128 + sig; throw { __exit: true, code: exitCode }; },

      // ── clock_time_get ──
      clock_time_get: (id, precision, time_ptr) => {
        // id 0=realtime, 1=monotonic — both return wall-clock nanoseconds
        setU64(time_ptr, BigInt(Date.now()) * 1_000_000n);
        return 0;
      },

      // ── clock_res_get ──
      clock_res_get: (id, res_ptr) => {
        setU64(res_ptr, 1_000_000n); // 1ms resolution
        return 0;
      },

      // ── sched_yield ──
      sched_yield: () => 0,

      // ── random_get ──
      random_get: (buf, buf_len) => {
        crypto.getRandomValues(new Uint8Array(memory.buffer, buf, buf_len));
        return 0;
      },

      // ── poll_oneoff — stub (used by some C++ runtimes for sleep) ──
      poll_oneoff: (in_ptr, out_ptr, nsubscriptions, nevents_ptr) => {
        setU32(nevents_ptr, 0); return 0;
      },

      // ── sock stubs ──
      sock_accept:  () => 28,
      sock_recv:    () => 28,
      sock_send:    () => 28,
      sock_shutdown:() => 28,
    }};

    try {
      const { instance } = await WebAssembly.instantiate(bytes, wasi);
      memory = instance.exports.memory;
      if (instance.exports._initialize) instance.exports._initialize();
      if (instance.exports.__wasm_call_ctors) instance.exports.__wasm_call_ctors();
      instance.exports._start();
    } catch(e) {
      if (!e?.__exit) {
        Terminal.write('\x1b[38;5;203mRuntime trap: ' + (e?.message || String(e)) + '\x1b[0m\r\n');
        exitCode = 1;
      }
    }
    return exitCode;
  }

  // ─────────────────────────────────────────────────────────────
  // Worker source (inlined) — full WASI shim for interactive mode
  // ─────────────────────────────────────────────────────────────
  function workerFn() {
    self.onmessage = async ({ data }) => {
      const { wasmBytes, sharedBuf } = data;
      const ctrl    = new Int32Array(sharedBuf, 0, 2);
      const dataBuf = new Uint8Array(sharedBuf, 8);
      const dec = new TextDecoder();
      let exitCode = 0, memory;

      const u32    = (ptr)       => new DataView(memory.buffer).getUint32(ptr, true);
      const setU32 = (ptr, v)    => new DataView(memory.buffer).setUint32(ptr, v, true);
      const setU64 = (ptr, v)    => new DataView(memory.buffer).setBigUint64(ptr, v, true);

      function iov_read(iovs, iovs_len) {
        let out = '', total = 0;
        for (let i = 0; i < iovs_len; i++) {
          const base = u32(iovs + i * 8), len = u32(iovs + i * 8 + 4);
          out += dec.decode(new Uint8Array(memory.buffer, base, len));
          total += len;
        }
        return { out, total };
      }

      const wasi = { wasi_snapshot_preview1: {
        fd_write(fd, iovs, iovs_len, nwritten) {
          const { out, total } = iov_read(iovs, iovs_len);
          setU32(nwritten, total);
          self.postMessage({ type: 'write', fd, text: out });
          return 0;
        },
        fd_read(fd, iovs, iovs_len, nread) {
          if (fd !== 0) { setU32(nread, 0); return 0; }
          Atomics.store(ctrl, 0, 1);
          self.postMessage({ type: 'waiting-stdin' });
          Atomics.wait(ctrl, 0, 1);
          const len = Atomics.load(ctrl, 1);
          const lineBytes = dataBuf.slice(0, len);
          Atomics.store(ctrl, 0, 0);
          const mem8 = new Uint8Array(memory.buffer);
          let written = 0;
          for (let i = 0; i < iovs_len && written < lineBytes.length; i++) {
            const base = u32(iovs + i * 8), cap = u32(iovs + i * 8 + 4);
            const chunk = lineBytes.slice(written, written + cap);
            mem8.set(chunk, base);
            written += chunk.length;
          }
          setU32(nread, written); return 0;
        },
        fd_close: () => 0,
        fd_seek(fd, ol, oh, w, np) { setU64(np, 0n); return fd < 3 ? 70 : 0; },
        fd_tell(fd, off) { setU64(off, 0n); return 0; },
        fd_fdstat_get(fd, stat) {
          const v = new DataView(memory.buffer);
          v.setUint8(stat, fd < 3 ? 2 : 4);
          v.setUint16(stat + 2, 0, true);
          v.setBigUint64(stat + 8, 0n, true);
          v.setBigUint64(stat + 16, 0n, true);
          return 0;
        },
        fd_fdstat_set_flags: () => 0,
        fd_filestat_get(fd, buf) { new Uint8Array(memory.buffer, buf, 64).fill(0); return 0; },
        fd_advise: () => 0,
        fd_allocate: () => 0,
        fd_datasync: () => 0,
        fd_sync:     () => 0,
        fd_prestat_get:      () => 8,
        fd_prestat_dir_name: () => 28,
        path_open:           () => 8,
        path_create_directory: () => 8,
        path_remove_directory: () => 8,
        path_unlink_file:    () => 8,
        path_rename:         () => 8,
        path_link:           () => 8,
        path_symlink:        () => 8,
        path_readlink:       () => 8,
        path_filestat_get:   () => 8,
        path_filestat_set_times: () => 8,
        environ_get: () => 0,
        environ_sizes_get: (c, b) => { setU32(c, 0); setU32(b, 0); return 0; },
        args_get: () => 0,
        args_sizes_get: (c, b) => { setU32(c, 0); setU32(b, 0); return 0; },
        proc_exit: (code) => { exitCode = code; throw { __exit: true, code }; },
        proc_raise: (sig) => { exitCode = 128 + sig; throw { __exit: true, code: exitCode }; },
        clock_time_get: (id, prec, ptr) => { setU64(ptr, BigInt(Date.now()) * 1_000_000n); return 0; },
        clock_res_get: (id, ptr)        => { setU64(ptr, 1_000_000n); return 0; },
        sched_yield: () => 0,
        random_get: (buf, len) => { crypto.getRandomValues(new Uint8Array(memory.buffer, buf, len)); return 0; },
        poll_oneoff: (i, o, n, ne) => { setU32(ne, 0); return 0; },
        sock_accept: () => 28, sock_recv: () => 28, sock_send: () => 28, sock_shutdown: () => 28,
      }};

      try {
        const { instance } = await WebAssembly.instantiate(wasmBytes, wasi);
        memory = instance.exports.memory;
        if (instance.exports._initialize) instance.exports._initialize();
        if (instance.exports.__wasm_call_ctors) instance.exports.__wasm_call_ctors();
        instance.exports._start();
      } catch(e) {
        if (!e?.__exit) {
          self.postMessage({ type: 'write', fd: 2, text: 'Runtime trap: ' + (e?.message || String(e)) + '\n' });
          exitCode = 1;
        }
      }
      self.postMessage({ type: 'done', exitCode });
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Web preview
  // ─────────────────────────────────────────────────────────────
  async function runWeb() { Preview.refresh(); Terminal.print('⚡ Preview refreshed.', 'success'); }

  // ─────────────────────────────────────────────────────────────
  // JavaScript
  // ─────────────────────────────────────────────────────────────
  async function runJS() {
    Terminal.print('$ node ' + State.activeFile, 'cmd');
    Terminal.print('─────────────────────────────', 'info');
    const fakeConsole = {
      log:  (...a) => Terminal.write('\x1b[0m'          + a.map(String).join(' ') + '\r\n'),
      error:(...a) => Terminal.write('\x1b[38;5;203m'   + a.map(String).join(' ') + '\x1b[0m\r\n'),
      warn: (...a) => Terminal.write('\x1b[38;5;220m'   + a.map(String).join(' ') + '\x1b[0m\r\n'),
      info: (...a) => Terminal.write('\x1b[38;5;69m'    + a.map(String).join(' ') + '\x1b[0m\r\n'),
    };
    try { new Function('console', State.files[State.activeFile])(fakeConsole); setExit(0); }
    catch(e) { Terminal.write('\x1b[38;5;203m' + e.toString() + '\x1b[0m\r\n'); setExit(1); }
    setStatus('ok', 'ready');
  }

  // ─────────────────────────────────────────────────────────────
  // TypeScript
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // Python (Pyodide)
  // ─────────────────────────────────────────────────────────────
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

    py.runPython(`import sys, io, builtins
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()`);

    const flushOut = () => {
      try {
        const out = py.runPython('sys.stdout.getvalue()');
        if (out) {
          py.runPython('sys.stdout.truncate(0); sys.stdout.seek(0)');
          Terminal.write(out.replace(/\n/g, '\r\n'));
        }
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

  // ─────────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────────
  async function init() {
    setStatus('ok', 'ready');
  }

  return { run, init };
})();
