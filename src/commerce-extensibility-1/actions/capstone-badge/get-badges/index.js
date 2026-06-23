const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');

// ---------------------------------------------------------------------------
// Capstone: get-badges
// Fast read of badge state for a SKU from I/O State (key `badge_<sku>`).
// Exposed through API Mesh as `Badges_getProductBadges(sku)` for the PDP.
// Returns an empty badge list if the SKU has not been computed yet.
// ---------------------------------------------------------------------------

async function main(params) {
  const logger = Core.Logger('get-badges', { level: params.LOG_LEVEL || 'info' });
  const startMs = Date.now();

  const { sku } = params;
  if (!sku) {
    return { statusCode: 400, body: { error: 'Missing required parameter: sku' } };
  }

  try {
    const state = await stateLib.init();
    let res = null;
    try {
      res = await state.get(`badge_${sku}`);
    } catch (e) {
      logger.info(JSON.stringify({
        action: 'get-badges', message: 'No badge state found',
        sku, error: e.message, durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      }));
    }

    if (!res || !res.value) {
      logger.info(JSON.stringify({
        action: 'get-badges', message: 'Cache miss — returning empty badges',
        sku, durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
      }));
      return { statusCode: 200, body: { sku, badges: [], updatedAt: null } };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.value);
    } catch {
      parsed = { badges: [] };
    }

    logger.info(JSON.stringify({
      action: 'get-badges', message: 'Badges retrieved',
      sku, badgeCount: (parsed.badges || []).length,
      durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
    }));

    return {
      statusCode: 200,
      body: {
        sku,
        badges: Array.isArray(parsed.badges) ? parsed.badges : [],
        updatedAt: parsed.updatedAt || null,
      },
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
