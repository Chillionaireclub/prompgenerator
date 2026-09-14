export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);

  // --- Geheim woord controleren ---
  const providedSecret = url.searchParams.get('secret');
  if (!process.env.AC_WEBHOOK_SECRET || providedSecret !== process.env.AC_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Ongeldig of ontbrekend geheim woord' });
  }
  // --- Einde controle ---

  const data = req.body || {};
  console.log('Ontvangen van ActiveCampaign:', JSON.stringify(data));

  const email = data.email || data.contact_email || data['contact[email]'] || data.Email;

  if (!email) {
    console.log('Geen e-mailadres gevonden in payload:', JSON.stringify(data));
    return res.status(200).json({ received: true, warning: 'Geen e-mailadres gevonden', data });
  }

  const toegangType = url.searchParams.get('type') || 'onbekend';
  const maanden = parseInt(url.searchParams.get('maanden') || '6', 10);

  const vandaag = new Date();
  const einddatum = new Date(vandaag);
  einddatum.setMonth(einddatum.getMonth() + maanden);
  const toDateString = (d) => d.toISOString().slice(0, 10);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

  try {
    // 1. Rij in Supabase aanmaken of bijwerken
    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/users?on_conflict=email`, {
      method: 'POST',
      headers: {
        apikey: supabaseSecret,
        Authorization: `Bearer ${supabaseSecret}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify([
        {
          email,
          toegang_type: toegangType,
          status: 'actief',
          ingangsdatum: toDateString(vandaag),
          einddatum: toDateString(einddatum),
        },
      ]),
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      console.log('Supabase-fout:', errText);
      return res.status(500).json({ error: 'Kon Supabase niet bijwerken', details: errText });
    }

    // 2. Inloglink genereren bij Supabase, zonder dat Supabase er zelf een mail bij stuurt
    const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: supabaseSecret,
        Authorization: `Bearer ${supabaseSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'magiclink',
        email,
        options: { redirect_to: 'https://app.chillionaires.club' },
      }),
    });

    if (!linkRes.ok) {
      const errText = await linkRes.text();
      console.log('Kon geen inloglink genereren:', errText);
      return res.status(500).json({ error: 'Kon geen inloglink genereren', details: errText });
    }

    const linkData = await linkRes.json();
    const loginUrl = `https://app.chillionaires.club/?token_hash=${linkData.hashed_token}&type=email`;

    // 3. Onze eigen welkomstmail versturen via Resend
    const productNaam = toegangType.startsWith('guide') ? 'jouw guide' : 'de Prompt Generator';

    const emailHtml = `
      <div style="background:#fff8f1;padding:40px 20px;font-family:Helvetica,Arial,sans-serif;">
        <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:22px;padding:36px;border:1px solid rgba(122,62,72,0.15);">
          <h1 style="color:#2e1a1a;font-size:26px;margin:0 0 8px;">Je bent binnen! 🎉</h1>
          <p style="color:#7a5c50;font-size:15px;line-height:1.6;">Bedankt voor je aankoop van ${productNaam}. Je hebt nu ${maanden} maanden toegang tot de Prompt Generator.</p>
          <a href="${loginUrl}" style="display:inline-block;margin-top:20px;background:#7a3e48;color:#fff8f1;text-decoration:none;font-weight:bold;padding:14px 28px;border-radius:10px;">Ga naar de generator →</a>
          <p style="color:#a08070;font-size:12px;margin-top:28px;">Deze link werkt eenmalig. Kom je later terug? Vul dan gewoon opnieuw je e-mailadres in op app.chillionaires.club voor een nieuwe inloglink.</p>
        </div>
      </div>
    `;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Chillionaires <welkom@auth.chillionaires.club>',
        to: [email],
        subject: 'Je bent binnen! Hier is je toegang 🎉',
        html: emailHtml,
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.log('Kon welkomstmail niet versturen:', errText);
      return res.status(500).json({ error: 'Kon welkomstmail niet versturen', details: errText });
    }

    return res.status(200).json({
      success: true,
      email,
      toegangType,
      einddatum: toDateString(einddatum),
    });
  } catch (err) {
    console.log('Onverwachte fout:', err.message);
    return res.status(500).json({ error: 'Er ging iets mis: ' + err.message });
  }
}
