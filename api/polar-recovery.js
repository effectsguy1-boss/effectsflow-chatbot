/**
 * EffectsFlow — Polar abandoned checkout recovery.
 *
 * Polar has no built-in cart recovery (it only sends receipts, renewal notices
 * and failed-payment dunning). This endpoint is that missing piece: it listens
 * to Polar checkout webhooks and drives the recovery through Sequenzy, using
 * the same tag-triggered pattern as every other flow in the account.
 *
 * Flow:  Polar webhook  ->  this function  ->  Sequenzy tag  ->  sequence sends
 *
 *   checkout open + email captured  -> add tag `cart-recovery` (+ attributes)
 *   checkout expired + email        -> same, belt and braces
 *   checkout succeeded / order      -> remove tag, so buyers are never chased,
 *                                      and add the ownership tag (owns-effectsflow /
 *                                      owns-textflow) so the purchase stoppers and
 *                                      the cart-recovery gates see the buyer
 *
 * The 5 recovery emails exist as staging HTML in Documents/Claude Code
 * (see EFG_Cart_Recovery_Flow.md). Build them as a Sequenzy sequence triggered
 * by `tag_added: cart-recovery` and this function feeds it.
 *
 * Env vars (Vercel -> Settings -> Environment Variables):
 *   POLAR_WEBHOOK_SECRET  = the whsec_... secret from the Polar endpoint  (required)
 *   SEQUENZY_API_KEY      = Sequenzy -> Settings -> API Keys              (required)
 *   POLAR_RECOVERY_URLS   = JSON map, product name or id -> Checkout Link  (recommended)
 *   POLAR_RECOVERY_URL    = single fallback Checkout Link                  (optional)
 *   RECOVERY_TAG          = tag name, defaults to `cart-recovery`    (optional)
 *   POLAR_OWNERSHIP_TAGS  = JSON map, product name or id -> ownership tag  (optional,
 *                           defaults to EffectsFlow Bundle -> owns-effectsflow,
 *                           TextFlow -> owns-textflow)
 *
 * Two things worth knowing before you wire this up:
 *
 * 1. A Polar checkout SESSION url is temporary and expires. Polar's own docs say
 *    to share the long-lived Checkout Link instead. So this writes two attributes:
 *    `checkout_url` (the live session, good for email 1) and `recovery_url` (your
 *    durable link, use it in emails 2 to 5 so the button never 404s).
 * 2. Sequenzy fires a tag_added sequence once per tag. If the tag is still on the
 *    subscriber from a previous abandon, a second abandon will not re-trigger.
 *    The purchase branch below removes it, which handles the common case.
 */

const crypto = require('crypto');

const SEQUENZY_BASE = 'https://api.sequenzy.com/api/v1';
const DEFAULT_TAG = 'cart-recovery';

// Vercel would otherwise consume the request stream, and the signature is
// computed over the exact raw bytes Polar sent.
module.exports.config = { api: { bodyParser: false } };

/* ------------------------------------------------------------------ raw body */

function readRawBody(req) {
  // Already buffered by the platform in some runtimes.
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      if (chunks.length) return resolve(Buffer.concat(chunks));
      // Stream was drained and parsed before we got here. Re-serialising is a
      // best effort and will usually fail the signature check, so shout about it.
      if (req.body && typeof req.body === 'object') {
        console.warn('raw body unavailable, falling back to re-serialised JSON — signature may fail');
        return resolve(Buffer.from(JSON.stringify(req.body), 'utf8'));
      }
      resolve(Buffer.alloc(0));
    });
    req.on('error', reject);
  });
}

/* --------------------------------------------------------------- signature */

/**
 * Standard Webhooks verification.
 *
 * Polar signs HMAC-SHA256 over `${id}.${timestamp}.${body}` but, unlike the
 * spec, uses the UTF-8 bytes of the FULL secret including the `whsec_` prefix.
 * Their own SDKs try both, so we do the same: whichever key matches, passes.
 */
