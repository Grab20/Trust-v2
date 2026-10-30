/**
 * check-payment-status
 * Called by the frontend when the user returns from Yoco checkout.
 * 1. Checks our DB — if already paid/active, return immediately.
 * 2. If still pending, calls Yoco API to get live status.
 * 3. If Yoco says paid, activates the boost directly (webhook fallback).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOCO_SECRET_KEY      = process.env.YOCO_SECRET_KEY;
const YOCO_API_BASE        = 'https://payments.yoco.com/api';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const checkoutId = event.queryStringParameters && event.queryStringParameters.checkoutId;
  if (!checkoutId) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'Missing checkoutId' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Check verify_payments first (driver R29 fee)
  const { data: verifyPayment } = await sb
    .from('verify_payments')
    .select('id, user_id, payment_status, yoco_checkout_id')
    .eq('yoco_checkout_id', checkoutId)
    .maybeSingle();

  if (verifyPayment) {
    // If paid, return immediately
    if (verifyPayment.payment_status === 'paid') {
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ payment: verifyPayment }) };
    }
    // Still pending — check with Yoco API directly as fallback
    if (YOCO_SECRET_KEY && verifyPayment.payment_status === 'pending') {
      try {
        const yocoRes = await fetch(`${YOCO_API_BASE}/checkouts/${checkoutId}`, {
          headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` },
        });
        if (yocoRes.ok) {
          const yocoData = await yocoRes.json();
          const checkoutStatus = (yocoData.status || '').toLowerCase();
          const paymentStatus  = (yocoData.payment?.status || yocoData.paymentStatus || '').toLowerCase();
          const isPaid = ['succeeded','complete','completed','paid'].includes(checkoutStatus)
                      || ['succeeded','complete','completed','paid'].includes(paymentStatus);
          if (isPaid) {
            const yocoPayId = yocoData.payment?.id || yocoData.id;
            const now = new Date().toISOString();
            await sb.from('verify_payments')
              .update({ payment_status: 'paid', yoco_payment_id: yocoPayId, paid_at: now, updated_at: now })
              .eq('yoco_checkout_id', checkoutId)
              .eq('payment_status', 'pending');
            await sb.from('driver_profiles')
              .update({ status: 'pending', verify_paid_at: now, updated_at: now })
              .eq('user_id', verifyPayment.user_id)
              .eq('status', 'pending_payment');
            // Fire admin notification (non-blocking)
            try {
              const { data: prof } = await sb.from('profiles').select('full_name,email').eq('id', verifyPayment.user_id).maybeSingle();
              fetch(`${process.env.URL || 'https://trustmatefleet.co.za'}/.netlify/functions/notify-docs`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: prof?.full_name||'', email: prof?.email||'', role: 'driver', uid: verifyPayment.user_id }),
              }).catch(() => {});
            } catch (_) {}
            return { statusCode: 200, headers: cors(), body: JSON.stringify({ payment: { ...verifyPayment, payment_status: 'paid' } }) };
          }
        }
      } catch (e) {
        console.warn('Yoco API check failed for verify payment (non-blocking):', e.message);
      }
    }
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ payment: verifyPayment }) };
  }

  const { data: payment, error } = await sb
    .from('boost_payments')
    .select('*')
    .eq('yoco_checkout_id', checkoutId)
    .maybeSingle();

  if (error || !payment) {
    return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: 'Payment not found' }) };
  }

  // Already processed — return as-is
  if (payment.payment_status === 'paid') {
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ payment }) };
  }

  // Still pending — verify with Yoco API directly
  if (YOCO_SECRET_KEY && payment.payment_status === 'pending') {
    try {
      const yocoRes = await fetch(`${YOCO_API_BASE}/checkouts/${checkoutId}`, {
        headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` },
      });

      if (yocoRes.ok) {
        const yocoData = await yocoRes.json();
        console.log('Yoco checkout response for', checkoutId, ':', JSON.stringify(yocoData));
        // Yoco checkout statuses: succeeded, complete, paid (varies by API version)
        const checkoutStatus = (yocoData.status || '').toLowerCase();
        const paymentStatus  = (yocoData.payment?.status || yocoData.paymentStatus || '').toLowerCase();
        const isPaid = ['succeeded','complete','completed','paid'].includes(checkoutStatus)
                    || ['succeeded','complete','completed','paid'].includes(paymentStatus);

        if (isPaid) {
          const yocoPayId = yocoData.payment?.id || yocoData.id;
          const now       = new Date();
          const expiry    = new Date(now.getTime() + payment.duration_days * 24 * 3600 * 1000);

          // Idempotent boost insert — ignore duplicate key (23505)
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
            console.error('Boost insert error (check-payment-status):', boostErr);
            return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: 'Boost activation failed' }) };
          }

          const boostId = boost?.id || null;

          // Update only if still pending — prevents double-activation race condition
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
            .eq('yoco_checkout_id', checkoutId)
            .eq('payment_status', 'pending');

          const updatedPayment = {
            ...payment,
            payment_status:   'paid',
            boost_id:         boostId,
            boost_start_at:   now.toISOString(),
            boost_expires_at: expiry.toISOString(),
          };

          console.log('Boost activated via payment-status fallback for checkout:', checkoutId);

          return { statusCode: 200, headers: cors(), body: JSON.stringify({ payment: updatedPayment }) };
        }
      }
    } catch (e) {
      console.warn('Yoco API check failed (non-blocking):', e.message);
    }
  }

  return { statusCode: 200, headers: cors(), body: JSON.stringify({ payment }) };
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
