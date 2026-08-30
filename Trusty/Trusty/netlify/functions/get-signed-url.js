/**
 * get-signed-url
 * Generates short-lived (300s) signed URLs for private Supabase Storage documents.
 * Authorization contexts: 'admin', 'owner_self', 'driver_self', 'matched_owner'
 *
 * POST body: { bucket, path, context }
 * Headers: Authorization: Bearer <user-jwt>
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SIGNED_URL_EXPIRY = 300; // seconds

const ADMIN_ONLY_PATTERNS = ['proof_of_residence', 'criminal_check', 'criminal-check', 'proof-of-residence', 'por-'];

const BUCKET_FOR_CONTEXT = {
  admin:         ['owner-id-docs', 'driver-id-docs'],
  owner_self:    ['owner-id-docs'],
  driver_self:   ['driver-id-docs'],
  matched_owner: ['driver-id-docs'],
};

function errResp(status, msg, logCode) {
  console.info('[doc_access]', JSON.stringify({ event: 'document_access_denied', reason: logCode }));
  return { statusCode: status, headers: CORS_HEADERS, body: JSON.stringify({ error: msg }) };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const { bucket, path: docPath, context } = body;

  if (!bucket || !docPath || !context) {
    return errResp(400, 'Missing required fields', 'missing_fields');
  }

  const allowedBuckets = BUCKET_FOR_CONTEXT[context];
  if (!allowedBuckets || !allowedBuckets.includes(bucket)) {
    return errResp(403, 'Forbidden', 'invalid_bucket_for_context');
  }

  if (docPath.includes('..') || docPath.startsWith('/')) {
    return errResp(400, 'Invalid path', 'invalid_path');
  }

  const authHeader = (event.headers || {})['authorization'] || (event.headers || {})['Authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return errResp(401, 'Unauthorized', 'missing_token');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[get-signed-url] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    return errResp(500, 'Server configuration error', 'missing_env');
  }

  // One service-role client for everything — verify JWT by passing token explicitly
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // auth.getUser(jwt) validates the token and returns the user — works with service role key
  const { data: userData, error: authErr } = await sb.auth.getUser(token);
  const user = userData && userData.user;
  if (authErr || !user) {
    console.error('[get-signed-url] token verification failed:', authErr && authErr.message);
    return errResp(401, 'Unauthorized', 'invalid_token');
  }

  const callerId = user.id;
  console.info('[doc_access]', JSON.stringify({ event: 'document_access_requested', context, callerId_prefix: callerId.slice(0, 8) }));

  // Authorization per context
  if (context === 'admin') {
    const { data: prof, error: profErr } = await sb.from('profiles').select('role,is_admin').eq('id', callerId).single();
    if (profErr || !prof || (prof.role !== 'admin' && !prof.is_admin)) {
      return errResp(403, 'Forbidden', 'not_admin');
    }

  } else if (context === 'owner_self') {
    if (!docPath.startsWith(callerId + '/')) return errResp(403, 'Forbidden', 'path_mismatch');
    const { data: prof } = await sb.from('profiles').select('role').eq('id', callerId).single();
    if (!prof || prof.role !== 'owner') return errResp(403, 'Forbidden', 'not_owner');

  } else if (context === 'driver_self') {
    if (!docPath.startsWith(callerId + '/')) return errResp(403, 'Forbidden', 'path_mismatch');
    const { data: prof } = await sb.from('profiles').select('role').eq('id', callerId).single();
    if (!prof || prof.role !== 'driver') return errResp(403, 'Forbidden', 'not_driver');

  } else if (context === 'matched_owner') {
    for (const pattern of ADMIN_ONLY_PATTERNS) {
      if (docPath.includes(pattern)) return errResp(403, 'Forbidden', 'admin_only_doc');
    }
    const { data: callerProf } = await sb.from('profiles').select('role').eq('id', callerId).single();
    if (!callerProf || callerProf.role !== 'owner') return errResp(403, 'Forbidden', 'caller_not_owner');

    const driverIdFromPath = docPath.split('/')[0];
    if (!driverIdFromPath) return errResp(403, 'Forbidden', 'invalid_path');

    const { data: match, error: matchErr } = await sb
      .from('applications')
      .select('id')
      .eq('owner_id', callerId)
      .eq('driver_id', driverIdFromPath)
      .eq('status', 'approved')
      .is('unmatched_at', null)
      .limit(1)
      .single();

    if (matchErr || !match) return errResp(403, 'Forbidden', 'no_active_match');

  } else {
    return errResp(400, 'Invalid context', 'invalid_context');
  }

  const { data: signedData, error: signedErr } = await sb.storage
    .from(bucket)
    .createSignedUrl(docPath, SIGNED_URL_EXPIRY);

  if (signedErr || !signedData || !signedData.signedUrl) {
    console.error('[get-signed-url] createSignedUrl error:', signedErr && signedErr.message, 'bucket:', bucket, 'path:', docPath);
    return errResp(500, 'Could not generate signed URL', 'signed_url_failed');
  }

  console.info('[doc_access]', JSON.stringify({ event: 'document_access_granted', context, callerId_prefix: callerId.slice(0, 8) }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ signedUrl: signedData.signedUrl, expiresIn: SIGNED_URL_EXPIRY }),
  };
};
