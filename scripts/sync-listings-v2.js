/**
 * HubSpot Listings Sync — v2 (with watermarked images via HubSpot Files)
 *
 * What's new vs v1 (sync-listings.js):
 *   - Descarga cada imagen del listing y la sube a HubSpot Files (quivani/images-xml).
 *   - Aplica un watermark en mosaico y sube el resultado (quivani/images-watermark).
 *   - Nombres de archivo determinísticos (ref + hash de URL) para detectar
 *     imágenes ya procesadas y evitar re-subir en cada sync.
 *   - Concurrencia controlada para no exceder rate limits de la API de Files.
 *   - all_images guarda las URLs watermarkeadas (images-watermark).
 *
 * Required env vars:
 *   HUBSPOT_TOKEN        — HubSpot Private App token
 *
 * Optional env vars:
 *   IMAGE_CONCURRENCY    — Imágenes en paralelo (default: 5)
 *
 * Carpetas en HubSpot Files (File Manager):
 *   quivani/watermark.png     — PNG con transparencia usado como watermark (ya existe)
 *   quivani/images-xml        — imágenes originales del XML
 *   quivani/images-watermark  — imágenes con watermark (estas van en all_images)
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');
const sharp = require('sharp');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const XML_URL =
  'https://v10-properties.reapcrm.com/xml/FrankSaltRealEstate/24329b2d-6754-4251-8ba0-4733bbb6b909_Endevio_Properties.xml';

const HS_OBJECT_TYPE       = 'listings';
const HS_BASE              = 'https://api.hubapi.com';
const BATCH_SIZE           = 100;
const CONCURRENCY          = parseInt(process.env.IMAGE_CONCURRENCY ?? '5', 10);
const FOLDER_ORIGINALS     = '/quivani/images-xml';        // imágenes originales del CRM
const FOLDER_WATERMARK     = '/quivani/images-watermark';  // imágenes procesadas (van en all_images)
const WATERMARK_HS_FOLDER  = '/quivani';                   // carpeta donde vive el watermark
const WATERMARK_HS_NAME    = 'watermark.png';              // nombre exacto en HubSpot Files

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('❌  Missing HUBSPOT_TOKEN environment variable');
  process.exit(1);
}

// Se inicializa en main() descargando el watermark desde HubSpot Files
let WATERMARK_BUFFER = null;

// ─── Concurrency limiter ───────────────────────────────────────────────────────
// Permite ejecutar hasta N tareas async en paralelo, encolando el resto.

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

// ─── Image stats ───────────────────────────────────────────────────────────────

const imgStats = { cached: 0, uploaded: 0, failed: 0 };

// ─── XML helpers ──────────────────────────────────────────────────────────────

function toArray(val) {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function mapXmlToHubspot(item) {
  const props = {};

  // — System (built-in) properties —
  if (item.PropertyTitle)    props.hs_name           = String(item.PropertyTitle);
  if (item.PriceNumber)      props.hs_price          = Number(item.PriceNumber);
  if (item.Bedrooms != null) props.hs_bedrooms       = Number(item.Bedrooms);
  if (item.Bathrooms != null)props.hs_bathrooms      = Number(item.Bathrooms);
  if (item.Locality)         props.hs_city           = String(item.Locality);
  if (item.LocalityCode)     props.hs_neighborhood   = String(item.LocalityCode);
  if (item.TotalArea != null)props.hs_square_footage = Number(item.TotalArea);
  if (item.PropertyType)     props.hs_listing_type   = String(item.PropertyType);

  // — Custom properties —
  props.reference_number = String(item.ReferenceNumber);

  if (item.Description)           props.description              = String(item.Description);
  if (item.CountryName)           props.country                  = String(item.CountryName);
  if (item.RegionName)            props.region                   = String(item.RegionName).replace(/^\d+-/, '').trim();
  if (item.InsideArea != null)    props.inside_area              = Number(item.InsideArea);
  if (item.OutsideArea != null)   props.outside_area             = Number(item.OutsideArea);
  if (item.TotalArea != null)     props.total_area               = Number(item.TotalArea);
  if (item.ProjectName)           props.project_name             = String(item.ProjectName);
  if (item.BlockOfPropertiesName) props.block_of_properties_name = String(item.BlockOfPropertiesName);
  if (item.AgentName)             props.agent_name               = String(item.AgentName);
  if (item.AgentEmail)            props.agent_email              = String(item.AgentEmail);
  if (item.AgentPhoneNumber)      props.agent_phone              = String(item.AgentPhoneNumber).trim();
  if (item.AgentImageUrl)         props.agent_photo              = String(item.AgentImageUrl).replace(/([^:])\/\//g, '$1/');
  if (item.RentalPriceType)       props.rental_price_type        = String(item.RentalPriceType).trim();
  if (item.AgencyType)            props.agency_type              = String(item.AgencyType);
  if (item.LastUpdated)           props.xml_last_updated         = new Date(item.LastUpdated).getTime();

  props.price_on_request = (item.IsPriceOnRequest === true || item.IsPriceOnRequest === 'true') ? 'true' : 'false';

  // all_images se setea DESPUÉS del procesamiento de imágenes (ver main)
  // Aquí se guarda como fallback con las URLs originales del XML
  const images = toArray(item.Images?.string);
  const imageUrls = images.filter(i => typeof i === 'string' && i.startsWith('http'));
  if (imageUrls.length) props.all_images = JSON.stringify(imageUrls);

  const features = toArray(item.PropertyFeatures?.PropertyFeature);
  if (features.length) {
    const items = features.map(f => `<li>${f.Name}: ${f.Value}</li>`).join('');
    props.key_features = `<ul>${items}</ul>`;
  }

  const isSale = item.IsSale === true || item.IsSale === 'true';
  props.transaction_type = isSale ? 'Sale' : 'Rent';
  props.status           = item.PropertyStatus === 'A' ? 'Active' : 'Inactive';

  return props;
}

// ─── HubSpot CRM API helpers ──────────────────────────────────────────────────

const HS_JSON_HEADERS = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

async function hsGet(path) {
  const res = await fetch(`${HS_BASE}${path}`, { headers: HS_JSON_HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function hsPost(path, body) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method: 'POST',
    headers: HS_JSON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`POST ${path} → HTTP ${res.status}: ${errBody}`);
  }
  return res.json();
}

async function fetchAllExistingListings() {
  const map = new Map();
  let after = null;
  let page  = 0;

  do {
    const qs = new URLSearchParams({ limit: '100', properties: 'reference_number' });
    if (after) qs.set('after', after);

    const data = await hsGet(`/crm/v3/objects/${HS_OBJECT_TYPE}?${qs}`);
    page++;

    for (const record of data.results ?? []) {
      const ref = record.properties?.reference_number;
      if (ref) map.set(ref, record.id);
    }

    after = data.paging?.next?.after ?? null;
    if (after) console.log(`  ↳ página ${page}: ${map.size} listings cargados…`);
  } while (after);

  return map;
}

async function batchCreate(propsList) {
  let created = 0;
  const errors = [];
  for (let i = 0; i < propsList.length; i += BATCH_SIZE) {
    const chunk = propsList.slice(i, i + BATCH_SIZE);
    try {
      const res = await hsPost(`/crm/v3/objects/${HS_OBJECT_TYPE}/batch/create`, {
        inputs: chunk.map(properties => ({ properties })),
      });
      created += res.results?.length ?? 0;
    } catch (e) { errors.push(e.message); }
  }
  return { created, errors };
}

async function batchUpdate(updateList) {
  let updated = 0;
  const errors = [];
  for (let i = 0; i < updateList.length; i += BATCH_SIZE) {
    const chunk = updateList.slice(i, i + BATCH_SIZE);
    try {
      const res = await hsPost(`/crm/v3/objects/${HS_OBJECT_TYPE}/batch/update`, {
        inputs: chunk.map(({ id, properties }) => ({ id, properties })),
      });
      updated += res.results?.length ?? 0;
    } catch (e) { errors.push(e.message); }
  }
  return { updated, errors };
}

// ─── HubSpot Files API helpers ────────────────────────────────────────────────

/**
 * Descarga el watermark desde HubSpot Files (quivani/watermark.png).
 * Se llama una sola vez al inicio de main() y setea WATERMARK_BUFFER.
 */
