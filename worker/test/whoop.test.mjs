// Offline check of the Whoop adapter: OAuth URL, callback state, token storage, day normalization.
import { whoop } from '../src/whoop.js';
import worker from '../src/index.js';
import assert from 'node:assert/strict';

const kv = new Map();
const env = {
  APP_KEY: 'k'.repeat(32), ENC_KEY: 'test-enc-key', WHOOP_CLIENT_ID: 'cid', WHOOP_CLIENT_SECRET: 'csecret',
  APP_URL: 'https://cam572.github.io/macro-tracker/',
  STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) },
};
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); calls.push({ url, opts });
  const J = d => new Response(JSON.stringify(d), { status: 200 });
  if (url.includes('/oauth2/token')) return J({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  if (url.includes('/v2/cycle')) return J({ records: [
    { id: 1, start: '2026-10-16T04:30:00Z', end: '2026-10-17T03:50:00Z', timezone_offset: '-05:00', score_state: 'SCORED', score: { strain: 14.27, kilojoule: 10460, average_heart_rate: 72, max_heart_rate: 171 } },
    { id: 2, start: '2026-10-17T03:50:00Z', end: null, timezone_offset: '-05:00', score_state: 'SCORED', score: { strain: 4.1, kilojoule: 3000, average_heart_rate: 60, max_heart_rate: 110 } },
  ] });
  if (url.includes('/v2/recovery')) return J({ records: [
    { cycle_id: 2, sleep_id: 's2', score_state: 'SCORED', score: { recovery_score: 38, resting_heart_rate: 58, hrv_rmssd_milli: 41.23, spo2_percentage: 96.1, skin_temp_celsius: 33.71, user_calibrating: false } },
  ] });
  if (url.includes('/v2/activity/sleep')) return J({ records: [
    { id: 's2', cycle_id: 2, nap: false, start: '2026-10-17T03:50:00Z', end: '2026-10-17T10:20:00Z', timezone_offset: '-05:00', score_state: 'SCORED', score: {
      stage_summary: { total_in_bed_time_milli: 23400000, total_light_sleep_time_milli: 11000000, total_slow_wave_sleep_time_milli: 4500000, total_rem_sleep_time_milli: 5200000, disturbance_count: 9 },
      sleep_needed: { baseline_milli: 27000000, need_from_sleep_debt_milli: 1800000, need_from_recent_strain_milli: 600000, need_from_recent_nap_milli: 0 },
      respiratory_rate: 15.2, sleep_performance_percentage: 70, sleep_consistency_percentage: 64, sleep_efficiency_percentage: 88.4 } },
    { id: 'nap', cycle_id: 2, nap: true, start: '2026-10-17T19:00:00Z', end: '2026-10-17T19:30:00Z', timezone_offset: '-05:00', score_state: 'SCORED', score: { stage_summary: {} } },
  ] });
  if (url.includes('/v2/activity/workout')) return J({ records: [
    { start: '2026-10-16T22:00:00Z', end: '2026-10-16T23:05:00Z', timezone_offset: '-05:00', sport_name: 'weightlifting', score: { strain: 9.8, kilojoule: 1800, average_heart_rate: 120, max_heart_rate: 160 } },
  ] });
  return new Response('nope', { status: 404 });
};

// Unauthed request is rejected; CORS locked to the page origin
let res = await worker.fetch(new Request('https://w.dev/health'), env);
assert.equal(res.status, 401);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://cam572.github.io');

// Connect URL: 8-char state, offline scope, callback on the worker origin
const auth = { Authorization: 'Bearer ' + env.APP_KEY };
res = await worker.fetch(new Request('https://w.dev/whoop/connect', { method: 'POST', headers: auth }), env);
const { url } = await res.json(); const u = new URL(url);
const state = u.searchParams.get('state');
assert.equal(state.length, 8); assert.match(u.searchParams.get('scope'), /offline/);
assert.equal(u.searchParams.get('redirect_uri'), 'https://w.dev/whoop/callback');

// Forged state is refused; real state connects and redirects back to the app
res = await worker.fetch(new Request('https://w.dev/whoop/callback?code=c&state=forged12'), env);
assert.match(res.headers.get('Location'), /#whoop=failed$/);
res = await worker.fetch(new Request(`https://w.dev/whoop/callback?code=c&state=${state}`), env);
assert.match(res.headers.get('Location'), /#whoop=connected$/);
assert.ok(!kv.get('whoop:tokens').includes('RT'), 'tokens are encrypted at rest');
const tokenCall = calls.find(c => c.url.includes('/oauth2/token'));
assert.match(tokenCall.opts.body.toString(), /grant_type=authorization_code/);

// Day normalization
res = await worker.fetch(new Request('https://w.dev/whoop/days?days=7', { headers: auth }), env);
const data = await res.json();
const byDate = Object.fromEntries(data.days.map(d => [d.date, d]));
console.log(JSON.stringify(data.days, null, 1));
assert.equal(byDate['2026-10-16'].strain.score, 14.3);       // cycle starting 11:30pm Oct 15 local → Oct 16
assert.equal(byDate['2026-10-16'].workouts[0].minutes, 65);   // 5pm local workout on Oct 16
assert.equal(byDate['2026-10-17'].recovery.score, 38);
assert.equal(byDate['2026-10-17'].sleep.hours, 5.8);          // light+deep+REM, nap ignored
assert.equal(byDate['2026-10-17'].sleep.needHours, 8.2);
assert.equal(byDate['2026-10-17'].strain.inProgress, true);

// Refresh path: expired token triggers refresh and stores the new pair
const t = JSON.parse(await (await import('../src/crypto.js')).open(env, kv.get('whoop:tokens')));
assert.equal(t.refresh, 'RT');
console.log('all whoop adapter checks passed');
{ // Activity history endpoint
  const r = await worker.fetch(new Request('https://w.dev/whoop/workouts?days=30', { headers: { Authorization: 'Bearer ' + env.APP_KEY } }), env);
  const d = await r.json();
  assert.equal(d.workouts.length, 1); assert.equal(d.workouts[0].sport, 'weightlifting'); assert.equal(d.workouts[0].minutes, 65);
  assert.equal(d.workouts[0].date, '2026-10-16'); assert.equal(d.workouts[0].zones.length, 6);
  console.log('workouts endpoint ok');
}
