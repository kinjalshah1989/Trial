import staticCatalog from './static-catalog.json' with { type: 'json' };

const folders = [
  { path: '/global-rani-products', fallback: 85 },
  { path: '/global-rani-earrings', fallback: 45 },
  { path: '/global-rani-bangles', fallback: 45 }
];
let cache = { at: 0, catalog: null };
const normalize = value => String(value || '').trim().toLowerCase();
const numeric = (value, fallback) => { const n = Number(String(value ?? '').replace(/[^0-9.-]/g,'')); return Number.isFinite(n) && n > 0 ? n : fallback; };
const title = id => String(id||'').split('-').filter(Boolean).map(w=>w[0].toUpperCase()+w.slice(1)).join(' ');

async function imageKitCatalog() {
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) return {};
  const auth = Buffer.from(`${privateKey}:`).toString('base64');
  const all=[];
  for(let skip=0;skip<5000;skip+=100){
    const r=await fetch(`https://api.imagekit.io/v1/files?limit=100&skip=${skip}`,{headers:{Authorization:`Basic ${auth}`,Accept:'application/json'}});
    if(!r.ok) throw new Error('ImageKit catalog unavailable');
    const page=await r.json(); if(!Array.isArray(page)) break; all.push(...page); if(page.length<100) break;
  }
  const out={};
  for(const cfg of folders){
    const files=all.filter(f=>String(f.filePath||f.path||'').startsWith(cfg.path+'/'));
    const groups=new Map();
    for(const f of files){
      const n=String(f.name||'');
      let m=n.match(/^(.*)-set-([123])\.(png|jpe?g|webp|avif)$/i);
      if(!m) m=n.match(/^(.*?)(?:-earrings|-earring|-set)?-([123])\.(png|jpe?g|webp|avif)$/i);
      if(!m) continue;
      const base=m[1].replace(/-(earrings?|set)$/i,'');
      if(!groups.has(base)) groups.set(base,[]); groups.get(base).push(f);
    }
    for(const [base, imgs] of groups){
      const first=imgs.sort((a,b)=>String(a.name).localeCompare(String(b.name)))[0];
      const md=first.customMetadata||{};
      if(['false','0','no','off','inactive'].includes(String(md.active??'true').toLowerCase())) continue;
      const name=String(md.productName||md.name||title(base)+(cfg.path.includes('products')?' Set':''));
      out[normalize(name)]={name,priceUSD:numeric(md.price??md.priceUSD,cfg.fallback),image:String(first.url||'')};
    }
  }
  return out;
}

export async function getCatalog(){
  if(cache.catalog && Date.now()-cache.at<10*60*1000) return cache.catalog;
  let dynamic={}; try{dynamic=await imageKitCatalog();}catch(e){console.warn(e.message)}
  cache={at:Date.now(),catalog:{...staticCatalog,...dynamic}};
  return cache.catalog;
}

export async function resolveCart(rawItems){
  if(!Array.isArray(rawItems)||!rawItems.length) throw new Error('Cart is empty.');
  const catalog=await getCatalog(); const items=[];
  for(const raw of rawItems.slice(0,100)){
    const product=catalog[normalize(raw?.name)];
    if(!product) throw new Error(`Product is unavailable: ${String(raw?.name||'Unknown product').slice(0,80)}`);
    const quantity=Math.max(1,Math.min(20,Math.floor(Number(raw?.quantity)||1)));
    items.push({...product,quantity});
  }
  return items;
}

export async function usdRate(currency){
  const code=String(currency||'USD').toUpperCase(); if(code==='USD') return 1;
  const response=await fetch('https://open.er-api.com/v6/latest/USD',{headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error('Live currency rate unavailable.');
  const data=await response.json(); const rate=Number(data?.rates?.[code]);
  if(!Number.isFinite(rate)||rate<=0) throw new Error('Selected currency is unsupported.');
  return rate;
}

export function pricedUSD(items,currency){
  const india=String(currency).toUpperCase()==='INR';
  return items.reduce((s,i)=>s+i.priceUSD*i.quantity*(india?0.5:1),0);
}
