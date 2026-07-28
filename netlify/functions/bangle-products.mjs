const IMAGEKIT_FOLDER = '/global-rani-bangles';
const SERVER_CACHE_TTL = 15 * 60 * 1000;
let memoryCache = null;

function json(body, status = 200, cacheStatus = 'MISS', forceRefresh = false) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 && !forceRefresh
        ? 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400'
        : 'no-store, max-age=0',
      'X-Global-Rani-Cache': cacheStatus
    }
  });
}

function normalizePath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}
function filePathOf(file) { return normalizePath(file.filePath || file.path || ''); }
function parentFolder(file) {
  const path = filePathOf(file);
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}
function versionedFileUrl(file) {
  const raw = String(file?.url || '').trim();
  if (!raw) return '';
  const version = String(file?.updatedAt || file?.createdAt || file?.fileId || '').trim();
  if (!version) return raw;
  const separator = raw.includes('?') ? '&' : '?';
  return `${raw}${separator}grv=${encodeURIComponent(version)}`;
}

function titleFromId(id) {
  return String(id || '').split('-').filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
function collectionIdForFile(file, wantedFolder, baseId) {
  const folder = parentFolder(file);
  const relative = folder.slice(wantedFolder.length).replace(/^\/+|\/+$/g, '');
  return (relative ? relative.split('/')[0] : String(baseId || '')).toLowerCase();
}
function collectionTitle(id, suffix) {
  const base = titleFromId(id);
  return new RegExp(`\b${suffix}$`, 'i').test(base) ? base : `${base} ${suffix}`;
}
function numberValue(value, fallback = 45) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function booleanValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off', 'inactive'].includes(String(value).trim().toLowerCase());
}
async function fetchAllFiles(privateKey) {
  const authorization = Buffer.from(`${privateKey}:`).toString('base64');
  const collected = [];
  const pageSize = 100;
  for (let skip = 0; skip < 5000; skip += pageSize) {
    const params = new URLSearchParams({ limit: String(pageSize), skip: String(skip) });
    const response = await fetch(`https://api.imagekit.io/v1/files?${params}`, {
      headers: { Authorization: `Basic ${authorization}`, Accept: 'application/json' }
    });
    const bodyText = await response.text();
    if (!response.ok) return { ok: false, status: response.status, detail: bodyText };
    let page;
    try { page = JSON.parse(bodyText); }
    catch { return { ok: false, status: 502, detail: 'ImageKit returned invalid JSON.' }; }
    if (!Array.isArray(page)) break;
    collected.push(...page);
    if (page.length < pageSize) break;
  }
  return { ok: true, files: collected };
}

function parseProductImage(filename) {
  const value = String(filename || '').trim();
  if (!/\.(png|jpe?g|webp|avif)$/i.test(value)) return null;
  if (/(?:^|-)(ar|transparent|tryon)(?:-|\.)/i.test(value)) return null;
  const numbered = value.match(/^(.*?)(?:-bangles|-bangle|-kadas|-kada|-set)?-([123])\.(png|jpe?g|webp|avif)$/i);
  if (numbered) {
    return {
      baseId: numbered[1].replace(/-(bangles?|kadas?|set)$/i, ''),
      slide: Number(numbered[2])
    };
  }
  const single = value.match(/^(.*?)\.(png|jpe?g|webp|avif)$/i);
  if (!single) return null;
  return { baseId: single[1].replace(/-(bangles?|kadas?|set)$/i, ''), slide: 1 };
}

