// Voice adapter — speech-to-text for the coach's talk mode.
// The page records a short clip and posts the raw audio here; the OpenAI key never leaves the Worker.
// Audio is passed straight through and never stored.

const STT_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MAX_BYTES = 10 * 1024 * 1024; // ~10 min of iPhone AAC; talk turns are seconds long

const fail = (code, status, publicMessage) => Object.assign(new Error(code), { code, status, publicMessage });
const extFor = type => /mp4|m4a|aac/.test(type) ? 'm4a' : /webm/.test(type) ? 'webm' : /ogg/.test(type) ? 'ogg' : /wav/.test(type) ? 'wav' : 'mp3';

async function transcribe(env, req) {
  if (!env.OPENAI_API_KEY) throw fail('voice_not_configured', 409, 'Voice isn\'t set up on the server yet — run ./setup.sh voice.');
  const type = (req.headers.get('Content-Type') || 'audio/mp4').split(';')[0];
  const audio = await req.arrayBuffer();
  if (audio.byteLength < 1000) throw fail('voice_too_short', 400, 'That clip was too short.');
  if (audio.byteLength > MAX_BYTES) throw fail('voice_too_long', 413, 'That clip was too long.');

  const form = new FormData();
  form.append('file', new Blob([audio], { type }), 'clip.' + extFor(type));
  form.append('model', env.STT_MODEL || 'gpt-4o-mini-transcribe');
  form.append('language', 'en');
  // Vocabulary hint so food and training words come out right
  form.append('prompt', 'Nutrition and training chat: macros, protein, carbs, grams, calories, Whoop, recovery, strain, glucose, Libre, sets, reps, RDL, Greek yogurt, Chipotle.');

  const res = await fetch(STT_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY.trim()}` }, body: form });
  if (res.status === 401) throw fail('voice_bad_key', 502, 'The OpenAI key on the server was rejected — run ./setup.sh voice again.');
  if (res.status === 429) throw fail('voice_rate_limited', 503, 'Voice is busy — try again in a moment.');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.log('stt error', res.status, body.error?.code || body.error?.type || ''); // never log audio or text
    throw fail('voice_stt_' + res.status, 502, 'Couldn\'t understand the audio — try again.');
  }
  const data = await res.json();
  return { text: (data.text || '').trim() };
}

export const voice = {
  status: env => ({ configured: !!env.OPENAI_API_KEY }),
  transcribe,
};
