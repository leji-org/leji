import * as path from 'node:path';
import { type Finding } from './findings.js';
import { exists, isDir, isFile, resolvedWithinRoot } from './fsx.js';
import { ESCAPABLE, proseRegions } from './renderlint.js';

/**
 * The in-layer link scan: given one markdown document, the link destinations in it
 * and, for each, whether it resolves to something the layer actually carries. Like
 * the rendering lint beside it, this module is the executable contract the Go and
 * Python SDKs port, so the grammar is stated here once, in the order it is applied.
 *
 * Only prose is scanned (`proseRegions`), so a destination inside a fenced block, a
 * code span, or the frontmatter is text rather than a link. Within prose:
 *
 * ```
 * link   := "!"? "[" label "]" "(" dest title? ")"
 * refdef := line-start(<= 3 spaces) "[" label "]" ":" spaces dest (spaces title)? line-end
 * label  := any run up to the first unescaped "]"
 * dest   := "<" any run without "<", ">" or a newline ">"      (the brackets are stripped)
 *         | run
 * run    := ( "\" punctuation | "(" run ")" | not(space, tab, newline, "(", ")") )+
 * title  := '"' no-newline '"' | "'" no-newline "'" | "(" no-newline ")"
 * ```
 *
 * `](` is one token: a link whose bracket and parenthesis are split across a line
 * break is not a link, and neither is one whose destination carries a newline. The
 * parentheses in a bare destination nest exactly one level (`dir/(x).md`), the
 * title is read only to find the closing `)` and is then discarded, and autolinks
 * and raw HTML are not links at all: `<a href>` is outside the rendering subset,
 * and an autolink is a URL, which this rule never judges.
 */

/** The one rule this scan produces. */
export const LINK_UNRESOLVED_RULE = 'link-unresolved';

/** The shared message template. Identical bytes in all three SDKs by convention,
 * outside the fixture contract by design. */
export function linkUnresolvedMessage(target: string): string {
   return `link target "${target}" does not resolve`;
}

/** One link found in a document: the destination exactly as written (the angle
 * brackets of the `<...>` form excepted, which are delimiters), and the 1-based
 * line the link opens on. */
export interface ScannedLink {
   target: string;
   line: number;
}

/** A URI scheme, which is what makes a destination somebody else's to resolve —
 * `https:`, `mailto:`, `data:` and every other. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A reference definition's opening: a label carrying no bracket of its own, and
 * the colon. Its position on the line is checked by the scan, which knows where the
 * line began; the indent a definition may carry is up to three spaces. */
const REFERENCE_OPEN = /^\[[^\]\n]+\]:[ \t]*/;
/** The most a line may be indented before it is code rather than prose. */
const REFERENCE_INDENT = /^ {0,3}$/;

function isSpace(c: string | undefined): boolean {
   return c === ' ' || c === '\t';
}

/** The offset just past the run of spaces and tabs at `i`. */
function skipSpaces(text: string, i: number): number {
   let j = i;
   while (isSpace(text[j])) j++;
   return j;
}

/**
 * A destination at `i`, as written, and the offset just past it; null when none can
 * be read there — an empty run, an unterminated angle form, a newline inside either,
 * or parentheses nested past the one level a destination may carry.
 */
function destinationAt(text: string, i: number): { target: string; end: number } | null {
   if (text[i] === '<') {
      let j = i + 1;
      while (j < text.length) {
         const c = text[j];
         if (c === '\\' && ESCAPABLE.test(text[j + 1] ?? '')) {
            j += 2;
            continue;
         }
         if (c === '\n' || c === '<') return null;
         if (c === '>') return { target: text.slice(i + 1, j), end: j + 1 };
         j++;
      }
      return null;
   }
   let j = i;
   let depth = 0;
   while (j < text.length) {
      const c = text[j];
      if (c === '\\' && ESCAPABLE.test(text[j + 1] ?? '')) {
         j += 2;
         continue;
      }
      if (c === '\n' || isSpace(c)) break;
      if (c === '(') {
         if (depth === 1) return null;
         depth++;
      } else if (c === ')') {
         if (depth === 0) break;
         depth--;
      }
      j++;
   }
   return depth !== 0 || j === i ? null : { target: text.slice(i, j), end: j };
}

/** The offset just past a title at `i`, or -1 when none stands there. */
function titleEnd(text: string, i: number): number {
   const open = text[i];
   const close = open === '(' ? ')' : open;
   if (open !== '"' && open !== "'" && open !== '(') return -1;
   let j = i + 1;
   while (j < text.length) {
      const c = text[j];
      if (c === '\\' && ESCAPABLE.test(text[j + 1] ?? '')) {
         j += 2;
         continue;
      }
      if (c === '\n') return -1;
      if (c === close) return j + 1;
      j++;
   }
   return -1;
}

/** The offset just past the optional title and the `)` closing an inline link at
 * `i`, or -1 when the link does not close there. */
function inlineCloseAt(text: string, i: number): number {
   let j = skipSpaces(text, i);
   if (j > i) {
      const t = titleEnd(text, j);
      if (t !== -1) j = skipSpaces(text, t);
   }
   return text[j] === ')' ? j + 1 : -1;
}

/** The offset just past the unescaped `]` closing a label opened at `i`, or -1. */
function labelEnd(text: string, i: number): number {
   let j = i + 1;
   while (j < text.length) {
      const c = text[j];
      if (c === '\\' && ESCAPABLE.test(text[j + 1] ?? '')) {
         j += 2;
         continue;
      }
      if (c === ']') return j + 1;
      j++;
   }
   return -1;
}

/** An inline link (or image) opening at the `[` at `i`: its destination and the
 * offset just past the whole construct, or null when nothing there is a link. */
