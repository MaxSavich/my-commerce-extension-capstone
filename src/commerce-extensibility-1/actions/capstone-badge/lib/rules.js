// ---------------------------------------------------------------------------
// Capstone shared badge-rules logic — v4 (unified attribute-rule model).
//
// EVERY badge is the SAME shape: a merchant-defined rule built from conditions
// on product attributes. There are NO hardcoded trigger types. A badge is:
//
//   {
//     id, enabled, label, style, ttlDays,
//     match: 'all' | 'any',
//     conditions: [ { field, op, value }, ... ]
//   }
//
// `field`  = any product attribute code (price, qty, created_at, special_price,
//            sku, or any custom_attribute code like material/brand).
// `value`  = the comparison value (string; numbers/dates coerced as needed).
//
// Operators:
//   >  >=  <  <=            numeric comparison
//   =  !=                   equals / not-equals (numeric or case-insensitive string)
//   contains               substring (case-insensitive)
//   in                     attribute equals ANY item in a comma-separated list
//   not_in                 attribute equals NONE of a comma-separated list
//   between                range "min|max", INCLUSIVE, open-ended ok
//                          ("100|" => >=100, "|200" => <=200). Polymorphic:
//                          if the attribute value and bounds parse as DATES it
//                          compares as dates (e.g. created_at between
//                          "2026-01-01|2026-06-30"); otherwise as numbers
//                          (e.g. price between "100|200"). Pure-numeric ranges
//                          may also use a dash: "100-200".
//   within_days            field's date is within <value> days of now (recent past)
//   date_reached           field's date is now-or-earlier (started). Empty = reached.
//   date_not_passed        field's date is now-or-later (not ended). Empty = not passed.
//   date_window_active     news_from reached AND news_to not passed (Commerce
//                          "Set Product as New" window active — NOW between two
//                          product attributes). `value` may override field names
//                          as "from|to". This is distinct from `between`, which
//                          tests one attribute against two literal bounds.
//
// Single source of truth for: model, defaults, migration (v1/v2/v3 -> v4),
// validation (save-rules), application (get-badges), and TTL calculation.
// ---------------------------------------------------------------------------

// Operators usable in a condition.
const CONDITION_OPS = [
  '>', '>=', '<', '<=', '=', '!=', 'contains', 'in', 'not_in', 'between',
  'within_days', 'date_reached', 'date_not_passed', 'date_window_active',
];

// Operators that don't need a user-entered value (value is optional/ignored).
const VALUELESS_OPS = ['date_reached', 'date_not_passed', 'date_window_active'];

// ---------------------------------------------------------------------------
// Default badge list — the classic six, expressed as attribute rules so they
// are fully editable in the Admin UI. First-run behaviour mirrors the old
// hardcoded defaults.
//
// New Arrival fires when recently created OR the "Set Product as New" window is
// active. Best Seller uses a single `in` list condition.
// ---------------------------------------------------------------------------
const DEFAULT_BADGE_LIST = [
  {
    id: 'new_1', enabled: true, label: 'New Arrival', style: 'product_badge_new', ttlDays: 30,
    match: 'any',
    conditions: [
      { field: 'created_at', op: 'within_days', value: '30' },
      { field: 'news_from_date', op: 'date_window_active', value: '' },
    ],
  },
  {
    id: 'bestseller_1', enabled: true, label: 'Best Seller', style: 'product_badge_default', ttlDays: 30,
    match: 'all', conditions: [{ field: 'sku', op: 'in', value: 'BPG-5005' }],
  },
  {
    id: 'limited_1', enabled: true, label: 'Limited Offer', style: 'product_badge_sale', ttlDays: 7,
    match: 'all', conditions: [{ field: 'special_price', op: '>', value: '0' }],
  },
  {
    id: 'lowstock_1', enabled: true, label: 'Low Stock', style: 'product_badge_stock', ttlDays: 3,
    match: 'all', conditions: [{ field: 'qty', op: '<', value: '10' }, { field: 'qty', op: '>', value: '0' }],
  },
  {
    id: 'lastone_1', enabled: true, label: 'Last One', style: 'product_badge_stock', ttlDays: 1,
    match: 'all', conditions: [{ field: 'qty', op: '=', value: '1' }],
  },
  {
    id: 'outofstock_1', enabled: true, label: 'Out of Stock', style: 'product_badge_stock', ttlDays: 1,
    match: 'all', conditions: [{ field: 'qty', op: '=', value: '0' }],
  },
];

