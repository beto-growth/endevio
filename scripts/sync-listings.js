/**
 * HubSpot Listings Sync
 * Fetches the ReapCRM XML feed and upserts records into the HubSpot
 * "listings" custom object using batch create / batch update.
 *
 * Required env var: HUBSPOT_TOKEN
 */

'use strict';

const { XMLParser } = require('fast-xml-parser');

// ─── Config ──────────────────────────────────────────────────────────────────

const XML_URL =
  'https://v10-properties.reapcrm.com/xml/FrankSaltRealEstate/24329b2d-6754-4251-8ba0-4733bbb6b909_Endevio_Properties.xml';

const HS_OBJECT_TYPE = 'listings';
const HS_BASE        = 'https://api.hubapi.com';
const BATCH_SIZE     = 100; // HubSpot max per batch request

const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
if (!HUBSPOT_TOKEN) {
  console.error('❌  Missing HUBSPOT_TOKEN environment variable');
  process.exit(1);
}

// ─── XML → HubSpot field mapping ─────────────────────────────────────────────
//
// XML field              HubSpot property           Notes
// ---------------------  -------------------------  --------------------------
// ReferenceNumber        reference_number           Unique key for dedup
// PropertyTitle          hs_name                    Record name
// PriceNumber            hs_price                   Numeric price
// RentalPriceType        rental_price_type          "per month", "per week"
// IsPriceOnRequest       price_on_request           Boolean
// Bedrooms               hs_bedrooms
// Bathrooms              hs_bathrooms
// Locality               hs_city
// LocalityCode           hs_neighborhood
// TotalArea              hs_square_footage + total_area
// PropertyType           hs_listing_type            Label values match exactly
// Description            description                May contain HTML
// CountryName            country
// RegionName             region
// InsideArea             inside_area
// OutsideArea            outside_area
// ProjectName            project_name
// BlockOfPropertiesName  block_of_properties_name
// AgentName              agent_name
// AgentEmail             agent_email
// AgentPhoneNumber       agent_phone                String field (phone format)
// AgentImageUrl          agent_photo
// Images[].string        all_images                 JSON array as string
// PropertyFeatures       key_features               "Name: Value" lines
// AgencyType             agency_type                "Open Agency", "Sole Agency"
// LastUpdated            xml_last_updated           Datetime from CRM feed
// IsSale                 transaction_type           'Sale' | 'Rent'
// PropertyStatus         status                     'Active' | 'Inactive'

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

  // hs_listing_type enum values match the XML PropertyType labels exactly
  if (item.PropertyType)     props.hs_listing_type   = String(item.PropertyType);

  // — Custom properties —
  props.reference_number = String(item.ReferenceNumber);

  if (item.Description)              props.description               = String(item.Description);
  if (item.CountryName)              props.country                   = String(item.CountryName);
  if (item.RegionName)               props.region                    = String(item.RegionName).replace(/^\d+-/, '').trim();
  if (item.InsideArea != null)       props.inside_area               = Number(item.InsideArea);
  if (item.OutsideArea != null)      props.outside_area              = Number(item.OutsideArea);
  if (item.TotalArea != null)        props.total_area                = Number(item.TotalArea);
  if (item.ProjectName)              props.project_name              = String(item.ProjectName);
  if (item.BlockOfPropertiesName)    props.block_of_properties_name  = String(item.BlockOfPropertiesName);
  if (item.AgentName)  props.agent_name  = String(item.AgentName);
  if (item.AgentEmail) props.agent_email = String(item.AgentEmail);
  if (item.AgentPhoneNumber) props.agent_phone = String(item.AgentPhoneNumber).trim();
  // Normalize URLs: fix double-slash paths (e.g. https://host//path → https://host/path)
  if (item.AgentImageUrl) {
    props.agent_photo = String(item.AgentImageUrl).replace(/([^:])\/\//g, '$1/');
  }
  if (item.RentalPriceType)  props.rental_price_type = String(item.RentalPriceType).trim();
  if (item.AgencyType)       props.agency_type = String(item.AgencyType);
  if (item.LastUpdated)      props.xml_last_updated = new Date(item.LastUpdated).getTime();
  props.price_on_request = (item.IsPriceOnRequest === true || item.IsPriceOnRequest === 'true') ? 'true' : 'false';

  // Images → JSON array stored as a string
  // XML structure: <Images><string>url</string><string>url</string></Images>
  const images = toArray(item.Images?.string);
  const imageUrls = images.filter(i => typeof i === 'string' && i.startsWith('http'));
  if (imageUrls.length) props.all_images = JSON.stringify(imageUrls);

  // PropertyFeatures → "Name: Value" lines
  const features = toArray(item.PropertyFeatures?.PropertyFeature);
  if (features.length) {
    const items = features.map(f => `<li>${f.Name}: ${f.Value}</li>`).join('');
    props.key_features = `<ul>${items}</ul>`;
  }

  // Enums — values verified against HubSpot portal
  const isSale = item.IsSale === true || item.IsSale === 'true';
  props.transaction_type = isSale ? 'Sale' : 'Rent';
  props.status           = item.PropertyStatus === 'A' ? 'Active' : 'Inactive';

  return props;
}