function inlineLinkAt(text: string, i: number): { target: string; end: number } | null {
   const label = labelEnd(text, i);
   if (label === -1 || text[label] !== '(') return null;
   const dest = destinationAt(text, label + 1);
   if (dest === null) return null;
   const end = inlineCloseAt(text, dest.end);
   return end === -1 ? null : { target: dest.target, end };
}

/** A reference definition opening at `i`, which is known to be a line start: its
 * destination and the offset just past the line, or null. The remainder of the line
 * must be empty or one title — `[^1]: a footnote's prose` is neither, and is prose. */
function referenceDefinitionAt(text: string, i: number): { target: string; end: number } | null {
   const newline = text.indexOf('\n', i);
   const line = text.slice(i, newline === -1 ? text.length : newline);
   const open = REFERENCE_OPEN.exec(line);
   if (open === null) return null;
   const dest = destinationAt(text, i + open[0].length);
   if (dest === null) return null;
   let j = skipSpaces(text, dest.end);
   if (j > dest.end) {
      const t = titleEnd(text, j);
      if (t !== -1) j = skipSpaces(text, t);
   }
   return j === i + line.length ? { target: dest.target, end: j } : null;
}

/** Every link destination in one markdown document, in document order. */
export function scanLinks(text: string): ScannedLink[] {
   const links: ScannedLink[] = [];
   for (const region of proseRegions(text)) {
      const body = region.text;
      let line = region.line;
      // Where the current line began, or -1 while the region resumes one that started
      // outside it (after a code span), where no definition can open.
      let lineStart = region.column === 0 ? 0 : -1;
      let i = 0;
      // The scan advances only forward, so the coordinates ride along with it.
      const advance = (to: number): void => {
         for (let k = i; k < to; k++) {
            if (body[k] !== '\n') continue;
            line++;
            lineStart = k + 1;
         }
         i = to;
      };
      while (i < body.length) {
         if (body[i] === '[') {
            const definition =
               lineStart !== -1 && REFERENCE_INDENT.test(body.slice(lineStart, i))
                  ? referenceDefinitionAt(body, i)
                  : null;
            // A label at a line start that no definition closes may still open an
            // inline link, so both forms are tried at the same bracket.
            const found = definition ?? inlineLinkAt(body, i);
            if (found !== null) {
               links.push({ target: found.target, line });
               advance(found.end);
               continue;
            }
         }
         advance(i + 1);
      }
   }
   return links;
}

/** Markdown backslash escapes removed: `\(` is a literal `(` on disk, and the
 * generated links the viewer emits carry that spelling. Only ASCII punctuation is
 * escapable, so every other backslash is itself a character of the path. */
function unescapeMarkdown(target: string): string {
   let out = '';
   for (let i = 0; i < target.length; i++) {
      if (target[i] === '\\' && ESCAPABLE.test(target[i + 1] ?? '')) {
         out += target[i + 1];
         i++;
      } else {
         out += target[i];
      }
   }
   return out;
}

/**
 * The absolute path a destination points at, or null when this rule does not judge
 * it: a URI scheme (`mailto:` and `data:` included), a bare fragment, or an empty
 * destination. A leading `/` resolves against the layer's `rootPath`, which is how
 * the viewer resolves one; everything else resolves against the linking document's
 * own directory. Escapes come off first, then `#fragment` and `?query`, then
 * percent-encoding — an undecodable target stays as written rather than being
 * dropped, so a mistyped escape is reported rather than silently passed.
 */
export function resolveLinkTarget(
   rootAbs: string,
   layerRootAbs: string,
   fromRelPath: string,
   target: string,
): string | null {
   if (target === '' || target.startsWith('#') || SCHEME.test(target)) return null;
   let cleaned = unescapeMarkdown(target).split('#')[0].split('?')[0];
   if (cleaned === '') return null;
   try {
      cleaned = decodeURIComponent(cleaned);
   } catch {
      // Not valid percent-encoding: judge the target exactly as it was written.
   }
   return cleaned.startsWith('/')
      ? path.resolve(layerRootAbs, `.${cleaned}`)
      : path.resolve(rootAbs, path.posix.dirname(fromRelPath), cleaned);
}

/**
 * A directory resolves only when it carries a `README.md` (nothing else tells a
 * reader which document the directory stands for); a file of any kind resolves by
 * existing, a dangling symlink therefore not at all.
 *
 * The README is a SECOND target, so it is contained before it is examined, by the
 * same rule and the same realpath-aware primitive the directory itself passed: a
 * directory inside the layer whose `README.md` links out of it stands for a document
 * this layer does not carry, and no existence test may be the first thing to touch
 * an outside-root path.
 */
function targetResolves(rootAbs: string, abs: string): boolean {
   if (!isDir(abs)) return exists(abs);
   const readme = path.join(abs, 'README.md');
   return resolvedWithinRoot(rootAbs, readme) && isFile(readme);
}

/**
 * The scan as findings for one governed document. Containment is checked before
 * existence and with the same realpath-aware primitive the write guards use, so a
 * target reaching outside the layer — by `..`, or through a symlink inside it — is
 * unresolved whether or not something happens to sit there.
 */
export function linkFindings(rootAbs: string, layerRootAbs: string, relPath: string, text: string): Finding[] {
   const findings: Finding[] = [];
   for (const { target, line } of scanLinks(text)) {
      const abs = resolveLinkTarget(rootAbs, layerRootAbs, relPath, target);
      if (abs === null) continue;
      if (resolvedWithinRoot(rootAbs, abs) && targetResolves(rootAbs, abs)) continue;
      findings.push({
         rule: LINK_UNRESOLVED_RULE,
         severity: 'error',
         path: relPath,
         line,
         construct: target,
         message: linkUnresolvedMessage(target),
      });
   }
   return findings;
}
