"""
polyide compile server
━━━━━━━━━━━━━━━━━━━━━━
Serves the IDE as static files AND handles C/C++ compilation
via your local wasi-sdk installation.

Usage:
    python3 server.py

Then open http://localhost:8080 in your browser.

First run: it will ask you where wasi-sdk is installed.
Your answer is saved to config.json so you only do it once.
"""

import http.server
import json
import os
import subprocess
import sys
import tempfile
import shutil

# ── Config ────────────────────────────────────────────────────────────────────

CONFIG_FILE = "config.json"

def load_or_create_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)

    print("\n" + "━" * 60)
    print("  polyide — first time setup")
    print("━" * 60)
    print("\nWhere is your wasi-sdk installed?")
    print("Example: C:\\Users\\Greg\\Downloads\\wasi-sdk-30.0-x86_64-windows\\wasi-sdk-30.0-x86_64-windows")
    print()

    while True:
        path = input("wasi-sdk path: ").strip().strip('"')
        clang = os.path.join(path, "bin", "clang.exe" if sys.platform == "win32" else "clang")
        sysroot = os.path.join(path, "share", "wasi-sysroot")

        if os.path.exists(clang) and os.path.exists(sysroot):
            print(f"\n✓ Found clang at: {clang}")
            print(f"✓ Found sysroot at: {sysroot}")
            break
        else:
            print(f"\n✗ Could not find clang.exe or sysroot in that path.")
            print(f"  Looking for: {clang}")
            print(f"  And:         {sysroot}")
            print(f"  Please check the path and try again.\n")

    config = {"wasi_sdk": path, "clang": clang, "sysroot": sysroot}
    with open(CONFIG_FILE, "w") as f:
        json.dump(config, f, indent=2)
    print(f"\n✓ Saved to {CONFIG_FILE} — won't ask again.\n")
    return config


CONFIG = load_or_create_config()

