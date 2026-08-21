/**
 * yoco-webhook
 * Receives Yoco webhook events. This is the ONLY place where Boost is activated.
 * The return URL alone never activates a Boost.
 *
 * Register this URL in your Yoco Business Portal:
 *   https://<your-netlify-site>.netlify.app/.netlify/functions/yoco-webhook
 *
 * Signature scheme: Standard Webhooks (https://www.standardwebhooks.com/)
 *   Headers: webhook-id, webhook-timestamp, webhook-signature
 *   Signed content: `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *   Secret: strip 'whsec_' prefix → base64-decode → HMAC-SHA256 → base64-encode
 *   webhook-signature value: space-separated list of "v1,<base64>" tokens
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Secret provided by Yoco when you register the webhook (format: whsec_XXXX=)
const YOCO_WEBHOOK_SECRET  = process.env.YOCO_WEBHOOK_SECRET;

// Reject webhooks signed more than 3 minutes ago (replay attack prevention)
const TIMESTAMP_TOLERANCE_MS = 3 * 60 * 1000;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';

  // ── Signature verification ─────────────────────────────────────
  if (YOCO_WEBHOOK_SECRET) {
    const webhookId  = event.headers['webhook-id'];
    const timestamp  = event.headers['webhook-timestamp'];
    const sigHeader  = event.headers['webhook-signature'];

    if (!webhookId || !timestamp || !sigHeader) {
      console.warn('Missing webhook signature headers');
      return { statusCode: 401, body: 'Missing signature headers' };
    }

    // Replay attack prevention: reject stale webhooks
    const eventMs = parseInt(timestamp, 10) * 1000;
    if (Math.abs(Date.now() - eventMs) > TIMESTAMP_TOLERANCE_MS) {
      console.warn('Webhook timestamp out of tolerance:', timestamp);
      return { statusCode: 401, body: 'Stale webhook' };
    }

    // Compute expected signature
    const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
    const secretBytes   = Buffer.from(YOCO_WEBHOOK_SECRET.split('_')[1], 'base64');
    const expected      = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    // webhook-signature may contain multiple "v1,<base64>" tokens separated by spaces
    const signatures = sigHeader.split(' ');
    const valid = signatures.some(sig => {
      const sigValue = sig.split(',')[1];
      if (!sigValue) return false;
      try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigValue));
      } catch {
        return false;
      }
    });

    if (!valid) {
      console.warn('Webhook signature mismatch');
      return { statusCode: 401, body: 'Invalid signature' };
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody || '{}'); } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('Yoco webhook received:', JSON.stringify(payload));

  // ── Route by event type ────────────────────────────────────────
  // [YOCO-VERIFY] exact event type strings — verify against Yoco docs
  const eventType = payload.type;

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  if (eventType === 'payment.succeeded') {
    await handlePaymentSucceeded(payload, sb);
  } else if (eventType === 'payment.failed') {
    await handlePaymentFailed(payload, sb);
  } else if (eventType === 'payment.refunded') {
    await handlePaymentRefunded(payload, sb);
  } else {
    console.log('Unhandled event type:', eventType);
  }

  // Always 200 to Yoco — prevents infinite retries on our side
  return { statusCode: 200, body: 'OK' };
};

async function handlePaymentSucceeded(payload, sb) {
  // Yoco puts checkoutId in payload.metadata.checkoutId
  // The payment/transaction id is at payload.id or payload.data?.id
  const checkoutId = payload.metadata?.checkoutId;
  const yocoPayId  = payload.id || payload.data?.id;

  if (!checkoutId) {
    console.error('No checkoutId in webhook metadata:', payload);
    return;
  }

  // ── Find the pending payment record ───────────────────────────
  const { data: payment, error: fetchErr } = await sb
    .from('boost_payments')
    .select('*')
    .eq('yoco_checkout_id', checkoutId)
    .maybeSingle();

  if (fetchErr || !payment) {
    console.error('Payment record not found for checkoutId:', checkoutId, fetchErr);
    return;
  }

  // Idempotency: already paid
  if (payment.payment_status === 'paid') {
    console.log('Payment already processed:', checkoutId);
    return;
  }

  const now    = new Date();
  const expiry = new Date(now.getTime() + payment.duration_days * 24 * 3600 * 1000);

  // ── Create the boost ───────────────────────────────────────────
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
    .single();

  if (boostErr) {
    console.error('Failed to create boost:', boostErr);
    return;
  }

  // ── Update payment record to paid ─────────────────────────────
  await sb
    .from('boost_payments')
    .update({
      payment_status:   'paid',
      yoco_payment_id:  yocoPayId,
      boost_id:         boost.id,
      boost_start_at:   now.toISOString(),
      boost_expires_at: expiry.toISOString(),
      paid_at:          now.toISOString(),
      updated_at:       now.toISOString(),
    })
    .eq('yoco_checkout_id', checkoutId);

  // ── Approve any pending boost_request for this driver ─────────
  if (payment.boost_type === 'driver') {
    await sb
      .from('boost_requests')
      .update({ status: 'approved', updated_at: now.toISOString() })
      .eq('driver_id', payment.target_id)
      .eq('status', 'pending');
  }

  console.log('Boost activated:', boost.id, 'for checkout:', checkoutId);

  // ── Sync boost status to Brevo (fire-and-forget) ──────────────
  try {
    await fetch(process.env.URL + '/.netlify/functions/brevo-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: payment.user_id, eventType: 'boost_activated' }),
    });
  } catch (e) {
    console.warn('Brevo boost sync failed (non-blocking):', e.message);
  }
}

async function handlePaymentFailed(payload, sb) {
  const checkoutId = payload.metadata?.checkoutId;
  if (!checkoutId) return;

  await sb
    .from('boost_payments')
    .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
    .eq('yoco_checkout_id', checkoutId)
    .eq('payment_status', 'pending');
}

async function handlePaymentRefunded(payload, sb) {
  const checkoutId = payload.metadata?.checkoutId;
  if (!checkoutId) return;

  const { data: payment } = await sb
    .from('boost_payments')
    .select('boost_id')
    .eq('yoco_checkout_id', checkoutId)
    .maybeSingle();

  if (payment?.boost_id) {
    await sb
      .from('boosts')
      .update({ status: 'cancelled' })
      .eq('id', payment.boost_id);
  }

  await sb
    .from('boost_payments')
    .update({ payment_status: 'refunded', updated_at: new Date().toISOString() })
    .eq('yoco_checkout_id', checkoutId);

  console.log('Boost deactivated due to refund:', checkoutId);
}
