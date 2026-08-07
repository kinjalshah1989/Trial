import crypto from 'node:crypto';
import { sendCustomerOrderEmail, sendGlobalRaniOrderEmail } from '../shared/paid-order-fulfillment.mjs';

// This storefront always uses the project's standard Firestore database.
// Keep this fixed so a named database (for example, "globalrani") cannot be
// selected accidentally through deployment configuration.
const FIREBASE_PROJECT_ID = 'the-global-rani-website';
const FIRESTORE_DATABASE_ID = '(default)';


function parseServiceAccount(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return null;

  // Remove one wrapping layer of quotes if Netlify stored the value that way.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); }
    catch { value = value.slice(1, -1); }
  }
  value = String(value).trim();

  const parseJson = (candidate) => {
    try {
      const parsed = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  };

  let account = parseJson(value);
  if (!account && /^[A-Za-z0-9+/=_-]+$/.test(value.replace(/\s/g, ''))) {
    try {
      const decoded = Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8').trim();
      account = parseJson(decoded);
      if (!account && decoded.includes('BEGIN ')) account = { private_key: decoded };
    } catch {}
  }
  return account;
}

function normalizePrivateKey(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';
  value = value
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
  if (!body) return '';
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function getFirebaseCredentials() {
  const serviceAccount =
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) ||
    parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) ||
    {};

  const credentialProjectId = String(
    serviceAccount.project_id || serviceAccount.projectId || process.env.FIREBASE_PROJECT_ID || ''
  ).trim();
  const clientEmail = String(
    serviceAccount.client_email || serviceAccount.clientEmail || process.env.FIREBASE_CLIENT_EMAIL || ''
  ).trim();

  const privateKeyCandidates = [
    serviceAccount.private_key,
    serviceAccount.privateKey,
    process.env.FIREBASE_PRIVATE_KEY_BASE64
      ? (() => { try { return Buffer.from(process.env.FIREBASE_PRIVATE_KEY_BASE64, 'base64').toString('utf8'); } catch { return ''; } })()
      : '',
    process.env.FIREBASE_PRIVATE_KEY
  ];
  let privateKey = '';
  for (const candidate of privateKeyCandidates) {
    privateKey = normalizePrivateKey(candidate);
    if (privateKey) break;
  }
  return { projectId: FIREBASE_PROJECT_ID, credentialProjectId, clientEmail, privateKey };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 100).map(item => ({
    name: cleanText(item?.name, 180),
    quantity: Math.max(1, Math.min(99, Number(item?.quantity) || 1)),
    image: cleanText(item?.image, 1000),
    priceUSD: Number.isFinite(Number(item?.priceUSD)) ? Number(item.priceUSD) : null
  })).filter(item => item.name);
}


function verifyCheckoutToken(token) {
  const secret = process.env.CHECKOUT_SIGNING_SECRET || process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('Checkout signing secret is not configured.');
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw new Error('Secure checkout token is missing.');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Checkout validation failed.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload?.exp || Date.now() > Number(payload.exp)) throw new Error('Checkout session expired. Please try again.');
  return payload;
}

