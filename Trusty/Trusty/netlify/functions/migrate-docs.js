/**
 * migrate-docs — one-shot 5-document test migration
 * Protected by MIGRATE_SECRET header.
 * POST /.netlify/functions/migrate-docs
 * Header: x-migrate-secret: <your MIGRATE_SECRET env var value>
 * Body: { "dryRun": false }
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const MIGRATE_SECRET       = process.env.MIGRATE_SECRET;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-migrate-secret',
};

function pathFromUrl(publicUrl, bucket) {
  try {
    const u = new URL(publicUrl);
    const marker = `/public/${bucket}/`;
    const idx = u.pathname.indexOf(marker);
    if (idx === -1) return null;
    return u.pathname.slice(idx + marker.length);
  } catch (e) { return null; }
}

async function migrateOne(sb, { table, idCol, pathCol, srcBucket, dstBucket, recordId, publicUrl, label, dryRun }) {
  const srcPath = pathFromUrl(publicUrl, srcBucket);
  if (!srcPath) {
    console.info('[migration]', JSON.stringify({ event: 'document_migration_failed', label, reason: 'cannot_parse_url', id: recordId.slice(0,8) }));
    return { id: recordId.slice(0,8), label, status: 'failed', reason: 'cannot_parse_url' };
  }
  if (dryRun) return { id: recordId.slice(0,8), label, status: 'dry_run', path: srcPath };

  const { data: fileData, error: dlErr } = await sb.storage.from(srcBucket).download(srcPath);
  if (dlErr || !fileData) {
    console.info('[migration]', JSON.stringify({ event: 'document_migration_failed', label, reason: 'download_failed', id: recordId.slice(0,8) }));
    return { id: recordId.slice(0,8), label, status: 'failed', reason: 'download_failed' };
  }

  const { error: upErr } = await sb.storage.from(dstBucket).upload(srcPath, fileData, { upsert: true });
  if (upErr) {
    console.info('[migration]', JSON.stringify({ event: 'document_migration_failed', label, reason: 'upload_failed', id: recordId.slice(0,8) }));
    return { id: recordId.slice(0,8), label, status: 'failed', reason: 'upload_failed' };
  }

  const { data: verifyData } = await sb.storage.from(dstBucket).createSignedUrl(srcPath, 30);
  if (!verifyData?.signedUrl) {
    console.info('[migration]', JSON.stringify({ event: 'document_migration_failed', label, reason: 'verify_failed', id: recordId.slice(0,8) }));
    return { id: recordId.slice(0,8), label, status: 'failed', reason: 'verify_failed' };
  }

  const upd = {}; upd[pathCol] = srcPath;
  const { error: dbErr } = await sb.from(table).update(upd).eq(idCol, recordId);
  if (dbErr) {
    console.info('[migration]', JSON.stringify({ event: 'document_migration_failed', label, reason: 'db_update_failed', id: recordId.slice(0,8) }));
    return { id: recordId.slice(0,8), label, status: 'failed', reason: 'db_update_failed' };
  }

  console.info('[migration]', JSON.stringify({ event: 'document_migration_succeeded', label, id: recordId.slice(0,8) }));
  return { id: recordId.slice(0,8), label, status: 'migrated' };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const secret = (event.headers || {})['x-migrate-secret'] || '';
  if (!MIGRATE_SECRET || secret !== MIGRATE_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden' }) };
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  let dryRun = false;
  try { dryRun = !!(JSON.parse(event.body || '{}').dryRun); } catch (e) {}

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: owners, error: owErr } = await sb.from('profiles')
    .select('id, doc_id_url')
    .in('role', ['owner', 'both'])
    .not('doc_id_url', 'is', null)
    .is('doc_id_path', null)
    .limit(3);
  if (owErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Owner query failed', detail: owErr.message }) };

  const { data: drivers, error: drErr } = await sb.from('driver_profiles')
    .select('user_id, doc_id_url')
    .not('doc_id_url', 'is', null)
    .is('doc_id_path', null)
    .limit(2);
  if (drErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Driver query failed', detail: drErr.message }) };

  const results = [];

  for (const o of (owners || [])) {
    results.push(await migrateOne(sb, {
      table: 'profiles', idCol: 'id', pathCol: 'doc_id_path',
      srcBucket: 'profile-photos', dstBucket: 'owner-id-docs',
      recordId: o.id, publicUrl: o.doc_id_url, label: 'Owner ID', dryRun,
    }));
  }

  for (const d of (drivers || [])) {
    results.push(await migrateOne(sb, {
      table: 'driver_profiles', idCol: 'user_id', pathCol: 'doc_id_path',
      srcBucket: 'driver-docs', dstBucket: 'driver-id-docs',
      recordId: d.user_id, publicUrl: d.doc_id_url, label: 'Driver ID', dryRun,
    }));
  }

  const migrated = results.filter(r => r.status === 'migrated').length;
  const failed   = results.filter(r => r.status === 'failed').length;

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun, owners_found: (owners||[]).length, drivers_found: (drivers||[]).length, total: results.length, migrated, failed, results }, null, 2),
  };
};
