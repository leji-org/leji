// Rewrites relative links in the spec markdown to site routes, so the spec
// files remain the single source of truth and read correctly on GitHub too.

interface HastNode {
   type: string;
   tagName?: string;
   properties?: { href?: unknown };
   children?: HastNode[];
}

export function rehypeMdLinks() {
   return (tree: HastNode) => {
      const visit = (node: HastNode) => {
         if (node.type === 'element' && node.tagName === 'a' && node.properties?.href) {
            const href = String(node.properties.href);
            const isRelative = !/^([a-z]+:)?\/\//.test(href) && !href.startsWith('/') && !href.startsWith('#');
            if (isRelative) {
               const clean = href.replace(/^(\.\.\/|\.\/)*/, '');
               if (clean.endsWith('.schema.json')) {
                  // Prose links go to the viewer page; the raw file stays at its canonical $id URL.
                  const base = clean
                     .split('/')
                     .pop()!
                     .replace(/\.schema\.json$/, '');
                  node.properties.href = `/schemas/${base}/`;
               } else if (clean === 'schemas/' || clean === 'schemas') {
                  node.properties.href = '/schemas/';
               } else if (clean === 'rationale/' || clean === 'rationale') {
                  node.properties.href = '/rationale/';
               } else if (clean === 'adoption/' || clean === 'adoption') {
                  node.properties.href = '/adoption/';
               } else if (clean.endsWith('.md')) {
                  const name = clean.replace(/\.md$/, '');
                  node.properties.href =
                     name === 'README' || name === 'readme' ? '/spec/' : `/spec/${name.split('/').pop()}/`;
               } else {
                  // Anything else (examples/, templates/) lives in the repository.
                  node.properties.href = `https://github.com/leji-org/leji/tree/main/${clean}`;
               }
            }
         }
         (node.children ?? []).forEach(visit);
      };
      visit(tree);
   };
}