async function fetchWatermarkFromHubSpot() {
  const qs = new URLSearchParams({ name: WATERMARK_HS_NAME, properties: 'url,name,path' });
  const res = await fetch(`${HS_BASE}/files/v3/files/search?${qs}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Búsqueda del watermark falló HTTP ${res.status}: ${body}`);
  }
  const data = await res.json();

  // Filtra por nombre exacto y carpeta
  const match = (data.results ?? []).find(
    f => f.name === WATERMARK_HS_NAME && f.path?.startsWith(WATERMARK_HS_FOLDER)
  );
  if (!match) {
    throw new Error(
      `"${WATERMARK_HS_NAME}" no encontrado en la carpeta "${WATERMARK_HS_FOLDER}" de HubSpot Files`
    );
  }

  const imgRes = await fetch(match.url);
  if (!imgRes.ok) throw new Error(`Descarga del watermark falló HTTP ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

/**
 * Busca un archivo en HubSpot Files por nombre exacto.
 * Retorna la URL pública o null si no existe.
 */
async function findFileByName(filename) {
  try {
    const qs = new URLSearchParams({ name: filename, properties: 'url,name' });
    const res = await fetch(`${HS_BASE}/files/v3/files/search?${qs}`, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    // La búsqueda puede devolver matches parciales, filtramos por nombre exacto
    const match = (data.results ?? []).find(f => f.name === filename);
    return match?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Sube un buffer de imagen a HubSpot Files en la carpeta indicada.
 * Retorna la URL pública del archivo subido.
 *
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {string} folderPath  — ej: '/quivani/images-xml' o '/quivani/images-watermark'
 */
async function uploadFile(buffer, filename, folderPath) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename);
  form.append('folderPath', folderPath);
  form.append('options', JSON.stringify({
    access: 'PUBLIC_INDEXABLE',
    overwrite: false,
  }));

  const res = await fetch(`${HS_BASE}/files/v3/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    body: form,
  });

  // 409 = archivo ya existe (race condition entre runs) → buscamos la URL existente
  if (res.status === 409) {
    const existing = await findFileByName(filename);
    if (existing) return existing;
    throw new Error(`Conflicto en upload y no se encontró el archivo: ${filename}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload falló HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.url;
}

/**
 * Aplica el watermark en mosaico sobre un buffer de imagen.
 */
async function applyWatermark(imageBuffer) {
  return sharp(imageBuffer)
    .composite([{
      input: WATERMARK_BUFFER,
      tile: true,    // repite el PNG sobre toda la imagen (mosaico)
      blend: 'over',
    }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Procesa una sola imagen:
 *   1. Genera nombres de archivo para la original y la watermarkeada
 *   2. Verifica si la watermarkeada ya existe en HubSpot Files (cache hit)
 *   3. Si no existe:
 *      a. Descarga la imagen original
 *      b. La sube a quivani/images-xml (original)
 *      c. Aplica watermark y sube a quivani/images-watermark
 *   4. Retorna la URL de la imagen watermarkeada (la que va en all_images)
 *
 * Usa el limiter para controlar concurrencia global.
 * En caso de error retorna la URL original del CRM como fallback.
 *
 * Naming:
 *   original    → {ref}_{hash12}.jpg       en quivani/images-xml
 *   watermarked → {ref}_{hash12}_wm.jpg    en quivani/images-watermark
 */
async function processOneImage(originalUrl, referenceNumber) {
  return limit(async () => {
    const hash        = crypto.createHash('sha256').update(originalUrl).digest('hex').slice(0, 12);
    const filenameOrig = `${referenceNumber}_${hash}.jpg`;
    const filenameWm   = `${referenceNumber}_${hash}_wm.jpg`;

    // 1. Cache check: si la watermarkeada ya existe, no hacemos nada más
    const cachedWm = await findFileByName(filenameWm);
    if (cachedWm) {
      imgStats.cached++;
      return cachedWm;
    }

    // 2. Descarga imagen original
    const dlRes = await fetch(originalUrl);
    if (!dlRes.ok) throw new Error(`Descarga falló HTTP ${dlRes.status}`);
    const imageBuffer = Buffer.from(await dlRes.arrayBuffer());

    // 3. Sube original a quivani/images-xml (si no existe ya)
    const cachedOrig = await findFileByName(filenameOrig);
    if (!cachedOrig) {
      await uploadFile(imageBuffer, filenameOrig, FOLDER_ORIGINALS);
    }

    // 4. Aplica watermark y sube a quivani/images-watermark
    const watermarked = await applyWatermark(imageBuffer);
    const wmUrl = await uploadFile(watermarked, filenameWm, FOLDER_WATERMARK);

    imgStats.uploaded++;
    return wmUrl;
  });
}

/**
 * Procesa todas las imágenes de un listing.
 * Lanza todas en paralelo (controlado por el limiter global).
 * Retorna array de URLs watermarkeadas (o URL original del CRM en caso de error).
 */
async function processImages(imageUrls, referenceNumber) {
  return Promise.all(
    imageUrls.map(async (url) => {
      try {
        return await processOneImage(url, referenceNumber);
      } catch (err) {
        imgStats.failed++;
        const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
        console.warn(`\n    ⚠️  [${referenceNumber}_${hash}_wm.jpg] falló: ${err.message} — usando URL original`);
        return url; // fallback a URL del CRM
      }
    })
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   HubSpot Listings Sync — v2             ║');
  console.log('║   (imágenes watermarked → HubSpot Files) ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}`);
  console.log(`📁  Originales  → ${FOLDER_ORIGINALS}`);
  console.log(`📁  Watermarked → ${FOLDER_WATERMARK}`);
  console.log(`⚡  Concurrencia: ${CONCURRENCY} imágenes en paralelo\n`);

  // 1 — Descargar watermark desde HubSpot Files
  console.log(`🖼️   Descargando watermark desde HubSpot Files (${WATERMARK_HS_FOLDER}/${WATERMARK_HS_NAME})…`);
  WATERMARK_BUFFER = await fetchWatermarkFromHubSpot();
  console.log(`    Watermark listo (${(WATERMARK_BUFFER.length / 1024).toFixed(1)} KB)\n`);

  // 2 — Fetch XML feed
  console.log('📥  Descargando feed XML…');
  const xmlRes = await fetch(XML_URL);
  if (!xmlRes.ok) throw new Error(`XML fetch falló con HTTP ${xmlRes.status}`);
  const xmlText = await xmlRes.text();
  console.log(`    Descargado ${(xmlText.length / 1024).toFixed(1)} KB\n`);

  // 3 — Parse XML
  console.log('🔍  Parseando XML…');
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    isArray: (tagName) =>
      ['XMLPropertyModelItem', 'string', 'PropertyFeature'].includes(tagName),
  });
  const parsed = parser.parse(xmlText);
  const xmlItems = parsed?.XMLPropertyModel?.Results?.XMLPropertyModelItem ?? [];
  console.log(`    ${xmlItems.length} propiedades en el feed\n`);

  if (xmlItems.length === 0) {
    console.warn('⚠️   XML retornó 0 propiedades — abortando para evitar pérdida de datos.');
    process.exit(0);
  }

  // 4 — Fetch existing HubSpot records
  console.log('📋  Cargando listings existentes en HubSpot…');
  const existingMap = await fetchAllExistingListings();
  console.log(`    ${existingMap.size} registros existentes\n`);

  // 5 — Mapear XML + procesar imágenes (en paralelo entre propiedades)
  console.log('🖼️   Procesando imágenes (descarga → watermark → HubSpot Files)…');
  console.log('    [cached] = ya existe en HubSpot Files  [↑] = subida nueva\n');

  const toCreate = [];
  const toUpdate = [];
  let skipped = 0;
  let processed = 0;

  // Lanzamos el procesamiento de todas las propiedades en paralelo
  // El limiter controla cuántas imágenes se procesan simultáneamente
  const results = await Promise.all(
    xmlItems.map(async (item) => {
      const props = mapXmlToHubspot(item);
      if (!props.reference_number) return null;

      // Extraemos las URLs crudas del XML
      const rawImages = toArray(item.Images?.string)
        .filter(i => typeof i === 'string' && i.startsWith('http'));

      // Procesamos imágenes y sobreescribimos all_images con las URLs de HubSpot
      if (rawImages.length > 0) {
        const processedUrls = await processImages(rawImages, props.reference_number);
        props.all_images = JSON.stringify(processedUrls);
      }

      return props;
    })
  );

  // Clasificamos en creates/updates
  for (const props of results) {
    if (!props) { skipped++; continue; }
    processed++;

    if (existingMap.has(props.reference_number)) {
      toUpdate.push({ id: existingMap.get(props.reference_number), properties: props });
    } else {
      toCreate.push(props);
    }
  }

  console.log('\n📊  Resumen de imágenes:');
  console.log(`    ✅  Cacheadas (ya estaban en HubSpot Files): ${imgStats.cached}`);
  console.log(`    ⬆️   Subidas nuevas (watermark aplicado):     ${imgStats.uploaded}`);
  if (imgStats.failed > 0) {
    console.log(`    ⚠️   Fallidas (usando URL original del CRM):  ${imgStats.failed}`);
  }
  console.log('');

  console.log('📊  Plan de sync:');
  console.log(`    ➕  Crear:  ${toCreate.length}`);
  console.log(`    ✏️   Actualizar: ${toUpdate.length}`);
  if (skipped) console.log(`    ⚠️   Sin reference_number (omitidos): ${skipped}`);
  console.log('');

  // 5 — Batch create
  if (toCreate.length > 0) {
    console.log(`➕  Creando ${toCreate.length} listings nuevos…`);
    const { created, errors } = await batchCreate(toCreate);
    console.log(`    ✅  Creados: ${created}`);
    errors.forEach(e => console.error(`    ❌  ${e}`));
    console.log('');
  }

  // 6 — Batch update
  if (toUpdate.length > 0) {
    console.log(`✏️   Actualizando ${toUpdate.length} listings existentes…`);
    const { updated, errors } = await batchUpdate(toUpdate);
    console.log(`    ✅  Actualizados: ${updated}`);
    errors.forEach(e => console.error(`    ❌  ${e}`));
    console.log('');
  }

  console.log('🎉  Sync v2 completo!');
}

main().catch(err => {
  console.error('\n💥  Error fatal:', err.message);
  process.exit(1);
});
