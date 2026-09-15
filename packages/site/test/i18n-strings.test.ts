import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHROME_KEYS, CHROME_LABELS } from '../src/data/chrome-labels.ts';
import { FOOTER_KEYS, FOOTER_LABELS } from '../src/data/footer-labels.ts';
import { PAGE_KIND_KEYS, PAGE_KIND_LABELS, SCHEMA_LABEL_KEYS, SCHEMA_LABELS } from '../src/data/schema-labels.ts';

// `src/data/i18n/en.reference.json` documents what each translated string means and
// what the English site says, so a translator has the source in front of them. It is
// documentation, not copy: no locale approved it as their page's wording, and English
// pages carry no note and no banner at all.
//
// So nothing may render it. That is enforced twice over, and this file is the check
// on both: the loader's glob excludes it by pattern, and no module imports it. Were
// either to go, a locale with a string missing would quietly ship English instead of
// failing the build, which is exactly the fallback the policy forbids.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, '..', 'src');
const dataDir = path.join(srcDir, 'data', 'i18n');
const reference = path.join(dataDir, 'en.reference.json');

/** Every module the site builds from. */
function modules(dir: string, out: string[] = []): string[] {
   for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) modules(abs, out);
      else if (entry.isFile() && /\.(ts|astro)$/.test(entry.name)) out.push(abs);
   }
   return out;
}

test('the reference strings are documentation: role and English copy for each', () => {
   const documented = JSON.parse(fs.readFileSync(reference, 'utf8')) as Record<string, unknown>;
   const keys = Object.keys(documented).filter((key) => !key.startsWith('$'));
   assert.ok(keys.length > 0, 'the reference file documents nothing');
   for (const key of keys) {
      const entry = documented[key] as Record<string, unknown>;
      assert.equal(typeof entry?.role, 'string', `${key} has no role`);
      assert.equal(typeof entry?.english, 'string', `${key} has no English copy`);
   }
   // Its shape is not a locale file's, so it could not be read as one even by mistake.
   assert.equal(documented.note, undefined);
});

