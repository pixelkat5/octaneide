"""
polyide — download dependencies for fully offline use
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Downloads and extracts:
  • Monaco Editor 0.44.0  → vendor/monaco/
  • xterm.js 5.3.0        → vendor/xterm/
  • xterm-addon-fit 0.8.0 → vendor/xterm/
  • JetBrains Mono font   → vendor/fonts/
  • Outfit font           → vendor/fonts/

Run once:  python download_deps.py
Then:      python server.py   (works 100% offline)
"""

import urllib.request
import tarfile
import os
import shutil
import sys

VENDOR = os.path.join(os.path.dirname(__file__), "vendor")

PACKAGES = [
    {
        "name":    "Monaco Editor",
        "url":     "https://registry.npmjs.org/monaco-editor/-/monaco-editor-0.44.0.tgz",
        "check":   os.path.join(VENDOR, "monaco", "editor", "editor.main.js"),
        "out":     os.path.join(VENDOR, "monaco"),
        "extract": lambda tar, out: extract_subdir(tar, "package/min/vs", out),
    },
    {
        "name":    "xterm.js",
        "url":     "https://registry.npmjs.org/xterm/-/xterm-5.3.0.tgz",
        "check":   os.path.join(VENDOR, "xterm", "xterm.js"),
        "out":     os.path.join(VENDOR, "xterm"),
        "extract": lambda tar, out: extract_files(tar, {
            "package/lib/xterm.js":  os.path.join(out, "xterm.js"),
            "package/css/xterm.css": os.path.join(out, "xterm.css"),
        }),
    },
    {
        "name":    "xterm-addon-fit",
        "url":     "https://registry.npmjs.org/xterm-addon-fit/-/xterm-addon-fit-0.8.0.tgz",
        "check":   os.path.join(VENDOR, "xterm", "xterm-addon-fit.js"),
        "out":     os.path.join(VENDOR, "xterm"),
        "extract": lambda tar, out: extract_files(tar, {
            "package/lib/xterm-addon-fit.js": os.path.join(out, "xterm-addon-fit.js"),
        }),
    },
    {
        "name":    "JetBrains Mono font",
        "url":     "https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.2.8.tgz",
        "check":   os.path.join(VENDOR, "fonts", "jetbrains-mono-400.woff2"),
        "out":     os.path.join(VENDOR, "fonts"),
        "extract": lambda tar, out: extract_files(tar, {
            "package/files/jetbrains-mono-latin-400-normal.woff2": os.path.join(out, "jetbrains-mono-400.woff2"),
            "package/files/jetbrains-mono-latin-600-normal.woff2": os.path.join(out, "jetbrains-mono-600.woff2"),
        }),
    },
    # Wasmer SDK is installed via npm — see _install_wasmer_sdk() below
    {
        "name":    "Outfit font",
        "url":     "https://registry.npmjs.org/@fontsource/outfit/-/outfit-5.2.6.tgz",
        "check":   os.path.join(VENDOR, "fonts", "outfit-700.woff2"),
        "out":     os.path.join(VENDOR, "fonts"),
        # Note: outfit latin 700/900 only ships as .woff in this package version,
        # so we use the latin-ext woff2 files which cover all latin characters too
        "extract": lambda tar, out: extract_files(tar, {
            "package/files/outfit-latin-ext-700-normal.woff2": os.path.join(out, "outfit-700.woff2"),
            "package/files/outfit-latin-ext-900-normal.woff2": os.path.join(out, "outfit-900.woff2"),
        }),
    },
]


# ── Helpers ───────────────────────────────────────────────────

def extract_subdir(tar, prefix, out_dir):
    """Extract all files under `prefix/` into `out_dir/`, stripping the prefix."""
    os.makedirs(out_dir, exist_ok=True)
    prefix = prefix.rstrip("/") + "/"
    for member in tar.getmembers():
        if not member.name.startswith(prefix):
            continue
        rel = member.name[len(prefix):]
        if not rel:
            continue
        dest = os.path.join(out_dir, rel)
        if member.isdir():
            os.makedirs(dest, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with tar.extractfile(member) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)


def write_raw(data, dest_path):
    """Write raw bytes to dest_path (for non-tarball downloads)."""
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    with open(dest_path, "wb") as f:
        f.write(data)


