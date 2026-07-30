// Rewrites relative links in the spec markdown to site routes, so the spec files
// stay the single source of truth and read correctly on GitHub too. Sätteri hast plugin.

import { defineHastPlugin } from 'satteri';

export const satteriMdLinks = defineHastPlugin({
   name: 'leji-md-links',
   element: {
      filter: ['a'],
      visit(node, ctx) {
         const href = node.properties?.href;
         if (typeof href !== 'string') return;
         const isRelative = !/^([a-z]+:)?\/\//.test(href) && !href.startsWith('/') && !href.startsWith('#');
         if (!isRelative) return;
         const clean = href.replace(/^(\.\.\/|\.\/)*/, '');
         let next: string;
         if (clean.endsWith('.schema.json')) {
            // Prose links go to the viewer page; the raw file stays at its canonical $id URL.
            const base = clean
               .split('/')
               .pop()!
               .replace(/\.schema\.json$/, '');
            next = `/schemas/${base}/`;
         } else if (clean === 'schemas/' || clean === 'schemas') {
            next = '/schemas/';
         } else if (clean === 'rationale/' || clean === 'rationale') {
            next = '/rationale/';
         } else if (clean === 'adoption/' || clean === 'adoption') {
            next = '/adoption/';
         } else if (clean.endsWith('.md')) {
            const name = clean.replace(/\.md$/, '');
            next = name === 'README' || name === 'readme' ? '/spec/' : `/spec/${name.split('/').pop()}/`;
         } else {
            // Anything else (examples/, templates/) lives in the repository.
            next = `https://github.com/leji-org/leji/tree/main/${clean}`;
         }
         ctx.setProperty(node, 'href', next);
      },
   },
});
