function getEmailFromToken(authHeader) {
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const decoded = JSON.parse(json);
    return decoded.email || null;
  } catch (err) {
    return null;
  }
}

async function fetchWithRetry(url, options, retries = 3, delayMs = 800) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Hoeveel gratis pogingen iemand zonder (actief) betaald account krijgt,
// en waar ze naartoe gestuurd worden zodra die op zijn.
const TRIAL_LIMIET = 2;
const CHECKOUT_URL = 'https://shop.chillionaires.club/checkout/promptgenerator-trial';

// Zet een e-mailadres om naar de vorm die we gebruiken om de gratis-proberen-
// teller bij te houden, zodat de bekendste gratis trucjes om een "nieuw"
// adres te krijgen niet werken:
// - Alles na een "+" wordt genegeerd (naam+1@gmail.com → naam@gmail.com).
//   Dit werkt bij vrijwel elke provider, niet alleen Gmail.
// - Bij Gmail/Googlemail specifiek worden ook punten in het adres genegeerd
//   (naam.achternaam@gmail.com → naamachternaam@gmail.com), want dat doet
//   Gmail zelf ook — het is daar dezelfde inbox.
// Let op: dit raakt alleen de trial-teller. De check of iemand al een betaald
// account heeft blijft op het exacte, originele e-mailadres lopen.
function normaliseerVoorTrial(email) {
  const lower = email.trim().toLowerCase();
  const atIndex = lower.lastIndexOf('@');
  if (atIndex === -1) return lower;
  let local = lower.slice(0, atIndex).split('+')[0];
  const domain = lower.slice(atIndex + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Je bent niet ingelogd.' });

  const email = getEmailFromToken(authHeader);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

  // Wordt gevuld als dit een niet-betalende gebruiker is die deze poging mag
  // doen — zo weet de frontend na een geslaagde generatie meteen of dit de
  // laatste gratis poging was, zonder dat daar een 3e aanroep voor nodig is.
  let trialInfoVoorResponse = null;

  try {
    // 1. Heeft deze persoon een actief betaald account? (ongewijzigd t.o.v. voorheen)
    const checkResponse = await fetch(`${supabaseUrl}/rest/v1/users?select=status,einddatum`, {
      headers: { apikey: supabaseKey, Authorization: authHeader }
    });
    const rows = await checkResponse.json();
    const user = Array.isArray(rows) ? rows[0] : null;
    const vandaag = new Date().toISOString().slice(0, 10);
    const heeftBetaaldeToegang = user && user.status === 'actief' && (!user.einddatum || user.einddatum >= vandaag);

    if (!heeftBetaaldeToegang) {
      // 2. Geen (actief) betaald account: val terug op de gratis testpogingen.
      if (!email) {
        console.log('TOEGANG GEWEIGERD (geen e-mail uit token):', JSON.stringify({ gevondenRij: user || null }));
        return res.status(403).json({ error: 'Je hebt geen actieve toegang. Neem contact op als je denkt dat dit niet klopt.' });
      }

      // De eerste stap (vragen ophalen) telt NIET als gebruikte poging, alleen
      // de laatste stap (de prompt zelf maken) wel — vandaar de header die de
      // frontend meestuurt. Onbekend/ontbrekend = veilig aan de kant van
      // "verbruikt" (zo kan dit nooit per ongeluk omzeild worden).
      const trialStap = req.headers['x-trial-step'] === 'check' ? 'check' : 'consume';
      const rpcNaam = trialStap === 'check' ? 'trial_status' : 'trial_poging_verbruiken';
      const trialEmail = normaliseerVoorTrial(email);

      const trialResp = await fetchWithRetry(`${supabaseUrl}/rest/v1/rpc/${rpcNaam}`, {
        method: 'POST',
        headers: {
          apikey: supabaseSecret,
          Authorization: `Bearer ${supabaseSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_email: trialEmail, p_limiet: TRIAL_LIMIET }),
      });

      if (!trialResp.ok) {
        const errText = await trialResp.text();
        console.log('Trial-check mislukt, ook na herhaalde pogingen:', errText);
        return res.status(500).json({ error: 'Kon je testpogingen niet controleren.' });
      }

      const trialResult = await trialResp.json();
      const eersteRij = Array.isArray(trialResult) ? trialResult[0] : trialResult;
      const toegestaan = eersteRij ? eersteRij.toegestaan : false;
      const aantalGebruikt = eersteRij ? eersteRij.aantal_gebruikt : TRIAL_LIMIET;

      if (!toegestaan) {
        console.log('TRIAL OP:', JSON.stringify({ email, trialEmail, aantal: aantalGebruikt, stap: trialStap }));
        return res.status(403).json({
          error: 'Je testpogingen zijn op.',
          trialOp: true,
          checkoutUrl: CHECKOUT_URL,
        });
      }

      console.log('GRATIS TESTPOGING:', JSON.stringify({ email, trialEmail, aantal: aantalGebruikt, limiet: TRIAL_LIMIET, stap: trialStap }));

      trialInfoVoorResponse = { aantalGebruikt, limiet: TRIAL_LIMIET, checkoutUrl: CHECKOUT_URL };
    }
  } catch (err) {
    console.log('TOEGANGSCHECK MISLUKT:', JSON.stringify({ email, fout: err.message }));
    return res.status(500).json({ error: 'Kon toegang niet controleren.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    // Alleen toevoegen bij een geslaagde aanroep — bij een foutmelding van
    // Anthropic zelf blijft de response ongewijzigd.
    if (trialInfoVoorResponse && response.ok) {
      data._trial = trialInfoVoorResponse;
    }
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Er ging iets mis: ' + err.message });
  }
}
