export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from 'crypto';

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function parseBody(rawBodyString, contentType) {
  if (contentType && contentType.includes('application/json')) {
    try { return JSON.parse(rawBodyString); } catch { return {}; }
  }
  // ActiveCampaign stuurt standaard als form-data (key=value&key2=value2)
  const params = new URLSearchParams(rawBodyString);
  const obj = {};
  for (const [key, value] of params.entries()) obj[key] = value;
  return obj;
}

function findEmail(data) {
  // We proberen een paar veelvoorkomende veldnamen, want de exacte naam
  // hangt af van hoe ActiveCampaign het precies verstuurt.
  const candidates = ['email', 'contact_email', 'contact[email]', 'Email'];
  for (const key of candidates) {
    if (data[key]) return data[key];
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const rawBodyString = rawBody.toString('utf8');

  // --- Handtekening controleren ---
  const secret = process.env.AC_WEBHOOK_SECRET;
  const receivedSignature = req.headers['x-signature'];

  if (!secret) {
    return res.status(500).json({ error: 'AC_WEBHOOK_SECRET niet ingesteld' });
  }
  if (!receivedSignature) {
    return res.status(401).json({ error: 'Geen handtekening ontvangen' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const sigMatches =
    receivedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature));

  if (!sigMatches) {
    console.log('Handtekening kwam niet overeen. Ontvangen headers:', req.headers, 'Body:', rawBodyString);
    return res.status(401).json({ error: 'Ongeldige handtekening' });
  }
  // --- Einde handtekening controle ---

  const contentType = req.headers['content-type'] || '';
  const data = parseBody(rawBodyString, contentType);
  const email = findEmail(data);

  // Log dit altijd even, zodat we in Vercel > Logs precies kunnen zien
  // wat ActiveCampaign daadwerkelijk verstuurt, ook als alles goed gaat.
  console.log('Ontvangen van ActiveCampaign:', JSON.stringify(data));

  if (!email) {
    console.log('Geen e-mailadres gevonden in payload:', JSON.stringify(data));
    return res.status(200).json({ received: true, warning: 'Geen e-mailadres gevonden', data });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
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
