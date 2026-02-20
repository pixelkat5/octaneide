// ── Git Panel ─────────────────────────────────────────────────
const Git = (() => {

  let _available = false; // true once server confirms git is present

  // ── UI helpers ────────────────────────────────────────────
  function _panelEl()  { return document.getElementById('panel-git'); }
  function _outputEl() { return document.getElementById('git-output'); }
  function _statusEl() { return document.getElementById('git-status-list'); }
  function _branchEl() { return document.getElementById('git-branch-name'); }
  function _msgEl()    { return document.getElementById('git-commit-msg'); }

  function _print(text, cls = '') {
    const el = _outputEl();
    if (!el) return;
    const line = document.createElement('div');
    line.className = 'git-line' + (cls ? ' ' + cls : '');
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function _clearOutput() {
    const el = _outputEl();
    if (el) el.innerHTML = '';
  }

  function _setLoading(btn, yes) {
    if (!btn) return;
    btn.disabled = yes;
    btn.dataset.origText = btn.dataset.origText || btn.textContent;
    btn.textContent = yes ? '⟳' : btn.dataset.origText;
  }

  // ── Server call ───────────────────────────────────────────
  async function _run(args, input = '') {
    try {
      const r = await fetch('/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args, input }),
      });
      if (!r.ok) {
        if (r.status === 404) return { ok: false, stdout: '', stderr: 'Git endpoint not found — please update server.py', code: 404 };
        return { ok: false, stdout: '', stderr: 'HTTP ' + r.status, code: r.status };
      }
      return await r.json(); // { ok, stdout, stderr, code }
    } catch (e) {
      return { ok: false, stdout: '', stderr: 'Server not running', code: -1 };
    }
  }

  // ── Pretty-print a result ─────────────────────────────────
  function _printResult(res) {
    if (res.stdout && res.stdout.trim()) {
      res.stdout.trim().split('\n').forEach(l => _print(l, ''));
    }
    if (res.stderr && res.stderr.trim()) {
      res.stderr.trim().split('\n').forEach(l => _print(l, 'git-err'));
    }
    if (!res.ok && !res.stderr && !res.stdout) {
      _print('(no output)', 'git-dim');
    }
  }

  // ── Refresh status + branch ───────────────────────────────
  async function refresh() {
    const branchEl = _branchEl();
    const statusEl = _statusEl();
    if (branchEl) branchEl.textContent = '…';
    if (statusEl) statusEl.innerHTML = '<div class="git-dim" style="padding:4px 0">loading…</div>';

    // Get branch
    const branchRes = await _run(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branchRes.ok) {
      _available = false;
      if (branchEl) branchEl.textContent = 'not a repo';
      if (statusEl) statusEl.innerHTML = '<div class="git-dim" style="padding:6px 0">Run <code>git init</code> first.</div>';
      return;
    }
    _available = true;
    if (branchEl) branchEl.textContent = branchRes.stdout.trim() || 'HEAD';

    // Get status --short
    const statusRes = await _run(['status', '--short', '--branch']);
    if (!statusEl) return;
    statusEl.innerHTML = '';
    if (!statusRes.stdout.trim()) {
      statusEl.innerHTML = '<div class="git-dim" style="padding:6px 0">✓ Working tree clean</div>';
      return;
    }
    statusRes.stdout.trim().split('\n').forEach(line => {
      if (!line) return;
      const xy  = line.slice(0, 2);
      const file = line.slice(3);
      // Skip the branch ## line
      if (xy === '##') return;
      const cls = xy.trim().startsWith('?') ? 'git-untracked' :
                  xy.includes('M') ? 'git-modified' :
                  xy.includes('A') ? 'git-added' :
                  xy.includes('D') ? 'git-deleted' : '';
      const row = document.createElement('div');
      row.className = 'git-status-row ' + cls;
      row.innerHTML = `<span class="git-xy">${_escHtml(xy)}</span><span class="git-file">${_escHtml(file)}</span>`;
      // Click to stage/unstage
      row.title = 'Click to stage';
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => stageFile(file.trim()));
      statusEl.appendChild(row);
    });
  }

  function _escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Commands ──────────────────────────────────────────────
  async function runCmd(argsStr) {
    _clearOutput();
    const args = argsStr.trim().split(/\s+/).filter(Boolean);
    if (!args.length) return;
    // Strip leading 'git' if user typed it
    const finalArgs = args[0] === 'git' ? args.slice(1) : args;
    _print('$ git ' + finalArgs.join(' '), 'git-cmd');
    const res = await _run(finalArgs);
    _printResult(res);
    await refresh();
  }

  async function stageFile(file) {
    _clearOutput();
    _print('$ git add ' + file, 'git-cmd');
    const res = await _run(['add', file]);
    _printResult(res);
    await refresh();
  }

  async function stageAll() {
    _clearOutput();
    _print('$ git add -A', 'git-cmd');
    const res = await _run(['add', '-A']);
    _printResult(res);
    await refresh();
  }

  async function commit() {
    const msg = (_msgEl() ? _msgEl().value.trim() : '');
    if (!msg) { _clearOutput(); _print('✗ Please enter a commit message.', 'git-err'); return; }
    const btn = document.getElementById('git-btn-commit');
    _setLoading(btn, true);
    _clearOutput();
    _print('$ git commit -m "' + msg + '"', 'git-cmd');
    const res = await _run(['commit', '-m', msg]);
    _printResult(res);
    if (res.ok && _msgEl()) _msgEl().value = '';
    _setLoading(btn, false);
    await refresh();
  }

  async function push() {
    const btn = document.getElementById('git-btn-push');
    _setLoading(btn, true);
    _clearOutput();
    _print('$ git push', 'git-cmd');
    const res = await _run(['push']);
    _printResult(res);
    _setLoading(btn, false);
    await refresh();
  }

  async function pull() {
    const btn = document.getElementById('git-btn-pull');
    _setLoading(btn, true);
    _clearOutput();
    _print('$ git pull', 'git-cmd');
    const res = await _run(['pull']);
    _printResult(res);
    _setLoading(btn, false);
    await refresh();
  }

  async function log() {
    _clearOutput();
    _print('$ git log --oneline -20', 'git-cmd');
    const res = await _run(['log', '--oneline', '-20']);
    _printResult(res);
  }

  async function diff() {
    _clearOutput();
    _print('$ git diff --stat', 'git-cmd');
    const res = await _run(['diff', '--stat']);
    _printResult(res);
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    // Tab button
    const tabBtn = document.querySelector('.o-tab[data-panel="git"]');
    if (tabBtn) tabBtn.addEventListener('click', () => { showPanel('git'); refresh(); });

    // Command input
    const cmdInput = document.getElementById('git-cmd-input');
    const cmdBtn   = document.getElementById('git-btn-run-cmd');
    if (cmdInput) {
      cmdInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { runCmd(cmdInput.value); cmdInput.value = ''; }
      });
    }
    if (cmdBtn) {
      cmdBtn.addEventListener('click', () => {
        if (cmdInput) { runCmd(cmdInput.value); cmdInput.value = ''; }
      });
    }

    // Buttons
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('git-btn-refresh',   () => { _clearOutput(); refresh(); });
    bind('git-btn-stage-all', stageAll);
    bind('git-btn-commit',    commit);
    bind('git-btn-push',      push);
    bind('git-btn-pull',      pull);
    bind('git-btn-log',       log);
    bind('git-btn-diff',      diff);
  }

  return { init, refresh, runCmd, stageAll, commit, push, pull, log, diff };
})();
