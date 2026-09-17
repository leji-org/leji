import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lightTokens, sheetTokens } from '../../sdk/test/css-tokens.ts';

// The site's two color schemes, judged against the two stylesheets that ship them:
// the light palette, and the dark sheet the head links over it.
//
// Nothing below restates a palette value that a stylesheet declares: every tone
// is parsed out of the `:root` rule that carries it, so a token edited below its
// floor, or a scheme block that stopped applying, fails here rather than reaching
// a reader. The pairs are judged by the WCAG formula rather than by eye, because
// "the dark page still reads" is an arithmetic claim.
//
// The formula is WCAG 2.x relative luminance and contrast ratio, spelled out here
// rather than pulled in: it is nine lines, it is frozen, and a dependency for it
// would be a larger surface than the thing it computes.

/** sRGB channel, 0-255, linearized per WCAG 2.x. */
function channel(value: number): number {
   const c = value / 255;
   return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The three channels of a `#RRGGBB` color, 0-255. */
function channels(hex: string): [number, number, number] {
   const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
   assert.ok(match, `not a #RRGGBB color: ${hex}`);
   const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(match[1].slice(i, i + 2), 16));
   return [r, g, b];
}

/** WCAG relative luminance of a `#RRGGBB` color. */
function luminance(hex: string): number {
   const [r, g, b] = channels(hex).map(channel);
   return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * A token value as it is actually seen, over the ground it is painted on.
 *
 * Several tones in the palette are white or mint at an alpha, so what a reader sees
 * is a blend and not the value in the file. Comparing the declarations alone would
 * call `rgba(255, 255, 255, 0.84)` lighter than `#f7f8f5`, which on a dark band it
 * is not. The shared parser stays hex-only; this is the site's own arithmetic,
 * because only the site knows which ground each of its tones lands on.
 */
function over(value: string, ground: string): string {
   const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
   if (rgba === null) return value;
   const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
   const base = channels(ground);
   const blended = [1, 2, 3].map((i) => Math.round(Number(rgba[i]) * alpha + base[i - 1] * (1 - alpha)));
   return `#${blended.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG contrast ratio between two `#RRGGBB` colors, 1:1 to 21:1. */
function contrast(a: string, b: string): number {
   const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
   return (high + 0.05) / (low + 0.05);
}

/** AA for normal-size text. */
const AA_NORMAL = 4.5;
/** AA for large text, which is the only size `--leji-text-muted` is spent at. */
const AA_LARGE = 3;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const siteSrc = path.resolve(testDir, '..', 'src');
const cssFile = (name: string) => fs.readFileSync(path.join(siteSrc, 'styles', name), 'utf8');
const GLOBAL_CSS = cssFile('global.css');
const PALETTE_CSS = cssFile('palette.css');
const DARK_CSS = cssFile('dark.css');

/**
 * A token's value in the dark scheme: the dark sheet's own, or the light one it
 * deliberately keeps. The mark green, the mint accent, and the quieter lettering
 * on the deep bands hold their values across both schemes, so the dark sheet
 * declares nothing for them and their light value is what a dark page paints.
 */
function inDark(token: string): string {
   const dark = sheetTokens(DARK_CSS);
   return dark.has(token) ? dark.get(token) : lightTokens(PALETTE_CSS).get(token);
}

/**
 * The `:root` declarations of the dark sheet's high-contrast block.
 *
 * Read here rather than through the shared parser, which reads the rule a sheet
 * applies unconditionally and never the one behind a preference query. That is the
 * behavior this file wants on both sides: the two rules carry different values,
 * and each is asserted against the grounds it actually paints.
 */
function darkHighContrastTokens(css: string): Map<string, string> {
   const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
   const block = /@media\s*\(\s*prefers-contrast:\s*more\s*\)\s*\{/;
   const opening = block.exec(source);
   assert.ok(opening, 'the stylesheet carries a dark high-contrast block');
   const rule = /:root\s*\{([^}]*)\}/.exec(source.slice(opening.index + opening[0].length));
   assert.ok(rule, 'the dark high-contrast block re-values the tokens on :root');
   const declarations = new Map<string, string>();
   for (const line of rule[1].split(';')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      declarations.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
   }
   assert.ok(declarations.size > 0, 'the dark high-contrast :root rule declares something');
   return declarations;
}

/** What `:root[data-appearance='<choice>']` in the palette declares `color-scheme` to be. */
function forcedScheme(choice: string): string | undefined {
   const source = PALETTE_CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');
   const rule = new RegExp(`:root\\[data-appearance=['"]${choice}['"]\\]\\s*\\{([^}]*)\\}`).exec(source);
   assert.ok(rule, `the palette carries no rule for a forced ${choice} choice`);
   return /color-scheme:\s*([^;]+)/.exec(rule[1])?.[1].trim();
}

test('the stylesheets design both schemes and re-value the palette for the dark one', () => {
   const light = lightTokens(PALETTE_CSS);
   const dark = sheetTokens(DARK_CSS);

   // Both schemes are declared, so form controls, scrollbars, and the canvas the
   // browser paints before the sheet applies sit on the right ground, and a
   // browser's own darkening has nothing left to invert.
   assert.equal(light.get('color-scheme'), 'light dark');

   // And a reader who has chosen one of the two takes that scheme's native UI with
   // them, rather than the operating system's. The dark sheet's link answers for the
   // page; these two rules answer for everything the browser paints itself.
   assert.equal(forcedScheme('dark'), 'dark');
   assert.equal(forcedScheme('light'), 'light');

   // Every token the dark sheet names carries a value of its own. A sheet that
   // restated a light value would read as designed and paint as unchanged.
   for (const token of dark.keys()) {
      assert.notEqual(dark.get(token), light.get(token), `${token} still carries its light value in the dark sheet`);
   }
});

test('every text tone is AA on the page and on the surface, in both schemes', () => {
   const light = lightTokens(PALETTE_CSS);
   const value = { light: (token: string) => light.get(token), dark: inDark };

   for (const scheme of ['light', 'dark'] as const) {
      // The two grounds that carry running text: the page itself, and the cards
      // and panels that sit on it.
      for (const ground of ['--leji-canvas', '--leji-surface']) {
         for (const [tone, floor] of [
            ['--leji-text', AA_NORMAL],
            ['--leji-text-body', AA_NORMAL],
            ['--leji-link', AA_NORMAL],
            // The muted tone is a large-text tone in both schemes, and the palette
            // says so; this is the bound that keeps it one.
            ['--leji-text-muted', AA_LARGE],
         ] as const) {
            const [text, paper] = [value[scheme](tone), value[scheme](ground)];
            const ratio = contrast(text, paper);
            assert.ok(
               ratio >= floor,
               `${scheme}: ${tone} (${text}) is ${ratio.toFixed(2)}:1 on ${ground} (${paper}), below ${floor}:1`,
            );
         }
      }
   }
});

test('the deep bands carry their lettering in both schemes', () => {
   const light = lightTokens(PALETTE_CSS);
   const value = { light: (token: string) => light.get(token), dark: inDark };

   // The hero, the header and the footer are deep green in both schemes, one step
   // deeper in dark. Their text takes an ink token rather than a text tone,
   // because a text tone follows the page and these grounds do not.
   for (const scheme of ['light', 'dark'] as const) {
      for (const band of ['--leji-deep', '--leji-deepest']) {
         for (const ink of ['--leji-ink-on-deep', '--leji-ink-on-deep-soft']) {
            const [text, ground] = [value[scheme](ink), value[scheme](band)];
            const ratio = contrast(text, ground);
            assert.ok(
               ratio >= AA_NORMAL,
               `${scheme}: ${ink} (${text}) is ${ratio.toFixed(2)}:1 on ${band} (${ground}), below AA`,
            );
         }
      }
   }
});

test('the ink tokens read on the grounds that do not follow the page', () => {
   const light = lightTokens(PALETTE_CSS);
   const value = { light: (token: string) => light.get(token), dark: inDark };

   // The mint is identity and holds its value in both schemes, so the text on it
   // is the thing that has to move: the skip link, the selection highlight, the
   // step numbers and the chart's core label all take this pair.
   for (const scheme of ['light', 'dark'] as const) {
      const [ink, mint] = [value[scheme]('--leji-ink-on-accent'), value[scheme]('--leji-accent')];
      const ratio = contrast(ink, mint);
      assert.ok(ratio >= AA_NORMAL, `${scheme}: --leji-ink-on-accent (${ink}) is ${ratio.toFixed(2)}:1 on the mint`);
   }

   // The primary button: the accessible green in light, the mint in dark, with the
   // label cut for whichever ground it lands on.
   for (const scheme of ['light', 'dark'] as const) {
      const [label, ground] = [value[scheme]('--leji-ink-on-cta'), value[scheme]('--leji-brand-dark')];
      const ratio = contrast(label, ground);
      assert.ok(
         ratio >= AA_NORMAL,
         `${scheme}: --leji-ink-on-cta (${label}) is ${ratio.toFixed(2)}:1 on --leji-brand-dark (${ground})`,
      );
   }

   // That button's hover ground is lifted in dark rather than brightened, so the
   // label still holds; in light the hover moment is the vivid brand green, which
   // the landing page's own rule documents as a hover state and not a text pair.
   const [label, hover] = [inDark('--leji-ink-on-cta'), inDark('--leji-cta-hover')];
   const hoverRatio = contrast(label, hover);
   assert.ok(
      hoverRatio >= AA_NORMAL,
      `dark: --leji-ink-on-cta (${label}) is ${hoverRatio.toFixed(2)}:1 on --leji-cta-hover (${hover})`,
   );
});

/** AAA for normal-size text, which is what the preference is asking for. */
const AAA_NORMAL = 7;

test('the high-contrast preference strengthens the dark scheme on its own ground', () => {
   const strengthened = darkHighContrastTokens(DARK_CSS);

   // What "strengthened" means is a relation, not a list of values: on every ground
   // the dark scheme paints, each tone the preference re-values reads at least as
   // well as the tone it replaces, and text clears AAA. Stating the six values here
   // instead would only assert that the file says what the file says, and would pass
   // a pair that had drifted below the plain scheme it is meant to improve on.
   //
   // The comparison is on effective colors: the tones the preference replaces are
   // white and mint at an alpha, so each one is composited over its ground first.
   for (const [tone, grounds, floor] of [
      ['--white-strong', ['--leji-deep', '--leji-deepest'], AAA_NORMAL],
      ['--white-soft', ['--leji-deep', '--leji-deepest'], AAA_NORMAL],
      ['--white-faint', ['--leji-deep', '--leji-deepest'], AAA_NORMAL],
      ['--leji-text-body', ['--leji-canvas', '--leji-surface'], AAA_NORMAL],
   ] as const) {
      for (const band of grounds) {
         const ground = inDark(band);
         const [strong, plain] = [over(strengthened.get(tone)!, ground), over(inDark(tone), ground)];
         const [ratio, was] = [contrast(strong, ground), contrast(plain, ground)];
         assert.ok(
            ratio >= was,
            `${tone} (${strong}) is ${ratio.toFixed(2)}:1 on ${band} (${ground}), below the ${was.toFixed(2)}:1 it strengthens`,
         );
         assert.ok(
            ratio >= floor,
            `${tone} (${strong}) is ${ratio.toFixed(2)}:1 on ${band} (${ground}), below ${floor}:1`,
         );
      }
   }

   // The two hairlines are not text and have no ratio to clear: what the preference
   // asks of them is that they be more visible, which on a dark page means lighter
   // than the tint the plain dark scheme draws on the same ground.
   for (const [rule, band] of [
      ['--leji-border', '--leji-canvas'],
      ['--leji-accent-rule', '--leji-deep'],
   ] as const) {
      const ground = inDark(band);
      const [strong, plain] = [over(strengthened.get(rule)!, ground), over(inDark(rule), ground)];
      assert.ok(
         luminance(strong) > luminance(plain),
         `${rule} (${strong}) is no lighter than the ${plain} it strengthens on ${band} (${ground})`,
      );
   }
});

// --- the two ways a token can be used against its own role ----------------------
//
// Both classes below are invisible in light, because the light values happen to
// suit: `--leji-surface` is white, which reads as text on a deep band, and a text
// tone is dark ink, which reads on the mint. In dark each one inverts and the text
// disappears into its ground. A scan of the authored rules catches the reappearance
// of either at the point it is written.

/** A ground token spent as a text tone. */
const GROUND_TOKENS = ['--leji-surface', '--leji-canvas'];
/** The grounds that hold their role whatever the scheme is, and so need ink of
 * their own rather than a tone that follows the page. */
const FIXED_GROUNDS = ['--leji-accent', '--leji-brand', '--leji-brand-dark', '--leji-deep', '--leji-deepest'];
/** The tones that follow the page. */
const TEXT_TOKENS = ['--leji-text', '--leji-text-body', '--leji-text-muted'];
/** The properties that paint text, lettering and marks. */
const TEXT_PROPERTIES = ['color', 'fill', 'stroke'];

/** One authored rule: the selector it was written under, and its declarations. */
interface Rule {
   sheet: string;
   selector: string;
   declarations: [string, string][];
}

/**
 * Every rule the site authors, from its three stylesheets and from the scoped
 * `<style>` block of each component and page.
 *
 * The parsing stays deliberately small, for the reason the shared token parser
 * gives: these are this repository's own authored sheets, where a declaration
 * ends at a semicolon and no brace or semicolon appears inside a comment or a
 * value. Matching the innermost braces is therefore enough to reach every rule,
 * and a rule inside a media query arrives with the query on the front of its
 * selector, which is exactly how the failure message wants to name it.
 */
function authoredRules(): Rule[] {
   const sheets: [string, string][] = [
      ['styles/global.css', GLOBAL_CSS],
      ['styles/palette.css', PALETTE_CSS],
      ['styles/dark.css', DARK_CSS],
   ];
   for (const entry of fs.readdirSync(siteSrc, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.astro')) continue;
      const source = fs.readFileSync(path.join(siteSrc, entry), 'utf8');
      for (const block of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) sheets.push([entry, block[1]]);
   }

   const rules: Rule[] = [];
   for (const [sheet, css] of sheets) {
      const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
      for (const match of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
         const declarations: [string, string][] = [];
         for (const line of match[2].split(';')) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            declarations.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
         }
         if (declarations.length > 0) {
            rules.push({
               sheet,
               selector: match[1]
                  .trim()
                  .split(/\s*\n\s*/)
                  .join(' '),
               declarations,
            });
         }
      }
   }
   assert.ok(rules.length > 0, 'the scan found rules to read');
   return rules;
}

/** Whether a value spends a given token, matched whole so `--leji-deep` is never
 * read out of `--leji-deepest`. */
function spends(value: string, token: string): boolean {
   return value.includes(`var(${token})`);
}

test('no ground token is spent as a text tone', () => {
   const found: string[] = [];
   let scanned = 0;
   for (const { sheet, selector, declarations } of authoredRules()) {
      for (const [property, value] of declarations) {
         if (!TEXT_PROPERTIES.includes(property)) continue;
         scanned += 1;
         for (const token of GROUND_TOKENS) {
            if (spends(value, token)) found.push(`${sheet}: ${selector} { ${property}: ${value} }`);
         }
      }
   }
   // The count is asserted too: a scan that reached no declaration would otherwise
   // pass loudly and prove nothing.
   assert.ok(scanned >= 500, `the scan read the site's text declarations: ${scanned} found`);
   assert.deepEqual(found, [], 'a ground token is painting text, which inverts with the scheme');
});

test('no page-following text tone lands on a ground that holds its value', () => {
   const found: string[] = [];
   let scanned = 0;
   for (const { sheet, selector, declarations } of authoredRules()) {
      const ground = declarations.find(
         ([property, value]) =>
            (property === 'background' || property === 'background-color') &&
            FIXED_GROUNDS.some((token) => spends(value, token)),
      );
      if (ground === undefined) continue;
      scanned += 1;
      for (const [property, value] of declarations) {
         if (!TEXT_PROPERTIES.includes(property)) continue;
         if (TEXT_TOKENS.some((token) => spends(value, token))) {
            found.push(`${sheet}: ${selector} { ${ground[0]}: ${ground[1]}; ${property}: ${value} }`);
         }
      }
   }
   assert.ok(scanned >= 50, `the scan read the rules painted on a fixed ground: ${scanned} found`);
   assert.deepEqual(found, [], 'a text tone is painting on a fixed ground, where it needs an ink token instead');
});
