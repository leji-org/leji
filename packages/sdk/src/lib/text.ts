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
