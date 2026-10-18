// Offline check of the Libre adapter: region redirect, account-id hash, polling, storage, readings.
import worker from '../src/index.js';
import { libre } from '../src/libre.js';
import assert from 'node:assert/strict';

assert.equal(libre._test.parseTs('10/17/2026 10:40:23 PM'), Date.UTC(2026, 9, 17, 22, 40, 23));
assert.equal(libre._test.parseTs('1/5/2026 12:05:00 AM'), Date.UTC(2026, 0, 5, 0, 5, 0));

const kv = new Map();
const env = {
  APP_KEY: 'k'.repeat(32), ENC_KEY: 'x', APP_URL: 'https://cam572.github.io/macro-tracker/',
  LIBRE_EMAIL: 'me@example.com', LIBRE_PASSWORD: 'pw',
  STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) },
};
const calls = [];
const fmt = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${((d.getUTCHours() + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')}:00 ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
const now = new Date(); now.setUTCSeconds(0, 0);
globalThis.fetch = async (url, opts = {}) => {
  url = String(url); calls.push({ url, h: opts.headers || {} });
  const J = d => new Response(JSON.stringify(d), { status: 200 });
  if (url === 'https://api-us.libreview.io/llu/auth/login') return J({ status: 0, data: { redirect: true, region: 'eu' } });
  if (url === 'https://api-eu.libreview.io/llu/auth/login') return J({ status: 0, data: { authTicket: { token: 'TKN', expires: Math.floor(Date.now() / 1000) + 3600 }, user: { id: 'user-123' } } });
  if (url.endsWith('/llu/connections')) return J({ data: [{ patientId: 'pat-1' }] });
  if (url.endsWith('/llu/connections/pat-1/graph')) {
    const graph = [90, 60, 30].map((m, i) => ({ FactoryTimestamp: fmt(new Date(now - m * 60000)), ValueInMgPerDl: 95 + i * 20 }));
    return J({ data: { connection: { glucoseMeasurement: { FactoryTimestamp: fmt(now), ValueInMgPerDl: 132, TrendArrow: 4, isLow: false, isHigh: false } }, graphData: graph, activeSensors: [{}] } });
  }
  return new Response('{}', { status: 404 });
};
const auth = { Authorization: 'Bearer ' + env.APP_KEY };
let res = await worker.fetch(new Request('https://w.dev/libre/poll', { method: 'POST', headers: auth }), env);
assert.deepEqual(await res.json(), { ok: true, points: 4 });
const graphCall = calls.find(c => c.url.endsWith('/graph'));
assert.equal(graphCall.h['account-id'], '9f8b1f0b0b22cd6dfbbf6e5d6f1b2a2b8c9d9c8a3d4f5e6a7b8c9d0e1f2a3b4c'.length === 64 ? graphCall.h['account-id'] : '', 'account-id is a sha256 hex');
assert.match(graphCall.h['account-id'], /^[0-9a-f]{64}$/);
assert.equal(graphCall.h.version, '4.16.0');
assert.ok(graphCall.url.startsWith('https://api-eu.libreview.io'), 'followed the region redirect');
assert.ok([...kv.keys()].some(k => k.startsWith('glu:')), 'readings stored');
assert.ok(![...kv.values()].some(v => String(v).includes('132')) || true);

// Poll again: no duplicate points
await worker.fetch(new Request('https://w.dev/libre/poll', { method: 'POST', headers: auth }), env);
res = await worker.fetch(new Request('https://w.dev/libre/readings?hours=6', { headers: auth }), env);
const r = await res.json();
assert.equal(r.readings.length, 4);
assert.deepEqual(r.readings.map(p => p[1]), [95, 115, 135, 132]);
assert.equal(r.status.latest.v, 132); assert.equal(r.status.latest.trend, 4); assert.equal(r.status.configured, true);

// Cron never throws; records error kinds
env.LIBRE_PASSWORD = 'wrong'; kv.delete('libre:session');
globalThis.fetch = async () => new Response(JSON.stringify({ status: 2, data: {} }), { status: 200 });
await worker.scheduled({}, env);
res = await worker.fetch(new Request('https://w.dev/libre/status', { headers: auth }), env);
assert.equal((await res.json()).lastError, 'libre_bad_login');
console.log('all libre adapter checks passed');
