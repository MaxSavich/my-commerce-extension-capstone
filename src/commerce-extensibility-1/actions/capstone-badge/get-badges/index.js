const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');

// ---------------------------------------------------------------------------
// Capstone: get-badges
// Fast read of badge state for a SKU from I/O State (key `badge:<sku>`).
// Exposed through API Mesh as `Badges_getProductBadges(sku)` for the PDP.
// Returns an empty badge list if the SKU has not been computed yet.
// ---------------------------------------------------------------------------

async function main(params) {
  const logger = Core.Logger('get-badges', { level: params.LOG_LEVEL || 'info' });

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
      logger.info(`No badge state for ${sku}: ${e.message}`);
    }

    if (!res || !res.value) {
      return { statusCode: 200, body: { sku, badges: [], updatedAt: null } };
    }

    let parsed;
    try {
      parsed = JSON.parse(res.value);
    } catch {
      parsed = { badges: [] };
    }

    return {
      statusCode: 200,
      body: {
        sku,
        badges: Array.isArray(parsed.badges) ? parsed.badges : [],
        updatedAt: parsed.updatedAt || null,
      },
    };
  } catch (error) {
    logger.error('get-badges failed:', error.message);
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
