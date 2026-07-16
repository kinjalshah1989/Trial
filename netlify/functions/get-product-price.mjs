import { getOrCreatePermanentPrice, configuredSetPriceRange, cleanProductId } from '../shared/permanent-prices.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' }
});

export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const productId = cleanProductId(url.searchParams.get('productId'));
    if (!productId) return json({ error: 'Product ID is required.' }, 400);
    const range = configuredSetPriceRange();
    const price = await getOrCreatePermanentPrice(productId, range.min, range.max);
    return json({ productId, price, currency: 'USD' });
  } catch (error) {
    console.error('get-product-price', error);
    return json({ error: error?.message || 'Unable to load product price.' }, 500);
  }
}

export const config = { path: '/api/get-product-price' };
