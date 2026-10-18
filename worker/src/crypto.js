// App-level encryption for anything sensitive kept in KV (on top of Cloudflare's own at-rest encryption).
// AES-GCM with a key derived from the ENC_KEY secret; output is "iv.ciphertext" in base64url.

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

let cached;
async function key(env) {
  if (cached) return cached;
  if (!env.ENC_KEY) throw Object.assign(new Error('missing ENC_KEY'), { code: 'config_missing', status: 500 });
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.ENC_KEY));
  cached = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return cached;
}

export async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(env), new TextEncoder().encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function open(env, sealed) {
  const [iv, ct] = sealed.split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(env), unb64(ct));
  return new TextDecoder().decode(pt);
}
