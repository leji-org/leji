import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sentenceGap } from '../src/sentence-gap.ts';

// The note and the banner are three sentences the locale authors separately, so
// something has to join them. A Latin space is right in most languages and visibly
// wrong after a full-width full stop, which already carries its own trailing space.
// The join is the components' business rather than a string a locale could get wrong,
// so this is where the rule is checked.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = path.resolve(testDir, '..', 'src', 'components');

test('a language with full-width punctuation abuts its sentences', () => {
   assert.equal(sentenceGap('zh-hans'), '');
   assert.equal(sentenceGap('ja'), '');
});

test('every other language keeps the space its punctuation expects', () => {
   for (const locale of ['vi', 'pt-br', 'es', 'en', 'ko', 'de']) {
      assert.equal(sentenceGap(locale), ' ', locale);
   }
});

test('both components join their sentences through it, never with a literal space', () => {
   for (const name of ['TranslationNote.astro', 'SpecTranslationBanner.astro']) {
      const source = fs.readFileSync(path.join(componentsDir, name), 'utf8');
      assert.ok(source.includes('sentenceGap('), `${name} does not decide its own sentence join`);
      assert.ok(!/\{`\s+\$\{/.test(source), `${name} joins two sentences with a literal space`);
   }
});
