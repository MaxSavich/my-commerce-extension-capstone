const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');

// ---------------------------------------------------------------------------
// Capstone: badge-event-consumer  (web: 'no' — I/O Events consumer)
//
// Triggered by Commerce catalog event `catalog_product_save_after`.
//
// v3 behaviour (lazy-pull model): simply deletes the cached badge_<sku> State
// entry for the saved product. The next PDP request for this SKU will call
// get-badges, find the cache miss, and recompute fresh from Commerce + current
// badge rules. No IMS token, no Commerce API call, no badge logic here.
// ---------------------------------------------------------------------------

function extractSku(params) {
  const d = params.data?.value || params.data || params.event?.data || {};
  return (
    d.sku ||
    d.product_sku ||
    params.sku ||
    (d.product && d.product.sku) ||
    null
  );
}

async function main(params) {
  const logger = Core.Logger('badge-event-consumer', { level: params.LOG_LEVEL || 'info' });
  const startMs = Date.now();

  const eventId = params.event_id || params.eventId || null;
  const eventType = params.type || params.event_type || 'unknown';

  try {
    const sku = extractSku(params);
    if (!sku) {
      logger.warn(JSON.stringify({
        action: 'badge-event-consumer', message: 'No sku in event payload — skipping',
        eventId, eventType, durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
      }));
      return { statusCode: 200, body: { message: 'No sku in payload, skipping', eventId } };
    }

    const state = await stateLib.init();
    await state.delete(`badge_${sku}`);

    logger.info(JSON.stringify({
      action: 'badge-event-consumer', message: 'Badge cache invalidated',
      sku, eventId, eventType,
      durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
    }));

    return { statusCode: 200, body: { message: 'Badge cache invalidated', sku, eventId } };
  } catch (error) {
    logger.error(JSON.stringify({
      action: 'badge-event-consumer', message: 'Failed to invalidate badge cache',
      eventId, error: error.message,
      durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
    }));
    return { statusCode: 500, body: { error: 'Badge cache invalidation failed', detail: error.message } };
  }
}

exports.main = main;
