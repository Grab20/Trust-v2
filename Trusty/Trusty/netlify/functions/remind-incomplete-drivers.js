/**
 * remind-incomplete-drivers
 * Scheduled daily at 9am SAST (7am UTC).
 *
 * Sends personalised reminder emails to:
 *   - "incomplete" drivers: missing ID/photo documents — shows per-doc tick/X checklist
 *   - "pending_docs" drivers: missing platform screenshots — shows per-platform tick/X checklist
 *
 * Delegates email rendering to the send-match-email edge function which uses
 * service-role to read each driver's actual upload state and builds the checklist.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EDGE_FN_URL          = process.env.SUPABASE_EDGE_URL
  || (SUPABASE_URL ? SUPABASE_URL.replace('supabase.co', 'supabase.co') + '/functions/v1/send-match-email' : null);
const EDGE_ANON_KEY        = process.env.SUPABASE_ANON_KEY;

// Hardcoded fallback so the function works even if the env var isn't set
const EDGE_URL = 'https://qyyflivkmnwikagnvstv.supabase.co/functions/v1/send-match-email';

// Batch size — Resend free tier allows 100 emails/day; raise if on paid plan
const BATCH_SIZE = 100;

exports.handler = async function () {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase env vars');
    return { statusCode: 500, body: 'Config error' };
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Fetch all incomplete and pending_docs driver profile IDs in one query
  const { data: drivers, error } = await sb
    .from('driver_profiles')
    .select('id, status, user_id')
    .in('status', ['incomplete', 'pending_docs'])
    .is('is_removed', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE * 2);  // fetch up to 200; BATCH_SIZE applied per type below

  if (error) {
    console.error('DB error:', error);
    return { statusCode: 500, body: 'DB error' };
  }

  if (!drivers || !drivers.length) {
    console.log('No drivers to remind.');
    return { statusCode: 200, body: 'No drivers' };
  }

  const incomplete   = drivers.filter(d => d.status === 'incomplete').slice(0, BATCH_SIZE);
  const pendingDocs  = drivers.filter(d => d.status === 'pending_docs').slice(0, BATCH_SIZE);

  console.log(`Reminding: ${incomplete.length} incomplete, ${pendingDocs.length} pending_docs`);

  let sent = 0, failed = 0;

  async function callEdge(driver_profile_id, type) {
    try {
      const res = await fetch(EDGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${EDGE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''}`,
        },
        body: JSON.stringify({ type, driver_profile_id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        console.error(`Edge fn error for ${driver_profile_id} (${type}):`, body.error || res.status);
        failed++;
      } else if (body.skipped) {
        console.log(`Skipped ${driver_profile_id} — ${body.skipped}`);
      } else {
        sent++;
      }
    } catch (e) {
      console.error(`Fetch error for ${driver_profile_id}:`, e.message);
      failed++;
    }
  }

  // Send in series to stay within Resend rate limits
  for (const d of incomplete)  await callEdge(d.id, 'incomplete_reminder');
  for (const d of pendingDocs) await callEdge(d.id, 'pending_docs_reminder');

  console.log(`Driver reminders done: sent=${sent}, failed=${failed}`);
  return { statusCode: 200, body: `sent=${sent} failed=${failed}` };
};
