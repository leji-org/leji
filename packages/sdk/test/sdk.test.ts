import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
   checkIndex,
   conformanceReport,
   freshnessReport,
   initLayer,
   loadManifest,
   validateLayer,
   writeIndex,
} from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

function tmpdir(): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), 'leji-test-'));
}

/** A temp dir that is a real git repository. Conformance evaluates the directory it
 * is given, so a layer outside a repository fails `core`'s git requirement: any test
 * asserting a verified level has to run somewhere git can answer. */
function gitTmpdir(): string {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
   return dir;
}

/** Commit whatever is in the tree. A repository is not enough: an unborn repo has no
 * committed state, so append-only discipline is unverifiable and `indexed` cannot
 * verify. A fixture that only ran `git init` would assert a level it has not earned,
 * which is the false positive this whole change removes. */
function commitAll(dir: string): void {
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
}

function copyExample(): string {
   const dir = gitTmpdir();
   fs.cpSync(exampleDir, dir, { recursive: true });
   commitAll(dir);
   return dir;
}

test('example monorepo validates clean', () => {
   const result = validateLayer(exampleDir);
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
});

test('index round-trip: regenerate then check is current', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   writeIndex(dir, manifest!);
   const check = checkIndex(dir, manifest!);
   assert.equal(check.stale, false);
});

test('index check goes stale when a document changes', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   writeIndex(dir, manifest!);
   fs.appendFileSync(path.join(dir, 'docs', 'domain', 'glossary.md'), '\n- **Refund**: a reversal.\n');
   const check = checkIndex(dir, manifest!);
   assert.equal(check.stale, true);
   assert.ok(check.findings.some((f) => f.rule === 'index-stale'));
});

test('index ids stay stable across a pure file move', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   writeIndex(dir, manifest!);
   // Move glossary.md to a new name in the same category; id must survive.
   fs.renameSync(path.join(dir, 'docs', 'domain', 'glossary.md'), path.join(dir, 'docs', 'domain', 'terms.md'));
   const result = writeIndex(dir, manifest!);
   const moved = result.index!.entries.find((e) => e.path === 'docs/domain/terms.md');
   assert.equal(moved?.id, 'glossary');
});

test('init --yes produces a layer that validates clean (core)', async () => {
   const dir = tmpdir();
   const result = await initLayer({ dir, yes: true });
   assert.ok(result.written.includes('leji.json'));
   const validation = validateLayer(dir);
   // init does not `git init`, so a freshly scaffolded layer in a bare tmp dir
   // carries exactly the not-in-git warning; its content is otherwise clean.
   const contentFindings = validation.findings.filter((f) => f.rule !== 'git-required');
   assert.deepEqual(contentFindings, []);
   assert.deepEqual(
      validation.findings.map((f) => f.rule),
      ['git-required'],
   );
});

test('init --yes at indexed level verifies its claim once committed', async () => {
   const dir = gitTmpdir();
   await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });
   // Committed, because append-only discipline compares against HEAD: an uncommitted
   // scaffold has no baseline and correctly reports `unknown` rather than verifying.
   commitAll(dir);
   const validation = validateLayer(dir);
   // Not a git repo: append-only is unverifiable (warning); no errors allowed.
   assert.deepEqual(
      validation.findings.filter((f) => f.severity === 'error'),
      [],
   );
   const conformance = conformanceReport(dir);
   assert.equal(conformance.claimedLevel, 'indexed');
   assert.equal(conformance.verifiedLevel, 'indexed');
});

test('init emits no machine block (core), the minimal manifest', async () => {
   const dir = tmpdir();
   const result = await initLayer({ dir, yes: true });
   assert.equal(result.manifest.machine, undefined, 'in-memory manifest carries no machine key');
   const written = JSON.parse(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'));
   assert.equal('machine' in written, false, 'leji.json on disk has no machine key');
   // Decisions and agents still resolve to their defaults under rootPath.
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'decisions', '0001-adopt-leji.md')));
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'agents', 'core.md')));
});

test('the scaffolded core profile fills its escalation placeholder', async () => {
   const dir = gitTmpdir();
   const result = await initLayer({ dir, yes: true });
   const owner = result.manifest.owners.primary.name;
   const core = fs.readFileSync(path.join(dir, 'docs', 'agents', 'core.md'), 'utf8');
   assert.ok(
      core.includes(`Ask the primary owner (${owner}) whenever mustAskWhen applies`),
      'the escalation line names the owner',
   );
   // Nothing angle-bracketed survives into the written profile: a `<...>` in an agent
   // profile is exactly what `leji validate --content` flags as a placeholder. The owner
   // name is removed first because git with no identity yields `<named owner>`, which is
   // the manifest's own fallback rather than an unfilled template slot.
   assert.equal(core.replaceAll(owner, '').includes('<'), false, core);
});

