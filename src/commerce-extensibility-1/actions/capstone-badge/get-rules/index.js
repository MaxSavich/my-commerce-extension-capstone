const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { DEFAULT_RULES, migrateRules } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: get-rules  (READ)
// Returns the merchant badge-rules from I/O State key `badge-rules`, migrated
// to the current model. If none are saved yet, returns DEFAULT_RULES.
//
// AUTH: READ action -> require-adobe-auth is FALSE in ext.config.yaml.
// The write path (save-rules) is the security boundary.
// ---------------------------------------------------------------------------

async function main(params) {
  const logger = Core.Logger('get-rules', { level: params.LOG_LEVEL || 'info' });
  const startMs = Date.now();

  try {
    const state = await stateLib.init();

    let raw = null;
    try {
      const res = await state.get('badge-rules');
      if (res && res.value) raw = JSON.parse(res.value);
    } catch (e) {
      logger.info(JSON.stringify({
        action: 'get-rules', message: 'No badge-rules in State yet',
        error: e.message, durationMs: Date.now() - startMs,
        timestamp: new Date().toISOString(),
      }));
    }

    const rules = raw ? migrateRules(raw) : DEFAULT_RULES;
    const isDefault = !raw;

    logger.info(JSON.stringify({
      action: 'get-rules', message: 'Rules retrieved',
      isDefault, durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    }));

    return { statusCode: 200, body: { rules, isDefault } };
  } catch (error) {
    logger.error(JSON.stringify({
      action: 'get-rules', message: 'Action failed',
      error: error.message, durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
    }));
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
