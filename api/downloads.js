/**
 * Secure downloads endpoint for the My Orders portal.
 *
 * Drop this file into your existing effectsflow-chatbot Vercel project as
 * /api/downloads.js and deploy. Then in the Shopify theme customizer, set
 * the portal section's "Downloads API URL" to:
 *   https://effectsflow-chatbot.vercel.app/api/downloads
 *
 * What it does:
 *  - Receives { email, license_key } from the portal
 *  - Validates the key SERVER-SIDE against Lemon Squeezy (store #199871)
 *  - Checks the email matches the order's email — can't be bypassed in devtools
 *  - Returns the download links ONLY on success
 *
 * With this live, the portal page source contains zero download links.
 * The links below live only on the server.
 */

const STORE_ID = 199871;

const ZXP = 'https://www.dropbox.com/scl/fi/577e439i9hsb5ycg83cu8/com.axwt.effectsflow-1.zxp?rlkey=yq9qhvh6clne6uatvyumn4ngw&st=ks1urulf&dl=0';
const GUIDE = 'https://youtu.be/rY7hHsfZe5E';

// Keys must match the product names in the portal, lowercased, alphanumeric only.
const DOWNLOADS = {
  effectsflow: {
    plugin: ZXP,
    pack: 'https://www.dropbox.com/scl/fo/ychmdzmviqjo4wwtak1qv/APbTi_M8l1D5DBcC1DNcAYg?rlkey=9gx5g16pczu2krml6logxsaj0&st=7g4y1lgl&dl=0',
    guide: GUIDE,
  },
  textflow: {
    plugin: ZXP,
    pack: 'https://www.dropbox.com/scl/fi/dalg7m3bcr2mq2z9wvw0h/TextFlow.effpack?rlkey=tunpmcqnse5kgv8fn2gmhl3vh&st=24e28m1g&dl=0',
    guide: GUIDE,
  },
};

// Which products each Lemon Squeezy purchase unlocks, matched by substring
// against the LS product/variant name (same logic as the portal).
function unlockedProducts(productName) {
  const hay = String(productName || '').toLowerCase();
  const products = {};
  if (hay.includes('effectsflow')) {
    products.effectsflow = DOWNLOADS.effectsflow;
    products.textflow = DOWNLOADS.textflow; // bundle includes TextFlow
  }
  if (hay.includes('textflow') || hay.includes('viral text')) {
    products.textflow = DOWNLOADS.textflow;
  }
  return products;
}

const ALLOWED_ORIGINS = ['https://theeffectsguy.store', 'https://www.theeffectsguy.store'];

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const { email, license_key: licenseKey } = req.body || {};
  if (!email || !licenseKey) return res.status(400).json({ ok: false, error: 'missing_fields' });

  let data = null;
  try {
    const r = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: String(licenseKey).trim().toLowerCase() }),
    });
    data = await r.json().catch(() => null);
  } catch (_) {
    return res.status(502).json({ ok: false, error: 'license_server_unreachable' });
  }

  if (!data || !data.valid) return res.status(403).json({ ok: false, error: 'invalid_key' });

  const meta = data.meta || {};
  const status = data.license_key && data.license_key.status;
  if (Number(meta.store_id) !== STORE_ID) return res.status(403).json({ ok: false, error: 'invalid_key' });
  if (status === 'disabled' || status === 'expired') return res.status(403).json({ ok: false, error: 'license_' + status });
  if (String(meta.customer_email || '').toLowerCase() !== String(email).trim().toLowerCase()) {
    return res.status(403).json({ ok: false, error: 'email_mismatch' });
  }

  const productName = (meta.product_name || '') + ' ' + (meta.variant_name || '');
  const products = unlockedProducts(productName);
  if (!Object.keys(products).length) return res.status(403).json({ ok: false, error: 'no_products' });

  return res.status(200).json({ ok: true, products });
};
