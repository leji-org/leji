// The custom properties a stylesheet declares for one color scheme, read out of
// the file itself.
//
// A test that carries its own copy of a palette passes whatever the stylesheet
// says, which is the one thing such a test exists to catch. So the values are
// parsed from the source and judged there: a token edited below its floor, or a
// scheme block that stopped applying, fails where it was changed.
//
// The parsing stays deliberately small. These are this repository's own authored
// sheets, where a `:root` rule is a flat list of declarations and no brace appears
// inside a comment or a string, so comments can be removed up front and what is
// left is a nesting the braces alone describe. A CSS parser would be a larger
// surface than the thing it parses, and a forgiving one would answer where this
// has to fail.

/**
 * The dark scheme's media query, matched as a whole prelude: a compound query such
 * as `(prefers-color-scheme: dark) and (prefers-contrast: more)` is a different
 * block with different values, and is never taken for this one.
 */
const DARK_BLOCK = /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)\s*\{/;

/** A `:root` rule opening, at a rule boundary rather than anywhere in the text. */
const ROOT_RULE = /(?:^|[\s};]):root\s*\{/;

/**
 * One rule's declarations, by property name.
 *
 * `get` throws on a property the rule does not declare, because a token that
 * disappeared is exactly the defect a caller is looking for: handing back
 * `undefined` for an assertion to compare against reports it as a wrong value
 * instead of a missing one.
 */
export class Declarations extends Map<string, string> {
   readonly rule: string;

   constructor(rule: string, entries: Iterable<readonly [string, string]>) {
      super(entries);
      this.rule = rule;
   }

   get(property: string): string {
      const value = super.get(property);
      if (value === undefined) throw new Error(`${this.rule} declares no ${property}`);
      return value;
   }
}

/** The stylesheet with its comments replaced by a space, so a rule boundary is a
 * brace or whitespace and nothing else. */
function stripComments(css: string): string {
   return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** The nesting depth of the text at `index`: a rule the stylesheet declares
 * unconditionally sits at zero, a rule inside an at-rule block deeper. */
function depthAt(css: string, index: number): number {
   const before = css.slice(0, index);
   return before.split('{').length - before.split('}').length;
}

/** The declarations of the first `:root` rule opening at or after `from`. */
function rootDeclarations(css: string, from: number, rule: string): Declarations {
   const opening = ROOT_RULE.exec(css.slice(from));
   if (opening === null) throw new Error(`${rule} is missing from the stylesheet`);
   const start = from + opening.index + opening[0].length;
   const end = css.indexOf('}', start);
   if (end < 0) throw new Error(`${rule} is never closed`);

   const entries: [string, string][] = [];
   for (const declaration of css.slice(start, end).split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      entries.push([declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()]);
   }
   if (entries.length === 0) throw new Error(`${rule} declares nothing`);
   return new Declarations(rule, entries);
}

/** The declarations of the first `:root` rule the stylesheet applies
 * unconditionally, so a rule nested in a scheme block is never read as one. */
function topLevelRoot(css: string, rule: string): Declarations {
   const source = stripComments(css);
   for (const opening of source.matchAll(new RegExp(ROOT_RULE, 'g'))) {
      if (depthAt(source, opening.index) === 0) return rootDeclarations(source, opening.index, rule);
   }
   throw new Error(`${rule} is missing from the stylesheet`);
}

/**
 * The declarations of the `:root` rule a two-scheme stylesheet applies
 * unconditionally, which is the light scheme's: the first one at the top level, so
 * a scheme block placed before it is never read as the default.
 */
export function lightTokens(css: string): Declarations {
   return topLevelRoot(css, 'the unconditional :root rule');
}

/**
 * The declarations of the `:root` rule of a sheet that carries one scheme and
 * nothing else, where the tokens are declared unconditionally and the link that
 * loads the sheet is what decides when they apply.
 */
export function sheetTokens(css: string): Declarations {
   return topLevelRoot(css, "the scheme sheet's :root rule");
}

/** The declarations of the `:root` rule inside the `prefers-color-scheme: dark`
 * block, which is where the dark scheme re-values the tokens. */
export function darkTokens(css: string): Declarations {
   const source = stripComments(css);
   const opening = DARK_BLOCK.exec(source);
   if (opening === null) throw new Error('the stylesheet declares no prefers-color-scheme: dark block');
   return rootDeclarations(source, opening.index + opening[0].length, 'the dark scheme :root rule');
}
