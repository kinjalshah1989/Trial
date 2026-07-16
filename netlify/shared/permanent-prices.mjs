import crypto from 'node:crypto';

let tokenCache = { token: '', expiresAt: 0 };

function parseServiceAccount(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
  }
  const parseJson = candidate => {
    try {
      const parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  };
  let account = parseJson(value);
  if (!account && /^[A-Za-z0-9+/=_\s-]+$/.test(value)) {
    try { account = parseJson(Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8').trim()); } catch {}
  }
  return account;
}

function normalizePrivateKey(rawValue) {
  let value = String(rawValue || '').trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
  const match = value.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/);
  if (!match) return '';
  const label = value.includes('BEGIN RSA PRIVATE KEY') ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return lines.length ? `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n` : '';
}

function credentials() {
  const account = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64)
    || parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    || {};
  const projectId = String(account.project_id || account.projectId || process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(account.client_email || account.clientEmail || process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const candidates = [
    account.private_key,
    account.privateKey,
    process.env.FIREBASE_PRIVATE_KEY_BASE64 ? (() => { try { return Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8'); } catch { return ''; } })() : '',
    process.env.FIREBASE_PRIVATE_KEY
  ];
  let privateKey = '';
  for (const candidate of candidates) {
    privateKey = normalizePrivateKey(candidate);
    if (privateKey) break;
  }
  return { projectId, clientEmail, privateKey };
}

function base64Url(value) { return Buffer.from(value).toString('base64url'); }

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const { clientEmail, privateKey } = credentials();
  if (!clientEmail || !privateKey) throw new Error('Firebase server credentials are not configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/datastore',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth2:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  });
  if (!response.ok) throw new Error(`Firebase authentication failed (${response.status}).`);
  const data = await response.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return tokenCache.token;
}

export function cleanProductId(value = '') {
  return String(value).replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function numberFromDocument(document) {
  const field = document?.fields?.price;
  const value = field?.integerValue ?? field?.doubleValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stableWholePrice(productId, min, max) {
  const low = Math.ceil(Number(min));
  const high = Math.floor(Number(max));
  const range = Math.max(1, high - low + 1);
  const digest = crypto.createHash('sha256').update(String(productId)).digest();
  const number = digest.readUInt32BE(0);
  return low + (number % range);
}

export async function getOrCreatePermanentPrice(productId, min = 79, max = 149) {
  const id = cleanProductId(productId);
  if (!id) throw new Error('Product ID is required.');
  const low = Number.isFinite(Number(min)) ? Number(min) : 79;
  const high = Number.isFinite(Number(max)) ? Number(max) : 149;
  if (high < low) throw new Error('Maximum product price must be greater than or equal to minimum price.');

  // This price is derived from the product ID, so it never changes on refresh,
  // redeploy, another browser, or a temporary Firebase outage.
  const stablePrice = stableWholePrice(id, low, high);
  const { projectId } = credentials();

  // Keep the storefront working even when Firebase has not been configured yet.
  // When Firebase becomes available, the exact same stable price is saved there.
  if (!projectId) return stablePrice;

  let token;
  try {
    token = await accessToken();
  } catch (error) {
    console.warn('Using stable product price because Firebase authentication is unavailable:', error?.message || error);
    return stablePrice;
  }

  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
  const documentUrl = `${base}/products/${encodeURIComponent(id)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let existing;
  try {
    existing = await fetch(documentUrl, { headers });
  } catch (error) {
    console.warn('Using stable product price because Firestore is unreachable:', error?.message || error);
    return stablePrice;
  }

  if (existing.ok) {
    const price = numberFromDocument(await existing.json());
    if (price !== null) return price;
  } else if (existing.status !== 404) {
    console.warn(`Using stable product price because Firestore lookup failed (${existing.status}).`);
    return stablePrice;
  }

  const price = stablePrice;
  const create = await fetch(`${base}/products?documentId=${encodeURIComponent(id)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields: {
      productId: { stringValue: id },
      price: { integerValue: String(price) },
      currency: { stringValue: 'USD' },
      createdAt: { timestampValue: new Date().toISOString() }
    } })
  });
  if (create.ok) return price;
  if (create.status === 409) {
    const winner = await fetch(documentUrl, { headers });
    if (winner.ok) {
      const saved = numberFromDocument(await winner.json());
      if (saved !== null) return saved;
    }
  }
  const detail = await create.text();
  console.warn(`Using stable product price because Firestore save failed (${create.status}): ${detail.slice(0, 180)}`);
  return stablePrice;
}

export function configuredSetPriceRange() {
  const min = Number(process.env.SET_PRICE_MIN_USD ?? 79);
  const max = Number(process.env.SET_PRICE_MAX_USD ?? 149);
  return {
    min: Number.isFinite(min) ? min : 79,
    max: Number.isFinite(max) ? max : 149
  };
}
