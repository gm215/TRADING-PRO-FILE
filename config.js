// Serves the Firebase web settings saved in Cloudflare (variable FB_CONFIG), so any phone
// that opens the site can sign in with email and password only, without pasting settings.
// The Firebase web config is public by design; your data is protected by the Firestore rules.
const PAT = {
  apiKey: /AIza[0-9A-Za-z_\-]{35}/,
  authDomain: /[a-z0-9.\-]+\.(firebaseapp\.com|web\.app)/i,
  projectId: /[a-z0-9\-]{4,40}/,
  storageBucket: /[a-z0-9.\-]+\.(appspot\.com|firebasestorage\.app)/i,
  messagingSenderId: /\d{6,20}/,
  appId: /\d:\d+:web:[0-9a-f]+/i
};
function parse(raw) {
  raw = String(raw || '').trim();
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch (e) { obj = null; }
  const out = {};
  for (const k of Object.keys(PAT)) {
    let v = obj && obj[k] != null ? String(obj[k]) : null;
    if (v == null) { const m = new RegExp(k + '\\s*[:=]\\s*["\']([^"\']+)["\']').exec(raw); v = m ? m[1] : null; }
    if (v == null) continue;
    const m2 = PAT[k].exec(v.trim()); if (m2) out[k] = m2[0];
  }
  return out.apiKey && out.projectId ? out : null;
}
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
export async function onRequestGet({ env }) {
  const cfg = parse(env && env.FB_CONFIG);
  if (!cfg) return new Response(JSON.stringify({ config: null }), { status: 404, headers: HEADERS });
  return new Response(JSON.stringify({ config: cfg }), { status: 200, headers: HEADERS });
}
