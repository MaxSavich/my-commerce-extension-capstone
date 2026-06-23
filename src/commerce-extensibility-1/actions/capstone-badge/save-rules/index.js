const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { migrateRules, validateRules } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: save-rules  (WRITE)
// Validates an incoming badge-rules payload and, if valid, persists it to
// I/O State key `badge-rules`.
//
// AUTH: WRITE action -> require-adobe-auth is TRUE in ext.config.yaml.
// The Adobe platform validates the merchant's IMS token before this code runs.
// An unauthenticated call never reaches here (401 at the platform layer).
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

    const rules = migrateRules(incoming);
    const { valid, errors } = validateRules(rules);
    if (!valid) {
      logger.warn(JSON.stringify({
        action: 'save-rules', message: 'Validation failed',
        errors, durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      }));
      return { statusCode: 400, body: { error: 'Validation failed', errors } };
    }

    const state = await stateLib.init();
    await state.put('badge-rules', JSON.stringify(rules)); // no TTL: rules persist

    logger.info(JSON.stringify({
      action: 'save-rules', message: 'Badge rules saved',
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
