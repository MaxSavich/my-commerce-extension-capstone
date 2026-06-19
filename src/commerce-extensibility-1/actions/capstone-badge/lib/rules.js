// ---------------------------------------------------------------------------
// Capstone shared badge-rules logic.
// Single source of truth for: the rule model, defaults, migration from the old
// flat shape, validation (used by save-rules), and badge application (used by
// compute-badges). Keeping this in one file means the Admin UI write path and
// the compute path can never drift apart.
// ---------------------------------------------------------------------------

// Expanded, merchant-editable rule model (Week 5).
// Each badge type can be enabled/disabled, relabelled, and tuned.
const DEFAULT_RULES = {
  version: 2,
  badges: {
    new: { enabled: true, label: 'New', withinDays: 30 },
    bestseller: { enabled: true, label: 'Best Seller', skus: ['BPG-5005'] },
    limited: { enabled: true, label: 'Limited Offer', requireDateWindow: true },
    outofstock: { enabled: true, label: 'Out of Stock' },
    lastone: { enabled: true, label: 'Last One' },
    lowstock: { enabled: true, label: 'Low Stock', threshold: 10 },
  },
};

// Badge types in priority order. The stock badges are mutually exclusive and
// evaluated in this order: Out of Stock (qty 0) -> Last One (qty 1) ->
// Low Stock (1 < qty < threshold). So a product is only ever one of them.
const BADGE_TYPES = ['new', 'bestseller', 'limited', 'outofstock', 'lastone', 'lowstock'];

// Accept the old flat shape ({ newWithinDays, bestsellerSkus }) written before
// Week 5 and map it onto the expanded model, so existing State never breaks.
function migrateRules(raw) {
  if (!raw || typeof raw !== 'object') return clone(DEFAULT_RULES);

  // Already in the new shape.
  if (raw.version === 2 && raw.badges) {
    return {
      version: 2,
      badges: {
        new: { ...DEFAULT_RULES.badges.new, ...(raw.badges.new || {}) },
        bestseller: { ...DEFAULT_RULES.badges.bestseller, ...(raw.badges.bestseller || {}) },
        limited: { ...DEFAULT_RULES.badges.limited, ...(raw.badges.limited || {}) },
        outofstock: { ...DEFAULT_RULES.badges.outofstock, ...(raw.badges.outofstock || {}) },
        lastone: { ...DEFAULT_RULES.badges.lastone, ...(raw.badges.lastone || {}) },
        lowstock: { ...DEFAULT_RULES.badges.lowstock, ...(raw.badges.lowstock || {}) },
      },
    };
  }

  // Old flat shape -> new model.
  const migrated = clone(DEFAULT_RULES);
  if (typeof raw.newWithinDays === 'number') {
    migrated.badges.new.withinDays = raw.newWithinDays;
  }
  if (Array.isArray(raw.bestsellerSkus)) {
    migrated.badges.bestseller.skus = raw.bestsellerSkus.slice();
  }
  return migrated;
}

