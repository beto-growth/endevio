/**
 * HubSpot Listings — Data Sync
 *
 * Descarga el XML de ReapCRM y hace upsert de los listings en HubSpot.
 * NO procesa imágenes: guarda las URLs originales del CRM en all_images.
 * El procesamiento de imágenes es responsabilidad de sync-images.js.
 *
 * Incremental: solo actualiza listings donde xml_last_updated cambió.
 * Para nuevos listings siempre crea.
 * Si all_images ya contiene URLs de HubSpot Files, NO las sobreescribe
 * (a menos que xml_last_updated haya cambiado, indicando que el CRM actualizó las imágenes).
 *
 * Required env var: HUBSPOT_TOKEN
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');

// ─── Config ───────────────────────────────────────────────────────────────────

const XML_URL =
  'https://v10-properties.reapcrm.com/xml/FrankSaltRealEstate/Properties.xml';

const HS_OBJECT_TYPE  = 'listings';
const HS_BASE         = 'https://api.hubapi.com';
const BATCH_SIZE      = 100;
const BATCH_DELAY_MS  = 300;   // pausa entre batch requests para respetar rate limits
const XML_TIMEOUT_MS  = 180_000; // 3 min — el feed puede pesar 140 MB
const XML_RETRIES     = 3;

// Dominio del CRM — usado para detectar imágenes sin procesar
const CRM_IMAGE_DOMAIN = 'reapcrm.com';

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('❌  Missing HUBSPOT_TOKEN environment variable');
  process.exit(1);
}

const HS_HEADERS = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toArray(val) {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

/** ¿La URL es de HubSpot Files (ya procesada)? */
function isHubSpotUrl(url) {
  return typeof url === 'string' && url.includes('hubspotusercontent');
}

/** ¿El JSON de all_images ya tiene URLs procesadas por HubSpot Files? */
function allImagesAlreadyProcessed(allImagesJson) {
  if (!allImagesJson) return false;
  try {
    const urls = JSON.parse(allImagesJson);
    return Array.isArray(urls) && urls.length > 0 && urls.every(isHubSpotUrl);
  } catch { return false; }
}

// ─── XML → HubSpot mapping ────────────────────────────────────────────────────