const DEFAULT_RULES = {
  version: 4,
  updated_at: new Date(0).toISOString(), // epoch — always stale on first compare
  badgeList: DEFAULT_BADGE_LIST,
};

// ---------------------------------------------------------------------------
// Convert one OLD typed badge (v3 or v2-shaped item) into v4 conditions.
// Returns { match, conditions } for the equivalent attribute rule.
// ---------------------------------------------------------------------------
function conditionsForLegacyType(item) {
  const type = item.type;
  switch (type) {
    case 'new':
      return {
        match: 'any',
        conditions: [
          { field: 'created_at', op: 'within_days', value: String(item.withinDays ?? 30) },
          { field: 'news_from_date', op: 'date_window_active', value: '' },
        ],
      };
    case 'bestseller': {
      const skus = Array.isArray(item.skus) ? item.skus : [];
      // Collapse the SKU list into a single `in` condition.
      return { match: 'all', conditions: [{ field: 'sku', op: 'in', value: skus.join(',') }] };
    }
    case 'limited':
      return { match: 'all', conditions: [{ field: 'special_price', op: '>', value: '0' }] };
    case 'lowstock':
      return {
        match: 'all',
        conditions: [
          { field: 'qty', op: '<', value: String(item.threshold ?? 10) },
          { field: 'qty', op: '>', value: '0' },
        ],
      };
    case 'lastone':
      return { match: 'all', conditions: [{ field: 'qty', op: '=', value: '1' }] };
    case 'outofstock':
      return { match: 'all', conditions: [{ field: 'qty', op: '=', value: '0' }] };
    default:
      return { match: 'all', conditions: [] };
  }
}

// Normalise a single condition to { field, op, value } strings.
function normalizeCondition(c) {
  return {
    field: typeof c?.field === 'string' ? c.field.trim() : '',
    op: typeof c?.op === 'string' ? c.op.trim() : '=',
    value: c?.value === undefined || c?.value === null ? '' : String(c.value),
  };
}

// Coerce a raw badge object (any version's item) into a clean v4 badge.
function normalizeBadge(item, fallbackId) {
  const id = (typeof item.id === 'string' && item.id.trim()) ? item.id : fallbackId;
  const label = typeof item.label === 'string' && item.label.trim() ? item.label : 'Badge';
  const style = typeof item.style === 'string' && item.style.trim() ? item.style : 'product_badge_default';
  const enabled = typeof item.enabled === 'boolean' ? item.enabled : true;
  const ttlDays = (Number.isInteger(item.ttlDays) && item.ttlDays >= 1) ? item.ttlDays : 7;

  // Already v4 (has conditions) -> keep them. Otherwise convert from legacy type.
  let match;
  let conditions;
  if (Array.isArray(item.conditions)) {
    match = item.match === 'any' ? 'any' : 'all';
    conditions = item.conditions.map(normalizeCondition);
  } else {
    const legacy = conditionsForLegacyType(item);
    match = legacy.match;
    conditions = legacy.conditions.map(normalizeCondition);
  }

  return { id, enabled, label, style, ttlDays, match, conditions };
}

// ---------------------------------------------------------------------------
// migrateRules — upgrades any saved shape to v4 in memory.
// v1 = old flat shape { newWithinDays, bestsellerSkus }
// v2 = keyed badges object { badges: { new: {...}, ... } }
// v3 = ordered array of typed badges { badgeList: [{type,...}] }
// v4 = ordered array of attribute-rule badges { badgeList: [{match,conditions}] }
// ---------------------------------------------------------------------------
function migrateRules(raw) {
  if (!raw || typeof raw !== 'object') return clone(DEFAULT_RULES);

  // v3 or v4 — ordered array. normalizeBadge handles both (converts typed -> conditions).
  if (Array.isArray(raw.badgeList)) {
    const badgeList = raw.badgeList.map((item, i) => normalizeBadge(item, `badge_${i + 1}`));
    return {
      version: 4,
      updated_at: raw.updated_at || new Date(0).toISOString(),
      badgeList: badgeList.length ? badgeList : clone(DEFAULT_BADGE_LIST),
    };
  }

  // v2 — keyed badges object. Convert each present key via its legacy type.
  if (raw.version === 2 && raw.badges) {
    const b = raw.badges;
    const order = ['new', 'bestseller', 'limited', 'outofstock', 'lastone', 'lowstock'];
    const badgeList = [];
    for (const type of order) {
      if (!b[type]) continue;
      badgeList.push(normalizeBadge({ ...b[type], id: `${type}_1`, type }, `${type}_1`));
    }
    return {
      version: 4,
      updated_at: new Date(0).toISOString(),
      badgeList: badgeList.length ? badgeList : clone(DEFAULT_BADGE_LIST),
    };
  }

  // v1 — old flat shape.
  const migrated = clone(DEFAULT_RULES);
  if (typeof raw.newWithinDays === 'number') {
    migrated.badgeList[0].conditions[0].value = String(raw.newWithinDays);
  }
  if (Array.isArray(raw.bestsellerSkus)) {
    migrated.badgeList[1].conditions = [{ field: 'sku', op: 'in', value: raw.bestsellerSkus.join(',') }];
    migrated.badgeList[1].match = 'all';
  }
  return migrated;
}

