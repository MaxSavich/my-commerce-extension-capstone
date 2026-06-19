const { defineConfig } = require("@adobe/aio-commerce-lib-app/config");

module.exports = defineConfig({
  metadata: {
    id: "commerce-oop-capstone-ms",
    displayName: "Commerce OOP Capstone MS",
    version: "1.0.0",
    description:
      "Capstone app: merchant-configurable product badges (compute, read, event-driven recompute) and the Badge Rules admin editor.",
  },
  adminUiSdk: {
    registration: {
      menuItems: [
        {
          id: 'capstone_badge_admin::apps',
          title: 'Product Badges',
          isSection: true,
          sortOrder: 100,
        },
        {
          id: 'capstone_badge_admin::badge_rules',
          title: 'Badge Rules',
          parent: 'capstone_badge_admin::apps',
          sortOrder: 1,
        },
      ],
    },
  },
  // Event-driven badge recompute: when a product is saved in Commerce, the
  // badge-event-consumer recomputes that SKU's badges (calls compute-badges).
  eventing: {
    commerce: [
      {
        provider: {
          label: 'Capstone Badge Events',
          description: 'Product save events for badge recomputation',
          key: 'capstone-badge-events',
        },
        events: [
          {
            name: 'observer.catalog_product_save_after',
            label: 'Product saved (badge recompute)',
            description: 'Recompute product badges whenever a product is saved.',
            fields: [
              { name: 'sku' },
            ],
            runtimeActions: ['capstone-badge/badge-event-consumer'],
          },
        ],
      },
    ],
  },
});
