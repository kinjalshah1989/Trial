import crypto from 'node:crypto';
import { resolveCart, usdRate, pricedUSD } from '../shared/secure-catalog.mjs';
import { createDocument, patchDocument } from '../shared/firebase-orders.mjs';

const SUPPORTED_CURRENCIES = new Set([
  'AED', 'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
  'HKD', 'HUF', 'ILS', 'INR', 'JPY', 'MYR', 'MXN', 'NOK', 'NZD', 'PHP',
  'PLN', 'QAR', 'SAR', 'SEK', 'SGD', 'THB', 'TWD', 'USD', 'ZAR'
]);
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function signingSecret() {
  const secret = process.env.CHECKOUT_SIGNING_SECRET || process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('Stripe checkout is not configured.');
  return secret;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function toMinorUnits(amount, currency) {
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return Math.round(Number(amount) * multiplier);
}

function fromMinorUnits(amount, currency) {
  const divisor = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 100;
  return Number((Number(amount) / divisor).toFixed(ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2));
}

function cleanEmail(value) {
  const email = String(value || '').trim().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function siteOrigin(request) {
  const configured = String(process.env.URL || process.env.DEPLOY_PRIME_URL || '').trim();
  const candidate = configured || new URL(request.url).origin;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The checkout return URL is invalid.');
  return parsed.origin;
}

async function createStripeSession(params) {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY is not configured in Netlify.');
  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': crypto.randomUUID()
    },
    body: params
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id || !data?.url) {
    throw new Error(data?.error?.message || 'Stripe Checkout could not be created.');
  }
  return data;
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const payload = await request.json();
    const currency = String(payload?.currency || 'USD').trim().toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) return json({ error: 'Unsupported currency.' }, 400);

    const shipping = payload?.shipping || {};
    const customerEmail = cleanEmail(shipping?.customerEmail);
    if (!cleanText(shipping?.customerName, 180) || !customerEmail || !cleanText(shipping?.shippingAddress1, 240) || !cleanText(shipping?.shippingCity, 120) || !cleanText(shipping?.shippingZip, 40)) {
      return json({ error: 'Complete shipping details are required before payment.' }, 400);
    }

    const items = await resolveCart(payload?.items);
    const requestedPrices = new Map((Array.isArray(payload?.items) ? payload.items : []).map(item => [
      cleanText(item?.name, 180).toLowerCase(),
      Number(item?.priceUSD)
    ]));
    const priceChanged = items.some(item => {
      const requested = requestedPrices.get(cleanText(item?.name, 180).toLowerCase());
      return Number.isFinite(requested) && Math.abs(requested - Number(item.priceUSD)) > 0.005;
    });
    if (priceChanged) {
      return json({
        error: 'A product price was refreshed. Review the updated cart total, then continue to payment again.',
        priceChanged: true,
        items: items.map(item => ({
          name: item.name,
          priceUSD: item.priceUSD,
          quantity: item.quantity,
          image: item.image
        }))
      }, 409);
    }
    const itemsUSD = pricedUSD(items, currency);
    const requestedTip = Math.max(0, Number(payload?.tipUSD) || 0);
    const maxTip = Math.max(25, itemsUSD * 0.30);
    const tipUSD = Math.min(requestedTip, maxTip);
    const rate = await usdRate(currency);
    const indiaDiscount = currency === 'INR' ? 0.5 : 1;
    const reference = crypto.randomUUID();
    const origin = siteOrigin(request);
    const params = new URLSearchParams({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      success_url: `${origin}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?stripe_cancelled=1#checkout`,
      client_reference_id: reference,
      submit_type: 'pay',
      'metadata[store]': 'global_rani',
      'metadata[checkout_reference]': reference,
      expires_at: String(Math.floor(Date.now() / 1000) + (30 * 60)),
      'payment_intent_data[description]': 'The Global Rani jewelry order',
      'payment_intent_data[metadata][store]': 'global_rani',
      'payment_intent_data[metadata][checkout_reference]': reference
    });

    params.set('customer_email', customerEmail);

    let amountTotal = 0;
    items.forEach((item, index) => {
      const unitAmount = toMinorUnits(item.priceUSD * indiaDiscount * rate, currency);
      if (!Number.isSafeInteger(unitAmount) || unitAmount <= 0) throw new Error(`Invalid price for ${item.name}.`);
      amountTotal += unitAmount * item.quantity;
      params.set(`line_items[${index}][quantity]`, String(item.quantity));
      params.set(`line_items[${index}][price_data][currency]`, currency.toLowerCase());
      params.set(`line_items[${index}][price_data][unit_amount]`, String(unitAmount));
      params.set(`line_items[${index}][price_data][product_data][name]`, String(item.name).slice(0, 180));
      if (/^https:\/\//i.test(String(item.image || ''))) {
        params.set(`line_items[${index}][price_data][product_data][images][0]`, String(item.image).slice(0, 1000));
      }
    });

    const tipAmount = toMinorUnits(tipUSD * rate, currency);
    if (tipAmount > 0) {
      if (items.length >= 100) return json({ error: 'The cart has too many separate items to add a tip.' }, 400);
      const index = items.length;
      amountTotal += tipAmount;
      params.set(`line_items[${index}][quantity]`, '1');
      params.set(`line_items[${index}][price_data][currency]`, currency.toLowerCase());
      params.set(`line_items[${index}][price_data][unit_amount]`, String(tipAmount));
      params.set(`line_items[${index}][price_data][product_data][name]`, 'Tip');
    }

    if (!Number.isSafeInteger(amountTotal) || amountTotal <= 0) {
      return json({ error: 'Invalid order total.' }, 400);
    }

    const checkoutPayload = {
      reference,
      items: items.map(item => ({
        name: item.name,
        priceUSD: item.priceUSD,
        quantity: item.quantity,
        image: item.image
      })),
      currency,
      amountTotal,
      itemsUSD: Number(itemsUSD.toFixed(2)),
      tipUSD: Number(tipUSD.toFixed(2)),
      exp: Date.now() + 35 * 60 * 1000
    };
    const checkoutToken = sign(checkoutPayload);
    const pendingCheckout = {
      reference,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 35 * 60 * 1000).toISOString(),
      currency,
      amountMinor: amountTotal,
      itemsUSD: Number(itemsUSD.toFixed(2)),
      tipUSD: Number(tipUSD.toFixed(2)),
      items: items.map(item => ({
        name: cleanText(item.name, 180),
        priceUSD: Number(item.priceUSD),
        quantity: Number(item.quantity),
        image: cleanText(item.image, 1000)
      })),
      firebaseUserId: cleanText(payload?.firebaseUserId, 180),
      checkoutMode: cleanText(payload?.checkoutMode, 30),
      customerName: cleanText(shipping?.customerName, 180),
      customerEmail,
      customerPhone: cleanText(shipping?.customerPhone, 60),
      shippingAddress: {
        line1: cleanText(shipping?.shippingAddress1, 240),
        line2: cleanText(shipping?.shippingAddress2, 240),
        city: cleanText(shipping?.shippingCity, 120),
        state: cleanText(shipping?.shippingState, 120),
        postalCode: cleanText(shipping?.shippingZip, 40),
        country: cleanText(shipping?.shippingCountry, 120)
      },
      deliveryNotes: cleanText(shipping?.deliveryNotes, 1000),
      notes: cleanText(shipping?.profileNotes, 1000),
      stripeCheckoutSessionId: ''
    };

    const pending = await createDocument('checkout_intents', reference, pendingCheckout);
    if (!pending.created) throw new Error('A duplicate secure checkout reference was generated. Please try again.');

    let session;
    try {
      session = await createStripeSession(params);
      await patchDocument('checkout_intents', reference, {
        status: 'AWAITING_PAYMENT',
        stripeCheckoutSessionId: session.id,
        stripeSessionCreatedAt: new Date().toISOString()
      });
    } catch (error) {
      try {
        await patchDocument('checkout_intents', reference, {
          status: 'SESSION_FAILED',
          checkoutError: cleanText(error?.message || error, 500)
        });
      } catch (updateError) {
        console.error('Unable to mark failed Stripe checkout:', updateError?.message || updateError);
      }
      throw error;
    }
    return json({
      ok: true,
      sessionId: session.id,
      url: session.url,
      checkoutToken,
      amountTotal,
      total: fromMinorUnits(amountTotal, currency),
      currency
    });
  } catch (error) {
    console.error('create-stripe-checkout error:', error);
    return json({ error: error?.message || 'Stripe Checkout could not be created.' }, 500);
  }
}

export const config = { path: '/api/create-stripe-checkout' };
