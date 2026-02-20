/**
 * Cloudflare Pages Worker — Wasmer Registry CORS Proxy
 * Proxies /wasmer-graphql → registry.wasmer.io/graphql
 * stripping the user-agent header that causes CORS preflight failures.
 */

const GRAPHQL_TARGET = "https://registry.wasmer.io/v3/graphql";
const CLANG_WEBC_URL  = "https://github.com/pixelkat5/octaneide/releases/download/clang-webc/clang.webc";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── /clang-webc → GitHub Releases proxy (adds CORS headers) ──
    if (url.pathname === "/clang-webc") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders(request) });
      }
      const response = await fetch(CLANG_WEBC_URL, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "follow",
      });
      const responseHeaders = new Headers();
      responseHeaders.set("Content-Type", "application/octet-stream");
      responseHeaders.set("Content-Length", response.headers.get("Content-Length") || "");
      Object.entries(corsHeaders(request)).forEach(([k, v]) => responseHeaders.set(k, v));
      return new Response(response.body, {
        status:  response.status,
        headers: responseHeaders,
      });
    }

    // ── /wasmer-graphql → Wasmer registry proxy ──
    if (url.pathname !== "/wasmer-graphql") {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const response = await fetch(GRAPHQL_TARGET, {
      method:  request.method,
      headers: {
        "content-type": "application/json",
        "host":         "registry.wasmer.io",
      },
      body: request.body,
    });

    const responseHeaders = new Headers(response.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => responseHeaders.set(k, v));

    return new Response(response.body, {
      status:  response.status,
      headers: responseHeaders,
    });
  }
};

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin":  request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age":       "86400",
  };
}
