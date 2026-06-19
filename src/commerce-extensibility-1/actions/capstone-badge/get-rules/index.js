const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { DEFAULT_RULES, migrateRules } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: get-rules  (READ)
// Returns the merchant badge-rules from I/O State key `badge-rules`, migrated
// to the current model. If none are saved yet, returns DEFAULT_RULES.
//
// AUTH: this is a READ action -> require-adobe-auth is FALSE in ext.config.yaml
// (same posture as the course get-enriched-orders read). Reading rules is not
// sensitive; the write path (save-rules) is the one that requires auth.
// ---------------------------------------------------------------------------
async function main(params) {
  const logger = Core.Logger('get-rules', { level: params.LOG_LEVEL || 'info' });

  try {
    const state = await stateLib.init();

    let raw = null;
    try {
      const res = await state.get('badge-rules');
      if (res && res.value) raw = JSON.parse(res.value);
    } catch (e) {
      logger.info(`No badge-rules in State yet: ${e.message}`);
    }

    const rules = raw ? migrateRules(raw) : DEFAULT_RULES;
    const isDefault = !raw;

    return { statusCode: 200, body: { rules, isDefault } };
  } catch (error) {
    logger.error('get-rules failed:', error.message);
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
