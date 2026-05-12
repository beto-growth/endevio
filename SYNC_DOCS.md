# HubSpot Listings Sync — Documentación

## Resumen

Sincronización automática del feed XML de **ReapCRM** (Frank Salt Real Estate) hacia el objeto custom **Listings** de HubSpot. Corre dos veces al día via GitHub Actions.

---

## Arquitectura

```
ReapCRM XML Feed (URL pública)
        ↓
GitHub Actions (cron: 12am y 12pm hora Malta)
        ↓
Node.js script (scripts/sync-listings.js)
        ↓
HubSpot API — objeto custom "listings"
  ├── CREATE  (propiedades nuevas en el XML)
  └── UPDATE  (propiedades existentes, key: reference_number)
```

---

## Fuente de datos

**URL del feed XML:**
```
https://v10-properties.reapcrm.com/xml/FrankSaltRealEstate/24329b2d-6754-4251-8ba0-4733bbb6b909_Endevio_Properties.xml
```

**Estructura del XML:**
```
XMLPropertyModel
  └── Results
        └── XMLPropertyModelItem[]   ← cada propiedad
  └── Agents
  └── Offices
```

---

## HubSpot

- **Portal:** beto@growthoperationsfirm.com
- **Objeto:** `listings` (Content Hub Enterprise)
- **Autenticación:** Private App token → GitHub Secret `HUBSPOT_TOKEN`
- **Deduplicación:** campo `reference_number` (valor único por propiedad)

> ⚠️ Rotar el token periódicamente en HubSpot → Private Apps y actualizar el secret en GitHub.

---

## Mapeo de campos XML → HubSpot

### Propiedades de sistema (built-in)

| Campo XML | Propiedad HubSpot | Tipo | Notas |
|---|---|---|---|
| `PropertyTitle` | `hs_name` | string | Nombre del record |
| `PriceNumber` | `hs_price` | number | Precio numérico |
| `Bedrooms` | `hs_bedrooms` | number | |
| `Bathrooms` | `hs_bathrooms` | number | |
| `Locality` | `hs_city` | string | |
| `LocalityCode` | `hs_neighborhood` | string | Código de localidad (ej: POR) |
| `TotalArea` | `hs_square_footage` | number | |
| `PropertyType` | `hs_listing_type` | enumeration | Valores coinciden exactamente con XML |

### Propiedades custom (preexistentes)

| Campo XML | Propiedad HubSpot | Tipo | Notas |
|---|---|---|---|
| `ReferenceNumber` | `reference_number` | string | 🔑 Clave de deduplicación |
| `Description` | `description` | string | Puede contener HTML |
| `CountryName` | `country` | string | |
| `RegionName` | `region` | string | Se limpia el prefijo numérico (ej: `"04-Sliema"` → `"Sliema"`) |
| `InsideArea` | `inside_area` | number | |
| `OutsideArea` | `outside_area` | number | |
| `TotalArea` | `total_area` | number | |
| `ProjectName` | `project_name` | string | |
| `BlockOfPropertiesName` | `block_of_properties_name` | string | |
| `Images.string[]` | `all_images` | string | JSON array de URLs serializado como string |
| `PropertyFeatures` | `key_features` | string | Renderizado como `<ul><li>Name: Value</li>...</ul>` |
| `IsSale` | `transaction_type` | enumeration | `true` → `"Sale"` / `false` → `"Rent"` |
| `PropertyStatus` | `status` | enumeration | `"A"` → `"Active"` / otro → `"Inactive"` |

### Propiedades custom (creadas durante este setup)

| Campo XML | Propiedad HubSpot | Tipo | Notas |
|---|---|---|---|
| `RentalPriceType` | `rental_price_type` | string | ej: `"per month"` |
| `IsPriceOnRequest` | `price_on_request` | bool | `true` / `false` |
| `LastUpdated` | `xml_last_updated` | datetime | Timestamp del CRM origen |
| `AgencyType` | `agency_type` | string | ej: `"Open Agency"` |
| `AgentPhoneNumber` | `agent_phone` | string | Formato string (evita pérdida de formato) |
| `AgentName` | `agent_name` | string | |
| `AgentEmail` | `agent_email` | string | |
| `AgentImageUrl` | `agent_photo` | string | URL normalizada (corrige doble slash `//`) |

### Campos XML ignorados (sin valor en este feed)

