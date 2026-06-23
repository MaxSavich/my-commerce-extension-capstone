import React, { useEffect, useState, useCallback } from 'react';
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
  TagGroup,
  Item,
  Picker,
  ActionButton,
  Dialog,
  DialogTrigger,
  Header,
  Footer,
  Checkbox,
} from '@adobe/react-spectrum';

const BASE = 'https://3967933-471blackyak-stage.adobeioruntime.net/api/v1/web/capstone-badge';
const GET_RULES_URL = `${BASE}/get-rules`;
const SAVE_RULES_URL = `${BASE}/save-rules`;

const TRIGGER_TYPES = [
  { id: 'new',        name: 'New Arrival' },
  { id: 'bestseller', name: 'Best Seller' },
  { id: 'limited',    name: 'Limited Offer' },
  { id: 'outofstock', name: 'Out of Stock' },
  { id: 'lastone',    name: 'Last One' },
  { id: 'lowstock',   name: 'Low Stock' },
];

const TYPE_DEFAULTS = {
  new:        { label: 'New',          style: 'product_badge_new',     ttlDays: 30, withinDays: 30 },
  bestseller: { label: 'Best Seller',  style: 'product_badge_default', ttlDays: 30, skus: [] },
  limited:    { label: 'Limited Offer',style: 'product_badge_sale',    ttlDays: 7,  requireDateWindow: true },
  outofstock: { label: 'Out of Stock', style: 'product_badge_stock',   ttlDays: 1 },
  lastone:    { label: 'Last One',     style: 'product_badge_stock',   ttlDays: 1 },
  lowstock:   { label: 'Low Stock',    style: 'product_badge_stock',   ttlDays: 3,  threshold: 10 },
};

function newBadgeInstance(type) {
  const id = `${type}_${Date.now()}`;
  return { id, type, enabled: true, ...TYPE_DEFAULTS[type] };
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
    if (b.type === 'new' && (!Number.isInteger(b.withinDays) || b.withinDays < 1))
      errors.push(`${p}: "within days" must be a positive whole number.`);
    if (b.type === 'lowstock' && (!Number.isInteger(b.threshold) || b.threshold < 2))
      errors.push(`${p}: "low stock threshold" must be >= 2.`);
  }
  return errors;
}

// ---- Sub-component: type-specific fields ----
function TypeFields({ badge, onChange }) {
  const u = (field, val) => onChange({ ...badge, [field]: val });

  if (badge.type === 'new') {
    return (
      <NumberField
        label="New within (days)"
        minValue={1}
        value={badge.withinDays}
        onChange={(v) => u('withinDays', v)}
        width="size-1600"
      />
    );
  }
  if (badge.type === 'bestseller') {
    return <SkuField badge={badge} onChange={onChange} />;
  }
  if (badge.type === 'limited') {
    return (
      <Checkbox
        isSelected={badge.requireDateWindow}
        onChange={(v) => u('requireDateWindow', v)}
      >
        Require active special-price date window
      </Checkbox>
    );
  }
  if (badge.type === 'lowstock') {
    return (
      <NumberField
        label="Low when below (qty)"
        minValue={2}
        value={badge.threshold}
        onChange={(v) => u('threshold', v)}
        width="size-1600"
      />
    );
  }
  return null;
}

function SkuField({ badge, onChange }) {
  const [skuInput, setSkuInput] = useState('');

  const addSku = () => {
    const sku = skuInput.trim();
    if (!sku) return;
    const skus = Array.isArray(badge.skus) ? badge.skus : [];
    if (!skus.includes(sku)) onChange({ ...badge, skus: [...skus, sku] });
    setSkuInput('');
  };

  const removeSku = (keys) => {
    const toRemove = new Set(keys);
    onChange({ ...badge, skus: badge.skus.filter((s) => !toRemove.has(s)) });
  };

  return (
    <View>
      <Flex gap="size-200" alignItems="end">
        <TextField
          label="Add Best Seller SKU"
          value={skuInput}
          onChange={setSkuInput}
          onKeyDown={(e) => { if (e.key === 'Enter') addSku(); }}
          width="size-2400"
        />
        <Button variant="secondary" onPress={addSku}>Add</Button>
      </Flex>
      <View marginTop="size-100">
        {(!badge.skus || badge.skus.length === 0) ? (
          <Text>No SKUs configured.</Text>
        ) : (
          <TagGroup
            aria-label="Best seller SKUs"
            onRemove={removeSku}
            items={badge.skus.map((s) => ({ id: s, name: s }))}
          >
            {(item) => <Item key={item.id}>{item.name}</Item>}
          </TagGroup>
        )}
      </View>
    </View>
  );
}