test('indexed init: no machine key, yet the index and changelog are written at the defaults', async () => {
   const dir = gitTmpdir();
   const result = await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });
   commitAll(dir);
   assert.equal(result.manifest.machine, undefined, 'no machine key even at indexed level');
   const written = JSON.parse(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'));
   assert.equal('machine' in written, false, 'leji.json on disk has no machine key');
   // The files are still created at their default locations.
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'context-index.json')), 'index written at default path');
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'context-changelog.json')), 'changelog written at default path');
   assert.ok(result.written.includes('docs/context-index.json'));
   // The resolvers find them: validate reports no errors and conformance verifies indexed.
   const validation = validateLayer(dir);
   assert.deepEqual(
      validation.findings.filter((f) => f.severity === 'error'),
      [],
   );
   const conformance = conformanceReport(dir);
   assert.equal(conformance.verifiedLevel, 'indexed');
});

test('init refuses to overwrite an existing layer', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   await assert.rejects(() => initLayer({ dir, yes: true }), /refuses to overwrite/);
});

test('changelog append-only detects a modified entry', () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });

   const changelogPath = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
   changelog.entries[0].summary = 'Rewritten history.';
   fs.writeFileSync(changelogPath, JSON.stringify(changelog, null, 2) + '\n');

   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'changelog-append-only' && f.severity === 'error'));
});

test('freshness reports expired horizons', () => {
   const dir = copyExample();
   const invariants = path.join(dir, 'docs', 'system', 'invariants.md');
   fs.writeFileSync(
      invariants,
      fs.readFileSync(invariants, 'utf8').replace('reviewAfter: 2026-12-10', 'reviewAfter: 2020-01-01'),
   );
   const { manifest } = loadManifest(dir);
   const report = freshnessReport(dir, manifest!);
   assert.equal(report.expired.length, 1);
   assert.equal(report.findings[0].rule, 'freshness-expired');
   assert.equal(report.findings[0].severity, 'warning');
   const strict = freshnessReport(dir, manifest!, true);
   assert.equal(strict.findings[0].severity, 'error');
});

// Conformance evaluates the directory it is given. A copy outside a git repository
// does not meet `core`'s first requirement, and saying so is the whole point: before
// this, the git item reported `manual`, `manual` was excluded from scoring, and a
// no-git copy was awarded `core` while `validate` was warning that it could not
// claim conformance. `tmpdir()` is deliberate here: it is outside any repository,
// which is exactly the condition under test.
test('a copy outside git does not verify, and says which requirement failed', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });

   const result = conformanceReport(dir);
   assert.equal(result.claimedLevel, 'indexed');
   assert.equal(result.verifiedLevel, null, 'a copy that fails core verifies nothing');

   const git = result.items.find((i) => i.id === 'git');
   assert.equal(git?.status, 'fail', 'no repository is gathered evidence, not missing evidence');

   // `manual` is reserved for the tagged process-attested items; nothing else uses it.
   const manualIds = result.items
      .filter((i) => i.status === 'manual')
      .map((i) => i.id)
      .sort();
   assert.deepEqual(manualIds, ['ci-validates', 'consumed-externally', 'review-gate', 'stale-pin-reporting']);

   // A conditional requirement that does not apply is its own outcome, not `manual`.
   assert.equal(result.items.find((i) => i.id === 'sibling-mounts')?.status, 'not-applicable');

   assert.ok(
      result.findings.some((f) => f.rule === 'conformance-claim'),
      'the claim is refuted, because the failure is definite',
   );
});

test('conformance fails an over-claim', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.conformance.claimedLevel = 'governed';
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   // Remove the freshness horizon so governed fails its machine check.
   const invariants = path.join(dir, 'docs', 'system', 'invariants.md');
   fs.writeFileSync(
      invariants,
      fs.readFileSync(invariants, 'utf8').replace(/freshness:\n  reviewAfter: [0-9-]+\n/, ''),
   );
   writeIndex(dir, { ...manifest });
   const result = conformanceReport(dir);
   assert.equal(result.verifiedLevel, 'indexed');
   assert.ok(result.findings.some((f) => f.rule === 'conformance-claim'));
});
