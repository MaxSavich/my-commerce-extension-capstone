import React, {
  useEffect, useState, useCallback, useRef,
} from 'react';
import { attach } from '@adobe/uix-guest';
import { extensionId } from './Constants';
import {
  Provider,
  defaultTheme,
  View,
  Heading,
  Text,
  Flex,
  ProgressCircle,
  Well,
  Switch,
  TextField,
  NumberField,
  Button,
  ButtonGroup,
  Divider,
  InlineAlert,
  Content,
  Item,
  Picker,
  ActionButton,
  Dialog,
  DialogTrigger,
  Header,
  Footer,
} from '@adobe/react-spectrum';

const BASE = 'https://3967933-471blackyak-stage.adobeioruntime.net/api/v1/web/capstone-badge';
const GET_RULES_URL = `${BASE}/get-rules`;
const SAVE_RULES_URL = `${BASE}/save-rules`;

// Operators offered in the condition builder (id = backend op).
const CONDITION_OPS = [
  { id: '>',                  name: 'greater than (>)' },
  { id: '>=',                 name: 'at least (>=)' },
  { id: '<',                  name: 'less than (<)' },
  { id: '<=',                 name: 'at most (<=)' },
  { id: '=',                  name: 'equals (=)' },
  { id: '!=',                 name: 'not equal (!=)' },
  { id: 'in',                 name: 'in list' },
  { id: 'not_in',             name: 'not in list' },
  { id: 'between',            name: 'between (min|max, numbers or dates)' },
  { id: 'contains',           name: 'contains' },
  { id: 'within_days',        name: 'within days (date)' },
  { id: 'date_reached',       name: 'date reached (≤ now)' },
  { id: 'date_not_passed',    name: 'date not passed (≥ now)' },
  { id: 'date_window_active', name: 'date window active (Set as New)' },
];

// Operators that need no value (value field is hidden).
const VALUELESS_OPS = ['date_reached', 'date_not_passed', 'date_window_active'];

// Per-operator placeholder hint for the value field.
function placeholderFor(op) {
  switch (op) {
    case 'in':
    case 'not_in':
      return 'comma list, e.g. BPG-5005,HDP-1001';
    case 'between':
      return '100|200, 100|, |200, or 2026-01-01|2026-06-30';
    case 'within_days':
      return 'days, e.g. 30';
    case 'contains':
      return 'substring, e.g. steel';
    default:
      return 'e.g. 500, steel';
  }
}

// A fresh blank badge — one starter condition the merchant edits.
function newBadgeInstance() {
  const id = `badge_${Date.now()}`;
  return {
    id,
    enabled: true,
    label: 'New Badge',
    style: 'product_badge_default',
    ttlDays: 7,
    match: 'all',
    conditions: [{ field: '', op: '=', value: '' }],
  };
}

function clientValidate(badgeList) {
  const errors = [];
  const seenIds = new Set();
  for (let i = 0; i < badgeList.length; i++) {
    const b = badgeList[i];
    const p = `Badge "${b.label || i}"`;
    if (!b.label || !b.label.trim()) errors.push(`${p}: label cannot be empty.`);
    if (!b.style || !b.style.trim()) errors.push(`${p}: style class cannot be empty.`);
    if (!Number.isInteger(b.ttlDays) || b.ttlDays < 1) errors.push(`${p}: TTL must be a positive whole number.`);
    if (seenIds.has(b.id)) errors.push(`${p}: duplicate id "${b.id}".`);
    else seenIds.add(b.id);
    if (!Array.isArray(b.conditions) || b.conditions.length === 0) {
      errors.push(`${p}: add at least one condition.`);
    } else {
      b.conditions.forEach((c, ci) => {
        if (!c.field || !c.field.trim()) errors.push(`${p}: condition ${ci + 1} needs an attribute code.`);
        // Valueless operators (date_reached/date_not_passed/date_window_active) need no value.
        if (!VALUELESS_OPS.includes(c.op)
            && (c.value === undefined || c.value === null || String(c.value).trim() === '')) {
          errors.push(`${p}: condition ${ci + 1} needs a value.`);
        }
        // between needs a "|" range (numbers or dates) or a numeric "a-b".
        if (c.op === 'between' && c.value
            && !String(c.value).includes('|') && !String(c.value).includes('-')) {
          errors.push(`${p}: condition ${ci + 1} "between" needs min|max (e.g. 100|200 or 2026-01-01|2026-06-30).`);
        }
      });
    }
  }
  return errors;
}