// Validate a rules object. Returns { valid, errors[] }. Used by save-rules
// before persisting (authoritative server-side check).
function validateRules(rules) {
  const errors = [];
  if (!rules || typeof rules !== 'object') {
    return { valid: false, errors: ['Rules must be an object'] };
  }
  const badges = rules.badges;
  if (!badges || typeof badges !== 'object') {
    return { valid: false, errors: ['Rules must contain a "badges" object'] };
  }

  for (const type of BADGE_TYPES) {
    const b = badges[type];
    if (!b || typeof b !== 'object') {
      errors.push(`Missing config for badge "${type}"`);
      continue;
    }
    if (typeof b.enabled !== 'boolean') {
      errors.push(`"${type}.enabled" must be true or false`);
    }
    if (typeof b.label !== 'string' || b.label.trim() === '') {
      errors.push(`"${type}.label" must be a non-empty string`);
    }
  }

  // New: withinDays must be a positive integer.
  const nd = badges.new && badges.new.withinDays;
  if (!Number.isInteger(nd) || nd <= 0) {
    errors.push('"new.withinDays" must be a positive whole number');
  }

  // Best Seller: skus must be an array of non-empty strings.
  const skus = badges.bestseller && badges.bestseller.skus;
  if (!Array.isArray(skus)) {
    errors.push('"bestseller.skus" must be an array');
  } else if (skus.some((s) => typeof s !== 'string' || s.trim() === '')) {
    errors.push('"bestseller.skus" must contain only non-empty SKU strings');
  }

  // Limited: requireDateWindow must be a boolean.
  const rdw = badges.limited && badges.limited.requireDateWindow;
  if (typeof rdw !== 'boolean') {
    errors.push('"limited.requireDateWindow" must be true or false');
  }

  // Low Stock: threshold must be a positive integer.
  const lt = badges.lowstock && badges.lowstock.threshold;
  if (!Number.isInteger(lt) || lt <= 0) {
    errors.push('"lowstock.threshold" must be a positive whole number');
  }

  return { valid: errors.length === 0, errors };
}

// ---- badge application (compute-badges uses this) ----

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

// Read the inventory quantity from the Commerce product payload.
// On ACCS, /V1/products/{sku} returns it at extension_attributes.stock_item.qty
// (verified against the live sandbox). Returns a number, or NaN if unavailable.
function getStockQty(product) {
  if (product == null) return NaN;
  const ea = product.extension_attributes;
  const si = ea && ea.stock_item;
  if (si && si.qty !== undefined && si.qty !== null) {
    return Number(si.qty);
  }
  return NaN;
}

// Apply the (migrated) rules to a product, returning the list of badge keys.
function applyBadgeRules(product, rules, sku) {
  const badges = [];
  const b = rules.badges;

  // NEW
  if (b.new.enabled) {
    const createdMs = parseCommerceDate(product.created_at);
    if (!Number.isNaN(createdMs)) {
      const ageDays = (Date.now() - createdMs) / 86_400_000;
      if (ageDays <= b.new.withinDays) badges.push('new');
    }
  }

  // BEST SELLER (merchant-configured SKU list)
  if (b.bestseller.enabled) {
    const skus = Array.isArray(b.bestseller.skus) ? b.bestseller.skus : [];
    if (skus.includes(sku)) badges.push('bestseller');
  }

  // LIMITED OFFER (active special_price; date window optional per rule)
  if (b.limited.enabled) {
    const specialPrice = parseFloat(getAttr(product, 'special_price'));
    if (!Number.isNaN(specialPrice) && specialPrice > 0) {
      if (!b.limited.requireDateWindow) {
        badges.push('limited');
      } else {
        const now = Date.now();
        const fromMs = parseCommerceDate(getAttr(product, 'special_from_date'));
        const toMs = parseCommerceDate(getAttr(product, 'special_to_date'));
        const fromOk = Number.isNaN(fromMs) || fromMs <= now;
        const toOk = Number.isNaN(toMs) || toMs >= now;
        if (fromOk && toOk) badges.push('limited');
      }
    }
  }

  // STOCK: mutually-exclusive, evaluated by priority. Out of Stock (qty 0) ->
  // Last One (qty 1) -> Low Stock (1 < qty < threshold). All read
  // extension_attributes.stock_item.qty.
  const qty = getStockQty(product);
  if (!Number.isNaN(qty)) {
    if (b.outofstock.enabled && qty === 0) {
      badges.push('outofstock');
    } else if (b.lastone.enabled && qty === 1) {
      badges.push('lastone');
    } else if (b.lowstock.enabled && qty > 1 && qty < b.lowstock.threshold) {
      badges.push('lowstock');
    }
  }

  return badges;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

module.exports = {
  DEFAULT_RULES,
  migrateRules,
  validateRules,
  applyBadgeRules,
};
