import { createDocument } from '../shared/firebase-orders.mjs';
import { cleanText, orderNumberForSession } from '../shared/paid-order-fulfillment.mjs';
import { verifyFirebaseUser } from './member-orders.mjs';

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function displayAmount(amountMinor, currency) {
  return ZERO_DECIMAL_CURRENCIES.has(currency)
    ? String(amountMinor)
    : (Number(amountMinor) / 100).toFixed(2);
}

async function stripeGet(path, params = {}) {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured in Netlify.');
  const url = new URL(`https://api.stripe.com/v1${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Stripe history request failed (${response.status}).`);
  return body;
}

async function listPaidGlobalRaniSessions(email) {
  const sessions = [];
  let startingAfter = '';
  for (let page = 0; page < 100; page += 1) {
    const body = await stripeGet('/checkout/sessions', {
      limit: 100,
      status: 'complete',
      'customer_details[email]': email,
      starting_after: startingAfter
    });
    const pageSessions = Array.isArray(body?.data) ? body.data : [];
    sessions.push(...pageSessions.filter(session =>
      session?.mode === 'payment' &&
      session?.payment_status === 'paid' &&
      session?.metadata?.store === 'global_rani' &&
      normalizedEmail(session?.customer_details?.email || session?.customer_email) === normalizedEmail(email)
    ));
    if (!body?.has_more) return sessions;
    startingAfter = String(pageSessions.at(-1)?.id || '');
    if (!startingAfter) throw new Error('Stripe returned an invalid order-history page.');
  }
  throw new Error('Stripe order history is too large to recover in one request.');
}

async function listLineItems(sessionId) {
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(String(sessionId || ''))) {
    throw new Error('Stripe returned an invalid Checkout Session ID.');
  }
  const items = [];
  let startingAfter = '';
  for (let page = 0; page < 10; page += 1) {
    const body = await stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`, {
      limit: 100,
      'expand[]': 'data.price.product',
      starting_after: startingAfter
    });
    const pageItems = Array.isArray(body?.data) ? body.data : [];
    items.push(...pageItems);
    if (!body?.has_more) return items;
    startingAfter = String(pageItems.at(-1)?.id || '');
    if (!startingAfter) throw new Error('Stripe returned an invalid line-item page.');
  }
  throw new Error('A Stripe order has too many line items to recover safely.');
}

function recoveredItems(lineItems, currency) {
  return lineItems.slice(0, 100).map(item => {
    const quantity = Math.max(1, Math.min(99, Math.floor(Number(item?.quantity) || 1)));
    const unitMinor = Number(item?.price?.unit_amount);
    const product = item?.price?.product && typeof item.price.product === 'object' ? item.price.product : {};
    const image = Array.isArray(product?.images)
      ? String(product.images.find(value => /^https:\/\//i.test(String(value || ''))) || '')
      : '';
    return {
      name: cleanText(item?.description || 'Product', 180),
      quantity,
      image: cleanText(image, 1000),
      priceUSD: currency === 'USD' && Number.isFinite(unitMinor) ? unitMinor / 100 : null
    };
  }).filter(item => item.name);
}

function buildRecoveredOrder(session, member, lineItems) {
  const amountMinor = Number(session?.amount_total);
  const currency = cleanText(session?.currency, 10).toUpperCase();
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !currency) {
    throw new Error(`Stripe Checkout Session ${cleanText(session?.id, 180)} has an invalid payment total.`);
  }
  const email = cleanText(session?.customer_details?.email || session?.customer_email, 254);
  if (normalizedEmail(email) !== normalizedEmail(member.email)) {
    throw new Error('Stripe returned an order for a different customer email.');
  }
  const paidAt = Number(session?.created) > 0
    ? new Date(Number(session.created) * 1000).toISOString()
    : new Date().toISOString();
  const shipping = session?.shipping_details || session?.collected_information?.shipping_details || {};
  const address = shipping?.address || session?.customer_details?.address || {};
  return {
    orderNumber: orderNumberForSession(session),
    stripeCheckoutSessionId: cleanText(session.id, 180),
    stripePaymentIntentId: cleanText(typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id, 180),
    paymentStatus: 'PAID',
    amountMinor,
    amount: displayAmount(amountMinor, currency),
    currency,
    createdAt: paidAt,
    paidAt,
    fulfillmentStatus: 'PAID',
    emailStatus: 'HISTORICAL',
    adminEmailStatus: 'SKIPPED',
    customerEmailStatus: 'SKIPPED',
    notificationSuppressed: true,
    recoveredFromStripe: true,
    recoveredAt: new Date().toISOString(),
    firebaseUserId: cleanText(member.uid, 180),
    checkoutMode: 'recovered',
    customerName: cleanText(session?.customer_details?.name || shipping?.name || email.split('@')[0], 180),
    customerEmail: email,
    customerEmailNormalized: normalizedEmail(email),
    customerPhone: cleanText(session?.customer_details?.phone, 60),
    shippingAddress: {
      line1: cleanText(address?.line1, 240),
      line2: cleanText(address?.line2, 240),
      city: cleanText(address?.city, 120),
      state: cleanText(address?.state, 120),
      postalCode: cleanText(address?.postal_code, 40),
      country: cleanText(address?.country, 120)
    },
    items: recoveredItems(lineItems, currency),
    payerEmail: email,
    payerEmailNormalized: normalizedEmail(email)
  };
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const authHeader = request.headers.get('authorization') || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!idToken) return json({ error: 'Please log in to recover your orders.' }, 401);

    const member = await verifyFirebaseUser(idToken);
    if (!member.emailVerified || !normalizedEmail(member.email)) {
      return json({ error: 'Verify your account email before recovering Stripe orders.' }, 403);
    }

    const sessions = await listPaidGlobalRaniSessions(member.email);
    let recovered = 0;
    let alreadyPresent = 0;
    for (const session of sessions) {
      const lineItems = await listLineItems(session.id);
      const order = buildRecoveredOrder(session, member, lineItems);
      const result = await createDocument('orders', order.orderNumber, order);
      if (result.created) recovered += 1;
      else alreadyPresent += 1;
    }

    return json({
      ok: true,
      found: sessions.length,
      recovered,
      alreadyPresent
    });
  } catch (error) {
    console.error('recover-member-orders error:', error?.message || error);
    return json({ error: error?.message || 'Could not recover Stripe order history.' }, 500);
  }
}

export const config = { path: '/api/recover-member-orders' };