// ---- Sub-component: condition builder (the rule) ----
function ConditionsEditor({ badge, onChange }) {
  const conditions = Array.isArray(badge.conditions) ? badge.conditions : [];
  const match = badge.match === 'any' ? 'any' : 'all';

  const setMatch = (m) => onChange({ ...badge, match: m });

  const updateCondition = (idx, patch) => {
    const next = conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onChange({ ...badge, conditions: next });
  };

  const addCondition = () => {
    onChange({ ...badge, conditions: [...conditions, { field: '', op: '=', value: '' }] });
  };

  const removeCondition = (idx) => {
    onChange({ ...badge, conditions: conditions.filter((_, i) => i !== idx) });
  };

  return (
    <View marginTop="size-200">
      <Flex alignItems="center" gap="size-200" marginBottom="size-100">
        <Text UNSAFE_style={{ fontWeight: 700 }}>Show this badge when</Text>
        <Picker
          aria-label="Match mode"
          selectedKey={match}
          onSelectionChange={setMatch}
          width="size-1700"
        >
          <Item key="all">ALL conditions</Item>
          <Item key="any">ANY condition</Item>
        </Picker>
        <Text>are true:</Text>
      </Flex>

      {conditions.length === 0 && (
        <Text UNSAFE_style={{ fontSize: 12, color: '#6e6e6e' }}>No conditions yet — add one below.</Text>
      )}

      {conditions.map((c, idx) => {
        const valueless = VALUELESS_OPS.includes(c.op);
        return (
          // eslint-disable-next-line react/no-array-index-key
          <Flex key={idx} gap="size-150" alignItems="end" marginBottom="size-100" wrap>
            <TextField
              label={idx === 0 ? 'Attribute code' : undefined}
              aria-label="Attribute code"
              value={c.field}
              onChange={(v) => updateCondition(idx, { field: v })}
              placeholder="e.g. price, qty, created_at, news_from_date, sku"
              width="size-2400"
            />
            <Picker
              label={idx === 0 ? 'Operator' : undefined}
              aria-label="Operator"
              items={CONDITION_OPS}
              selectedKey={c.op}
              onSelectionChange={(k) => updateCondition(idx, { op: k })}
              width="size-3400"
            >
              {(item) => <Item key={item.id}>{item.name}</Item>}
            </Picker>
            {valueless ? (
              <View width="size-2400">
                <Text UNSAFE_style={{ fontSize: 12, color: '#6e6e6e' }}>
                  {c.op === 'date_window_active' ? 'Checks news_from/news_to window' : 'No value needed'}
                </Text>
              </View>
            ) : (
              <TextField
                label={idx === 0 ? 'Value' : undefined}
                aria-label="Value"
                value={String(c.value ?? '')}
                onChange={(v) => updateCondition(idx, { value: v })}
                placeholder={placeholderFor(c.op)}
                width="size-2400"
              />
            )}
            <ActionButton aria-label="Remove condition" onPress={() => removeCondition(idx)}>✕</ActionButton>
          </Flex>
        );
      })}

      <View marginTop="size-100">
        <Button variant="secondary" onPress={addCondition}>+ Add condition</Button>
      </View>
    </View>
  );
}

// ---- Sub-component: single badge card ----
function BadgeCard({ badge, index, total, onChange, onDelete, onMove }) {
  return (
    <Well marginBottom="size-200">
      <Flex gap="size-200" alignItems="start">
        <Flex direction="column" gap="size-50" marginTop="size-100">
          <ActionButton aria-label="Move up" isDisabled={index === 0} onPress={() => onMove(index, -1)} isQuiet>▲</ActionButton>
          <ActionButton aria-label="Move down" isDisabled={index === total - 1} onPress={() => onMove(index, 1)} isQuiet>▼</ActionButton>
        </Flex>

        <View flex>
          {/* Title row */}
          <Flex alignItems="center" gap="size-200" marginBottom="size-200">
            <Heading level={4} flex margin={0}>{badge.label || '(no label)'}</Heading>
            <Switch
              isSelected={badge.enabled}
              onChange={(v) => onChange({ ...badge, enabled: v })}
            >
              {badge.enabled ? 'Enabled' : 'Disabled'}
            </Switch>
          </Flex>

          {/* Identity row: label / style / cache TTL */}
          <Flex gap="size-300" wrap alignItems="start">
            <TextField
              label="Label"
              value={badge.label}
              onChange={(v) => onChange({ ...badge, label: v })}
              width="size-2400"
            />
            <TextField
              label="Style (CSS class)"
              value={badge.style}
              onChange={(v) => onChange({ ...badge, style: v })}
              description="Full CSS class — add a matching rule to product-badges.css"
              width="size-2400"
            />
            <NumberField
              label="Cache TTL (days)"
              minValue={1}
              value={badge.ttlDays}
              onChange={(v) => onChange({ ...badge, ttlDays: v })}
              width="size-1600"
            />
          </Flex>

          {/* The rule */}
          <ConditionsEditor badge={badge} onChange={onChange} />
        </View>

        <DialogTrigger>
          <ActionButton aria-label="Delete badge" isQuiet marginTop="size-100" UNSAFE_style={{ color: '#c00' }}>✕</ActionButton>
          {(close) => (
            <Dialog>
              <Header><Heading>Delete badge</Heading></Header>
              <Content>
                <Text>Delete "{badge.label}"? This cannot be undone until you save.</Text>
              </Content>
              <Footer>
                <ButtonGroup>
                  <Button variant="secondary" onPress={close}>Cancel</Button>
                  <Button variant="negative" onPress={() => { onDelete(badge.id); close(); }}>Delete</Button>
                </ButtonGroup>
              </Footer>
            </Dialog>
          )}
        </DialogTrigger>
      </Flex>
    </Well>
  );
}