// ---------------------------------------------------------------------------
// validateRules — server-side check used by save-rules before persisting.
// Returns { valid: bool, errors: string[] }.
// ---------------------------------------------------------------------------
function validateRules(rules) {
  if (!rules || typeof rules !== 'object') {
    return { valid: false, errors: ['Rules must be an object'] };
  }
  if (!Array.isArray(rules.badgeList)) {
    return { valid: false, errors: ['Rules must contain a "badgeList" array'] };
  }
  if (rules.badgeList.length === 0) {
    return { valid: false, errors: ['"badgeList" must not be empty'] };
  }

  const errors = [];
  const seenIds = new Set();

  for (let i = 0; i < rules.badgeList.length; i++) {
    const item = rules.badgeList[i];
    const prefix = `badgeList[${i}]`;

    if (!item.id || typeof item.id !== 'string' || item.id.trim() === '') {
      errors.push(`${prefix}: "id" must be a non-empty string`);
    } else if (seenIds.has(item.id)) {
      errors.push(`${prefix}: duplicate id "${item.id}"`);
    } else {
      seenIds.add(item.id);
    }

    if (typeof item.label !== 'string' || item.label.trim() === '') {
      errors.push(`${prefix}: "label" must be a non-empty string`);
    }
    if (typeof item.style !== 'string' || item.style.trim() === '') {
      errors.push(`${prefix}: "style" must be a non-empty string`);
    }
    if (typeof item.enabled !== 'boolean') {
      errors.push(`${prefix}: "enabled" must be true or false`);
    }
    if (!Number.isInteger(item.ttlDays) || item.ttlDays < 1) {
      errors.push(`${prefix}: "ttlDays" must be a positive whole number`);
    }
    if (item.match !== 'all' && item.match !== 'any') {
      errors.push(`${prefix}: "match" must be "all" or "any"`);
    }
    if (!Array.isArray(item.conditions) || item.conditions.length === 0) {
      errors.push(`${prefix}: add at least one condition`);
    } else {
      item.conditions.forEach((c, ci) => {
        const cp = `${prefix}.conditions[${ci}]`;
        if (!c || typeof c.field !== 'string' || c.field.trim() === '') {
          errors.push(`${cp}: "field" must be a non-empty attribute code`);
        }
        if (!CONDITION_OPS.includes(c?.op)) {
          errors.push(`${cp}: "op" must be one of: ${CONDITION_OPS.join(', ')}`);
        }
        // Valueless operators don't require a value; all others do.
        if (!VALUELESS_OPS.includes(c?.op)
            && (c?.value === undefined || c?.value === null || String(c.value).trim() === '')) {
          errors.push(`${cp}: "value" must not be empty`);
        }
        // between needs at least one bound (numeric OR date).
        if (c?.op === 'between') {
          const { lo, hi } = splitRange(c.value);
          const hasLo = lo !== '' && (isNumeric(lo) || isDateLike(lo));
          const hasHi = hi !== '' && (isNumeric(hi) || isDateLike(hi));
          if (!hasLo && !hasHi) {
            errors.push(`${cp}: "between" needs a min and/or max, e.g. "100|200", "100|", "|200", or dates "2026-01-01|2026-06-30"`);
          }
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

// Is this string a plain number?
function isNumeric(s) {
  const t = String(s ?? '').trim();
  return t !== '' && !Number.isNaN(Number(t));
}

// Does this string look like a date (has a date separator and parses)?
function isDateLike(s) {
  const t = String(s ?? '').trim();
  if (t === '') return false;
  // Must contain a date-ish separator so bare numbers don't count as dates.
  if (!/[-/T: ]/.test(t)) return false;
  return !Number.isNaN(parseCommerceDate(t));
}

// Split a range string into raw side strings { lo, hi }.
// Prefers "|". Falls back to "-" ONLY for pure numeric ranges (so date strings
// like "2026-01-01" are never split on their internal dashes).
function splitRange(value) {
  const s = String(value ?? '').trim();
  if (s.includes('|')) {
    const [lo, hi] = s.split('|');
    return { lo: (lo || '').trim(), hi: (hi || '').trim() };
  }
  // No pipe: only treat "-" as a separator for numeric a-b (not dates, not leading negative).
  if (s.includes('-') && !s.startsWith('-') && !isDateLike(s)) {
    const [lo, hi] = s.split('-');
    return { lo: (lo || '').trim(), hi: (hi || '').trim() };
  }
  // Single value = lower bound only.
  return { lo: s, hi: '' };
}

// Parse a "min|max" range string into { min, max } NUMBERS (null = open side).
// Used for numeric between and by external callers/tests.
function parseRange(value) {
  const { lo, hi } = splitRange(value);
  const min = isNumeric(lo) ? Number(lo) : null;
  const max = isNumeric(hi) ? Number(hi) : null;
  return { min, max };
}

// Split a comma-separated list value into trimmed, lowercased, non-empty items.
function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

// ---------------------------------------------------------------------------
// evalBetween — polymorphic range check. Compares as DATES when the attribute
// value and at least one bound look like dates; otherwise as NUMBERS.
// Bounds are inclusive; either side may be open.
// ---------------------------------------------------------------------------
function evalBetween(raw, value) {
  const { lo, hi } = splitRange(value);
  const loGiven = lo !== '';
  const hiGiven = hi !== '';
  if (!loGiven && !hiGiven) return false; // need at least one bound

  // Decide date vs numeric: prefer dates if the bounds/value are date-like.
  const boundsLookDate = (loGiven && isDateLike(lo)) || (hiGiven && isDateLike(hi));
  const valueLooksDate = isDateLike(raw);

  if (boundsLookDate || (valueLooksDate && !isNumeric(String(raw).trim()))) {
    // DATE comparison.
    const v = parseCommerceDate(raw);
    if (Number.isNaN(v)) return false;
    const loMs = loGiven ? parseCommerceDate(lo) : NaN;
    const hiMs = hiGiven ? parseCommerceDate(hi) : NaN;
    if (loGiven && !Number.isNaN(loMs) && v < loMs) return false;
    if (hiGiven && !Number.isNaN(hiMs) && v > hiMs) return false;
    // If a given bound failed to parse as a date, treat the range as unsatisfied.
    if (loGiven && Number.isNaN(loMs) && !isNumeric(lo)) return false;
    if (hiGiven && Number.isNaN(hiMs) && !isNumeric(hi)) return false;
    return true;
  }

  // NUMERIC comparison.
  const num = parseFloat(raw);
  if (Number.isNaN(num)) return false;
  const min = isNumeric(lo) ? Number(lo) : null;
  const max = isNumeric(hi) ? Number(hi) : null;
  if (min === null && max === null) return false;
  if (min !== null && num < min) return false;
  if (max !== null && num > max) return false;
  return true;
}

// ---------------------------------------------------------------------------
// evalCondition — evaluate one { field, op, value } against a product.
// ---------------------------------------------------------------------------
function evalCondition(product, sku, cond) {
  const { field, op, value } = cond;
  if (!field && op !== 'date_window_active') return false;

  // --- Date-window operator: news_from reached AND news_to not passed. -----
  if (op === 'date_window_active') {
    let fromField = 'news_from_date';
    let toField = 'news_to_date';
    if (typeof value === 'string' && value.includes('|')) {
      const parts = value.split('|');
      if (parts[0].trim()) fromField = parts[0].trim();
      if (parts[1] && parts[1].trim()) toField = parts[1].trim();
    } else if (field) {
      fromField = field;
    }
    const now = Date.now();
    const fromMs = parseCommerceDate(getAttr(product, fromField));
    const toMs = parseCommerceDate(getAttr(product, toField));
    const fromOk = Number.isNaN(fromMs) || fromMs <= now;   // empty/missing = reached
    const toOk = Number.isNaN(toMs) || toMs >= now;          // empty/missing = not passed
    return fromOk && toOk;
  }

  let raw = field === 'sku' ? sku : getAttr(product, field);
  if ((raw === undefined || raw === null) && field === 'qty') raw = getStockQty(product);

  // --- List membership. ----------------------------------------------------
  if (op === 'in' || op === 'not_in') {
    const list = parseList(value);
    const member = raw !== undefined && raw !== null && list.includes(String(raw).trim().toLowerCase());
    return op === 'in' ? member : !member;
  }

  // --- Range (numbers OR dates). -------------------------------------------
  if (op === 'between') {
    if (raw === undefined || raw === null) return false;
    return evalBetween(raw, value);
  }

  // --- Single-date operators relative to now. ------------------------------
  if (op === 'date_reached') {
    const ms = parseCommerceDate(raw);
    return Number.isNaN(ms) ? true : ms <= Date.now(); // empty = reached
  }
  if (op === 'date_not_passed') {
    const ms = parseCommerceDate(raw);
    return Number.isNaN(ms) ? true : ms >= Date.now(); // empty = not passed
  }

  if (op === 'within_days') {
    const ms = parseCommerceDate(raw);
    if (Number.isNaN(ms)) return false;
    const days = Number(value);
    if (Number.isNaN(days)) return false;
    const ageDays = (Date.now() - ms) / 86_400_000;
    return ageDays <= days;
  }

  if (op === 'contains') {
    if (raw === undefined || raw === null) return false;
    return String(raw).toLowerCase().includes(String(value).toLowerCase());
  }

  const numA = parseFloat(raw);
  const numB = parseFloat(value);
  const numeric = !Number.isNaN(numA) && !Number.isNaN(numB);

  switch (op) {
    case '>':  return numeric && numA > numB;
    case '>=': return numeric && numA >= numB;
    case '<':  return numeric && numA < numB;
    case '<=': return numeric && numA <= numB;
    case '=':
      return numeric ? numA === numB : String(raw ?? '').toLowerCase() === String(value).toLowerCase();
    case '!=':
      return numeric ? numA !== numB : String(raw ?? '').toLowerCase() !== String(value).toLowerCase();
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// applyBadgeRules — iterate badgeList, evaluate each badge's conditions,
// return matched IDs (in list order = PDP display priority).
// ---------------------------------------------------------------------------
function applyBadgeRules(product, badgeList, sku) {
  const matched = [];
  for (const item of badgeList) {
    if (!item.enabled) continue;
    const conditions = Array.isArray(item.conditions) ? item.conditions : [];
    if (conditions.length === 0) continue;
    const results = conditions.map((c) => evalCondition(product, sku, normalizeCondition(c)));
    const ok = item.match === 'any' ? results.some(Boolean) : results.every(Boolean);
    if (ok) matched.push(item.id);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// computeTtlSeconds — min(ttlDays of matched badges), fallback 30 days.
// ---------------------------------------------------------------------------
function computeTtlSeconds(matchedIds, badgeList) {
  if (!matchedIds || matchedIds.length === 0) return 30 * 86400;
  const idSet = new Set(matchedIds);
  let minDays = Infinity;
  for (const item of badgeList) {
    if (idSet.has(item.id) && Number.isInteger(item.ttlDays) && item.ttlDays >= 1) {
      if (item.ttlDays < minDays) minDays = item.ttlDays;
    }
  }
  return (minDays === Infinity ? 30 : minDays) * 86400;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getAttr(product, code) {
  if (product == null) return undefined;
  if (product[code] !== undefined) return product[code];
  const ca = Array.isArray(product.custom_attributes) ? product.custom_attributes : [];
  const found = ca.find((a) => a && a.attribute_code === code);
  return found ? found.value : undefined;
}

function parseCommerceDate(raw) {
  if (!raw) return NaN;
  return new Date(`${String(raw).trim().replace(' ', 'T')}Z`).getTime();
}

function getStockQty(product) {
  if (product == null) return NaN;
  const ea = product.extension_attributes;
  const si = ea && ea.stock_item;
  if (si && si.qty !== undefined && si.qty !== null) return Number(si.qty);
  return NaN;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  CONDITION_OPS,
  VALUELESS_OPS,
  DEFAULT_RULES,
  DEFAULT_BADGE_LIST,
  migrateRules,
  validateRules,
  applyBadgeRules,
  computeTtlSeconds,
};
