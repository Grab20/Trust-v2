/**
 * boost-payment-success
 * Yoco redirects here after a successful payment.
 * Verifies payment with Yoco API, activates boost, then sends user back to the app.
 * successUrl: https://trustmate.co.za/.netlify/functions/boost-payment-success?uid=USER_ID&bt=BOOST_TYPE
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const YOCO_SECRET_KEY      = process.env.YOCO_SECRET_KEY;
const YOCO_API_BASE        = 'https://payments.yoco.com/api';

exports.handler = async function (event) {
  const params     = event.queryStringParameters || {};
  const userId     = params.uid;
  const boostType  = params.bt;

  // Also check if Yoco appends checkoutId directly
  const yocoCheckoutId = params.checkoutId || params.id || params.checkout_id || null;

  const siteUrl = process.env.URL || 'https://trustmate.co.za';

  if (!userId) {
    return redirect(`${siteUrl}?payment=error&reason=missing_uid`);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Find the most recent pending payment for this user
  let query = sb
    .from('boost_payments')
    .select('*')
    .eq('user_id', userId)
    .eq('payment_status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);

  if (yocoCheckoutId) {
    query = sb
      .from('boost_payments')
      .select('*')
      .eq('yoco_checkout_id', yocoCheckoutId)
      .maybeSingle();
  } else {
    query = query.maybeSingle();
  }

  const { data: payment, error: fetchErr } = await query;

  if (fetchErr || !payment) {
    console.error('Payment not found for uid:', userId, fetchErr);
    return redirect(`${siteUrl}?payment=error&reason=not_found`);
  }

  // Already paid — just redirect to success
  if (payment.payment_status === 'paid') {
    return redirect(`${siteUrl}?payment=success&checkoutId=${payment.yoco_checkout_id}`);
  }

  // Verify with Yoco API
  const checkoutId = yocoCheckoutId || payment.yoco_checkout_id;

  try {
    const yocoRes = await fetch(`${YOCO_API_BASE}/checkouts/${checkoutId}`, {
      headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` },
    });

    if (yocoRes.ok) {
      const yocoData = await yocoRes.json();
      console.log('Yoco response for', checkoutId, ':', JSON.stringify(yocoData));

      const checkoutStatus = (yocoData.status || '').toLowerCase();
      const paymentStatus  = (yocoData.payment?.status || yocoData.paymentStatus || '').toLowerCase();
      const isPaid = ['succeeded','complete','completed','paid'].includes(checkoutStatus)
                  || ['succeeded','complete','completed','paid'].includes(paymentStatus);

      if (isPaid) {
        const yocoPayId = yocoData.payment?.id || yocoData.id;
        const now       = new Date();

        if (payment.boost_type === 'bn_application') {
          // B/N plan: create entitlement (extend from current expiry if active one exists)
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
            console.error('bn_entitlement insert error:', entErr);
          }

          await sb.from('boost_payments').update({
            payment_status:   'paid',
            yoco_payment_id:  yocoPayId,
            boost_start_at:   now.toISOString(),
            boost_expires_at: newExpiry.toISOString(),
            paid_at:          now.toISOString(),
            updated_at:       now.toISOString(),
          }).eq('id', payment.id).eq('payment_status', 'pending');

          // Supersede other abandoned pending bn_application checkouts for this user
          await sb
            .from('boost_payments')
            .update({ payment_status: 'superseded', updated_at: now.toISOString() })
            .eq('user_id', payment.user_id)
            .eq('boost_type', 'bn_application')
            .eq('payment_status', 'pending')
            .neq('id', payment.id);

          console.log('B/N entitlement activated via boost-payment-success for checkout:', checkoutId);
          return redirect(`${siteUrl}?payment=success&checkoutId=${checkoutId}&bn=1`);
        }

        const expiry = new Date(now.getTime() + payment.duration_days * 24 * 3600 * 1000);

        // Create boost (idempotent — ignore duplicate key)
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
          console.error('Boost insert error:', boostErr);
          return redirect(`${siteUrl}?payment=error&reason=boost_failed`);
        }

        const boostId = boost?.id || null;

        // Update payment to paid — only if still pending (prevents double-activation)
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
          .eq('id', payment.id)
          .eq('payment_status', 'pending');

        // Supersede other abandoned pending checkouts for same user+type
        await sb
          .from('boost_payments')
          .update({ payment_status: 'superseded', updated_at: now.toISOString() })
          .eq('user_id', payment.user_id)
          .eq('boost_type', payment.boost_type)
          .eq('payment_status', 'pending')
          .neq('id', payment.id);

        console.log('Boost activated via boost-payment-success for checkout:', checkoutId);

        return redirect(`${siteUrl}?payment=success&checkoutId=${checkoutId}&boosted=1`);
      }
    }
  } catch (e) {
    console.error('Yoco verify error:', e.message);
  }

  // Yoco not confirmed yet — send back to app, frontend will poll
  return redirect(`${siteUrl}?payment=success&checkoutId=${checkoutId}`);
};

function redirect(url) {
  return {
    statusCode: 302,
    headers: { Location: url },
    body: '',
  };
}
