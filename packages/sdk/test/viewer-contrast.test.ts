import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateViewer, loadManifest } from '../dist/index.js';

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
   assert.ok(html.includes(`--leji-link: ${BRAND_LINK};`), 'the declaration carries the authored hex');
   fs.rmSync(dir, { recursive: true, force: true });
});
