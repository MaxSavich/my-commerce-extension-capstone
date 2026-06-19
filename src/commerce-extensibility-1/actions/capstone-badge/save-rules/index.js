const { Core } = require('@adobe/aio-sdk');
const stateLib = require('@adobe/aio-lib-state');
const { migrateRules, validateRules } = require('../lib/rules');

// ---------------------------------------------------------------------------
// Capstone: save-rules  (WRITE)
// Validates an incoming badge-rules payload and, if valid, persists it to
// I/O State key `badge-rules`. Validation happens HERE (authoritative,
// server-side) -- there is no separate validate action.
//
// AUTH: this is a WRITE action -> require-adobe-auth is TRUE in ext.config.yaml.
// The Adobe platform validates the merchant's IMS token (sent by the Admin UI
// as `Authorization: Bearer <imsToken>` + `x-gw-ims-org-id`) BEFORE this code
// runs; an unauthenticated call never reaches here (401 at the platform layer).
// No in-code token check is needed -- the annotation is the security boundary.
// ---------------------------------------------------------------------------
async function main(params) {
  const logger = Core.Logger('save-rules', { level: params.LOG_LEVEL || 'info' });

  try {
    // Accept rules from JSON body (`rules`) or a stringified `rules` param.
    let incoming = params.rules;
    if (typeof incoming === 'string') {
      try { incoming = JSON.parse(incoming); } catch { incoming = null; }
    }
    if (!incoming) {
      return { statusCode: 400, body: { error: 'Missing or invalid "rules" payload' } };
    }

    // Normalize then validate before writing.
    const rules = migrateRules(incoming);
    const { valid, errors } = validateRules(rules);
    if (!valid) {
      return { statusCode: 400, body: { error: 'Validation failed', errors } };
    }

    const state = await stateLib.init();
    await state.put('badge-rules', JSON.stringify(rules)); // no TTL: rules persist

    logger.info('Saved badge-rules');
    return { statusCode: 200, body: { rules, saved: true } };
  } catch (error) {
    logger.error('save-rules failed:', error.message);
    return { statusCode: 500, body: { error: 'Internal server error', detail: error.message } };
  }
}

exports.main = main;
