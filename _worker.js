/**
 * Cloudflare Pages Worker — Wasmer Registry CORS Proxy
 * Proxies /wasmer-graphql → registry.wasmer.io/graphql
 * stripping the user-agent header that causes CORS preflight failures.
 */

const TARGET = "https://registry.wasmer.io/graphql";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/wasmer-graphql") {
      return env.ASSETS.fetch(request);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Forward the request body as a raw stream — don't touch it
    const response = await fetch(TARGET, {
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
