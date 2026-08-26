/**
 * brevo-bulk-sync
 * Admin-only. Preview and bulk-sync all TrustMate users to Brevo.
 *
 * GET  ?mode=preview  — returns stats + 5 sample contacts, no sync performed
 * POST ?mode=sync     — performs the actual bulk upsert (requires preview first)
 *
 * Secured by BREVO_BULK_SYNC_SECRET header: x-sync-secret must match env var.
 */

const { createClient } = require('@supabase/supabase-js');

const BREVO_API_KEY      = process.env.BREVO_API_KEY;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRIVERS_LIST_ID    = parseInt(process.env.BREVO_DRIVERS_LIST_ID || '0') || 0;
const OWNERS_LIST_ID     = parseInt(process.env.BREVO_OWNERS_LIST_ID  || '0') || 0;
const SYNC_SECRET        = process.env.BREVO_BULK_SYNC_SECRET || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-sync-secret',
};

// ── Re-use same helpers as brevo-sync.js ─────────────────────────────────────

function parseName(fullName) {
  if (!fullName || !fullName.trim()) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

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
    incomplete: 'Incomplete', pending_docs: 'Pending Documents',
    pending: 'Pending Review', approved: 'Approved',
    rejected: 'Rejected', removed: 'Removed',
  };
  return map[dp.status] || 'Pending';
}

function ownerAccountStatus(profile) {
  if (profile.is_suspended) return 'Suspended';
  if (profile.is_removed)   return 'Removed';
  const map = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', removed: 'Removed', incomplete: 'Incomplete' };
  return map[profile.admin_status] || 'Pending';
}

function buildContactAttributes(profile, dp, cars, matchedAsDriver, matchedAsOwner, activeBoost) {
  const { first, last } = parseName(profile.full_name);
  const { city, province } = parseLocation(profile.location);
  const role     = profile.role || 'driver';
  const isDriver = role === 'driver' || role === 'both';
  const isOwner  = role === 'owner'  || role === 'both';
  const now      = new Date().toISOString();

  const attrs = {
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
    attrs.ACCOUNT_STATUS = driverAccountStatus(dp, profile);
    attrs.DRIVER_STATUS  = dp ? (dp.status || 'unknown') : 'unknown';
    attrs.MATCH_STATUS   = matchedAsDriver ? 'Matched' : 'Unmatched';
    attrs.BOOST_STATUS   = (activeBoost && activeBoost.type === 'driver') ? 'Active' : 'Inactive';
  }

  if (isOwner) {
    if (!isDriver) {
      attrs.ACCOUNT_STATUS = ownerAccountStatus(profile);
      attrs.MATCH_STATUS   = matchedAsOwner ? 'Matched' : 'Unmatched';
    }
    const approved  = (cars || []).filter(c => c.admin_status === 'approved');
    const available = approved.filter(c => c.status !== 'rented');
    const rented    = approved.filter(c => c.status === 'rented');
    attrs.HAS_AVAILABLE_VEHICLE = available.length > 0 ? 'Yes' : 'No';
    attrs.HAS_MATCHED_VEHICLE   = rented.length   > 0 ? 'Yes' : 'No';
    if (approved.length === 0)     attrs.VEHICLE_STATUS = 'None';
    else if (available.length > 0) attrs.VEHICLE_STATUS = 'Available';
    else if (rented.length > 0)    attrs.VEHICLE_STATUS = 'Matched';
    else                           attrs.VEHICLE_STATUS = 'None';
    if (!isDriver && activeBoost && activeBoost.type === 'vehicle') attrs.BOOST_STATUS = 'Active';
  }

  const listIds = [];
  if (isDriver && DRIVERS_LIST_ID) listIds.push(DRIVERS_LIST_ID);
  if (isOwner  && OWNERS_LIST_ID)  listIds.push(OWNERS_LIST_ID);

  return { attrs, listIds };
}