function mapXmlToHubspot(item) {
  const props = {};

  // — Propiedades de sistema —
  if (item.PropertyTitle)     props.hs_name           = String(item.PropertyTitle);
  if (item.PriceNumber)       props.hs_price          = Number(item.PriceNumber);
  if (item.Bedrooms  != null) props.hs_bedrooms       = Number(item.Bedrooms);
  if (item.Bathrooms != null) props.hs_bathrooms      = Number(item.Bathrooms);
  if (item.Locality)          props.hs_city           = String(item.Locality);
  if (item.LocalityCode)      props.hs_neighborhood   = String(item.LocalityCode);
  if (item.TotalArea != null) props.hs_square_footage = Number(item.TotalArea);

  // — Propiedades custom —
  props.reference_number = String(item.ReferenceNumber);

  if (item.PropertyType)          props.xml_listing_type         = String(item.PropertyType);
  if (item.Purpose)               props.purpose                  = String(item.Purpose);
  if (item.Description)           props.description              = String(item.Description).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  if (item.CountryName)           props.country                  = String(item.CountryName);
  if (item.RegionName)            props.region                   = String(item.RegionName).replace(/^\d+-/, '').trim();
  if (item.InsideArea  != null)   props.inside_area              = Number(item.InsideArea);
  if (item.OutsideArea != null)   props.outside_area             = Number(item.OutsideArea);
  if (item.TotalArea   != null)   props.total_area               = Number(item.TotalArea);
  if (item.ProjectName)           props.project_name             = String(item.ProjectName);
  if (item.BlockOfPropertiesName) props.block_of_properties_name = String(item.BlockOfPropertiesName);
  if (item.AgentName)             props.agent_name               = String(item.AgentName);
  if (item.AgentEmail)            props.agent_email              = String(item.AgentEmail);
  if (item.AgentPhoneNumber)      props.agent_phone              = String(item.AgentPhoneNumber).trim();
  if (item.AgentImageUrl)         props.agent_photo              = String(item.AgentImageUrl).replace(/([^:])\/\//g, '$1/');
  if (item.RentalPriceType)       props.rental_price_type        = String(item.RentalPriceType).trim();
  if (item.AgencyType)            props.agency_type              = String(item.AgencyType);
  if (item.LastUpdated)           props.xml_last_updated         = new Date(item.LastUpdated).getTime();

  props.price_on_request = (item.IsPriceOnRequest === true || item.IsPriceOnRequest === 'true')
    ? 'true' : 'false';

  const isSale = item.IsSale === true || item.IsSale === 'true';
  props.transaction_type = isSale ? 'Sale' : 'Rent';
  props.status           = item.PropertyStatus === 'A' ? 'Active' : 'Inactive';

  const features = toArray(item.PropertyFeatures?.PropertyFeature);
  if (features.length) {
    const lines = features.map(f => `<li>${f.Name}: ${f.Value}</li>`).join('');
    props.key_features = `<ul>${lines}</ul>`;
  }

  // Imágenes: siempre guardamos las URLs originales del CRM.
  // sync-images.js se encarga de procesarlas y actualizar all_images con HubSpot Files URLs.
  const images    = toArray(item.Images?.string);
  const imageUrls = images.filter(i => typeof i === 'string' && i.startsWith('http'));
  if (imageUrls.length) props.all_images = JSON.stringify(imageUrls);

  return props;
}

// ─── HubSpot CRM API helpers ──────────────────────────────────────────────────

async function hsGet(path) {
  const res = await fetch(`${HS_BASE}${path}`, { headers: HS_HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${path} → HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function hsPost(path, body) {
  const res = await fetch(`${HS_BASE}${path}`, {
    method: 'POST',
    headers: HS_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`POST ${path} → HTTP ${res.status}: ${errBody}`);
  }
  return res.json();
}

/**
 * Carga todos los listings existentes en HubSpot.
 * Retorna Map: reference_number → { id, xml_last_updated (ms), all_images }
 */
async function fetchAllExistingListings() {
  const map = new Map();
  let after = null;
  let page  = 0;

  do {
    const qs = new URLSearchParams({
      limit: '100',
      properties: 'reference_number,xml_last_updated,all_images',
    });
    if (after) qs.set('after', after);

    const data = await hsGet(`/crm/v3/objects/${HS_OBJECT_TYPE}?${qs}`);
    page++;

    for (const record of data.results ?? []) {
      const ref = record.properties?.reference_number;
      if (ref) {
        map.set(ref, {
          id:               record.id,
          xml_last_updated: Number(record.properties?.xml_last_updated ?? 0),
          all_images:       record.properties?.all_images ?? null,
        });
      }
    }

    after = data.paging?.next?.after ?? null;
    if (page % 20 === 0) console.log(`  ↳ página ${page}: ${map.size} listings…`);
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
    } catch (e) {
      errors.push(e.message);
    }
    if (i + BATCH_SIZE < propsList.length) await sleep(BATCH_DELAY_MS);
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
  console.log('║   HubSpot Listings — Data Sync       ║');
  console.log('║   (metadata · incremental · sin imgs)║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}\n`);

  // 1 — Fetch XML (con reintentos)
  console.log('📥  Descargando feed XML…');
  let xmlText;

  for (let attempt = 1; attempt <= XML_RETRIES; attempt++) {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), XML_TIMEOUT_MS);
      const res   = await fetch(XML_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      xmlText = await res.text();
      break;
    } catch (err) {
      if (attempt === XML_RETRIES)
        throw new Error(`XML fetch falló tras ${XML_RETRIES} intentos: ${err.message}`);
      console.warn(`    ⚠️  Intento ${attempt} falló (${err.message}), reintentando en 15s…`);
      await sleep(15_000);
    }
  }
  console.log(`    Descargado ${(xmlText.length / 1024 / 1024).toFixed(1)} MB\n`);

  // 2 — Parse XML
  console.log('🔍  Parseando XML…');
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue:    true,
    processEntities:  false,
    htmlEntities:     true,
    isArray: tagName => ['XMLPropertyModelItem', 'string', 'PropertyFeature'].includes(tagName),
  });
  const parsed   = parser.parse(xmlText);
  const xmlItems = parsed?.XMLPropertyModel?.Results?.XMLPropertyModelItem ?? [];
  console.log(`    ${xmlItems.length} propiedades en el feed\n`);

  if (xmlItems.length === 0) {
    console.warn('⚠️   XML retornó 0 propiedades — abortando para evitar pérdida de datos.');
    process.exit(0);
  }

  // 3 — Fetch listings existentes en HubSpot
  console.log('📋  Cargando listings existentes en HubSpot…');
  const existingMap = await fetchAllExistingListings();
  console.log(`    ${existingMap.size} registros existentes\n`);

  // 4 — Clasificar: create / update (incremental) / skip (sin cambios)
  const toCreate  = [];
  const toUpdate  = [];
  let   unchanged = 0;
  let   skipped   = 0;

  for (const item of xmlItems) {
    const props = mapXmlToHubspot(item);
    if (!props.reference_number) { skipped++; continue; }

    const existing = existingMap.get(props.reference_number);

    if (!existing) {
      // Nuevo listing → crear con URLs del CRM en all_images
      toCreate.push(props);
      continue;
    }

    const newTs = Number(props.xml_last_updated ?? 0);
    const oldTs = existing.xml_last_updated;

    if (newTs <= oldTs) {
      // Sin cambios en el CRM → no tocar nada (preserva all_images procesadas)
      unchanged++;
      continue;
    }

    // xml_last_updated cambió → el CRM actualizó la propiedad.
    // Actualizamos todos los campos incluyendo all_images con las URLs nuevas del CRM.
    // sync-images.js detectará que all_images volvió a tener CRM URLs y reprocessará.
    toUpdate.push({ id: existing.id, properties: props });
  }

  console.log('📊  Plan de sync:');
  console.log(`    ➕  Crear:       ${toCreate.length}`);
  console.log(`    ✏️   Actualizar:  ${toUpdate.length}  (xml_last_updated cambió)`);
  console.log(`    ⏭️   Sin cambios: ${unchanged}`);
  if (skipped) console.log(`    ⚠️   Sin reference_number: ${skipped}`);
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
    console.log(`✏️   Actualizando ${toUpdate.length} listings…`);
    const { updated, errors } = await batchUpdate(toUpdate);
    console.log(`    ✅  Actualizados: ${updated}`);
    errors.forEach(e => console.error(`    ❌  ${e}`));
    console.log('');
  }

  console.log('🎉  Data sync completo!');
}

main().catch(err => {
  console.error('\n💥  Error fatal:', err.message);
  process.exit(1);
});
