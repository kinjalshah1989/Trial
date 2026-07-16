const IMAGEKIT_FOLDERS = [
  '/global-rani-earrings',
  '/earrings',
  '/global-rani-products',
  '/products',
  '/global-rani-bangles',
  '/bangles'
];

const SERVER_CACHE_TTL = 15 * 60 * 1000;
let memoryCache = null;

function json(body, status = 200, cacheStatus = 'MISS') {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400' : 'no-store, max-age=0',
      'X-Global-Rani-Cache': cacheStatus
    }
  });
}

function normalizePath(value) {
  const path = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function filePathOf(file) {
  return normalizePath(file.filePath || file.path || '');
}

function parentFolder(file) {
  const path = filePathOf(file);
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function isDisplayImage(file) {
  const name = String(file.name || '').toLowerCase();
  const type = String(file.fileType || file.type || '').toLowerCase();
  const isImage = type === 'image' || /\.(png|jpe?g|webp|avif)$/i.test(name);
  if (!isImage) return false;
  return !/(?:^|[-_])(ar|transparent|split|mask)(?:[-_.]|$)/i.test(name);
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

export default async function handler(request) {
  const forceRefresh = (() => { try { return new URL(request.url).searchParams.get('refresh') === '1'; } catch { return false; } })();
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

    const wantedFolders = IMAGEKIT_FOLDERS.map(normalizePath);
    const images = result.files
      .filter(isDisplayImage)
      .filter(file => {
        const folder = parentFolder(file);
        return wantedFolders.some(wanted => folder === wanted || folder.startsWith(`${wanted}/`));
      })
      .map(file => ({
        name: file.name,
        url: file.url,
        folder: parentFolder(file)
      }))
      .filter(item => item.url);

    const unique = [];
    const seen = new Set();
    for (const image of images) {
      if (seen.has(image.url)) continue;
      seen.add(image.url);
      unique.push(image);
    }

    const payload = {
      images: unique,
      count: unique.length,
      folders: wantedFolders
    };
    memoryCache = { savedAt: Date.now(), body: payload };
    return json(payload, 200, 'MISS');
  } catch (error) {
    return json({
      error: 'Inventory images could not be loaded.',
      detail: error?.message || String(error)
    }, 500);
  }
}

export const config = { path: '/api/inventory-images' };
