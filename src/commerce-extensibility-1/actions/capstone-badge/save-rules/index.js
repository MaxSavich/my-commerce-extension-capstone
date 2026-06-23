const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { migrateRules, validateRules } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: save-rules  (WRITE)
// Validates an incoming badge-rules payload and, if valid, persists it to
// I/O State key `badge-rules` with a fresh `updated_at` timestamp.
//
// The updated_at timestamp is the invalidation signal: get-badges compares
// rules.updated_at against badge_<sku>.computed_at on every PDP request.
// When rules are newer, get-badges recomputes inline automatically.
//
// AUTH: WRITE action -> require-adobe-auth is TRUE in ext.config.yaml.
// The Adobe platform validates the merchant's IMS token before this code runs.
// ---------------------------------------------------------------------------

async function main(params) {
  const logger = Core.Logger('save-rules', { level: params.LOG_LEVEL || 'info' });
  const startMs = Date.now();

  try {
    let incoming = params.rules;
    if (typeof incoming === 'string') {
      try { incoming = JSON.parse(incoming); } catch { incoming = null; }
    }
    if (!incoming) {
      return { statusCode: 400, body: { error: 'Missing or invalid "rules" payload' } };
    }

    // Migrate to v3 then validate.
    const rules = migrateRules(incoming);
    const { valid, errors } = validateRules(rules);
    if (!valid) {
      logger.warn(JSON.stringify({
        action: 'save-rules', message: 'Validation failed',
        errors, durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
      }));
      return { statusCode: 400, body: { error: 'Validation failed', errors } };
    }

    // Stamp updated_at so get-badges can detect staleness.
    rules.updated_at = new Date().toISOString();

    const state = await stateLib.init();
    await state.put('badge-rules', JSON.stringify(rules)); // no TTL: rules persist indefinitely

    logger.info(JSON.stringify({
      action: 'save-rules', message: 'Badge rules saved',
      badgeCount: rules.badgeList.length,
      updated_at: rules.updated_at,
      durationMs: Date.now() - startMs, timestamp: new Date().toISOString(),
    }));

    return { statusCode: 200, body: { rules, saved: true } };
  } catch (error) {
    logger.error(JSON.stringify({
      action: 'save-rules', message: 'Action failed',
      error: error.message, durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    }));
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
