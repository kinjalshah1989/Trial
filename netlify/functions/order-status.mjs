import { fulfillPaidCheckout, orderStatusForSession } from '../shared/paid-order-fulfillment.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  }
});

async function retrieveStripeSession(sessionId) {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) throw new Error('Stripe server credentials are not configured.');
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` }
  });
  const session = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(session?.error?.message || `Stripe payment verification failed (${response.status}).`);
  return session;
}

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  try {
    const sessionId = String(new URL(request.url).searchParams.get('session_id') || '').trim();
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9]+$/.test(sessionId)) {
      return json({ error: 'A valid Stripe Checkout Session ID is required.' }, 400);
    }
    const session = await retrieveStripeSession(sessionId);
    if (session?.mode !== 'payment' || session?.metadata?.store !== 'global_rani') {
      return json({ error: 'This payment does not belong to The Global Rani.' }, 403);
    }
    if (session?.status !== 'complete' || session?.payment_status !== 'paid') {
      return json({
        paid: false,
        processing: true,
        status: session?.status || 'open',
        paymentStatus: session?.payment_status || 'unpaid'
      });
    }
    // Stripe webhooks remain the primary fulfillment path. This paid-session
    // fallback safely completes or retries the same idempotent order emails
    // when webhook delivery is delayed, while the customer is on Thank You.
    try {
      await fulfillPaidCheckout(session, `paid-return-${session.id}`);
    } catch (error) {
      console.error('Paid return fulfillment retry failed:', error?.message || error);
    }
    return json(await orderStatusForSession(session));
  } catch (error) {
    console.error('order-status error:', error?.message || error);
    return json({ error: error?.message || 'Order status could not be loaded.' }, 500);
  }
}

export const config = { path: '/api/order-status' };
