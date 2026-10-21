/**
 * upload-private-doc
 * Verifies the caller's JWT then generates a short-lived signed upload URL.
 * The frontend uses that URL to push the file directly to Supabase Storage,
 * bypassing the RLS policies that block new/unconfirmed users.
 * Uses only SUPABASE_SERVICE_ROLE_KEY — no SUPABASE_ANON_KEY needed.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_BUCKETS = ['driver-id-docs', 'owner-id-docs'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Missing auth token' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[upload-private-doc] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  // Service-role client — auth.getUser(jwt) validates the token without needing SUPABASE_ANON_KEY
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  const user = userData && userData.user;
  if (userErr || !user) {
    console.error('[upload-private-doc] token verification failed:', userErr && userErr.message);
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { bucket, path: storagePath } = body;

  if (!bucket || !storagePath) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'bucket and path required' }) };
  }

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Bucket not allowed' }) };
  }

  if (!storagePath.startsWith(user.id + '/')) {
    return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Path must be in your own folder' }) };
  }

  const { data: signedData, error: signErr } = await sb.storage
    .from(bucket)
    .createSignedUploadUrl(storagePath);

  if (signErr || !signedData) {
    console.error('[upload-private-doc] createSignedUploadUrl error:', signErr && signErr.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: signErr ? signErr.message : 'Failed to create signed URL' })
    };
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({
      signedUrl: signedData.signedUrl,
      token: signedData.token,
      path: storagePath
    })
  };
};
