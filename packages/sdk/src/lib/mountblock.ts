/**
 * Parser for a boot profile's `leji-mounts` blocks: the machine-checkable half of
 * the federated-siblings requirement (spec `boot-profile.md`, requirement 9).
 *
 * A host that declares `federation.mounts` surfaces each sibling in its boot
 * profile, in the author's task language, through a constrained block:
 *
 * ```leji-mounts
 * - mount: acme-product-context
 *   owner: Product team
 *   carries: product-side domain language and the decisions behind it
 *   read-when: a task touches product behavior, product terminology, or billing
 * ```
 *
 * Grammar, frozen so the Go and Python ports parse it identically:
 *
 * - Fence recognition is the shared `leji-index` scanner (`scanFencedBlocks`) in
 *   its ASCII mode: three or more backticks, then the tag, then end of line or
 *   whitespace and any remainder, and any closing fence of three or more
 *   backticks. The info string is the tag ALONE, so a nonempty remainder (one
 *   token or several) is an error naming it, never an ignored fence; a fence whose
 *   tag merely prefixes another word (`leji-mountsx`) names a different grammar and
 *   opens nothing. One or MORE blocks may appear anywhere in the document; their
 *   entries concatenate in document order.
 * - Whitespace, everywhere in this grammar, is ASCII space (U+0020) and tab
 *   (U+0009) and nothing else: fence indent, fence padding, the blank-line and
 *   comment tests, and field indentation are all scanned with an explicit `[ \t]`
 *   alphabet, never a runtime whitespace class. This is the porting contract:
 *   JavaScript `trim`/`\s`, Python `strip`, and Go's `unicode.IsSpace` disagree on
 *   characters such as U+0085 and U+00A0, so a `\s` port could disagree about
 *   whether a fence or a field line is even there.
 * - A record begins at column 1 with `- mount: `; its fields are indented exactly
 *   two ASCII spaces. Within a record `owner`, `carries`, and `read-when` each
 *   appear exactly once, in any order. Unknown fields, duplicate fields, missing
 *   fields, and misindented lines are errors.
 * - A value is the nonempty remainder of its physical line after the `key: `
 *   prefix, with no leading or trailing space/tab and no control or line/paragraph
 *   separator character (which is what makes a value single-line by construction).
 * - Blank lines and full lines starting `#` are ignored, matching `leji-index`.
 * - Errors are returned sorted by source line (stable within a line), so a reader
 *   and every port see them in the order the file reads, not in the order the
 *   parser happened to detect them (a record's missing-field errors are raised at
 *   its closing boundary but belong to its `- mount:` line).
 * - Lines split on LF with a trailing CR stripped (CRLF tolerated); a CR anywhere
 *   else lands inside a value and is rejected as a control character. File content
 *   is UTF-8 (decoded by the reader before it reaches this parser).
 *
 * The parser reports grammar only. Whether an entry names a declared mount, and
 * whether its owner matches the declaration, is the validator's cross-check
 * against the manifest; the fidelity of `carries` and `read-when` to what the
 * sibling actually holds is authored task language and is not machine-checked.
 */

import { scanFencedBlocks, stripAsciiPad } from './indexfile.js';

/** One surfaced sibling, as authored in the block. */
export interface MountBlockEntry {
   mount: string;
   owner: string;
   carries: string;
   readWhen: string;
   /** 1-based line of the record's `- mount:` line, for diagnostics. */
   line: number;
}

export interface MountBlockError {
   /** 1-based line the error points at. */
   line: number;
   message: string;
}

export interface ParsedMountBlocks {
   /** Entries from every block, concatenated in document order. */
   entries: MountBlockEntry[];
   /** Grammar errors sorted by source line; parsing never stops at the first. */
   errors: MountBlockError[];
   /** True when the document carries at least one `leji-mounts` fence, empty or not. */
   sawBlock: boolean;
}

// `s` so a stray CR (or any other line terminator a split on LF left behind) is
// captured into the value and rejected there, rather than making the line itself
// unparseable and reporting the wrong thing.
const RECORD = /^- mount: (.*)$/s;
const FIELD = /^ {2}([^ \t:]+): (.*)$/s;
/** Any line that looks like a `key: value` field, whatever its indentation. */
const FIELD_ANY = /^[ \t]*[^ \t:]+: /;
/** C0 and C1 controls (CR, LF, and tab among them) plus the Unicode line and
 * paragraph separators. Splitting on these differs across runtimes (Python's
 * `splitlines` recognizes U+2028; JavaScript and Go do not), so a value carrying
 * one is rejected rather than parsed differently by each port. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

const FIELDS = ['owner', 'carries', 'read-when'] as const;
type FieldName = (typeof FIELDS)[number];

/**
 * Why a string cannot be carried as a block value, or null when it can. Shared
 * with the validator so a manifest identity the block could never express (an
 * empty, padded, or multi-line `owner.name`) is reported against the manifest
 * rather than surfacing as an unfixable mismatch.
 */
