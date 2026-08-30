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

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing auth token' }) };
  }

  // Verify the caller's JWT by making a request as that user.
  // Pass the token as Authorization header on a service-role client — Supabase
  // will resolve auth.uid() from the token while the service key grants admin access.
  const sbVerify = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error: userErr } = await sbVerify.auth.getUser();

  if (userErr || !user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { bucket, path: storagePath } = body;

  if (!bucket || !storagePath) {
    return { statusCode: 400, body: JSON.stringify({ error: 'bucket and path required' }) };
  }

  if (!ALLOWED_BUCKETS.includes(bucket)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Bucket not allowed' }) };
  }

  if (!storagePath.startsWith(user.id + '/')) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Path must be in your own folder' }) };
  }

  // Service-role client for the actual signed URL generation (no user token header)
  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: signedData, error: signErr } = await sbAdmin.storage
    .from(bucket)
    .createSignedUploadUrl(storagePath);

  if (signErr || !signedData) {
    console.error('createSignedUploadUrl error:', signErr && signErr.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: signErr ? signErr.message : 'Failed to create signed URL' })
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      signedUrl: signedData.signedUrl,
      token: signedData.token,
      path: storagePath
    })
  };
};
