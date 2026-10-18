// Whoop adapter — official v2 developer API over OAuth 2.0.
// Returns normalized per-day summaries so the page never depends on Whoop's raw shapes.

import { seal, open } from './crypto.js';

const AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const API = 'https://api.prod.whoop.com/developer';
const SCOPES = 'offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement';
const TOKEN_KEY = 'whoop:tokens';

const fail = (code, status, publicMessage) => Object.assign(new Error(code), { code, status, publicMessage });
const redirectUri = origin => `${origin}/whoop/callback`;

async function saveTokens(env, t) {
  await env.STORE.put(TOKEN_KEY, await seal(env, JSON.stringify({
    access: t.access_token, refresh: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in || 3600) * 1000,
  })));
}
async function loadTokens(env) {
  const raw = await env.STORE.get(TOKEN_KEY);
  return raw ? JSON.parse(await open(env, raw)) : null;
}

async function tokenRequest(env, params) {
  // Trim in case the secret was pasted with stray whitespace
  const id = (env.WHOOP_CLIENT_ID || '').trim(), secret = (env.WHOOP_CLIENT_SECRET || '').trim();
  // OAuth allows the client to authenticate in the body (client_secret_post) or via HTTP Basic
  // (client_secret_basic). Try body first; if Whoop rejects the client, retry with Basic.
  // A client-auth failure is checked before the code, so the code is still usable for the retry.
  const attempts = [
    { headers: {}, body: { client_id: id, client_secret: secret, ...params } },
    { headers: { Authorization: 'Basic ' + btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`) }, body: params },
  ];
  let last;
  for (const [i, a] of attempts.entries()) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...a.headers },
      body: new URLSearchParams(a.body),
    });
    if (res.ok) { if (i) console.log('whoop token ok via basic auth'); return res.json(); }
    // OAuth error codes/descriptions are safe to log; never log tokens or secrets
    const body = await res.json().catch(() => ({}));
    console.log('whoop token error', i ? 'basic' : 'post', res.status, body.error || '', body.error_description || '');
    last = res.status;
    if (body.error !== 'invalid_client') break;
  }
  throw fail('whoop_token_' + last, 502, 'Whoop sign-in failed — try reconnecting Whoop.');
}

async function refreshIfNeeded(env, withinSeconds = 60) {
  const t = await loadTokens(env);
  if (!t) return null;
  if (t.expiresAt - Date.now() > withinSeconds * 1000) return t;
  try {
    // Each refresh invalidates the previous refresh token, so store the new pair immediately
    const fresh = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: t.refresh, scope: 'offline' });
    await saveTokens(env, fresh);
    return loadTokens(env);
  } catch (err) {
    if (/whoop_token_(400|401)/.test(err.code)) await env.STORE.delete(TOKEN_KEY); // refresh token is dead — needs reconnect
    throw err;
  }
}

async function api(env, path, params = {}) {
  const t = await refreshIfNeeded(env);
  if (!t) throw fail('whoop_not_connected', 409, 'Whoop is not connected.');
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t.access}` } });
  if (res.status === 429) throw fail('whoop_rate_limited', 503, 'Whoop is busy — try again in a minute.');
  if (!res.ok) throw fail('whoop_api_' + res.status, 502, 'Whoop data could not be loaded.');
  return res.json();
}

// Walk every page of a collection inside the window
async function collect(env, path, start) {
  const out = [];
  let nextToken;
  for (let page = 0; page < 20; page++) {
    const data = await api(env, path, { limit: 25, start, nextToken });
    out.push(...(data.records || []));
    nextToken = data.next_token;
    if (!nextToken) break;
  }
  return out;
}

// Whoop "days" run sleep-onset to sleep-onset. Label each by the calendar day you woke up into:
// shift the start into local time, then forward 12h (11pm Mon → Tue, 1am Tue → Tue).
function localDay(iso, offset = '+00:00', shiftHours = 0) {
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(offset || '+00:00') || ['', '+', '00', '00'];
  const mins = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  return new Date(Date.parse(iso) + (mins + shiftHours * 60) * 60000).toISOString().slice(0, 10);
}
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const hours = ms => ms == null ? null : r1(ms / 3600000);
const kcal = kj => kj == null ? null : Math.round(kj / 4.184);