async function verifyStripeSession(sessionId) {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) throw new Error('Stripe server credentials are not configured.');
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) throw new Error('Stripe Checkout session ID is invalid.');
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` }
  });
  const session = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(session?.error?.message || `Stripe payment verification failed (${response.status}).`);
  if (session?.mode !== 'payment' || session?.metadata?.store !== 'global_rani') {
    throw new Error('This Stripe Checkout session does not belong to The Global Rani.');
  }
  if (session?.status !== 'complete' || session?.payment_status !== 'paid') {
    throw new Error('Stripe has not confirmed a completed payment.');
  }
  return session;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

async function getGoogleAccessToken() {
  const { credentialProjectId, clientEmail, privateKey } = getFirebaseCredentials();
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

function firestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  if (typeof value === 'object') {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, val]) => [key, firestoreValue(val)])) } };
  }
  return { stringValue: String(value) };
}

async function saveOrderToFirestore(orderId, orderData) {
  const { projectId } = getFirebaseCredentials();
  if (!projectId) throw new Error('Firebase project ID is not configured.');
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${FIRESTORE_DATABASE_ID}/documents/orders?documentId=${encodeURIComponent(orderId)}`;
  const fields = Object.fromEntries(Object.entries(orderData).map(([key, value]) => [key, firestoreValue(value)]));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    if (response.status === 409) return { alreadyExists: true };
    const detail = await response.text();
    throw new Error(`Firestore save failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const payload = await request.json();
    const stripeSessionId = cleanText(payload?.stripeSessionId, 160);
    if (!stripeSessionId) return json({ error: 'Stripe Checkout session ID is required.' }, 400);
    const secureCheckout = verifyCheckoutToken(payload?.checkoutToken);

    const session = await verifyStripeSession(stripeSessionId);
    const amountTotal = Number(session?.amount_total);
    const currency = String(session?.currency || '').toUpperCase();
    if (!secureCheckout.reference || session?.metadata?.checkout_reference !== secureCheckout.reference) throw new Error('Stripe Checkout session does not match this order.');
    if (String(currency).toUpperCase() !== String(secureCheckout.currency).toUpperCase()) throw new Error('Paid currency does not match the secure checkout.');
    if (!Number.isSafeInteger(amountTotal) || amountTotal !== Number(secureCheckout.amountTotal)) throw new Error('Paid amount does not match the secure server price.');
    const profile = payload?.shipping || {};
    const stripeCreatedAt = Number(session?.created) > 0 ? new Date(Number(session.created) * 1000) : new Date();
    const orderDate = stripeCreatedAt.toISOString().slice(0, 10).replaceAll('-', '');
    const orderSuffix = stripeSessionId.replace(/[^A-Za-z0-9]/g, '').slice(-12).toUpperCase();
    const orderNumber = `GR-${orderDate}-${orderSuffix}`;
    const orderData = {
      orderNumber,
      stripeCheckoutSessionId: stripeSessionId,
      stripePaymentIntentId: cleanText(typeof session?.payment_intent === 'string' ? session.payment_intent : session?.payment_intent?.id, 160),
      paymentStatus: 'PAID',
      amountMinor: amountTotal,
      amount: currency === 'JPY' ? String(amountTotal) : (amountTotal / 100).toFixed(2),
      currency: cleanText(currency, 10),
      createdAt: new Date().toISOString(),
      fulfillmentStatus: 'NEW',
      emailStatus: 'PENDING',
      adminEmailStatus: 'PENDING',
      customerEmailStatus: 'PENDING',
      firebaseUserId: cleanText(payload?.firebaseUserId, 160),
      checkoutMode: cleanText(payload?.checkoutMode, 20),
      customerName: cleanText(profile?.customerName, 180),
      customerEmail: cleanText(profile?.customerEmail, 254),
      customerEmailNormalized: cleanText(profile?.customerEmail, 254).toLowerCase(),
      customerPhone: cleanText(profile?.customerPhone, 60),
      shippingAddress: {
        line1: cleanText(profile?.shippingAddress1, 240),
        line2: cleanText(profile?.shippingAddress2, 240),
        city: cleanText(profile?.shippingCity, 120),
        state: cleanText(profile?.shippingState, 120),
        postalCode: cleanText(profile?.shippingZip, 40),
        country: cleanText(profile?.shippingCountry, 120)
      },
      deliveryNotes: cleanText(profile?.deliveryNotes, 1000),
      notes: cleanText(profile?.profileNotes, 1000),
      items: cleanItems(secureCheckout.items),
      tipUSD: Number(secureCheckout.tipUSD) || 0,
      payerEmail: cleanText(session?.customer_details?.email || session?.customer_email, 254),
      payerEmailNormalized: cleanText(session?.customer_details?.email || session?.customer_email, 254).toLowerCase()
    };
    if (!orderData.customerName || !orderData.customerEmail || !orderData.shippingAddress.line1 || !orderData.shippingAddress.city || !orderData.shippingAddress.postalCode) {
      return json({ error: 'Complete shipping details are required.' }, 400);
    }

    let stored = false;
    let emailed = false;
    let customerEmailed = false;
    let alreadyStored = false;
    try {
      const saved = await saveOrderToFirestore(orderNumber, orderData);
      stored = true;
      alreadyStored = saved?.alreadyExists === true;
    } catch (error) {
      console.error('Order storage failed:', error?.message || error);
    }
    if (!alreadyStored) {
      try {
        await sendGlobalRaniOrderEmail(orderData);
        emailed = true;
      } catch (error) {
        console.error('Store order email failed:', error?.message || error);
      }
      try {
        await sendCustomerOrderEmail(orderData);
        customerEmailed = true;
      } catch (error) {
        console.error('Customer order email failed:', error?.message || error);
      }
    }
    if (!stored && !emailed && !customerEmailed) {
      return json({ error: 'Payment succeeded, but the order record could not be delivered. Please contact support with your Stripe Checkout session ID.' }, 500);
    }
    return json({ ok: true, orderNumber, stored, emailed, customerEmailed, alreadyStored, stripeSessionId, amountTotal, currency });
  } catch (error) {
    console.error('create-order error:', error);
    return json({ error: error?.message || 'Order could not be recorded.' }, 500);
  }
}

export const config = { path: '/api/create-order' };
