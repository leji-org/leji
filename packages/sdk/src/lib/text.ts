/**
 * One text contract for every canonical surface, so the three SDKs agree byte for
 * byte: a single UTF-8 byte-order comparator, and a scalar-string guard at the
 * validation boundary that keeps ill-formed text out of hashing, sorting, and
 * output entirely.
 */

/**
 * UTF-8 byte-order comparison: the one comparator for every ordered canonical
 * surface (mount rows, findings, resolver state keys, viewer tables). Never
 * locale-sensitive, and identical to Go (which compares bytes) and Python (which
 * compares code points, the same order). JavaScript's own `<` compares UTF-16
 * code units, which orders astral characters before U+E000..U+FFFF where UTF-8
 * bytes order them after; this is the difference the comparator exists to remove.
 * Callers pass scalar strings only (see `isScalarString`): encoding an unpaired
 * surrogate substitutes U+FFFD and would compare something the input never said.
 */
export function byteCompare(a: string, b: string): number {
   return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * A well-formed Unicode scalar sequence: no unpaired surrogate. A JSON parser
 * accepts an escaped lone surrogate, but strict UTF-8 encoding of one raises in
 * some runtimes and silently substitutes U+FFFD in others, so the same document
 * would crash one implementation and produce output in another.
 */
export function isScalarString(s: string): boolean {
   return !/\p{Surrogate}/u.test(s);
}

/**
 * The one line-wrapper behind every terminal help surface, so the three SDKs emit
 * the same bytes: whitespace runs collapse to one space, the first line is indented
 * by `indentFirst` and every continuation by `indentRest`, and width is counted in
 * Unicode CODE POINTS — never UTF-16 units, which would measure an astral character
 * as two and wrap a line early in JavaScript alone. A token that cannot fit the
 * remaining width takes a line of its own, unbroken (URLs and flag spellings stay
 * copyable). Returns the finished lines, indents included; empty text yields none.
 */
/**
 * Terminal help wraps at a fixed width, never the actual terminal's: help bytes are
 * a shared contract across the three SDKs, so they may not depend on the environment.
 */
export const HELP_WIDTH = 80;

export function wrap(text: string, width: number, indentFirst: number, indentRest: number): string[] {
   const words = text.split(/\s+/).filter((w) => w !== '');
   if (words.length === 0) return [];
   const lines: string[] = [];
   let indent = indentFirst;
   let current = '';
   for (const word of words) {
      const room = width - indent - [...current].length;
      if (current === '') current = word;
      else if ([...word].length + 1 <= room) current += ' ' + word;
      else {
         lines.push(' '.repeat(indent) + current);
         indent = indentRest;
         current = word;
      }
   }
   lines.push(' '.repeat(indent) + current);
   return lines;
}

/**
 * One row of a two-column help block: a label on the left, its prose on the right,
 * the prose hanging under itself at `col`. A label that would leave no gap before
 * its summary — one at least as wide as the column, which the option column's clamp
 * makes reachable — takes the line alone and its summary starts on the next line at
 * the same column, so a long flag never concatenates into the text describing it.
 * Width is counted in code points, like `wrap` itself.
 */
export function helpRow(label: string, col: number, text: string, width = HELP_WIDTH): string[] {
   const lines = wrap(text, width, col, col);
   const labelWidth = [...label].length;
   if (labelWidth >= col - 3) {
      const head = `   ${label}`;
      return lines.length === 0 ? [head] : [head, ...lines];
   }
   // Padded by CODE POINTS, never `padEnd`: that counts UTF-16 units, so an astral
   // character in a flag or command name would pad two columns short and misalign the
   // whole block in JavaScript alone.
   const head = `   ${label}${' '.repeat(col - 3 - labelWidth)}`;
   if (lines.length === 0) return [head.trimEnd()];
   return [head + lines[0].slice(col), ...lines.slice(1)];
}

/**
 * Where a two-column block's right column starts: the longest label plus a gap, kept
 * inside a band so one long label cannot push every summary to the right edge, and
 * measured in CODE POINTS. Past the band's top the label outgrows the column and
 * `helpRow` gives it its own line. Every dynamic label class in terminal help resolves
 * its column here — the bounds are the class's contract, identical in all three SDKs.
 */
export function boundedColumn(labels: string[], gap: number, min: number, max: number): number {
   const longest = Math.max(0, ...labels.map((l) => [...l].length));
   return 3 + Math.min(max, Math.max(min, longest + gap));
}

/** Option rows, top-level and per-command: flags plus 3, bounded to [20, 30]. */
export function optionColumn(flags: string[]): number {
   return boundedColumn(flags, 3, 20, 30);
}

/** Command and alias rows: the name plus 3, bounded to [12, 30]. */
export function nameColumn(names: string[]): number {
   return boundedColumn(names, 3, 12, 30);
}

/** Exit-code rows: the code plus 2 (they are digits, not words), bounded to [3, 8]. */
export function exitCodeColumn(codes: string[]): number {
   return boundedColumn(codes, 2, 3, 8);
}
