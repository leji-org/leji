import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { schemaInventory } from '../src/schema-i18n.ts';

// Where the pages find the repository, proven by a build rather than by a function call.
//
// The resolution only misbehaves under a real build: the page runs from a chunk emitted
// under the output directory, so neither the working directory nor a fixed count of
// directories above the module leads back to the repository. A unit test cannot see
// that, because plain Node runs the module from its source file and every answer looks
// right. So the fixture next door is built the way the failure shows, from the
// repository root as the working directory, which is where `process.cwd()` resolution
// broke, and the assertions read the page it emitted.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const fixtureDir = path.join(testDir, 'fixtures', 'repo-root');
const astro = path.join(repoRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');

let outDir: string;
let page: string;
/** The build's own cache directory, removed afterwards only if it was not there first. */
let ownedCache: string | null = null;

/** What the page printed under one id, which is what it managed to read. */
function printed(id: string): string {
   const found = new RegExp(`<p id="${id}">([^<]*)</p>`).exec(page);
   assert.ok(found, `the built page has no ${id}:\n${page}`);
   return found[1];
}

before(() => {
   const cache = path.join(repoRoot, '.astro');
   ownedCache = fs.existsSync(cache) ? null : cache;
   outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-repo-root-'));
   const build = spawnSync(process.execPath, [astro, 'build', '--root', fixtureDir, '--outDir', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
   });
   assert.equal(
      build.status,
      0,
      `the fixture site did not build from the repository root:\n${build.stdout}\n${build.stderr}`,
   );
   page = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
});

after(() => {
   fs.rmSync(outDir, { recursive: true, force: true });
   if (ownedCache) fs.rmSync(ownedCache, { recursive: true, force: true });
});

test('the schemas a page reads are the ones the repository publishes', () => {
   const inventory = schemaInventory(fs.readdirSync(path.join(repoRoot, 'schemas')));
   assert.ok(inventory.length > 0, 'the repository publishes no schemas, so this proves nothing');
   assert.equal(printed('schemas'), inventory.join(' '));
});

test('the specification is read from the same root', () => {
   const docs = fs.readdirSync(path.join(repoRoot, 'spec')).filter((file) => file.endsWith('.md'));
   assert.ok(docs.length > 0);
   assert.equal(printed('spec'), String(docs.length));
});

test('a file beside the page is read from this package, not from the repository root', () => {
   const beside = JSON.parse(fs.readFileSync(path.join(packageDir, 'src', 'data', 'manifest-complete.json'), 'utf-8'));
   assert.equal(printed('manifest'), String(Object.keys(beside).length));
});
