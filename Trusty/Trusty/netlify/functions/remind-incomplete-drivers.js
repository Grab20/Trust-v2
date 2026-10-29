/**
 * remind-incomplete-drivers
 * Sends a push notification to all incomplete / pending_docs drivers
 * who have a push subscription, reminding them to upload their documents.
 *
 * Runs automatically at 9am SAST daily (7am UTC) via netlify.toml schedule.
 * Also callable manually:
 *   GET /.netlify/functions/remind-incomplete-drivers?secret=YOUR_SETUP_SECRET
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY     = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY    = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT        = process.env.VAPID_SUBJECT || 'mailto:hello@trustmate.co.za';
const SETUP_SECRET         = process.env.SETUP_SECRET || 'trustmate-setup-2026';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── VAPID JWT ─────────────────────────────────────────────────────────────────
function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64uDec(s) {
  return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64');
}
async function buildVapidJWT(audience) {
  const header  = base64url(JSON.stringify({ typ:'JWT', alg:'ES256' }));
  const payload = base64url(JSON.stringify({ aud:audience, exp:Math.floor(Date.now()/1000)+43200, sub:VAPID_SUBJECT }));
  const sig_in  = `${header}.${payload}`;
  const privDer = b64uDec(VAPID_PRIVATE_KEY);
  const pkcs8   = Buffer.concat([
    Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420','hex'),
    privDer,
    Buffer.from('a144034200','hex'),
    b64uDec(VAPID_PUBLIC_KEY),
  ]);
  const privKey = crypto.createPrivateKey({ key:pkcs8, format:'der', type:'pkcs8' });
  const sign    = crypto.createSign('SHA256');
  sign.update(sig_in);
  const der = sign.sign(privKey);
  let off = 2; const rLen = der[3]; off = 4;
  const r = der.slice(off, off+rLen); off += rLen+1;
  const sLen = der[off]; off++;
  const s = der.slice(off, off+sLen);
  const pad = n => n.length < 32 ? Buffer.concat([Buffer.alloc(32-n.length),n]) : n.slice(-32);
  return `${sig_in}.${base64url(Buffer.concat([pad(r),pad(s)]))}`;
}

// ── AES-128-GCM payload encryption ───────────────────────────────────────────
async function encryptPayload(plaintext, p256dh, auth) {
  const kp = crypto.generateKeyPairSync('ec', {
    namedCurve:'prime256v1',
    publicKeyEncoding:{type:'spki',format:'der'},
    privateKeyEncoding:{type:'pkcs8',format:'der'},
  });
  const serverPub = kp.publicKey.slice(26);
  const clientPub = b64uDec(p256dh);
  const authSec   = b64uDec(auth);
  const spki      = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200','hex'), clientPub]);
  const ecdh      = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(kp.privateKey.slice(36,68));
  const shared    = ecdh.computeSecret(clientPub);
  function hkdf(salt,ikm,info,len){
    const prk=crypto.createHmac('sha256',salt).update(ikm).digest();
    let buf=Buffer.alloc(len),t=Buffer.alloc(0),off=0;
    for(let i=1;off<len;i++){const h=crypto.createHmac('sha256',prk);h.update(t);h.update(info);h.update(Buffer.from([i]));t=h.digest();t.copy(buf,off);off+=t.length;}
    return buf.slice(0,len);
  }
  const salt = crypto.randomBytes(16);
  function inf(type,cp,sp){return Buffer.concat([Buffer.from(`Content-Encoding: ${type}\0`),Buffer.from('P-256\0'),Buffer.alloc(2),Buffer.from([0,cp.length]),cp,Buffer.alloc(2),Buffer.from([0,sp.length]),sp]);}
  const prk   = hkdf(authSec,shared,Buffer.concat([Buffer.from('Content-Encoding: auth\0'),Buffer.from('P-256')]),32);
  const cek   = hkdf(salt,prk,inf('aesgcm',clientPub,serverPub),16);
  const nonce = hkdf(salt,prk,inf('nonce',clientPub,serverPub),12);
  const ciph  = crypto.createCipheriv('aes-128-gcm',cek,nonce);
  const enc   = Buffer.concat([ciph.update(Buffer.concat([Buffer.alloc(2),Buffer.from(plaintext)])),ciph.final(),ciph.getAuthTag()]);
  return { enc, salt, serverPub };
}

// ── Send one push ─────────────────────────────────────────────────────────────
async function pushOne(sub, payload) {
  const url = new URL(sub.endpoint);
  const jwt = await buildVapidJWT(`${url.protocol}//${url.host}`);
  const { enc, salt, serverPub } = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Encoding': 'aesgcm',
      'Content-Type':     'application/octet-stream',
      'Encryption':       `salt=${base64url(salt)}`,
      'Crypto-Key':       `dh=${base64url(serverPub)}`,
      'TTL':              '86400',
    },
    body: enc,
  });
  return { ok: res.ok, status: res.status };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const isScheduled = !event.httpMethod;
  const secret = (event.queryStringParameters || {}).secret;
  if (!isScheduled && secret !== SETUP_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!VAPID_PRIVATE_KEY || !VAPID_PUBLIC_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'VAPID keys not configured' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Find all incomplete/pending_docs drivers who have push subscriptions
  const { data: rows, error } = await sb
    .from('driver_profiles')
    .select('user_id, status')
    .in('status', ['incomplete', 'pending_docs']);

  if (error) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  }

  const userIds = (rows || []).map(r => r.user_id);
  if (!userIds.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0, reason: 'no_incomplete_drivers' }) };
  }

  const { data: subs, error: subErr } = await sb
    .from('push_subscriptions')
    .select('user_id, endpoint, p256dh, auth')
    .in('user_id', userIds);

  if (subErr) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: subErr.message }) };
  }
  if (!subs || !subs.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0, reason: 'no_push_subscriptions' }) };
  }

  const payload = {
    title: 'Complete your profile 📄',
    body:  'Upload your documents to get verified and start applying for vehicles on TrustMate.',
    url:   '/?tab=dc',
    tag:   'tm-docs-reminder',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  };

  let sent = 0, failed = 0, gone = [];

  for (const sub of subs) {
    try {
      const result = await pushOne(sub, payload);
      if (result.ok) {
        sent++;
      } else if (result.status === 410 || result.status === 404) {
        gone.push(sub.endpoint);
        failed++;
      } else {
        console.error('Push failed', sub.endpoint, result.status);
        failed++;
      }
    } catch (e) {
      console.error('Push error', e.message);
      failed++;
    }
  }

  if (gone.length) {
    await sb.from('push_subscriptions').delete().in('endpoint', gone);
  }

  console.log(`remind-incomplete-drivers: sent=${sent} failed=${failed} expired_removed=${gone.length}`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ sent, failed, expired_removed: gone.length, total_drivers: userIds.length }),
  };
};
