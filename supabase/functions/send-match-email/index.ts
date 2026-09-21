import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const FROM = 'TrustMate <noreply@trustmatefleet.co.za>';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' };
const site = 'https://trustmatefleet.co.za';
const footer = '<p style="margin-top:24px;font-size:12px;color:#888">TrustMate Fleet - SA E-Hailing Driver-Owner Marketplace</p>';

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || !to) return;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!res.ok) console.error('Resend error', await res.text());
}

function btn(url: string, label: string) {
  return `<p style="margin-top:20px"><a href="${url}" style="background:#1a5c28;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:700">${label}</a></p>`;
}

function docRow(label: string, uploaded: boolean) {
  const icon = uploaded ? '✅' : '❌';
  const color = uploaded ? '#166534' : '#dc2626';
  return `<li style="padding:5px 0;color:${color}"><strong>${icon} ${label}</strong></li>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const body = await req.json();
  const { type, application_id, driver_profile_id } = body;
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Doc reminder types (use driver_profile_id, not application_id) ──────
  if (type === 'incomplete_reminder' || type === 'pending_docs_reminder') {
    if (!driver_profile_id) {
      return new Response(JSON.stringify({ error: 'Missing driver_profile_id' }), { status: 400, headers: CORS });
    }

    const { data: dp } = await sb
      .from('driver_profiles')
      .select('*')
      .eq('id', driver_profile_id)
      .maybeSingle();

    if (!dp) {
      return new Response(JSON.stringify({ error: 'Driver profile not found' }), { status: 404, headers: CORS });
    }

    const { data: prof } = await sb
      .from('profiles')
      .select('full_name, email')
      .eq('id', dp.user_id)
      .maybeSingle();

    const driverName = prof?.full_name ?? 'Driver';
    const driverEmail = prof?.email;

    if (!driverEmail) {
      return new Response(JSON.stringify({ ok: true, skipped: 'no_email' }), { headers: CORS });
    }

    if (type === 'incomplete_reminder') {
      const docs = [
        { label: 'Headshot photo', uploaded: !!dp.photo_headshot_url },
        { label: 'Full-body photo', uploaded: !!(dp.photo_fullbody_url || dp.photo_fullbody_path) },
        { label: 'Photo holding ID', uploaded: !!(dp.photo_holding_id_url || dp.photo_holding_id_path) },
        { label: 'SA ID / Passport', uploaded: !!(dp.doc_id_url || dp.doc_id_path) },
        { label: "Driver's Licence (front)", uploaded: !!(dp.doc_license_url || dp.doc_license_path) },
        { label: "Driver's Licence (back)", uploaded: !!(dp.doc_license_back_url || dp.doc_license_back_path) },
        { label: 'Proof of Residence', uploaded: !!(dp.proof_of_residence_url || dp.proof_of_residence_path) },
      ];
      const missing = docs.filter(d => !d.uploaded).length;
      await sendEmail(
        driverEmail,
        'Action Required: Complete Your TrustMate Documents',
        `<p>Hi ${driverName},</p>
<p>Your TrustMate driver application is <strong>incomplete</strong>. Please upload the missing documents below so your profile can be reviewed.</p>
<ul style="list-style:none;padding:0;margin:16px 0;font-size:14px;line-height:2">
${docs.map(d => docRow(d.label, d.uploaded)).join('')}
</ul>
<p style="font-size:13px;color:#666">${missing} document${missing !== 1 ? 's' : ''} still needed.</p>
${btn(site, 'Upload Documents Now')}${footer}`
      );
    } else {
      // pending_docs_reminder — platform screenshots
      const shots = [
        { label: 'Uber screenshot (trips & rating)', uploaded: !!dp.screenshot_uber_url },
        { label: 'Bolt screenshot (trips & rating)', uploaded: !!dp.screenshot_bolt_url },
        { label: 'InDrive screenshot (trips & rating)', uploaded: !!dp.screenshot_indrive_url },
      ];
      const hasPlatform = dp.platforms && dp.platforms.length > 0;
      const relevantShots = hasPlatform
        ? shots.filter(s => {
            const plat = s.label.split(' ')[0].toLowerCase();
            return (dp.platforms as string[]).some((p: string) => p.toLowerCase().includes(plat));
          })
        : shots;
      const missing = relevantShots.filter(s => !s.uploaded).length;
      await sendEmail(
        driverEmail,
        'Action Required: Upload Your Platform Screenshots - TrustMate',
        `<p>Hi ${driverName},</p>
<p>You're almost there! To complete your TrustMate application we need <strong>screenshots from your e-hailing platform(s)</strong> showing your trip count and driver rating.</p>
<ul style="list-style:none;padding:0;margin:16px 0;font-size:14px;line-height:2">
${relevantShots.map(s => docRow(s.label, s.uploaded)).join('')}
</ul>
<p style="font-size:13px;color:#666">Each screenshot must clearly show your username, total trips completed, and your star rating.</p>
${missing === 0 ? '<p style="color:#166534;font-weight:700">✅ All screenshots uploaded — your profile is under review!</p>' : `<p style="color:#dc2626"><strong>${missing} screenshot${missing !== 1 ? 's' : ''} still needed.</strong></p>`}
${missing > 0 ? btn(site, 'Upload Screenshots Now') : ''}${footer}`
      );
    }

    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
  }

  // ── Application-based types ──────────────────────────────────────────────
  const { data: app } = await sb
    .from('applications')
    .select('id, driver_id, owner_id, message, owner_notes, counter_price')
    .eq('id', application_id)
    .maybeSingle();

  if (!app) return new Response(JSON.stringify({ error: 'Application not found' }), { status: 404, headers: CORS });

  const [{ data: driverProfile }, { data: ownerProfile }] = await Promise.all([
    sb.from('profiles').select('full_name, email').eq('id', app.driver_id).maybeSingle(),
    sb.from('profiles').select('full_name, email').eq('id', app.owner_id).maybeSingle(),
  ]);

  const driverName  = driverProfile?.full_name ?? 'Driver';
  const ownerName   = ownerProfile?.full_name  ?? 'Vehicle Owner';
  const driverEmail = driverProfile?.email;
  const ownerEmail  = ownerProfile?.email;

  // owner sent a request to a driver
  if (type === 'owner_request') {
    if (driverEmail) {
      await sendEmail(
        driverEmail,
        `${ownerName} has sent you a vehicle request on TrustMate`,
        `<p>Hi ${driverName},</p>
<p>A vehicle owner (<strong>${ownerName}</strong>) has sent you a rental request on <strong>TrustMate Fleet</strong>.</p>
${app.message ? `<p>Their message: <em>"${app.message}"</em></p>` : ''}
<p>Log in to review and accept or decline this request.</p>
${btn(site, 'View Request')}${footer}`
      );
    }

  // match confirmed (owner accepted driver application, or driver accepted owner request)
  } else if (type === 'match_approved') {
    if (driverEmail) {
      await sendEmail(
        driverEmail,
        'You have been matched with a vehicle on TrustMate!',
        `<p>Hi ${driverName},</p>
<p>Congratulations! You have been <strong>matched with a vehicle owner</strong> on <strong>TrustMate Fleet</strong>.</p>
<p>Owner: <strong>${ownerName}</strong></p>
<p>Log in to view the owner contact details and get started.</p>
${btn(site, 'View Match')}${footer}`
      );
    }
    if (ownerEmail) {
      await sendEmail(
        ownerEmail,
        `Match confirmed - ${driverName} is now matched with your vehicle`,
        `<p>Hi ${ownerName},</p>
<p>Great news! <strong>${driverName}</strong> has been matched with your vehicle on <strong>TrustMate Fleet</strong>.</p>
<p>Log in to view the driver contact details.</p>
${btn(site, 'View Match')}${footer}`
      );
    }

  // owner declined a driver's application
  } else if (type === 'application_rejected') {
    if (driverEmail) {
      const reasonBlock = app.owner_notes
        ? `<p style="background:#fef2f2;border-left:3px solid #dc2626;padding:8px 12px;border-radius:4px;font-size:14px;color:#7f1d1d">Reason: <em>${app.owner_notes}</em></p>`
        : '';
      await sendEmail(
        driverEmail,
        'Your application was declined - TrustMate',
        `<p>Hi ${driverName},</p>
<p>Unfortunately, <strong>${ownerName}</strong> has declined your application on <strong>TrustMate Fleet</strong>.</p>
${reasonBlock}
<p>Don't be discouraged - there are other owners on the platform. Browse available vehicles and apply again.</p>
${btn(site, 'Browse Vehicles')}${footer}`
      );
    }

  // driver declined an owner's request
  } else if (type === 'driver_rejected') {
    if (ownerEmail) {
      await sendEmail(
        ownerEmail,
        `${driverName} declined your request - TrustMate`,
        `<p>Hi ${ownerName},</p>
<p><strong>${driverName}</strong> has declined your rental request on <strong>TrustMate Fleet</strong>.</p>
<p>You can browse more verified drivers on the platform and send a new request.</p>
${btn(site, 'Browse Drivers')}${footer}`
      );
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', ...CORS } });
});
