/**
 * HubSpot Listings — Image Repair
 *
 * Script de reparación one-shot para listings cuyo all_images fue sobreescrito
 * con URLs del CRM (perdiendo los watermarks ya procesados).
 *
 * Estrategia:
 *  1. Carga el cache de imágenes watermarked ya existentes en HubSpot Files.
 *  2. Busca listings con CRM URLs en all_images (los "dañados").
 *  3. Para cada imagen:
 *     - Si el archivo watermarked ya existe en HubSpot Files → usa esa URL (rápido, sin reprocesar)
 *     - Si no existe → descarga, aplica watermark, sube (caso raro: imágenes nunca procesadas)
 *  4. Actualiza all_images con las URLs correctas de HubSpot Files.
 *
 * Required env var: HUBSPOT_TOKEN
 * Optional env vars:
 *   REPAIR_BATCH_SIZE  — listings por lote de búsqueda (default: 2000, sin límite de run)
 *   IMAGE_CONCURRENCY  — imágenes en paralelo (default: 15)
 */

'use strict';

const sharp  = require('sharp');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const HS_OBJECT_TYPE    = 'listings';
const HS_BASE           = 'https://api.hubapi.com';
const BATCH_SIZE        = 100;
const BATCH_DELAY_MS    = 300;
const CONCURRENCY       = parseInt(process.env.IMAGE_CONCURRENCY ?? '15', 10);
const FOLDER_ORIGINALS  = '/quivani/images-xml';
const FOLDER_WATERMARK  = '/quivani/images-watermark';
const WATERMARK_FILE_ID = '212770895196';
const CRM_DOMAIN        = 'reapcrm.com';

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

