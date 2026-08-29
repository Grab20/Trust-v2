/**
 * setup-yoco-webhook (one-time use)
 * Call this once to register the webhook with Yoco.
 * DELETE this function after use.
 * Protect with SETUP_SECRET env var.
 * Usage: GET /.netlify/functions/setup-yoco-webhook?secret=YOUR_SETUP_SECRET
 */

const YOCO_SECRET_KEY     = process.env.YOCO_SECRET_KEY;
const YOCO_WEBHOOK_SECRET = process.env.YOCO_WEBHOOK_SECRET;
const SETUP_SECRET        = process.env.SETUP_SECRET || 'trustmate-setup-2026';
const SITE_URL            = process.env.URL || 'https://trustmate.co.za';

exports.handler = async function (event) {
  const secret = (event.queryStringParameters || {}).secret;
  if (secret !== SETUP_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const webhookUrl = `${SITE_URL}/.netlify/functions/yoco-webhook`;

  // Try common Yoco webhook endpoint paths
  const endpoints = [
    'https://payments.yoco.com/api/webhooks',
    'https://payments.yoco.com/api/webhook-subscriptions',
    'https://api.yoco.com/v1/webhooks',
  ];

  const results = [];

  for (const endpoint of endpoints) {
    try {
      // First list existing
      const listRes = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${YOCO_SECRET_KEY}` },
      });
      const listBody = await listRes.text();
      results.push({ endpoint, listStatus: listRes.status, listBody });

      if (listRes.status === 200) {
        // Found the right endpoint — now register
        const createRes = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${YOCO_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: webhookUrl,
            events: ['payment.succeeded', 'payment.failed', 'payment.refunded'],
          }),
        });
        const createBody = await createRes.text();
        results.push({ createStatus: createRes.status, createBody });
        break;
      }
    } catch (e) {
      results.push({ endpoint, error: e.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl, results }, null, 2),
  };
};
