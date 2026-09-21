/**
 * create-boost-checkout
 * Called by the frontend to initiate a Yoco payment session.
 * Returns a redirect URL — the frontend redirects the user to Yoco.
 *
 * VERIFY against https://developer.yoco.com/docs/getting-started/build-with-yoco/checkout-api
 * before going live. Fields marked [YOCO-VERIFY] may need adjustment.
 */

const { createClient } = require('@supabase/supabase-js');

const YOCO_API_BASE = 'https://payments.yoco.com/api'; // [YOCO-VERIFY] base URL
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOCO_SECRET_KEY      = process.env.YOCO_SECRET_KEY; // live key, never expose

exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Validate environment ───────────────────────────────────────
  if (!YOCO_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env vars: YOCO_SECRET_KEY, SUPABASE_URL, or SUPABASE_SERVICE_ROLE_KEY');
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { boost_type, target_id, user_id, site_url } = body;

  if (!boost_type || !target_id || !user_id || !site_url) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (!['driver', 'vehicle'].includes(boost_type)) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid boost_type' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Load pricing from DB ───────────────────────────────────────
  const { data: cfg } = await sb.from('boost_config').select('key,value');
  const cfgMap = {};
  (cfg || []).forEach(r => { cfgMap[r.key] = r.value; });

  const amountCents = parseInt(
    boost_type === 'driver' ? cfgMap.driver_boost_price_cents : cfgMap.vehicle_boost_price_cents
  );
  const durationDays = parseInt(
    boost_type === 'driver' ? cfgMap.driver_boost_days : cfgMap.vehicle_boost_days
  );
  const currency = cfgMap.currency || 'ZAR';

  if (!amountCents || !durationDays) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Pricing config missing' }) };
  }

  // ── Idempotency: check for existing pending payment ────────────
  // If the user already has a pending checkout that is < 30 min old, reuse it.
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: existing } = await sb
    .from('boost_payments')
    .select('id, yoco_checkout_id')
    .eq('user_id', user_id)
    .eq('boost_type', boost_type)
    .eq('target_id', target_id)
    .eq('payment_status', 'pending')
    .gte('created_at', thirtyMinAgo)
    .maybeSingle();

  // ── Create Yoco checkout session ───────────────────────────────
  // [YOCO-VERIFY] Request body shape. Yoco Checkout API v1 as of 2024:
  //   POST https://payments.yoco.com/api/checkouts
  //   { amount (cents), currency, successUrl, cancelUrl, failureUrl, metadata }
  // checkoutId appended after Yoco creates the session — placeholder replaced below
  // successUrl routes through our function which verifies payment server-side before redirecting to app
  const successUrl  = `${process.env.URL || site_url}/.netlify/functions/boost-payment-success?uid=${user_id}&bt=${boost_type}`;
  const cancelUrl   = `${site_url}?payment=cancelled`;
  const failureUrl  = `${site_url}?payment=failed`;

  let yocoCheckoutId, yocoRedirectUrl;

  if (existing && existing.yoco_checkout_id) {
    // Reuse existing checkout — do NOT create a new Yoco session
    yocoCheckoutId  = existing.yoco_checkout_id;
    yocoRedirectUrl = `https://pay.yoco.com/${yocoCheckoutId}`;
  } else {
    const tempSuccessUrl = successUrl;
    const yocoRes = await fetch(`${YOCO_API_BASE}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount:     amountCents,
        currency:   currency,
        successUrl: tempSuccessUrl,
        cancelUrl:  cancelUrl,
        failureUrl: failureUrl,
        metadata: {
          user_id:    user_id,
          boost_type: boost_type,
          target_id:  target_id,
        },
      }),
    });

    if (!yocoRes.ok) {
      const errText = await yocoRes.text();
      console.error('Yoco API error:', errText);
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'Payment provider error. Please try again.' }) };
    }

    const yocoData = await yocoRes.json();
    yocoCheckoutId  = yocoData.id;          // [YOCO-VERIFY] field name
    yocoRedirectUrl = yocoData.redirectUrl; // [YOCO-VERIFY] field name

    if (!yocoCheckoutId || !yocoRedirectUrl) {
      console.error('Unexpected Yoco response:', yocoData);
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'Unexpected payment provider response' }) };
    }

    // ── Create pending payment record ──────────────────────────────
    const { error: insertErr } = await sb.from('boost_payments').insert({
      user_id,
      boost_type,
      target_id,
      duration_days:   durationDays,
      amount_cents:    amountCents,
      currency,
      yoco_checkout_id: yocoCheckoutId,
      payment_status:  'pending',
    });

    if (insertErr) {
      // Unique constraint violation = duplicate — safe to continue with existing record
      if (insertErr.code !== '23505') {
        console.error('DB insert error:', insertErr);
        return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Failed to record payment' }) };
      }
    }
  }

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({ redirectUrl: yocoRedirectUrl, checkoutId: yocoCheckoutId }),
  };
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
