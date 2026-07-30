// Appends a permalink anchor to each heading (h2-h4). Sätteri hast plugin.
// Exported as a factory so the GithubSlugger resets per document (slug numbering
// doesn't bleed across pages). Runs before Sätteri's built-in heading-ids pass,
// so it assigns the id itself and the built-in pass reuses it.

import GithubSlugger from 'github-slugger';
import { defineHastPlugin } from 'satteri';

const HEADINGS = ['h2', 'h3', 'h4'];

export function satteriHeadingAnchors() {
   const slugger = new GithubSlugger();
   return defineHastPlugin({
      name: 'leji-heading-anchors',
      element: {
         filter: HEADINGS,
         visit(node, ctx) {
            const existing = node.properties?.id;
            const id = typeof existing === 'string' && existing ? existing : slugger.slug(ctx.textContent(node));
            ctx.setProperty(node, 'id', id);
            ctx.appendChild(node, {
               type: 'element',
               tagName: 'a',
               properties: { className: ['heading-anchor'], href: `#${id}`, ariaLabel: 'Permalink to this section' },
               children: [{ type: 'text', value: '#' }],
            });
         },
      },
   });
}
