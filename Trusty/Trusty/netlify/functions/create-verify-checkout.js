/**
 * create-verify-checkout
 * Creates a Yoco checkout session for the R29 driver verification fee.
 * Called after a driver submits their documents (status = pending_payment).
 * On payment.succeeded webhook, yoco-webhook advances status → pending and
 * fires the admin notification email.
 */

const { createClient } = require('@supabase/supabase-js');

const YOCO_API_BASE         = 'https://payments.yoco.com/api';
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOCO_SECRET_KEY       = process.env.YOCO_SECRET_KEY;

const VERIFY_FEE_CENTS = 2900; // R29.00
const CURRENCY         = 'ZAR';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!YOCO_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing env vars');
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { user_id, site_url } = body;
  if (!user_id || !site_url) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Missing user_id or site_url' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Confirm driver is in pending_payment status
  const { data: dp, error: dpErr } = await sb
    .from('driver_profiles')
    .select('id, status, user_id')
    .eq('user_id', user_id)
    .maybeSingle();

  if (dpErr || !dp) {
    return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: 'Driver profile not found' }) };
  }
  if (dp.status !== 'pending_payment') {
    // Already paid or in another state — don't create a duplicate charge
    if (dp.status === 'pending' || dp.status === 'approved') {
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ already_paid: true }) };
    }
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Profile is not awaiting payment' }) };
  }

  // Idempotency: reuse pending checkout < 30 min old
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: existing } = await sb
    .from('verify_payments')
    .select('id, yoco_checkout_id')
    .eq('user_id', user_id)
    .eq('payment_status', 'pending')
    .gte('created_at', thirtyMinAgo)
    .maybeSingle();

  let yocoCheckoutId, yocoRedirectUrl;

  if (existing && existing.yoco_checkout_id) {
    yocoCheckoutId  = existing.yoco_checkout_id;
    yocoRedirectUrl = `https://pay.yoco.com/${yocoCheckoutId}`;
  } else {
    const successUrl = `${process.env.URL || site_url}/.netlify/functions/boost-payment-success?uid=${user_id}&bt=verify`;
    const cancelUrl  = `${site_url}?payment=cancelled`;
    const failureUrl = `${site_url}?payment=failed`;

    const yocoRes = await fetch(`${YOCO_API_BASE}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount:     VERIFY_FEE_CENTS,
        currency:   CURRENCY,
        successUrl: successUrl,
        cancelUrl:  cancelUrl,
        failureUrl: failureUrl,
        metadata: {
          user_id:      user_id,
          payment_type: 'driver_verify',
        },
      }),
    });

    if (!yocoRes.ok) {
      const errText = await yocoRes.text();
      console.error('Yoco API error:', errText);
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'Payment provider error. Please try again.' }) };
    }

    const yocoData = await yocoRes.json();
    yocoCheckoutId  = yocoData.id;
    yocoRedirectUrl = yocoData.redirectUrl;

    if (!yocoCheckoutId || !yocoRedirectUrl) {
      console.error('Unexpected Yoco response:', yocoData);
      return { statusCode: 502, headers: cors(), body: JSON.stringify({ error: 'Unexpected payment provider response' }) };
    }

    const { error: insertErr } = await sb.from('verify_payments').insert({
      user_id,
      amount_cents:     VERIFY_FEE_CENTS,
      currency:         CURRENCY,
      yoco_checkout_id: yocoCheckoutId,
      payment_status:   'pending',
    });

    if (insertErr && insertErr.code !== '23505') {
      console.error('DB insert error:', insertErr);
      return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Failed to record payment' }) };
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
