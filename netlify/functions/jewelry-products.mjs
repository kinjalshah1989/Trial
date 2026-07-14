const IMAGEKIT_FOLDER = '/global-rani-products';

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

function displayNameFromId(id) {
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') + ' Set';
}

function numberValue(value, fallback = 85) {
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
    // Important: only use the universally supported list parameters here.
    // Folder filtering is done safely below in JavaScript.
    const params = new URLSearchParams({
      limit: String(pageSize),
      skip: String(skip)
    });

    const response = await fetch(`https://api.imagekit.io/v1/files?${params.toString()}`, {
      headers: {
        Authorization: `Basic ${authorization}`,
        Accept: 'application/json'
      }
    });

    const bodyText = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        detail: bodyText
      };
    }

    let page;
    try {
      page = JSON.parse(bodyText);
    } catch {
      return { ok: false, status: 502, detail: 'ImageKit returned invalid JSON.' };
    }

    if (!Array.isArray(page)) break;
    collected.push(...page);
    if (page.length < pageSize) break;
  }

  return { ok: true, files: collected };
}

function parseCarouselFilename(filename) {
  const match = String(filename || '').trim().match(/^(.*)-set-([123])\.(png|jpe?g|webp|avif)$/i);
  if (!match) return null;
  return { baseId: match[1], slide: Number(match[2]) };
}

export default async function handler(request) {
  const forceRefresh = (() => { try { return new URL(request.url).searchParams.get('refresh') === '1'; } catch { return false; } })();
  if (!forceRefresh && memoryCache && Date.now() - memoryCache.savedAt < SERVER_CACHE_TTL) {
    return json(memoryCache.body, 200, 'HIT');
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
        imageKitMessage: result.detail,
        hint: 'Check that the saved value is the ImageKit PRIVATE key, with no quotation marks or extra spaces.'
      }, 502);
    }

    const wantedFolder = normalizePath(IMAGEKIT_FOLDER);
    const allFiles = result.files;
    const files = allFiles.filter(file => {
      const folder = parentFolder(file);
      return folder === wantedFolder || folder.startsWith(`${wantedFolder}/`);
    });

    const byName = new Map(
      files.map(file => [String(file.name || '').trim().toLowerCase(), file])
    );

    const carouselGroups = new Map();

    for (const file of files) {
      const parsed = parseCarouselFilename(file.name);
      if (!parsed) continue;
      const key = parsed.baseId.toLowerCase();
      if (!carouselGroups.has(key)) carouselGroups.set(key, { baseId: parsed.baseId, slides: new Map() });
      carouselGroups.get(key).slides.set(parsed.slide, file);
    }

    const products = [];
    const incompleteProducts = [];

    for (const { baseId, slides } of carouselGroups.values()) {
      const image1 = slides.get(1);
      const image2 = slides.get(2);
      const image3 = slides.get(3);

      const arCandidates = [
        `${baseId}-ar.png`, `${baseId}-ar.webp`, `${baseId}-ar.jpg`, `${baseId}-ar.jpeg`, `${baseId}-ar.avif`,
        `${baseId}-set-ar.png`, `${baseId}-set-ar.webp`, `${baseId}-set-ar.jpg`, `${baseId}-set-ar.jpeg`, `${baseId}-set-ar.avif`
      ];

      const gifCandidates = [
        `${baseId}-box-opening.gif`,
        `${baseId}-jewelry-box-opening.gif`,
        `${baseId}-set-jewelry-box-opening.gif`
      ];

      const arFile = arCandidates.map(name => byName.get(name.toLowerCase())).find(Boolean);
      const gifFile = gifCandidates.map(name => byName.get(name.toLowerCase())).find(Boolean);
      const missing = [];
      if (!image1) missing.push('set-1 image');
      if (!image2) missing.push('set-2 image');
      if (!image3) missing.push('set-3 image');
      if (!arFile) missing.push('AR image');
      if (!gifFile) missing.push('box-opening GIF');

      if (missing.length) {
        incompleteProducts.push({
          product: baseId,
          missing,
          acceptedCarouselNames: [
            `${baseId}-set-1.png`, `${baseId}-set-2.png`, `${baseId}-set-3.png`
          ],
          acceptedArNames: arCandidates,
          acceptedGifNames: gifCandidates
        });
        continue;
      }

      const metadata = image1.customMetadata || {};
      if (!booleanValue(metadata.active, true)) continue;

      products.push({
        id: `${baseId}-set`,
        name: metadata.productName || metadata.name || displayNameFromId(baseId),
        description: metadata.description || metadata.productDescription || 'A coordinated jewelry set from The Global Rani collection.',
        price: numberValue(metadata.price ?? metadata.priceUSD, 85),
        category: metadata.category || 'Jewelry Set',
        images: [image1.url, image2.url, image3.url],
        image: image1.url,
        arImage: arFile.url,
        boxGif: gifFile.url
      });
    }

    products.sort((a, b) => a.name.localeCompare(b.name));

    const payload = {
      products,
      count: products.length,
      folder: wantedFolder,
      totalImageKitFilesRead: allFiles.length,
      filesSeenInProductFolder: files.length,
      filenamesSeen: files.map(file => file.name),
      incompleteProducts
    };
    memoryCache = { savedAt: Date.now(), body: payload };
    return json(payload, 200, 'MISS');
  } catch (error) {
    return json({
      error: 'Jewelry products could not be loaded.',
      detail: error?.message || String(error)
    }, 500);
  }
}

export const config = { path: '/api/jewelry-products' };
