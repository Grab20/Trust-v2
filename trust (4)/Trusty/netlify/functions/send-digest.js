/**
 * send-digest
 * Scheduled 3x/day (7am, 12pm, 6pm SAST = 5am, 10am, 4pm UTC).
 * Sends each owner a summary of new driver applications since the last digest.
 * Uses Resend for transactional email delivery.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY      = process.env.RESEND_API_KEY;
const FROM_EMAIL          = process.env.DIGEST_FROM_EMAIL || 'hello@trustmate.co.za';
const FROM_NAME           = process.env.DIGEST_FROM_NAME  || 'TrustMate';

// How far back to look for new applications (8 hours covers any gap between digest windows)
const WINDOW_HOURS = 8;

exports.handler = async function () {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY) {
    console.error('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or RESEND_API_KEY');
    return { statusCode: 500, body: 'Config error' };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();

  // Fetch driver-initiated applications created in the window
  const { data: apps, error: appErr } = await sb
    .from('applications')
    .select('id, owner_id, driver_id, created_at')
    .eq('initiated_by', 'driver')
    .gte('created_at', since);

  if (appErr) { console.error('DB error:', appErr); return { statusCode: 500, body: 'DB error' }; }
  if (!apps || !apps.length) {
    console.log('No new driver applications in window.');
    return { statusCode: 200, body: 'No apps' };
  }

  // Group by owner_id
  const byOwner = {};
  apps.forEach(function (a) {
    if (!byOwner[a.owner_id]) byOwner[a.owner_id] = 0;
    byOwner[a.owner_id]++;
  });

  const ownerIds = Object.keys(byOwner);

  // Fetch owner profiles (name + email)
  const { data: profiles } = await sb
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ownerIds);

  const pm = {};
  (profiles || []).forEach(function (p) { pm[p.id] = p; });

  let sent = 0, skipped = 0;

  for (const ownerId of ownerIds) {
    const profile = pm[ownerId];
    if (!profile || !profile.email) { skipped++; continue; }

    const count = byOwner[ownerId];
    const firstName = (profile.full_name || '').split(' ')[0] || 'there';
    const subject = count === 1
      ? `${firstName}, you have 1 new driver application on TrustMate`
      : `${firstName}, you have ${count} new driver applications on TrustMate`;

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#1a5c28;font-size:20px;margin-bottom:12px">You have new driver applications</h2>
        <p style="font-size:15px;color:#333;line-height:1.6">
          Hi ${firstName},<br/><br/>
          <strong>${count} driver${count !== 1 ? 's have' : ' has'} applied</strong> to your listing${count !== 1 ? 's' : ''} in the last few hours.
        </p>
        <p style="margin:20px 0">
          <a href="https://trustmate.co.za" style="display:inline-block;padding:12px 28px;background:#1a5c28;color:#fff;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px">
            View Applications
          </a>
        </p>
        <p style="font-size:13px;color:#666;line-height:1.5">
          Log in to TrustMate to review and respond to these applications.<br/>
          Review quickly — drivers may apply to multiple listings.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="font-size:11px;color:#999">TrustMate &middot; trustmate.co.za</p>
      </div>`;

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to: [profile.email],
          subject,
          html,
        }),
      });
      if (res.ok) {
        sent++;
      } else {
        const err = await res.text();
        console.error('Resend error for', profile.email, err);
        skipped++;
      }
    } catch (e) {
      console.error('Fetch error for', profile.email, e);
      skipped++;
    }
  }

  console.log(`Digest sent: ${sent}, skipped: ${skipped}`);
  return { statusCode: 200, body: `Sent ${sent}, skipped ${skipped}` };
};
