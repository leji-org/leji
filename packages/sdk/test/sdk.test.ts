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

function copyExample(): string {
   const dir = tmpdir();
   fs.cpSync(exampleDir, dir, { recursive: true });
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

test('init --yes at indexed level verifies its claim immediately', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });
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
