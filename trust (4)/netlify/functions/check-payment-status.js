/**
 * check-payment-status
 * Called by the frontend when the user returns from Yoco.
 * Returns the payment status WITHOUT activating anything.
 * Activation only ever happens in yoco-webhook.js.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const { data: payment, error } = await sb
    .from('boost_payments')
    .select('payment_status, boost_id, boost_type, amount_cents, currency, boost_start_at, boost_expires_at')
    .eq('yoco_checkout_id', checkoutId)
    .maybeSingle();

  if (error || !payment) {
    return { statusCode: 404, headers: cors(), body: JSON.stringify({ error: 'Payment not found' }) };
  }

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({ payment }),
  };
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}