export default async function handler(request) {
  const forceRefresh = (() => {
    try { return new URL(request.url).searchParams.get('refresh') === '1'; }
    catch { return false; }
  })();
  if (!forceRefresh && memoryCache && Date.now() - memoryCache.savedAt < SERVER_CACHE_TTL) {
    return json(memoryCache.body, 200, 'HIT');
  }

  try {
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    if (!privateKey) return json({ error: 'IMAGEKIT_PRIVATE_KEY is missing in Netlify.' }, 500);

    const result = await fetchAllFiles(privateKey);
    if (!result.ok) {
      return json({
        error: 'ImageKit could not be read.',
        status: result.status,
        imageKitMessage: result.detail
      }, 502);
    }

    const wantedFolder = normalizePath(IMAGEKIT_FOLDER);
    const allFiles = result.files;
    const files = allFiles.filter(file => {
      const folder = parentFolder(file);
      return folder === wantedFolder || folder.startsWith(`${wantedFolder}/`);
    });
    const byName = new Map(files.map(file => [String(file.name || '').trim().toLowerCase(), file]));
    const groups = new Map();

    for (const file of files) {
      const parsed = parseProductImage(file.name);
      if (!parsed || !parsed.baseId) continue;
      const key = parsed.baseId.toLowerCase();
      if (!groups.has(key)) groups.set(key, { baseId: parsed.baseId, slides: new Map() });
      if (!groups.get(key).slides.has(parsed.slide)) groups.get(key).slides.set(parsed.slide, file);
    }

    const products = [];
    for (const { baseId, slides } of groups.values()) {
      const orderedImages = [...slides.entries()].sort((a, b) => a[0] - b[0]).map(([, file]) => file);
      if (!orderedImages.length) continue;
      const first = orderedImages[0];
      const metadata = first.customMetadata || {};
      if (!booleanValue(metadata.active, true)) continue;

      const arCandidates = [
        `${baseId}-ar.png`, `${baseId}-ar.webp`, `${baseId}-ar.jpg`, `${baseId}-ar.jpeg`,
        `${baseId}-bangles-ar.png`, `${baseId}-bangle-ar.png`, `${baseId}-kadas-ar.png`, `${baseId}-kada-ar.png`
      ];
      const gifCandidates = [
        `${baseId}-box-opening.gif`, `${baseId}-jewelry-box-opening.gif`,
        `${baseId}-bangles-box-opening.gif`, `${baseId}-bangle-box-opening.gif`,
        `${baseId}-kadas-box-opening.gif`, `${baseId}-kada-box-opening.gif`
      ];
      const arFile = arCandidates.map(name => byName.get(name.toLowerCase())).find(Boolean);
      const gifFile = gifCandidates.map(name => byName.get(name.toLowerCase())).find(Boolean);

      const collectionId = collectionIdForFile(first, wantedFolder, baseId);
      const collectionName = metadata.collectionName || metadata.productFamilyName || collectionTitle(collectionId, 'Bangles');
      products.push({
        id: `${baseId}-bangles`,
        collectionId,
        collectionName,
        name: metadata.productName || metadata.name || titleFromId(baseId),
        description: metadata.description || metadata.productDescription || 'Statement bangles and kadas from The Global Rani collection.',
        price: numberValue(metadata.price ?? metadata.priceUSD, 45),
        category: metadata.category || 'Bangles & Kadas',
        images: orderedImages.map(versionedFileUrl),
        image: first.url,
        arImage: versionedFileUrl(arFile),
        boxGif: versionedFileUrl(gifFile)
      });
    }

    products.sort((a, b) => a.name.localeCompare(b.name));
    const collectionMap = new Map();
    for (const product of products) {
      const key = product.collectionId || product.id;
      if (!collectionMap.has(key)) collectionMap.set(key, { id:key, name:product.collectionName, description:product.description, category:product.category, image:product.image, images:product.images, price:product.price, colorCount:0, variants:[] });
      const collection = collectionMap.get(key);
      collection.colorCount += 1; collection.variants.push(product); collection.price = Math.min(collection.price, product.price);
    }
    const collections = Array.from(collectionMap.values()).sort((a,b)=>a.name.localeCompare(b.name));
    const payload = {
      products,
      collections,
      count: products.length,
      folder: wantedFolder,
      filesSeenInProductFolder: files.length,
      filenamesSeen: files.map(file => file.name)
    };
    memoryCache = { savedAt: Date.now(), body: payload };
    return json(payload, 200, 'MISS', forceRefresh);
  } catch (error) {
    return json({ error: 'Bangle products could not be loaded.', detail: error?.message || String(error) }, 500);
  }
}

export const config = { path: '/api/bangle-products' };
