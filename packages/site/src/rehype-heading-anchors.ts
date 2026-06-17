// Appends a grabbable permalink to each section heading (h2-h4) in the rendered
// markdown, so any section of the spec can be linked and cited directly. Heading
// ids are reused when present (Astro injects them) and otherwise derived with
// the same slugger Astro uses, so anchors stay stable and match the headings.

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
