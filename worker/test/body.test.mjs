import worker from '../src/index.js';
import { body } from '../src/body.js';
import assert from 'node:assert/strict';
const { toKg, toPct } = body._test;
assert.equal(Math.round(toKg('182.4 lb') * 10) / 10, 82.7);
assert.equal(toKg(80, 'kg'), 80);
assert.equal(Math.round(toKg('82,5 kg') * 10) / 10, 82.5);
assert.equal(toPct(0.215), 21.5); assert.equal(toPct('21.5%'), 21.5);
const kv = new Map();
const env = { APP_KEY: 'k'.repeat(32), ENC_KEY: 'x', APP_URL: 'https://cam572.github.io/macro-tracker/',
  STORE: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v), delete: async k => kv.delete(k) } };
const auth = { Authorization: 'Bearer ' + env.APP_KEY, 'Content-Type': 'application/json' };
const post = b => worker.fetch(new Request('https://w.dev/body', { method: 'POST', headers: auth, body: JSON.stringify(b) }), env);
let r = await (await post({ weight: '182.4 lb', bodyFat: '0.215', measuredAt: '2026-10-17T13:02:00Z' })).json();
assert.equal(r.entry.kg, 82.74); assert.equal(r.entry.bf, 21.5);
await post({ weight: '182.6 lb', bodyFat: '21.4%', measuredAt: '2026-10-17T13:02:40Z' }); // duplicate sample → replaces
await post({ weight: 81.9, weightUnit: 'kg', measuredAt: new Date().toISOString(), source: 'manual' });
let res = await (await worker.fetch(new Request('https://w.dev/body?days=3650', { headers: auth }), env)).json();
assert.equal(res.entries.length, 2); assert.equal(res.entries[0].bf, 21.4);
res = await post({ weight: '18 lb' }); assert.equal(res.status, 400);
res = await worker.fetch(new Request('https://w.dev/body', { method: 'POST', body: '{}' }), env); assert.equal(res.status, 401);
assert.ok(![...kv.values()].some(v => String(v).includes('82.74')), 'sealed at rest');
console.log('all body checks passed');
{ const { toKg, toPct } = body._test;
  assert.equal(Math.round(toKg(['182.4 lb']) * 10) / 10, 82.7);
  assert.equal(toPct([{ value: 0.2 }]), 20);
  console.log('wrapped shapes ok'); }
