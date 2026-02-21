// ── Project Panel (export / import) ──────────────────────────
const Git = (() => {

  // ── Export project as .zip ────────────────────────────────
  async function exportZip() {
    // Build a zip using a tiny in-browser zip writer (no dependencies needed —
    // we construct a valid ZIP binary manually for small projects).
    const files = { ...State.files };
    if (State.activeFile && State.editor) files[State.activeFile] = State.editor.getValue();

    const enc = new TextEncoder();
    const entries = Object.entries(files);

    // Simple ZIP builder
    const localHeaders = [];
    const centralDir   = [];
    let offset = 0;

    for (const [name, content] of entries) {
      const nameBytes = enc.encode(name);
      const dataBytes = enc.encode(content);
      const crc = crc32(dataBytes);
      const now = dosDateTime();

      // Local file header
      const lh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lh.buffer);
      lv.setUint32(0,  0x04034b50, true); // signature
      lv.setUint16(4,  20, true);          // version needed
      lv.setUint16(6,  0, true);           // flags
      lv.setUint16(8,  0, true);           // compression (stored)
      lv.setUint32(10, now, true);         // mod time/date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lh.set(nameBytes, 30);

      localHeaders.push(lh, dataBytes);

      // Central directory entry
      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0,  0x02014b50, true);
      cv.setUint16(4,  20, true);
      cv.setUint16(6,  20, true);
      cv.setUint16(8,  0, true);
      cv.setUint16(10, 0, true);
      cv.setUint32(12, now, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, dataBytes.length, true);
      cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      centralDir.push(cd);

      offset += lh.length + dataBytes.length;
    }

    const cdOffset = offset;
    const cdBytes  = concat(centralDir);

    // End of central directory
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0,  0x06054b50, true);
    ev.setUint16(4,  0, true);
    ev.setUint16(6,  0, true);
    ev.setUint16(8,  entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdBytes.length, true);
    ev.setUint32(16, cdOffset, true);
    ev.setUint16(20, 0, true);

    const zipBytes = concat([...localHeaders, cdBytes, eocd]);
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'project.zip';
    a.click();
    URL.revokeObjectURL(url);
    _print('✓ Exported project.zip (' + entries.length + ' files)', 'git-ok');
  }

  // ── Import files from disk ────────────────────────────────
  function importFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.cpp,.c,.h,.hpp,.js,.ts,.py,.html,.htm,.css,.json,.md,.txt';
    input.onchange = async () => {
      const fileList = Array.from(input.files);
      if (!fileList.length) return;
      let imported = 0;
      for (const file of fileList) {
        const text = await file.text();
        State.files[file.name] = text;
        if (!State.openTabs.includes(file.name)) State.openTabs.push(file.name);
        imported++;
      }
      FileTree.render();
      if (imported === 1) {
        State.activeFile = fileList[0].name;
        Editor.open(fileList[0].name);
      }
      await Persist.save();
      _print(`✓ Imported ${imported} file${imported !== 1 ? 's' : ''}`, 'git-ok');
    };
    input.click();
  }

  // ── Export single active file ─────────────────────────────
  function exportFile() {
    const name = State.activeFile;
    if (!name) { _print('✗ No file active.', 'git-err'); return; }
    const content = (State.editor ? State.editor.getValue() : State.files[name]) || '';
    const blob = new Blob([content], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = FileTree.basename(name); a.click();
    URL.revokeObjectURL(url);
    _print('✓ Downloaded ' + FileTree.basename(name), 'git-ok');
  }

  // ── Clear / reset project ─────────────────────────────────
  async function clearProject() {
    if (!confirm('Clear all files and reset to the default project?')) return;
    State.files = {
      'main.cpp': '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n',
    };
    State.openTabs = ['main.cpp'];
    State.activeFile = 'main.cpp';
    FileTree.render();
    Editor.open('main.cpp');
    await Persist.save();
    _print('✓ Project reset.', 'git-ok');
  }

  // ── Output helper ─────────────────────────────────────────
  function _print(text, cls = '') {
    const el = document.getElementById('git-output');
    if (!el) return;
    const line = document.createElement('div');
    line.className = 'git-line' + (cls ? ' ' + cls : '');
    line.textContent = text;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  // ── ZIP helpers ───────────────────────────────────────────
  function concat(arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
  }

  function crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime() {
    const d = new Date();
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return ((date << 16) | time) >>> 0;
  }

  // ── Init ──────────────────────────────────────────────────
  function init() {
    const tabBtn = document.querySelector('.o-tab[data-panel="git"]');
    if (tabBtn) tabBtn.addEventListener('click', () => showPanel('git'));

    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('git-btn-export-zip',  exportZip);
    bind('git-btn-import',      importFiles);
    bind('git-btn-export-file', exportFile);
    bind('git-btn-clear',       clearProject);
  }

  return { init };
})();
