const IMAGEKIT_FOLDER = '/global-rani-earrings';

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0' }
  });
}
function normalizePath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}
function filePathOf(file) { return normalizePath(file.filePath || file.path || ''); }
function parentFolder(file) {
  const path = filePathOf(file); const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
function titleFromId(id) {
  return String(id || '').split('-').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function numberValue(value, fallback = 45) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function booleanValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false','0','no','off','inactive'].includes(String(value).trim().toLowerCase());
}
async function fetchAllFiles(privateKey) {
  const authorization = Buffer.from(`${privateKey}:`).toString('base64');
  const collected = []; const pageSize = 100;
  for (let skip = 0; skip < 5000; skip += pageSize) {
    const params = new URLSearchParams({ limit: String(pageSize), skip: String(skip) });
    const response = await fetch(`https://api.imagekit.io/v1/files?${params}`, { headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' } });
    const bodyText = await response.text();
    if (!response.ok) return { ok:false, status:response.status, detail:bodyText };
    let page; try { page = JSON.parse(bodyText); } catch { return { ok:false, status:502, detail:'ImageKit returned invalid JSON.' }; }
    if (!Array.isArray(page)) break;
    collected.push(...page); if (page.length < pageSize) break;
  }
  return { ok:true, files:collected };
}
function parseCarouselFilename(filename) {
  const match = String(filename || '').trim().match(/^(.*?)(?:-earrings|-earring|-set)?-([123])\.(png|jpe?g|webp|avif)$/i);
  if (!match) return null;
  return { baseId: match[1].replace(/-(earrings?|set)$/i, ''), slide:Number(match[2]) };
}
export default async function handler() {
  try {
    const privateKey = const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;;
    if (!privateKey) return json({ error:'IMAGEKIT_PRIVATE_KEY is missing in Netlify.' }, 500);
    const result = await fetchAllFiles(privateKey);
    if (!result.ok) return json({ error:'ImageKit could not be read.', status:result.status, imageKitMessage:result.detail }, 502);
    const wantedFolder = normalizePath(IMAGEKIT_FOLDER);
    const allFiles = result.files;
    const files = allFiles.filter(file => { const folder = parentFolder(file); return folder === wantedFolder || folder.startsWith(`${wantedFolder}/`); });
    const byName = new Map(files.map(file => [String(file.name || '').trim().toLowerCase(), file]));
    const groups = new Map();
    for (const file of files) {
      const parsed = parseCarouselFilename(file.name); if (!parsed) continue;
      const key = parsed.baseId.toLowerCase();
      if (!groups.has(key)) groups.set(key, { baseId:parsed.baseId, slides:new Map() });
      groups.get(key).slides.set(parsed.slide, file);
    }
    const products = []; const incompleteProducts = [];
    for (const { baseId, slides } of groups.values()) {
      const image1=slides.get(1), image2=slides.get(2), image3=slides.get(3);
      const arCandidates = [`${baseId}-ar.png`,`${baseId}-ar.webp`,`${baseId}-ar.jpg`,`${baseId}-ar.jpeg`,`${baseId}-earrings-ar.png`,`${baseId}-earring-ar.png`];
      const gifCandidates = [`${baseId}-box-opening.gif`,`${baseId}-jewelry-box-opening.gif`,`${baseId}-earrings-box-opening.gif`,`${baseId}-earring-box-opening.gif`];
      const arFile = arCandidates.map(n=>byName.get(n.toLowerCase())).find(Boolean);
      const gifFile = gifCandidates.map(n=>byName.get(n.toLowerCase())).find(Boolean);
      const missing=[]; if(!image1)missing.push('image 1'); if(!image2)missing.push('image 2'); if(!image3)missing.push('image 3'); if(!arFile)missing.push('AR image'); if(!gifFile)missing.push('box-opening GIF');
      if (missing.length) { incompleteProducts.push({ product:baseId, missing, acceptedCarouselNames:[`${baseId}-1.png`,`${baseId}-2.png`,`${baseId}-3.png`,`${baseId}-earrings-1.png`,`${baseId}-earrings-2.png`,`${baseId}-earrings-3.png`], acceptedArNames:arCandidates, acceptedGifNames:gifCandidates }); continue; }
      const metadata=image1.customMetadata||{}; if(!booleanValue(metadata.active,true)) continue;
      products.push({
        id:`${baseId}-earrings`, name:metadata.productName||metadata.name||titleFromId(baseId),
        description:metadata.description||metadata.productDescription||'Statement earrings from The Global Rani collection.',
        price:numberValue(metadata.price??metadata.priceUSD,45), category:metadata.category||'Earrings',
        images:[image1.url,image2.url,image3.url], image:image1.url, arImage:arFile.url, boxGif:gifFile.url
      });
    }
    products.sort((a,b)=>a.name.localeCompare(b.name));
    return json({ products, count:products.length, folder:wantedFolder, filesSeenInProductFolder:files.length, filenamesSeen:files.map(f=>f.name), incompleteProducts });
  } catch(error) { return json({ error:'Earring products could not be loaded.', detail:error?.message||String(error) },500); }
}
export const config = { path:'/api/earring-products' };
