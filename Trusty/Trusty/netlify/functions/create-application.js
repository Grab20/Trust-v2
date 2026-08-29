/**
 * create-application
 * Server-side application creation with B/N driver enforcement.
 * All limit checks happen here so they cannot be bypassed by the frontend.
 *
 * POST /.netlify/functions/create-application
 * Authorization: Bearer <supabase JWT>
 * Body: { owner_id, car_id?, message?, counter_price? }
 *
 * Returns: { id: application_id } on success
 *          { error: string, code?: string } on failure
 *   code 'BN_LIMIT_FREE'  → free quota exhausted (show upgrade prompt)
 *   code 'BN_LIMIT_SPAM'  → paid anti-spam (4/day) hit
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Anon key used only to verify the caller's JWT
const SUPABASE_ANON_KEY    = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

const FREE_APPS_PER_WEEK = 3;
const PAID_APPS_PER_DAY  = 4;

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };
}

function resp(statusCode, body) {
  return { statusCode, headers: cors(), body: JSON.stringify(body) };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST')    return resp(405, { error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return resp(500, { error: 'Server configuration error' });
  }

  // ── Authenticate caller via JWT ───────────────────────────────
  const authHeader = (event.headers || {})['authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return resp(401, { error: 'Missing Authorization header' });

  // Use anon client to get user from JWT
  const sbAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY || SUPABASE_SERVICE_KEY);
  const { data: { user }, error: authErr } = await sbAnon.auth.getUser(jwt);
  if (authErr || !user) return resp(401, { error: 'Invalid or expired token' });

  const callerId = user.id;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return resp(400, { error: 'Invalid JSON' });
  }

  const { owner_id, car_id, message, counter_price } = body;
  if (!owner_id) return resp(400, { error: 'Missing owner_id' });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Load driver profile ───────────────────────────────────────
  const { data: dp, error: dpErr } = await sb
    .from('driver_profiles')
    .select('*')
    .eq('user_id', callerId)
    .maybeSingle();

  if (dpErr || !dp) return resp(400, { error: 'Driver profile not found' });
  if (dp.status !== 'approved') return resp(403, { error: 'Your profile must be approved before you can apply.' });

  // ── Determine if caller is a B/N driver ──────────────────────
  const isBN = !parseInt(dp.uber_trips    || 0)
            && !parseInt(dp.bolt_trips    || 0)
            && !parseInt(dp.indrive_trips || 0)
            && !parseInt(dp.self_uber_trips    || 0)
            && !parseInt(dp.self_bolt_trips    || 0)
            && !parseInt(dp.self_indrive_trips || 0);

  if (isBN) {
    const now = new Date();

    // Check for active paid entitlement
    const { data: ent } = await sb
      .from('bn_entitlements')
      .select('id, expires_at')
      .eq('driver_id', callerId)
      .eq('status', 'active')
      .lte('starts_at', now.toISOString())
      .gte('expires_at', now.toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ent) {
      // Paid plan: enforce 4 applications/day anti-spam
      const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      const { count: dayCount } = await sb
        .from('applications')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', callerId)
        .eq('initiated_by', 'driver')
        .gte('created_at', dayAgo);

      if ((dayCount || 0) >= PAID_APPS_PER_DAY) {
        return resp(429, {
          error: 'You have reached the daily application limit (4/day). Try again tomorrow.',
          code: 'BN_LIMIT_SPAM',
        });
      }
    } else {
      // Free plan: enforce 3 applications per 7-day rolling window
      const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
      const { count: weekCount } = await sb
        .from('applications')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', callerId)
        .eq('initiated_by', 'driver')
        .gte('created_at', weekAgo);

      if ((weekCount || 0) >= FREE_APPS_PER_WEEK) {
        return resp(429, {
          error: 'You have used all 3 free applications this week. Upgrade to send unlimited applications.',
          code: 'BN_LIMIT_FREE',
        });
      }
    }
  }

  // ── Duplicate / state checks (mirrors frontend guards) ────────
  const { data: myMatch } = await sb
    .from('applications')
    .select('id')
    .eq('driver_id', callerId)
    .eq('status', 'approved')
    .is('unmatched_at', null)
    .maybeSingle();

  if (myMatch) return resp(409, { error: 'You are already matched with an owner. Unmatch first.' });

  if (car_id) {
    const { data: carMatch } = await sb
      .from('applications')
      .select('id')
      .eq('car_id', car_id)
      .eq('status', 'approved')
      .is('unmatched_at', null)
      .maybeSingle();
    if (carMatch) return resp(409, { error: 'This car is already matched with another driver.' });

    const { data: carPause } = await sb
      .from('cars')
      .select('applications_paused')
      .eq('id', car_id)
      .maybeSingle();
    if (carPause?.applications_paused) return resp(409, { error: 'Applications for this car are currently paused.' });

    // Block reapplication to same car if previously rejected
    const { data: prior } = await sb
      .from('applications')
      .select('id,status')
      .eq('car_id', car_id)
      .eq('driver_id', callerId)
      .maybeSingle();
    if (prior) {
      const msg = prior.status === 'approved'  ? 'You are already matched for this car.'
                : prior.status === 'pending'   ? 'You already have a pending request for this car.'
                : 'You have already applied to this car and were not accepted.';
      return resp(409, { error: msg });
    }
  }

  // ── Insert application ────────────────────────────────────────
  const ins = {
    driver_id:     callerId,
    owner_id:      owner_id,
    car_id:        car_id || null,
    status:        'pending',
    message:       message || null,
    initiated_by:  'driver',
    counter_price: counter_price ? parseInt(counter_price) : null,
  };

  const { data: app, error: insErr } = await sb
    .from('applications')
    .insert(ins)
    .select('id')
    .maybeSingle();

  if (insErr) {
    if (insErr.code === '23505') return resp(409, { error: 'Duplicate application.' });
    console.error('Application insert error:', insErr);
    return resp(500, { error: 'Failed to submit application. Please try again.' });
  }

  return resp(200, { id: app.id });
};
