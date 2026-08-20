import { type Finding } from './findings.js';
import { parseFrontmatter } from './frontmatter.js';

/**
 * The rendering-subset scan: given one markdown document, the constructs in it
 * that render differently across renderers. This module is the executable
 * contract the Go and Python SDKs port — the rules are stated here once, in the
 * order they are applied, because a second statement of them (a grammar, a spec
 * paragraph) would be a source that drifts.
 *
 * The rules, in application order:
 *
 * 1. **Excluded regions are found first.** YAML frontmatter (a leading block
 *    only, by the SDK's own boundary), fenced code blocks, and HTML comments are
 *    scanned before anything else, and nothing inside one is ever reported —
 *    text that merely names a construct is not that construct. Code spans are
 *    excluded the same way, inline, as the scan reaches them.
 * 2. **Three constructs are reported**, and only these three:
 *    `raw-html` (CommonMark HTML blocks and inline raw HTML; comments excepted,
 *    since Leji's own generated-block markers are comments), `footnote` (the
 *    definition and reference forms alike), and `math-block` (a PAIRED `$$`
 *    delimiter — a lone one is prose).
 * 3. **Backslash escapes are honored** for all three, per CommonMark: an escaped
 *    ASCII punctuation character is a literal, so `\<div>` is prose.
 * 4. **Overlapping constructs resolve to the earliest-starting match**, which the
 *    single left-to-right scan below produces by construction, and each match is
 *    attributed to the line it OPENS on — a multi-line HTML block or `$$` block
 *    reports once, at its opening line.
 * 5. **One hit per (line, construct)**: the line is the unit, so a line carrying
 *    two inline tags reports `raw-html` once.
 *
 * What is deliberately NOT reported: inline `$` (a currency amount spells it),
 * unknown fence info strings (the unhighlighted fallback is conforming), and
 * loose prose shapes. `adoption/rendering.md` is the profile these rules serve.
 */

/** The closed token set. Findings compare on it across the three SDKs; the
 * message text does not. */
export type RenderConstruct = 'raw-html' | 'footnote' | 'math-block';

/** The one rule this scan produces. `--strict` promotes it (see `export.ts`). */
export const RENDER_UNSUPPORTED_RULE = 'render-unsupported';

/** The shared message template. Identical bytes in all three SDKs by convention,
 * outside the fixture contract by design. */
export function renderUnsupportedMessage(construct: RenderConstruct): string {
   return `\`${construct}\` is outside the supported rendering subset; see adoption/rendering.md`;
}

/** One reported construct: the token, and the 1-based line it opens on. */
export interface RenderHit {
   line: number;
   construct: RenderConstruct;
}

/**
 * CommonMark HTML block type 6: a line opening with one of these tags starts a
 * block that runs to the next blank line, whatever else the line carries. The
 * list is CommonMark's, verbatim, so a `</div>` closing a block on a later line
 * is block content rather than a second construct.
 */
const BLOCK_TAGS = new Set(
   (
      'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl ' +
      'dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend ' +
      'li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td ' +
      'tfoot th thead title tr track ul'
   ).split(' '),
);

/** CommonMark HTML block type 1: these run to a line carrying a closing tag
 * rather than to a blank line, because their content is raw text. */
const RAW_TEXT_OPEN = /^<(script|pre|style|textarea)([ \t>]|$)/i;
const RAW_TEXT_CLOSE = /<\/(script|pre|style|textarea)>/i;

