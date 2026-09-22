/**
 * EffectsFlow — email capture endpoint for the scratch-and-win popup.
 *
 * The popup POSTs { email, code, source } here (form-encoded). This function
 * validates the email and creates the subscriber in Sequenzy, tagged with the
 * popup source so sequences can trigger off it. Optionally it also appends a
 * row to the Google Sheet as a backup list (non-blocking — a Sheet failure
 * never fails the signup).
 *
 * Why route through Vercel instead of posting straight to Sequenzy:
 *   - only accepts requests from your store (origin allowlist)
 *   - validates the email server-side
 *   - keeps the Sequenzy API key out of the page source
 *
 * Tagging: the live Sequenzy sequence "Website Email Collection — LIMITED24" fires on the
 * tag `limited24`, so the discount code is lowercased and sent as a tag alongside the source.
 * Without that tag the subscriber lands but no email ever goes out.
 *
 * Env vars (set in Vercel → Settings → Environment Variables):
 *   SEQUENZY_API_KEY  = Sequenzy dashboard → Settings → API Keys   (required)
 *   SHEET_WEBHOOK_URL = Google Apps Script Web App /exec URL       (optional backup)
 *   SEQUENZY_TAGS     = extra tags, comma separated                (optional safety net)
 */

const ALLOWED_ORIGINS = ['https://theeffectsguy.store', 'https://www.theeffectsguy.store'];
const SEQUENZY_URL = 'https://api.sequenzy.com/api/v1/subscribers';

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    // Vercel parses JSON + form-urlencoded into req.body; handle strings just in case.
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); }
      catch (_) { body = Object.fromEntries(new URLSearchParams(body)); }
    }
    body = body || {};

    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').slice(0, 60);
    const source = String(body.source || 'scratch-popup').slice(0, 60);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }

    // The sequence triggers on the discount-code tag, not on the source, so send both.
    const extraTags = String(process.env.SEQUENZY_TAGS || '')
      .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const tags = [...new Set([source, code.toLowerCase(), ...extraTags].filter(Boolean))];

    const apiKey = process.env.SEQUENZY_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'no_sequenzy_key_configured' });

    // Backup row to the Google Sheet, fire-and-forget: never blocks or fails the signup.
    const sheetWebhook = process.env.SHEET_WEBHOOK_URL;
    const sheetWrite = sheetWebhook
      ? fetch(sheetWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ email, code, source }),
        }).catch((err) => console.error('sheet backup failed:', err))
      : Promise.resolve();

    const r = await fetch(SEQUENZY_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        tags,
        customAttributes: { discount_code: code, source },
        enrollInSequences: true,
      }),
    });

    await sheetWrite;

    // An already-subscribed email is a success from the customer's side.
    if (r.status === 409) return res.status(200).json({ ok: true, already_subscribed: true });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('sequenzy error:', r.status, detail.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'sequenzy_write_failed' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('subscribe error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};
