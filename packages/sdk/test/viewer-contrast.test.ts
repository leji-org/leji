import { strict as assert } from 'node:assert';
import { test } from 'node:test';

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

// The dark palette, by the role each value plays in the `:root[data-theme='dark']`
// block of `templates/viewer/assets/vue.css`. The dark mode is reader-chosen
// (not only OS-driven), so these tones get the same arithmetic guard as the
// light ones: a token move that drops a pair below AA fails here, instead of
// reaching a dark-using reader as unreadable text.
const DARK_LINK = '#6FD4B9';
const DARK_TEXT = '#E7EFE9';
const DARK_TEXT_BODY = '#A8BCB3';
const DARK_CONTENT = '#162220'; // --leji-content in dark
const DARK_CODE_BG = '#1A2B27'; // --leji-code-bg in dark
const DARK_COMMENT = '#8AA29A'; // the dark Prism .token.comment tone

test('the dark link tone is AA on the dark grounds it lands on', () => {
   // Body links and inline code share --leji-link in dark; both grounds must
   // clear AA for normal-size text.
   assert.ok(
      contrast(DARK_LINK, DARK_CONTENT) >= 4.5,
      `${DARK_LINK} on content ${DARK_CONTENT} is ${contrast(DARK_LINK, DARK_CONTENT).toFixed(2)}:1, below AA`,
   );
   assert.ok(
      contrast(DARK_LINK, DARK_CODE_BG) >= 4.5,
      `${DARK_LINK} on code ${DARK_CODE_BG} is ${contrast(DARK_LINK, DARK_CODE_BG).toFixed(2)}:1, below AA`,
   );
});

test('the dark typography tones carry their sizes on the dark grounds', () => {
   // Headings, emphasis, and every normal-size run of copy: AA at normal size
   // on the reading surface.
   for (const [name, tone] of [
      ['--leji-text', DARK_TEXT],
      ['--leji-text-body', DARK_TEXT_BODY],
   ] as const) {
      const ratio = contrast(tone, DARK_CONTENT);
      assert.ok(
         ratio >= 4.5,
         `${name} (${tone}) is ${ratio.toFixed(2)}:1 on dark content, below AA for normal-size text`,
      );
   }

   // The fenced-code base text and the syntax-comment tone read on the dark
   // code ground; these are the values the dark block pins by hand.
   const codeText = contrast(DARK_TEXT, DARK_CODE_BG);
   assert.ok(codeText >= 4.5, `code text (${DARK_TEXT}) is ${codeText.toFixed(2)}:1 on dark code, below AA`);
   const comment = contrast(DARK_COMMENT, DARK_CODE_BG);
   assert.ok(comment >= 4.5, `comment (${DARK_COMMENT}) is ${comment.toFixed(2)}:1 on dark code, below AA`);
});