export function valueRepresentationError(value: string): string | null {
   if (value === '') return 'the value is empty';
   if (/^[ \t]|[ \t]$/.test(value)) return 'the value has leading or trailing whitespace';
   if (CONTROL.test(value)) return 'the value carries a control or line-separator character';
   return null;
}

/** Parse every `leji-mounts` block in a boot profile. */
export function parseMountBlocks(text: string): ParsedMountBlocks {
   const entries: MountBlockEntry[] = [];
   const errors: MountBlockError[] = [];
   const scan = scanFencedBlocks(text, 'leji-mounts');

   let open: { mount: string; line: number; valid: boolean; fields: Map<FieldName, string> } | null = null;
   const closeRecord = (): void => {
      const record = open;
      if (record === null) return;
      open = null;
      for (const field of FIELDS) {
         if (!record.fields.has(field)) {
            errors.push({ line: record.line, message: `mount "${record.mount}" is missing the "${field}" field` });
            record.valid = false;
         }
      }
      if (record.valid) {
         entries.push({
            mount: record.mount,
            owner: record.fields.get('owner')!,
            carries: record.fields.get('carries')!,
            readWhen: record.fields.get('read-when')!,
            line: record.line,
         });
      }
   };

   for (const block of scan.blocks) {
      // The info string is the tag alone. Whatever follows it, one token or several,
      // arrives here as the block's remainder and is a targeted error naming it in
      // full; the block is consumed either way, so a typo never degrades to prose.
      if (block.token !== undefined) {
         errors.push({
            line: block.openLine,
            message: `the leji-mounts info string carries nothing after the tag, but this fence declares "${block.token}"`,
         });
      }
      for (const { text: raw, line } of block.lines) {
         const trimmed = stripAsciiPad(raw);
         if (trimmed === '' || trimmed.startsWith('#')) continue;
         const record = RECORD.exec(raw);
         if (record) {
            closeRecord();
            const name = record[1];
            const bad = valueRepresentationError(name);
            if (bad) errors.push({ line, message: `mount name is unusable: ${bad}` });
            open = { mount: name, line, valid: bad === null, fields: new Map() };
            continue;
         }
         if (trimmed.startsWith('- mount:')) {
            errors.push({ line, message: 'a "- mount:" record must start at column 1, followed by one space' });
            if (open !== null) open.valid = false;
            continue;
         }
         const field = FIELD.exec(raw);
         if (!field) {
            errors.push({
               line,
               message: FIELD_ANY.test(raw)
                  ? 'a field line must be indented exactly two spaces, as "  <key>: <value>"'
                  : `unparseable line ${JSON.stringify(raw)} (expected "- mount: <name>" or "  <key>: <value>")`,
            });
            if (open !== null) open.valid = false;
            continue;
         }
         const [, key, value] = field;
         if (open === null) {
            errors.push({ line, message: `field "${key}" appears before any "- mount:" record` });
            continue;
         }
         if (!(FIELDS as readonly string[]).includes(key)) {
            errors.push({ line, message: `mount "${open.mount}" carries the unknown field "${key}"` });
            open.valid = false;
            continue;
         }
         const name = key as FieldName;
         if (open.fields.has(name)) {
            errors.push({ line, message: `mount "${open.mount}" declares the "${name}" field twice` });
            open.valid = false;
            continue;
         }
         const bad = valueRepresentationError(value);
         if (bad) {
            errors.push({ line, message: `mount "${open.mount}" field "${name}" is unusable: ${bad}` });
            open.valid = false;
            continue;
         }
         open.fields.set(name, value);
      }
      // A block boundary closes the record it opened: records never span blocks.
      closeRecord();
   }

   if (scan.unterminated) {
      errors.push({
         line: scan.blocks[scan.blocks.length - 1].openLine,
         message: 'unterminated leji-mounts block (no closing fence)',
      });
   }
   // Source-line order, stable within a line (Array.prototype.sort is stable, as
   // are Go's SliceStable and Python's sorted, which the ports use).
   errors.sort((a, b) => a.line - b.line);
   return { entries, errors, sawBlock: scan.blocks.length > 0 };
}
