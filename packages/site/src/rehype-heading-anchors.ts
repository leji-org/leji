// Appends a permalink anchor to each heading (h2-h4) so any section can be linked; reuses Astro's ids/slugger so anchors stay stable.

import GithubSlugger from 'github-slugger';

interface HastNode {
   type: string;
   tagName?: string;
   value?: string;
   properties?: { id?: unknown; className?: unknown; href?: unknown; ariaLabel?: unknown };
   children?: HastNode[];
}

const HEADINGS = new Set(['h2', 'h3', 'h4']);

const textOf = (node: HastNode): string =>
   node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

export function rehypeHeadingAnchors() {
   return (tree: HastNode) => {
      const slugger = new GithubSlugger();
      const visit = (node: HastNode) => {
         if (node.type === 'element' && node.tagName && HEADINGS.has(node.tagName)) {
            node.properties = node.properties ?? {};
            const existing = node.properties.id ? String(node.properties.id) : '';
            const id = existing || slugger.slug(textOf(node));
            node.properties.id = id;
            node.children = node.children ?? [];
            node.children.push({
               type: 'element',
               tagName: 'a',
               properties: { className: ['heading-anchor'], href: `#${id}`, ariaLabel: 'Permalink to this section' },
               children: [{ type: 'text', value: '#' }],
            });
         }
         (node.children ?? []).forEach(visit);
      };
      visit(tree);
   };
}
