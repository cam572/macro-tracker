// Macro Coach backend — a thin, single-user Cloudflare Worker.
// Holds the secrets the public tracker page can't: Whoop OAuth tokens today, LibreLinkUp next.
// Each data source lives behind its own adapter so it can be swapped without touching the page.
//
// Secrets (wrangler secret put): APP_KEY, ENC_KEY, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, LIBRE_EMAIL, LIBRE_PASSWORD
// Vars (wrangler.toml): APP_URL
// KV binding: STORE

import { whoop } from './whoop.js';
import { libre } from './libre.js';

const json = (data, status = 200, env) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...cors(env) },
});
const cors = env => ({
  'Access-Control-Allow-Origin': new URL(env.APP_URL).origin,
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Vary': 'Origin',
});

// Constant-time compare so the app key can't be guessed byte by byte
function authed(req, env) {
  const got = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const want = env.APP_KEY || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    try {
      // OAuth redirect lands here from Whoop's site — authorized by the one-time state, not the app key
      if (url.pathname === '/whoop/callback') {
        const ok = await whoop.handleCallback(url, env);
        return Response.redirect(`${env.APP_URL}#whoop=${ok ? 'connected' : 'failed'}`, 302);
      }

      if (!authed(req, env)) return json({ error: 'unauthorized' }, 401, env);

      switch (`${req.method} ${url.pathname}`) {
        // Shape-only check of the saved Whoop credentials (lengths, never values) for setup troubleshooting
        case 'GET /whoop/config-check': return json({
          clientIdLength: (env.WHOOP_CLIENT_ID || '').length, clientIdLooksLikeUuid: /^[0-9a-f-]{36}$/i.test((env.WHOOP_CLIENT_ID || '').trim()),
          secretLength: (env.WHOOP_CLIENT_SECRET || '').length, secretTrimmedLength: (env.WHOOP_CLIENT_SECRET || '').trim().length,
          secretEqualsClientId: (env.WHOOP_CLIENT_SECRET || '').trim() === (env.WHOOP_CLIENT_ID || '').trim(),
        }, 200, env);
        case 'GET /health':           return json({ ok: true, sources: { whoop: await whoop.status(env), libre: await libre.status(env) } }, 200, env);
        case 'POST /whoop/connect':   return json({ url: await whoop.authorizeUrl(env, url.origin) }, 200, env);
        case 'GET /whoop/status':     return json(await whoop.status(env), 200, env);
        case 'GET /whoop/days':       return json(await whoop.days(env, Math.min(+url.searchParams.get('days') || 14, 60)), 200, env);
        case 'POST /whoop/disconnect':await whoop.disconnect(env); return json({ ok: true }, 200, env);
        case 'GET /libre/status':     return json(await libre.status(env), 200, env);
        case 'GET /libre/readings':   return json(await libre.readings(env, Math.min(+url.searchParams.get('hours') || 24, 24 * 30)), 200, env);
        case 'POST /libre/poll':      return json(await libre.pollNow(env), 200, env);
      }
      return json({ error: 'not found' }, 404, env);
    } catch (err) {
      // Never echo health data or tokens — just the error kind
      console.log('error', url.pathname, err.code || err.message);
      return json({ error: err.code || 'server_error', message: err.publicMessage || 'Something went wrong' }, err.status || 500, env);
    }
  },

  // Keep the Whoop refresh token alive and pre-refresh access tokens off the request path
  async scheduled(_event, env) {
    await Promise.all([
      whoop.refreshIfNeeded(env, 20 * 60).catch(err => console.log('cron refresh failed', err.code || err.message)),
      libre.pollSafe(env), // LibreLinkUp only keeps ~12h, so collect every run
    ]);
  },
};
