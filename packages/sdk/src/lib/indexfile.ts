/**
 * Parser for a category index file's `leji-index` block.
 *
 * An index file is curated markdown carrying one or more fenced blocks tagged
 * `leji-index`. The mini-format is deliberately small and dependency-free so all
 * three SDKs parse it identically:
 *
 * ```leji-index
 * - path: docs/invariants.md          # a single file
 * - path: docs/Wood-Badge/            # a whole directory (recursed)
 * ```
 *
 * The fence info string carries the block's kind. Exactly three forms are
 * valid: `leji-index` (intent, the default), `leji-index intent`, and
 * `leji-index record`. Any other token after `leji-index` is a targeted parse
 * error, never silently ignored: the grammar is finite by design.
 *
 * Rules: an entry line is exactly `- path: <repo-relative-posix-path>` with an
 * optional trailing ` # comment` (the `#` must be whitespace-preceded, so a `#`
 * inside a path is preserved). Blank lines and full-line `#` comments are ignored.
 * No quoting, nesting, or extra keys. A path may be a directory (recursed for
 * markdown) or a single `.md` file; resolution happens in the layer.
 *
 * **Whitespace anywhere in this grammar is ASCII space or tab, and nothing else**,
 * and a leading UTF-8 byte order mark is stripped before parsing. The three
 * runtimes' own whitespace classes disagree (U+0085, U+00A0, U+FEFF), so a grammar
 * spelled in them is not one grammar; see `scanFencedBlocks`.
 */

/** A document's kind: maintained present truth, or dated evidence. */
export type DocKind = 'intent' | 'record';

export interface IndexFileEntry {
   path: string;
   /** The block's declared kind (`intent` when the fence carries none). */
   kind: DocKind;
}

export interface ParsedIndexFile {
   entries: IndexFileEntry[];
   errors: string[];
}

/** ASCII-only fence recognition: indent and padding are space and tab, nothing else. */
const FENCE_CLOSE = /^[ \t]*`{3,}[ \t]*$/;
/** An entry line, on the same ASCII alphabet: `\s` is a different set of characters
 * in JavaScript, Go's `regexp`, and Python's `re`, and a grammar three SDKs parse
 * cannot be spelled in a class they disagree about. */
const ENTRY = /^-[ \t]+path:[ \t]+(.*)$/;
/** A trailing comment opens on a whitespace-preceded `#`, whitespace again meaning
 * space or tab and nothing else, so a `#` inside a path is kept. */
const TRAILING_COMMENT = /[ \t]#/;
const ASCII_PAD = /^[ \t]+|[ \t]+$/g;
/** U+FEFF as a leading character: a UTF-8 byte order mark, decoded. */
const BOM = '\ufeff';

/** Strip leading and trailing ASCII space/tab, and nothing else. The one padding
 * rule every grammar frozen on the ASCII alphabet uses, scanner and parser alike. */
export function stripAsciiPad(s: string): string {
   return s.replace(ASCII_PAD, '');
}

/** One fenced block a scan found: its info-string remainder and its body. */
export interface FencedBlock {
   /** The complete padding-stripped remainder of the info string, when it carries
    * anything. A fence opens on the tag alone and whatever follows it is handed to
    * the grammar to accept or reject, so a fence carrying junk is a reportable block
    * rather than a silently ignored one. */
   token?: string;
   /** 1-based line number of the opening fence. */
   openLine: number;
   /** Body lines verbatim (never trimmed), each with its 1-based line number. */
   lines: { text: string; line: number }[];
}

export interface FenceScan {
   blocks: FencedBlock[];
   /** True when a block ran to end of file with no closing fence. */
   unterminated: boolean;
}

