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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const { type, application_id } = await req.json();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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
