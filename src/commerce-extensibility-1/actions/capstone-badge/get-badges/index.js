const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { DEFAULT_RULES, migrateRules, applyBadgeRules, computeTtlSeconds } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: get-badges  (v3 — lazy-pull with inline compute)
//
// Single entry point for PDP badge data. Serves from I/O State when fresh;
// computes inline when stale or missing. Staleness = rules updated_at is newer
// than the cached badge computed_at. A missing State entry always computes.
//
// Compute path (inline — no HTTP hop):
//   1. IMS S2S token
//   2. GET /V1/products/{sku} from Commerce REST
//   3. applyBadgeRules → matched badge IDs
//   4. write badge_<sku> to State with TTL = min(ttlDays of matched badges)
//
// Response shape (unchanged for API Mesh compatibility):
//   { sku, badges: ["id1", "id2"], updatedAt: ISO }
// ---------------------------------------------------------------------------

let cachedToken = null;
let cachedExpiryMs = 0;

function normalizeImsTokenUrl(raw) {
  const fallback = 'https://ims-na1.adobelogin.com/ims/token/v2';
  if (!raw || typeof raw !== 'string') return fallback;
  const u = raw.trim().replace(/^['"]+|['"]+$/g, '').replace(/;+\s*$/g, '').trim();
  return u || fallback;
}

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
  if (cachedToken && Date.now() < cachedExpiryMs - 60_000) return cachedToken;
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

function catalogProductUrl(baseUrl, sku, params) {
  const b = String(baseUrl).replace(/\/$/, '');
  const encodedSku = encodeURIComponent(sku);
  if (/api\.commerce\.adobe\.com/i.test(b)) return `${b}/V1/products/${encodedSku}`;
  const storeCode = params.COMMERCE_STORE_CODE || 'default';
  return `${b}/rest/${encodeURIComponent(storeCode)}/V1/products/${encodedSku}`;
}

// Inline compute: fetch product → apply rules → write State → return badge IDs.
async function computeAndCache(sku, rules, state, params, logger, startMs) {
  const rawBase = params.COMMERCE_API_BASE_URL;
  if (!rawBase) throw new Error('Missing COMMERCE_API_BASE_URL');

  const accessToken = await getImsAccessToken(params);
  const productUrl = catalogProductUrl(rawBase, sku, params);

  const res = await fetch(productUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-api-key': params.IMS_OAUTH_S2S_CLIENT_ID,
      'x-gw-ims-org-id': params.IMS_OAUTH_S2S_ORG_ID,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Commerce API ${res.status} for SKU ${sku}`);
  }

  const product = await res.json();
  const badgeIds = applyBadgeRules(product, rules.badgeList, sku);
  const ttlSeconds = computeTtlSeconds(badgeIds, rules.badgeList);
  const computed_at = new Date().toISOString();

  await state.put(`badge_${sku}`, JSON.stringify({ sku, badge_ids: badgeIds, computed_at }), { ttl: ttlSeconds });

  logger.info(JSON.stringify({
    action: 'get-badges', message: 'Badges computed and cached',
    sku, badgeIds, ttlDays: Math.round(ttlSeconds / 86400),
    durationMs: Date.now() - startMs, timestamp: computed_at,
  }));

  return { badge_ids: badgeIds, computed_at };
}

async function main(params) {
  const logger = Core.Logger('get-badges', { level: params.LOG_LEVEL || 'info' });
  const startMs = Date.now();

  const { sku } = params;
  if (!sku) {
    return { statusCode: 400, body: { error: 'Missing required parameter: sku' } };
  }

  try {
    const state = await stateLib.init();

    // 1. Read badge-rules (migrate to v3 if needed).
    let rules = DEFAULT_RULES;
    try {
      const rulesRes = await state.get('badge-rules');
      if (rulesRes && rulesRes.value) {
        rules = migrateRules(JSON.parse(rulesRes.value));
      }
    } catch (e) {
      logger.warn(JSON.stringify({ action: 'get-badges', message: 'Could not read badge-rules, using defaults', error: e.message }));
    }

    // 2. Read cached badge state for this SKU.
    let cached = null;
    try {
      const cachedRes = await state.get(`badge_${sku}`);
      if (cachedRes && cachedRes.value) {
        cached = JSON.parse(cachedRes.value);
      }
    } catch (e) {
      // Key not found — treat as cache miss.
    }

    // 3. Staleness check: recompute if missing OR rules are newer than cached.
    let badge_ids;
    let computed_at;

    if (!cached) {
      // Cache miss — compute fresh.
      logger.info(JSON.stringify({ action: 'get-badges', message: 'Cache miss — computing', sku, durationMs: Date.now() - startMs, timestamp: new Date().toISOString() }));
      const result = await computeAndCache(sku, rules, state, params, logger, startMs);
      badge_ids = result.badge_ids;
      computed_at = result.computed_at;
    } else if (rules.updated_at && rules.updated_at > cached.computed_at) {
      // Rules updated after last compute — recompute.
      logger.info(JSON.stringify({ action: 'get-badges', message: 'Rules updated — recomputing', sku, rules_updated_at: rules.updated_at, cached_computed_at: cached.computed_at, durationMs: Date.now() - startMs, timestamp: new Date().toISOString() }));
      const result = await computeAndCache(sku, rules, state, params, logger, startMs);
      badge_ids = result.badge_ids;
      computed_at = result.computed_at;
    } else {
      // Fresh — serve from cache.
      badge_ids = cached.badge_ids || [];
      computed_at = cached.computed_at;
      logger.info(JSON.stringify({ action: 'get-badges', message: 'Served from cache', sku, badgeCount: badge_ids.length, durationMs: Date.now() - startMs, timestamp: new Date().toISOString() }));
    }

    return {
      statusCode: 200,
      body: { sku, badges: badge_ids, updatedAt: computed_at },
    };
  } catch (error) {
    logger.error(JSON.stringify({
      action: 'get-badges', message: 'Action failed',
      sku, error: error.message, durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    }));
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
