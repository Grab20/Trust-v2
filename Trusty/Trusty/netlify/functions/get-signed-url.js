/**
 * get-signed-url
 * Generates short-lived (300s) signed URLs for private Supabase Storage documents.
 * Authorization contexts: 'admin', 'owner_self', 'matched_owner'
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

// Documents only admin may view — never matched-owner
const ADMIN_ONLY_PATTERNS = ['proof_of_residence', 'criminal_check', 'criminal-check', 'proof-of-residence'];

// Fix 1: Allowed buckets per context — prevents cross-context bucket access
const BUCKET_FOR_CONTEXT = {
  admin:         ['owner-id-docs', 'driver-id-docs'],
  owner_self:    ['owner-id-docs'],
  driver_self:   ['driver-id-docs'],
  matched_owner: ['driver-id-docs'],
};

function err(status, msg, logCode) {
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

  // --- Parse request ---
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const { bucket, path: docPath, context } = body;

  if (!bucket || !docPath || !context) {
    return err(400, 'Missing required fields', 'missing_fields');
  }

  // Fix 1: Validate bucket is allowed for this context
  const allowedBuckets = BUCKET_FOR_CONTEXT[context];
  if (!allowedBuckets || !allowedBuckets.includes(bucket)) {
    return err(403, 'Forbidden', 'invalid_bucket_for_context');
  }

  // Fix 2: Path traversal protection
  if (!docPath || docPath.includes('..') || docPath.startsWith('/')) {
    return err(400, 'Invalid path', 'invalid_path');
  }

  // --- Validate caller JWT ---
  const authHeader = (event.headers || {})['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return err(401, 'Unauthorized', 'missing_token');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[get-signed-url] Missing env vars');
    return err(500, 'Server configuration error', 'missing_env');
  }

  const sbService = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Verify JWT using service role client with user token — no SUPABASE_ANON_KEY needed
  const sbVerify = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error: authErr } = await sbVerify.auth.getUser();
  if (authErr || !user) return err(401, 'Unauthorized', 'invalid_token');

  const callerId = user.id;
  console.info('[doc_access]', JSON.stringify({ event: 'document_access_requested', context, callerId_prefix: callerId.slice(0,8) }));

  // --- Authorization ---
  if (context === 'admin') {
    // Verify caller has admin role
    const { data: prof, error: profErr } = await sbService.from('profiles').select('role').eq('id', callerId).single();
    if (profErr || !prof || prof.role !== 'admin') return err(403, 'Forbidden', 'not_admin');

  } else if (context === 'owner_self') {
    // Owner viewing their own document — path must start with their UID
    if (!docPath.startsWith(callerId + '/')) return err(403, 'Forbidden', 'path_mismatch');
    // Verify caller is owner role
    const { data: prof } = await sbService.from('profiles').select('role').eq('id', callerId).single();
    if (!prof || prof.role !== 'owner') return err(403, 'Forbidden', 'not_owner');

  } else if (context === 'driver_self') {
    // Driver viewing their own document — path must start with their UID
    if (!docPath.startsWith(callerId + '/')) return err(403, 'Forbidden', 'path_mismatch');
    // Verify caller is driver role
    const { data: prof } = await sbService.from('profiles').select('role').eq('id', callerId).single();
    if (!prof || prof.role !== 'driver') return err(403, 'Forbidden', 'not_driver');

  } else if (context === 'matched_owner') {
    // Matched owner viewing a matched driver's verification documents
    // Block admin-only document types regardless
    for (const pattern of ADMIN_ONLY_PATTERNS) {
      if (docPath.includes(pattern)) return err(403, 'Forbidden', 'admin_only_doc');
    }

    // Caller must be owner role
    const { data: callerProf } = await sbService.from('profiles').select('role').eq('id', callerId).single();
    if (!callerProf || callerProf.role !== 'owner') return err(403, 'Forbidden', 'caller_not_owner');

    // Extract driver UID from path (first segment)
    const driverIdFromPath = docPath.split('/')[0];
    if (!driverIdFromPath) return err(403, 'Forbidden', 'invalid_path');

    // Verify active match between this owner and the driver
    const { data: match, error: matchErr } = await sbService
      .from('applications')
      .select('id')
      .eq('owner_id', callerId)
      .eq('driver_id', driverIdFromPath)
      .eq('status', 'approved')
      .is('unmatched_at', null)
      .limit(1)
      .single();

    if (matchErr || !match) return err(403, 'Forbidden', 'no_active_match');

  } else {
    return err(400, 'Invalid context', 'invalid_context');
  }

  // --- Generate signed URL ---
  const { data: signedData, error: signedErr } = await sbService.storage
    .from(bucket)
    .createSignedUrl(docPath, SIGNED_URL_EXPIRY);

  if (signedErr || !signedData || !signedData.signedUrl) {
    console.error('[get-signed-url] createSignedUrl error:', signedErr && signedErr.message);
    return err(500, 'Could not generate signed URL', 'signed_url_failed');
  }

  console.info('[doc_access]', JSON.stringify({ event: 'document_access_granted', context, callerId_prefix: callerId.slice(0,8) }));

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ signedUrl: signedData.signedUrl, expiresIn: SIGNED_URL_EXPIRY }),
  };
};
