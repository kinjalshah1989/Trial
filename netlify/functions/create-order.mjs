import crypto from 'node:crypto';


function normalizePrivateKey(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) return '';

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { value = JSON.parse(value); }
    catch { value = value.slice(1, -1); }
  }

  value = String(value)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();

  if (!value.includes('BEGIN PRIVATE KEY')) {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8').trim();
      if (decoded.includes('BEGIN PRIVATE KEY')) value = decoded;
    } catch {}
  }

  value = value
    .replace(/-----BEGIN PRIVATE KEY-----\s*/g, '-----BEGIN PRIVATE KEY-----\n')
    .replace(/\s*-----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----')
    .trim();

  return value.endsWith('\n') ? value : `${value}\n`;
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

function getPayPalBaseUrl() {
  return String(process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';
}

async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('PayPal server credentials are not configured.');
  const response = await fetch(`${getPayPalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!response.ok) throw new Error(`PayPal authentication failed (${response.status}).`);
  return (await response.json()).access_token;
}

async function verifyPayPalOrder(orderId) {
  const token = await getPayPalAccessToken();
  const response = await fetch(`${getPayPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`PayPal order verification failed (${response.status}).`);
  const order = await response.json();
  const captures = (order.purchase_units || []).flatMap(unit => unit?.payments?.captures || []);
  const completedCapture = captures.find(capture => capture?.status === 'COMPLETED');
  if (order.status !== 'COMPLETED' || !completedCapture) throw new Error('PayPal has not confirmed a completed payment.');
  return { order, capture: completedCapture };
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

async function getGoogleAccessToken() {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);
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
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not configured.');
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/orders?documentId=${encodeURIComponent(orderId)}`;
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
    const detail = await response.text();
    throw new Error(`Firestore save failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

async function sendOrderEmail(orderData) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ORDER_NOTIFICATION_EMAIL;
  const from = process.env.ORDER_FROM_EMAIL;
  if (!apiKey || !to || !from) throw new Error('Order email environment variables are not configured.');
  const items = orderData.items.map(item => `<li>${escapeHtml(item.name)} × ${item.quantity}</li>`).join('');
  const address = orderData.shippingAddress;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: orderData.customerEmail || undefined,
      subject: `New Global Rani order ${orderData.orderNumber}`,
      html: `
        <h2>New paid Global Rani order</h2>
        <p><strong>Order:</strong> ${escapeHtml(orderData.orderNumber)}</p>
        <p><strong>PayPal capture:</strong> ${escapeHtml(orderData.paypalCaptureId)}</p>
        <p><strong>Paid:</strong> ${escapeHtml(orderData.amount)} ${escapeHtml(orderData.currency)}</p>
        <h3>Customer</h3>
        <p>${escapeHtml(orderData.customerName)}<br>${escapeHtml(orderData.customerEmail)}<br>${escapeHtml(orderData.customerPhone)}</p>
        <h3>Shipping address</h3>
        <p>${escapeHtml(address.line1)}<br>${escapeHtml(address.line2)}<br>${escapeHtml(address.city)}, ${escapeHtml(address.state)} ${escapeHtml(address.postalCode)}<br>${escapeHtml(address.country)}</p>
        <h3>Items</h3><ul>${items}</ul>
        <p><strong>Notes:</strong> ${escapeHtml(orderData.notes)}</p>`
    })
  });
  if (!response.ok) throw new Error(`Order email failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const payload = await request.json();
    const paypalOrderId = cleanText(payload?.paypalOrderId, 120);
    if (!paypalOrderId) return json({ error: 'PayPal order ID is required.' }, 400);

    const { order, capture } = await verifyPayPalOrder(paypalOrderId);
    const amount = capture?.amount?.value || order?.purchase_units?.[0]?.amount?.value || '';
    const currency = capture?.amount?.currency_code || order?.purchase_units?.[0]?.amount?.currency_code || '';
    const profile = payload?.shipping || {};
    const orderNumber = `GR-${new Date().toISOString().slice(0,10).replaceAll('-', '')}-${paypalOrderId.slice(-8).toUpperCase()}`;
    const orderData = {
      orderNumber,
      paypalOrderId,
      paypalCaptureId: cleanText(capture?.id, 120),
      paymentStatus: 'PAID',
      amount: cleanText(amount, 30),
      currency: cleanText(currency, 10),
      createdAt: new Date().toISOString(),
      fulfillmentStatus: 'NEW',
      firebaseUserId: cleanText(payload?.firebaseUserId, 160),
      checkoutMode: cleanText(payload?.checkoutMode, 20),
      customerName: cleanText(profile?.customerName, 180),
      customerEmail: cleanText(profile?.customerEmail, 254),
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
      items: cleanItems(payload?.items),
      payerEmail: cleanText(order?.payer?.email_address, 254)
    };
    if (!orderData.customerName || !orderData.customerEmail || !orderData.shippingAddress.line1 || !orderData.shippingAddress.city || !orderData.shippingAddress.postalCode) {
      return json({ error: 'Complete shipping details are required.' }, 400);
    }

    const results = await Promise.allSettled([
      saveOrderToFirestore(orderNumber, orderData),
      sendOrderEmail(orderData)
    ]);
    const stored = results[0].status === 'fulfilled';
    const emailed = results[1].status === 'fulfilled';
    if (!stored && !emailed) {
      console.error('Order persistence failed', results.map(result => result.status === 'rejected' ? result.reason?.message : 'ok'));
      return json({ error: 'Payment succeeded, but the order record could not be delivered. Please contact support with your PayPal order ID.' }, 500);
    }
    return json({ ok: true, orderNumber, stored, emailed });
  } catch (error) {
    console.error('create-order error:', error);
    return json({ error: error?.message || 'Order could not be recorded.' }, 500);
  }
}

export const config = { path: '/api/create-order' };
