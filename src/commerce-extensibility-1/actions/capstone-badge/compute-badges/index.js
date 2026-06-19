const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { DEFAULT_RULES, migrateRules, applyBadgeRules } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: compute-badges
// Reads a product from the Commerce API, applies the badge rules, and writes
// the resulting badge state to I/O State under key `badge:<sku>`.
//
// Badge rules (final, per SESSION_CAPSTONE_PLAN.md):
//   new        -> product created_at within `newWithinDays` (default 30)
//   bestseller -> sku present in merchant-configured `bestsellerSkus[]`
//   limited    -> active special_price within special_from/to_date window
//
// Rules are read from I/O State key `badge-rules`; if absent, DEFAULT_RULES
// (from lib/rules) is used (editable via the Week 5 Admin UI Badge Rules page).
// ---------------------------------------------------------------------------

const BADGE_STATE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let cachedToken = null;
let cachedExpiryMs = 0;

function normalizeImsTokenUrl(raw) {
  const fallback = 'https://ims-na1.adobelogin.com/ims/token/v2';
  if (!raw || typeof raw !== 'string') return fallback;
  const u = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/;+\s*$/g, '')
    .trim();
  return u || fallback;
}

/** IMS expects `scope` as comma-separated names, not a JSON array string. */
function scopeFormValue(scopesParam) {
  if (scopesParam == null) return '';
  const s = String(scopesParam).trim();
  if (!s.startsWith('[')) return s;
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter(Boolean).join(',') : s;
  } catch {
    return s;
  }
}

async function getImsAccessToken(params) {
  if (cachedToken && Date.now() < cachedExpiryMs - 60_000) {
    return cachedToken;
  }
  const tokenUrl = normalizeImsTokenUrl(params.IMS_TOKEN_URL);
  const scope = scopeFormValue(params.IMS_OAUTH_S2S_SCOPES);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: String(params.IMS_OAUTH_S2S_CLIENT_ID || ''),
    client_secret: String(params.IMS_OAUTH_S2S_CLIENT_SECRET || ''),
    org_id: String(params.IMS_OAUTH_S2S_ORG_ID || ''),
    scope,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`IMS token request failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  cachedExpiryMs = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/** SaaS (ACCS) uses `/V1/products/{sku}`; on-prem Magento uses `/rest/{store}/V1/...`. */
function catalogProductUrl(baseUrl, sku, p) {
  const b = String(baseUrl).replace(/\/$/, '');
  const encodedSku = encodeURIComponent(sku);
  if (/api\.commerce\.adobe\.com/i.test(b)) {
    return `${b}/V1/products/${encodedSku}`;
  }
  const storeCode = (p && p.COMMERCE_STORE_CODE) || 'default';
  return `${b}/rest/${encodeURIComponent(storeCode)}/V1/products/${encodedSku}`;
}

async function loadRules(state, logger) {
  try {
    const res = await state.get('badge-rules');
    if (res && res.value) {
      return migrateRules(JSON.parse(res.value));
    }
  } catch (e) {
    logger.warn(`badge-rules not loaded, using defaults: ${e.message}`);
  }
  return DEFAULT_RULES;
}

async function main(params) {
  const logger = Core.Logger('compute-badges', { level: params.LOG_LEVEL || 'info' });

  try {
    const { sku } = params;
    if (!sku) {
      return { statusCode: 400, body: { error: 'Missing required parameter: sku' } };
    }
    const rawBase = params.COMMERCE_API_BASE_URL;
    if (!rawBase || typeof rawBase !== 'string') {
      return { statusCode: 400, body: { error: 'Missing COMMERCE_API_BASE_URL' } };
    }

    const baseUrl = rawBase.replace(/\/$/, '');
    const accessToken = await getImsAccessToken(params);
    const productUrl = catalogProductUrl(baseUrl, sku, params);

    logger.info(`Fetching product for badge computation: ${sku}`);
    const response = await fetch(productUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'x-api-key': params.IMS_OAUTH_S2S_CLIENT_ID,
        'x-gw-ims-org-id': params.IMS_OAUTH_S2S_ORG_ID,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      logger.error(`Commerce API ${response.status} ${productUrl}`);
      return {
        statusCode: response.status,
        body: { error: `Commerce API error: ${response.statusText}`, url: productUrl },
      };
    }

    const product = await response.json();

    const state = await stateLib.init();
    const rules = await loadRules(state, logger);
    const badges = applyBadgeRules(product, rules, sku);

    const value = { sku, badges, updatedAt: new Date().toISOString() };
    await state.put(`badge_${sku}`, JSON.stringify(value), { ttl: BADGE_STATE_TTL_SECONDS });

    logger.info(`Computed badges for ${sku}: ${badges.join(', ') || '(none)'}`);
    return { statusCode: 200, body: value };
  } catch (error) {
    logger.error('compute-badges failed:', error.message);
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
