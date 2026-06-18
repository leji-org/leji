// Wraps every markdown table in a scroll container so a wide table scrolls in its own box instead of widening the page.

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
