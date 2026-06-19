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
  // Event-driven badge recompute is wired via an I/O Events registration created
  // in the Developer Console (Commerce Events wizard) on provider
  // "Commerce-Event-Provider-MS1_Label", delivering observer.catalog_product_save_after
  // to capstone-badge/badge-event-consumer. (No declarative `eventing` block here:
  // the registration is managed in Console, per course Activity 4-1.)
});
