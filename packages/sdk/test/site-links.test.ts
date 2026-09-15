import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Every leji.org URL this SDK hands a user must land on something this repository
// actually ships. The URLs are constants in the source (`leji badge`'s markdown
// wrapper, the help footers, the install hint, the `$schema` values written into a
// scaffolded layer), so nothing at runtime can catch a dead one: a page renamed or
// never written turns every emitted line into a 404 the adopter publishes.
//
// Two kinds of target, because there are two kinds of URL:
//   /<path>/            a site page under packages/site/src/pages
//   /schemas/v1.0/<f>   a canonical schema, served from the repo-root schemas/
//
// Single implementation, deliberately: the Python and Go ports mirror these exact
// strings and the parity suite pins them, so checking the TypeScript reference
// covers the class. Dependency-free (a directory walk and one regex) so it runs in
// `test:unit` with nothing installed beyond the package's own devDependencies.
//
// Known limit, stated rather than papered over: a page reached through a dynamic
// route (`pages/spec/[...slug].astro`) is not recognized as a target. No emitted
// URL uses one today; one that did would fail here loudly, and the rule below is
// where to widen it.
//
// The second test walks the translated trees under `pages/<locale>/`, where a
// locale mirrors the English route tree beneath its prefix. It uses the same
// resolver, in the other direction: a translated page whose English route does
// not exist is an orphan, which would advertise an `hreflang` alternate and a
// header switch pointing at a page nobody can reach. The English tree is not
// checked for completeness: an English-only surface is the normal state, and the
// machine surfaces (`/schemas/**`, `llms*.txt`, the raw `.md` routes) are never
// translated at all.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const srcDir = path.join(packageDir, 'src');
const cliSpec = path.join(packageDir, 'cli.json');
const pagesDir = path.join(repoRoot, 'packages', 'site', 'src', 'pages');
const schemasDir = path.join(repoRoot, 'schemas');

/** The site origin, and the path that follows it, wherever either appears in a
 * string literal. The character class stops at the closing quote, backtick or
 * parenthesis that ends the literal it sits in. */
const SITE_URL = /https:\/\/leji\.org([A-Za-z0-9._/-]*)/g;

/** URLs under this prefix are schema files, not pages. */
const SCHEMA_PREFIX = '/schemas/v1.0/';

interface SiteUrl {
   /** The path part, `/` for the bare origin. */
   sitePath: string;
   /** Where it is written, repository-relative, for the failure message. */
   sources: string[];
}

/** Every TypeScript file under `src/`, plus the CLI spec. */
function scannedFiles(dir: string, out: string[] = []): string[] {
   for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) scannedFiles(abs, out);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
   }
   return out;
}

function collect(): SiteUrl[] {
   const found = new Map<string, Set<string>>();
   for (const abs of [...scannedFiles(srcDir), cliSpec]) {
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      for (const match of fs.readFileSync(abs, 'utf8').matchAll(SITE_URL)) {
         const sitePath = match[1] === '' ? '/' : match[1];
         const sources = found.get(sitePath) ?? new Set<string>();
         sources.add(rel);
         found.set(sitePath, sources);
      }
   }
   return [...found]
      .map(([sitePath, sources]) => ({ sitePath, sources: [...sources].sort() }))
      .sort((a, b) => a.sitePath.localeCompare(b.sitePath));
}

function isFile(abs: string): boolean {
   return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

/** `/` is the index; `/x/` is `x.astro` or `x/index.astro`, and a deeper path is
 * the same rule over its segments. */
function pageExists(sitePath: string): boolean {
   const segments = sitePath.split('/').filter((s) => s !== '');
   if (segments.length === 0) return isFile(path.join(pagesDir, 'index.astro'));
   const base = path.join(pagesDir, ...segments);
   return isFile(`${base}.astro`) || isFile(path.join(base, 'index.astro'));
}

/** A canonical schema URL resolves to the file at the repository root, which is the
 * one the site serves at that `$id`. */
function schemaExists(sitePath: string): boolean {
   const rest = sitePath.slice(SCHEMA_PREFIX.length).split('/');
   return rest.every((s) => s !== '' && s !== '..') && isFile(path.join(schemasDir, ...rest));
}

function targetExists(sitePath: string): boolean {
   return sitePath.startsWith(SCHEMA_PREFIX) ? schemaExists(sitePath) : pageExists(sitePath);
}

/** The translated locales, read out of the site's own registry so this test and
 *  the site cannot disagree about which trees exist. English is the source tree
 *  and has no directory of its own. */
function translatedLocales(): string[] {
   const registry = path.join(repoRoot, 'packages', 'site', 'src', 'i18n.ts');
   const declaration = /export const LOCALES = \[([^\]]*)\]/.exec(fs.readFileSync(registry, 'utf8'));
   assert.ok(declaration, 'packages/site/src/i18n.ts no longer declares LOCALES: this test cannot find the trees');
   return [...declaration[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).filter((locale) => locale !== 'en');
}

interface TranslatedPage {
   /** The English route it mirrors, resolved by the same rule as a site URL. */
   route: string;
   /** Where the translation lives, repository-relative, for the failure message. */
   source: string;
}

/** Every `.astro` page under one locale directory, as the English route it
 *  mirrors: the locale tree repeats the English route tree beneath its prefix. */
function translatedPages(dir: string, route = '', out: TranslatedPage[] = []): TranslatedPage[] {
   for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) translatedPages(abs, `${route}/${entry.name}`, out);
      else if (entry.isFile() && entry.name.endsWith('.astro')) {
         const base = entry.name.slice(0, -'.astro'.length);
         out.push({
            route: base === 'index' ? `${route}/` : `${route}/${base}/`,
            source: path.relative(repoRoot, abs).split(path.sep).join('/'),
         });
      }
   }
   return out;
}

test('every leji.org URL the SDK emits has a target in this repository', () => {
   const urls = collect();
   // A scan that finds nothing would pass silently; these URLs exist, so an empty
   // collection means the regex or the walk broke, not that the source is clean.
   assert.ok(urls.length > 0, 'no https://leji.org URL was collected: the scan is broken, not the source');
   const missing = urls.filter((u) => !targetExists(u.sitePath)).map((u) => `${u.sitePath} (${u.sources.join(', ')})`);
   assert.deepEqual(
      missing,
      [],
      `leji.org URLs with no target in this repository: ${missing.join(', ')}\n` +
         'Add the page under packages/site/src/pages (or the schema under schemas/), or stop emitting the URL.',
   );
});

test('every translated page mirrors an English route in this repository', () => {
   const orphans: string[] = [];
   for (const locale of translatedLocales()) {
      const dir = path.join(pagesDir, locale);
      if (!fs.existsSync(dir)) continue;
      for (const page of translatedPages(dir)) {
         if (!pageExists(page.route)) orphans.push(`${page.source} -> ${page.route}`);
      }
   }
   assert.deepEqual(
      orphans,
      [],
      `translated pages with no English route: ${orphans.join(', ')}\n` +
         'Add the English page under packages/site/src/pages, or withdraw the translation.',
   );
});
