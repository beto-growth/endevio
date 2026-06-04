/**
 * HubSpot Listings — Image Repair
 *
 * Usa crm_images como fuente de verdad para restaurar all_images:
 *
 *  - Si all_images ya tiene URLs de HubSpot Files → skip (ya está bien)
 *  - Si all_images está vacío/null/"[]"/CRM URLs:
 *      → Intenta remap desde caché de HubSpot Files (sin descargar nada)
 *      → Si hay imágenes en caché → escribe all_images con esas URLs
 *      → Si no hay nada en caché → restaura all_images = crm_images
 *        para que sync-images.js las procese en sus próximos runs
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

const stats = { remapped: 0, restored: 0, skipped: 0, updated: 0 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isCrmUrl(url)      { return typeof url === 'string' && url.includes(CRM_DOMAIN); }
function isHubSpotUrl(url)  { return typeof url === 'string' && url.includes('hubspotusercontent'); }

function parseUrls(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function allHubSpot(urls) {
  return urls.length > 0 && urls.every(isHubSpotUrl);
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

// ─── Listar todos los listings con crm_images ─────────────────────────────────

async function fetchAllListings() {
  const results = [];
  let after     = null;
  let total     = 0;
  let retries   = 0;

  while (true) {
    const qs = new URLSearchParams({
      limit:      '100',
      properties: 'reference_number,all_images,crm_images',
    });
    if (after) qs.set('after', after);

    let res;
    try {
      res = await fetch(`${HS_BASE}/crm/v3/objects/${HS_OBJECT_TYPE}?${qs}`, {
        headers: HS_JSON_HEADERS,
      });
    } catch (err) {
      if (retries++ < 5) { await sleep(5_000); continue; }
      throw new Error(`List error de red: ${err.message}`);
    }

    if (res.status === 502 || res.status === 503) {
      if (retries++ < 5) { await sleep(5_000); continue; }
      throw new Error(`List falló HTTP ${res.status} tras 5 reintentos`);
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`List falló HTTP ${res.status}: ${errBody}`);
    }

    retries = 0;
    const data = await res.json();
    total += data.results?.length ?? 0;

    for (const record of data.results ?? []) {
      const crmImages = record.properties?.crm_images;
      if (!crmImages) continue; // sin crm_images → no podemos hacer nada

      results.push({
        id:               record.id,
        reference_number: record.properties.reference_number,
        all_images:       record.properties?.all_images ?? null,
        crm_images:       crmImages,
      });
    }

    after = data.paging?.next?.after ?? null;
    if (!after) break;

    process.stdout.write(`\r    Revisados: ${total} | Con crm_images: ${results.length}…`);
    await sleep(150);
  }

  return results;
}

// ─── Batch update ─────────────────────────────────────────────────────────────

async function batchUpdate(updateList) {
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
        errors.push(`HTTP ${res.status}: ${body.slice(0, 200)}`);
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
  console.log('║   (restaurar all_images desde caché) ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}\n`);

  // 1 — Caché de watermarks
  console.log('📂  Cargando caché de watermarks en HubSpot Files…');
  const existingWm = await loadWatermarkCache();
  console.log(`    ${existingWm.size} archivos watermarked en caché\n`);

  // Diagnóstico: mostrar 3 keys del caché
  const cacheKeys = [...existingWm.keys()].slice(0, 3);
  console.log(`    🔎  Ejemplo keys en caché: ${cacheKeys.join(', ')}\n`);

  // 2 — Cargar todos los listings con crm_images
  console.log('🔍  Cargando listings con crm_images…');
  const listings = await fetchAllListings();
  console.log(`\r    ✅ ${listings.length} listings con crm_images encontrados\n`);

  if (listings.length === 0) {
    console.log('⚠️  No hay listings con crm_images. Nada que hacer.');
    return;
  }

  // 3 — Clasificar y reparar
  console.log('🔧  Analizando y reparando…\n');

  const updates = [];

  for (const listing of listings) {
    const allUrls = parseUrls(listing.all_images);
    const crmUrls = parseUrls(listing.crm_images);

    // Ya está bien → skip
    if (allHubSpot(allUrls)) {
      stats.skipped++;
      continue;
    }

    // Intentar remap desde caché usando las URLs del CRM
    const remappedUrls = crmUrls
      .map((url) => {
        if (!isCrmUrl(url)) return null;
        const hash       = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
        const filenameWm = `${listing.reference_number}_${hash}_wm.jpg`;
        return existingWm.has(filenameWm) ? existingWm.get(filenameWm) : null;
      })
      .filter(Boolean);

    if (remappedUrls.length > 0) {
      // Hay watermarks en caché → restaurar con URLs de HubSpot Files
      stats.remapped += remappedUrls.length;
      updates.push({ id: listing.id, all_images: remappedUrls.length > 0 ? JSON.stringify(remappedUrls) : null });
    } else {
      // Sin caché → restaurar all_images = crm_images para que sync-images procese
      stats.restored++;
      updates.push({ id: listing.id, all_images: listing.crm_images });
    }
  }

  console.log(`📊  Plan:`);
  console.log(`    ✅  Ya correctos (skip):        ${stats.skipped}`);
  console.log(`    ⚡  Remapeados desde caché:     ${updates.filter((_, i) => i < updates.length).length - stats.restored}`);
  console.log(`    🔄  Restaurados a CRM URLs:     ${stats.restored}  ← sync-images los procesará\n`);

  if (updates.length === 0) {
    console.log('✅  Nada que actualizar.');
    return;
  }

  // 4 — Actualizar HubSpot
  console.log(`✏️   Actualizando ${updates.length} listings en HubSpot…`);
  const { updated, errors } = await batchUpdate(updates);
  stats.updated = updated;

  console.log(`\n✅  Listings actualizados: ${stats.updated}`);
  errors.forEach(e => console.error(`    ❌  ${e}`));
  console.log('\n🎉  Reparación completa!');
}

main().catch(err => {
  console.error('\n💥  Error fatal:', err.message);
  process.exit(1);
});
