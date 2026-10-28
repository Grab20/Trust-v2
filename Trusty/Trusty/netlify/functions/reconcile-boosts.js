/**
 * reconcile-boosts
 * Checks all pending boost_payments against Yoco API and activates any that were paid.
 * Runs automatically every 2 hours via Netlify scheduled functions.
 * Also callable manually: GET /.netlify/functions/reconcile-boosts?secret=YOUR_SETUP_SECRET
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOCO_SECRET_KEY      = process.env.YOCO_SECRET_KEY;
const YOCO_API_BASE        = 'https://payments.yoco.com/api';
const SETUP_SECRET         = process.env.SETUP_SECRET || 'trustmate-setup-2026';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  // Allow scheduled invocation (no secret) or manual with secret
  const isScheduled = event.httpMethod === undefined || event.httpMethod === null || !event.httpMethod;
  const secret = (event.queryStringParameters || {}).secret;
  if (!isScheduled && secret !== SETUP_SECRET) {
    return { statusCode: 401, headers: cors(), body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!YOCO_SECRET_KEY) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'YOCO_SECRET_KEY not set' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Get all pending payments
  const { data: pending, error } = await sb
    .from('boost_payments')
    .select('*')
    .eq('payment_status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: error.message }) };
  }

  const results = { total: pending.length, activated: [], notPaid: [], errors: [] };

  for (const payment of pending) {
    try {
      const yocoRes = await fetch(`${YOCO_API_BASE}/checkouts/${payment.yoco_checkout_id}`, {
        headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` },
      });

      if (!yocoRes.ok) {
        results.errors.push({ id: payment.yoco_checkout_id, status: yocoRes.status });
        continue;
      }

      const yocoData = await yocoRes.json();
      const checkoutStatus = (yocoData.status || '').toLowerCase();
      const paymentStatus  = (yocoData.payment?.status || yocoData.paymentStatus || '').toLowerCase();
      const isPaid = ['succeeded','complete','completed','paid'].includes(checkoutStatus)
                  || ['succeeded','complete','completed','paid'].includes(paymentStatus);

      if (!isPaid) {
        results.notPaid.push({ id: payment.yoco_checkout_id, yocoStatus: yocoData.status });
        continue;
      }

      // Activate boost
      const yocoPayId = yocoData.payment?.id || yocoData.id;
      const now       = new Date();
      const expiry    = new Date(now.getTime() + payment.duration_days * 24 * 3600 * 1000);

      // ── B/N application plan ───────────────────────────────────
      if (payment.boost_type === 'bn_application') {
        const { data: existing } = await sb
          .from('bn_entitlements')
          .select('id, expires_at')
          .eq('driver_id', payment.user_id)
          .eq('status', 'active')
          .gte('expires_at', now.toISOString())
          .order('expires_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const baseDate  = existing ? new Date(Math.max(new Date(existing.expires_at), now)) : now;
        const newExpiry = new Date(baseDate.getTime() + payment.duration_days * 24 * 3600 * 1000);

        const { error: entErr } = await sb.from('bn_entitlements').insert({
          driver_id:  payment.user_id,
          payment_id: payment.id,
          plan_type:  'paid',
          status:     'active',
          starts_at:  now.toISOString(),
          expires_at: newExpiry.toISOString(),
        });

        if (entErr && entErr.code !== '23505') {
          results.errors.push({ id: payment.yoco_checkout_id, entErr: entErr.message });
          continue;
        }

        await sb.from('boost_payments').update({
          payment_status:   'paid',
          yoco_payment_id:  yocoPayId,
          boost_start_at:   now.toISOString(),
          boost_expires_at: newExpiry.toISOString(),
          paid_at:          now.toISOString(),
          updated_at:       now.toISOString(),
        }).eq('id', payment.id);

        results.activated.push({ checkout: payment.yoco_checkout_id, user: payment.user_id, type: 'bn_application' });
        continue;
      }

      // ── Standard boost (driver / vehicle) ─────────────────────
      const { data: boost, error: boostErr } = await sb
        .from('boosts')
        .insert({
          type:          payment.boost_type,
          target_id:     payment.target_id,
          status:        'active',
          test_mode:     false,
          duration_days: payment.duration_days,
          start_at:      now.toISOString(),
          end_at:        expiry.toISOString(),
          impressions:   0,
          profile_views: 0,
          created_by:    payment.user_id,
        })
        .select('id')
        .maybeSingle();

      if (boostErr && boostErr.code !== '23505') {
        results.errors.push({ id: payment.yoco_checkout_id, boostErr: boostErr.message });
        continue;
      }

      const boostId = boost?.id || null;

      await sb
        .from('boost_payments')
        .update({
          payment_status:   'paid',
          yoco_payment_id:  yocoPayId,
          boost_id:         boostId,
          boost_start_at:   now.toISOString(),
          boost_expires_at: expiry.toISOString(),
          paid_at:          now.toISOString(),
          updated_at:       now.toISOString(),
        })
        .eq('id', payment.id);

      results.activated.push({
        checkout: payment.yoco_checkout_id,
        user: payment.user_id,
        type: payment.boost_type,
        boostId,
      });

    } catch (e) {
      results.errors.push({ id: payment.yoco_checkout_id, error: e.message });
    }
  }

  console.log('Reconcile complete:', JSON.stringify(results));

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({
      summary: {
        total:     results.total,
        activated: results.activated.length,
        notPaid:   results.notPaid.length,
        errors:    results.errors.length,
      },
      activated: results.activated,
      notPaid:   results.notPaid,
      errors:    results.errors,
    }, null, 2),
  };
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
