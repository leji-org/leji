import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateViewer, loadManifest } from '../dist/index.js';
import { lightTokens, sheetTokens } from './css-tokens.ts';

// The viewer's text tones, judged by the contrast formula rather than by eye.
//
// `--leji-link` is fixed at #007D59 precisely so that a layer's own accent
// (`viewer.theme.primary`) can be anything and body links still meet AA. That
// guarantee is arithmetic, so it is asserted as arithmetic: the moment either the
// token or a ground moves, this file says so, instead of a reviewer noticing a
// slightly paler green two releases later.
//
// The formula is WCAG 2.x relative luminance and contrast ratio, spelled out here
// rather than pulled in: it is nine lines, it is frozen, and a dependency for it
// would be a larger surface than the thing it computes.

/** sRGB channel, 0–255, linearized per WCAG 2.x. */
function channel(value: number): number {
   const c = value / 255;
   return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#RRGGBB` color. */
function luminance(hex: string): number {
   const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
   assert.ok(match, `not a #RRGGBB color: ${hex}`);
   const [r, g, b] = [0, 2, 4].map((i) => channel(Number.parseInt(match[1].slice(i, i + 2), 16)));
   return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#RRGGBB` colors, 1:1 to 21:1. */
function contrast(a: string, b: string): number {
   const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
   return (high + 0.05) / (low + 0.05);
}

// The brand's tones, by the role each one plays in `templates/viewer/`.
const LINK = '#007D59';
/** The link color `fixtures/valid-viewer-link-pass` configures: a brand indigo that
 * clears the floor, so the guard admits it and the page carries it. */
const BRAND_LINK = '#5A50F9';
const TEXT = '#183B32';
const TEXT_BODY = '#4D5B56';
const TEXT_MUTED = '#76827D';
const WHITE = '#FFFFFF';
const CODE_BG = '#E8F4EE';

/** Ratios are compared to two decimals: the expected values are the point of the
 * test, and a tolerance wide enough to absorb a real tone change would defeat it. */
const TOLERANCE = 0.01;

test('the fixed link tone is AA on both grounds it lands on', () => {
   // Body links: #007D59 on the content ground.
   assert.ok(
      Math.abs(contrast(LINK, WHITE) - 5.15) < TOLERANCE,
      `${LINK} on ${WHITE} is ${contrast(LINK, WHITE).toFixed(2)}:1, expected 5.15:1`,
   );
   // Inline code: the same tone on the brand's code ground, the narrower of the two.
   assert.ok(
      Math.abs(contrast(LINK, CODE_BG) - 4.56) < TOLERANCE,
      `${LINK} on ${CODE_BG} is ${contrast(LINK, CODE_BG).toFixed(2)}:1, expected 4.56:1`,
   );
   assert.ok(contrast(LINK, CODE_BG) >= 4.5, 'the inline-code pair meets AA for normal-size text');
});

test('the typography tones carry their sizes on the content ground', () => {
   // Headings, emphasis, and every normal-size run of copy: AA at normal size.
   for (const [name, tone] of [
      ['--leji-text', TEXT],
      ['--leji-text-body', TEXT_BODY],
   ] as const) {
      const ratio = contrast(tone, WHITE);
      assert.ok(ratio >= 4.5, `${name} (${tone}) is ${ratio.toFixed(2)}:1 on white, below AA for normal-size text`);
   }

   // The muted tone is 3.99:1, which is AA for large text (>=18.66px bold or
   // >=24px) and nothing else. `templates/viewer/` declares it and uses it nowhere,
   // so this bound is the rule a future consumer has to satisfy: large sizes only.
   const muted = contrast(TEXT_MUTED, WHITE);
   assert.ok(
      muted >= 3,
      `--leji-text-muted (${TEXT_MUTED}) is ${muted.toFixed(2)}:1 on white, below AA for large text`,
   );
});

// --- viewer.theme.link, the one tone a layer may move ---------------------------
//
// The guard measures against the code ground only, because that ground is the
// narrower one: the assertions below are the two halves of that claim — a color
// the single check refuses that a white-only check would have admitted, and the
// color the fixture ships, which clears both.

test('the link guard measures the narrower ground, so a white-only check is not enough', () => {
   // #767676 is the counterexample: AA on white, below AA on inline code. A guard
   // checking white alone would let it through and ship unreadable inline code.
   const gray = '#767676';
   assert.ok(
      Math.abs(contrast(gray, WHITE) - 4.54) < TOLERANCE,
      `${gray} on ${WHITE} is ${contrast(gray, WHITE).toFixed(2)}:1, expected 4.54:1`,
   );
   assert.ok(contrast(gray, WHITE) >= 4.5, 'the counterexample passes on white');
   assert.ok(
      Math.abs(contrast(gray, CODE_BG) - 4.02) < TOLERANCE,
      `${gray} on ${CODE_BG} is ${contrast(gray, CODE_BG).toFixed(2)}:1, expected 4.02:1`,
   );
   assert.ok(contrast(gray, CODE_BG) < 4.5, 'and fails on the ground the guard uses');

   // The configured hex clears the narrower ground, so it clears both.
   assert.ok(
      contrast(BRAND_LINK, CODE_BG) >= 4.5,
      `${BRAND_LINK} on ${CODE_BG} is ${contrast(BRAND_LINK, CODE_BG).toFixed(2)}:1, below the guard's floor`,
   );
   assert.ok(contrast(BRAND_LINK, WHITE) >= 4.5, 'and clears the content ground too');
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A throwaway copy of a fixture layer, so generateViewer writes somewhere disposable. */
function copyFixture(name: string): string {
   const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-link-')));
   fs.cpSync(path.join(repoRoot, 'fixtures', name), dir, { recursive: true });
   return dir;
}

test('a viewer.theme.link that names no color is refused by name, not by ratio', () => {
   // A malformed value has no measurable ratio, so the guard's other message says
   // what is wrong with it and names what the viewer does instead.
   const dir = copyFixture('valid-viewer-link-pass');
   const { manifest } = loadManifest(dir);
   manifest!.viewer = { theme: { link: 'rebeccapurple' } };
   const result = generateViewer(dir, manifest!);
   const warnings = result.findings.filter((f) => f.rule === 'viewer-theme-link-contrast');
   assert.equal(warnings.length, 1, 'the refusal is surfaced exactly once');
   assert.equal(warnings[0].severity, 'warning');
   assert.equal(
      warnings[0].message,
      'viewer.theme.link "rebeccapurple" is not a hex color; body links keep the fixed accessible tone',
   );
   const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(!html.includes('--leji-link:'), 'a refused value declares nothing at all');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty or blank viewer.theme.link is a bad value, not an absent one', () => {
   // The schema accepts `link: ""`, so it is a present value the guard must judge —
   // reading it as "unset" would let the one input most likely to arrive from a
   // half-filled manifest pass without the warning the design promises.
   for (const blank of ['', '   ', '\t', '\n']) {
      const dir = copyFixture('valid-viewer-link-pass');
      const { manifest } = loadManifest(dir);
      manifest!.viewer = { theme: { link: blank } };
      const result = generateViewer(dir, manifest!);
      const warnings = result.findings.filter((f) => f.rule === 'viewer-theme-link-contrast');
      assert.equal(warnings.length, 1, `${JSON.stringify(blank)} warns exactly once`);
      assert.equal(warnings[0].severity, 'warning');
      assert.equal(
         warnings[0].message,
         `viewer.theme.link "${blank}" is not a hex color; body links keep the fixed accessible tone`,
      );
      const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
      assert.ok(!html.includes('--leji-link:'), `${JSON.stringify(blank)} declares nothing`);
      fs.rmSync(dir, { recursive: true, force: true });
   }

   // The absent case is the only silent one: no key, no finding, no declaration.
   const dir = copyFixture('valid-viewer-link-pass');
   const { manifest } = loadManifest(dir);
   manifest!.viewer = { theme: {} };
   const result = generateViewer(dir, manifest!);
   assert.deepEqual(
      result.findings.filter((f) => f.rule === 'viewer-theme-link-contrast'),
      [],
      'a missing key is absent, and absent is silent',
   );
   const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(!html.includes('--leji-link:'), 'an absent key declares nothing');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('a viewer.theme.link that clears the floor reaches the page', () => {
   const dir = copyFixture('valid-viewer-link-pass');
   const { manifest } = loadManifest(dir);
   const result = generateViewer(dir, manifest!);
   assert.deepEqual(
      result.findings.filter((f) => f.rule === 'viewer-theme-link-contrast'),
      [],
      'a passing value is accepted silently',
   );
   const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   // Scoped to the light scheme, and asserted whole: the wrapper is the contract,
   // because the guard measures the authored color against the light grounds only.
   assert.ok(
      html.includes(`@media (prefers-color-scheme: light) { :root { --leji-link: ${BRAND_LINK}; } }`),
      'the declaration carries the authored hex, scoped to the light scheme',
   );
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the link declaration takes the shape the page it lands on can carry', () => {
   // The guard measures the authored color against the light grounds and nothing
   // else, so what the page may do with an accepted color follows from the scheme
   // it renders in: a page that follows the reader's system keeps the tone behind
   // the light media query, a page that names light needs no query to hold it
   // there, and a page that names dark declares nothing, its link tone being fixed.
   const cases: [string | undefined, string | null][] = [
      [undefined, `@media (prefers-color-scheme: light) { :root { --leji-link: ${BRAND_LINK}; } }`],
      ['system', `@media (prefers-color-scheme: light) { :root { --leji-link: ${BRAND_LINK}; } }`],
      ['light', `:root { --leji-link: ${BRAND_LINK}; }`],
      ['dark', null],
   ];
   const dir = copyFixture('valid-viewer-link-pass');
   const { manifest } = loadManifest(dir);
   for (const [appearance, declaration] of cases) {
      const label = appearance ?? 'absent';
      manifest!.viewer = {
         theme: { link: BRAND_LINK, ...(appearance === undefined ? {} : { appearance: appearance as 'system' }) },
      };
      const result = generateViewer(dir, manifest!);
      assert.deepEqual(
         result.findings.filter((f) => f.rule === 'viewer-theme-link-contrast'),
         [],
         `${label}: a passing value is accepted silently`,
      );
      const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
      if (declaration === null) assert.ok(!html.includes('--leji-link:'), `${label} declares nothing`);
      else assert.ok(html.includes(declaration), `${label} carries ${declaration}`);
   }

   // The guard runs on every page, so a refused value is reported whatever the
   // scheme: the finding is about the value the author wrote, not about whether
   // this particular page would have had a use for it.
   for (const appearance of [undefined, 'system', 'light', 'dark'] as const) {
      const label = appearance ?? 'absent';
      manifest!.viewer = {
         theme: { link: '#767676', ...(appearance === undefined ? {} : { appearance }) },
      };
      const result = generateViewer(dir, manifest!);
      const warnings = result.findings.filter((f) => f.rule === 'viewer-theme-link-contrast');
      assert.equal(warnings.length, 1, `${label}: the refusal is surfaced exactly once`);
      assert.equal(warnings[0].severity, 'warning');
      const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
      assert.ok(!html.includes('--leji-link:'), `${label}: a refused value declares nothing at all`);
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- the dark scheme, judged against the stylesheet it ships ---------------------
//
// Nothing below restates a dark value. The authored sources are
// `templates/viewer/assets/vue.css` for the light scheme and
// `templates/viewer/assets/vue-dark.css` for the dark one (the vendored copies
// beside the three SDKs are pinned by `assets:check`), and every tone is parsed out
// of the sheet that declares it. A suite carrying its own copy of the palette
// passes whatever the stylesheet says, which is the one thing it is here to catch.

const viewerAssets = path.join(repoRoot, 'templates', 'viewer', 'assets');
const VIEWER_CSS = fs.readFileSync(path.join(viewerAssets, 'vue.css'), 'utf8');
const VIEWER_DARK_CSS = fs.readFileSync(path.join(viewerAssets, 'vue-dark.css'), 'utf8');

/** AA for normal-size text. Every run of text the dark scheme paints is normal size
 * or larger, the 0.6rem code-language label included, so nothing there may take the
 * large-text floor the light muted tone sits on. */
const AA_NORMAL = 4.5;

/** The two tokens the dark sheet deliberately leaves at their light values: the
 * layer's own accent, which colors surfaces rather than text there, and the mark
 * green, which is a brand moment and never small text. */
const KEPT_IN_DARK = ['--theme-color', '--leji-brand'];

/** The custom properties a rule declares, sorted, so two blocks can be compared by
 * what they carry rather than by the order they were written in. */
function properties(tokens: Map<string, string>): string[] {
   return [...tokens.keys()].filter((name) => name.startsWith('--')).sort();
}

/** The dark stylesheet with its comments removed, so a rule is bounded by braces
 * alone. Every rule in it applies whenever the sheet is linked: the `media`
 * attribute on the link is what decides that, so a media query inside the file
 * would be a second, hidden condition on rules the page has already chosen to
 * take, and there is none. */
function darkSection(css: string): string {
   const source = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
   assert.equal(source.search(/@media/), -1, 'the dark sheet carries no media query of its own');
   return source;
}

/** Every Prism `.token` rule the dark sheet colors, as `[selector, #RRGGBB]`. A rule
 * that moves a border rather than the text declares no `color`, and is not one. */
function prismTones(section: string): [string, string][] {
   const tones: [string, string][] = [];
   for (const rule of section.matchAll(/([^{}]*\.token[^{}]*)\{([^{}]*)\}/g)) {
      const color = /^\s*color:\s*(#[0-9a-fA-F]{6})\s*;/m.exec(rule[2]);
      if (color === null) continue;
      tones.push([
         rule[1]
            .trim()
            .split(/\s*\n\s*/)
            .join(' '),
         color[1],
      ]);
   }
   return tones;
}

test('the dark sheet re-values every token but the two it deliberately keeps', () => {
   const dark = sheetTokens(VIEWER_DARK_CSS);
   const light = lightTokens(VIEWER_CSS);

   // The scheme is declared, so form controls, scrollbars, and the canvas the
   // browser paints before the sheet applies sit on the right ground.
   assert.equal(dark.get('color-scheme'), 'dark');
   assert.equal(light.get('color-scheme'), 'light');

   assert.deepEqual(
      properties(dark),
      properties(light).filter((name) => !KEPT_IN_DARK.includes(name)),
      'the dark sheet re-values exactly the tokens the light sheet declares, minus the kept two',
   );
   for (const token of properties(dark)) {
      assert.notEqual(dark.get(token), light.get(token), `${token} still carries its light value in the dark sheet`);
   }
});

test('every dark text tone is AA on every dark ground', () => {
   const dark = sheetTokens(VIEWER_DARK_CSS);
   // The three grounds the viewer paints, against the four tones that land on them:
   // headings, copy, the muted label tone, and links, which reach the content, the
   // sidebar and panels, and inline and fenced code respectively.
   for (const ground of ['--leji-page', '--leji-paper', '--leji-code-bg']) {
      for (const tone of ['--leji-text', '--leji-text-body', '--leji-text-muted', '--leji-link']) {
         const ratio = contrast(dark.get(tone), dark.get(ground));
         assert.ok(
            ratio >= AA_NORMAL,
            `${tone} (${dark.get(tone)}) is ${ratio.toFixed(2)}:1 on ${ground} (${dark.get(ground)}), below AA for normal-size text`,
         );
      }
   }
});

test('the dark surfaces step off the content ground by the amounts the palette states', () => {
   const dark = sheetTokens(VIEWER_DARK_CSS);
   const page = dark.get('--leji-page');
   // Neither pair carries text, so neither has an AA floor; what they have is a
   // stated step, and a step that quietly closed would flatten the sidebar into the
   // page and lose every table rule.
   for (const [token, expected] of [
      ['--leji-paper', 1.11],
      ['--leji-line', 1.43],
   ] as const) {
      const ratio = contrast(dark.get(token), page);
      assert.ok(
         Math.abs(ratio - expected) < TOLERANCE,
         `${token} (${dark.get(token)}) is ${ratio.toFixed(2)}:1 against the content ground, expected ${expected}:1`,
      );
   }
});

test('every Prism tone the dark sheet declares reads on the code ground', () => {
   const dark = sheetTokens(VIEWER_DARK_CSS);
   const codeBg = dark.get('--leji-code-bg');
   const tones = prismTones(darkSection(VIEWER_DARK_CSS));

   // Highlighted code is normal-size text, so the syntax palette carries the same
   // floor as prose. The count is asserted too: a scan that matched nothing would
   // otherwise pass this test loudly and prove nothing.
   assert.ok(tones.length >= 9, `the dark sheet colors the Prism token classes: ${tones.length} rules found`);
   for (const [selector, tone] of tones) {
      const ratio = contrast(tone, codeBg);
      assert.ok(
         ratio >= AA_NORMAL,
         `${selector} (${tone}) is ${ratio.toFixed(2)}:1 on the code ground (${codeBg}), below AA for normal-size text`,
      );
   }

   // The comment tone is the narrowest of the set and the one the palette pins, so
   // it is asserted at its value rather than only against the floor.
   const comment = tones.find(([selector]) => selector.includes('.token.comment'));
   assert.ok(comment, 'the comment tone is one of them');
   const ratio = contrast(comment[1], codeBg);
   assert.ok(
      Math.abs(ratio - 6.69) < TOLERANCE,
      `the comment tone (${comment[1]}) is ${ratio.toFixed(2)}:1 on the code ground, expected 6.69:1`,
   );
});

test('the code-language label takes a text tone in dark, on both grounds it sits on', () => {
   const dark = sheetTokens(VIEWER_DARK_CSS);

   // `attr(data-lang)` is 0.6rem text. The stock theme gives it the rule tone, which
   // is a surface color; the dark sheet gives it the muted text tone instead, and
   // that is what makes the floor below the right one to hold it to.
   const label = /\.markdown-section pre::after,[^{}]*\{([^{}]*)\}/.exec(darkSection(VIEWER_DARK_CSS));
   assert.ok(label, 'the dark sheet gives the code-language label a rule of its own');
   assert.match(label[0], /output::after/, 'the same rule covers the output label');
   assert.match(label[1], /color:\s*var\(--leji-text-muted\)/, 'the label takes the muted text tone');

   // A fenced block's label sits on the code ground; a decision output's sits on the
   // content ground.
   for (const ground of ['--leji-code-bg', '--leji-page']) {
      const ratio = contrast(dark.get('--leji-text-muted'), dark.get(ground));
      assert.ok(
         ratio >= AA_NORMAL,
         `the label tone (${dark.get('--leji-text-muted')}) is ${ratio.toFixed(2)}:1 on ${ground}, below AA for normal-size text`,
      );
   }
});

test('the light :root still carries the 1.5.0 values', () => {
   // The dark scheme is additive: it lives in a sheet of its own, and the
   // unconditional block is untouched. This is also what ties the constants above
   // to the stylesheet, so the arithmetic in this file is arithmetic about the
   // shipped tones.
   const light = lightTokens(VIEWER_CSS);
   for (const [token, value] of [
      ['--theme-color', '#009F71'],
      ['--leji-brand', '#009F71'],
      ['--leji-link', LINK],
      ['--leji-deep', '#164E42'],
      ['--leji-accent', '#78D7B5'],
      ['--leji-page', WHITE],
      ['--leji-paper', '#F7F8F5'],
      ['--leji-text', TEXT],
      ['--leji-text-body', TEXT_BODY],
      ['--leji-text-muted', TEXT_MUTED],
      ['--leji-line', '#CDE5D9'],
      ['--leji-code-bg', CODE_BG],
      ['--leji-caret', '#AAAAAA'],
   ] as const) {
      assert.equal(light.get(token), value.toLowerCase(), `${token} moved off its 1.5.0 value`);
   }
});