/**
 * Scan every fenced block whose info string names `tag`, in document order.
 *
 * One scanner for every leji block grammar (`leji-index` here, `leji-mounts` in
 * the boot profile), so backtick counts, an optional info remainder, closing
 * fences, unclosed fences, and a block nested inside a longer markdown example
 * all behave identically wherever a block grammar is added. The scan is line
 * based and markdown structure blind by design: a `leji-index` fence inside a
 * four-backtick example block is a real block, in this scanner and in the Go and
 * Python ports.
 *
 * Lines split on LF with a trailing CR stripped (CRLF tolerated). `tag` is a
 * fixed literal supplied by the caller, never user input.
 *
 * **The whitespace alphabet is ASCII space and tab, scanned explicitly, and it is
 * the porting contract.** JavaScript's `\s` and `trim`, Python's `strip` and `re`,
 * and Go's `unicode.IsSpace` and `regexp` disagree about characters like U+0085 and
 * U+00A0, so a literal port of a `\s` scanner can disagree about whether a fence is
 * even there: a U+00A0 before a closing fence, or a BOM before an opening one, used
 * to decide the answer differently in each SDK. A fence opens on the tag followed by
 * end of line or by whitespace, and the whole remainder goes to the grammar. The tag
 * boundary is respected either way: `leji-mountsx` names a different tag and opens
 * nothing.
 *
 * A leading UTF-8 byte order mark is stripped first, identically everywhere. It can
 * only ever precede the first line, and letting it decide whether that line is a
 * fence is the same portability hazard one character further left.
 */
export function scanFencedBlocks(text: string, tag: string): FenceScan {
   const open = new RegExp(`^[ \\t]*\`{3,}[ \\t]*${tag}([ \\t].*)?$`, 's');
   const blocks: FencedBlock[] = [];
   const lines = (text.startsWith(BOM) ? text.slice(BOM.length) : text).split(/\r?\n/);
   let current: FencedBlock | null = null;
   for (let i = 0; i < lines.length; i++) {
      if (current === null) {
         const m = open.exec(lines[i]);
         if (m) {
            // The captured remainder is a token only once its padding is off.
            const rest = stripAsciiPad(m[1] ?? '') || undefined;
            current = rest === undefined ? { openLine: i + 1, lines: [] } : { token: rest, openLine: i + 1, lines: [] };
            blocks.push(current);
         }
         continue;
      }
      if (FENCE_CLOSE.test(lines[i])) {
         current = null;
         continue;
      }
      current.lines.push({ text: lines[i], line: i + 1 });
   }
   return { blocks, unterminated: current !== null };
}

/**
 * Parse every `leji-index` block in an index file. Multiple blocks are
 * concatenated in document order (so entries can be grouped under prose
 * headings), each entry carrying its block's kind; the Go and Python ports must
 * replicate this.
 */
export function parseIndexFile(text: string): ParsedIndexFile {
   const entries: IndexFileEntry[] = [];
   const errors: string[] = [];
   const seen = new Set<string>();
   const scan = scanFencedBlocks(text, 'leji-index');

   for (const block of scan.blocks) {
      // The kind token is validated here rather than in the scanner, so an unknown
      // token is a targeted error and the block is still consumed (its entries must
      // not fall back to parsing as prose).
      let blockKind: DocKind = 'intent';
      if (block.token !== undefined && block.token !== 'intent' && block.token !== 'record') {
         errors.push(
            `line ${block.openLine}: unknown leji-index block kind "${block.token}" (expected intent or record)`,
         );
      } else if (block.token === 'record') {
         blockKind = 'record';
      }
      for (const { text: raw, line } of block.lines) {
         // Every padding rule inside a block is the scanner's ASCII alphabet too, so
         // one U+00A0 cannot make an entry parse in one SDK and not in another.
         const trimmed = stripAsciiPad(raw);
         if (trimmed === '' || trimmed.startsWith('#')) continue;
         const m = ENTRY.exec(trimmed);
         if (!m) {
            errors.push(`line ${line}: unparseable entry ${JSON.stringify(raw)} (expected "- path: <path>")`);
            continue;
         }
         // Strip a trailing comment only when the `#` is whitespace-preceded, so a
         // `#` inside the path is kept.
         let p = m[1];
         const hashAt = p.search(TRAILING_COMMENT);
         if (hashAt >= 0) p = p.slice(0, hashAt);
         p = stripAsciiPad(p);
         if (p === '') {
            errors.push(`line ${line}: empty path`);
            continue;
         }
         if (p.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(p) || p.includes('\\')) {
            errors.push(`line ${line}: invalid path "${p}" (must be a repository-relative POSIX path)`);
            continue;
         }
         if (seen.has(p)) {
            errors.push(`line ${line}: duplicate path "${p}"`);
            continue;
         }
         seen.add(p);
         entries.push({ path: p, kind: blockKind });
      }
   }

   if (scan.unterminated) errors.push('unterminated leji-index block (no closing fence)');
   if (scan.blocks.length === 0) errors.push('no leji-index block found in this index file');
   return { entries, errors };
}
