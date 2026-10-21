/**
 * confirm-user-email
 * Called after the app's own OTP verification succeeds.
 * Uses the service role key to mark the Supabase user's email as confirmed
 * so the frontend can immediately sign in and get an auth session for uploads.
 */
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let userId;
  try {
    const body = JSON.parse(event.body || '{}');
    userId = body.userId;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!userId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'userId required' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { error } = await sb.auth.admin.updateUserById(userId, {
    email_confirm: true
  });

  if (error) {
    console.error('confirm-user-email error:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
