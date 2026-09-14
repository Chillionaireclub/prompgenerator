export default async function handler(req, res) {
  // Alleen POST toestaan
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- Toegangscontrole: is deze gebruiker ingelogd én heeft hij actieve toegang? ---
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Je bent niet ingelogd.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  try {
    const checkResponse = await fetch(
      `${supabaseUrl}/rest/v1/users?select=status,einddatum`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: authHeader
        }
      }
    );

    const rows = await checkResponse.json();
    const user = Array.isArray(rows) ? rows[0] : null;

    const vandaag = new Date().toISOString().slice(0, 10);
    const heeftToegang =
      user &&
      user.status === 'actief' &&
      (!user.einddatum || user.einddatum >= vandaag);

    if (!heeftToegang) {
      return res.status(403).json({
        error: 'Je hebt geen actieve toegang. Neem contact op als je denkt dat dit niet klopt.'
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Kon toegang niet controleren.' });
  }
  // --- Einde toegangscontrole ---

  // API sleutel uit environment variable (veilig, nooit zichtbaar voor bezoekers)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    return res.status(response.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Er ging iets mis: ' + err.message });
  }
}