async function days(env, n) {
  const start = new Date(Date.now() - (n + 1) * 86400000).toISOString();
  const [cycles, recoveries, sleeps, workouts] = await Promise.all([
    collect(env, '/v2/cycle', start),
    collect(env, '/v2/recovery', start),
    collect(env, '/v2/activity/sleep', start),
    collect(env, '/v2/activity/workout', start),
  ]);

  const byCycle = new Map(), out = {};
  for (const c of cycles) {
    const date = localDay(c.start, c.timezone_offset, 12);
    const d = out[date] ||= { date, recovery: null, sleep: null, strain: null, workouts: [] };
    byCycle.set(c.id, d);
    if (c.score_state === 'SCORED' && c.score) {
      d.strain = { score: r1(c.score.strain), kcal: kcal(c.score.kilojoule), avgHr: c.score.average_heart_rate, maxHr: c.score.max_heart_rate, inProgress: !c.end };
    }
  }
  for (const r of recoveries) {
    const d = byCycle.get(r.cycle_id);
    if (!d || r.score_state !== 'SCORED' || !r.score) continue;
    d.recovery = {
      score: r.score.recovery_score, hrv: r1(r.score.hrv_rmssd_milli), rhr: r.score.resting_heart_rate,
      spo2: r1(r.score.spo2_percentage), skinTempC: r1(r.score.skin_temp_celsius), calibrating: !!r.score.user_calibrating,
    };
  }
  for (const s of sleeps) {
    if (s.nap || s.score_state !== 'SCORED' || !s.score) continue;
    const d = byCycle.get(s.cycle_id) || (out[localDay(s.end, s.timezone_offset)] ||= { date: localDay(s.end, s.timezone_offset), recovery: null, sleep: null, strain: null, workouts: [] });
    const st = s.score.stage_summary || {}, need = s.score.sleep_needed || {};
    const asleep = (st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0);
    d.sleep = {
      hours: hours(asleep), inBedHours: hours(st.total_in_bed_time_milli),
      deepHours: hours(st.total_slow_wave_sleep_time_milli), remHours: hours(st.total_rem_sleep_time_milli),
      needHours: hours((need.baseline_milli || 0) + (need.need_from_sleep_debt_milli || 0) + (need.need_from_recent_strain_milli || 0) + (need.need_from_recent_nap_milli || 0)),
      performance: s.score.sleep_performance_percentage, efficiency: r1(s.score.sleep_efficiency_percentage),
      consistency: s.score.sleep_consistency_percentage, respRate: r1(s.score.respiratory_rate), disturbances: st.disturbance_count,
      bedtime: s.start, wake: s.end,
    };
  }
  for (const w of workouts) {
    const date = localDay(w.start, w.timezone_offset);
    const d = out[date] ||= { date, recovery: null, sleep: null, strain: null, workouts: [] };
    d.workouts.push({
      sport: w.sport_name || 'Activity', start: w.start,
      minutes: Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60000),
      strain: r1(w.score?.strain), kcal: kcal(w.score?.kilojoule), avgHr: w.score?.average_heart_rate, maxHr: w.score?.max_heart_rate,
    });
  }
  return { syncedAt: new Date().toISOString(), days: Object.values(out).sort((a, b) => a.date.localeCompare(b.date)) };
}

export const whoop = {
  async authorizeUrl(env, origin) {
    // Whoop requires an 8-character state; keep it 10 minutes to match the callback
    const state = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
    await env.STORE.put('whoop:state:' + state, '1', { expirationTtl: 600 });
    const u = new URL(AUTH_URL);
    u.search = new URLSearchParams({ response_type: 'code', client_id: env.WHOOP_CLIENT_ID, redirect_uri: redirectUri(origin), scope: SCOPES, state });
    return u.toString();
  },

  async handleCallback(url, env) {
    const state = url.searchParams.get('state'), code = url.searchParams.get('code');
    if (url.searchParams.get('error')) { console.log('whoop callback error', url.searchParams.get('error'), url.searchParams.get('error_description') || ''); return false; }
    if (!state || !code) { console.log('whoop callback missing', !state ? 'state' : 'code'); return false; }
    if (!(await env.STORE.get('whoop:state:' + state))) { console.log('whoop callback unknown state'); return false; }
    await env.STORE.delete('whoop:state:' + state);
    const t = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(url.origin) }).catch(() => null);
    if (!t) return false;
    if (!t.refresh_token) { console.log('whoop token response had no refresh_token; scopes:', t.scope || ''); return false; }
    await saveTokens(env, t);
    return true;
  },

  async status(env) {
    const t = await loadTokens(env).catch(() => null);
    return { connected: !!t };
  },

  async disconnect(env) {
    const t = await loadTokens(env).catch(() => null);
    if (t) await fetch(`${API}/v2/user/access`, { method: 'DELETE', headers: { Authorization: `Bearer ${t.access}` } }).catch(() => {});
    await env.STORE.delete(TOKEN_KEY);
  },

  refreshIfNeeded,
  days,
};