def extract_files(tar, mapping):
    """Extract specific named files from tar into given destination paths."""
    members = {m.name: m for m in tar.getmembers()}
    for src_name, dest_path in mapping.items():
        if src_name not in members:
            print(f"    ⚠  {src_name} not found in archive")
            continue
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        with tar.extractfile(members[src_name]) as src, open(dest_path, "wb") as dst:
            shutil.copyfileobj(src, dst)


def download(url, label):
    """Download url to a temp file, showing a simple progress indicator."""
    import tempfile
    tmp = tempfile.mktemp(suffix=".tgz")
    print(f"  ↓  {label}", end="", flush=True)

    def reporthook(count, block_size, total_size):
        if total_size > 0:
            pct = min(100, count * block_size * 100 // total_size)
            print(f"\r  ↓  {label}  {pct}%   ", end="", flush=True)

    try:
        urllib.request.urlretrieve(url, tmp, reporthook)
    except Exception as e:
        print(f"\n  ✗  Failed: {e}")
        return None
    print(f"\r  ✓  {label}          ")
    return tmp


def _install_wasmer_sdk():
    """Extract wasm-inlined.mjs from the @wasmer/sdk@0.10.0 npm tarball."""
    SDK_VERSION = "0.10.0"
    dest_js     = os.path.join(VENDOR, "wasmer", "WasmerSDKBundled.js")
    # Force re-install if the file exists but is an older version
    if os.path.isfile(dest_js):
        with open(dest_js, encoding="utf-8", errors="ignore") as f:
            header = f.read(512)
        if f"@version v{SDK_VERSION}" in header:
            print("  ✓  Wasmer SDK (already present, skipping)")
            return True
        print(f"  ↺  Wasmer SDK outdated — upgrading to {SDK_VERSION}…")

    import tempfile, tarfile as tf
    TARBALL_URL = f"https://registry.npmjs.org/@wasmer/sdk/-/sdk-{SDK_VERSION}.tgz"
    # 0.10.0: wasm-inlined.mjs has the wasm baked in — no separate .wasm needed
    TARGET_JS   = "package/dist/wasm-inlined.mjs"

    # Use local tgz if already downloaded (e.g. via npm pack)
    local_tgz = os.path.join(os.path.dirname(__file__), f"wasmer-sdk-{SDK_VERSION}.tgz")
    if os.path.isfile(local_tgz):
        print(f"  ↓  Wasmer SDK — using local {os.path.basename(local_tgz)}")
        tgz_path = local_tgz
        cleanup  = False
    else:
        tgz_path = tempfile.mktemp(suffix=".tgz")
        cleanup  = True
        print("  ↓  Wasmer SDK (~9 MB)", end="", flush=True)
        def reporthook(count, block_size, total_size):
            if total_size > 0:
                pct = min(100, count * block_size * 100 // total_size)
                print(f"\r  ↓  Wasmer SDK (~9 MB)  {pct}%   ", end="", flush=True)
        try:
            urllib.request.urlretrieve(TARBALL_URL, tgz_path, reporthook)
            print()
        except Exception as e:
            print(f"\n  ✗  Failed to download Wasmer SDK: {e}")
            return False

    try:
        os.makedirs(os.path.join(VENDOR, "wasmer"), exist_ok=True)
        with tf.open(tgz_path, "r:gz") as tar:
            with tar.extractfile(tar.getmember(TARGET_JS)) as src:
                js_data = src.read().decode("utf-8")
        # wasm-inlined.mjs has the wasm as a base64 data URL — no URL rewrite needed
        with open(dest_js, "w", encoding="utf-8") as dst:
            dst.write(js_data)
        print(f"  ✓  Wasmer SDK {SDK_VERSION} installed")
        return True
    except Exception as e:
        print(f"  ✗  Failed to extract Wasmer SDK: {e}")
        return False
    finally:
        if cleanup:
            try: os.unlink(tgz_path)
            except: pass


def _download_clang_webc():
    """Download clang/clang webc for offline in-browser compile."""
    dest = os.path.join(VENDOR, "wasmer", "clang.webc")
    if os.path.isfile(dest):
        print("  ✓  clang/clang webc (already present, skipping)")
        return True

    import json, tempfile

    # ── Step 1: find the download URL ────────────────────────────────────────
    # Try GraphQL first, then fall back to known direct URL patterns.

    # clang.webc is hosted on GitHub Releases (too large for git).
    RELEASE_URL = "https://github.com/pixelkat5/octaneide/releases/download/clang-webc/clang.webc"
    print(f"  ↓  clang.webc — downloading from GitHub Releases…")
    tmp = dest + ".tmp.webc"
    try:
        def reporthook(count, block_size, total_size):
            if total_size > 0:
                mb_done = count * block_size / 1_000_000
                mb_total = total_size / 1_000_000
                pct = min(100, int(mb_done * 100 / mb_total))
                print(f"\r  ↓  clang.webc  {mb_done:.1f}/{mb_total:.1f} MB  ({pct}%)   ", end="", flush=True)
            else:
                print(f"\r  ↓  clang.webc  {count * block_size / 1_000_000:.1f} MB…   ", end="", flush=True)
        urllib.request.urlretrieve(RELEASE_URL, tmp, reporthook)
        print()
        os.makedirs(os.path.join(VENDOR, "wasmer"), exist_ok=True)
        shutil.move(tmp, dest)
        size_mb = os.path.getsize(dest) / 1_000_000
        print(f"  ✓  clang.webc saved ({size_mb:.1f} MB)")
        return True
    except Exception as e:
        print(f"\n  ✗  Download failed: {e}")
        print("     Upload clang.webc to GitHub Releases first (see README).")
        if os.path.isfile(tmp):
            try: os.unlink(tmp)
            except: pass
        return False


def _write_fonts_css():
    """Write vendor/fonts/fonts.css referencing the downloaded woff2 files."""
    css_path = os.path.join(VENDOR, "fonts", "fonts.css")
    css = """\
/* JetBrains Mono — served locally by polyide */
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('jetbrains-mono-400.woff2') format('woff2');
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url('jetbrains-mono-600.woff2') format('woff2');
}
/* Outfit */
@font-face {
  font-family: 'Outfit';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url('outfit-700.woff2') format('woff2');
}
@font-face {
  font-family: 'Outfit';
  font-style: normal;
  font-weight: 900;
  font-display: swap;
  src: url('outfit-900.woff2') format('woff2');
}
"""
    with open(css_path, "w") as f:
        f.write(css)
    print("  ✓  vendor/fonts/fonts.css written")


# ── Main ──────────────────────────────────────────────────────

def main():
    print("\n" + "━" * 56)
    print("  polyide — downloading offline dependencies")
    print("━" * 56 + "\n")

    all_ok = True
    for pkg in PACKAGES:
        out = pkg["out"]

        # Skip only if this package's specific output file already exists
        if os.path.isfile(pkg["check"]):
            print(f"  ✓  {pkg['name']} (already present, skipping)")
            continue

        if pkg.get("raw"):
            # Plain file download — no tarball extraction needed
            print(f"  ↓  {pkg['name']}", end="", flush=True)
            try:
                import urllib.request
                with urllib.request.urlopen(pkg["url"]) as r:
                    data = r.read()
                pkg["extract"](data, out)
                print(f"\r  ✓  {pkg['name']}          ")
            except Exception as e:
                print(f"\n  ✗  Failed: {e}")
                all_ok = False
            continue

        tmp = download(pkg["url"], pkg["name"])
        if not tmp:
            all_ok = False
            continue

        try:
            with tarfile.open(tmp, "r:gz") as tar:
                pkg["extract"](tar, out)
        except Exception as e:
            print(f"  ✗  Extract failed: {e}")
            all_ok = False
        finally:
            try:
                os.unlink(tmp)
            except Exception:
                pass

    # Wasmer SDK via npm (separate from tgz packages)
    if not _install_wasmer_sdk():
        all_ok = False

    # clang/clang webc for in-browser compile
    if not _download_clang_webc():
        all_ok = False

    print()
    if all_ok:
        _write_fonts_css()
        print("  ✓  All done! Run  python server.py  to start.\n")
    else:
        print("  ⚠  Some downloads failed. Check your internet connection and retry.\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
