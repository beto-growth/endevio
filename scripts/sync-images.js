/**
 * HubSpot Listings — Image Sync
 *
 * Busca listings que tienen URLs del CRM en all_images (sin procesar),
 * descarga cada imagen, aplica watermark en mosaico, las sube a HubSpot Files
 * y actualiza all_images con las URLs de HubSpot Files.
 *
 * Esquema de propiedades:
 *   crm_images  — URLs originales del CRM (escrito por sync-data.js, nunca por este script)
 *   all_images  — URLs watermarked de HubSpot Files (escrito exclusivamente por este script)
 *
 * sync-data.js resetea all_images = crm_images solo cuando las imágenes del CRM cambian,
 * lo que dispara el reprocesamiento en el próximo run de este script.
 *
 * Diseñado para procesar el backlog de 17.000+ listings gradualmente.
 * Cada run procesa hasta LISTINGS_PER_RUN listings y luego termina.
 *
 * Required env var: HUBSPOT_TOKEN
 * Optional env vars:
 *   LISTINGS_PER_RUN   — listings por run (default: 500)
 *   IMAGE_CONCURRENCY  — imágenes en paralelo (default: 10)
 */

'use strict';

const sharp  = require('sharp');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const HS_OBJECT_TYPE    = 'listings';
const HS_BASE           = 'https://api.hubapi.com';
const BATCH_SIZE        = 100;
const BATCH_DELAY_MS    = 300;
const CONCURRENCY       = parseInt(process.env.IMAGE_CONCURRENCY  ?? '10',  10);
const LISTINGS_PER_RUN  = parseInt(process.env.LISTINGS_PER_RUN   ?? '500', 10);
const FOLDER_ORIGINALS  = '/quivani/images-xml';
const FOLDER_WATERMARK  = '/quivani/images-watermark';
const WATERMARK_FILE_ID = '212770895196';
const CRM_DOMAIN        = 'reapcrm.com'; // detecta imágenes sin procesar

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('❌  Missing HUBSPOT_TOKEN environment variable');
  process.exit(1);
}

const HS_JSON_HEADERS = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

let WATERMARK_BUFFER = null;

const imgStats = { cached: 0, uploaded: 0, failed: 0, skipped: 0 };

// ─── Concurrency limiter ──────────────────────────────────────────────────────

function makeLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const run = () => {
    while (active < concurrency && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      fn().then(resolve, reject).finally(() => { active--; run(); });
    }
  };
  return fn => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    run();
  });
}

const limit = makeLimiter(CONCURRENCY);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Detección de imágenes sin procesar ───────────────────────────────────────

function isCrmUrl(url) {
  return typeof url === 'string' && url.includes(CRM_DOMAIN);
}

function needsProcessing(allImagesJson) {
  if (!allImagesJson) return false;
  try {
    const urls = JSON.parse(allImagesJson);
    return Array.isArray(urls) && urls.some(isCrmUrl);
  } catch { return false; }
}

// ─── HubSpot CRM helpers ──────────────────────────────────────────────────────

/**
 * Busca listings con all_images que contenga URLs del CRM.
 * Usa la Search API de HubSpot con HAS_PROPERTY + filtrado client-side.
 * Retorna hasta LISTINGS_PER_RUN listings.
 */
async function fetchListingsNeedingImages() {
  const results = [];
  let after = null;
  let searchPage = 0;

  while (results.length < LISTINGS_PER_RUN) {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: 'all_images', operator: 'HAS_PROPERTY' }],
      }],
      properties: ['reference_number', 'all_images', 'transaction_type'],
      sorts: [{ propertyName: 'transaction_type', direction: 'DESCENDING' }], // Sale > Rent alfabéticamente
      limit: 100,
    };
    if (after) body.after = after;

    const res = await fetch(`${HS_BASE}/crm/v3/objects/${HS_OBJECT_TYPE}/search`, {
      method: 'POST',
      headers: HS_JSON_HEADERS,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Search falló HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    searchPage++;

    for (const record of data.results ?? []) {
      const allImagesJson = record.properties?.all_images;
      if (!needsProcessing(allImagesJson)) continue;

      results.push({
        id:               record.id,
        reference_number: record.properties.reference_number,
        transaction_type: record.properties.transaction_type ?? '',
        imageUrls:        JSON.parse(allImagesJson),
      });

      if (results.length >= LISTINGS_PER_RUN) break;
    }

    after = data.paging?.next?.after ?? null;
    if (!after) break;

    // Pausa entre páginas de búsqueda para no saturar la API
    await sleep(200);
  }

  return results;
}

