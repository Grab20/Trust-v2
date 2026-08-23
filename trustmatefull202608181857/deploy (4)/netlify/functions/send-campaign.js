/**
 * send-campaign
 * Admin-only. Sends a bulk promotional email to drivers or owners via Resend.
 * Fetches recipients from Supabase, filters by audience, sends individual emails.
 *
 * POST body: {
 *   audience: 'drivers' | 'owners' | 'drivers_unmatched' | 'owners_unmatched',
 *   subject: string,
 *   preview: boolean  — if true, returns recipient list without sending
 * }
 *
 * Secured by x-admin-secret header matching ADMIN_CAMPAIGN_SECRET env var.
 */

const { createClient } = require('@supabase/supabase-js');

const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_SECRET         = process.env.ADMIN_CAMPAIGN_SECRET || '';
const FROM_EMAIL           = 'TrustMate <noreply@trustmatefleet.co.za>';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  // Auth check
  const secret = event.headers['x-admin-secret'] || '';
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  const { audience, subject, textBody, preview } = body;

  if (!audience || !subject || !textBody) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'audience, subject and textBody are required' }) };
  }

  if (!RESEND_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'RESEND_API_KEY not configured' }) };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Fetch recipients ──────────────────────────────────────────────────────
  let recipients = [];

  if (audience === 'drivers' || audience === 'drivers_unmatched') {
    // Approved drivers
    const { data: dps } = await sb
      .from('driver_profiles')
      .select('user_id')
      .eq('status', 'approved');

    const driverIds = (dps || []).map(d => d.user_id);

    if (audience === 'drivers_unmatched' && driverIds.length) {
      // Exclude drivers with an active match
      const { data: matched } = await sb
        .from('applications')
        .select('driver_id')
        .eq('status', 'approved')
        .is('unmatched_at', null)
        .in('driver_id', driverIds);
      const matchedSet = new Set((matched || []).map(a => a.driver_id));
      const unmatchedIds = driverIds.filter(id => !matchedSet.has(id));
      if (unmatchedIds.length) {
        const { data: profiles } = await sb
          .from('profiles')
          .select('id,full_name,email')
          .in('id', unmatchedIds)
          .eq('email_confirmed', true);
        recipients = (profiles || []).filter(p => p.email);
      }
    } else if (driverIds.length) {
      const { data: profiles } = await sb
        .from('profiles')
        .select('id,full_name,email')
        .in('id', driverIds)
        .eq('email_confirmed', true);
      recipients = (profiles || []).filter(p => p.email);
    }

  } else if (audience === 'owners' || audience === 'owners_unmatched') {
    const { data: ownerProfiles } = await sb
      .from('profiles')
      .select('id,full_name,email')
      .in('role', ['owner', 'both'])
      .eq('admin_status', 'approved')
      .eq('email_confirmed', true);

    const allOwners = (ownerProfiles || []).filter(p => p.email);

    if (audience === 'owners_unmatched' && allOwners.length) {
      const ownerIds = allOwners.map(o => o.id);
      const { data: matched } = await sb
        .from('applications')
        .select('owner_id')
        .eq('status', 'approved')
        .is('unmatched_at', null)
        .in('owner_id', ownerIds);
      const matchedSet = new Set((matched || []).map(a => a.owner_id));
      recipients = allOwners.filter(o => !matchedSet.has(o.id));
    } else {
      recipients = allOwners;
    }
  }

  if (!recipients.length) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, sent: 0, skipped: 0, recipients: [], message: 'No eligible recipients found.' }),
    };
  }

  // Preview mode — return list without sending
  if (preview) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, preview: true, count: recipients.length, recipients }),
    };
  }

  // ── Send emails ───────────────────────────────────────────────────────────
  let sent = 0, failed = 0, failedList = [];

  for (const r of recipients) {
    const firstName = (r.full_name || '').split(' ')[0] || 'there';
    const personalised = textBody.replace(/\{\{name\}\}/g, firstName);

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [r.email],
          subject,
          text: personalised,
        }),
      });

      if (res.ok) {
        sent++;
      } else {
        const err = await res.json().catch(() => ({}));
        console.error('Resend failed for', r.email, err);
        failed++;
        failedList.push(r.email);
      }
    } catch (e) {
      console.error('Send error for', r.email, e.message);
      failed++;
      failedList.push(r.email);
    }

    // Throttle: 2 emails/sec to stay within Resend free limits
    await new Promise(res => setTimeout(res, 500));
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, sent, failed, failedList }),
  };
};
