// ── Preview ───────────────────────────────────────────────────
const Preview = (() => {
  const frame = document.getElementById('preview-frame');

  function build() {
    const htmlFile = Object.keys(State.files).find(f =>
      FileTree.basename(f) === 'index.html' || f === 'index.html' || f.endsWith('.html')
    );
    if (!htmlFile) return `<html><body style="background:#0c0c0f;color:#666680;font-family:monospace;padding:30px;font-size:13px"><p>No .html file found.</p></body></html>`;

    let html = State.files[htmlFile];

    // inline CSS
    html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*\/?>/gi, (_, href) => {
      const f = Object.keys(State.files).find(p => FileTree.basename(p) === href.replace(/^\.\//, '') || p === href.replace(/^\.\//, ''));
      return f ? `<style>${State.files[f]}</style>` : _;
    });

    // inline JS/TS
    html = html.replace(/<script([^>]*)src=["']([^"']+)["'][^>]*><\/script>/gi, (_, attrs, src) => {
      const name = src.replace(/^\.\//, '');
      const f = Object.keys(State.files).find(p => FileTree.basename(p) === name || p === name);
      if (!f) return _;
      let code = State.files[f];
      if (f.endsWith('.ts')) code = stripTypes(code);
      return `<script${attrs.replace(/src=["'][^"']*["']/, '')}>${code}<\/script>`;
    });

    // inject eruda devtools
    html = html.replace('</body>', `<script src="https://cdn.jsdelivr.net/npm/eruda@3/eruda.min.js"><\/script><script>eruda.init();<\/script>\n</body>`);

    return html;
  }

  // Basic TS type stripping
  function stripTypes(code) {
    return code
      .replace(/import\s+type\s+.*?;\n?/g,'')
      .replace(/\binterface\s+\w+[\s\S]*?\n\}/g,'')
      .replace(/\btype\s+\w+\s*=\s*[^;]+;/g,'')
      .replace(/<[A-Z][A-Za-z0-9,\s\[\]|&?]*>/g,'')
      .replace(/(\w+)\s*:\s*[A-Za-z\[\]<>|&?]+(\s*[,)=])/g,'$1$2')
      .replace(/\)\s*:\s*[A-Za-z\[\]<>|&?]+\s*\{/g,') {')
      .replace(/\b(readonly|public|private|protected)\s+/g,'');
  }

  function refresh() { frame.srcdoc = build(); }

  document.getElementById('btn-refresh').onclick = refresh;

  return { refresh };
})();
