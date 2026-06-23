// ---------------------------------------------------------------------------
// Capstone shared badge-rules logic — v3 (dynamic badge list).
//
// Single source of truth for: the rule model, defaults, migration from v1/v2,
// validation (save-rules), badge application (get-badges), and TTL calculation.
//
// KEY CHANGE from v2: badges are no longer a fixed keyed object. They are an
// ORDERED ARRAY of badge instances (`badgeList`). Each instance has a stable
// `id`, a `type` (trigger logic selector), a merchant-editable `label`,
// a `style` (full CSS class name for the PDP), and a `ttlDays` for cache TTL.
// Merchants can add/delete/reorder instances from the Admin UI without any
// code changes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trigger types — code-owned. Controls which rule logic fires for an instance.
// Stock types (outofstock/lastone/lowstock) are mutually exclusive per product.
// ---------------------------------------------------------------------------
const TRIGGER_TYPES = ['new', 'bestseller', 'limited', 'outofstock', 'lastone', 'lowstock'];

// ---------------------------------------------------------------------------
// Default badge list — mirrors the v2 defaults so first-run behaviour is
// identical to what was deployed in Weeks 3–5.
// ---------------------------------------------------------------------------
const DEFAULT_BADGE_LIST = [
  { id: 'new_1',        type: 'new',        label: 'New',          style: 'product_badge_new',     enabled: true, ttlDays: 30, withinDays: 30 },
  { id: 'bestseller_1', type: 'bestseller',  label: 'Best Seller',  style: 'product_badge_default', enabled: true, ttlDays: 30, skus: ['BPG-5005'] },
  { id: 'limited_1',    type: 'limited',     label: 'Limited Offer',style: 'product_badge_sale',    enabled: true, ttlDays: 7,  requireDateWindow: true },
  { id: 'outofstock_1', type: 'outofstock',  label: 'Out of Stock', style: 'product_badge_stock',   enabled: true, ttlDays: 1 },
  { id: 'lastone_1',    type: 'lastone',     label: 'Last One',     style: 'product_badge_stock',   enabled: true, ttlDays: 1 },
  { id: 'lowstock_1',   type: 'lowstock',    label: 'Low Stock',    style: 'product_badge_stock',   enabled: true, ttlDays: 3,  threshold: 10 },
];

const DEFAULT_RULES = {
  version: 3,
  updated_at: new Date(0).toISOString(), // epoch — always stale on first compare
  badgeList: DEFAULT_BADGE_LIST,
};

// ---------------------------------------------------------------------------
// migrateRules — upgrades any saved shape to v3 in memory.
// Called by get-rules (on read) and save-rules (before validate+persist).
// v1 = old flat shape { newWithinDays, bestsellerSkus }
// v2 = keyed badges object { badges: { new: {...}, ... } }
// v3 = ordered array { badgeList: [...] }
// ---------------------------------------------------------------------------
function migrateRules(raw) {
  if (!raw || typeof raw !== 'object') return clone(DEFAULT_RULES);

  // Already v3.
  if (raw.version === 3 && Array.isArray(raw.badgeList)) {
    // Fill any missing common fields with defaults from the matching default entry.
    const badgeList = raw.badgeList.map((item) => {
      const def = DEFAULT_BADGE_LIST.find((d) => d.id === item.id) || {};
      return {
        id: item.id,
        type: item.type || def.type || 'new',
        label: item.label !== undefined ? item.label : (def.label || item.type),
        style: item.style || def.style || 'product_badge_default',
        enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
        ttlDays: (Number.isInteger(item.ttlDays) && item.ttlDays >= 1) ? item.ttlDays : (def.ttlDays || 30),
        ...typeDefaults(item.type, item),
      };
    });
    return {
      version: 3,
      updated_at: raw.updated_at || new Date(0).toISOString(),
      badgeList,
    };
  }

  // v2 — keyed badges object.
  if (raw.version === 2 && raw.badges) {
    const b = raw.badges;
    const badgeList = [];

    if (b.new) badgeList.push({
      id: 'new_1', type: 'new',
      label: b.new.label || 'New',
      style: b.new.style || 'product_badge_new',
      enabled: typeof b.new.enabled === 'boolean' ? b.new.enabled : true,
      ttlDays: 30,
      withinDays: Number.isInteger(b.new.withinDays) ? b.new.withinDays : 30,
    });
    if (b.bestseller) badgeList.push({
      id: 'bestseller_1', type: 'bestseller',
      label: b.bestseller.label || 'Best Seller',
      style: b.bestseller.style || 'product_badge_default',
      enabled: typeof b.bestseller.enabled === 'boolean' ? b.bestseller.enabled : true,
      ttlDays: 30,
      skus: Array.isArray(b.bestseller.skus) ? b.bestseller.skus.slice() : [],
    });
    if (b.limited) badgeList.push({
      id: 'limited_1', type: 'limited',
      label: b.limited.label || 'Limited Offer',
      style: b.limited.style || 'product_badge_sale',
      enabled: typeof b.limited.enabled === 'boolean' ? b.limited.enabled : true,
      ttlDays: 7,
      requireDateWindow: typeof b.limited.requireDateWindow === 'boolean' ? b.limited.requireDateWindow : true,
    });
    if (b.outofstock) badgeList.push({
      id: 'outofstock_1', type: 'outofstock',
      label: b.outofstock.label || 'Out of Stock',
      style: b.outofstock.style || 'product_badge_stock',
      enabled: typeof b.outofstock.enabled === 'boolean' ? b.outofstock.enabled : true,
      ttlDays: 1,
    });
    if (b.lastone) badgeList.push({
      id: 'lastone_1', type: 'lastone',
      label: b.lastone.label || 'Last One',
      style: b.lastone.style || 'product_badge_stock',
      enabled: typeof b.lastone.enabled === 'boolean' ? b.lastone.enabled : true,
      ttlDays: 1,
    });
    if (b.lowstock) badgeList.push({
      id: 'lowstock_1', type: 'lowstock',
      label: b.lowstock.label || 'Low Stock',
      style: b.lowstock.style || 'product_badge_stock',
      enabled: typeof b.lowstock.enabled === 'boolean' ? b.lowstock.enabled : true,
      ttlDays: 3,
      threshold: Number.isInteger(b.lowstock.threshold) ? b.lowstock.threshold : 10,
    });

    return {
      version: 3,
      updated_at: new Date(0).toISOString(),
      badgeList: badgeList.length ? badgeList : clone(DEFAULT_BADGE_LIST),
    };
  }

  // v1 — old flat shape.
  const migrated = clone(DEFAULT_RULES);
  if (typeof raw.newWithinDays === 'number') {
    migrated.badgeList[0].withinDays = raw.newWithinDays;
  }
  if (Array.isArray(raw.bestsellerSkus)) {
    migrated.badgeList[1].skus = raw.bestsellerSkus.slice();
  }
  return migrated;
}