// ─── HubSpot API helpers ──────────────────────────────────────────────────────

const HS_HEADERS = {
  Authorization: `Bearer ${HUBSPOT_TOKEN}`,
  'Content-Type': 'application/json',
};

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

// Fetch ALL existing listings, paginating through the full result set.
// Returns a Map: reference_number → hs_object_id
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
    if (after) console.log(`  ↳ page ${page}: ${map.size} listings fetched so far…`);
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
  }

  return { updated, errors };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════╗');
  console.log('║   HubSpot Listings Sync          ║');
  console.log('╚══════════════════════════════════╝');
  console.log(`⏰  ${new Date().toISOString()}\n`);

  // 1 — Fetch XML feed
  console.log('📥  Fetching XML feed…');
  const xmlRes = await fetch(XML_URL);
  if (!xmlRes.ok) throw new Error(`XML fetch failed with HTTP ${xmlRes.status}`);
  const xmlText = await xmlRes.text();
  console.log(`    Downloaded ${(xmlText.length / 1024).toFixed(1)} KB\n`);

  // 2 — Parse XML
  console.log('🔍  Parsing XML…');
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
    isArray: (tagName) =>
      ['XMLPropertyModelItem', 'string', 'PropertyFeature'].includes(tagName),
  });
  const parsed = parser.parse(xmlText);
  const xmlItems = parsed?.XMLPropertyModel?.Results?.XMLPropertyModelItem ?? [];
  console.log(`    Found ${xmlItems.length} properties in feed\n`);

  if (xmlItems.length === 0) {
    console.warn('⚠️   XML returned 0 properties — aborting to avoid accidental data loss.');
    process.exit(0);
  }

  // 3 — Fetch existing HubSpot records
  console.log('📋  Fetching existing HubSpot listings…');
  const existingMap = await fetchAllExistingListings();
  console.log(`    Found ${existingMap.size} existing records\n`);

  // 4 — Split into creates vs updates
  const toCreate = [];
  const toUpdate = [];
  let skipped = 0;

  for (const item of xmlItems) {
    const props = mapXmlToHubspot(item);
    if (!props.reference_number) { skipped++; continue; }

    if (existingMap.has(props.reference_number)) {
      toUpdate.push({ id: existingMap.get(props.reference_number), properties: props });
    } else {
      toCreate.push(props);
    }
  }

  console.log('📊  Sync plan:');
  console.log(`    ➕ Create: ${toCreate.length}`);
  console.log(`    ✏️   Update: ${toUpdate.length}`);
  if (skipped) console.log(`    ⚠️   Skipped (no reference_number): ${skipped}`);
  console.log('');

  // 5 — Batch create
  if (toCreate.length > 0) {
    console.log(`➕  Creating ${toCreate.length} new listings…`);
    const { created, errors } = await batchCreate(toCreate);
    console.log(`    ✅  Created: ${created}`);
    errors.forEach(e => console.error(`    ❌  ${e}`));
    console.log('');
  }

  // 6 — Batch update
  if (toUpdate.length > 0) {
    console.log(`✏️   Updating ${toUpdate.length} existing listings…`);
    const { updated, errors } = await batchUpdate(toUpdate);
    console.log(`    ✅  Updated: ${updated}`);
    errors.forEach(e => console.error(`    ❌  ${e}`));
    console.log('');
  }

  console.log('🎉  Sync complete!');
}

main().catch(err => {
  console.error('\n💥  Fatal error:', err.message);
  process.exit(1);
});
