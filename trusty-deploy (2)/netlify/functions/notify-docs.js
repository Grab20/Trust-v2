/**
 * notify-docs
 * Called by the frontend after a driver completes registration with documents.
 * Sends an email to info@trustmate.co.za notifying admin of the new submission.
 * Requires env var: RESEND_API_KEY
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ADMIN_EMAIL    = ['ngomaft@yahoo.com', 'info@trustmate.co.za'];
const FROM_EMAIL     = 'TrustMate <noreply@trustmatefleet.co.za>';

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, apikey, authorization',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  const { name, email, role, uid } = body;

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Email service not configured' }) };
  }

  const subject = role === 'owner'
    ? `New owner registered: ${name || email}`
    : `New driver documents submitted: ${name || email}`;

  const html = `
    <h2>New ${role === 'owner' ? 'Owner' : 'Driver'} Submission — TrustMate</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Name</td><td><strong>${esc(name || '—')}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Email</td><td>${esc(email || '—')}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Role</td><td style="text-transform:capitalize">${esc(role || '—')}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">User ID</td><td style="font-size:12px;color:#999">${esc(uid || '—')}</td></tr>
    </table>
    <p style="margin-top:16px">
      <a href="https://trustmatefleet.co.za" style="background:#16a34a;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600">Review in Admin Panel</a>
    </p>
    <p style="font-size:12px;color:#999;margin-top:24px">TrustMate · trustmatefleet.co.za</p>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: ADMIN_EMAIL,
        subject,
        html,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('Resend error:', data);
      return {
        statusCode: 502,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Failed to send email' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('notify-docs error:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
