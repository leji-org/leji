// Wraps every markdown table in a scroll container so a wide table scrolls in its
// own box instead of widening the page. Sätteri hast plugin.

import { defineHastPlugin } from 'satteri';

export const satteriTableScroll = defineHastPlugin({
   name: 'leji-table-scroll',
   element: {
      filter: ['table'],
      visit(node, ctx) {
         // wrapNode makes `node` the first child, giving `div.table-scroll > table`.
         ctx.wrapNode(node, {
            type: 'element',
            tagName: 'div',
            properties: { className: ['table-scroll'], tabIndex: 0, role: 'region', ariaLabel: 'Scrollable table' },
            children: [],
         });
      },
   },
});