async function batchUpdateImages(updateList) {
  let updated = 0;
  const errors = [];

  for (let i = 0; i < updateList.length; i += BATCH_SIZE) {
    const chunk = updateList.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(`${HS_BASE}/crm/v3/objects/${HS_OBJECT_TYPE}/batch/update`, {
        method: 'POST',
        headers: HS_JSON_HEADERS,
        body: JSON.stringify({
          inputs: chunk.map(({ id, all_images }) => ({ id, properties: { all_images } })),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        errors.push(`HTTP ${res.status}: ${body}`);
      } else {
        const data = await res.json();
        updated += data.results?.length ?? 0;
      }
    } catch (e) {
      errors.push(e.message);
    }
    if (i + BATCH_SIZE < updateList.length) await sleep(BATCH_DELAY_MS);
  }

  return { updated, errors };
}

// ─── HubSpot Files API helpers ────────────────────────────────────────────────

async function fetchWatermarkFromHubSpot() {
  const metaRes = await fetch(`${HS_BASE}/files/v3/files/${WATERMARK_FILE_ID}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!metaRes.ok) {
    const body = await metaRes.text();
    throw new Error(`Watermark metadata falló HTTP ${metaRes.status}: ${body}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('Watermark no tiene URL pública');
  const imgRes = await fetch(meta.url);
  if (!imgRes.ok) throw new Error(`Watermark download falló HTTP ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

/**
 * Carga todos los archivos de una carpeta en HubSpot Files.
 * Pagina en rangos de createdAt para superar el límite de 10k de la Search API.
 */
async function loadFolderFiles(folderPath) {
  const map        = new Map();
  let createdAfter = 0; // timestamp ms — avanza con cada ventana

  while (true) {
    let after    = null;
    let lastSeen = 0;
    let countInWindow = 0;

    do {
      const qs = new URLSearchParams({
        path:       folderPath,
        properties: 'url,name,createdAt',
        limit:      '100',
        sort:       'createdAt',
      });
      if (after)        qs.set('after', after);
      if (createdAfter) qs.set('createdAfter', new Date(createdAfter + 1).toISOString());

      const res = await fetch(`${HS_BASE}/files/v3/files/search?${qs}`, {
        headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      });
      if (!res.ok) break;

      const data = await res.json();
      for (const file of data.results ?? []) {
        if (!file.url) continue;
        const filename = decodeURIComponent(file.url.split('/').pop().split('?')[0]);
        if (filename) map.set(filename, file.url);
        const ts = new Date(file.createdAt ?? 0).getTime();
        if (ts > lastSeen) lastSeen = ts;
        countInWindow++;
      }

      after = data.paging?.next?.after ?? null;
    } while (after);

    // Si esta ventana trajo menos de 9900 resultados, ya no hay más
    if (countInWindow < 9900 || lastSeen <= createdAfter) break;

    // Avanzar la ventana al último timestamp visto
    createdAfter = lastSeen;
  }

  return map;
}

/**
 * Descarga una imagen con reintentos automáticos para errores transitorios del CRM (500/502).
 */
async function downloadImage(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === maxRetries)
        throw new Error(`Descarga falló (error de red: ${err.message}) — ${url}`);
      await sleep(2_000 * attempt);
      continue;
    }

    if (res.ok) return Buffer.from(await res.arrayBuffer());

    const transient = res.status === 500 || res.status === 502 || res.status === 503;
    if (!transient || attempt === maxRetries)
      throw new Error(`Descarga falló HTTP ${res.status} — ${url}`);

    await sleep(2_000 * attempt); // 2s, 4s
  }
}

/**
 * Sube un archivo a HubSpot Files con reintentos y backoff exponencial en 429.
 * HubSpot Files API: ~190 req / 10s. Con alta concurrencia podemos excederlo.
 */
async function uploadFile(buffer, filename, folderPath, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename);
    form.append('folderPath', folderPath);
    form.append('options', JSON.stringify({ access: 'PUBLIC_INDEXABLE', overwrite: true }));

    const res = await fetch(`${HS_BASE}/files/v3/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
      body: form,
    });

    if (res.ok) {
      const data = await res.json();
      return data.url;
    }

    if (res.status === 429 || res.status === 502 || res.status === 503) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 30_000);
      if (attempt < maxRetries) {
        await sleep(waitMs);
        continue;
      }
    }

    const body = await res.text();
    throw new Error(`Upload falló HTTP ${res.status}: ${body}`);
  }
}

