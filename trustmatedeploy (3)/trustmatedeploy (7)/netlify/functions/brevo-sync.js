/**
 * brevo-sync
 * Upserts a single TrustMate user to Brevo as a contact.
 * Called fire-and-forget from the app. Never blocks TrustMate operations.
 * Failed syncs are logged to brevo_sync_failures for manual retry.
 *
 * POST body: { userId: string, eventType: string }
 * Admin single-user sync also accepted.
 */

const { createClient } = require('@supabase/supabase-js');

const BREVO_API_KEY      = process.env.BREVO_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRIVERS_LIST_ID    = parseInt(process.env.BREVO_DRIVERS_LIST_ID || '0') || 0;
const OWNERS_LIST_ID     = parseInt(process.env.BREVO_OWNERS_LIST_ID  || '0') || 0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseName(fullName) {
  if (!fullName || !fullName.trim()) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

// "15 Main St, Sandton, Johannesburg, Gauteng" → { city: 'Johannesburg', province: 'Gauteng' }
function parseLocation(loc) {
  if (!loc) return { city: '', province: '' };
  const parts = loc.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[parts.length - 2], province: parts[parts.length - 1] };
  if (parts.length === 1) return { city: parts[0], province: '' };
  return { city: '', province: '' };
}

function driverAccountStatus(dp, profile) {
  if (profile.is_suspended) return 'Suspended';
  if (profile.is_removed)   return 'Removed';
  if (!dp) return 'Pending';
  const map = {
    incomplete:   'Incomplete',
    pending_docs: 'Pending Documents',
    pending:      'Pending Review',
    approved:     'Approved',
    rejected:     'Rejected',
    removed:      'Removed',
  };
  return map[dp.status] || 'Pending';
}

function ownerAccountStatus(profile) {
  if (profile.is_suspended) return 'Suspended';
  if (profile.is_removed)   return 'Removed';
  const map = {
    pending:    'Pending',
    approved:   'Approved',
    rejected:   'Rejected',
    incomplete: 'Incomplete',
    removed:    'Removed',
  };
  return map[profile.admin_status] || 'Pending';
}

// ── Build all Brevo attributes for a user ────────────────────────────────────

async function buildAttributes(sb, profile) {
  const { first, last } = parseName(profile.full_name);
  const { city, province } = parseLocation(profile.location);
  const role     = profile.role || 'driver';
  const isDriver = role === 'driver' || role === 'both';
  const isOwner  = role === 'owner'  || role === 'both';
  const now      = new Date().toISOString();

  const attrs = {
    // Always present — FIRSTNAME has a safe fallback for personalisation
    FIRSTNAME:      first || 'TrustMate Member',
    LASTNAME:       last  || '',
    ROLE:           role === 'both' ? 'Both' : role === 'owner' ? 'Owner' : 'Driver',
    CITY:           city,
    PROVINCE:       province,
    ACCOUNT_STATUS: 'Pending',
    MATCH_STATUS:   'Unmatched',
    BOOST_STATUS:   'Inactive',
  };

  if (isDriver) {
    const { data: dp } = await sb
      .from('driver_profiles')
      .select('status,user_id')
      .eq('user_id', profile.id)
      .maybeSingle();

    attrs.ACCOUNT_STATUS = driverAccountStatus(dp, profile);
    attrs.DRIVER_STATUS  = dp ? (dp.status || 'unknown') : 'unknown';

    // Active match = application approved + not unmatched
    const { data: dMatch } = await sb
      .from('applications')
      .select('id')
      .eq('driver_id', profile.id)
      .eq('status', 'approved')
      .is('unmatched_at', null)
      .limit(1)
      .maybeSingle();
    attrs.MATCH_STATUS = dMatch ? 'Matched' : 'Unmatched';

    // Boost: must be active status AND end_at in the future
    const { data: dBoost } = await sb
      .from('boosts')
      .select('id,end_at')
      .eq('type', 'driver')
      .eq('target_id', profile.id)
      .eq('status', 'active')
      .gte('end_at', now)
      .limit(1)
      .maybeSingle();
    attrs.BOOST_STATUS = dBoost ? 'Active' : 'Inactive';
  }

  if (isOwner) {
    // For 'both' role, driver status takes precedence for ACCOUNT_STATUS
    if (!isDriver) attrs.ACCOUNT_STATUS = ownerAccountStatus(profile);

    // Vehicle status
    const { data: cars } = await sb
      .from('cars')
      .select('id,admin_status,status')
      .eq('owner_id', profile.id)
      .neq('status', 'removed');

    const approved   = (cars || []).filter(c => c.admin_status === 'approved');
    const available  = approved.filter(c => c.status !== 'rented');
    const rented     = approved.filter(c => c.status === 'rented');

    attrs.HAS_AVAILABLE_VEHICLE = available.length > 0 ? 'Yes' : 'No';
    attrs.HAS_MATCHED_VEHICLE   = rented.length   > 0 ? 'Yes' : 'No';

    if (approved.length === 0)            attrs.VEHICLE_STATUS = 'None';
    else if (available.length > 0)        attrs.VEHICLE_STATUS = 'Available';
    else if (rented.length > 0)           attrs.VEHICLE_STATUS = 'Matched';
    else                                  attrs.VEHICLE_STATUS = 'None';

    // Owner match status
    const { data: oMatch } = await sb
      .from('applications')
      .select('id')
      .eq('owner_id', profile.id)
      .eq('status', 'approved')
      .is('unmatched_at', null)
      .limit(1)
      .maybeSingle();
    if (!isDriver) attrs.MATCH_STATUS = oMatch ? 'Matched' : 'Unmatched';

    // Vehicle boost
    const carIds = (cars || []).map(c => c.id);
    if (carIds.length > 0) {
      const { data: vBoost } = await sb
        .from('boosts')
        .select('id,end_at')
        .eq('type', 'vehicle')
        .in('target_id', carIds)
        .eq('status', 'active')
        .gte('end_at', now)
        .limit(1)
        .maybeSingle();
      if (!isDriver) attrs.BOOST_STATUS = vBoost ? 'Active' : 'Inactive';
    }
  }

  return attrs;
}

