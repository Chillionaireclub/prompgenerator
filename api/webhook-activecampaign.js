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
  const acApiUrl = process.env.AC_API_URL;
  const acApiKey = process.env.AC_API_KEY;

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

    // 3. De juiste contactpersoon opzoeken in ActiveCampaign (via e-mailadres)
    const contactRes = await fetch(
      `${acApiUrl}/api/3/contacts?email=${encodeURIComponent(email)}`,
      { headers: { 'Api-Token': acApiKey } }
    );
    const contactData = await contactRes.json();
    const contact = contactData.contacts && contactData.contacts[0];

    if (!contact) {
      console.log('Contact niet gevonden in ActiveCampaign voor e-mail:', email);
      return res.status(200).json({
        success: true,
        warning: 'Rij in Supabase staat goed, maar contact niet gevonden in ActiveCampaign',
        email,
      });
    }

    // 4. Het juiste custom field opzoeken (op naam "Inloglink")
    const fieldsRes = await fetch(`${acApiUrl}/api/3/fields`, {
      headers: { 'Api-Token': acApiKey },
    });
    const fieldsData = await fieldsRes.json();
    const field = fieldsData.fields.find((f) => f.title === 'Inloglink');

    if (!field) {
      console.log('Veld "Inloglink" niet gevonden in ActiveCampaign');
      return res.status(200).json({
        success: true,
        warning: 'Rij in Supabase staat goed, maar veld "Inloglink" bestaat niet in ActiveCampaign',
        email,
      });
    }

    // 5. De link in dat veld zetten bij het contact
    const fieldValueRes = await fetch(`${acApiUrl}/api/3/fieldValues`, {
      method: 'POST',
      headers: {
        'Api-Token': acApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fieldValue: {
          contact: contact.id,
          field: field.id,
          value: loginUrl,
        },
      }),
    });

    if (!fieldValueRes.ok) {
      const errText = await fieldValueRes.text();
      console.log('Kon veld niet bijwerken in ActiveCampaign:', errText);
      return res.status(500).json({ error: 'Kon ActiveCampaign niet bijwerken', details: errText });
    }

    return res.status(200).json({
      success: true,
      email,
      toegangType,
      einddatum: toDateString(einddatum),
      loginUrl,
    });
  } catch (err) {
    console.log('Onverwachte fout:', err.message);
    return res.status(500).json({ error: 'Er ging iets mis: ' + err.message });
  }
}
