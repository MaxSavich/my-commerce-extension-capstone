const { Core } = require('@adobe/aio-sdk');

// ---------------------------------------------------------------------------
// Capstone: badge-event-consumer  (web: 'no' — I/O Events consumer)
//
// Triggered by the Commerce catalog event `catalog_product_save_after`.
// On each product save it recomputes that SKU's badges by calling the
// existing capstone-badge actions over HTTP (decoupled, no shared module):
//
//   1. GET get-badges?sku=<sku>      -> badgesBefore (current State)
//   2. GET compute-badges?sku=<sku>  -> badgesAfter  (recomputed + written)
//
// It writes a single structured JSON log line so an evaluator can follow one
// change end-to-end: { sku, eventId, correlationId, badgesBefore, badgesAfter }.
//
// Dependencies: @adobe/aio-sdk (Core.Logger) + global fetch only. The State
// write is owned by compute-badges; this action stays stateless.
// ---------------------------------------------------------------------------

const PACKAGE = 'capstone-badge';

/**
 * Resolve a sibling web-action URL. Defaults to this namespace's vanity host
 * (https://<namespace>.adobeioruntime.net/api/v1/web/<package>/<action>) so no
 * extra config is required; override via input if ever needed.
 */
function actionUrl(actionName, override) {
  if (override && /^https?:\/\//i.test(String(override).trim())) return String(override).trim();
  const ns = process.env.__OW_NAMESPACE;
  return `https://${ns}.adobeioruntime.net/api/v1/web/${PACKAGE}/${actionName}`;
}

/** Pull the SKU out of an I/O Events / Commerce product-save payload. */
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

/** GET a badge action and return its parsed badge list (defensive). */
async function fetchBadges(url, logger) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return Array.isArray(body.badges) ? body.badges : [];
}

async function main(params) {
  const logger = Core.Logger('badge-event-consumer', { level: params.LOG_LEVEL || 'info' });

  const eventId = params.event_id || params.eventId || null;
  const correlationId = process.env.__OW_ACTIVATION_ID || eventId || null;
  const eventType = params.type || params.event_type || 'unknown';

  try {
    const sku = extractSku(params);
    if (!sku) {
      logger.warn(`No sku in event payload (type=${eventType}, eventId=${eventId}); skipping`);
      return { statusCode: 200, body: { message: 'No sku in payload, skipping', eventId } };
    }

    logger.info(`Recompute trigger: sku=${sku} type=${eventType} eventId=${eventId}`);

    const getUrl = actionUrl('get-badges', params.GET_BADGES_URL);
    const computeUrl = actionUrl('compute-badges', params.COMPUTE_BADGES_URL);
    const skuQs = `sku=${encodeURIComponent(sku)}`;

    // badgesBefore — best-effort; never fail the consumer over the "before" read
    let badgesBefore = null;
    try {
      badgesBefore = await fetchBadges(`${getUrl}?${skuQs}`, logger);
    } catch (e) {
      logger.warn(`get-badges (before) failed for ${sku}: ${e.message}`);
    }

    // badgesAfter — recompute + persist via compute-badges
    const badgesAfter = await fetchBadges(`${computeUrl}?${skuQs}`, logger);

    // Single structured line for end-to-end traceability
    logger.info(
      JSON.stringify({
        msg: 'badge-recompute',
        sku,
        eventId,
        correlationId,
        eventType,
        badgesBefore,
        badgesAfter,
        changed: JSON.stringify(badgesBefore) !== JSON.stringify(badgesAfter),
        at: new Date().toISOString(),
      })
    );

    return {
      statusCode: 200,
      body: { message: 'Badge recompute complete', sku, eventId, correlationId, badgesBefore, badgesAfter },
    };
  } catch (error) {
    logger.error(
      JSON.stringify({
        msg: 'badge-recompute-failed',
        eventId,
        correlationId,
        error: error.message,
      })
    );
    return { statusCode: 500, body: { error: 'Badge recompute failed', detail: error.message, eventId } };
  }
}

exports.main = main;
