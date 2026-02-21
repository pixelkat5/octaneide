// ── Compiler ──────────────────────────────────────────────────
const Compiler = (() => {

  // ─────────────────────────────────────────────────────────────
  // browsercc CDN URLs  (all served from jsDelivr, no server needed)
  // ─────────────────────────────────────────────────────────────
  const BROWSERCC_BASE   = 'https://cdn.jsdelivr.net/npm/browsercc@0.1.1/dist';
  const WASI_SHIM_URL    = 'https://esm.sh/@bjorn3/browser_wasi_shim@0.4.2/es2022/browser_wasi_shim.mjs';

  // ─────────────────────────────────────────────────────────────
  // Status helpers
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // Run dispatcher
  // ─────────────────────────────────────────────────────────────
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
  // C / C++ entry point
  // Pipeline: server.py (local dev only) → browsercc (always offline after first load)
  // ─────────────────────────────────────────────────────────────
  async function runCpp() {
    // Find entry file: prefer main.cpp, then main.c, then any .cpp, then any .c
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
      // server.py — only used for local dev, skipped silently if not running
      const serverOk = await runCppServer(entry, isCpp);
      if (serverOk) return;

      // browsercc — fully offline after first load
      await runCppBrowsercc(entry, isCpp);

    } catch(e) {
      Terminal.print('✗ C++ runner error: ' + e.message, 'stderr');
      if (State.settings.showDevErrors) console.error(e);
      setExit(1); setStatus('err', 'error');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // browsercc pipeline
  // Uses a Web Worker that runs the entire compile+link+execute cycle.
  // All heavy WASM files are fetched once and cached by the service worker.
  // ─────────────────────────────────────────────────────────────
  function runCppBrowsercc(entry, isCpp) {
    return new Promise((resolve, reject) => {
      // Build file map to send to worker
      const files = {};
      for (const [name, src] of Object.entries(State.files)) {
        files[name] = src;
      }

      const std   = State.settings.std  || (isCpp ? '-std=c++17' : '-std=c11');
      const opt   = State.settings.opt  || '-O1';
      const flags = State.settings.flags || '';

      Terminal.print(
        `$ ${isCpp ? 'clang++' : 'clang'} ${entry} ${std} ${opt}${flags ? ' ' + flags : ''}`,
        'cmd'
      );
      setStatus('spin', 'compiling (browsercc)…');

      // Inline the worker function — avoids needing a separate worker file
      // and works on Cloudflare Pages with no extra build step.
      const workerSrc = `(${_browserccWorker.toString()})()`;
      const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
      const workerUrl  = URL.createObjectURL(workerBlob);
      const worker     = new Worker(workerUrl);

      // SharedArrayBuffer for interactive stdin (requires COOP/COEP headers)
      let sharedBuf = null;
      if (typeof SharedArrayBuffer !== 'undefined') {
        sharedBuf = new SharedArrayBuffer(64 * 1024); // 64 KB stdin buffer
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
            // Colour-code compile diagnostics
            data.text.split('\n').forEach(line => {
              if (!line) return;
              if (/\berror\b/i.test(line))        Terminal.write('\x1b[38;5;203m' + line + '\x1b[0m\r\n');
              else if (/\bwarning\b/i.test(line)) Terminal.write('\x1b[38;5;220m' + line + '\x1b[0m\r\n');
              else if (/\bnote\b/i.test(line))    Terminal.write('\x1b[38;5;244m' + line + '\x1b[0m\r\n');
              else                                Terminal.write('\x1b[38;5;244m' + line + '\x1b[0m\r\n');
            });
            break;
          }

          case 'waiting-stdin':
            // Program called read()/cin >> — prompt user interactively
            if (sharedBuf) {
              Terminal.startInteractiveInput(sharedBuf);
            } else {
              // Fallback: can't do synchronous stdin without SAB
              const ctrl = new Int32Array(data.sharedBuf, 0, 2);
              Atomics.store(ctrl, 1, 0);
              Atomics.store(ctrl, 0, 0);
              Atomics.notify(ctrl, 0);
            }
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
              `─── exit ${data.exitCode} · browsercc/clang ───`,
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
        files,
        entry,
        isCpp,
        std,
        opt,
        flags,
        sharedBuf,
        browserccBase: BROWSERCC_BASE,
        wasiShimUrl:   WASI_SHIM_URL,
      });
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Web Worker source — runs inside a blob worker.
  //
  // Pipeline:
  //   1. Fetch clang.js + lld.js (emscripten glue modules)
  //   2. Fetch clang.wasm + lld.wasm + sysroot.tar (cached by SW after first load)
  //   3. Run clang to compile .cpp → .o (WASM object)
  //   4. Run lld to link .o → final WASM binary
  //   5. Run final WASM with @bjorn3/browser_wasi_shim
  //
  // All communication back to main thread is via postMessage.
  // ─────────────────────────────────────────────────────────────
  function _browserccWorker() {
    let browserccBase, wasiShimUrl;

    // ── Helpers ──────────────────────────────────────────────
    function post(type, extra = {}) {
      self.postMessage({ type, ...extra });
    }

    // Load browsercc module (returns { clang, lld, ... })
    async function loadBrowsercc() {
      post('status', { text: 'loading compiler…' });
      // Import the main browsercc index which re-exports clang + lld helpers
      const { default: BrowserCC } = await import(`${browserccBase}/index.js`);
      return BrowserCC;
    }

    // Unpack sysroot.tar into an in-memory map { path → Uint8Array }
    async function fetchSysroot() {
      post('status', { text: 'loading sysroot…' });
      const resp = await fetch(`${browserccBase}/sysroot.tar`);
      if (!resp.ok) throw new Error('Failed to fetch sysroot.tar: ' + resp.status);
      const buf  = await resp.arrayBuffer();
      return parseTar(new Uint8Array(buf));
    }

    // Minimal tar parser — handles ustar and old-style POSIX tars
    function parseTar(data) {
      const files = {};
      const dec = new TextDecoder();
      let offset = 0;
      while (offset + 512 <= data.length) {
        const header = data.slice(offset, offset + 512);
        // Check for end-of-archive (two 512-byte zero blocks)
        if (header.every(b => b === 0)) { offset += 512; continue; }
        const name = dec.decode(header.slice(0, 100)).replace(/\0.*$/, '');
        if (!name) { offset += 512; continue; }
        const sizeStr = dec.decode(header.slice(124, 136)).replace(/\0.*$/, '').trim();
        const size    = parseInt(sizeStr, 8) || 0;
        const type    = String.fromCharCode(header[156]);
        // prefix field (ustar)
        const prefix  = dec.decode(header.slice(345, 500)).replace(/\0.*$/, '');
        const fullName = prefix ? prefix + '/' + name : name;
        offset += 512; // past header
        if (type === '0' || type === '' || type === '\0') {
          // Regular file
          files['/' + fullName.replace(/^\//, '')] = data.slice(offset, offset + size);
        }
        // Advance past file data, rounded up to 512-byte blocks
        offset += Math.ceil(size / 512) * 512;
      }
      return files;
    }

    // Run clang (or lld) with a virtual FS and return { exitCode, stderr }
    async function runTool(moduleFactory, args, inputFiles, outputPath) {
      return new Promise((resolve) => {
        let stderr = '';
        let exitCode = 0;

        const Module = moduleFactory({
          noInitialRun: true,
          print:    () => {},
          printErr: (text) => { stderr += text + '\n'; },
          quit: (code) => { exitCode = code; },
          preRun: [(m) => {
            // Write all input files into emscripten's virtual FS
            for (const [path, data] of Object.entries(inputFiles)) {
              const parts = path.split('/').filter(Boolean);
              // Create parent dirs
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
          try {
            m.callMain(args);
          } catch(e) {
            if (typeof e === 'number') exitCode = e;
            else if (e && e.status !== undefined) exitCode = e.status;
            else exitCode = 1;
          }
          // Read output file if requested
          let output = null;
          if (outputPath) {
            try { output = m.FS.readFile(outputPath); } catch(_) {}
          }
          resolve({ exitCode, stderr: stderr.trim(), output });
        }).catch(e => {
          resolve({ exitCode: 1, stderr: e.message, output: null });
        });
      });
    }

    // ── Main message handler ──────────────────────────────────
    self.onmessage = async ({ data }) => {
      const { files, entry, isCpp, std, opt, flags, sharedBuf } = data;
      browserccBase = data.browserccBase;
      wasiShimUrl   = data.wasiShimUrl;

      try {
        // ── Step 1: Load browsercc modules ──
        post('status', { text: 'loading clang…' });

        // Import clang.js and lld.js — these are emscripten-generated module factories
        const [clangMod, lldMod] = await Promise.all([
          import(`${browserccBase}/clang.js`).then(m => m.default || m),
          import(`${browserccBase}/lld.js`).then(m => m.default || m),
        ]);

        // ── Step 2: Load sysroot (C++ standard headers + libs) ──
        post('status', { text: 'loading sysroot…' });
        const resp = await fetch(`${browserccBase}/sysroot.tar`);
        if (!resp.ok) throw new Error('Failed to fetch sysroot.tar: HTTP ' + resp.status);
        const tarBuf  = await resp.arrayBuffer();
        const sysroot = parseTar(new Uint8Array(tarBuf));

        // ── Step 3: Compile with clang ──
        post('status', { text: 'compiling…' });

        // Build the virtual FS for clang: user source files + sysroot
        const clangFS = {};

        // Add sysroot files
        for (const [p, d] of Object.entries(sysroot)) clangFS[p] = d;

        // Add user source files under /src/
        const enc = new TextEncoder();
        for (const [name, src] of Object.entries(files)) {
          clangFS['/src/' + name] = enc.encode(src);
        }

        // Also try to load the precompiled stdc++.h.pch header for speed
        let pchData = null;
        try {
          const pchResp = await fetch(`${browserccBase}/stdc++.h.pch`);
          if (pchResp.ok) pchData = new Uint8Array(await pchResp.arrayBuffer());
        } catch(_) {}
        if (pchData) clangFS['/usr/include/c++/v1/stdc++.h.pch'] = pchData;

        const clangArgs = [
          isCpp ? 'clang++' : 'clang',
          `/src/${entry}`,
          '-o', '/out/output.o',
          '-c',          // compile only, no link
          std,
          opt,
          '-isysroot', '/',
          '-I/usr/include',
          '-I/usr/include/c++/v1',
          '-I/src',
          '--target=wasm32-wasi',
          '-fno-exceptions',   // keeps output .o simpler; remove if project needs exceptions
        ];
        if (flags) clangArgs.push(...flags.split(/\s+/).filter(Boolean));

        // Ensure /out dir exists
        clangFS['/out/.keep'] = new Uint8Array(0);

        const compile = await runTool(clangMod, clangArgs, clangFS, '/out/output.o');

        if (compile.stderr) post('stderr', { text: compile.stderr });

        if (compile.exitCode !== 0 || !compile.output) {
          post('compile-error', { exitCode: compile.exitCode || 1 });
          return;
        }

        post('compile-ok');

        // ── Step 4: Link with lld ──
        post('status', { text: 'linking…' });

        const lldFS = {};
        // Add sysroot libs
        for (const [p, d] of Object.entries(sysroot)) lldFS[p] = d;
        // Add compiled object
        lldFS['/out/output.o'] = compile.output;

        const lldArgs = [
          'wasm-ld',
          '/out/output.o',
          '-o', '/out/a.wasm',
          '--no-entry',
          '--export-dynamic',
          '--allow-undefined',
          '-L/usr/lib/wasm32-wasi',
          isCpp ? '-lc++ -lc++abi -lc' : '-lc',
          '-lwasi-emulated-mman',
        ];

        const link = await runTool(lldMod, lldArgs, lldFS, '/out/a.wasm');

        if (link.stderr) post('stderr', { text: link.stderr });

        if (link.exitCode !== 0 || !link.output) {
          post('compile-error', { exitCode: link.exitCode || 1 });
          return;
        }

        // ── Step 5: Execute with @bjorn3/browser_wasi_shim ──
        post('status', { text: 'running…' });

        const { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory } =
          await import(wasiShimUrl);

        // Capture output
        let stdoutBuf = '';
        let stderrBuf = '';

        // stdin handling
        let stdinBytes = new Uint8Array(0);
        let stdinPos   = 0;

        let stdinFile;
        if (sharedBuf) {
          // Interactive: use SharedArrayBuffer for synchronous reads from main thread
          const ctrl    = new Int32Array(sharedBuf, 0, 2);
          const dataBuf = new Uint8Array(sharedBuf, 8);
          let   pending = false;

          stdinFile = new File([], {
            read(len) {
              if (!pending) {
                pending = true;
                Atomics.store(ctrl, 0, 1);
                post('waiting-stdin', { sharedBuf });
                Atomics.wait(ctrl, 0, 1); // blocks worker thread until main thread writes
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
          // Non-interactive: empty stdin
          stdinFile = new File([]);
        }

        const flushStdout = ConsoleStdout.lineBuffered(line => {
          post('stdout', { text: line + '\n' });
        });
        const flushStderr = ConsoleStdout.lineBuffered(line => {
          post('stderr', { text: line });
        });

        const fds = [
          new OpenFile(stdinFile),
          flushStdout,
          flushStderr,
        ];

        const wasi = new WASI(
          ['program'],   // argv[0]
          [],            // env
          fds,
          { debug: false }
        );

        let exitCode = 0;
        try {
          const wasmModule = await WebAssembly.compile(link.output.buffer
            ? link.output.buffer
            : link.output instanceof Uint8Array
              ? link.output.buffer
              : link.output
          );
          const instance = await WebAssembly.instantiate(wasmModule, {
            wasi_snapshot_preview1: wasi.wasiImport,
          });
          exitCode = wasi.start(instance) ?? 0;
        } catch(e) {
          if (e && e.message && e.message.includes('exit')) {
            // proc_exit — extract code if possible
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

  // ─────────────────────────────────────────────────────────────
  // Local server (server.py) — dev-only fallback
  // Returns true if server responded, false if not running.
  // ─────────────────────────────────────────────────────────────
  async function runCppServer(entry, isCpp) {
    const filesToSend = { ...State.files };
    for (const id of (State.settings.downloadedLibs || [])) {
      const lib = LIBRARIES.find(l => l.id === id);
      if (lib) { const data = await Persist.loadLib(id); if (data) filesToSend[lib.path] = data; }
    }

    let result;
    try {
      const r = await fetch('/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: filesToSend,
          entry,
          std:   State.settings.std,
          opt:   State.settings.opt,
          flags: State.settings.flags,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      result = await r.json();
    } catch(e) {
      return false; // server not running — silent
    }

    Terminal.print('$ (server.py) ' + (isCpp ? 'clang++' : 'clang') + ' ' + entry, 'cmd');

    if (result.stderr) {
      result.stderr.split('\n').forEach(line => {
        if (!line) return;
        if (/\berror\b/i.test(line))        Terminal.write('\x1b[38;5;203m' + line + '\x1b[0m\r\n');
        else if (/\bwarning\b/i.test(line)) Terminal.write('\x1b[38;5;220m' + line + '\x1b[0m\r\n');
        else                                Terminal.write('\x1b[38;5;244m' + line + '\x1b[0m\r\n');
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
      if (interactive) Terminal.print('⚠ Interactive stdin unavailable — pre-collect mode.', 'warn');
      const stdin = await Terminal.promptStdin();
      exitCode = await runWasmInline(wasmBytes, stdin);
    }
    setExit(exitCode); setStatus('ok', 'ready');
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // Interactive WASM runner (server.py output) via SharedArrayBuffer
  // ─────────────────────────────────────────────────────────────
  function runWasmInteractive(wasmBytes) {
    return new Promise(resolve => {
      const sharedBuf = new SharedArrayBuffer(1024 * 1024);
      const workerSrc = `(${workerFn.toString()})()`;
      const blob      = new Blob([workerSrc], { type: 'application/javascript' });
      const worker    = new Worker(URL.createObjectURL(blob));

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
  // Inline WASM runner — complete WASI shim (used by server.py path)
  // ─────────────────────────────────────────────────────────────
  async function runWasmInline(bytes, stdin = '') {
    let exitCode = 0, memory;
    const dec = new TextDecoder(), enc = new TextEncoder();
    const stdinB = enc.encode(stdin + (stdin.endsWith('\n') ? '' : '\n'));
    let stdinPos = 0;

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
        if (fd === 1) Terminal.write('\x1b[0m' + out.replace(/\n/g, '\r\n'));
        else if (fd === 2) Terminal.write('\x1b[38;5;203m' + out.replace(/\n/g, '\r\n') + '\x1b[0m');
        return 0;
      },
      fd_read(fd, iovs, iovs_len, nread) {
        let total = 0;
        if (fd === 0) {
          const mem8 = new Uint8Array(memory.buffer);
          for (let i = 0; i < iovs_len; i++) {
            const base = u32(iovs + i * 8), len = u32(iovs + i * 8 + 4);
            const chunk = stdinB.slice(stdinPos, stdinPos + len);
            mem8.set(chunk, base); stdinPos += chunk.length; total += chunk.length;
            if (chunk.length < len) break;
          }
        }
        setU32(nread, total); return 0;
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
      fd_advise: () => 0, fd_allocate: () => 0, fd_datasync: () => 0, fd_sync: () => 0,
      fd_prestat_get: () => 8, fd_prestat_dir_name: () => 28, path_open: () => 8,
      path_create_directory: () => 8, path_remove_directory: () => 8,
      path_unlink_file: () => 8, path_rename: () => 8, path_link: () => 8,
      path_symlink: () => 8, path_readlink: () => 8, path_filestat_get: () => 8,
      path_filestat_set_times: () => 8,
      environ_get: () => 0,
      environ_sizes_get: (c, b) => { setU32(c, 0); setU32(b, 0); return 0; },
      args_get: () => 0,
      args_sizes_get: (c, b) => { setU32(c, 0); setU32(b, 0); return 0; },
      proc_exit: (code) => { exitCode = code; throw { __exit: true, code }; },
      proc_raise: (sig) => { exitCode = 128 + sig; throw { __exit: true, code: exitCode }; },
      clock_time_get: (id, prec, ptr) => { setU64(ptr, BigInt(Date.now()) * 1_000_000n); return 0; },
      clock_res_get: (id, ptr) => { setU64(ptr, 1_000_000n); return 0; },
      sched_yield: () => 0,
      random_get: (buf, len) => { crypto.getRandomValues(new Uint8Array(memory.buffer, buf, len)); return 0; },
      poll_oneoff: (i, o, n, ne) => { setU32(ne, 0); return 0; },
      sock_accept: () => 28, sock_recv: () => 28, sock_send: () => 28, sock_shutdown: () => 28,
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
  // Worker source for interactive mode (server.py path only)
  // ─────────────────────────────────────────────────────────────
  function workerFn() {
    self.onmessage = async ({ data }) => {
      const { wasmBytes, sharedBuf } = data;
      const ctrl    = new Int32Array(sharedBuf, 0, 2);
      const dataBuf = new Uint8Array(sharedBuf, 8);
      const dec = new TextDecoder();
      let exitCode = 0, memory;

      const u32    = (p)    => new DataView(memory.buffer).getUint32(p, true);
      const setU32 = (p, v) => new DataView(memory.buffer).setUint32(p, v, true);
      const setU64 = (p, v) => new DataView(memory.buffer).setBigUint64(p, v, true);

      function iov_read(iovs, n) {
        let out = '', total = 0;
        for (let i = 0; i < n; i++) {
          const base = u32(iovs + i*8), len = u32(iovs + i*8 + 4);
          out += dec.decode(new Uint8Array(memory.buffer, base, len));
          total += len;
        }
        return { out, total };
      }

      const wasi = { wasi_snapshot_preview1: {
        fd_write(fd, iovs, n, nw) {
          const { out, total } = iov_read(iovs, n);
          setU32(nw, total);
          self.postMessage({ type: 'write', fd, text: out });
          return 0;
        },
        fd_read(fd, iovs, n, nr) {
          if (fd !== 0) { setU32(nr, 0); return 0; }
          Atomics.store(ctrl, 0, 1);
          self.postMessage({ type: 'waiting-stdin' });
          Atomics.wait(ctrl, 0, 1);
          const len = Atomics.load(ctrl, 1);
          const chunk = dataBuf.slice(0, len);
          Atomics.store(ctrl, 0, 0);
          const mem8 = new Uint8Array(memory.buffer);
          let written = 0;
          for (let i = 0; i < n && written < chunk.length; i++) {
            const base = u32(iovs + i*8), cap = u32(iovs + i*8 + 4);
            const sl = chunk.slice(written, written + cap);
            mem8.set(sl, base); written += sl.length;
          }
          setU32(nr, written); return 0;
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
        fd_advise: () => 0, fd_allocate: () => 0, fd_datasync: () => 0, fd_sync: () => 0,
        fd_prestat_get: () => 8, fd_prestat_dir_name: () => 28, path_open: () => 8,
        path_create_directory: () => 8, path_remove_directory: () => 8,
        path_unlink_file: () => 8, path_rename: () => 8, path_link: () => 8,
        path_symlink: () => 8, path_readlink: () => 8, path_filestat_get: () => 8,
        path_filestat_set_times: () => 8,
        environ_get: () => 0,
        environ_sizes_get: (c, b) => { setU32(c, 0); setU32(b, 0); return 0; },
        args_get: () => 0,
        args_sizes_get: (c, b) => { setU32(c, 0); setU32(b, 0); return 0; },
        proc_exit: (code) => { exitCode = code; throw { __exit: true, code }; },
        proc_raise: (sig) => { exitCode = 128+sig; throw { __exit: true, code: exitCode }; },
        clock_time_get: (id, p, ptr) => { setU64(ptr, BigInt(Date.now()) * 1_000_000n); return 0; },
        clock_res_get: (id, ptr) => { setU64(ptr, 1_000_000n); return 0; },
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
        if (!e?.__exit)
          self.postMessage({ type: 'write', fd: 2, text: 'Runtime trap: ' + (e?.message || String(e)) + '\n' });
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
      log:  (...a) => Terminal.write('\x1b[0m'        + a.map(String).join(' ') + '\r\n'),
      error:(...a) => Terminal.write('\x1b[38;5;203m' + a.map(String).join(' ') + '\x1b[0m\r\n'),
      warn: (...a) => Terminal.write('\x1b[38;5;220m' + a.map(String).join(' ') + '\x1b[0m\r\n'),
      info: (...a) => Terminal.write('\x1b[38;5;69m'  + a.map(String).join(' ') + '\x1b[0m\r\n'),
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

    py.runPython(`import sys, io
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
