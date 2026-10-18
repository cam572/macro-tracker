// LibreLinkUp adapter (Freestyle Libre 3) — UNOFFICIAL API, isolated so it can be swapped.
// Abbott has no public API; this follows the LibreLinkUp follower-app protocol as implemented by
// the maintained community client pylibrelinkup. If Abbott bumps the minimum app version, update
// APP_VERSION below. LibreLinkUp only exposes ~12h of graph data, so the cron collects readings
// into KV (sealed) to build long-term history.

import { seal, open } from './crypto.js';

const APP_VERSION = '4.16.0';
const PRODUCT = 'llu.android';
const USER_AGENT = 'okhttp/4.12.0';
const DEFAULT_HOST = 'https://api-us.libreview.io';
const SESSION_KEY = 'libre:session';
const STATUS_KEY = 'libre:status';
const KEEP_DAYS = 120;

const fail = (code, status, publicMessage) => Object.assign(new Error(code), { code, status, publicMessage });
const hostFor = region => region === 'ru' ? 'https://api.libreview.ru' : `https://api-${region}.libreview.io`;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function headers(session) {
  // LibreView's bot protection 403s requests that don't look like the app — keep the app's headers + user-agent
  const h = {
    'content-type': 'application/json', 'cache-control': 'no-cache', 'accept-encoding': 'gzip', connection: 'Keep-Alive',
    'user-agent': USER_AGENT, product: PRODUCT, version: APP_VERSION,
  };
  if (session) { h.authorization = `Bearer ${session.token}`; h['account-id'] = session.accountHash; }
  return h;
}

async function setStatus(env, patch) {
  const cur = JSON.parse((await env.STORE.get(STATUS_KEY)) || '{}');
  await env.STORE.put(STATUS_KEY, JSON.stringify({ ...cur, ...patch }));
}

// LibreView reports problems in the body: status 2 = bad login, 920 = app version too old,
// data.step = terms/privacy/email verification that must be accepted in the LibreLinkUp app.
async function login(env, host = DEFAULT_HOST, hops = 0) {
  if (!env.LIBRE_EMAIL || !env.LIBRE_PASSWORD) throw fail('libre_not_configured', 409, 'Libre 3 is not set up on the server yet.');
  const res = await fetch(`${host}/llu/auth/login`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ email: env.LIBRE_EMAIL.trim(), password: env.LIBRE_PASSWORD }),
  });
  if (res.status === 429) throw fail('libre_rate_limited', 503, 'LibreLinkUp is rate limiting — will retry.');
  if (res.status === 403) throw fail('libre_blocked', 502, 'LibreLinkUp blocked the server request — the connector needs an update.');
  const body = await res.json().catch(() => ({}));
  const d = body.data || {};
  if (d.redirect && d.region && hops < 2) return login(env, hostFor(String(d.region).toLowerCase()), hops + 1);
  if (body.status === 920) throw fail('libre_app_version', 502, 'LibreLinkUp changed its required app version — the connector needs an update.');
  if (d.step?.type) throw fail('libre_step_' + d.step.type, 409, 'Open the LibreLinkUp app and accept the latest terms, then try again.');
  if (body.status === 2) throw fail('libre_bad_login', 401, 'LibreLinkUp login failed — check the email and password.');
  if (!d.authTicket?.token || !d.user?.id) {
    // Shape only — status code and field names, never credentials or values
    console.log('libre login rejected', host, 'http', res.status, 'status', body.status, 'dataKeys', Object.keys(d).join(','), 'error', body.error?.message || '');
    throw fail('libre_bad_login', 401, 'LibreLinkUp login failed — check the email and password.');
  }
  const session = {
    host, token: d.authTicket.token, accountHash: await sha256Hex(d.user.id),
    expiresAt: (d.authTicket.expires ? d.authTicket.expires * 1000 : Date.now() + 3600e3) - 5 * 60e3,
  };
  // Find the shared patient (the Libre 3 wearer) once
  const conns = await api(env, session, '/llu/connections');
  const patient = (conns.data || [])[0];
  if (!patient?.patientId) throw fail('libre_no_connection', 409, 'No one is sharing with this LibreLinkUp account yet.');
  session.patientId = patient.patientId;
  await env.STORE.put(SESSION_KEY, await seal(env, JSON.stringify(session)));
  return session;
}

