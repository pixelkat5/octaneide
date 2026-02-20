/**
 * Cloudflare Pages Worker — Wasmer Registry CORS Proxy
 * 
 * Place this file at the root of your repo as _worker.js
 * Cloudflare Pages will automatically deploy it as a Worker.
 * 
 * Proxies /wasmer-graphql → registry.wasmer.io/graphql
 * stripping the user-agent header that causes CORS failures.
 */

const TARGET = "https://registry.wasmer.io/graphql";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Pass through everything except our proxy endpoint
    if (url.pathname !== "/wasmer-graphql") {
      return env.ASSETS.fetch(request);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Strip user-agent, forward to real registry
    const headers = new Headers(request.headers);
    headers.delete("user-agent");
    headers.delete("User-Agent");
    headers.set("host", "registry.wasmer.io");

    const response = await fetch(new Request(TARGET, {
      method:  request.method,
      headers: headers,
      body:    request.method !== "GET" ? request.body : undefined,
    }));

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
