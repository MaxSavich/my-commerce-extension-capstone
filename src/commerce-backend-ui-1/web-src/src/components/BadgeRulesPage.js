import React, { useEffect, useState } from 'react';
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
} from '@adobe/react-spectrum';

// Capstone app namespace + package. get-rules is no-auth; save-rules requires
// the merchant IMS token (sent below).
const BASE = 'https://3967933-471blackyak-stage.adobeioruntime.net/api/v1/web/capstone-badge';
const GET_RULES_URL = `${BASE}/get-rules`;
const SAVE_RULES_URL = `${BASE}/save-rules`;

// Client-side validation for instant feedback (the authoritative check still
// runs server-side inside save-rules).
function clientValidate(rules) {
  const errors = [];
  const b = rules.badges;
  if (!Number.isInteger(b.new.withinDays) || b.new.withinDays <= 0) {
    errors.push('New: "within days" must be a positive whole number.');
  }
  if (!Number.isInteger(b.lowstock.threshold) || b.lowstock.threshold <= 0) {
    errors.push('Low Stock: "below quantity" must be a positive whole number.');
  }
  for (const t of ['new', 'bestseller', 'limited', 'outofstock', 'lastone', 'lowstock']) {
    if (!b[t].label || !b[t].label.trim()) errors.push(`${t}: label cannot be empty.`);
  }
  return errors;
}

