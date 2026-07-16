import crypto from 'node:crypto';
import { resolveCart, usdRate, pricedUSD } from '../shared/secure-catalog.mjs';

const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const base=()=>String(process.env.PAYPAL_ENV||'live').toLowerCase()==='sandbox'?'https://api-m.sandbox.paypal.com':'https://api-m.paypal.com';
async function token(){
  const id=process.env.PAYPAL_CLIENT_ID, secret=process.env.PAYPAL_CLIENT_SECRET;
  if(!id||!secret) throw new Error('PayPal server credentials are not configured.');
  const r=await fetch(`${base()}/v1/oauth2/token`,{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  if(!r.ok) throw new Error('PayPal authentication failed.'); return (await r.json()).access_token;
}
function sign(payload){
  const secret=process.env.CHECKOUT_SIGNING_SECRET||process.env.PAYPAL_CLIENT_SECRET;
  if(!secret) throw new Error('Checkout signing secret is not configured.');
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export default async function handler(request){
  if(request.method!=='POST') return json({error:'Method not allowed.'},405);
  try{
    const p=await request.json();
    const currency=String(p?.currency||'USD').toUpperCase();
    const allowed=new Set(['AUD','BRL','CAD','CNY','CZK','DKK','EUR','HKD','HUF','ILS','JPY','MYR','MXN','TWD','NZD','NOK','PHP','PLN','GBP','SGD','SEK','CHF','THB','USD','INR']);
    if(!allowed.has(currency)) return json({error:'Unsupported currency.'},400);
    const items=await resolveCart(p?.items);
    const itemsUSD=pricedUSD(items,currency);
    const requestedTip=Math.max(0,Number(p?.tipUSD)||0);
    const maxTip=Math.max(25,itemsUSD*.30);
    const tipUSD=Math.min(requestedTip,maxTip);
    const rate=await usdRate(currency);
    const total=(itemsUSD+tipUSD)*rate;
    if(!Number.isFinite(total)||total<=0) return json({error:'Invalid order total.'},400);
    const orderPayload={items:items.map(i=>({name:i.name,priceUSD:i.priceUSD,quantity:i.quantity,image:i.image})),currency,itemsUSD:Number(itemsUSD.toFixed(2)),tipUSD:Number(tipUSD.toFixed(2)),total:Number(total.toFixed(2)),exp:Date.now()+30*60*1000};
    const checkoutToken=sign(orderPayload);
    const access=await token();
    const r=await fetch(`${base()}/v2/checkout/orders`,{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json','PayPal-Request-Id':crypto.randomUUID()},body:JSON.stringify({intent:'CAPTURE',purchase_units:[{description:'The Global Rani jewelry order',amount:{currency_code:currency,value:total.toFixed(2)}}]})});
    const data=await r.json().catch(()=>({}));
    if(!r.ok||!data.id) throw new Error(data?.message||'PayPal order could not be created.');
    return json({ok:true,orderId:data.id,checkoutToken,total:total.toFixed(2),currency});
  }catch(e){console.error('create-paypal-order',e);return json({error:e?.message||'Checkout could not be created.'},500)}
}
export const config={path:'/api/create-paypal-order'};
