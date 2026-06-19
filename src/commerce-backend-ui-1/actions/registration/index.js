'use strict';

const extensionId = 'capstone_badge_admin';
const menuSectionId = `${extensionId}::apps`;
const menuItemId = `${extensionId}::badge_rules`;

async function main () {
  return {
    statusCode: 200,
    body: {
      registration: {
        menuItems: [
          {
            id: menuSectionId,
            title: 'Product Badges',
            isSection: true,
            sortOrder: 100,
          },
          {
            id: menuItemId,
            title: 'Badge Rules',
            parent: menuSectionId,
            sortOrder: 1,
          },
        ],
        page: {
          title: 'Product Badges Admin',
        },
      },
    },
  };
}

exports.main = main;
