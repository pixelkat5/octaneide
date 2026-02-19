// ── File Tree ─────────────────────────────────────────────────
const FileTree = (() => {
  const el = document.getElementById('file-list');
  const openDirs = new Set();

  const basename = p => p.slice(p.lastIndexOf('/') + 1);
  const dirname  = p => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  const join     = (...a) => a.filter(Boolean).join('/');

  const DEFAULT_FA = 'fa-solid fa-file';
  const SI_BASE    = 'https://cdn.simpleicons.org/';

  const LANG_META = {
    c:       { label:'C',              color:'#a8b9cc', fa:'fa-solid fa-gear',               si:'c',           supported:true,   supportMsg:'Compiled via WASI clang' },
    h:       { label:'C/C++ Header',   color:'#5af0a8', fa:'fa-solid fa-diamond-half-stroke', si:null,          supported:true,   supportMsg:'Header — include in your .cpp or .c' },
    cpp:     { label:'C++',            color:'#9d8fff', fa:'fa-solid fa-gear',               si:'cplusplus',   supported:true,   supportMsg:'Compiled via WASI clang++' },
    cc:      { label:'C++',            color:'#9d8fff', fa:'fa-solid fa-gear',               si:'cplusplus',   supported:true,   supportMsg:'Compiled via WASI clang++' },
    cxx:     { label:'C++',            color:'#9d8fff', fa:'fa-solid fa-gear',               si:'cplusplus',   supported:true,   supportMsg:'Compiled via WASI clang++' },
    hpp:     { label:'C++ Header',     color:'#5af0a8', fa:'fa-solid fa-diamond-half-stroke', si:null,          supported:true,   supportMsg:'Header — include in your .cpp' },
    cs:      { label:'C#',             color:'#9b4f96', fa:'fa-solid fa-hashtag',            si:'csharp',      supported:false,  supportMsg:'C# is not supported yet' },
    py:      { label:'Python',         color:'#3572a5', fa:'fa-brands fa-python',            si:'python',      supported:true,   supportMsg:'Runs via Pyodide (download runtime first)' },
    pyw:     { label:'Python',         color:'#3572a5', fa:'fa-brands fa-python',            si:'python',      supported:true,   supportMsg:'Runs via Pyodide (download runtime first)' },
    ipynb:   { label:'Jupyter',        color:'#f37626', fa:'fa-solid fa-book-open',          si:'jupyter',     supported:false,  supportMsg:'Jupyter notebooks not supported' },
    rs:      { label:'Rust',           color:'#ce4a00', fa:'fa-solid fa-gear',               si:'rust',        supported:false,  supportMsg:'Rust is not supported yet' },
    toml:    { label:'TOML',           color:'#9c4121', fa:'fa-solid fa-file-code',          si:null,          supported:'view', supportMsg:'Config file — view & edit only' },
    rb:      { label:'Ruby',           color:'#cc342d', fa:'fa-solid fa-gem',                si:'ruby',        supported:false,  supportMsg:'Ruby is not supported yet' },
    erb:     { label:'Ruby ERB',       color:'#cc342d', fa:'fa-solid fa-gem',                si:'ruby',        supported:false,  supportMsg:'Ruby ERB not supported' },
    go:      { label:'Go',             color:'#00add8', fa:'fa-solid fa-arrow-right-long',   si:'go',          supported:false,  supportMsg:'Go is not supported yet' },
    html:    { label:'HTML',           color:'#e34c26', fa:'fa-solid fa-globe',              si:'html5',       supported:true,   supportMsg:'Rendered in live preview panel' },
    htm:     { label:'HTML',           color:'#e34c26', fa:'fa-solid fa-globe',              si:'html5',       supported:true,   supportMsg:'Rendered in live preview panel' },
    css:     { label:'CSS',            color:'#264de4', fa:'fa-brands fa-css3-alt',          si:'css3',        supported:true,   supportMsg:'Injected into live preview' },
    scss:    { label:'SCSS',           color:'#cc6699', fa:'fa-brands fa-sass',              si:'sass',        supported:'view', supportMsg:'SCSS — no compiler, view only' },
    sass:    { label:'Sass',           color:'#cc6699', fa:'fa-brands fa-sass',              si:'sass',        supported:'view', supportMsg:'Sass — no compiler, view only' },
    less:    { label:'Less',           color:'#1d365d', fa:'fa-solid fa-file-code',          si:'less',        supported:'view', supportMsg:'Less — view & edit only' },
    js:      { label:'JavaScript',     color:'#f7df1e', fa:'fa-brands fa-square-js',         si:'javascript',  supported:true,   supportMsg:'Executed in browser sandbox' },
    mjs:     { label:'JS Module',      color:'#f7df1e', fa:'fa-brands fa-square-js',         si:'javascript',  supported:true,   supportMsg:'Executed in browser sandbox' },
    ts:      { label:'TypeScript',     color:'#3178c6', fa:'fa-solid fa-t',                  si:'typescript',  supported:true,   supportMsg:'Transpiled via Monaco TS worker' },
    tsx:     { label:'TypeScript JSX', color:'#3178c6', fa:'fa-solid fa-t',                  si:'typescript',  supported:true,   supportMsg:'Transpiled via Monaco TS worker' },
    jsx:     { label:'React JSX',      color:'#61dafb', fa:'fa-brands fa-react',             si:'react',       supported:true,   supportMsg:'Executed in browser sandbox' },
    vue:     { label:'Vue',            color:'#42b883', fa:'fa-brands fa-vuejs',             si:'vuedotjs',    supported:'view', supportMsg:'Vue SFCs — view & edit only' },
    svelte:  { label:'Svelte',         color:'#ff3e00', fa:'fa-solid fa-s',                  si:'svelte',      supported:'view', supportMsg:'Svelte — view & edit only' },
    swift:   { label:'Swift',          color:'#f05138', fa:'fa-brands fa-swift',             si:'swift',       supported:false,  supportMsg:'Swift is not supported yet' },
    php:     { label:'PHP',            color:'#8892bf', fa:'fa-brands fa-php',               si:'php',         supported:false,  supportMsg:'PHP is not supported yet' },
    lua:     { label:'Lua',            color:'#00007c', fa:'fa-solid fa-moon',               si:'lua',         supported:false,  supportMsg:'Lua is not supported yet' },
    java:    { label:'Java',           color:'#ed8b00', fa:'fa-brands fa-java',              si:'openjdk',     supported:false,  supportMsg:'Java is not supported yet' },
    groovy:  { label:'Groovy',         color:'#4298b8', fa:'fa-solid fa-g',                  si:'apachegroovy',supported:false,  supportMsg:'Groovy is not supported yet' },
    scala:   { label:'Scala',          color:'#de3423', fa:'fa-solid fa-s',                  si:'scala',       supported:false,  supportMsg:'Scala is not supported yet' },
    r:       { label:'R',              color:'#276dc3', fa:'fa-solid fa-chart-simple',       si:'r',           supported:false,  supportMsg:'R is not supported yet' },
    rmd:     { label:'R Markdown',     color:'#276dc3', fa:'fa-solid fa-chart-simple',       si:'r',           supported:false,  supportMsg:'R Markdown not supported' },
    sql:     { label:'SQL',            color:'#e48e00', fa:'fa-solid fa-database',           si:'mysql',       supported:'view', supportMsg:'View & edit only — not executed' },
    sqlite:  { label:'SQLite',         color:'#003b57', fa:'fa-solid fa-database',           si:'sqlite',      supported:'view', supportMsg:'View & edit only — not executed' },
    kt:      { label:'Kotlin',         color:'#7f52ff', fa:'fa-solid fa-k',                  si:'kotlin',      supported:false,  supportMsg:'Kotlin is not supported yet' },
    kts:     { label:'Kotlin Script',  color:'#7f52ff', fa:'fa-solid fa-k',                  si:'kotlin',      supported:false,  supportMsg:'Kotlin Script not supported yet' },
    ex:      { label:'Elixir',         color:'#6e4a7e', fa:'fa-solid fa-droplet',            si:'elixir',      supported:false,  supportMsg:'Elixir is not supported yet' },
    exs:     { label:'Elixir Script',  color:'#6e4a7e', fa:'fa-solid fa-droplet',            si:'elixir',      supported:false,  supportMsg:'Elixir is not supported yet' },
    heex:    { label:'HEEx Template',  color:'#6e4a7e', fa:'fa-solid fa-droplet',            si:'elixir',      supported:false,  supportMsg:'Phoenix HEEx not supported' },
    sas:     { label:'SAS',            color:'#00adef', fa:'fa-solid fa-chart-bar',          si:null,          supported:false,  supportMsg:'SAS is not supported yet' },
    sh:      { label:'Shell',          color:'#4eaa25', fa:'fa-solid fa-terminal',           si:'gnubash',     supported:false,  supportMsg:'Shell scripts are not executed' },
    bash:    { label:'Bash',           color:'#4eaa25', fa:'fa-solid fa-terminal',           si:'gnubash',     supported:false,  supportMsg:'Bash scripts are not executed' },
    zsh:     { label:'Zsh',            color:'#4eaa25', fa:'fa-solid fa-terminal',           si:'zsh',         supported:false,  supportMsg:'Zsh scripts are not executed' },
    ps1:     { label:'PowerShell',     color:'#5391fe', fa:'fa-solid fa-terminal',           si:'powershell',  supported:false,  supportMsg:'PowerShell not supported' },
    json:    { label:'JSON',           color:'#cbcb41', fa:'fa-solid fa-brackets-curly',     si:'json',        supported:'view', supportMsg:'View & edit only — not executed' },
    yaml:    { label:'YAML',           color:'#cb171e', fa:'fa-solid fa-file-code',          si:'yaml',        supported:'view', supportMsg:'View & edit only — not executed' },
    yml:     { label:'YAML',           color:'#cb171e', fa:'fa-solid fa-file-code',          si:'yaml',        supported:'view', supportMsg:'View & edit only — not executed' },
    xml:     { label:'XML',            color:'#f0a030', fa:'fa-solid fa-code',               si:null,          supported:'view', supportMsg:'View & edit only — not executed' },
    csv:     { label:'CSV',            color:'#3ddd8a', fa:'fa-solid fa-table',              si:null,          supported:'view', supportMsg:'View & edit only — not executed' },
    env:     { label:'.env',           color:'#ecd53f', fa:'fa-solid fa-key',                si:null,          supported:'view', supportMsg:'Environment variables — view & edit only' },
    md:      { label:'Markdown',       color:'#a889ff', fa:'fa-solid fa-book',               si:'markdown',    supported:'view', supportMsg:'View & edit only — not executed' },
    mdx:     { label:'MDX',            color:'#fcb32c', fa:'fa-solid fa-book',               si:'mdx',         supported:'view', supportMsg:'View & edit only — not executed' },
    tex:     { label:'LaTeX',          color:'#008080', fa:'fa-solid fa-subscript',          si:'latex',       supported:false,  supportMsg:'LaTeX is not supported yet' },
    dart:    { label:'Dart',           color:'#00b4ab', fa:'fa-solid fa-d',                  si:'dart',        supported:false,  supportMsg:'Dart is not supported yet' },
    nim:     { label:'Nim',            color:'#ffe953', fa:'fa-solid fa-n',                  si:'nim',         supported:false,  supportMsg:'Nim is not supported yet' },
    zig:     { label:'Zig',            color:'#f7a41d', fa:'fa-solid fa-z',                  si:'zig',         supported:false,  supportMsg:'Zig is not supported yet' },
    hs:      { label:'Haskell',        color:'#5d4f85', fa:'fa-solid fa-h',                  si:'haskell',     supported:false,  supportMsg:'Haskell is not supported yet' },
    ml:      { label:'OCaml',          color:'#ec6813', fa:'fa-solid fa-o',                  si:'ocaml',       supported:false,  supportMsg:'OCaml is not supported yet' },
    fs:      { label:'F#',             color:'#378bba', fa:'fa-solid fa-f',                  si:'fsharp',      supported:false,  supportMsg:'F# is not supported yet' },
    clj:     { label:'Clojure',        color:'#5881d8', fa:'fa-solid fa-c',                  si:'clojure',     supported:false,  supportMsg:'Clojure is not supported yet' },
    elm:     { label:'Elm',            color:'#1293d8', fa:'fa-solid fa-e',                  si:'elm',         supported:false,  supportMsg:'Elm is not supported yet' },
    erl:     { label:'Erlang',         color:'#a90533', fa:'fa-solid fa-e',                  si:'erlang',      supported:false,  supportMsg:'Erlang is not supported yet' },
    jl:      { label:'Julia',          color:'#9558b2', fa:'fa-solid fa-j',                  si:'julia',       supported:false,  supportMsg:'Julia is not supported yet' },
    pl:      { label:'Perl',           color:'#0298c3', fa:'fa-solid fa-p',                  si:'perl',        supported:false,  supportMsg:'Perl is not supported yet' },
    cr:      { label:'Crystal',        color:'#000000', fa:'fa-solid fa-gem',                si:'crystal',     supported:false,  supportMsg:'Crystal is not supported yet' },
    d:       { label:'D',              color:'#ba595e', fa:'fa-solid fa-d',                  si:'d',           supported:false,  supportMsg:'D is not supported yet' },
    fortran: { label:'Fortran',        color:'#4d41b1', fa:'fa-solid fa-f',                  si:'fortran',     supported:false,  supportMsg:'Fortran is not supported yet' },
    f90:     { label:'Fortran',        color:'#4d41b1', fa:'fa-solid fa-f',                  si:'fortran',     supported:false,  supportMsg:'Fortran is not supported yet' },
    rkt:     { label:'Racket',         color:'#9f1d20', fa:'fa-solid fa-r',                  si:'racket',      supported:false,  supportMsg:'Racket is not supported yet' },
    lisp:    { label:'Lisp',           color:'#3fb68b', fa:'fa-solid fa-l',                  si:null,          supported:false,  supportMsg:'Lisp is not supported yet' },
    jl2:     { label:'Julia',          color:'#9558b2', fa:'fa-solid fa-j',                  si:'julia',       supported:false,  supportMsg:'Julia is not supported yet' },
    asm:     { label:'Assembly',       color:'#6e4c13', fa:'fa-solid fa-microchip',          si:null,          supported:false,  supportMsg:'Assembly not supported' },
    wasm:    { label:'WebAssembly',    color:'#654ff0', fa:'fa-solid fa-w',                  si:'webassembly', supported:'view', supportMsg:'Binary WASM — view only' },
    glsl:    { label:'GLSL',           color:'#5586a4', fa:'fa-solid fa-cubes',              si:null,          supported:false,  supportMsg:'Shader language — not supported' },
    tf:      { label:'Terraform',      color:'#7b42bc', fa:'fa-solid fa-cloud',              si:'terraform',   supported:'view', supportMsg:'View & edit only' },
    dockerfile:{ label:'Dockerfile',   color:'#2496ed', fa:'fa-brands fa-docker',            si:'docker',      supported:'view', supportMsg:'View & edit only' },
    makefile:{ label:'Makefile',       color:'#427819', fa:'fa-solid fa-hammer',             si:'cmake',       supported:'view', supportMsg:'View & edit only' },
    graphql: { label:'GraphQL',        color:'#e10098', fa:'fa-solid fa-diagram-project',    si:'graphql',     supported:'view', supportMsg:'View & edit only' },
    gql:     { label:'GraphQL',        color:'#e10098', fa:'fa-solid fa-diagram-project',    si:'graphql',     supported:'view', supportMsg:'View & edit only' },
    proto:   { label:'Protobuf',       color:'#d8d8e8', fa:'fa-solid fa-file-code',          si:null,          supported:'view', supportMsg:'View & edit only' },
    txt:     { label:'Plain Text',     color:'#888898', fa:'fa-solid fa-file-lines',         si:null,          supported:'view', supportMsg:'Plain text — view & edit only' },
    log:     { label:'Log',            color:'#666680', fa:'fa-solid fa-scroll',             si:null,          supported:'view', supportMsg:'Log file — view only' },
    gitignore:{ label:'.gitignore',    color:'#f54d27', fa:'fa-brands fa-git-alt',           si:'git',         supported:'view', supportMsg:'Git config — view & edit only' },
    svg:     { label:'SVG',            color:'#ffb13b', fa:'fa-solid fa-image',              si:null,          supported:'view', supportMsg:'Vector image — renders in preview' },
    lock:    { label:'Lock File',      color:'#666680', fa:'fa-solid fa-lock',               si:null,          supported:'view', supportMsg:'Package lock — view only' },
  };

  function getLangMeta(name) {
    const lname = name.toLowerCase();
    if (lname === 'dockerfile') return LANG_META['dockerfile'];
    if (lname === 'makefile')   return LANG_META['makefile'];
    if (lname === '.gitignore') return LANG_META['gitignore'];
    const dot = name.lastIndexOf('.');
    if (dot < 0) return null;
    return LANG_META[name.slice(dot + 1).toLowerCase()] || null;
  }

  function icon(name) {
    const m = getLangMeta(name);
    if (!m) return `<i class="${DEFAULT_FA} lang-icon" style="color:var(--dim)"></i>`;
    return `<i class="${m.fa} lang-icon" style="color:${m.color}"></i>`;
  }

  function buildTree() {
    const root = { dirs:{}, files:[] };
    for (const path of Object.keys(State.files)) {
      const parts = path.split('/'); let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs[parts[i]]) node.dirs[parts[i]] = { dirs:{}, files:[] };
        node = node.dirs[parts[i]];
      }
      node.files.push({ name: parts[parts.length-1], path });
    }
    return root;
  }

  let dragSrc = null;
  function makeDraggableFile(div, path) {
    div.draggable = true;
    div.addEventListener('dragstart', e => { dragSrc = path; e.dataTransfer.effectAllowed = 'move'; div.style.opacity = '0.5'; });
    div.addEventListener('dragend', () => { dragSrc = null; div.style.opacity = ''; document.querySelectorAll('.td-head.drag-over').forEach(d => d.classList.remove('drag-over')); });
  }
  function makeDropTarget(head, targetDir) {
    head.addEventListener('dragover', e => { if (!dragSrc) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; head.classList.add('drag-over'); });
    head.addEventListener('dragleave', () => head.classList.remove('drag-over'));
    head.addEventListener('drop', e => {
      e.preventDefault(); head.classList.remove('drag-over'); if (!dragSrc) return;
      const newPath = join(targetDir, basename(dragSrc));
      if (newPath === dragSrc) return;
      if (State.files[newPath] !== undefined) { Terminal.print(`✗ "${newPath}" already exists.`, 'stderr'); return; }
      State.files[newPath] = State.files[dragSrc]; delete State.files[dragSrc];
      if (State.editorModels[dragSrc]) { State.editorModels[dragSrc].dispose(); delete State.editorModels[dragSrc]; }
      State.openTabs = State.openTabs.map(t => t === dragSrc ? newPath : t);
      if (State.activeFile === dragSrc) State.activeFile = newPath;
      openDirs.add(targetDir); dragSrc = null; render(); Editor.renderTabs();
      if (State.activeFile === newPath) Editor.open(newPath);
      Persist.save();
    });
  }
  el.addEventListener('dragover', e => { if (!dragSrc) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  el.addEventListener('drop', e => {
    e.preventDefault(); if (!dragSrc || e.target !== el) return;
    const newPath = basename(dragSrc); if (newPath === dragSrc) return;
    if (State.files[newPath] !== undefined) { Terminal.print(`✗ "${newPath}" already exists.`, 'stderr'); return; }
    State.files[newPath] = State.files[dragSrc]; delete State.files[dragSrc];
    if (State.editorModels[dragSrc]) { State.editorModels[dragSrc].dispose(); delete State.editorModels[dragSrc]; }
    State.openTabs = State.openTabs.map(t => t === dragSrc ? newPath : t);
    if (State.activeFile === dragSrc) State.activeFile = newPath;
    dragSrc = null; render(); Editor.renderTabs(); Persist.save();
  });

  function renderNode(node, prefix, container) {
    for (const [name, child] of Object.entries(node.dirs).sort()) {
      const full = join(prefix, name); const isOpen = openDirs.has(full);
      const wrap = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'td-head' + (isOpen ? ' open' : '');
      head.innerHTML = `<span class="chev"><i class="fa-solid fa-chevron-right"></i></span><span class="folder-icon"><i class="fa-solid fa-${isOpen?'folder-open':'folder'}"></i></span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${name}</span><span class="td-x" data-deldir="${full}"><i class="fa-solid fa-xmark"></i></span>`;
      head.addEventListener('click', e => {
        if (e.target.closest('[data-deldir]')) { delDir(e.target.closest('[data-deldir]').dataset.deldir); return; }
        if (openDirs.has(full)) {
          openDirs.delete(full); head.classList.remove('open'); kids.classList.add('closed'); kids.innerHTML = '';
          head.querySelector('.folder-icon i').className = 'fa-solid fa-folder';
        } else {
          openDirs.add(full); head.classList.add('open'); kids.classList.remove('closed'); kids.innerHTML = '';
          head.querySelector('.folder-icon i').className = 'fa-solid fa-folder-open';
          renderNode(child, full, kids);
        }
      });
      makeDropTarget(head, full);
      const kids = document.createElement('div');
      kids.className = 'td-children' + (isOpen ? '' : ' closed');
      wrap.appendChild(head); wrap.appendChild(kids); container.appendChild(wrap);
      if (isOpen) renderNode(child, full, kids);
    }
    for (const { name, path } of [...node.files].sort((a,b) => a.name.localeCompare(b.name))) {
      if (name === '.gitkeep') continue;
      const div = document.createElement('div');
      div.className = 'tf' + (path === State.activeFile ? ' active' : '');
      div.innerHTML = `<span class="file-icon">${icon(name)}</span><span class="tf-name">${name}</span><span class="tf-x" data-del="${path}"><i class="fa-solid fa-xmark"></i></span>`;
      div.addEventListener('click', e => {
        if (e.target.closest('[data-del]')) { delFile(e.target.closest('[data-del]').dataset.del); return; }
        Editor.open(path);
      });
      makeDraggableFile(div, path); container.appendChild(div);
    }
  }

  function render() { el.innerHTML = ''; renderNode(buildTree(), '', el); }

  function createFile(path, content) {
    if (State.files[path] !== undefined) { Editor.open(path); return; }
    State.files[path] = (content !== undefined) ? content : defaultContent(basename(path));
    path.split('/').slice(0,-1).reduce((acc,p)=>{ const full=acc?acc+'/'+p:p; openDirs.add(full); return full; },'');
    render(); Editor.open(path); Persist.save();
  }
  function delFile(path) {
    const rest = Object.keys(State.files).filter(f => f !== path);
    if (rest.length === 0) return;
    if (State.editorModels[path]) { State.editorModels[path].dispose(); delete State.editorModels[path]; }
    delete State.files[path];
    State.openTabs = State.openTabs.filter(t => t !== path);
    if (State.activeFile === path) Editor.open(rest[0]);
    else { render(); Editor.renderTabs(); }
    Persist.save();
  }
  function delDir(dirPath) {
    const toDelete = Object.keys(State.files).filter(f => f.startsWith(dirPath+'/') || f === dirPath);
    const real = toDelete.filter(f => !f.endsWith('.gitkeep'));
    if (real.length && !confirm(`Delete "${dirPath}" and all its contents?`)) return;
    for (const p of toDelete) {
      if (State.editorModels[p]) { State.editorModels[p].dispose(); delete State.editorModels[p]; }
      delete State.files[p]; State.openTabs = State.openTabs.filter(t => t !== p);
    }
    openDirs.delete(dirPath);
    const remaining = Object.keys(State.files);
    if (!State.files[State.activeFile]) Editor.open(remaining[0]||null);
    else { render(); Editor.renderTabs(); }
    Persist.save();
  }

  // ── Modal ──────────────────────────────────────────────────
  document.getElementById('btn-new-file').onclick   = () => showModal('file', '');
  document.getElementById('btn-new-folder').onclick = () => showModal('folder', '');
  document.getElementById('btn-modal-ok').onclick     = confirmModal;
  document.getElementById('btn-modal-cancel').onclick = closeModal;
  document.getElementById('modal-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { if (!document.getElementById('btn-modal-ok').disabled) confirmModal(); }
    if (e.key === 'Escape') closeModal();
  });
  document.getElementById('modal-input').addEventListener('input', e => updateModalState(e.target.value.trim()));
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  function setModalColor(hex) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    document.getElementById('modal-glow').style.background =
      `radial-gradient(ellipse, rgba(${r},${g},${b},0.3) 0%, transparent 70%)`;
    document.getElementById('modal').style.setProperty('--input-glow',  `rgba(${r},${g},${b},0.55)`);
    document.getElementById('modal').style.setProperty('--input-shadow',`rgba(${r},${g},${b},0.14)`);
    const ring = document.getElementById('modal-icon-ring');
    ring.style.background = `rgba(${r},${g},${b},0.12)`;
    ring.style.borderColor = `rgba(${r},${g},${b},0.4)`;
    ring.style.boxShadow = `inset 0 1px 0 rgba(255,255,255,.1), 0 8px 24px rgba(0,0,0,.4), 0 0 28px rgba(${r},${g},${b},0.22)`;
  }

  function resetModalColor() {
    document.getElementById('modal-glow').style.background =
      'radial-gradient(ellipse, rgba(124,106,255,0.15) 0%, transparent 70%)';
    document.getElementById('modal').style.setProperty('--input-glow',  'rgba(124,106,255,.55)');
    document.getElementById('modal').style.setProperty('--input-shadow','rgba(124,106,255,.12)');
    const ring = document.getElementById('modal-icon-ring');
    ring.style.background = ''; ring.style.borderColor = ''; ring.style.boxShadow = '';
  }

  function animIcon(iconEl, newClass, newColor) {
    iconEl.style.transform = 'scale(0.3) rotate(-15deg)';
    iconEl.style.opacity = '0';
    setTimeout(() => {
      iconEl.className = newClass; iconEl.style.color = newColor;
      iconEl.style.transform = 'scale(1) rotate(0deg)'; iconEl.style.opacity = '1';
    }, 110);
  }

  function updateModalState(val) {
    const isFile  = State.modalMode === 'file';
    const okBtn   = document.getElementById('btn-modal-ok');
    const iconEl  = document.getElementById('modal-icon');
    const nameEl  = document.getElementById('modal-lang-name');
    const extEl   = document.getElementById('modal-lang-ext');
    const badge   = document.getElementById('modal-support-badge');
    const infoBar = document.getElementById('modal-info-bar');
    const siImg   = document.getElementById('modal-si-img');
    const infoMsg = document.getElementById('modal-info-msg');

    okBtn.disabled = val.length === 0;

    if (!isFile) {
      animIcon(iconEl, 'fa-solid fa-folder', '#f0a030');
      nameEl.textContent = 'New Folder'; nameEl.style.color = '#f0a030';
      extEl.textContent  = 'directory';
      badge.className = 'hidden'; infoBar.classList.add('hidden');
      setModalColor('#f0a030'); return;
    }

    const meta = getLangMeta(val);
    if (!meta) {
      animIcon(iconEl, DEFAULT_FA, 'var(--dim)');
      nameEl.textContent = val.length > 0 ? 'Unknown type' : '—';
      nameEl.style.color = 'var(--dim)';
      const dot = val.lastIndexOf('.');
      extEl.textContent = dot >= 0 ? val.slice(dot) + ' · unrecognized' : 'type a filename with an extension';
      badge.className = 'hidden'; infoBar.classList.add('hidden');
      resetModalColor(); return;
    }

    animIcon(iconEl, meta.fa, meta.color);
    nameEl.textContent = meta.label; nameEl.style.color = meta.color;
    const dot = val.lastIndexOf('.');
    extEl.textContent = dot >= 0 ? val.slice(dot) + ' file' : '';

    badge.classList.remove('hidden','sup-yes','sup-view','sup-no');
    if      (meta.supported === true)  { badge.className = 'sup-yes';  badge.textContent = '✓ supported'; }
    else if (meta.supported === 'view'){ badge.className = 'sup-view'; badge.textContent = '◉ view only'; }
    else                               { badge.className = 'sup-no';   badge.textContent = '✗ unsupported'; }

    infoMsg.textContent = meta.supportMsg;
    if (meta.si) {
      siImg.src = `${SI_BASE}${meta.si}/${meta.color.replace('#','')}`;
      siImg.alt = meta.label; siImg.classList.remove('hidden');
      siImg.onerror = () => siImg.classList.add('hidden');
    } else { siImg.classList.add('hidden'); }
    infoBar.classList.remove('hidden');

    setModalColor(meta.color);
  }

  function showModal(mode, parent) {
    State.modalMode = mode; State.modalParentPath = parent;
    const iconEl  = document.getElementById('modal-icon');
    const nameEl  = document.getElementById('modal-lang-name');
    const extEl   = document.getElementById('modal-lang-ext');
    const input   = document.getElementById('modal-input');

    input.value = '';
    input.placeholder = mode === 'file' ? 'filename.ext' : 'folder-name';
    iconEl.className = mode === 'file' ? DEFAULT_FA : 'fa-solid fa-folder';
    iconEl.style.color = mode === 'file' ? 'var(--dim)' : '#f0a030';
    iconEl.style.transform = ''; iconEl.style.opacity = '';
    nameEl.textContent = mode === 'file' ? '—' : 'New Folder';
    nameEl.style.color = mode === 'file' ? 'var(--dim)' : '#f0a030';
    extEl.textContent  = mode === 'file' ? 'type a filename with an extension' : 'directory';
    document.getElementById('modal-support-badge').className = 'hidden';
    document.getElementById('modal-info-bar').classList.add('hidden');
    document.getElementById('btn-modal-ok').disabled = true;
    resetModalColor();
    document.getElementById('modal-overlay').classList.remove('hidden');
    setTimeout(() => input.focus(), 80);
  }

  function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

  function confirmModal() {
    const name = document.getElementById('modal-input').value.trim();
    if (!name) return; closeModal();
    const path = State.modalParentPath ? State.modalParentPath+'/'+name : name;
    if (State.modalMode === 'folder') createFile(path+'/.gitkeep', '');
    else createFile(path);
  }

  return { render, createFile, delFile, basename, dirname, join };
})();
