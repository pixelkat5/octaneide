// ── Terminal ──────────────────────────────────────────────────
const Terminal = (() => {
  function init() {
    const TC = window.Terminal;
    const FA = window.FitAddon?.FitAddon || window.FitAddon;
    if (!TC) {
      document.getElementById('xterm-container').innerHTML =
        '<div style="padding:14px;color:#ff4d6d;font-size:12px">⚠ Terminal failed to load — use <code>python server.py</code> (not server.py with COEP headers)</div>';
      return;
    }
    State.term = new TC({
      theme:{ background:'#0c0c0f', foreground:'#d8d8e8', cursor:'#7c6aff',
              black:'#1a1a20', red:'#ff4d6d', green:'#3ddd8a', yellow:'#f0a030',
              blue:'#7c6aff', magenta:'#c87aff', cyan:'#5cc8ff', white:'#d8d8e8',
              brightBlack:'#5a5a70', brightRed:'#ff6b84', brightGreen:'#5af0a8',
              brightYellow:'#ffbb50', brightBlue:'#9d8fff', brightMagenta:'#d89fff',
              brightCyan:'#7ad8ff', brightWhite:'#ffffff' },
      fontFamily:"'JetBrains Mono', monospace", fontSize:12, lineHeight:1.5,
      cursorBlink:true, scrollback:5000, convertEol:true,
    });
    if (FA) { State.fitAddon = new FA(); State.term.loadAddon(State.fitAddon); }
    State.term.open(document.getElementById('xterm-container'));
    if (State.fitAddon) State.fitAddon.fit();
    new ResizeObserver(() => { if (State.fitAddon) State.fitAddon.fit(); })
      .observe(document.getElementById('xterm-container'));

    State.term.writeln('\x1b[38;5;99m OctaneIDE\x1b[0m  \x1b[38;5;8mCtrl+Enter to run · ⚙ for settings\x1b[0m');
    State.term.writeln('');
  }

  function clear() { if (State.term) { State.term.clear(); State.term.write('\x1b[2J\x1b[H'); } }

  function print(text, type='stdout') {
    if (!State.term) return;
    const c = { stdout:'\x1b[0m', stderr:'\x1b[38;5;203m', info:'\x1b[38;5;69m', success:'\x1b[38;5;84m', warn:'\x1b[38;5;220m', cmd:'\x1b[38;5;241m' };
    State.term.writeln((c[type]||'\x1b[0m') + text + '\x1b[0m');
  }

  function write(s) { if (State.term) State.term.write(s); }

  // ── Interactive stdin (for worker-based execution) ──
  // Called by compiler when the worker signals it's waiting for input.
  // Captures keypresses, echoes them, and writes the completed line
  // into the SharedArrayBuffer so the worker can unblock.
  let _inputDisposable = null;

  function startInteractiveInput(sharedBuf) {
    if (!State.term) return;
    const ctrl    = new Int32Array(sharedBuf, 0, 2);
    const dataBuf = new Uint8Array(sharedBuf, 8);
    const enc     = new TextEncoder();
    let line = '';

    _inputDisposable = State.term.onData(data => {
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 13 || ch === '\n') {
          // Enter — send line + newline to worker
          State.term.write('\r\n');
          const encoded = enc.encode(line + '\n');
          dataBuf.set(encoded, 0);
          Atomics.store(ctrl, 1, encoded.length);   // set length
          Atomics.store(ctrl, 0, 2);                // set control = ready
          Atomics.notify(ctrl, 0, 1);               // wake the worker
          line = '';
          // Disposable stays active — program may ask for more input
        } else if (code === 127 || code === 8) {
          // Backspace
          if (line.length > 0) {
            line = line.slice(0, -1);
            State.term.write('\b \b');
          }
        } else if (code === 3) {
          // Ctrl+C — kill (send empty, worker will likely get EOF or loop)
          stopInteractiveInput();
        } else if (code >= 32) {
          line += ch;
          State.term.write(ch);
        }
      }
    });
  }

  function stopInteractiveInput() {
    if (_inputDisposable) { _inputDisposable.dispose(); _inputDisposable = null; }
  }

  // ── Pre-collect stdin (fallback for non-interactive mode) ──
  function promptStdin() {
    return new Promise(resolve => {
      if (!State.term) { resolve(''); return; }
      let input = '', currentLine = '';
      State.term.writeln('\x1b[38;5;69m── stdin: type input below, Ctrl+D when done ──\x1b[0m');
      State.term.write('\x1b[38;5;220m> \x1b[0m');
      const disposable = State.term.onData(data => {
        for (const ch of data) {
          const code = ch.charCodeAt(0);
          if (code === 4) {
            if (currentLine.length > 0) { input += currentLine + '\n'; State.term.writeln(''); }
            State.term.writeln('\x1b[38;5;69m── EOF ──\x1b[0m');
            disposable.dispose();
            resolve(input);
            return;
          }
          if (code === 13 || ch === '\n') {
            input += currentLine + '\n'; State.term.writeln(''); currentLine = '';
            State.term.write('\x1b[38;5;220m> \x1b[0m');
          } else if (code === 127 || code === 8) {
            if (currentLine.length > 0) { currentLine = currentLine.slice(0,-1); State.term.write('\b \b'); }
          } else if (code >= 32) { currentLine += ch; State.term.write(ch); }
        }
      });
    });
  }

  return { init, clear, print, write, startInteractiveInput, stopInteractiveInput, promptStdin };
})();