// Fill type-specific defaults when migrating a v3 item that may be missing fields.
function typeDefaults(type, item) {
  switch (type) {
    case 'new':
      return { withinDays: Number.isInteger(item.withinDays) && item.withinDays >= 1 ? item.withinDays : 30 };
    case 'bestseller':
      return { skus: Array.isArray(item.skus) ? item.skus : [] };
    case 'limited':
      return { requireDateWindow: typeof item.requireDateWindow === 'boolean' ? item.requireDateWindow : true };
    case 'lowstock':
      return { threshold: Number.isInteger(item.threshold) && item.threshold >= 2 ? item.threshold : 10 };
    default:
      return {};
  }
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

    if (!TRIGGER_TYPES.includes(item.type)) {
      errors.push(`${prefix}: "type" must be one of: ${TRIGGER_TYPES.join(', ')}`);
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

    // Type-specific checks.
    if (item.type === 'new') {
      if (!Number.isInteger(item.withinDays) || item.withinDays < 1) {
        errors.push(`${prefix}: "withinDays" must be a positive whole number`);
      }
    }
    if (item.type === 'bestseller') {
      if (!Array.isArray(item.skus)) {
        errors.push(`${prefix}: "skus" must be an array`);
      } else if (item.skus.some((s) => typeof s !== 'string' || s.trim() === '')) {
        errors.push(`${prefix}: "skus" must contain only non-empty strings`);
      }
    }
    if (item.type === 'limited') {
      if (typeof item.requireDateWindow !== 'boolean') {
        errors.push(`${prefix}: "requireDateWindow" must be true or false`);
      }
    }
    if (item.type === 'lowstock') {
      if (!Number.isInteger(item.threshold) || item.threshold < 2) {
        errors.push(`${prefix}: "threshold" must be an integer >= 2`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// applyBadgeRules — iterate badgeList, dispatch on type, return matched IDs.
// Stock types are mutually exclusive: highest-priority match wins per product.
// ---------------------------------------------------------------------------
function applyBadgeRules(product, badgeList, sku) {
  const matched = [];

  // Track whether a stock badge has already fired (mutual exclusion).
  let stockBadgeFired = false;
  const qty = getStockQty(product);

  for (const item of badgeList) {
    if (!item.enabled) continue;

    switch (item.type) {
      case 'new': {
        const createdMs = parseCommerceDate(product.created_at);
        if (!Number.isNaN(createdMs)) {
          const ageDays = (Date.now() - createdMs) / 86_400_000;
          if (ageDays <= item.withinDays) matched.push(item.id);
        }
        break;
      }
      case 'bestseller': {
        const skus = Array.isArray(item.skus) ? item.skus : [];
        if (skus.includes(sku)) matched.push(item.id);
        break;
      }
      case 'limited': {
        const specialPrice = parseFloat(getAttr(product, 'special_price'));
        if (!Number.isNaN(specialPrice) && specialPrice > 0) {
          if (!item.requireDateWindow) {
            matched.push(item.id);
          } else {
            const now = Date.now();
            const fromMs = parseCommerceDate(getAttr(product, 'special_from_date'));
            const toMs = parseCommerceDate(getAttr(product, 'special_to_date'));
            const fromOk = Number.isNaN(fromMs) || fromMs <= now;
            const toOk = Number.isNaN(toMs) || toMs >= now;
            if (fromOk && toOk) matched.push(item.id);
          }
        }
        break;
      }
      case 'outofstock': {
        if (!stockBadgeFired && !Number.isNaN(qty) && qty === 0) {
          matched.push(item.id);
          stockBadgeFired = true;
        }
        break;
      }
      case 'lastone': {
        if (!stockBadgeFired && !Number.isNaN(qty) && qty === 1) {
          matched.push(item.id);
          stockBadgeFired = true;
        }
        break;
      }
      case 'lowstock': {
        if (!stockBadgeFired && !Number.isNaN(qty) && qty > 1 && qty < item.threshold) {
          matched.push(item.id);
          stockBadgeFired = true;
        }
        break;
      }
      default:
        break;
    }
  }

  return matched;
}

// ---------------------------------------------------------------------------
// computeTtlSeconds — given the matched badge IDs and the full badgeList,
// return the TTL in seconds to use when writing badge_<sku> to State.
// Uses min(ttlDays of matched badges), falls back to 30 days if none matched.
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
  TRIGGER_TYPES,
  DEFAULT_RULES,
  DEFAULT_BADGE_LIST,
  migrateRules,
  validateRules,
  applyBadgeRules,
  computeTtlSeconds,
};
