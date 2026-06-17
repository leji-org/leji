// Wraps every markdown table in a scroll container so a table wider than the
// reading column scrolls within its own box instead of pushing the whole page
// (and the doc sidebar) wider than the viewport on narrow screens.

interface HastNode {
   type: string;
   tagName?: string;
   properties?: Record<string, unknown>;
   children?: HastNode[];
}

export function rehypeTableScroll() {
   return (tree: HastNode) => {
      const visit = (node: HastNode) => {
         const children = node.children;
         if (!children) return;
         for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child.type === 'element' && child.tagName === 'table') {
               children[i] = {
                  type: 'element',
                  tagName: 'div',
                  properties: { className: ['table-scroll'] },
                  children: [child],
               };
            }
            visit(child);
         }
      };
      visit(tree);
   };
}