// ---- Main page component ----
export function BadgeRulesPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [badgeList, setBadgeList] = useState([]);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [guest, setGuest] = useState(null);

  // Scroll anchors: top (for save-success / errors) and bottom (for + Add Badge).
  const topRef = useRef(null);
  const bottomRef = useRef(null);
  // Set when the user clicks "+ Add Badge", so the next render scrolls to the
  // newly appended (lowest) badge — but NOT on reorder/load/save.
  const scrollToBottomNext = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const guestConnection = await attach({ id: extensionId });
        setGuest(guestConnection);
        const res = await fetch(GET_RULES_URL, { headers: { 'Content-Type': 'application/json' } });
        if (!res.ok) throw new Error(`get-rules returned ${res.status}`);
        const data = await res.json();
        setBadgeList(data.rules.badgeList || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // After a "+ Add Badge", scroll the new (bottom-most) badge into view.
  useEffect(() => {
    if (scrollToBottomNext.current && bottomRef.current) {
      scrollToBottomNext.current = false;
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [badgeList]);

  // On a successful save, scroll up so the merchant sees the success banner.
  useEffect(() => {
    if (saved && topRef.current) {
      topRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [saved]);

  // On a validation/save error, scroll up so the merchant sees the error banner.
  useEffect(() => {
    if (error && topRef.current) {
      topRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [error]);

  const updateBadge = useCallback((updated) => {
    setSaved(false);
    setBadgeList((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
  }, []);

  const deleteBadge = useCallback((id) => {
    setSaved(false);
    setBadgeList((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const moveBadge = useCallback((index, direction) => {
    setSaved(false);
    setBadgeList((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const addBadge = useCallback(() => {
    setSaved(false);
    scrollToBottomNext.current = true; // trigger scroll-to-bottom on next render
    setBadgeList((prev) => [...prev, newBadgeInstance()]);
  }, []);

  const save = async () => {
    setError(null);
    setSaved(false);
    const clientErrors = clientValidate(badgeList);
    if (clientErrors.length) { setError(clientErrors.join(' ')); return; }
    setSaving(true);
    try {
      const ctx = guest?.sharedContext;
      const imsToken = ctx?.get('imsToken');
      const imsOrgId = ctx?.get('imsOrgId');
      const rules = { version: 4, badgeList };
      const res = await fetch(SAVE_RULES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${imsToken}`,
          'x-gw-ims-org-id': imsOrgId,
        },
        body: JSON.stringify({ rules }),
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data.errors ? data.errors.join(' ') : (data.error || `save-rules returned ${res.status}`);
        throw new Error(detail);
      }
      setBadgeList(data.rules.badgeList || []);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Provider theme={defaultTheme} colorScheme="light">
        <View padding="size-400">
          <Flex alignItems="center" gap="size-200">
            <ProgressCircle aria-label="Loading" isIndeterminate />
            <Text>Loading badge rules...</Text>
          </Flex>
        </View>
      </Provider>
    );
  }

  if (!badgeList && error) {
    return (
      <Provider theme={defaultTheme} colorScheme="light">
        <View padding="size-400">
          <Heading level={1}>Badge Rules</Heading>
          <Well><Text>Could not load rules: {error}</Text></Well>
        </View>
      </Provider>
    );
  }

  return (
    <Provider theme={defaultTheme} colorScheme="light">
      <View padding="size-400">
        {/* top scroll anchor (save success / error banners live just below) */}
        <div ref={topRef} />
        <Flex alignItems="center" gap="size-300" marginBottom="size-200">
          <Heading level={1} flex margin={0}>Badge Rules</Heading>
          <Button variant="cta" onPress={addBadge}>+ Add Badge</Button>
        </Flex>

        <Text>Each badge is a rule: a label, a style, and one or more conditions on product attributes. Drag to reorder — order controls PDP display priority.</Text>

        {error && (
          <View marginTop="size-200">
            <InlineAlert variant="negative">
              <Heading>Error</Heading>
              <Content>{error}</Content>
            </InlineAlert>
          </View>
        )}
        {saved && (
          <View marginTop="size-200">
            <InlineAlert variant="positive">
              <Heading>Saved</Heading>
              <Content>Badge rules updated. Products will use the new rules on their next PDP visit.</Content>
            </InlineAlert>
          </View>
        )}

        <Divider size="S" marginY="size-300" />

        {badgeList.length === 0 ? (
          <Well><Text>No badges configured. Click "+ Add Badge" to create one.</Text></Well>
        ) : (
          badgeList.map((badge, i) => (
            <BadgeCard
              key={badge.id}
              badge={badge}
              index={i}
              total={badgeList.length}
              onChange={updateBadge}
              onDelete={deleteBadge}
              onMove={moveBadge}
            />
          ))
        )}

        <Divider size="S" marginY="size-300" />

        <ButtonGroup>
          <Button variant="cta" onPress={save} isPending={saving}>Save rules</Button>
        </ButtonGroup>
        {/* bottom scroll anchor (+ Add Badge scrolls here) */}
        <div ref={bottomRef} />
      </View>
    </Provider>
  );
}
