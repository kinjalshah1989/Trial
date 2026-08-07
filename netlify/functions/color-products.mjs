const ALLOWED_COLORS = new Set([
  'pink', 'red', 'green', 'blue', 'gold', 'purple', 'black', 'multicolor'
]);

const SERVER_CACHE_TTL = 15 * 60 * 1000;
const memoryCache = new Map();

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

function filePathOf(file) {
  return normalizePath(file?.filePath || file?.path || '');
}

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
  return `${raw}${raw.includes('?') ? '&' : '?'}grv=${encodeURIComponent(version)}`;
}

function slugify(value) {
  return String(value || '')
    .replace(/\.[^/.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(value) {
  return String(value || '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function numberValue(value, fallback = 85) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off', 'inactive'].includes(String(value).trim().toLowerCase());
}

function isProductImage(file) {
  const name = String(file?.name || '').trim();
  if (!/\.(png|jpe?g|webp|avif)$/i.test(name)) return false;
  const stem = name.replace(/\.[^.]+$/, '');
  return !/(?:^|[-_ ])(?:ar|try[-_ ]?on)$/i.test(stem);
}

function parseProductImage(file, wantedFolder) {
  if (!isProductImage(file)) return null;
  const name = String(file.name || '').trim();
  const stem = name.replace(/\.[^.]+$/, '');
  const numbered = stem.match(/^(.*?)(?:[-_ ](?:set|image|photo|view))?[-_ ]([123])$/i);
  const slide = numbered ? Number(numbered[2]) : 1;
  let base = (numbered ? numbered[1] : stem).replace(/[-_ ](?:set|image|photo|view)$/i, '');
  const folder = parentFolder(file);
  const relativeFolder = folder.slice(wantedFolder.length).replace(/^\/+|\/+$/g, '');
  const folderName = relativeFolder.split('/').filter(Boolean).pop() || '';
  if (!base || /^(image|photo|view|set|product)$/i.test(base)) base = folderName || base || 'jewelry';
  const key = `${relativeFolder.toLowerCase()}::${base.toLowerCase()}`;
  return { key, base, slide, folder };
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

function findCompanion(files, folder, candidates) {
  const wanted = new Set(candidates.map(name => name.toLowerCase()));
  return files.find(file => parentFolder(file) === folder && wanted.has(String(file.name || '').toLowerCase()));
}

export default async function handler(request) {
  let url;
  try { url = new URL(request.url); }
  catch { return json({ error: 'Invalid request URL.' }, 400); }

  const color = String(url.searchParams.get('color') || '').trim().toLowerCase();
  const forceRefresh = url.searchParams.get('refresh') === '1';
  if (!ALLOWED_COLORS.has(color)) {
    return json({ error: 'Choose pink, red, green, blue, gold, purple, black, or multicolor.' }, 400);
  }

  const cached = memoryCache.get(color);
  if (!forceRefresh && cached && Date.now() - cached.savedAt < SERVER_CACHE_TTL) {
    return json(cached.body, 200, 'HIT');
  }

  try {
    const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
    if (!privateKey) {
      return json({
        error: 'IMAGEKIT_PRIVATE_KEY is missing in Netlify.',
        fix: 'Add it under Project configuration → Environment variables, then redeploy.'
      }, 500);
    }

    const result = await fetchAllFiles(privateKey);
    if (!result.ok) {
      return json({
        error: 'ImageKit could not be read.',
        status: result.status,
        imageKitMessage: result.detail
      }, 502);
    }

    const wantedFolder = `/global-rani-${color}`;
    const files = result.files.filter(file => {
      const folder = parentFolder(file);
      return folder === wantedFolder || folder.startsWith(`${wantedFolder}/`);
    });

    const groups = new Map();
    for (const file of files) {
      const parsed = parseProductImage(file, wantedFolder);
      if (!parsed) continue;
      if (!groups.has(parsed.key)) {
        groups.set(parsed.key, { base: parsed.base, folder: parsed.folder, slides: new Map() });
      }
      const group = groups.get(parsed.key);
      if (!group.slides.has(parsed.slide)) group.slides.set(parsed.slide, file);
    }

    const products = [];
    const incompleteProducts = [];
    const colorTitle = titleFromId(color);

    for (const group of groups.values()) {
      const orderedEntries = [...group.slides.entries()].sort((a, b) => a[0] - b[0]);
      const orderedImages = orderedEntries.map(([, file]) => file);
      if (!orderedImages.length) continue;
      const firstImage = orderedImages[0];
      const metadata = firstImage.customMetadata || {};
      if (!booleanValue(metadata.active, true)) continue;

      const base = group.base;
      const arFile = findCompanion(files, group.folder, [
        `${base}-ar.png`, `${base}-ar.webp`, `${base}-ar.jpg`, `${base}-ar.jpeg`, `${base}-ar.avif`,
        `${base}-try-on.png`, `${base}-try-on.webp`, `${base}-tryon.png`, `${base}-tryon.webp`
      ]);
      const gifFile = findCompanion(files, group.folder, [
        `${base}-box-opening.gif`, `${base}-jewelry-box-opening.gif`, `${base}-set-jewelry-box-opening.gif`
      ]);
      const productSlug = slugify(base) || `jewelry-${products.length + 1}`;
      const productName = metadata.productName || metadata.name || titleFromId(base);

      products.push({
        id: `${color}-${productSlug}`,
        collectionId: color,
        collectionName: `${colorTitle} Jewelry`,
        name: productName,
        description: metadata.description || metadata.productDescription || `${colorTitle} jewelry from The Global Rani collection.`,
        price: numberValue(metadata.price ?? metadata.priceUSD, 85),
        category: metadata.category || `${colorTitle} Jewelry`,
        color,
        images: orderedImages.map(versionedFileUrl),
        image: versionedFileUrl(firstImage),
        arImage: versionedFileUrl(arFile),
        boxGif: versionedFileUrl(gifFile)
      });

      const missingSlides = [1, 2, 3].filter(slide => !group.slides.has(slide));
      if (missingSlides.length) incompleteProducts.push({ id: productSlug, missingSlides });
    }

    products.sort((a, b) => a.name.localeCompare(b.name));
    const payload = {
      products,
      count: products.length,
      color,
      folder: wantedFolder,
      filesSeenInColorFolder: files.length,
      filenamesSeen: files.map(file => file.name),
      incompleteProducts
    };
    memoryCache.set(color, { savedAt: Date.now(), body: payload });
    return json(payload, 200, 'MISS', forceRefresh);
  } catch (error) {
    return json({
      error: 'Color products could not be loaded.',
      detail: error?.message || String(error)
    }, 500);
  }
}

export const config = { path: '/api/color-products' };
