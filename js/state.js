// ── State ─────────────────────────────────────────────────────
const State = {
  files:      {},       // path → content
  openTabs:   [],       // open file paths
  activeFile: null,
  editor:     null,
  editorModels: {},
  term:       null,
  fitAddon:   null,
  activePanel: 'terminal',
  liveReloadTimer: null,
  modalMode: 'file',
  modalParentPath: '',
  settings: {
    fontSize:    13,
    theme:       'vs-dark',
    std:         '-std=c++17',
    opt:         '-O1',
    flags:       '-Wall',
    liveReload:  true,
    reloadDelay: 600,
    cppBackend:       'browsercc',
    interactiveStdin: true,
    wordWrap:         false,
    downloadedLibs:     [],
    downloadedRuntimes: [],
    showDevErrors: false,
  },
};

// ── Language detection from extension ────────────────────────
function detectLang(path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const map = {
    '.cpp':'cpp','.cc':'cpp','.c':'c','.h':'cpp','.hpp':'cpp',
    '.html':'web','.htm':'web',
    '.css':'css','.js':'js','.ts':'ts',
    '.py':'python','.cs':'csharp',
    '.json':'json','.md':'markdown',
  };
  return map[ext] || 'text';
}

// Monaco language id from our lang
function monacoLang(path) {
  const l = detectLang(path);
  const map = {
    cpp:'cpp', c:'cpp', web:'html', css:'css',
    js:'javascript', ts:'typescript', python:'python',
    csharp:'csharp', json:'json', markdown:'markdown', text:'plaintext',
  };
  return map[l] || 'plaintext';
}

// Human-readable label shown next to Run button
function langLabel(path) {
  const l = detectLang(path);
  const labels = {
    cpp:'C++', c:'C', web:'HTML', css:'CSS', js:'JavaScript',
    ts:'TypeScript', python:'Python', csharp:'C#', json:'JSON',
    markdown:'Markdown', text:'Text',
  };
  return labels[l] || '';
}

// Default file contents
function defaultContent(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const t = {
    '.cpp': '#include <iostream>\n\nint main() {\n    std::cout << "Hello, World!" << std::endl;\n    return 0;\n}\n',
    '.c':   '#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}\n',
    '.h':   '#pragma once\n\n',
    '.hpp': '#pragma once\n\n',
    '.py':  'def main():\n    print("Hello, World!")\n\nif __name__ == "__main__":\n    main()\n',
    '.html':'<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"/><title>App</title><link rel="stylesheet" href="style.css"/></head>\n<body>\n\n<script src="app.js"><\/script>\n</body>\n</html>\n',
    '.css': '/* styles */\nbody {\n    font-family: system-ui, sans-serif;\n}\n',
    '.js':  '// app.js\nconsole.log("Hello!");\n',
    '.ts':  '// main.ts\nconst greet = (name: string): string => `Hello, ${name}!`;\nconsole.log(greet("World"));\n',
    '.cs':  'using System;\n\nclass Program {\n    static void Main() {\n        Console.WriteLine("Hello, World!");\n    }\n}\n',
    '.json':'{\n  \n}\n',
  };
  return t[ext] || '';
}

// Libraries available for download
const LIBRARIES = [
  { id:'nlohmann-json', name:'nlohmann/json', desc:'JSON for Modern C++', size:'~1.5MB', url:'https://github.com/nlohmann/json/releases/latest/download/json.hpp', path:'nlohmann/json.hpp' },
  { id:'fmt',          name:'{fmt}',          desc:'Fast formatting library', size:'~300KB', url:'https://raw.githubusercontent.com/fmtlib/fmt/master/include/fmt/format.h', path:'fmt/format.h' },
];

// Python packages installable via micropip (Pyodide)
const PYTHON_PACKAGES = [
  { id:'py-requests',        name:'requests',         desc:'HTTP requests library — fetch URLs, APIs, web pages', size:'~120KB', pkg:'requests' },
  { id:'py-numpy',           name:'numpy',             desc:'Numerical computing — arrays, math, linear algebra',  size:'~7MB',  pkg:'numpy' },
  { id:'py-pandas',          name:'pandas',            desc:'Data analysis — DataFrames, CSV/JSON processing',     size:'~12MB', pkg:'pandas' },
  { id:'py-matplotlib',      name:'matplotlib',        desc:'2D plotting and data visualization',                  size:'~10MB', pkg:'matplotlib' },
  { id:'py-pygame',          name:'pygame-ce',         desc:'Game development — sprites, audio, keyboard input',   size:'~4MB',  pkg:'pygame-ce' },
  { id:'py-beautifulsoup',   name:'beautifulsoup4',    desc:'HTML/XML parsing and web scraping',                   size:'~200KB',pkg:'beautifulsoup4' },
  { id:'py-pillow',          name:'Pillow',            desc:'Image processing — open, edit, and save images',      size:'~3MB',  pkg:'Pillow' },
  { id:'py-scipy',           name:'scipy',             desc:'Scientific computing — stats, signal processing',     size:'~25MB', pkg:'scipy' },
  { id:'py-sympy',           name:'sympy',             desc:'Symbolic mathematics and algebra',                    size:'~5MB',  pkg:'sympy' },
  { id:'py-internetarchive', name:'internetarchive',   desc:'Internet Archive CLI & API — search, download items', size:'~500KB',pkg:'internetarchive' },
  { id:'py-twitchio',        name:'twitchio',          desc:'Twitch IRC & API wrapper for chat bots',              size:'~300KB',pkg:'twitchio' },
  { id:'py-pydantic',        name:'pydantic',          desc:'Data validation using Python type hints',             size:'~2MB',  pkg:'pydantic' },
  { id:'py-httpx',           name:'httpx',             desc:'Modern async HTTP client with requests-like API',     size:'~200KB',pkg:'httpx' },
  { id:'py-arrow',           name:'arrow',             desc:'Better dates & times for Python',                     size:'~200KB',pkg:'arrow' },
  { id:'py-rich',            name:'rich',              desc:'Rich text and beautiful formatting in the terminal',  size:'~500KB',pkg:'rich' },
];

const RUNTIMES = [
  { id:'python', name:'Python (Pyodide)', desc:'CPython 3.12 in WASM — enables .py files', size:'~11MB', url:'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js' },
  { id:'cpp-wasmer', name:'C++ Compiler (Wasmer)', desc:'Offline clang in WASM — compile C/C++ without internet', size:'~100MB', url:null },
];