test('no module imports the reference strings', () => {
   const importers = modules(srcDir)
      .filter((abs) => /(from|import)\s*\(?\s*['"][^'"]*reference\.json['"]/.test(fs.readFileSync(abs, 'utf8')))
      .map((abs) => path.relative(srcDir, abs));
   assert.deepEqual(importers, [], `modules importing the reference strings: ${importers.join(', ')}`);
});

test('the strings loader excludes the reference file by pattern', () => {
   const loader = fs.readFileSync(path.join(dataDir, 'index.ts'), 'utf8');
   const glob = /import\.meta\.glob<[^>]*>\(\s*\[([^\]]*)\]/.exec(loader);
   assert.ok(glob, 'src/data/i18n/index.ts no longer loads the locale files from a glob');
   assert.ok(glob[1].includes("'!./*.reference.json'"), 'the glob would load the reference file as a locale');
});

test('every locale file beside it is a locale on the roster', () => {
   const registry = fs.readFileSync(path.join(srcDir, 'i18n.ts'), 'utf8');
   const declaration = /export const LOCALES = \[([^\]]*)\]/.exec(registry);
   assert.ok(declaration, 'packages/site/src/i18n.ts no longer declares LOCALES');
   const roster = [...declaration[1].matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
   const files = fs
      .readdirSync(dataDir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.reference.json'))
      .map((name) => name.slice(0, -'.json'.length));
   assert.ok(files.length > 0, 'no locale strings at all: the scan is broken, not the source');
   for (const locale of files) assert.ok(roster.includes(locale), `${locale}.json is not a locale on the roster`);
});

// The note's contract: a locale file carries the whole set and nothing else, and no
// string places the revision a translation follows, which the drift gate reads and no
// reader ever sees. Both are build failures rather than rendering faults, because a
// half-drafted sentence would otherwise ship with a placeholder in it.

const NOTE_KEYS = ['template', 'linkText', 'made', 'corrections', 'correctionsFull', 'issueLinkText', 'editLinkText'];
const SPEC_BANNER_KEYS = ['template', 'fullTemplate', 'linkText'];

function localeFiles(): { locale: string; strings: Record<string, Record<string, string>> }[] {
   return fs
      .readdirSync(dataDir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.reference.json'))
      .map((name) => ({
         locale: name.slice(0, -'.json'.length),
         strings: JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8')),
      }));
}

test('every locale carries the whole note and banner set, and no key beyond it', () => {
   const locales = localeFiles();
   assert.ok(locales.length > 0, 'no locale strings at all: the scan is broken, not the source');
   for (const { locale, strings } of locales) {
      assert.deepEqual(Object.keys(strings.note).sort(), [...NOTE_KEYS].sort(), `${locale}.json note`);
      if (!strings.specBanner) continue;
      assert.deepEqual(Object.keys(strings.specBanner).sort(), [...SPEC_BANNER_KEYS].sort(), `${locale}.json banner`);
   }
});

test('no locale shows a reader a revision, and each sentence places the links it needs', () => {
   for (const { locale, strings } of localeFiles()) {
      for (const [group, set] of Object.entries(strings)) {
         if (group === 'glossary' || typeof set !== 'object') continue;
         for (const [key, text] of Object.entries(set)) {
            if (typeof text !== 'string') continue;
            assert.ok(!text.includes('{revision}'), `${locale}.json ${group}.${key} still shows a revision`);
         }
      }
      assert.ok(strings.note.template.includes('{link}'), `${locale}.json note.template links no English page`);
      for (const placeholder of ['{issue}', '{edit}']) {
         assert.ok(
            strings.note.corrections.includes(placeholder),
            `${locale}.json note.corrections has no ${placeholder}`,
         );
      }
      // The one-page view is composed from ten files and has none of its own to edit.
      assert.ok(strings.note.correctionsFull.includes('{issue}'), `${locale}.json note.correctionsFull has no {issue}`);
      assert.ok(!strings.note.correctionsFull.includes('{edit}'), `${locale}.json note.correctionsFull edits nothing`);
   }
});

// The footer closes every page in every language, so its contract is the navigation
// chrome's: every locale carries the whole block, and nothing beyond it. A locale short
// one label would otherwise put an English word in the middle of its own line.

test('every locale carries the whole footer, and no key beyond it', () => {
   const locales = localeFiles();
   assert.ok(locales.length > 0, 'no locale strings at all: the scan is broken, not the source');
   for (const { locale, strings } of locales) {
      assert.ok(strings.footer, `${locale}.json has no footer`);
      assert.deepEqual(Object.keys(strings.footer).sort(), [...FOOTER_KEYS].sort(), `${locale}.json footer`);
   }
});

// Two agreements the inventory above cannot see, because they are about what the labels
// say rather than which of them are present. Both of the footer's links into this site
// name a page of this site, and each has to name it the way that page names itself, or a
// reader leaves by a word that belongs to something else.
//
// Trust is one word in two bands: the navigation and the footer point at one page, so a
// locale writes its name once and both bands read it. Trademark labels a page whose own
// heading is a sentence ("Política de marca y uso"), and the footer prints the noun that sentence
// is about, so the agreement there is that the label stands inside the heading, in
// whatever case the language writes it mid-sentence. English is checked beside the
// locales: it is the page of record, not an exception to what the record says.

/** The English navigation labels are a module this runner cannot import (it reaches the
 *  specification documents through a specifier only the site build resolves), so the one
 *  label this agreement is about is read from its source, as the roster above is. */
function englishNavTrust(): string {
   const source = fs.readFileSync(path.join(srcDir, 'data', 'nav-labels.ts'), 'utf8');
   const label = /^\s*trust: '([^']*)',/m.exec(source);
   assert.ok(label, 'packages/site/src/data/nav-labels.ts no longer declares a trust label');
   return label[1];
}

test('the footer and the navigation call the trust page one name', () => {
   const locales = localeFiles();
   assert.ok(locales.length > 0, 'no locale strings at all: the scan is broken, not the source');
   assert.equal(FOOTER_LABELS.trust, englishNavTrust(), 'English names the trust page two ways');
   for (const { locale, strings } of locales) {
      assert.equal(strings.footer.trust, strings.nav.trust, `${locale}.json names the trust page two ways`);
   }
});

test('every footer names the trademark page after its own heading', () => {
   const pagesDir = path.join(srcDir, 'pages');
   const footers = [
      { locale: 'en', label: FOOTER_LABELS.trademark, page: path.join(pagesDir, 'trademark.astro') },
      ...localeFiles().map(({ locale, strings }) => ({
         locale,
         label: strings.footer.trademark,
         page: path.join(pagesDir, locale, 'trademark.astro'),
      })),
   ];
   let checked = 0;
   for (const { locale, label, page } of footers) {
      // A locale with no page of its own links the English one, which its word cannot head.
      if (!fs.existsSync(page)) continue;
      const heading = /<h1>([^<]+)<\/h1>/.exec(fs.readFileSync(page, 'utf8'));
      assert.ok(heading, `${locale} trademark page carries no heading of its own`);
      assert.ok(
         heading[1].toLowerCase().includes(label.toLowerCase()),
         `${locale} footer says "${label}", its trademark page is headed "${heading[1]}"`,
      );
      checked += 1;
   }
   assert.ok(checked > 1, 'no translated trademark page at all: the scan is broken, not the source');
});

// The shared chrome closes the same gap the footer's contract does: a skip link, a
// header link, a runtimes label and two copy buttons sit on pages every locale ships, so
// a locale short one label would put an English word in the middle of its own page.

test('every locale carries the whole shared chrome, and no key beyond it', () => {
   const locales = localeFiles();
   assert.ok(locales.length > 0, 'no locale strings at all: the scan is broken, not the source');
   for (const { locale, strings } of locales) {
      assert.ok(strings.chrome, `${locale}.json has no chrome`);
      assert.deepEqual(Object.keys(strings.chrome).sort(), [...CHROME_KEYS].sort(), `${locale}.json chrome`);
   }
});

test('the reference file documents every key a locale carries', () => {
   const documented = Object.keys(JSON.parse(fs.readFileSync(reference, 'utf8'))).filter((key) => !key.startsWith('$'));
   const expected = [
      ...NOTE_KEYS.map((key) => `note.${key}`),
      ...SPEC_BANNER_KEYS.map((key) => `specBanner.${key}`),
      ...CHROME_KEYS.map((key) => `chrome.${key}`),
      ...SCHEMA_LABEL_KEYS.map((key) => `schema.${key}`),
      ...PAGE_KIND_KEYS.map((key) => `pageKinds.${key}`),
   ];
   assert.deepEqual(documented.sort(), expected.sort());
});

test('the reference file quotes the English the site actually renders', () => {
   const documented = JSON.parse(fs.readFileSync(reference, 'utf8')) as Record<string, { english: string }>;
   for (const [key, text] of Object.entries(CHROME_LABELS)) assert.equal(documented[`chrome.${key}`].english, text);
   for (const [key, text] of Object.entries(SCHEMA_LABELS)) assert.equal(documented[`schema.${key}`].english, text);
   for (const [key, text] of Object.entries(PAGE_KIND_LABELS)) {
      assert.equal(documented[`pageKinds.${key}`].english, text);
   }
});

// The two chrome groups two shared components render. A locale authors them when it
// translates the schema reference; until then English — the page of record — stands in
// those two places, because inventing wording no locale approved is worse than either.
// What is checked here is that a locale that did author them authored the whole set, and
// kept the placeholders the components substitute into.

test('a locale that authors the schema chrome authors all of it, placeholders included', () => {
   for (const { locale, strings } of localeFiles()) {
      const schema = strings.schema as Record<string, string> | undefined;
      const pageKinds = strings.pageKinds as Record<string, string> | undefined;
      if (schema) {
         assert.deepEqual(Object.keys(schema).sort(), [...SCHEMA_LABEL_KEYS].sort(), `${locale}.json schema`);
         assert.ok(schema.linkTo.includes('{name}'), `${locale}.json schema.linkTo names no field`);
         assert.ok(schema.arrayOfEnum.includes('{values}'), `${locale}.json schema.arrayOfEnum carries no values`);
      }
      if (pageKinds) {
         assert.deepEqual(Object.keys(pageKinds).sort(), [...PAGE_KIND_KEYS].sort(), `${locale}.json pageKinds`);
         for (const kind of ['normative', 'reference']) {
            assert.ok(pageKinds[kind].includes('{spec}'), `${locale}.json pageKinds.${kind} names no spec line`);
         }
         for (const kind of ['guide', 'background', 'governance']) {
            assert.ok(!pageKinds[kind].includes('{spec}'), `${locale}.json pageKinds.${kind} is not spec-governed`);
         }
      }
      assert.equal(Boolean(schema), Boolean(pageKinds), `${locale}.json carries one chrome group without the other`);
   }
});

test('a locale with schema pages of its own carries both groups', () => {
   const pagesDir = path.join(srcDir, 'pages');
   const withSchemaPages = fs
      .readdirSync(pagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(pagesDir, entry.name, 'schemas')))
      .map((entry) => entry.name);
   for (const locale of withSchemaPages) {
      const strings = JSON.parse(fs.readFileSync(path.join(dataDir, `${locale}.json`), 'utf8'));
      assert.ok(strings.schema, `${locale} has schema pages but no schema chrome`);
      assert.ok(strings.pageKinds, `${locale} has schema pages but no eyebrow phrases`);
   }
});
