// ── Persist ───────────────────────────────────────────────────
const Persist = (() => {
  const DB = 'OctaneIDE2'; const VER = 1;
  let db = null;

  async function open() {
    if (db) return db;
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = e => { db = e.target.result; res(db); };
      r.onerror   = e => rej(e.target.error);
    });
  }

  function idbGet(k)    { return new Promise((res,rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }
  function idbSet(k, v) { return new Promise((res,rej) => { const r = db.transaction('kv','readwrite').objectStore('kv').put(v,k); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }

  function saveSettings() { try { localStorage.setItem('OctaneIDE2-settings', JSON.stringify(State.settings)); } catch(e){} }
  function loadSettings() { try { const s=localStorage.getItem('OctaneIDE2-settings'); if(s) Object.assign(State.settings, JSON.parse(s)); } catch(e){} }

  async function save() {
    await open();
    if (State.activeFile && State.editor) State.files[State.activeFile] = State.editor.getValue();
    await idbSet('project', { files: State.files, openTabs: State.openTabs, activeFile: State.activeFile });
    saveSettings();
  }

  async function load() {
    await open();
    loadSettings();
    try {
      const p = await idbGet('project');
      if (p && Object.keys(p.files||{}).length > 0) {
        State.files      = p.files;
        State.openTabs   = p.openTabs || Object.keys(p.files);
        State.activeFile = p.activeFile || Object.keys(p.files)[0];
        return true;
      }
    } catch(e) {}
    return false;
  }

  async function saveLib(id, content) { await open(); await idbSet('lib:'+id, content); if (!State.settings.downloadedLibs.includes(id)) { State.settings.downloadedLibs.push(id); saveSettings(); } }
  async function loadLib(id)           { await open(); return await idbGet('lib:'+id); }

  return { save, load, saveSettings, loadSettings, saveLib, loadLib };
})();
