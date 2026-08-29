/**
 * migrate-docs
 * Admin-only utility: copies documents from public buckets to private buckets,
 * updates _path columns in DB, and verifies the copy via signed URL.
 *
 * POST body: { doc_type, limit }
 *   doc_type: 'owner_id' | 'driver_id' | 'driver_license' | 'driver_pdp' |
 *             'driver_holding_id' | 'driver_fullbody' | 'proof_of_residence' | 'criminal_check'
 *   limit: number (max 10 for safety)
 *
 * Returns: { migrated, skipped, failed, results[] }
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Document type configuration
const DOC_CONFIGS = {
  owner_id: {
    table: 'profiles',
    url_col: 'doc_id_url',
    path_col: 'doc_id_path',
    src_bucket: 'profile-photos',
    dst_bucket: 'owner-id-docs',
    id_col: 'id',
    role_filter: { col: 'role', val: 'owner' },
  },
  driver_id: {
    table: 'driver_profiles',
    url_col: 'doc_id_url',
    path_col: 'doc_id_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  driver_license: {
    table: 'driver_profiles',
    url_col: 'doc_license_url',
    path_col: 'doc_license_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  driver_license_back: {
    table: 'driver_profiles',
    url_col: 'doc_license_back_url',
    path_col: 'doc_license_back_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  driver_pdp: {
    table: 'driver_profiles',
    url_col: 'pdp_url',
    path_col: 'pdp_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  driver_holding_id: {
    table: 'driver_profiles',
    url_col: 'photo_holding_id_url',
    path_col: 'photo_holding_id_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  driver_fullbody: {
    table: 'driver_profiles',
    url_col: 'photo_fullbody_url',
    path_col: 'photo_fullbody_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  proof_of_residence: {
    table: 'driver_profiles',
    url_col: 'proof_of_residence_url',
    path_col: 'proof_of_residence_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
  criminal_check: {
    table: 'driver_profiles',
    url_col: 'criminal_check_url',
    path_col: 'criminal_check_path',
    src_bucket: 'driver-docs',
    dst_bucket: 'driver-id-docs',
    id_col: 'user_id',
  },
};

// Extract storage path from a public URL
function pathFromUrl(url, bucket) {
  try {
    const u = new URL(url);
    // Supabase public URL: /storage/v1/object/public/<bucket>/<path>
    const marker = `/public/${bucket}/`;
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    return u.pathname.slice(idx + marker.length);
  } catch (e) {
    return null;
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: 'Method not allowed' };

  const authHeader = (event.headers || {})['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const sbAnon = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // Verify caller is admin
  const { data: { user } } = await sbAnon.auth.getUser(token);
  if (!user) return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).single();
  if (!prof || prof.role !== 'admin') return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Forbidden' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const { doc_type, limit: rawLimit } = body;
  const limit = Math.min(parseInt(rawLimit) || 5, 10); // hard cap at 10

  const cfg = DOC_CONFIGS[doc_type];
  if (!cfg) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid doc_type' }) };

  // Fetch records that have a URL but no path yet
  let query = sb.from(cfg.table)
    .select(`${cfg.id_col}, ${cfg.url_col}, ${cfg.path_col}`)
    .not(cfg.url_col, 'is', null)
    .is(cfg.path_col, null)
    .limit(limit);
  if (cfg.role_filter) query = query.eq(cfg.role_filter.col, cfg.role_filter.val);

  const { data: rows, error: fetchErr } = await query;
  if (fetchErr) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: fetchErr.message }) };

  const results = [];
  let migrated = 0, skipped = 0, failed = 0;

  for (const row of (rows || [])) {
    const recordId = row[cfg.id_col];
    const publicUrl = row[cfg.url_col];
    if (!publicUrl) { skipped++; continue; }

    const srcPath = pathFromUrl(publicUrl, cfg.src_bucket);
    if (!srcPath) {
      console.info('[doc_migration]', JSON.stringify({ event: 'document_migration_failed', doc_type, reason: 'cannot_parse_url' }));
      results.push({ id: recordId, status: 'failed', reason: 'cannot_parse_url' });
      failed++; continue;
    }

    // Download from public source bucket
    const { data: fileData, error: dlErr } = await sb.storage.from(cfg.src_bucket).download(srcPath);
    if (dlErr || !fileData) {
      console.info('[doc_migration]', JSON.stringify({ event: 'document_migration_failed', doc_type, reason: 'download_failed' }));
      results.push({ id: recordId, status: 'failed', reason: 'download_failed' });
      failed++; continue;
    }

    // Upload to private destination bucket using same path structure
    const { error: upErr } = await sb.storage.from(cfg.dst_bucket).upload(srcPath, fileData, { upsert: true });
    if (upErr) {
      console.info('[doc_migration]', JSON.stringify({ event: 'document_migration_failed', doc_type, reason: 'upload_failed' }));
      results.push({ id: recordId, status: 'failed', reason: 'upload_failed' });
      failed++; continue;
    }

    // Verify via signed URL
    const { data: verifyData } = await sb.storage.from(cfg.dst_bucket).createSignedUrl(srcPath, 30);
    if (!verifyData || !verifyData.signedUrl) {
      console.info('[doc_migration]', JSON.stringify({ event: 'document_migration_failed', doc_type, reason: 'verify_failed' }));
      results.push({ id: recordId, status: 'failed', reason: 'verify_failed' });
      failed++; continue;
    }

    // Update DB with new path
    const upd = {}; upd[cfg.path_col] = srcPath;
    const { error: dbErr } = await sb.from(cfg.table).update(upd).eq(cfg.id_col, recordId);
    if (dbErr) {
      console.info('[doc_migration]', JSON.stringify({ event: 'document_migration_failed', doc_type, reason: 'db_update_failed' }));
      results.push({ id: recordId, status: 'failed', reason: 'db_update_failed' });
      failed++; continue;
    }

    console.info('[doc_migration]', JSON.stringify({ event: 'document_migration_succeeded', doc_type }));
    results.push({ id: recordId, status: 'migrated' });
    migrated++;
  }

  return {
    statusCode: 200,
    headers: CORS_HEADERS,
    body: JSON.stringify({ migrated, skipped, failed, total: rows.length, results }),
  };
};
