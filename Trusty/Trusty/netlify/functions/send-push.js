/**
 * send-push
 * Sends a Web Push notification to one or more users.
 *
 * POST body:
 *   { user_ids: string[], title: string, body: string, url?: string, tag?: string }
 *   OR
 *   { user_id: string, title, body, url?, tag? }
 *
 * Called internally by other functions (match email, trust actions, etc.)
 * or directly from the admin panel.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPID_PUBLIC_KEY     = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY    = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT        = process.env.VAPID_SUBJECT || 'mailto:hello@trustmate.co.za';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

// ── VAPID JWT helpers ─────────────────────────────────────────────────────────
function base64url(buf) {
  return (Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

async function buildVapidJWT(audience) {
  const header  = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = base64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200, // 12 hours
    sub: VAPID_SUBJECT,
  }));
  const sigInput = `${header}.${payload}`;
  const privDer  = base64urlDecode(VAPID_PRIVATE_KEY);

  // Rebuild PKCS8 DER for P-256 private key from raw 32 bytes
  const pkcs8Header = Buffer.from(
    '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420',
    'hex'
  );
  const pkcs8Footer = Buffer.from('a144034200', 'hex');
  const pubKeyBytes = base64urlDecode(VAPID_PUBLIC_KEY); // 65-byte uncompressed point
  const pkcs8 = Buffer.concat([pkcs8Header, privDer, pkcs8Footer, pubKeyBytes]);

  const privateKeyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sign = crypto.createSign('SHA256');
  sign.update(sigInput);
  const derSig = sign.sign(privateKeyObj);

  // DER → raw 64-byte signature (r + s)
  let offset = 2;
  const rLen = derSig[3]; offset = 4;
  const r = derSig.slice(offset, offset + rLen); offset += rLen + 1;
  const sLen = derSig[offset]; offset++;
  const s = derSig.slice(offset, offset + sLen);
  const pad = n => n.length < 32 ? Buffer.concat([Buffer.alloc(32 - n.length), n]) : n.slice(-32);
  const rawSig = Buffer.concat([pad(r), pad(s)]);

  return `${sigInput}.${base64url(rawSig)}`;
}

// ── AES-128-GCM encryption for push payload ───────────────────────────────────
async function encryptPayload(plaintext, p256dh, auth) {
  const serverKeyPair = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const serverPublicRaw  = serverKeyPair.publicKey.slice(26);  // 65-byte uncompressed
  const clientPublicRaw  = base64urlDecode(p256dh);
  const authSecret       = base64urlDecode(auth);

  // Reconstruct client public key as KeyObject
  const spkiHeader = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const clientSpki = Buffer.concat([spkiHeader, clientPublicRaw]);
  const clientPublicKey = crypto.createPublicKey({ key: clientSpki, format: 'der', type: 'spki' });

  const serverPrivateKey = crypto.createPrivateKey({
    key: serverKeyPair.privateKey, format: 'der', type: 'pkcs8'
  });

  // ECDH shared secret
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(serverKeyPair.privateKey.slice(36, 68));
  const sharedSecret = ecdh.computeSecret(clientPublicRaw);

  // HKDF-SHA256 key derivation (RFC8291)
  function hkdf(salt, ikm, info, length) {
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    const buf = Buffer.alloc(length);
    let t = Buffer.alloc(0); let offset = 0;
    for (let i = 1; offset < length; i++) {
      const hmac = crypto.createHmac('sha256', prk);
      hmac.update(t); hmac.update(info); hmac.update(Buffer.from([i]));
      t = hmac.digest();
      t.copy(buf, offset);
      offset += t.length;
    }
    return buf.slice(0, length);
  }

  const salt = crypto.randomBytes(16);

  function buildInfo(type, clientPub, serverPub) {
    return Buffer.concat([
      Buffer.from(`Content-Encoding: ${type}\0`),
      Buffer.from('P-256\0'),
      Buffer.alloc(2), Buffer.from([0, clientPub.length]), clientPub,
      Buffer.alloc(2), Buffer.from([0, serverPub.length]), serverPub,
    ]);
  }

  const prk   = hkdf(authSecret, sharedSecret,
    Buffer.concat([Buffer.from('Content-Encoding: auth\0'), Buffer.from('P-256')]), 32);
  const cek   = hkdf(salt, prk, buildInfo('aesgcm', clientPublicRaw, serverPublicRaw), 16);
  const nonce = hkdf(salt, prk, buildInfo('nonce',  clientPublicRaw, serverPublicRaw), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const padded = Buffer.concat([Buffer.alloc(2), Buffer.from(plaintext)]);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  return { encrypted, salt, serverPublicRaw };
}

// ── Send a single Web Push request ───────────────────────────────────────────
async function sendWebPush(subscription, payload) {
  const endpoint = subscription.endpoint;
  const urlObj   = new URL(endpoint);
  const audience = `${urlObj.protocol}//${urlObj.host}`;
  const jwt      = await buildVapidJWT(audience);
  const vapidPub = VAPID_PUBLIC_KEY;

  const { encrypted, salt, serverPublicRaw } = await encryptPayload(
    JSON.stringify(payload), subscription.p256dh, subscription.auth
  );

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':    `vapid t=${jwt},k=${vapidPub}`,
      'Content-Encoding': 'aesgcm',
      'Content-Type':     'application/octet-stream',
      'Encryption':       `salt=${base64url(salt)}`,
      'Crypto-Key':       `dh=${base64url(serverPublicRaw)}`,
      'TTL':              '86400',
    },
    body: encrypted,
  });

  return { ok: res.ok, status: res.status };
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.error('Missing env vars for send-push');
    return { statusCode: 500, headers: CORS, body: 'Config error' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, headers: CORS, body: 'Invalid JSON' };
  }

  const { title, body: msgBody, url = '/', tag = 'tm-general' } = body;
  const userIds = body.user_ids || (body.user_id ? [body.user_id] : []);

  if (!title || !msgBody || !userIds.length) {
    return { statusCode: 400, headers: CORS, body: 'Missing title, body, or user_id(s)' };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: subs, error } = await sb
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .in('user_id', userIds);

  if (error) {
    console.error('DB error:', error);
    return { statusCode: 500, headers: CORS, body: 'DB error' };
  }
  if (!subs || !subs.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0, reason: 'no_subscriptions' }) };
  }

  const payload = { title, body: msgBody, url, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' };
  let sent = 0, failed = 0, gone = [];

  for (const sub of subs) {
    try {
      const result = await sendWebPush(sub, payload);
      if (result.ok) {
        sent++;
      } else if (result.status === 410 || result.status === 404) {
        // Subscription expired — clean it up
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

  // Remove expired subscriptions
  if (gone.length) {
    await sb.from('push_subscriptions').delete().in('endpoint', gone);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify({ sent, failed }),
  };
};
