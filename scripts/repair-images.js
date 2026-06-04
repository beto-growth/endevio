/**
 * HubSpot Listings — Image Repair
 *
 * Script de reparación one-shot para listings cuyo all_images fue sobreescrito
 * con URLs del CRM (perdiendo los watermarks ya procesados).
 *
 * SOLO hace remap desde el caché de HubSpot Files — no descarga ni procesa imágenes nuevas.
 * Las imágenes que no estén en el caché se eliminan del listado; sync-images.js las procesará
 * en sus próximos runs normales.
 *
 * Required env var: HUBSPOT_TOKEN
 */

'use strict';

const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const HS_OBJECT_TYPE   = 'listings';
const HS_BASE          = 'https://api.hubapi.com';
const BATCH_SIZE       = 100;
const BATCH_DELAY_MS   = 300;
const FOLDER_WATERMARK = '/quivani/images-watermark';
const CRM_DOMAIN       = 'reapcrm.com';

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('❌  Missing HUBSPOT_TOKEN environment variable');
  process.exit(1);
}

const HS_JSON_HEADERS = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

const stats = { listings: 0, remapped: 0, missing: 0, updated: 0 };

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

// ─── HubSpot Files — cargar caché watermark ───────────────────────────────────

async function loadWatermarkCache() {
  const map  = new Map();
  let after  = null;

  do {
    const qs = new URLSearchParams({ path: FOLDER_WATERMARK, properties: 'url,name', limit: '100' });
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

// ─── Buscar listings dañados ──────────────────────────────────────────────────
// Usa GET /crm/v3/objects (sin límite de 10k) con filtrado client-side.

async function fetchDamagedListings() {
  const results = [];
  let after = null;
  let total = 0;

  while (true) {
    const qs = new URLSearchParams({
      limit: '100',
      properties: 'reference_number,all_images',
    });
    if (after) qs.set('after', after);

    const res = await fetch(`${HS_BASE}/crm/v3/objects/${HS_OBJECT_TYPE}?${qs}`, {
      headers: HS_JSON_HEADERS,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`List falló HTTP ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    total += data.results?.length ?? 0;

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

    process.stdout.write(`\r    Revisados: ${total} | Dañados: ${results.length}…`);
    await sleep(150);
  }

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   HubSpot Listings — Image Repair    ║');
  console.log('║   (remap desde caché · sin procesar) ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}\n`);

  // 1 — Cargar caché de watermarks existentes en HubSpot Files
  console.log('📂  Cargando caché de watermarks en HubSpot Files…');
  const existingWm = await loadWatermarkCache();
  console.log(`    ${existingWm.size} archivos watermarked en caché\n`);

  // 2 — Buscar todos los listings dañados
  console.log('🔍  Buscando listings dañados…');
  const listings = await fetchDamagedListings();
  console.log(`\r    ✅ ${listings.length} listings dañados encontrados\n`);

  if (listings.length === 0) {
    console.log('✅  No hay listings dañados. Nada que reparar.');
    return;
  }

  stats.listings = listings.length;

  // 3 — Remap desde caché (sin descargar ni procesar nada)
  console.log('🔧  Remapeando imágenes desde caché…\n');

  // Diagnóstico: mostrar los primeros 3 filenames buscados vs muestra del caché
  if (listings.length > 0) {
    const sample = listings[0];
    const sampleUrl = sample.imageUrls.find(isCrmUrl);
    if (sampleUrl) {
      const hash = crypto.createHash('sha256').update(sampleUrl).digest('hex').slice(0, 12);
      const filenameWm = `${sample.reference_number}_${hash}_wm.jpg`;
      console.log(`    🔎  Ejemplo filename buscado: ${filenameWm}`);
      const cacheKeys = [...existingWm.keys()].slice(0, 3);
      console.log(`    🔎  Ejemplo keys en caché:   ${cacheKeys.join(', ')}\n`);
    }
  }

  const updates = [];
  for (const listing of listings) {
    const repairedUrls = listing.imageUrls
      .map((url) => {
        if (!isCrmUrl(url)) return url; // ya es HubSpot URL, conservar

        const hash       = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
        const filenameWm = `${listing.reference_number}_${hash}_wm.jpg`;

        if (existingWm.has(filenameWm)) {
          stats.remapped++;
          return existingWm.get(filenameWm);
        }

        // No está en caché — sync-images.js lo procesará en el próximo run
        stats.missing++;
        return null;
      })
      .filter(url => url !== null);

    // Solo actualizar si hay imágenes remapeadas — nunca escribir array vacío
    if (repairedUrls.length > 0) {
      updates.push({ id: listing.id, all_images: JSON.stringify(repairedUrls) });
    }
  }

  // 4 — Actualizar HubSpot
  console.log(`✏️   Actualizando ${updates.length} listings en HubSpot (${listings.length - updates.length} sin caché, quedan intactos)…`);
  const { updated, errors } = await batchUpdateImages(updates);
  stats.updated = updated;

  console.log('\n📊  Resultado:');
  console.log(`    🏠  Listings reparados:      ${stats.listings}`);
  console.log(`    ⚡  Imágenes remapeadas:     ${stats.remapped}`);
  if (stats.missing > 0)
    console.log(`    ⏳  Sin caché (pendientes):  ${stats.missing}  ← sync-images las procesará`);
  console.log(`    ✅  Listings actualizados:   ${stats.updated}`);
  errors.forEach(e => console.error(`    ❌  ${e}`));
  console.log('\n🎉  Reparación completa!');
}

main().catch(err => {
  console.error('\n💥  Error fatal:', err.message);
  process.exit(1);
});