function verify(rawBody, headers, secret) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) return false;

  // Reject anything more than 5 minutes out, either direction (replay guard).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const signed = `${id}.${timestamp}.${rawBody.toString('utf8')}`;

  const keys = [Buffer.from(secret, 'utf8')]; // Polar's current encoding
  if (secret.startsWith('whsec_')) {
    keys.push(Buffer.from(secret.slice(6), 'base64')); // Standard Webhooks spec key
  }

  const expected = keys.map((k) => crypto.createHmac('sha256', k).update(signed).digest('base64'));

  // Header is space separated, each entry `v1,<base64>`.
  return signatureHeader.split(' ').some((entry) => {
    const sig = entry.split(',')[1];
    if (!sig) return false;
    return expected.some((exp) => {
      const a = Buffer.from(sig);
      const b = Buffer.from(exp);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
  });
}

/* ----------------------------------------------------------------- sequenzy */

async function sequenzy(path, body, method = 'POST') {
  const r = await fetch(`${SEQUENZY_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.SEQUENZY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`sequenzy ${path} ${r.status} ${detail.slice(0, 300)}`);
  }
  return r.json().catch(() => ({}));
}

const addTag = (email, tag) => sequenzy('/subscribers/tags', { email, tag });
const removeTag = (email, tag) => sequenzy('/subscribers/tags/remove', { email, tag });

function patchAttributes(email, customAttributes) {
  // merge, so the popup's discount_code / source survive.
  return sequenzy(
    `/subscribers/${encodeURIComponent(email)}`,
    { customAttributes, customAttributesStrategy: 'merge' },
    'PATCH'
  );
}

/* ------------------------------------------------------------ recovery link */

/**
 * Which durable Checkout Link to send the customer back to.
 *
 * POLAR_RECOVERY_URLS is a JSON map keyed by Polar product id OR product name,
 * so a TextFlow abandon goes back to the TextFlow link and a Bundle abandon to
 * the Bundle link. POLAR_RECOVERY_URL is the fallback when nothing matches, and
 * the live session url is the fallback after that.
 *
 *   POLAR_RECOVERY_URLS = {"EffectsFlow Bundle":"https://buy.polar.sh/…","TextFlow":"https://buy.polar.sh/…"}
 */
function pickRecoveryUrl(data, productName) {
  let map = {};
  const raw = process.env.POLAR_RECOVERY_URLS;
  if (raw) {
    try { map = JSON.parse(raw); }
    catch (err) { console.warn('POLAR_RECOVERY_URLS is not valid JSON, ignoring it'); }
  }
  const productId = data.product_id || data.productId || data.product?.id;
  if (productId && map[productId]) return map[productId];
  if (productName) {
    const key = Object.keys(map).find((k) => k.toLowerCase() === productName.toLowerCase());
    if (key) return map[key];
  }
  return process.env.POLAR_RECOVERY_URL || data.url || '';
}

/* ---------------------------------------------------------- ownership tag */

/**
 * Sequenzy's native Polar integration tags buyers `customer` but never adds the
 * product ownership tags the rest of the account keys off (`owns-effectsflow`,
 * `owns-textflow`). Those used to come from the Lemon Squeezy webhook. This puts
 * them back for Polar orders so "Purchase, stop free nurture", the TextFlow
 * upsell stopper and the cart-recovery purchase gates all keep working.
 *
 *   POLAR_OWNERSHIP_TAGS = {"EffectsFlow Bundle":"owns-effectsflow","TextFlow":"owns-textflow"}
 */
const DEFAULT_OWNERSHIP_TAGS = {
  'EffectsFlow Bundle': 'owns-effectsflow',
  'EffectsFlow Plugin Full Access': 'owns-effectsflow',
  'EffectsFlow': 'owns-effectsflow',
  'TextFlow': 'owns-textflow',
};

function pickOwnershipTag(data, productName) {
  let map = DEFAULT_OWNERSHIP_TAGS;
  const raw = process.env.POLAR_OWNERSHIP_TAGS;
  if (raw) {
    try { map = { ...DEFAULT_OWNERSHIP_TAGS, ...JSON.parse(raw) }; }
    catch (err) { console.warn('POLAR_OWNERSHIP_TAGS is not valid JSON, using defaults'); }
  }
  const productId = data.product_id || data.productId || data.product?.id;
  if (productId && map[productId]) return map[productId];
  if (productName) {
    const key = Object.keys(map).find((k) => k.toLowerCase() === productName.toLowerCase());
    if (key) return map[key];
    // "EffectsFlow Bundle / Text Presets" style variants still mean the bundle.
    if (/effectsflow/i.test(productName)) return 'owns-effectsflow';
    if (/textflow/i.test(productName)) return 'owns-textflow';
  }
  return '';
}

/* ------------------------------------------------------------- junk emails */

/**
 * Polar's checkout accepts any syntactically valid address, so people testing
 * the page type "gfgfhf@gmail.com" and Gmail happily delivers all five recovery
 * emails to it (plus the LIMITED24 second bite). That is 10 sends to nobody, and
 * every one of them counts against the sending domain's reputation.
 *
 * This is deliberately conservative: it only rejects addresses no real person
 * would own. Anything borderline still gets the recovery flow.
 */
const JUNK_LOCALS = new Set([
  'test', 'testemail', 'testing', 'tester', 'example', 'sample', 'demo',
  'asdf', 'asdfg', 'asdfgh', 'qwerty', 'qwertyuiop', 'zxcv', 'abc', 'abcd', 'abcdef',
  'aaa', 'aaaa', 'xxx', 'xxxx', 'none', 'noemail', 'no', 'na', 'null', 'fake', 'spam',
  'email', 'mail', 'user', 'admin', 'info',
]);
const JUNK_DOMAINS = new Set([
  'example.com', 'test.com', 'email.com', 'mail.com', 'gmail.co', 'gmial.com',
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com',
  'sharklasers.com', 'temp-mail.org', 'tempmail.com', 'trashmail.com', 'getnada.com',
]);

function looksJunk(email) {
  const at = email.indexOf('@');
  if (at < 1) return true;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (JUNK_DOMAINS.has(domain)) return true;
  if (!domain.includes('.') || domain.length < 4) return true;

  const bare = local.replace(/[^a-z]/g, ''); // letters only: "rh851877" -> "rh"
  if (JUNK_LOCALS.has(bare) || JUNK_LOCALS.has(local)) return true;
  if (/(.)\1{3,}/.test(local)) return true; // aaaa, 1111
  // Five or more letters and not a single vowel: gfgfhf, ngh38fc, sdfghjk.
  if (bare.length >= 5 && !/[aeiouy]/.test(bare)) return true;
  return false;
}

/* -------------------------------------------------------------------- money */

function formatAmount(cents, currency) {
  if (typeof cents !== 'number') return '';
  const amount = cents / 100;
  const body = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return String(currency || 'usd').toLowerCase() === 'usd' ? `$${body}` : `${body} ${String(currency).toUpperCase()}`;
}

/* ------------------------------------------------------------------ handler */

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const secret = process.env.POLAR_WEBHOOK_SECRET;
  const apiKey = process.env.SEQUENZY_API_KEY;
  if (!secret || !apiKey) {
    console.error('missing POLAR_WEBHOOK_SECRET or SEQUENZY_API_KEY');
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  let event;
  try {
    const raw = await readRawBody(req);
    if (!verify(raw, req.headers, secret)) {
      console.warn('polar signature rejected');
      return res.status(403).json({ ok: false, error: 'bad_signature' });
    }
    event = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    console.error('polar payload error:', err);
    return res.status(400).json({ ok: false, error: 'bad_payload' });
  }

  const type = event.type;
  const data = event.data || {};
  const tag = (process.env.RECOVERY_TAG || DEFAULT_TAG).trim().toLowerCase();

  // Polar sends snake_case over the wire; read camelCase too so this survives
  // an SDK-shaped payload in testing.
  const email = String(data.customer_email || data.customerEmail || '').trim().toLowerCase();
  const status = data.status;

  try {
    /* ---- purchase: stop chasing, always runs first and wins ---- */
    const isPurchase =
      type === 'order.created' ||
      type === 'order.paid' ||
      ((type === 'checkout.updated' || type === 'checkout.created') && status === 'succeeded');

    if (isPurchase) {
      const buyer = email || String(data.customer?.email || '').trim().toLowerCase();
      if (!buyer) return res.status(202).json({ ok: true, skipped: 'no_email_on_purchase' });
      await removeTag(buyer, tag);
      console.log(`purchase, removed ${tag} from ${buyer}`);

      // Ownership tag. Never let this block the untag above: a failure here is
      // logged, the buyer is still out of the recovery flow.
      const boughtName =
        data.product?.name || (Array.isArray(data.products) && data.products[0]?.name) || '';
      const ownTag = pickOwnershipTag(data, boughtName);
      if (ownTag) {
        await addTag(buyer, ownTag)
          .then(() => console.log(`purchase, added ${ownTag} to ${buyer} (${boughtName || 'no product name'})`))
          .catch((err) => console.error('ownership tag failed (recovery tag already removed):', err.message));
      } else {
        console.warn(`purchase by ${buyer} with unmapped product "${boughtName}", no ownership tag added`);
      }
      return res.status(202).json({ ok: true, action: 'untagged', ownershipTag: ownTag || null });
    }

    /* ---- abandon: checkout is open or has expired, and we have an email ---- */
    const isAbandon =
      (type === 'checkout.updated' || type === 'checkout.created') && status === 'open'
        ? true
        : type === 'checkout.expired';

    if (!isAbandon) return res.status(202).json({ ok: true, skipped: `ignored:${type}` });
    if (!email) return res.status(202).json({ ok: true, skipped: 'no_email_yet' });
    if (looksJunk(email)) {
      console.warn(`junk email on abandon, not tagging: ${email}`);
      return res.status(202).json({ ok: true, skipped: 'junk_email' });
    }

    const product =
      data.product?.name || (Array.isArray(data.products) && data.products[0]?.name) || '';

    // Tag first: it creates the subscriber if new and triggers the sequence.
    await addTag(email, tag);

    // Then the merge fields the emails read. The sequence's first step waits an
    // hour, so writing these a moment later is fine.
    await patchAttributes(email, {
      checkout_url: data.url || '',
      recovery_url: pickRecoveryUrl(data, product),
      product_name: product,
      price: formatAmount(
        typeof data.total_amount === 'number' ? data.total_amount : data.totalAmount,
        data.currency
      ),
      checkout_id: data.id || '',
      abandoned_at: new Date().toISOString(),
      abandon_source: type,
      // Checkout Link metadata is copied onto the session, so `source: website`,
      // `source: marketing-email` etc. survives. Lets you compare recovery rate
      // per traffic source later without any extra work now.
      original_source: String(data.metadata?.source || ''),
    }).catch((err) => {
      // A failed attribute write must not lose the recovery. The tag is already on.
      console.error('attribute write failed (tag still applied):', err.message);
    });

    console.log(`tagged ${email} ${tag} (${type}, ${product || 'no product'})`);
    return res.status(202).json({ ok: true, action: 'tagged' });
  } catch (err) {
    console.error('recovery error:', err);
    // 5xx tells Polar to retry, which is what we want for a transient failure.
    return res.status(500).json({ ok: false, error: 'recovery_failed' });
  }
};