# ── HTTP Handler ──────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def handle_error(self, request, client_address):
        # Suppress noisy Windows connection reset/abort errors (WinError 10053/10054)
        # These are normal — the browser closes connections early all the time
        import traceback, sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError)):
            return
        traceback.print_exc()

    def log_message(self, format, *args):
        # Only log actual /compile POST requests
        try:
            msg = str(args[0]) if args else ""
            if '"/compile"' in msg or msg.strip().startswith("POST /compile"):
                print(f"  [compile] {args[1]} {msg[:60]}")
        except Exception:
            pass

    def end_headers(self):
        # Enable SharedArrayBuffer for interactive stdin (Atomics.wait in Web Worker).
        # Safe now that all assets are self-hosted — no cross-origin resources to block.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_POST(self):
        if self.path == "/compile":
            self._handle_compile()
        elif self.path == "/git":
            self._handle_git()
        else:
            self.send_error(404)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _handle_compile(self):
        length = int(self.headers.get("Content-Length", 0))
        body   = json.loads(self.rfile.read(length))

        files   = body.get("files", {})       # { "main.cpp": "...", "utils.h": "..." }
        std     = body.get("std",   "-std=c++17")
        opt     = body.get("opt",   "-O1")
        flags   = body.get("flags", "-Wall")
        entry   = body.get("entry", None)     # which file is the entry point

        if not files:
            return self._json(400, {"error": "No files provided"})

        # Pick entry point: explicit, or first .cpp/.c file
        if not entry:
            entry = next((f for f in files if f.endswith(".cpp") or f.endswith(".cc")), None)
        if not entry:
            entry = next((f for f in files if f.endswith(".c")), None)
        if not entry:
            return self._json(400, {"error": "No .cpp or .c entry point found"})

        # Write all files to a temp directory
        tmpdir = tempfile.mkdtemp(prefix="polyide_")
        try:
            for name, content in files.items():
                # Support nested paths like "include/utils.h"
                full = os.path.join(tmpdir, name.replace("/", os.sep))
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "w", encoding="utf-8") as f:
                    f.write(content)

            out_wasm = os.path.join(tmpdir, "output.wasm")
            entry_path = os.path.join(tmpdir, entry.replace("/", os.sep))

            is_cpp = entry.endswith(".cpp") or entry.endswith(".cc")
            compiler = CONFIG["clang"] + ("++" if is_cpp else "")
            # clang++ is next to clang in wasi-sdk
            if not os.path.exists(compiler):
                compiler = CONFIG["clang"]  # fallback to clang for C++

            cmd = [
                compiler,
                entry_path,
                f"--target=wasm32-wasi",
                f"--sysroot={CONFIG['sysroot']}",
                f"-I{tmpdir}",          # so #include "utils.h" works
                std,
                opt,
            ]

            # Link C++ standard library for C++ files.
            # wasi-sdk ships libc++ without exception support by default,
            # so we disable exceptions/rtti unless the user explicitly adds -fexceptions.
            if is_cpp:
                user_flags = flags.split() if flags else []
                if "-fexceptions" not in user_flags:
                    cmd += ["-fno-exceptions", "-fno-rtti"]
                cmd += ["-lc++", "-lc++abi"]

            # Add extra flags (split on spaces)
            if flags:
                cmd += [f for f in flags.split() if f]

            cmd += ["-o", out_wasm]

            print(f"  $ {' '.join(os.path.basename(c) if i > 0 else c for i, c in enumerate(cmd))}")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=30
            )

            stderr = (result.stderr or "").strip()
            stdout = (result.stdout or "").strip()
            combined = "\n".join(filter(None, [stdout, stderr]))

            if result.returncode != 0:
                return self._json(200, {
                    "success": False,
                    "exit_code": result.returncode,
                    "stderr": combined,
                })

            # Read compiled wasm and return as base64
            import base64
            with open(out_wasm, "rb") as f:
                wasm_b64 = base64.b64encode(f.read()).decode()

            return self._json(200, {
                "success": True,
                "wasm":    wasm_b64,
                "stderr":  combined,   # may have warnings even on success
                "entry":   entry,
            })

        except subprocess.TimeoutExpired:
            return self._json(200, {"success": False, "stderr": "Compilation timed out (30s limit)"})
        except Exception as e:
            return self._json(500, {"success": False, "stderr": str(e)})
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def _handle_git(self):
        """Run an arbitrary git command in the project directory and return output."""
        import shlex
        length = int(self.headers.get("Content-Length", 0))
        body   = json.loads(self.rfile.read(length))

        args  = body.get("args", [])   # list of strings, e.g. ["commit", "-m", "msg"]
        stdin = body.get("input", "")  # optional stdin string

        if not args or not isinstance(args, list):
            return self._json(400, {"ok": False, "stdout": "", "stderr": "No git args provided", "code": 1})

        # Safety: block a small set of truly destructive args
        blocked = {"--exec", "--upload-pack", "--receive-pack"}
        if any(a in blocked for a in args):
            return self._json(400, {"ok": False, "stdout": "", "stderr": "Blocked argument", "code": 1})

        cmd = ["git"] + args
        project_dir = os.path.dirname(os.path.abspath(__file__))

        try:
            result = subprocess.run(
                cmd,
                cwd=project_dir,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=30,
            )
            return self._json(200, {
                "ok":     result.returncode == 0,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "code":   result.returncode,
            })
        except FileNotFoundError:
            return self._json(200, {"ok": False, "stdout": "", "stderr": "git not found — is Git installed and on your PATH?", "code": 127})
        except subprocess.TimeoutExpired:
            return self._json(200, {"ok": False, "stdout": "", "stderr": "git command timed out (30s)", "code": 1})
        except Exception as e:
            return self._json(500, {"ok": False, "stdout": "", "stderr": str(e), "code": 1})


# ── Start ─────────────────────────────────────────────────────────────────────

PORT = 8080

print(f"\n  polyide running at http://localhost:{PORT}")
print(f"  wasi-sdk: {CONFIG['wasi_sdk']}")
print(f"  Press Ctrl+C to stop\n")

# Warn if vendor folder is missing
if not os.path.isdir("vendor") or not os.path.exists(os.path.join("vendor", "xterm", "xterm.js")):
    print("  ⚠  WARNING: vendor/ folder not found or incomplete.")
    print("     Run  python download_deps.py  first to download offline assets.\n")

httpd = http.server.HTTPServer(("", PORT), Handler)
httpd.serve_forever()