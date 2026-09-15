import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// `scripts/version.ts --check` asserts version coherence; `--check --release` adds
// the release-readiness rule: the CHANGELOG.md heading for the version the manifests
// declare reads `## <version> · YYYY-MM-DD`, and the canonical CHANGELOG.json release
// entry, when the release carries one, names the same day.
//
// The script resolves the repository from its own location, so every case here builds
// a whole small tree in a temp directory and runs a copy of the script from inside it.
// That is the only way a case can declare a version whose changelog heading is wrong:
// this checkout's own is correct, which is what the release path requires of it.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..', '..');
const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'version.ts'), 'utf8');

const temps: string[] = [];

after(() => {
   for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

interface Tree {
   /** What all 9 locations declare. */
   version: string;
   /** The whole CHANGELOG.md. */
   changelog: string;
   /** CHANGELOG.json entries; omitted writes no CHANGELOG.json at all. */
   entries?: { id: string; date: string }[];
}

/** A temp repository carrying only what the script reads: the 9 version locations, the
 * two internal dependency ranges, the changelogs, and the script itself. The prose
 * files it checks for drift are absent, and absent files are skipped. */
function fixture(tree: Tree): string {
   const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-version-check-'));
   temps.push(root);
   const write = (rel: string, text: string) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
   };
   const v = tree.version;
   const manifest = (deps = false) =>
      deps
         ? `{\n  "version": "${v}",\n  "dependencies": {\n    "@leji-org/leji": "^${v}"\n  }\n}\n`
         : `{\n  "version": "${v}"\n}\n`;
   // `"type": "module"`, as the real root carries it, so the run is not narrated by
   // Node's module-type warning.
   write('package.json', `{\n  "type": "module",\n  "version": "${v}"\n}\n`);
   write('packages/sdk/package.json', manifest());
   write('packages/sdk/jsr.json', manifest());
   write('packages/sdk-py/package.json', manifest());
   write('packages/sdk-go/package.json', manifest());
   write('packages/create-leji/package.json', manifest(true));
   write('packages/mcp/package.json', manifest(true));
   write('packages/sdk-py/pyproject.toml', `[project]\nname = "leji"\nversion = "${v}"\n`);
   write('packages/sdk-go/internal/schemas/schemas.go', `package schemas\n\nvar SDKVersion = "${v}"\n`);
   write('CHANGELOG.md', tree.changelog);
   if (tree.entries) write('CHANGELOG.json', `${JSON.stringify({ entries: tree.entries }, null, 2)}\n`);
   write('scripts/version.ts', script);
   return root;
}

/** One run of the fixture's own copy of the script, from a neutral directory. */
function check(root: string, ...args: string[]): { status: number | null; output: string } {
   const res = spawnSync(process.execPath, [path.join(root, 'scripts', 'version.ts'), '--check', ...args], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
   });
   return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

const DATED = '# Changelog\n\n## 1.5.0 · 2026-09-14\n\nthe release.\n\n## 1.4.1 · 2026-08-26\n\nthe one before.\n';
const UNSTAMPED = DATED.replace('## 1.5.0 · 2026-09-14', '## 1.5.0 · unreleased');

test('plain --check passes a bumped tree whose heading is not yet dated', () => {
   const { status, output } = check(fixture({ version: '1.5.0', changelog: UNSTAMPED }));
   assert.equal(status, 0);
   assert.match(output, /version coherent: 1\.5\.0/);
   assert.doesNotMatch(output, /release date/);
});

test('release mode fails an undated heading, after coherence has passed', () => {
   const { status, output } = check(fixture({ version: '1.5.0', changelog: UNSTAMPED }), '--release');
   assert.equal(status, 1);
   // Coherence ran and passed; the release rule still runs before the script exits 0.
   assert.match(output, /version coherent: 1\.5\.0/);
   assert.match(output, /carries no release date/);
   assert.match(output, /## 1\.5\.0 · unreleased/);
   assert.match(output, /stamp the release date: RELEASING\.md step 4/);
});

test('release mode fails when the declared version has no heading at all', () => {
   const changelog = '# Changelog\n\n## Unreleased\n\n## 1.4.1 · 2026-08-26\n';
   const { status, output } = check(fixture({ version: '1.5.0', changelog }), '--release');
   assert.equal(status, 1);
   assert.match(output, /carries no "## 1\.5\.0" heading/);
   assert.match(output, /stamp the release date/);
});

test('release mode fails a heading whose date is not a date', () => {
   const changelog = DATED.replace('2026-09-14', 'September 14, 2026');
   const { status, output } = check(fixture({ version: '1.5.0', changelog }), '--release');
   assert.equal(status, 1);
   assert.match(output, /carries no release date/);
   assert.match(output, /expected "## 1\.5\.0 · YYYY-MM-DD"/);
});

test('release mode fails a heading carrying anything after the date', () => {
   const changelog = DATED.replace('2026-09-14', '2026-09-14 (pending)');
   const { status, output } = check(fixture({ version: '1.5.0', changelog }), '--release');
   assert.equal(status, 1);
   assert.match(output, /nothing after the date/);
});

test('release mode fails a date the calendar does not have', () => {
   const changelog = DATED.replace('2026-09-14', '2026-02-30');
   const { status, output } = check(fixture({ version: '1.5.0', changelog }), '--release');
   assert.equal(status, 1);
   assert.match(output, /calendar does not have/);
   assert.match(output, /## 1\.5\.0 · 2026-02-30/);
});

test('release mode fails when the CHANGELOG.json release entry names another day', () => {
   const entries = [{ id: 'release-1-5-0', date: '2026-09-13' }];
   const { status, output } = check(fixture({ version: '1.5.0', changelog: DATED, entries }), '--release');
   assert.equal(status, 1);
   assert.match(output, /entry "release-1-5-0" is dated 2026-09-13, not 2026-09-14/);
});

test('release mode rejects a prerelease version with its own message', () => {
   const changelog = '# Changelog\n\n## 1.5.0-rc.1 · 2026-09-14\n';
   const { status, output } = check(fixture({ version: '1.5.0-rc.1', changelog }), '--release');
   assert.equal(status, 1);
   assert.match(output, /1\.5\.0-rc\.1 is a prerelease/);
});

test('release mode passes a dated heading whose JSON entry names the same day', () => {
   const entries = [{ id: 'release-1-5-0', date: '2026-09-14' }];
   const { status, output } = check(fixture({ version: '1.5.0', changelog: DATED, entries }), '--release');
   assert.equal(status, 0);
   assert.match(output, /release date stamped: ## 1\.5\.0 · 2026-09-14/);
});

test('release mode passes a dated heading with no canonical JSON entry', () => {
   // The release carries no `release-1-5-0` entry, and an entry under any other id is
   // not this version's entry: neither is a finding.
   const entries = [{ id: 'viewer-theme-link', date: '2026-08-02' }];
   const { status } = check(fixture({ version: '1.5.0', changelog: DATED, entries }), '--release');
   assert.equal(status, 0);
});

test("a later version's unreleased heading is not judged, in either mode", () => {
   const changelog = `# Changelog\n\n## 1.6.0 · unreleased\n\nnext.\n\n${DATED.slice('# Changelog\n\n'.length)}`;
   const root = fixture({ version: '1.5.0', changelog, entries: [{ id: 'release-1-5-0', date: '2026-09-14' }] });
   assert.equal(check(root).status, 0);
   assert.equal(check(root, '--release').status, 0);
});
