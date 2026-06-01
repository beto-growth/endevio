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
const WATERMARK_FILE_ID    = '212770895196';               // file ID en HubSpot Files (quivani/watermark.png)

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
  if (item.PropertyType)     props.xml_property_type = String(item.PropertyType);

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
 * Descarga el watermark desde HubSpot Files usando su file ID.
 * Se llama una sola vez al inicio de main() y setea WATERMARK_BUFFER.
 * File: quivani/watermark.png (ID: 212770895196)
 */
async function fetchWatermarkFromHubSpot() {
  // Obtenemos la URL pública del archivo por su ID
  const metaRes = await fetch(`${HS_BASE}/files/v3/files/${WATERMARK_FILE_ID}`, {
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
  });
  if (!metaRes.ok) {
    const body = await metaRes.text();
    throw new Error(`No se pudo obtener el watermark (ID ${WATERMARK_FILE_ID}) HTTP ${metaRes.status}: ${body}`);
  }
  const meta = await metaRes.json();
  if (!meta.url) throw new Error(`El archivo watermark (ID ${WATERMARK_FILE_ID}) no tiene URL pública`);

  // Descargamos el contenido del archivo
  const imgRes = await fetch(meta.url);
  if (!imgRes.ok) throw new Error(`Descarga del watermark falló HTTP ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

/**
 * Carga todos los archivos de una carpeta de HubSpot Files en un Map (filename → url).
 * Usa paginación para carpetas con muchos archivos.
 * Evita cualquier búsqueda por nombre (sin límite de 20 chars).
 */
async function loadFolderFiles(folderPath) {
  const map = new Map();
  let after = null;

  do {
    const qs = new URLSearchParams({ path: folderPath, properties: 'url,name', limit: '100' });
    if (after) qs.set('after', after);

    const res = await fetch(`${HS_BASE}/files/v3/files/search?${qs}`, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });

    if (!res.ok) break; // carpeta vacía o aún no existe — OK

    const data = await res.json();
    for (const file of data.results ?? []) {
      if (!file.url) continue;
      // HubSpot devuelve `name` SIN extensión (ej: "24294_abc_wm").
      // Extraemos el filename completo desde la URL, que siempre incluye la extensión.
      const filename = decodeURIComponent(file.url.split('/').pop().split('?')[0]);
      if (filename) map.set(filename, file.url);
    }

    after = data.paging?.next?.after ?? null;
  } while (after);

  return map;
}

/**
 * Sube un buffer de imagen a HubSpot Files en la carpeta indicada.
 * Retorna la URL pública del archivo subido.
 * En caso de 409 (ya existe — race condition) retorna null; el caller decide qué hacer.
 */
async function uploadFile(buffer, filename, folderPath) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename);
  form.append('folderPath', folderPath);
  // overwrite: true → si el archivo ya existe lo sobreescribe en lugar de crear duplicados
  // con nombres incrementados (_wm-2.jpg, _wm-3.jpg…). El cache check previo evita
  // que esto se ejecute para archivos ya existentes en condiciones normales.
  form.append('options', JSON.stringify({ access: 'PUBLIC_INDEXABLE', overwrite: true }));

  const res = await fetch(`${HS_BASE}/files/v3/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload falló HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.url;
}

/**
 * Aplica el watermark en mosaico sobre un buffer de imagen.
 * Sharp exige que el watermark sea <= dimensiones de la imagen.
 * Si la imagen es más pequeña que el watermark, lo redimensionamos antes de tilear.
 */
async function applyWatermark(imageBuffer) {
  const img  = sharp(imageBuffer);
  const { width: imgW, height: imgH } = await img.metadata();
  const { width: wmW,  height: wmH  } = await sharp(WATERMARK_BUFFER).metadata();

  let wmInput = WATERMARK_BUFFER;
  if (wmW > imgW || wmH > imgH) {
    // Escala el watermark para que quepa dentro de la imagen (mantiene aspect ratio)
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
 *   1. Genera nombres determinísticos para original y watermarkeada
 *   2. Cache check contra Maps pre-cargados (sin llamadas API)
 *   3. Si no existe: descarga → sube original → aplica watermark → sube watermarkeada
 *   4. Retorna URL watermarkeada (la que va en all_images)
 *
 * Naming:
 *   original    → {ref}_{hash12}.jpg      en quivani/images-xml
 *   watermarked → {ref}_{hash12}_wm.jpg   en quivani/images-watermark
 *
 * @param {string} originalUrl
 * @param {string} referenceNumber
 * @param {Map}    existingWm    — Map pre-cargado de quivani/images-watermark
 * @param {Map}    existingOrig  — Map pre-cargado de quivani/images-xml
 */
async function processOneImage(originalUrl, referenceNumber, existingWm, existingOrig) {
  return limit(async () => {
    const hash         = crypto.createHash('sha256').update(originalUrl).digest('hex').slice(0, 12);
    const filenameOrig = `${referenceNumber}_${hash}.jpg`;
    const filenameWm   = `${referenceNumber}_${hash}_wm.jpg`;

    // 1. Cache check local (sin API)
    if (existingWm.has(filenameWm)) {
      imgStats.cached++;
      return existingWm.get(filenameWm);
    }

    // 2. Descarga imagen original
    const dlRes = await fetch(originalUrl);
    if (!dlRes.ok) throw new Error(`Descarga falló HTTP ${dlRes.status}`);
    const imageBuffer = Buffer.from(await dlRes.arrayBuffer());

    // 3. Sube original (si no existe)
    if (!existingOrig.has(filenameOrig)) {
      await uploadFile(imageBuffer, filenameOrig, FOLDER_ORIGINALS);
      existingOrig.set(filenameOrig, true); // marca como subido en este run
    }

    // 4. Aplica watermark y sube
    const watermarked = await applyWatermark(imageBuffer);
    const wmUrl = await uploadFile(watermarked, filenameWm, FOLDER_WATERMARK);

    existingWm.set(filenameWm, wmUrl); // actualiza el map para este run // actualiza el map para este run
    imgStats.uploaded++;
    return wmUrl;
  });
}

/**
 * Procesa todas las imágenes de un listing en paralelo (limitado por el limiter global).
 * Fallback a URL original del CRM en caso de error por imagen.
 */
async function processImages(imageUrls, referenceNumber, existingWm, existingOrig) {
  return Promise.all(
    imageUrls.map(async (url) => {
      try {
        return await processOneImage(url, referenceNumber, existingWm, existingOrig);
      } catch (err) {
        imgStats.failed++;
        const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 12);
        console.warn(`\n    ⚠️  [${referenceNumber}_${hash}_wm.jpg] ${err.message} — usando URL original`);
        return url;
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
  console.log(`🖼️   Descargando watermark desde HubSpot Files (ID: ${WATERMARK_FILE_ID})…`);
  WATERMARK_BUFFER = await fetchWatermarkFromHubSpot();
  console.log(`    Watermark listo (${(WATERMARK_BUFFER.length / 1024).toFixed(1)} KB)\n`);

  // 2 — Fetch XML feed (con reintentos por si el servidor de ReapCRM falla momentáneamente)
  console.log('📥  Descargando feed XML…');
  let xmlText;
  const XML_RETRIES = 3;
  const XML_TIMEOUT_MS = 60_000; // 60s — el feed puede pesar varios MB
  for (let attempt = 1; attempt <= XML_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), XML_TIMEOUT_MS);
      const xmlRes = await fetch(XML_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!xmlRes.ok) throw new Error(`HTTP ${xmlRes.status}`);
      xmlText = await xmlRes.text();
      break; // éxito
    } catch (err) {
      if (attempt === XML_RETRIES) throw new Error(`XML fetch falló tras ${XML_RETRIES} intentos: ${err.message}`);
      console.warn(`    ⚠️  Intento ${attempt} falló (${err.message}), reintentando en 10s…`);
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
  console.log(`    Descargado ${(xmlText.length / 1024).toFixed(1)} KB\n`);

  // 3 — Parse XML
  console.log('🔍  Parseando XML…');
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    processEntities: false,   // evita el límite de 1000 expansiones de entidades
    htmlEntities: true,       // reconoce entidades HTML (&amp; &nbsp; etc.) sin contarlas
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

  // 5 — Pre-cargar archivos existentes en HubSpot Files (un request por carpeta)
  console.log('📂  Cargando archivos existentes en HubSpot Files…');
  const [existingWm, existingOrig] = await Promise.all([
    loadFolderFiles(FOLDER_WATERMARK),
    loadFolderFiles(FOLDER_ORIGINALS),
  ]);
  console.log(`    ${existingWm.size} watermarked, ${existingOrig.size} originales\n`);

  // 6 — Mapear XML + procesar imágenes (en paralelo entre propiedades)
  console.log('🖼️   Procesando imágenes (descarga → watermark → HubSpot Files)…');
  console.log('    [cached] = ya en HubSpot Files  [↑] = subida nueva\n');

  const toCreate = [];
  const toUpdate = [];
  let skipped = 0;

  // Lanzamos todas las propiedades en paralelo; el limiter controla la concurrencia real
  const results = await Promise.all(
    xmlItems.map(async (item) => {
      const props = mapXmlToHubspot(item);
      if (!props.reference_number) return null;

      const rawImages = toArray(item.Images?.string)
        .filter(i => typeof i === 'string' && i.startsWith('http'));

      if (rawImages.length > 0) {
        const processedUrls = await processImages(rawImages, props.reference_number, existingWm, existingOrig);
        props.all_images = JSON.stringify(processedUrls);
      }

      return props;
    })
  );

  // Clasificamos en creates/updates
  for (const props of results) {
    if (!props) { skipped++; continue; }

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