// Inline raw HTML, as CommonMark defines it: an open tag, a closing tag, a
// processing instruction, a declaration, or a CDATA section. (A comment is the
// sixth form and the excepted one, handled as an excluded region.) Sticky, so
// each is tried at exactly the scan position. A declaration takes an ASCII letter
// of either case after `<!`: `<!DOCTYPE html>` and `<!foo bar>` alike disappear
// into the renderer, which is precisely what the lint exists to warn about.
const OPEN_TAG =
   /<[A-Za-z][A-Za-z0-9-]*(?:[ \t\r\n]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t\r\n]*=[ \t\r\n]*(?:[^ \t\r\n"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t\r\n]*\/?>/y;
const CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*[ \t\r\n]*>/y;
const CDATA = /<!\[CDATA\[[\s\S]*?\]\]>/y;
const DECLARATION = /<![A-Za-z][\s\S]*?>/y;
const PROCESSING = /<\?[\s\S]*?\?>/y;
/** Both footnote forms: the reference `[^id]`, and the definition `[^id]:`,
 * whose opening bracket the same match covers. An unclosed `[^` is prose. */
const FOOTNOTE = /\[\^[^\][\n]+\]/y;

/** A fence opener: three or more backticks or tildes. A backtick fence's info
 * string may carry no backtick, which is what keeps a code span off this path. */
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
/** A fence closer: the same character, at least as long, alone on its line. */
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
/** Escapable per CommonMark: ASCII punctuation, and nothing else. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/**
 * A span the scan treats as one unit: an excluded region (`construct: null`), or
 * a block-level construct reported at its opening line. Regions are produced in
 * document order and never overlap.
 */
interface Region {
   start: number;
   end: number;
   construct: RenderConstruct | null;
}

/** Offsets at which each line begins, so an offset resolves to a line number. */
function lineStartsOf(text: string): number[] {
   const starts = [0];
   for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
   return starts;
}

/** The 0-based line an offset falls on. */
function lineOf(starts: number[], offset: number): number {
   let lo = 0;
   let hi = starts.length - 1;
   while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
   }
   return lo;
}

/** One line's text, without its line terminator (CRLF included). */
function lineTextAt(text: string, starts: number[], li: number): string {
   const end = li + 1 < starts.length ? starts[li + 1] : text.length;
   return text.slice(starts[li], end).replace(/\r?\n$/, '');
}

/** The offset just past a line's terminator. */
function lineEndOf(text: string, starts: number[], li: number): number {
   return li + 1 < starts.length ? starts[li + 1] : text.length;
}

/** Leading spaces, capped at the four that would make the line indented code. */
function indentOf(line: string): number {
   let n = 0;
   while (n < 4 && (line[n] === ' ' || line[n] === '\t')) n++;
   return n;
}

/**
 * The block pass: frontmatter, fenced code, HTML comments (all excluded), and
 * the HTML blocks that report as `raw-html` at their opening line. Line-based
 * and in document order, so a fence inside a comment is comment text and a
 * comment inside a fence is code — whichever opens first wins.
 */
function blockRegions(text: string, starts: number[]): Region[] {
   const regions: Region[] = [];
   const n = text.length;
   let li = 0;

   // Frontmatter, by the SDK's own boundary (a LEADING block only; a `---` later
   // in the document is a thematic break, and an unterminated block is prose).
   const fm = parseFrontmatter(text);
   if (fm.body.length !== n) {
      const end = n - fm.body.length;
      regions.push({ start: 0, end, construct: null });
      li = end >= n ? starts.length : lineOf(starts, end);
   }

   while (li < starts.length) {
      const line = lineTextAt(text, starts, li);
      const indent = indentOf(line);
      if (indent >= 4) {
         li++;
         continue;
      }
      const rest = line.slice(indent);
      const at = starts[li] + indent;

      const fence = FENCE_OPEN.exec(rest);
      if (fence !== null && (fence[1][0] === '~' || !fence[2].includes('`'))) {
         let close = li + 1;
         for (; close < starts.length; close++) {
            const candidate = lineTextAt(text, starts, close);
            const m = FENCE_CLOSE.exec(candidate.slice(indentOf(candidate)));
            if (m !== null && m[1][0] === fence[1][0] && m[1].length >= fence[1].length) break;
         }
         const last = Math.min(close, starts.length - 1);
         regions.push({ start: starts[li], end: lineEndOf(text, starts, last), construct: null });
         li = last + 1;
         continue;
      }

      // A comment opening a line is CommonMark HTML block type 2: it runs to the
      // line carrying `-->`, and the whole of that line belongs to it. Comments
      // are the one HTML form the profile excepts, so the region reports nothing.
      if (rest.startsWith('<!--')) {
         const close = text.indexOf('-->', at + 4);
         const last = close === -1 ? starts.length - 1 : lineOf(starts, close + 3);
         regions.push({ start: starts[li], end: lineEndOf(text, starts, last), construct: null });
         li = last + 1;
         continue;
      }

      // CommonMark HTML blocks 3, 4 and 5: a processing instruction, a declaration,
      // or a CDATA section opening a line is a BLOCK, running to the line carrying
      // its terminator (`?>`, `>`, `]]>`) and ending with that whole line — so what
      // follows the terminator on it is block content, never a second construct. An
      // unterminated one runs to the end of the document, as the comment form does.
      // Type 4 takes an ASCII letter of either case, so `<!foo` opens a block exactly
      // as `<!DOCTYPE` does — everything through the next `>` disappears from the page.
      const terminator = rest.startsWith('<?')
         ? '?>'
         : rest.startsWith('<![CDATA[')
           ? ']]>'
           : /^<![A-Za-z]/.test(rest)
             ? '>'
             : null;
      if (terminator !== null) {
         const close = text.indexOf(terminator, at);
         const last = close === -1 ? starts.length - 1 : lineOf(starts, close);
         regions.push({ start: starts[li], end: lineEndOf(text, starts, last), construct: 'raw-html' });
         li = last + 1;
         continue;
      }

      if (RAW_TEXT_OPEN.test(rest)) {
         const rel = text.slice(at).search(RAW_TEXT_CLOSE);
         const last = rel === -1 ? starts.length - 1 : lineOf(starts, at + rel);
         regions.push({ start: starts[li], end: lineEndOf(text, starts, last), construct: 'raw-html' });
         li = last + 1;
         continue;
      }

      // Type 6 (a known block tag opens the line) and type 7 (any complete tag
      // alone on a line, which cannot interrupt a paragraph). Both run to the
      // next blank line, so the tags closing them are block content.
      const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)([ \t]|\/?>|$)/.exec(rest);
      const previousBlank = li === 0 || lineTextAt(text, starts, li - 1).trim() === '';
      const isBlock = (tag !== null && BLOCK_TAGS.has(tag[1].toLowerCase())) || (previousBlank && wholeLineIsTag(rest));
      if (isBlock) {
         let close = li + 1;
         while (close < starts.length && lineTextAt(text, starts, close).trim() !== '') close++;
         regions.push({ start: starts[li], end: lineEndOf(text, starts, close - 1), construct: 'raw-html' });
         li = close;
         continue;
      }
      li++;
   }
   return regions;
}

