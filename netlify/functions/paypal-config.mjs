const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300'
  }
});

export default async function handler() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const environment = String(process.env.PAYPAL_ENV || 'live').trim().toLowerCase();

  if (!clientId) {
    return json({ error: 'PAYPAL_CLIENT_ID is not configured in Netlify.' }, 500);
  }

  if (environment !== 'live') {
    return json({ error: 'PayPal is not configured for live payments.', environment }, 500);
  }

  return json({ clientId, environment: 'live', currency: 'USD' });
}

export const config = { path: '/api/paypal-config' };
