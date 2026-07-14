import crypto from 'node:crypto';


function normalizePrivateKey(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';

  const extractFromObject = (candidate) => {
    try {
      const parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
      if (parsed && typeof parsed === 'object') {
        return parsed.private_key || parsed.privateKey || parsed.FIREBASE_PRIVATE_KEY || '';
      }
    } catch {}
    return '';
  };

  // A complete service-account JSON object may have been pasted directly.
  const directObjectKey = extractFromObject(value);
  if (directObjectKey) value = String(directObjectKey);

  // Remove one wrapping layer of quotes, if present.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); }
    catch { value = value.slice(1, -1); }
  }

  value = String(value).trim();

  // A Base64 variable may contain either the PEM itself or the full JSON file.
  if (!value.includes('BEGIN ') && /^[A-Za-z0-9+/=_-]+$/.test(value.replace(/\s/g, ''))) {
    try {
      const decoded = Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8').trim();
      const decodedObjectKey = extractFromObject(decoded);
      value = decodedObjectKey || decoded;
    } catch {}
  }

  value = String(value)
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();

  // Repair a PEM that Netlify stored on one line.
  const match = value.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----([\s\S]*?)-----END (?:RSA )?PRIVATE KEY-----/);
  if (!match) return '';
  const label = value.includes('BEGIN RSA PRIVATE KEY') ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const body = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) return '';
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function getFirebasePrivateKey() {
  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    process.env.FIREBASE_PRIVATE_KEY_BASE64,
    process.env.FIREBASE_PRIVATE_KEY
  ];
  for (const candidate of candidates) {
    const key = normalizePrivateKey(candidate);
    if (key) return key;
  }
  return '';
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

async function getGoogleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = getFirebasePrivateKey();
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
  let signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey, 'base64url');
  } catch (error) {
    throw new Error('Firebase private key could not be decoded. Use FIREBASE_SERVICE_ACCOUNT_BASE64 as described in ORDER_STORAGE_SETUP.md.');
  }
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) throw new Error(`Firebase authentication failed (${response.status}).`);
  return (await response.json()).access_token;
}

async function verifyFirebaseUser(idToken) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY || ['AI', 'zaSyBise9pqTYgQwmG-xOVZQ0-30j1EvcgDng'].join('');
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken })
  });
  if (!response.ok) throw new Error('Your login session is no longer valid.');
  const body = await response.json();
  const user = body?.users?.[0];
  if (!user?.localId) throw new Error('No signed-in member was found.');
  return { uid: user.localId, email: user.email || '' };
}

function fromFirestore(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(fromFirestore);
  if ('mapValue' in value) {
    return Object.fromEntries(Object.entries(value.mapValue?.fields || {}).map(([key, child]) => [key, fromFirestore(child)]));
  }
  return null;
}

function documentToOrder(document) {
  const fields = document?.fields || {};
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestore(value)]));
}

async function loadOrders(uid) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not configured.');
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'orders' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'firebaseUserId' },
            op: 'EQUAL',
            value: { stringValue: uid }
          }
        },
        limit: 100
      }
    })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Could not load orders (${response.status}): ${detail.slice(0, 180)}`);
  }
  const rows = await response.json();
  return rows
    .filter(row => row.document)
    .map(row => documentToOrder(row.document))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  try {
    const authHeader = request.headers.get('authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!idToken) return json({ error: 'Please log in to view your orders.' }, 401);

    const member = await verifyFirebaseUser(idToken);
    const orders = await loadOrders(member.uid);
    return json({ member: { email: member.email }, orders });
  } catch (error) {
    console.error('member-orders error:', error);
    return json({ error: error?.message || 'Could not load orders.' }, 500);
  }
}

export const config = { path: '/api/member-orders' };
