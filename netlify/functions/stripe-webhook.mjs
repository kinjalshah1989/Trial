import crypto from 'node:crypto';
import { fulfillPaidCheckout } from '../shared/paid-order-fulfillment.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) throw new Error('Stripe webhook signature configuration is missing.');
  const values = String(signatureHeader).split(',').map(part => part.trim()).filter(Boolean);
  const timestampPart = values.find(part => part.startsWith('t='));
  const signatures = values.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  const timestamp = Number(timestampPart?.slice(2));
  if (!Number.isFinite(timestamp) || !signatures.length) throw new Error('Stripe webhook signature is malformed.');
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (age > toleranceSeconds) throw new Error('Stripe webhook signature timestamp is outside the allowed tolerance.');
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (!signatures.some(signature => safeEqualHex(signature, expected))) {
    throw new Error('Stripe webhook signature verification failed.');
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const secret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) return json({ error: 'STRIPE_WEBHOOK_SECRET is not configured.' }, 500);

  const rawBody = await request.text();
  try {
    verifyStripeSignature(rawBody, request.headers.get('stripe-signature'), secret);
  } catch (error) {
    console.error('Stripe webhook signature error:', error?.message || error);
    return json({ error: 'Invalid Stripe webhook signature.' }, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); }
  catch { return json({ error: 'Stripe webhook body is invalid JSON.' }, 400); }

  const handledEvents = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);
  if (!handledEvents.has(event?.type)) return json({ received: true, ignored: true });

  const session = event?.data?.object;
  if (!session || session.object !== 'checkout.session') return json({ error: 'Stripe Checkout Session is missing.' }, 400);
  if (session.payment_status !== 'paid') {
    return json({ received: true, pending: true });
  }

  try {
    const result = await fulfillPaidCheckout(session, event.id);
    return json({ received: true, fulfilled: true, ...result });
  } catch (error) {
    console.error('Stripe webhook fulfillment failed:', error?.message || error);
    // A non-2xx response asks Stripe to retry delivery. Firebase order writes
    // and Resend requests are idempotent, so retries are safe.
    return json({ error: error?.message || 'Paid order fulfillment failed.' }, 500);
  }
}

export const config = { path: '/api/stripe-webhook' };