/** True when the line is one complete open or closing tag and nothing else. */
function wholeLineIsTag(rest: string): boolean {
   for (const re of [OPEN_TAG, CLOSE_TAG]) {
      re.lastIndex = 0;
      const m = re.exec(rest);
      if (m !== null && rest.slice(m[0].length).trim() === '') return true;
   }
   return false;
}

/** The end of the region containing `i`, or `i` when it is outside every one. */
function skipRegion(regions: Region[], i: number): number {
   for (const r of regions) if (i >= r.start && i < r.end) return r.end;
   return i;
}

/** The length of the run of `ch` starting at `i`. */
function runLength(text: string, i: number, ch: string): number {
   let n = 0;
   while (i + n < text.length && text[i + n] === ch) n++;
   return n;
}

/**
 * A code span: a backtick run closed by a run of exactly the same length. An
 * unclosed run is literal text, so the scan resumes just past it. Inline state
 * never crosses a block boundary: a candidate whose closer would lie beyond an
 * excluded or block region is unclosed AT that boundary, because the region ends
 * the paragraph the run opened in — so constructs after the region still report.
 */
function afterCodeSpan(text: string, regions: Region[], i: number): number {
   const open = runLength(text, i, '`');
   let j = i + open;
   while (j < text.length) {
      if (skipRegion(regions, j) !== j) break;
      if (text[j] === '`') {
         const run = runLength(text, j, '`');
         if (run === open) return j + run;
         j += run;
         continue;
      }
      j++;
   }
   return i + open;
}