async function api(env, session, path) {
  const res = await fetch(session.host + path, { headers: headers(session) });
  if (res.status === 401) throw fail('libre_session_expired', 401, 'LibreLinkUp session expired.');
  if (res.status === 429) throw fail('libre_rate_limited', 503, 'LibreLinkUp is rate limiting — will retry.');
  if (!res.ok) throw fail('libre_api_' + res.status, 502, 'LibreLinkUp data could not be loaded.');
  const body = await res.json();
  if (body.status === 920) throw fail('libre_app_version', 502, 'LibreLinkUp changed its required app version — the connector needs an update.');
  return body;
}

async function session(env) {
  const raw = await env.STORE.get(SESSION_KEY);
  const s = raw ? JSON.parse(await open(env, raw)) : null;
  return s && s.expiresAt > Date.now() && s.patientId ? s : login(env);
}

// LibreView timestamps look like "10/17/2026 10:40:23 PM". FactoryTimestamp is UTC.
function parseTs(s) {
  const m = /^(\d+)\/(\d+)\/(\d{4}) (\d+):(\d\d):(\d\d) ([AP]M)$/.exec(s || '');
  if (!m) return null;
  let h = +m[4] % 12; if (m[7] === 'PM') h += 12;
  return Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +m[6]);
}
const point = g => {
  const t = parseTs(g.FactoryTimestamp);
  const v = g.ValueInMgPerDl ?? g.Value;
  return t && v ? [Math.round(t / 1000), Math.round(v)] : null;
};
const dayKey = sec => 'glu:' + new Date(sec * 1000).toISOString().slice(0, 10);

async function readDay(env, key) {
  const raw = await env.STORE.get(key);
  return raw ? JSON.parse(await open(env, raw)) : [];
}

// Merge new points into per-UTC-day buckets (dedup by timestamp)
async function store(env, points) {
  const byDay = new Map();
  for (const p of points) { const k = dayKey(p[0]); (byDay.get(k) || byDay.set(k, []).get(k)).push(p); }
  for (const [k, pts] of byDay) {
    const merged = new Map((await readDay(env, k)).map(p => [p[0], p]));
    for (const p of pts) merged.set(p[0], p);
    const arr = [...merged.values()].sort((a, b) => a[0] - b[0]);
    await env.STORE.put(k, await seal(env, JSON.stringify(arr)), { expirationTtl: KEEP_DAYS * 86400 });
  }
}

async function poll(env) {
  let s = await session(env);
  let data;
  try { data = await api(env, s, `/llu/connections/${s.patientId}/graph`); }
  catch (err) {
    if (err.code !== 'libre_session_expired') throw err;
    s = await login(env); data = await api(env, s, `/llu/connections/${s.patientId}/graph`);
  }
  const d = data.data || {};
  const cur = d.connection?.glucoseMeasurement;
  const points = [...(d.graphData || []).map(point), cur && point(cur)].filter(Boolean);
  await store(env, points);
  const latest = cur && point(cur);
  await setStatus(env, {
    lastPollAt: Date.now(), lastError: null,
    latest: latest ? { t: latest[0], v: latest[1], trend: cur.TrendArrow ?? null, isLow: !!cur.isLow, isHigh: !!cur.isHigh } : null,
    sensorActive: !!d.activeSensors?.length,
  });
  return points.length;
}

export const libre = {
  configured: env => !!(env.LIBRE_EMAIL && env.LIBRE_PASSWORD),

  async status(env) {
    const st = JSON.parse((await env.STORE.get(STATUS_KEY)) || '{}');
    return { configured: libre.configured(env), ...st };
  },

  // Cron entry: never throws, records the error kind for the app to show
  async pollSafe(env) {
    if (!libre.configured(env)) return;
    try { await poll(env); }
    catch (err) { await setStatus(env, { lastError: err.code || 'error', lastErrorAt: Date.now() }); console.log('libre poll failed', err.code || err.message); }
  },

  async pollNow(env) { const n = await poll(env); return { ok: true, points: n }; },

  async readings(env, hours) {
    const now = Math.floor(Date.now() / 1000), from = now - hours * 3600;
    const keys = [];
    for (let t = from; t <= now + 86400; t += 86400) { const k = dayKey(t); if (!keys.includes(k)) keys.push(k); }
    const all = (await Promise.all(keys.map(k => readDay(env, k)))).flat().filter(p => p[0] >= from);
    return { readings: all, status: await libre.status(env) };
  },

  async reset(env) { await env.STORE.delete(SESSION_KEY); await env.STORE.delete(STATUS_KEY); },

  _test: { parseTs, point },
};