| Campo XML | Motivo |
|---|---|
| `Plans` | Siempre vacío en este feed |
| `NextAvailableDate` | Siempre vacío en este feed |
| `Purpose` | Código interno del CRM (ej: `"R-LL"`) |
| `PropertyTypeCode` | Redundante con `PropertyType` |
| `CountryISO2/3`, `RegionCode` | Códigos internos, no necesarios |
| `AgentIdentifier`, `BlockOfPropertiesId`, `ProjectId` | GUIDs internos |

---

## Transformaciones aplicadas

| Campo | Transformación |
|---|---|
| `region` | Remueve prefijo numérico: `^\d+-` → `""` (ej: `"04-Sliema"` → `"Sliema"`) |
| `agent_photo` | Normaliza doble slash en URL: `([^:])//` → `$1/` |
| `key_features` | Convierte array de `{Name, Value}` a `<ul><li>Name: Value</li></ul>` |
| `all_images` | Serializa array de URLs como JSON string |
| `xml_last_updated` | Convierte `"YYYY-MM-DD HH:MM:SS"` a timestamp Unix (ms) |

---

## Estructura del repositorio

```
endevio/
├── .github/
│   └── workflows/
│       └── sync-listings.yml     # GitHub Actions workflow
├── scripts/
│   ├── sync-listings.js          # Script principal de sync
│   ├── package.json
│   └── package-lock.json
├── .gitignore
└── SYNC_DOCS.md                  # Este archivo
```

---

## GitHub Actions Workflow

**Archivo:** `.github/workflows/sync-listings.yml`

**Schedule (hora Malta):**
| Hora Malta | Cron (UTC) | Verano (CEST UTC+2) | Invierno (CET UTC+1) |
|---|---|---|---|
| 12:00 AM | `0 22 * * *` | ✅ exacto | 11:00 PM (1h antes) |
| 12:00 PM | `0 10 * * *` | ✅ exacto | 11:00 AM (1h antes) |

> GitHub Actions usa UTC. El offset de 1 hora en invierno es aceptable para un sync de datos.

**Secret requerido en el repo:**
```
HUBSPOT_TOKEN = <HubSpot Private App token>
```
Configurar en: **GitHub → Settings → Secrets and variables → Actions**

**Trigger manual:** Actions → "Sync Listings from ReapCRM XML" → "Run workflow"

---

## Lógica del script

```
1. Fetch XML desde URL pública
2. Parse XML con fast-xml-parser
   - Ruta de items: XMLPropertyModel → Results → XMLPropertyModelItem[]
   - isArray forzado en: XMLPropertyModelItem, string (imágenes), PropertyFeature
3. Fetch todos los listings existentes en HubSpot (paginado, 100/página)
   → construye Map: reference_number → hs_object_id
4. Por cada item del XML:
   - Aplicar transformaciones y mapeo
   - Si reference_number existe en el Map → UPDATE
   - Si no existe → CREATE
5. Ejecutar batch create (POST /crm/v3/objects/listings/batch/create)
6. Ejecutar batch update (POST /crm/v3/objects/listings/batch/update)
   → Máximo 100 records por batch request
```

**Protección contra borrado accidental:**
Si el XML devuelve 0 propiedades, el script aborta sin modificar nada en HubSpot.

---

## Dependencias

```json
{
  "fast-xml-parser": "^4.4.1"
}
```
Node.js >= 20 (fetch nativo, sin node-fetch).

---

## HubSpot API endpoints usados

| Método | Endpoint | Uso |
|---|---|---|
| `GET` | `/crm/v3/objects/listings?properties=reference_number` | Fetch existentes (paginado) |
| `POST` | `/crm/v3/objects/listings/batch/create` | Crear nuevos listings |
| `POST` | `/crm/v3/objects/listings/batch/update` | Actualizar listings existentes |

---

## Mantenimiento

### Agregar una nueva propiedad al sync

1. Crear la propiedad en HubSpot via API o UI
2. Agregar el mapeo en `scripts/sync-listings.js` dentro de `mapXmlToHubspot()`
3. Commit y push → el próximo sync la populará

### Rotar el token de HubSpot

1. HubSpot → Settings → Private Apps → crear nuevo token
2. GitHub → beto-growth/endevio → Settings → Secrets → actualizar `HUBSPOT_TOKEN`
3. Revocar el token viejo en HubSpot

### Verificar último sync

GitHub → beto-growth/endevio → Actions → "Sync Listings from ReapCRM XML"
