/**
 * Cloudflare Pages Worker — Wasmer Registry CORS Proxy
 * Proxies /wasmer-graphql → registry.wasmer.io/graphql
 * stripping the user-agent header that causes CORS preflight failures.
 */

const TARGET = "https://registry.wasmer.io/graphql";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Pass everything else to static assets
    if (url.pathname !== "/wasmer-graphql") {
      return env.ASSETS.fetch(request);
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Read body as text so we can forward it cleanly
    const body = request.method !== "GET" && request.method !== "HEAD"
      ? await request.text()
      : undefined;

    // Build clean headers — strip user-agent, set correct host and content-type
    const headers = new Headers();
    headers.set("host", "registry.wasmer.io");
    headers.set("content-type", request.headers.get("content-type") || "application/json");
    const auth = request.headers.get("authorization");
    if (auth) headers.set("authorization", auth);

    const response = await fetch(TARGET, {
      method:  request.method,
      headers: headers,
      body:    body,
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