// ── Brevo API upsert ─────────────────────────────────────────────────────────

async function upsertBrevoContact(email, attributes, listIds) {
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify({
      email,
      attributes,
      listIds: listIds.filter(Boolean),
      updateEnabled: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo ${res.status}: ${err}`);
  }
}

// ── Failure logging ──────────────────────────────────────────────────────────

async function logFailure(sb, { userId, email, eventType, payload, error }) {
  try {
    // Increment attempts if a pending failure already exists for this user+event
    const { data: existing } = await sb
      .from('brevo_sync_failures')
      .select('id,attempts')
      .eq('user_id', userId)
      .eq('event_type', eventType)
      .eq('sync_status', 'pending')
      .maybeSingle();

    if (existing) {
      await sb.from('brevo_sync_failures').update({
        attempts: (existing.attempts || 1) + 1,
        error: String(error),
        last_attempted_at: new Date().toISOString(),
        payload,
      }).eq('id', existing.id);
    } else {
      await sb.from('brevo_sync_failures').insert({
        user_id: userId,
        email,
        event_type: eventType,
        payload,
        error: String(error),
        attempts: 1,
        last_attempted_at: new Date().toISOString(),
        sync_status: 'pending',
      });
    }
  } catch (e) {
    console.error('brevo-sync: failed to log failure:', e);
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!BREVO_API_KEY) {
    console.error('brevo-sync: BREVO_API_KEY not set');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: false, reason: 'not_configured' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  const { userId, eventType = 'manual' } = body;
  if (!userId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'userId required' }) };

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: profile } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (!profile) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Profile not found' }) };
  if (!profile.email) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No email' }) };

  const role     = profile.role || 'driver';
  const isDriver = role === 'driver' || role === 'both';
  const isOwner  = role === 'owner'  || role === 'both';

  const listIds = [];
  if (isDriver && DRIVERS_LIST_ID) listIds.push(DRIVERS_LIST_ID);
  if (isOwner  && OWNERS_LIST_ID)  listIds.push(OWNERS_LIST_ID);

  let attributes;
  try {
    attributes = await buildAttributes(sb, profile);
  } catch (e) {
    console.error('brevo-sync: buildAttributes error:', e);
    await logFailure(sb, { userId, email: profile.email, eventType, payload: {}, error: e });
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Build failed' }) };
  }

  try {
    await upsertBrevoContact(profile.email, attributes, listIds);
    // Clear any pending failures for this user
    await sb.from('brevo_sync_failures')
      .update({ sync_status: 'resolved' })
      .eq('user_id', userId)
      .eq('sync_status', 'pending');
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true, attributes }) };
  } catch (e) {
    console.error('brevo-sync: upsert failed:', e);
    await logFailure(sb, { userId, email: profile.email, eventType, payload: attributes, error: e });
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Brevo unavailable, logged for retry' }) };
  }
};
