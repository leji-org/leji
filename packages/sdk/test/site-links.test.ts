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