const stats = { remapped: 0, reprocessed: 0, failed: 0, listings: 0 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ─── HubSpot Files helpers ────────────────────────────────────────────────────

async function fetchWatermarkFromHubSpot() {
  const metaRes = await fetch(`${HS_BASE}/files/v3/files/${WATERMARK_FILE_ID}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!metaRes.ok) throw new Error(`Watermark metadata falló HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('Watermark no tiene URL pública');
  const imgRes = await fetch(meta.url);
  if (!imgRes.ok) throw new Error(`Watermark download falló HTTP ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

async function loadFolderFiles(folderPath) {
  const map  = new Map();
  let after  = null;

  do {
    const qs = new URLSearchParams({ path: folderPath, properties: 'url,name', limit: '100' });
    if (after) qs.set('after', after);

    const res = await fetch(`${HS_BASE}/files/v3/files/search?${qs}`, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    if (!res.ok) break;

    const data = await res.json();
    for (const file of data.results ?? []) {
      if (!file.url) continue;
      const filename = decodeURIComponent(file.url.split('/').pop().split('?')[0]);
      if (filename) map.set(filename, file.url);
    }

    after = data.paging?.next?.after ?? null;
  } while (after);

  return map;
}

async function downloadImage(url, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === maxRetries)
        throw new Error(`Error de red: ${err.message} — ${url}`);
      await sleep(2_000 * attempt);
      continue;
    }
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const transient = res.status === 500 || res.status === 502 || res.status === 503;
    if (!transient || attempt === maxRetries)
      throw new Error(`HTTP ${res.status} — ${url}`);
    await sleep(2_000 * attempt);
  }
}

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
      if (attempt < maxRetries) { await sleep(waitMs); continue; }
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

// ─── Fetch listings dañados ───────────────────────────────────────────────────

async function fetchDamagedListings() {
  const results = [];
  let after = null;

  console.log('🔍  Buscando listings con CRM URLs en all_images…');

  while (true) {
    const body = {
      filterGroups: [{
        filters: [{ propertyName: 'all_images', operator: 'HAS_PROPERTY' }],
      }],
      properties: ['reference_number', 'all_images', 'transaction_type'],
      sorts: [{ propertyName: 'transaction_type', direction: 'DESCENDING' }],
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

    for (const record of data.results ?? []) {
      const allImagesJson = record.properties?.all_images;
      if (!needsProcessing(allImagesJson)) continue;
      results.push({
        id:               record.id,
        reference_number: record.properties.reference_number,
        imageUrls:        JSON.parse(allImagesJson),
      });
    }

    after = data.paging?.next?.after ?? null;
    if (!after) break;

    process.stdout.write(`\r    ${results.length} listings dañados encontrados…`);
    await sleep(200);
  }

  console.log(`\r    ✅ ${results.length} listings dañados encontrados     `);
  return results;
}

// ─── Batch update ─────────────────────────────────────────────────────────────

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

// ─── Procesar una imagen ──────────────────────────────────────────────────────

async function repairOneImage(url, referenceNumber, existingWm, existingOrig) {
  if (!isCrmUrl(url)) return url; // ya es HubSpot URL, no tocar

  return limit(async () => {
    const hash         = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
    const filenameWm   = `${referenceNumber}_${hash}_wm.jpg`;
    const filenameOrig = `${referenceNumber}_${hash}.jpg`;

    // ✅ Caso ideal: el watermark ya existe en HubSpot Files → solo remap, sin reprocesar
    if (existingWm.has(filenameWm)) {
      stats.remapped++;
      return existingWm.get(filenameWm);
    }

    // ⚙️  No existe aún → descargar, watermark, subir
    const imageBuffer = await downloadImage(url);

    if (!existingOrig.has(filenameOrig)) {
      await uploadFile(imageBuffer, filenameOrig, FOLDER_ORIGINALS);
      existingOrig.set(filenameOrig, true);
    }

    const watermarked = await applyWatermark(imageBuffer);
    const wmUrl = await uploadFile(watermarked, filenameWm, FOLDER_WATERMARK);
    existingWm.set(filenameWm, wmUrl);
    stats.reprocessed++;
    return wmUrl;
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   HubSpot Listings — Image Repair    ║');
  console.log('║   (remap watermarks existentes)      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}\n`);

  // 1 — Watermark (necesario para los casos que haya que reprocesar)
  console.log(`🖼️   Descargando watermark (ID: ${WATERMARK_FILE_ID})…`);
  WATERMARK_BUFFER = await fetchWatermarkFromHubSpot();
  console.log(`    Watermark listo (${(WATERMARK_BUFFER.length / 1024).toFixed(1)} KB)\n`);

  // 2 — Cache de archivos existentes en HubSpot Files
  console.log('📂  Cargando archivos existentes en HubSpot Files…');
  const [existingWm, existingOrig] = await Promise.all([
    loadFolderFiles(FOLDER_WATERMARK),
    loadFolderFiles(FOLDER_ORIGINALS),
  ]);
  console.log(`    ${existingWm.size} watermarked, ${existingOrig.size} originales\n`);

  // 3 — Buscar todos los listings dañados (sin límite de run)
  const listings = await fetchDamagedListings();
  console.log('');

  if (listings.length === 0) {
    console.log('✅  No hay listings dañados. Nada que reparar.');
    return;
  }

  stats.listings = listings.length;
  console.log(`🔧  Reparando ${listings.length} listings…\n`);

  // 4 — Reparar imágenes
  const updates = await Promise.all(
    listings.map(async (listing) => {
      const repairedUrls = (await Promise.all(
        listing.imageUrls.map(async (url) => {
          try {
            return await repairOneImage(url, listing.reference_number, existingWm, existingOrig);
          } catch (err) {
            stats.failed++;
            console.warn(`    ⚠️  [${listing.reference_number}] ${err.message} — imagen eliminada`);
            return null;
          }
        })
      )).filter(url => url !== null);

      return { id: listing.id, all_images: JSON.stringify(repairedUrls) };
    })
  );

  // 5 — Actualizar HubSpot
  console.log(`\n✏️   Actualizando ${updates.length} listings en HubSpot…`);
  const { updated, errors } = await batchUpdateImages(updates);

  console.log('\n📊  Resultado:');
  console.log(`    🏠  Listings procesados:  ${stats.listings}`);
  console.log(`    ⚡  Remapeados (caché):   ${stats.remapped}`);
  console.log(`    ⚙️   Reprocesados:         ${stats.reprocessed}`);
  if (stats.failed) console.log(`    ⚠️   Imágenes fallidas:    ${stats.failed}`);
  console.log(`    ✅  Listings actualizados: ${updated}`);
  errors.forEach(e => console.error(`    ❌  ${e}`));
  console.log('\n🎉  Reparación completa!');
}

main().catch(err => {
  console.error('\n💥  Error fatal:', err.message);
  process.exit(1);
});
