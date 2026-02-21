/**
 * Cloudflare Pages Worker
 * Passes all requests through to static assets.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  }
};
