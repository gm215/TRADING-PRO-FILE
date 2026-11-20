// Trading Pro-File on Cloudflare Workers: the app's files come from /public,
// and two small services run here: /api/ai (Workers AI) and /api/config (sign-in from any phone).
import { onRequestPost as aiPost } from './ai.js';
import { onRequestGet as configGet } from './config.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/ai') {
      if (request.method === 'POST') return aiPost({ request, env, ctx });
      return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
    }
    if (url.pathname === '/api/config') {
      if (request.method === 'GET') return configGet({ request, env, ctx });
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET' } });
    }
    return env.ASSETS.fetch(request);
  }
};
