import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SPEC_DOCS } from '../src/data/spec-docs.ts';
import { correctionIndex, correctionLinksFor, pageRouteKey } from '../src/correction-links.ts';

// The invitation to correct a translated page is only as good as the file it points at,
// and nothing on the page carries that path: it is derived from the two globs the
// registry already reads. So the property under this file is that the derivation names
// files that are actually there, for every translated route the site emits, the 404
// included. The registry hands the same file lists to the same functions at build time;
// here they come from the directories on disk instead.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, '..', 'src');
const REPOSITORY = 'https://github.com/leji-org/leji';
const LOCALES = ['zh-hans', 'ja', 'pt-br', 'es', 'vi'];

/** The page glob's keys, as Vite would produce them: every `.astro` under a locale's
 *  page tree, its specification route excluded (that route is machinery, and the
 *  documents it renders are content files, indexed below). */
function pageFiles(): string[] {
   const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
         if (entry.isDirectory()) walk(path.join(dir, entry.name), out);
         else if (entry.name.endsWith('.astro')) out.push(path.join(dir, entry.name));
      }
      return out;
   };
   return LOCALES.flatMap((locale) =>
      walk(path.join(srcDir, 'pages', locale))
         .map((abs) => `./${path.relative(srcDir, abs)}`)
         .filter((file) => !file.startsWith(`./pages/${locale}/spec/`)),
   );
}

/** The translated specification content's keys. */
function specFiles(): string[] {
   const contentDir = path.join(srcDir, 'content', 'i18n');
   return fs
      .readdirSync(contentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .flatMap((locale) =>
         fs
            .readdirSync(path.join(contentDir, locale, 'spec'))
            .sort()
            .map((name) => `./content/i18n/${locale}/spec/${name}`),
      );
}

const INDEX = correctionIndex(pageFiles(), specFiles());

const links = (key: string, locale: string) => correctionLinksFor(INDEX, { key, locale, href: `${key}/` });

test('a page file is indexed under the route it serves, the locale prefix included', () => {
   assert.equal(pageRouteKey('./pages/vi/quickstart.astro'), '/vi/quickstart');
   assert.equal(pageRouteKey('./pages/vi/index.astro'), '/vi');
   assert.equal(pageRouteKey('./pages/pt-br/404.astro'), '/pt-br/404');
   assert.throws(() => pageRouteKey('./pages/index.astro'), /outside a locale directory/);
});

test('every translated route names a file that is on disk', () => {
   for (const [key, file] of INDEX.files) {
      assert.ok(fs.existsSync(path.join(srcDir, file)), `${key} points at ${file}, which is not there`);
   }
   // The whole point of the index is that it is not a list anyone maintains.
   assert.ok(INDEX.files.size >= LOCALES.length * 20, `only ${INDEX.files.size} translated routes indexed`);
});

test('the 404 is in the index, since a reader reads it like any other page', () => {
   for (const locale of LOCALES) {
      assert.equal(INDEX.files.get(`/${locale}/404`), `pages/${locale}/404.astro`);
   }
});

test('an ordinary page offers its own file and no document list', () => {
   const { issueHref, editHref, documents } = links('/vi/quickstart', 'vi');
   assert.equal(editHref, `${REPOSITORY}/edit/main/packages/site/src/pages/vi/quickstart.astro`);
   assert.deepEqual(documents, []);
   // The language and the route are in the title before the reader types anything.
   assert.equal(
      issueHref,
      `${REPOSITORY}/issues/new?template=translation-correction.md&title=${encodeURIComponent('[vi] /vi/quickstart/: ')}`,
   );
});

test('a specification document offers the content file, not the route that renders it', () => {
   assert.equal(
      links('/ja/spec/versioning', 'ja').editHref,
      `${REPOSITORY}/edit/main/packages/site/src/content/i18n/ja/spec/versioning.md`,
   );
   assert.equal(
      links('/ja/spec', 'ja').editHref,
      `${REPOSITORY}/edit/main/packages/site/src/content/i18n/ja/spec/readme.md`,
   );
});

test('the one-page view names all ten documents in reading order, and no file of its own', () => {
   for (const locale of LOCALES) {
      const { editHref, documents } = links(`/${locale}/spec/full`, locale);
      assert.equal(editHref, null, `${locale} offered one file for a page composed of ten`);
      assert.deepEqual(
         documents.map((document) => document.doc),
         SPEC_DOCS.map((doc) => doc.id),
         `${locale} one-page view`,
      );
      assert.deepEqual(
         documents.map((document) => document.editHref),
         SPEC_DOCS.map((doc) => `${REPOSITORY}/edit/main/packages/site/src/content/i18n/${locale}/spec/${doc.id}.md`),
         `${locale} one-page view`,
      );
   }
});

test('a locale part way through the specification advertises no one-page view', () => {
   const partial = correctionIndex([], [`./content/i18n/ko/spec/readme.md`]);
   assert.equal(partial.fullViews.size, 0);
   assert.equal(partial.files.get('/ko/spec'), 'content/i18n/ko/spec/readme.md');
});

test('a route with no file fails rather than inviting a correction that leads nowhere', () => {
   assert.throws(() => links('/vi/no-such-page', 'vi'), /no source file/);
});
