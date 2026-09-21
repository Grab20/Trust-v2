/**
 * remind-incomplete-owners
 * Scheduled daily at 8am SAST (6am UTC).
 * Sends a reminder email to owners who registered but have no car listing yet.
 * Only emails owners created within the last 14 days to avoid spamming stale accounts.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const FROM_EMAIL           = process.env.DIGEST_FROM_EMAIL || 'hello@trustmate.co.za';
const FROM_NAME            = process.env.DIGEST_FROM_NAME  || 'TrustMate';

// Only remind owners who registered within this window
const REMIND_WINDOW_DAYS = 14;

exports.handler = async function () {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY) {
    console.error('Missing env vars');
    return { statusCode: 500, body: 'Config error' };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const since = new Date(Date.now() - REMIND_WINDOW_DAYS * 86400 * 1000).toISOString();

  // Fetch owners with no car listing, registered in the last 14 days
  const { data: owners, error } = await sb
    .from('profiles')
    .select('id, full_name, email')
    .in('role', ['owner', 'both'])
    .is('is_removed', null)
    .gte('created_at', since);

  if (error) { console.error('DB error:', error); return { statusCode: 500, body: 'DB error' }; }
  if (!owners || !owners.length) {
    console.log('No owners found in window.');
    return { statusCode: 200, body: 'No owners' };
  }

  // Filter to only owners with zero cars
  const ownerIds = owners.map(function (o) { return o.id; });
  const { data: cars } = await sb
    .from('cars')
    .select('owner_id')
    .in('owner_id', ownerIds);

  const ownersWithCars = new Set((cars || []).map(function (c) { return c.owner_id; }));
  const incomplete = owners.filter(function (o) { return !ownersWithCars.has(o.id) && o.email; });

  if (!incomplete.length) {
    console.log('All recent owners have car listings.');
    return { statusCode: 200, body: 'No incomplete owners' };
  }

  console.log(`Sending reminders to ${incomplete.length} incomplete owner(s)`);
  let sent = 0, skipped = 0;

  for (const owner of incomplete) {
    const firstName = (owner.full_name || '').split(' ')[0] || 'there';

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#1a5c28;font-size:20px;margin-bottom:12px">Complete your listing to find verified drivers</h2>
        <p style="font-size:15px;color:#333;line-height:1.6">
          Hi ${firstName},<br/><br/>
          You created a TrustMate account but your vehicle listing is not yet complete.
          <strong>Verified e-hailing drivers in your area are actively looking for cars right now.</strong>
        </p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:16px 0">
          To complete your listing you will need:<br/>
          &bull; A selfie photo<br/>
          &bull; A copy of your ID or passport<br/>
          &bull; Front, side and back photos of your car<br/>
          &bull; Basic car and rental details
        </p>
        <p style="margin:24px 0">
          <a href="https://trustmate.co.za" style="display:inline-block;padding:13px 32px;background:#1a5c28;color:#fff;text-decoration:none;border-radius:7px;font-weight:700;font-size:15px">
            Complete My Listing
          </a>
        </p>
        <p style="font-size:13px;color:#666;line-height:1.5">
          Log in with the email address you used to register, then tap <strong>"Complete My Vehicle Listing"</strong> on your dashboard.
          It takes less than 5 minutes.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
        <p style="font-size:11px;color:#999">
          TrustMate &middot; trustmate.co.za &middot;
          <a href="https://trustmate.co.za" style="color:#999">Unsubscribe</a>
        </p>
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
          to: [owner.email],
          subject: `${firstName}, verified drivers are waiting — complete your listing on TrustMate`,
          html,
        }),
      });
      if (res.ok) {
        sent++;
      } else {
        const err = await res.text();
        console.error('Resend error for', owner.email, err);
        skipped++;
      }
    } catch (e) {
      console.error('Fetch error for', owner.email, e);
      skipped++;
    }
  }

  console.log(`Incomplete owner reminders: sent=${sent}, skipped=${skipped}`);
  return { statusCode: 200, body: `Sent ${sent}, skipped ${skipped}` };
};
