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

  // Log dit altijd, zodat we in Vercel > Logs precies kunnen zien
  // wat ActiveCampaign daadwerkelijk verstuurt.
  console.log('Ontvangen van ActiveCampaign:', JSON.stringify(data));

  // We proberen een paar veelvoorkomende veldnamen voor het e-mailadres.
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

    return res.status(200).json({ success: true, email, toegangType, einddatum: toDateString(einddatum) });
  } catch (err) {
    console.log('Onverwachte fout:', err.message);
    return res.status(500).json({ error: 'Er ging iets mis: ' + err.message });
  }
}