export function BadgeRulesPage () {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [skuInput, setSkuInput] = useState('');

  // Hold the guest connection so we can read the IMS token when saving.
  const [guest, setGuest] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        // attach() gives us the Admin UI SDK shared context (IMS token, org).
        const guestConnection = await attach({ id: extensionId });
        setGuest(guestConnection);

        // READ: get-rules is no-auth, so no token needed here.
        const res = await fetch(GET_RULES_URL, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) throw new Error(`get-rules returned ${res.status}`);
        const data = await res.json();
        setRules(data.rules);
      } catch (err) {
        console.error('Failed to load badge rules:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const updateBadge = (type, field, value) => {
    setSaved(false);
    setRules((prev) => ({
      ...prev,
      badges: { ...prev.badges, [type]: { ...prev.badges[type], [field]: value } },
    }));
  };

  const addSku = () => {
    const sku = skuInput.trim();
    if (!sku) return;
    const current = rules.badges.bestseller.skus;
    if (!current.includes(sku)) updateBadge('bestseller', 'skus', [...current, sku]);
    setSkuInput('');
  };

  const removeSku = (keys) => {
    const toRemove = new Set(keys);
    updateBadge('bestseller', 'skus', rules.badges.bestseller.skus.filter((s) => !toRemove.has(s)));
  };

  const save = async () => {
    setError(null);
    setSaved(false);
    const clientErrors = clientValidate(rules);
    if (clientErrors.length) {
      setError(clientErrors.join(' '));
      return;
    }
    setSaving(true);
    try {
      // === AUTH HAPPENS HERE ===
      // save-rules is require-adobe-auth:true. Send the merchant IMS token from
      // the Admin UI SDK shared context as a Bearer token + the org id header.
      // The Adobe platform validates this token before the action runs.
      const ctx = guest?.sharedContext;
      const imsToken = ctx?.get('imsToken');
      const imsOrgId = ctx?.get('imsOrgId');

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
      setRules(data.rules);
      setSaved(true);
    } catch (err) {
      console.error('Failed to save badge rules:', err);
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

  if (!rules) {
    return (
      <Provider theme={defaultTheme} colorScheme="light">
        <View padding="size-400">
          <Heading level={1}>Badge Rules</Heading>
          <Well><Text>Could not load rules: {error}</Text></Well>
        </View>
      </Provider>
    );
  }

  const b = rules.badges;

  return (
    <Provider theme={defaultTheme} colorScheme="light">
      <View padding="size-400">
        <Heading level={1}>Badge Rules</Heading>
        <Text>Configure how product badges are computed. Changes apply the next time a product is processed.</Text>

        {error && (
          <View marginTop="size-200">
            <InlineAlert variant="negative">
              <Heading>Could not save</Heading>
              <Content>{error}</Content>
            </InlineAlert>
          </View>
        )}
        {saved && (
          <View marginTop="size-200">
            <InlineAlert variant="positive">
              <Heading>Saved</Heading>
              <Content>Badge rules updated.</Content>
            </InlineAlert>
          </View>
        )}

        {/* NEW */}
        <View marginTop="size-400">
          <Flex alignItems="center" gap="size-200">
            <Heading level={3} flex>New</Heading>
            <Switch isSelected={b.new.enabled} onChange={(v) => updateBadge('new', 'enabled', v)}>Enabled</Switch>
          </Flex>
          <Flex gap="size-300" wrap alignItems="end">
            <TextField label="Label" value={b.new.label} onChange={(v) => updateBadge('new', 'label', v)} />
            <NumberField
              label="New within (days)"
              minValue={1}
              value={b.new.withinDays}
              onChange={(v) => updateBadge('new', 'withinDays', v)}
            />
          </Flex>
        </View>

        <Divider size="S" marginY="size-300" />

        {/* BEST SELLER */}
        <View>
          <Flex alignItems="center" gap="size-200">
            <Heading level={3} flex>Best Seller</Heading>
            <Switch isSelected={b.bestseller.enabled} onChange={(v) => updateBadge('bestseller', 'enabled', v)}>Enabled</Switch>
          </Flex>
          <TextField label="Label" value={b.bestseller.label} onChange={(v) => updateBadge('bestseller', 'label', v)} />
          <View marginTop="size-200">
            <Text>Best Seller SKUs</Text>
            <Flex gap="size-200" alignItems="end" marginTop="size-100">
              <TextField
                label="Add SKU"
                value={skuInput}
                onChange={setSkuInput}
                onKeyDown={(e) => { if (e.key === 'Enter') addSku(); }}
              />
              <Button variant="secondary" onPress={addSku}>Add</Button>
            </Flex>
            <View marginTop="size-200">
              {b.bestseller.skus.length === 0 ? (
                <Text>No SKUs configured.</Text>
              ) : (
                <TagGroup aria-label="Best seller SKUs" onRemove={removeSku} items={b.bestseller.skus.map((s) => ({ id: s, name: s }))}>
                  {(item) => <Item key={item.id}>{item.name}</Item>}
                </TagGroup>
              )}
            </View>
          </View>
        </View>

        <Divider size="S" marginY="size-300" />

        {/* LIMITED OFFER */}
        <View>
          <Flex alignItems="center" gap="size-200">
            <Heading level={3} flex>Limited Offer</Heading>
            <Switch isSelected={b.limited.enabled} onChange={(v) => updateBadge('limited', 'enabled', v)}>Enabled</Switch>
          </Flex>
          <TextField label="Label" value={b.limited.label} onChange={(v) => updateBadge('limited', 'label', v)} />
          <View marginTop="size-200">
            <Switch
              isSelected={b.limited.requireDateWindow}
              onChange={(v) => updateBadge('limited', 'requireDateWindow', v)}
            >
              Require active special-price date window
            </Switch>
          </View>
        </View>

        <Divider size="S" marginY="size-300" />

        {/* OUT OF STOCK */}
        <View>
          <Flex alignItems="center" gap="size-200">
            <Heading level={3} flex>Out of Stock</Heading>
            <Switch isSelected={b.outofstock.enabled} onChange={(v) => updateBadge('outofstock', 'enabled', v)}>Enabled</Switch>
          </Flex>
          <TextField label="Label" value={b.outofstock.label} onChange={(v) => updateBadge('outofstock', 'label', v)} />
          <View marginTop="size-100">
            <Text>Shown when the product's inventory quantity is exactly 0.</Text>
          </View>
        </View>

        <Divider size="S" marginY="size-300" />

        {/* LAST ONE */}
        <View>
          <Flex alignItems="center" gap="size-200">
            <Heading level={3} flex>Last One</Heading>
            <Switch isSelected={b.lastone.enabled} onChange={(v) => updateBadge('lastone', 'enabled', v)}>Enabled</Switch>
          </Flex>
          <TextField label="Label" value={b.lastone.label} onChange={(v) => updateBadge('lastone', 'label', v)} />
          <View marginTop="size-100">
            <Text>Shown when exactly 1 unit remains in stock.</Text>
          </View>
        </View>

        <Divider size="S" marginY="size-300" />

        {/* LOW STOCK */}
        <View>
          <Flex alignItems="center" gap="size-200">
            <Heading level={3} flex>Low Stock</Heading>
            <Switch isSelected={b.lowstock.enabled} onChange={(v) => updateBadge('lowstock', 'enabled', v)}>Enabled</Switch>
          </Flex>
          <Flex gap="size-300" wrap alignItems="end">
            <TextField label="Label" value={b.lowstock.label} onChange={(v) => updateBadge('lowstock', 'label', v)} />
            <NumberField
              label="Low when below (qty)"
              minValue={2}
              value={b.lowstock.threshold}
              onChange={(v) => updateBadge('lowstock', 'threshold', v)}
            />
          </Flex>
          <View marginTop="size-100">
            <Text>Shown when inventory is more than 1 but below this quantity. Out of Stock and Last One take priority.</Text>
          </View>
        </View>

        <Divider size="S" marginY="size-300" />

        <ButtonGroup>
          <Button variant="cta" onPress={save} isPending={saving}>Save rules</Button>
        </ButtonGroup>
      </View>
    </Provider>
  );
}