// ---- Sub-component: single badge card ----
function BadgeCard({ badge, index, total, onChange, onDelete, onMove }) {
  const typeName = TRIGGER_TYPES.find((t) => t.id === badge.type)?.name || badge.type;

  return (
    <Well marginBottom="size-200">
      <Flex gap="size-200" alignItems="center" marginBottom="size-200">
        <Flex direction="column" gap="size-50">
          <ActionButton
            aria-label="Move up"
            isDisabled={index === 0}
            onPress={() => onMove(index, -1)}
            isQuiet
          >▲</ActionButton>
          <ActionButton
            aria-label="Move down"
            isDisabled={index === total - 1}
            onPress={() => onMove(index, 1)}
            isQuiet
          >▼</ActionButton>
        </Flex>

        <View flex>
          <Flex alignItems="center" gap="size-200" marginBottom="size-200">
            <Heading level={4} flex margin={0}>
              {badge.label || '(no label)'} <Text UNSAFE_style={{ fontSize: 12, color: '#666', fontWeight: 'normal' }}>— {typeName}</Text>
            </Heading>
            <Switch
              isSelected={badge.enabled}
              onChange={(v) => onChange({ ...badge, enabled: v })}
            >
              {badge.enabled ? 'Enabled' : 'Disabled'}
            </Switch>
          </Flex>

          <Flex gap="size-300" wrap alignItems="end" marginBottom="size-200">
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
              description="Full CSS class name — add matching rule to product-badges.css"
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

          <TypeFields badge={badge} onChange={onChange} />
        </View>

        <DialogTrigger>
          <ActionButton aria-label="Delete badge" isQuiet UNSAFE_style={{ color: '#c00' }}>✕</ActionButton>
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

  // Add-badge dialog state
  const [newType, setNewType] = useState('new');

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

  const addBadge = useCallback((type, close) => {
    setSaved(false);
    setBadgeList((prev) => [...prev, newBadgeInstance(type)]);
    close();
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
      const rules = { version: 3, badgeList };
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
        <Flex alignItems="center" gap="size-300" marginBottom="size-200">
          <Heading level={1} flex margin={0}>Badge Rules</Heading>

          <DialogTrigger>
            <Button variant="cta">+ Add Badge</Button>
            {(close) => (
              <Dialog>
                <Header><Heading>Add a new badge</Heading></Header>
                <Content>
                  <Text>Choose the trigger type. You can customise the label, style, and parameters after adding.</Text>
                  <View marginTop="size-200">
                    <Picker
                      label="Trigger type"
                      items={TRIGGER_TYPES}
                      selectedKey={newType}
                      onSelectionChange={setNewType}
                    >
                      {(item) => <Item key={item.id}>{item.name}</Item>}
                    </Picker>
                  </View>
                </Content>
                <Footer>
                  <ButtonGroup>
                    <Button variant="secondary" onPress={close}>Cancel</Button>
                    <Button variant="cta" onPress={() => addBadge(newType, close)}>Add</Button>
                  </ButtonGroup>
                </Footer>
              </Dialog>
            )}
          </DialogTrigger>
        </Flex>

        <Text>Configure how product badges are computed and displayed. Drag to reorder — order controls PDP display priority and stock-badge mutual exclusion.</Text>

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
      </View>
    </Provider>
  );
}