async function applyWatermark(imageBuffer) {
  const img = sharp(imageBuffer);
  const { width: imgW, height: imgH } = await img.metadata();
  const { width: wmW,  height: wmH  } = await sharp(WATERMARK_BUFFER).metadata();

  let wmInput = WATERMARK_BUFFER;
  if (wmW > imgW || wmH > imgH) {
    wmInput = await sharp(WATERMARK_BUFFER)
      .resize(Math.min(wmW, imgW), Math.min(wmH, imgH), { fit: 'inside' })
      .toBuffer();
  }

  return img
    .composite([{ input: wmInput, tile: true, blend: 'over' }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Procesa una sola imagen:
 * - Si es URL de HubSpot → ya está procesada, retorna tal cual
 * - Si es URL del CRM → descarga, watermark, sube a HubSpot Files
 * - Si ya existe en el cache (Map) → retorna URL cacheada
 */
async function processOneImage(url, referenceNumber, existingWm, existingOrig) {
  // Si ya es URL de HubSpot, no procesar
  if (!isCrmUrl(url)) {
    imgStats.skipped++;
    return url;
  }

  return limit(async () => {
    const hash         = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    const filenameOrig = `${referenceNumber}_${hash}.jpg`;
    const filenameWm   = `${referenceNumber}_${hash}_wm.jpg`;

    // Cache hit — imagen ya existe en HubSpot Files
    if (existingWm.has(filenameWm)) {
      imgStats.cached++;
      return existingWm.get(filenameWm);
    }

    // Descarga (con reintentos para errores 500/502 del CRM)
    const imageBuffer = await downloadImage(url);

    // Sube original (si no existe)
    if (!existingOrig.has(filenameOrig)) {
      await uploadFile(imageBuffer, filenameOrig, FOLDER_ORIGINALS);
      existingOrig.set(filenameOrig, true);
    }

    // Watermark y sube
    const watermarked = await applyWatermark(imageBuffer);
    const wmUrl = await uploadFile(watermarked, filenameWm, FOLDER_WATERMARK);

    existingWm.set(filenameWm, wmUrl);
    imgStats.uploaded++;
    return wmUrl;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   HubSpot Listings — Image Sync      ║');
  console.log('║   (watermark → HubSpot Files)        ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}`);
  console.log(`🔢  Listings por run:  ${LISTINGS_PER_RUN}`);
  console.log(`⚡  Concurrencia:      ${CONCURRENCY} imágenes en paralelo\n`);

  // 1 — Watermark
  console.log(`🖼️   Descargando watermark (ID: ${WATERMARK_FILE_ID})…`);
  WATERMARK_BUFFER = await fetchWatermarkFromHubSpot();
  console.log(`    Watermark listo (${(WATERMARK_BUFFER.length / 1024).toFixed(1)} KB)\n`);

  // 2 — Pre-cargar archivos existentes en HubSpot Files (cache)
  console.log('📂  Cargando archivos existentes en HubSpot Files…');
  const [existingWm, existingOrig] = await Promise.all([
    loadFolderFiles(FOLDER_WATERMARK),
    loadFolderFiles(FOLDER_ORIGINALS),
  ]);
  console.log(`    ${existingWm.size} watermarked, ${existingOrig.size} originales\n`);

  // 3 — Buscar listings con imágenes sin procesar
  console.log(`🔍  Buscando listings con imágenes del CRM (máx ${LISTINGS_PER_RUN})…`);
  const listings = await fetchListingsNeedingImages();
  console.log(`    ${listings.length} listings para procesar\n`);

  if (listings.length === 0) {
    console.log('✅  Todas las imágenes ya están en HubSpot Files. Nada que hacer.');
    return;
  }

  // 4 — Procesar imágenes (paralelo entre listings, limitado por el limiter global)
  console.log('🖼️   Procesando imágenes…\n');

  const updates = await Promise.all(
    listings.map(async (listing) => {
      const processedUrls = (await Promise.all(
        listing.imageUrls.map(async (url) => {
          try {
            return await processOneImage(url, listing.reference_number, existingWm, existingOrig);
          } catch (err) {
            imgStats.failed++;
            const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
            console.warn(
              `    ⚠️  [${listing.reference_number}_${hash}_wm.jpg] ${err.message} — imagen eliminada`
            );
            return null; // se filtra abajo
          }
        })
      )).filter(url => url !== null);

      // Si todas las imágenes fallaron → no actualizar, dejar CRM URLs para reintentar
      if (processedUrls.length === 0) return null;

      return { id: listing.id, all_images: JSON.stringify(processedUrls) };
    })
  );

  const validUpdates = updates.filter(u => u !== null);

  console.log('\n📊  Resumen de imágenes:');
  console.log(`    ✅  Cacheadas (ya en HubSpot Files):     ${imgStats.cached}`);
  console.log(`    ⏭️   Ya procesadas (URLs de HubSpot):    ${imgStats.skipped}`);
  console.log(`    ⬆️   Subidas nuevas (watermark aplicado): ${imgStats.uploaded}`);
  if (imgStats.failed > 0)
    console.log(`    ⚠️   Fallidas (se reintentarán):         ${imgStats.failed}`);
  console.log('');

  // 5 — Actualizar all_images en HubSpot
  console.log(`✏️   Actualizando all_images en ${validUpdates.length} listings…`);
  const { updated, errors } = await batchUpdateImages(validUpdates);
  console.log(`    ✅  Actualizados: ${updated}`);
  errors.forEach(e => console.error(`    ❌  ${e}`));
  console.log('');

  const remaining = listings.length === LISTINGS_PER_RUN;
  console.log('🎉  Image sync completo!');
  if (remaining) {
    console.log(`    ℹ️   Se alcanzó el límite de ${LISTINGS_PER_RUN} listings.`);
    console.log('    ℹ️   Quedan listings por procesar — el próximo run continuará.');
  } else {
    console.log('    ℹ️   Se procesaron todos los listings disponibles.');
  }
}

main().catch(err => {
  console.error('\n💥  Error fatal:', err.message);
  process.exit(1);
});
