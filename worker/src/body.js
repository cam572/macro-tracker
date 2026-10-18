// Body measurements adapter — scale-agnostic inbox (weight, body fat %, lean mass).
// Today it's fed by an iPhone Shortcut reading Apple Health (Hume Body Pod → Health → Shortcut → here),
// plus manual entries from the tracker. Stored sealed in KV, canonical units: kg and percent.

import { seal, open } from './crypto.js';

const KEY = 'body:log';
const fail = (code, status, publicMessage) => Object.assign(new Error(code), { code, status, publicMessage });

// Shortcuts sends values in many shapes: 182.4, "182.4", "182.4 lb", 0.215 (fraction) or "21.5%".
function num(v) {
  if (typeof v === 'number') return v;
  const m = /-?\d+(?:[.,]\d+)?/.exec(String(v ?? ''));
  return m ? parseFloat(m[0].replace(',', '.')) : NaN;
}
function toKg(v, unit) {
  const n = num(v);
  if (!isFinite(n) || n <= 0) return null;
  const u = String(unit || v || '').toLowerCase();
  if (/kg|kilo/.test(u)) return n;
  if (/st\b|stone/.test(u)) return n * 6.35029;
  return n * 0.45359237; // default lb (US Health locale)
}
function toPct(v) {
  const n = num(v);
  if (!isFinite(n) || n <= 0) return null;
  return n < 1 ? n * 100 : n; // Health may hand over 0.215 for 21.5%
}
function toTime(v) {
  const t = Date.parse(v);
  return isFinite(t) ? t : Date.now();
}

async function load(env) {
  const raw = await env.STORE.get(KEY);
  return raw ? JSON.parse(await open(env, raw)) : [];
}

export const body = {
  async add(env, input) {
    const kg = toKg(input.weight, input.weightUnit ?? input.unit);
    const bf = toPct(input.bodyFat);
    const leanKg = input.leanMass != null ? toKg(input.leanMass, input.leanMassUnit ?? input.weightUnit) : null;
    if (kg == null && bf == null) throw fail('body_empty', 400, 'No weight or body fat value received.');
    if (kg != null && (kg < 25 || kg > 350)) throw fail('body_out_of_range', 400, 'That weight looks off — check the unit.');
    if (bf != null && (bf < 2 || bf > 75)) throw fail('body_out_of_range', 400, 'That body fat value looks off.');
    const t = toTime(input.measuredAt);
    const entry = {
      t, kg: kg != null ? Math.round(kg * 100) / 100 : null, bf: bf != null ? Math.round(bf * 10) / 10 : null,
      leanKg: leanKg != null ? Math.round(leanKg * 100) / 100 : null, source: String(input.source || 'shortcut').slice(0, 20),
    };
    // The same Health sample often arrives more than once — dedupe within 2 minutes, keep newest values
    const log = (await load(env)).filter(e => Math.abs(e.t - t) > 120000);
    log.push(entry);
    log.sort((a, b) => a.t - b.t);
    await env.STORE.put(KEY, await seal(env, JSON.stringify(log.slice(-1500))));
    return { ok: true, entry };
  },

  async list(env, days) {
    const from = Date.now() - days * 86400000;
    return { entries: (await load(env)).filter(e => e.t >= from) };
  },

  async remove(env, t) {
    const log = (await load(env)).filter(e => e.t !== t);
    await env.STORE.put(KEY, await seal(env, JSON.stringify(log)));
    return { ok: true };
  },

  _test: { toKg, toPct, num },
};