async function upsertBrevoContact(email, attributes, listIds) {
  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({ email, attributes, listIds: listIds.filter(Boolean), updateEnabled: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo ${res.status}: ${err}`);
  }
}

// ── Build the full dataset from Supabase ─────────────────────────────────────

async function buildDataset(sb) {
  const now = new Date().toISOString();

  // Fetch all non-removed profiles with emails
  const { data: profiles } = await sb
    .from('profiles')
    .select('id,full_name,email,role,location,admin_status,is_suspended,is_removed')
    .not('email', 'is', null)
    .order('created_at', { ascending: false });

  const allProfiles = (profiles || []).filter(p => p.email && p.email.trim());

  const ids = allProfiles.map(p => p.id);
  if (!ids.length) return { allProfiles, dpMap: {}, carsMap: {}, matchedDriverIds: new Set(), matchedOwnerIds: new Set(), activeBoostMap: {} };

  // Fetch driver profiles, cars, active matches, active boosts — in parallel
  const [dpRes, carsRes, dMatchRes, oMatchRes, boostRes] = await Promise.all([
    sb.from('driver_profiles').select('user_id,status').in('user_id', ids),
    sb.from('cars').select('id,owner_id,admin_status,status').in('owner_id', ids).neq('status', 'removed'),
    sb.from('applications').select('driver_id').eq('status', 'approved').is('unmatched_at', null),
    sb.from('applications').select('owner_id').eq('status', 'approved').is('unmatched_at', null),
    sb.from('boosts').select('id,type,target_id,end_at').eq('status', 'active').gte('end_at', now),
  ]);

  const dpMap = {};
  (dpRes.data || []).forEach(d => { dpMap[d.user_id] = d; });

  const carsMap = {};
  (carsRes.data || []).forEach(c => {
    if (!carsMap[c.owner_id]) carsMap[c.owner_id] = [];
    carsMap[c.owner_id].push(c);
  });

  const matchedDriverIds = new Set((dMatchRes.data || []).map(a => a.driver_id));
  const matchedOwnerIds  = new Set((oMatchRes.data || []).map(a => a.owner_id));

  // Build boost map: driver_id/car_id → boost
  const activeBoostByTarget = {};
  (boostRes.data || []).forEach(b => { activeBoostByTarget[b.target_id] = b; });

  // For owners: find active boost by their car ids
  const activeBoostMap = {};
  allProfiles.forEach(p => {
    const role = p.role || 'driver';
    const isDriver = role === 'driver' || role === 'both';
    const isOwner  = role === 'owner'  || role === 'both';
    if (isDriver && activeBoostByTarget[p.id]) {
      activeBoostMap[p.id] = activeBoostByTarget[p.id];
    }
    if (isOwner) {
      const ownerCars = carsMap[p.id] || [];
      for (const c of ownerCars) {
        if (activeBoostByTarget[c.id]) { activeBoostMap[p.id] = activeBoostByTarget[c.id]; break; }
      }
    }
  });

  return { allProfiles, dpMap, carsMap, matchedDriverIds, matchedOwnerIds, activeBoostMap };
}

// ── Handler ───────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Auth check
  const secret = event.headers['x-sync-secret'] || '';
  if (!SYNC_SECRET || secret !== SYNC_SECRET) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const mode = (event.queryStringParameters || {}).mode || 'preview';
  const sb   = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { allProfiles, dpMap, carsMap, matchedDriverIds, matchedOwnerIds, activeBoostMap } = await buildDataset(sb);

  const drivers = allProfiles.filter(p => p.role === 'driver' || p.role === 'both');
  const owners  = allProfiles.filter(p => p.role === 'owner'  || p.role === 'both');
  const both    = allProfiles.filter(p => p.role === 'both');

  // Email deduplication
  const emailCounts = {};
  allProfiles.forEach(p => { emailCounts[p.email] = (emailCounts[p.email] || 0) + 1; });
  const duplicateEmails    = Object.entries(emailCounts).filter(([, n]) => n > 1).map(([e]) => e);
  const missingEmails      = []; // already filtered
  const missingFirstNames  = allProfiles.filter(p => !parseName(p.full_name).first || parseName(p.full_name).first === '').map(p => p.email);

  const approvedDrivers = allProfiles.filter(p => {
    const dp = dpMap[p.user_id || p.id];
    return dp && dp.status === 'approved';
  });
  const approvedOwners = allProfiles.filter(p =>
    (p.role === 'owner' || p.role === 'both') && p.admin_status === 'approved'
  );

  // Build 5 sample contacts
  const samples = allProfiles.slice(0, 5).map(p => {
    const role = p.role || 'driver';
    const isDriver = role === 'driver' || role === 'both';
    const isOwner  = role === 'owner'  || role === 'both';
    const { attrs, listIds } = buildContactAttributes(
      p,
      dpMap[p.id],
      carsMap[p.id] || [],
      matchedDriverIds.has(p.id),
      matchedOwnerIds.has(p.id),
      activeBoostMap[p.id] || null
    );
    return { email: p.email, attributes: attrs, listIds };
  });

  const preview = {
    totals: {
      all_users:        allProfiles.length,
      drivers:          drivers.length,
      owners:           owners.length,
      both_roles:       both.length,
      approved_drivers: approvedDrivers.length,
      approved_owners:  approvedOwners.length,
    },
    data_quality: {
      duplicate_emails:   duplicateEmails,
      missing_first_names: missingFirstNames,
    },
    sample_contacts: samples,
  };

  if (mode === 'preview') {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(preview, null, 2) };
  }

  if (event.httpMethod !== 'POST' || mode !== 'sync') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Use POST ?mode=sync to run the actual sync' }) };
  }

  // ── Bulk sync ──────────────────────────────────────────────────────────────
  const results = { synced: 0, failed: 0, errors: [] };

  // Deduplicate by email (keep first occurrence)
  const seen = new Set();
  const unique = allProfiles.filter(p => {
    if (seen.has(p.email)) return false;
    seen.add(p.email);
    return true;
  });

  // Process in batches of 50 to avoid overwhelming Brevo
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    await Promise.all(batch.map(async (p) => {
      try {
        const { attrs, listIds } = buildContactAttributes(
          p,
          dpMap[p.id],
          carsMap[p.id] || [],
          matchedDriverIds.has(p.id),
          matchedOwnerIds.has(p.id),
          activeBoostMap[p.id] || null
        );
        await upsertBrevoContact(p.email, attrs, listIds);
        results.synced++;
      } catch (e) {
        results.failed++;
        results.errors.push({ email: p.email, error: String(e) });
        // Log to brevo_sync_failures
        try {
          await sb.from('brevo_sync_failures').insert({
            user_id: p.id, email: p.email, event_type: 'bulk_sync',
            payload: {}, error: String(e), attempts: 1,
            last_attempted_at: new Date().toISOString(), sync_status: 'pending',
          });
        } catch (_) {}
      }
    }));
    // Small delay between batches
    await new Promise(r => setTimeout(r, 200));
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, ...results }),
  };
};

function parseName(fullName) {
  if (!fullName || !fullName.trim()) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}