/**
 * The next unescaped `$$` at or after `from`, or -1. A delimiter is a closer only
 * where a delimiter can be read: not inside a code span, not inside a comment, and
 * not on the far side of a block boundary — a pair no more bridges a region than a
 * code span does, so an open whose apparent mate sits in one of them is unpaired,
 * which is prose.
 */
function nextMathDelimiter(text: string, regions: Region[], from: number): number {
   let j = from;
   while (j < text.length - 1) {
      if (skipRegion(regions, j) !== j) return -1;
      if (text[j] === '\\' && ESCAPABLE.test(text[j + 1] ?? '')) {
         j += 2;
         continue;
      }
      if (text[j] === '`') {
         j = afterCodeSpan(text, regions, j);
         continue;
      }
      if (text.startsWith('<!--', j)) {
         const close = text.indexOf('-->', j + 4);
         j = close === -1 ? text.length : close + 3;
         continue;
      }
      if (text[j] === '$' && text[j + 1] === '$') return j;
      j++;
   }
   return -1;
}

/** An inline raw-HTML form at `i`, as its end offset, or -1. */
function inlineHtmlEnd(text: string, i: number): number {
   for (const re of [CDATA, PROCESSING, DECLARATION, CLOSE_TAG, OPEN_TAG]) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m !== null) return i + m[0].length;
   }
   return -1;
}

/**
 * Every reported construct in one markdown document, ordered by (line,
 * construct) — the order the export's findings carry, and the tie-breaker that
 * keeps two constructs on one line deterministic across the three SDKs.
 */
export function scanRenderConstructs(text: string): RenderHit[] {
   const starts = lineStartsOf(text);
   const regions = blockRegions(text, starts);
   const seen = new Set<string>();
   const hits: RenderHit[] = [];
   const record = (offset: number, construct: RenderConstruct): void => {
      const line = lineOf(starts, offset) + 1;
      const key = `${line} ${construct}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ line, construct });
   };

   for (const r of regions) if (r.construct !== null) record(r.start, r.construct);

   // The inline pass: one left-to-right walk, so the earliest-starting match
   // wins every overlap and each match is consumed whole.
   let i = 0;
   while (i < text.length) {
      const skip = skipRegion(regions, i);
      if (skip !== i) {
         i = skip;
         continue;
      }
      const c = text[i];
      if (c === '\\' && ESCAPABLE.test(text[i + 1] ?? '')) {
         i += 2;
         continue;
      }
      if (c === '`') {
         i = afterCodeSpan(text, regions, i);
         continue;
      }
      if (c === '<') {
         if (text.startsWith('<!--', i)) {
            const close = text.indexOf('-->', i + 4);
            i = close === -1 ? text.length : close + 3;
            continue;
         }
         const end = inlineHtmlEnd(text, i);
         if (end !== -1) {
            record(i, 'raw-html');
            i = end;
            continue;
         }
         i++;
         continue;
      }
      if (c === '[' && text[i + 1] === '^') {
         FOOTNOTE.lastIndex = i;
         const m = FOOTNOTE.exec(text);
         if (m !== null) {
            record(i, 'footnote');
            i += m[0].length;
            continue;
         }
         i++;
         continue;
      }
      if (c === '$' && text[i + 1] === '$') {
         const close = nextMathDelimiter(text, regions, i + 2);
         if (close !== -1) {
            record(i, 'math-block');
            i = close + 2;
            continue;
         }
         // Unpaired: prose, and the scan carries on past it.
         i += 2;
         continue;
      }
      i++;
   }

   hits.sort((a, b) => a.line - b.line || (a.construct < b.construct ? -1 : a.construct > b.construct ? 1 : 0));
   return hits;
}

/** The scan as findings for one document: `warning` severity, the repository-
 * relative path the export carries it at, the opening line, and the token. */
export function renderLintFindings(relPath: string, text: string): Finding[] {
   return scanRenderConstructs(text).map((hit) => ({
      rule: RENDER_UNSUPPORTED_RULE,
      severity: 'warning' as const,
      path: relPath,
      line: hit.line,
      construct: hit.construct,
      message: renderUnsupportedMessage(hit.construct),
   }));
}
