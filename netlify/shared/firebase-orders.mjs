import crypto from 'node:crypto';

// Paid orders and pending checkouts are always stored in `(default)`.
const FIREBASE_PROJECT_ID = 'the-global-rani-website';
const FIRESTORE_DATABASE_ID = '(default)';

let tokenCache = { token: '', expiresAt: 0 };

function parseServiceAccount(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); }
    catch { value = value.slice(1, -1); }
  }
  const parseJson = candidate => {
    try {
      const parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  };
  let account = parseJson(value);
  if (!account && /^[A-Za-z0-9+/=_\s-]+$/.test(value)) {
    try { account = parseJson(Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8').trim()); }
    catch {}
  }
  return account;
}

function normalizePrivateKey(rawValue) {
  const value = String(rawValue || '').trim()
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
  const credentialProjectId = String(account.project_id || account.projectId || process.env.FIREBASE_PROJECT_ID || '').trim();
  const clientEmail = String(account.client_email || account.clientEmail || process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  const candidates = [
    account.private_key,
    account.privateKey,
    process.env.FIREBASE_PRIVATE_KEY_BASE64
      ? (() => { try { return Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8'); } catch { return ''; } })()
      : '',
    process.env.FIREBASE_PRIVATE_KEY
  ];
  let privateKey = '';
  for (const candidate of candidates) {
    privateKey = normalizePrivateKey(candidate);
    if (privateKey) break;
  }
  return { projectId: FIREBASE_PROJECT_ID, credentialProjectId, clientEmail, privateKey };
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const { credentialProjectId, clientEmail, privateKey } = credentials();
  if (credentialProjectId && credentialProjectId !== FIREBASE_PROJECT_ID) {
    throw new Error(`Firebase credentials belong to ${credentialProjectId}; expected ${FIREBASE_PROJECT_ID}.`);
  }
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
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`
    })
  });
  if (!response.ok) throw new Error(`Firebase authentication failed (${response.status}).`);
  const data = await response.json();
  if (!data?.access_token) throw new Error('Firebase authentication returned no access token.');
  tokenCache = { token: data.access_token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return tokenCache.token;
}

export function firestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, firestoreValue(item)]))
      }
    };
  }
  return { stringValue: String(value) };
}

export function fromFirestoreValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return decodeFields(value.mapValue?.fields || {});
  return null;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

function encodeFields(data) {
  return Object.fromEntries(Object.entries(data || {}).map(([key, value]) => [key, firestoreValue(value)]));
}

function baseDocumentsUrl() {
  const { projectId } = credentials();
  if (!projectId) throw new Error('Firebase project ID is not configured.');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${FIRESTORE_DATABASE_ID}/documents`;
}

function documentUrl(collection, documentId) {
  return `${baseDocumentsUrl()}/${encodeURIComponent(collection)}/${encodeURIComponent(documentId)}`;
}

async function authHeaders() {
  return {
    Authorization: `Bearer ${await accessToken()}`,
    'Content-Type': 'application/json'
  };
}

export async function getDocument(collection, documentId) {
  const response = await fetch(documentUrl(collection, documentId), { headers: await authHeaders() });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore read failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  const document = await response.json();
  return {
    id: documentId,
    name: document.name,
    createTime: document.createTime,
    updateTime: document.updateTime,
    ...decodeFields(document.fields || {})
  };
}

export async function queryDocumentsByStringFields(collection, filters) {
  const collectionId = String(collection || '').trim();
  if (!collectionId) throw new Error('Firestore collection is required.');

  const safeFilters = (Array.isArray(filters) ? filters : [])
    .map(filter => ({
      fieldPath: String(filter?.fieldPath || '').trim(),
      value: String(filter?.value || '').trim()
    }))
    .filter(filter => /^[A-Za-z_][A-Za-z0-9_]*$/.test(filter.fieldPath) && filter.value);
  if (!safeFilters.length) return [];

  const url = `${baseDocumentsUrl()}:runQuery`;
  const headers = await authHeaders();
  const resultSets = await Promise.all(safeFilters.map(async filter => {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath: filter.fieldPath },
              op: 'EQUAL',
              value: { stringValue: filter.value }
            }
          }
        }
      })
    });
    if (!response.ok) {
      throw new Error(`Firestore query failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
    }
    const rows = await response.json();
    return rows.filter(row => row.document).map(row => {
      const document = row.document;
      const id = decodeURIComponent(String(document.name || '').split('/').pop() || '');
      return {
        id,
        name: document.name,
        createTime: document.createTime,
        updateTime: document.updateTime,
        ...decodeFields(document.fields || {})
      };
    });
  }));

  return resultSets.flat();
}

export async function listDocuments(collection, { pageSize = 300, maxPages = 100 } = {}) {
  const collectionId = String(collection || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(collectionId)) {
    throw new Error('A valid Firestore collection is required.');
  }

  const safePageSize = Math.min(Math.max(Number(pageSize) || 300, 1), 300);
  const safeMaxPages = Math.min(Math.max(Number(maxPages) || 100, 1), 100);
  const headers = await authHeaders();
  const documents = [];
  let pageToken = '';

  for (let page = 0; page < safeMaxPages; page += 1) {
    const params = new URLSearchParams({ pageSize: String(safePageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await fetch(`${baseDocumentsUrl()}/${encodeURIComponent(collectionId)}?${params}`, { headers });
    if (!response.ok) {
      throw new Error(`Firestore list failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
    }

    const body = await response.json();
    for (const document of body.documents || []) {
      const id = decodeURIComponent(String(document.name || '').split('/').pop() || '');
      documents.push({
        id,
        name: document.name,
        createTime: document.createTime,
        updateTime: document.updateTime,
        ...decodeFields(document.fields || {})
      });
    }

    pageToken = String(body.nextPageToken || '').trim();
    if (!pageToken) return documents;
  }

  throw new Error('Firestore order history is too large to read safely in one request.');
}

export async function createDocument(collection, documentId, data) {
  const url = `${baseDocumentsUrl()}/${encodeURIComponent(collection)}?documentId=${encodeURIComponent(documentId)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ fields: encodeFields(data) })
  });
  if (response.status === 409) {
    return { created: false, document: await getDocument(collection, documentId) };
  }
  if (!response.ok) throw new Error(`Firestore create failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  const document = await response.json();
  return { created: true, document: { id: documentId, ...decodeFields(document.fields || {}) } };
}

export async function setDocument(collection, documentId, data) {
  const response = await fetch(documentUrl(collection, documentId), {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ fields: encodeFields(data) })
  });
  if (!response.ok) throw new Error(`Firestore write failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  const document = await response.json();
  return { id: documentId, ...decodeFields(document.fields || {}) };
}

export async function patchDocument(collection, documentId, updates) {
  const url = new URL(documentUrl(collection, documentId));
  Object.keys(updates).forEach(field => url.searchParams.append('updateMask.fieldPaths', field));
  const response = await fetch(url, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ fields: encodeFields(updates) })
  });
  if (!response.ok) throw new Error(`Firestore update failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  const document = await response.json();
  return { id: documentId, ...decodeFields(document.fields || {}) };
}

export function resetFirebaseTokenCacheForTests() {
  tokenCache = { token: '', expiresAt: 0 };
}
