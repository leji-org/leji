import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SPEC_DOCS } from '../src/data/spec-docs.ts';

// The translated-specification machinery, proven by an actual build before any locale
// adopts it. The fixture next door is a minimal Astro project that imports this
// package's real modules and components over synthetic content: a locale with every
// document, one with two of them, and one with none. What it emits is what the site
// would emit, so these assertions are about pages on disk rather than functions.
//
// Everything here is unreachable from the shipped site: the fixture is built into a
// temporary directory and its content is never in `src/`.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const fixtureDir = path.join(testDir, 'fixtures', 'spec-i18n');
const astro = path.join(repoRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');

/** The complete locale, the partial one, and the one with no content. */
const COMPLETE = 'ja';
const PARTIAL = 'es';
const PARTIAL_DOCS = ['readme', 'conformance'];
const EMPTY = 'pt-br';

let outDir: string;

function page(...segments: string[]): string {
   return path.join(outDir, ...segments, 'index.html');
}

function html(...segments: string[]): string {
   return fs.readFileSync(page(...segments), 'utf8');
}

function exists(...segments: string[]): boolean {
   return fs.existsSync(page(...segments));
}

function matches(source: string, pattern: RegExp): string[] {
   return [...source.matchAll(pattern)].map((match) => match[1] ?? match[0]);
}

before(() => {
   outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-spec-i18n-'));
   const build = spawnSync(process.execPath, [astro, 'build', '--root', fixtureDir, '--outDir', outDir], {
      encoding: 'utf8',
   });
   assert.equal(build.status, 0, `the fixture site did not build:\n${build.stdout}\n${build.stderr}`);
});

after(() => fs.rmSync(outDir, { recursive: true, force: true }));

test('a locale gets one page per document it has translated', () => {
   for (const { id } of SPEC_DOCS) {
      assert.ok(exists(COMPLETE, 'spec', ...(id === 'readme' ? [] : [id])), `${COMPLETE} is missing ${id}`);
   }
   for (const id of PARTIAL_DOCS) {
      assert.ok(exists(PARTIAL, 'spec', ...(id === 'readme' ? [] : [id])), `${PARTIAL} is missing ${id}`);
   }
});

test('a partial locale gets no one-page view and no page it has no document for', () => {
   assert.ok(!exists(PARTIAL, 'spec', 'full'), 'a partial locale advertised a one-page view missing documents');
   const untranslated = SPEC_DOCS.map((doc) => doc.id).filter((id) => !PARTIAL_DOCS.includes(id));
   for (const id of untranslated) assert.ok(!exists(PARTIAL, 'spec', id), `${PARTIAL} invented a page for ${id}`);
});

test('a locale with no translated documents emits nothing, so its route file is inert', () => {
   assert.ok(!fs.existsSync(path.join(outDir, EMPTY)), 'a locale with no content still emitted pages');
});

test('the complete locale gets a one-page view, with the banner once', () => {
   const full = html(COMPLETE, 'spec', 'full');
   assert.equal(matches(full, /class="spec-translation"/g).length, 1);
   // One section per document, composed by the same code as the English one-page view:
   // the demoted headings leave one h1, and every id is namespaced by its document.
   assert.equal(matches(full, /<section class="spec-section"/g).length, SPEC_DOCS.length);
   assert.equal(matches(full, /<h1[\s>]/g).length, 1);
   assert.ok(full.includes('id="context-layer--requirements"'), 'repeated heading ids were not namespaced');
   assert.ok(full.includes('id="versioning--requirements"'), 'repeated heading ids were not namespaced');
});

test('the one-page view invites an issue and offers no single file to edit', () => {
   const full = html(COMPLETE, 'spec', 'full');
   // Composed from ten files, so there is no one file a pull request would touch: the
   // locale's own route puts a link beside each document heading instead.
   assert.equal(matches(full, /href="[^"]*\/issues\/new[^"]*"/g).length, 1);
   assert.equal(matches(full, /href="[^"]*\/edit\/main[^"]*"/g).length, 0);
});

test('a translated document names the English page it follows and how to correct it', () => {
   const first = html(COMPLETE, 'spec');
   assert.equal(matches(first, /class="spec-translation"/g).length, 1);
   assert.ok(first.includes('href="/spec/"'), 'the banner does not link the normative English page');
   const issue = matches(first, /href="([^"]*\/issues\/new[^"]*)"/g);
   assert.equal(issue.length, 1);
   assert.ok(issue[0].includes(encodeURIComponent(`[${COMPLETE}] /${COMPLETE}/spec/: `)), issue[0]);
   assert.deepEqual(matches(first, /href="([^"]*\/edit\/main[^"]*)"/g), [
      `https://github.com/leji-org/leji/edit/main/packages/site/src/content/i18n/${COMPLETE}/spec/readme.md`,
   ]);
});

test('no translated page shows a reader the revision it follows', () => {
   const shown = SPEC_DOCS.map((_doc, index) => String(index).repeat(7));
   for (const page of [html(COMPLETE, 'spec'), html(COMPLETE, 'spec', 'full')]) {
      for (const sha of shown) assert.ok(!page.includes(sha), `a source revision is on the page: ${sha}`);
   }
});

test('every translated page carries the alternates for the languages it exists in', () => {
   const alternates = (source: string) => matches(source, /<link rel="alternate" hreflang="([^"]+)"/g);
   // Both locales have the first document, so both heads name both, plus English.
   assert.deepEqual(alternates(html(COMPLETE, 'spec')), ['en', PARTIAL, COMPLETE, 'x-default']);
   assert.deepEqual(alternates(html(PARTIAL, 'spec')), ['en', PARTIAL, COMPLETE, 'x-default']);
   // Only the complete locale has this one.
   assert.deepEqual(alternates(html(COMPLETE, 'spec', 'versioning')), ['en', COMPLETE, 'x-default']);
});

test('the sitemap lists every emitted route and nothing else', () => {
   const sitemap = fs.readFileSync(path.join(outDir, 'sitemap-0.xml'), 'utf8');
   const listed = matches(sitemap, /<loc>([^<]+)<\/loc>/g).sort();
   const expected = [
      ...SPEC_DOCS.map((doc) => `https://leji.org/${COMPLETE}/spec/${doc.id === 'readme' ? '' : `${doc.id}/`}`),
      `https://leji.org/${COMPLETE}/spec/full/`,
      ...PARTIAL_DOCS.map((id) => `https://leji.org/${PARTIAL}/spec/${id === 'readme' ? '' : `${id}/`}`),
   ].sort();
   assert.deepEqual(listed, expected);
});

test('no translated page claims to be the specification', () => {
   const claims: string[] = [];
   const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
         const abs = path.join(dir, entry.name);
         if (entry.isDirectory()) walk(abs);
         else if (entry.name.endsWith('.html') && fs.readFileSync(abs, 'utf8').includes('TechArticle')) {
            claims.push(path.relative(outDir, abs));
         }
      }
   };
   walk(outDir);
   assert.deepEqual(claims, [], `translated pages emitting TechArticle metadata: ${claims.join(', ')}`);
});
