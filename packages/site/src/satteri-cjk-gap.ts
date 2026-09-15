// Deletes the ASCII space Markdown forces around emphasis at a CJK boundary, in the
// locales whose punctuation is full width. `**注意。** 次へ` cannot be written without
// that space: the closing `**` sits after `。`, and CommonMark closes emphasis there
// only when a space follows. So in Japanese and Simplified Chinese prose an ASCII
// space at such a boundary is syntax padding rather than typography, and this deletes
// it when both sides of the gap are CJK. The convention, stated once:
//
//   - an ASCII space (U+0020) at an eligible boundary is padding, and goes;
//   - an intentional separator is the ideographic space (U+3000), never touched;
//   - a Latin letter, a digit (half or full width), or a code span on either side
//     means the space is someone's spacing rather than Markdown's, and it stays;
//   - a document carrying raw HTML, authored or a syntax-highlighted code block,
//     is left exactly as authored, whole;
//   - a heading keeps its spaces: its id is minted from the text after this plugin
//     runs, so a deletion there would move every fragment link to it.
//
// Sätteri hast plugin.

// The `.ts` extension on the import below is deliberate: the test loads this module
// directly under Node, which resolves relative specifiers exactly as written.
import type { Element } from 'hast';
import { defineHastPlugin } from 'satteri';
import { FULL_WIDTH_PUNCTUATION } from './sentence-gap.ts';

/** A CJK letter: Han in every plane, the two kana, and the prolonged sound mark,
 *  which is a mark of its own script. */
const CJK_LETTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]$/u;
/** Punctuation that ends a phrase, closing brackets and the joiners among them. */
const CJK_CLOSE = /^[。、，．：；！？…‥）」』】〕〉》｝〙〗・〜～]$/u;
/** Punctuation that opens one. */
const CJK_OPEN = /^[（「『【〔〈《｛〘〖]$/u;

/** A character a gap may follow, and the one an emphasis may end on. */
const closesPhrase = (char: string) => CJK_LETTER.test(char) || CJK_CLOSE.test(char);
/** A character a gap may precede in running text. */
const continuesPhrase = (char: string) => closesPhrase(char) || CJK_OPEN.test(char);
/** A character an emphasis may begin with. */
const opensPhrase = (char: string) => CJK_LETTER.test(char) || CJK_OPEN.test(char);

// The vetoed classes (Latin letters and digits, half and full width, and every kind
// of whitespace, U+3000 among them) need no test of their own: none of them is in a
// class above, so a gap beside one is never eligible.

/** Subtrees this plugin leaves alone: a link and a code span carry spacing of their
 *  own, and a heading's id is minted from its text further down the pipeline. */
const PROTECTED = new Set(['a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** The shape this plugin reads off a node, which is every node type it may meet,
 *  `raw` included, so the document check below sees what the HAST really holds. */
interface GapNode {
   type: string;
   tagName?: string;
   value?: string;
   children?: readonly GapNode[];
}

/** The last character of a string, as a character rather than a UTF-16 unit. */
function lastChar(text: string): string {
   const tail = text.slice(-2);
   return tail.length === 2 && [...tail].length === 1 ? tail : text.slice(-1);
}

/** The first character of a string, on the same terms. */
function firstChar(text: string): string {
   return text ? String.fromCodePoint(text.codePointAt(0)!) : '';
}

/** `node` when it is emphasis, which is the only element this plugin reads an edge
 *  character out of. */
function asEmphasis(node: GapNode | undefined): GapNode | undefined {
   return node?.type === 'element' && (node.tagName === 'strong' || node.tagName === 'em') ? node : undefined;
}

/** The character an emphasis ends on, descending through nested emphasis only: a code
 *  span or a link at the edge is not a character this convention speaks about, and
 *  reports none. */
function closingEdge(node: GapNode | undefined): string {
   const emphasis = asEmphasis(node);
   const last = emphasis?.children?.at(-1);
   if (!last) return '';
   return last.type === 'text' ? lastChar(last.value ?? '') : closingEdge(last);
}

/** The character an emphasis begins with, on the same terms. */
function openingEdge(node: GapNode | undefined): string {
   const emphasis = asEmphasis(node);
   const first = emphasis?.children?.[0];
   if (!first) return '';
   return first.type === 'text' ? firstChar(first.value ?? '') : openingEdge(first);
}

/** Whether the document holds raw HTML anywhere. Raw tags arrive as nodes beside the
 *  elements they wrap rather than around them, so a wrapper opened in one block and
 *  closed in another protects nothing structurally: the whole document is the only
 *  boundary that holds. */
function hasRawHtml(node: GapNode): boolean {
   return node.type === 'raw' || (node.children?.some(hasRawHtml) ?? false);
}

/** The language the document is written in, read from the file it came from, exactly
 *  as the link rewriter reads it: a translated document lives under
 *  `content/i18n/<locale>/`, and only the full-width-punctuation locales qualify. */
function isFullWidthTranslation(fileURL: URL | undefined): boolean {
   const match = fileURL && /\/content\/i18n\/([^/]+)\//.exec(fileURL.pathname);
   return match ? FULL_WIDTH_PUNCTUATION.has(match[1]) : false;
}

/** Exported as a factory so the two document-level decisions below, the locale and
 *  the raw-HTML skip, are made once per document and reset with the next one. */
export function satteriCjkGap() {
   let translated: boolean | undefined;
   let rawDocument: boolean | undefined;
   return defineHastPlugin({
      name: 'leji-cjk-gap',
      text(node, ctx) {
         translated ??= isFullWidthTranslation(ctx.fileURL);
         if (!translated) return;
         const value = node.value;
         if (!value.includes(' ')) return;
         const parent = ctx.parent(node) as GapNode | undefined;
         const index = ctx.indexOf(node);
         if (!parent?.children || index === undefined) return;

         // Climbing answers both document questions at once: whether this text sits in
         // a protected subtree, and what tree to check for raw HTML.
         let root = parent;
         for (;;) {
            if (root.type === 'element' && PROTECTED.has(root.tagName ?? '')) return;
            const above = ctx.parent(root as unknown as Element) as GapNode | undefined;
            if (!above) break;
            root = above;
         }
         rawDocument ??= hasRawHtml(root);
         if (rawDocument) return;

         const before = index > 0 ? parent.children[index - 1] : undefined;
         const after = parent.children[index + 1];

         // A lone space between two emphasis spans has no neighbouring character of
         // its own; the two facing edges are the boundary, and the node goes whole.
         if (value === ' ') {
            if (closesPhrase(closingEdge(before)) && opensPhrase(openingEdge(after))) ctx.removeNode(node);
            return;
         }

         // Both ends of one text node are trimmed in a single replacement, because a
         // node mutated twice in one pass keeps only one of the two.
         const leading = value.startsWith(' ') && value[1] !== ' ';
         const trailing = value.endsWith(' ') && value[value.length - 2] !== ' ';
         const start =
            leading && closesPhrase(closingEdge(before)) && continuesPhrase(firstChar(value.slice(1))) ? 1 : 0;
         const end =
            trailing && opensPhrase(openingEdge(after)) && closesPhrase(lastChar(value.slice(0, -1)))
               ? value.length - 1
               : value.length;
         if (start === 0 && end === value.length) return;
         const trimmed = value.slice(start, end);
         if (trimmed === '') ctx.removeNode(node);
         else ctx.replaceNode(node, { type: 'text', value: trimmed });
      },
   });
}
