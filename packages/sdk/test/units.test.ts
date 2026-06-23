import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
   buildSidebar,
   checkChangelogAppendOnly,
   checkIndex,
   compactChangelog,
   conformanceReport,
   freshnessReport,
   generateViewer,
   loadManifest,
   seedChangelogIfMissing,
   serializeChangelog,
   validateLayer,
   writeIndex,
} from '../dist/index.js';
import { bindAgentInManifestText, declareVendorAdapterInManifestText } from '../dist/lib/manifest.js';
import { finding, hasErrors, summarize } from '../dist/lib/findings.js';
import { walkMd, underPath } from '../dist/lib/fsx.js';
import { excludedFromCategories, scanAgentProfiles, scanCategories } from '../dist/lib/layer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

function tmpdir(prefix: string): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyExample(): string {
   const dir = tmpdir('leji-unit-');
   fs.cpSync(exampleDir, dir, { recursive: true });
   return dir;
}

test('index resolves the default path when machine.indexPath is undeclared', () => {
   const dir = tmpdir('leji-noidx-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const { manifest } = loadManifest(dir);
   // rootPath is docs/, so the default index path is docs/context-index.json.
   // No file exists there yet: checkIndex reports index-required (missing file).
   const check = checkIndex(dir, manifest!);
   assert.equal(check.findings[0].rule, 'index-required');
   assert.match(check.findings[0].message, /docs\/context-index\.json does not exist/);
   assert.equal(check.findings[0].path, 'docs/context-index.json');
   // writeIndex now always has a path: it writes to the default and reports no error.
   const write = writeIndex(dir, manifest!);
   assert.ok(!write.findings.some((f) => f.rule === 'index-required'), 'no index-required after write');
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'context-index.json')), 'default index written');
   // The written index is now current.
   assert.equal(checkIndex(dir, manifest!).stale, false);
});

test('no machine block: agents/decisions resolve to docs/agents/ and docs/decisions/', () => {
   const dir = tmpdir('leji-nomachine-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   // The fixture declares no machine block at all.
   const { manifest } = loadManifest(dir);
   assert.equal(manifest!.machine, undefined, 'fixture has no machine block');

   // Drop a valid agent profile at the default profiles location (docs/agents/).
   const agentsDir = path.join(dir, 'docs', 'agents');
   fs.mkdirSync(agentsDir, { recursive: true });
   fs.writeFileSync(
      path.join(agentsDir, 'core.md'),
      [
         '---',
         'id: core',
         'name: Core',
         'role: core',
         'requiredRead:',
         '  - docs/boot-profile.md',
         'mustAskWhen:',
         '  - a proposal weakens an invariant',
         'freshness:',
         '  reviewAfter: 2020-01-01',
         '---',
         '',
         '# Core',
         '',
         'A profile under the default agents directory.',
         '',
      ].join('\n'),
   );

   // scanAgentProfiles finds the profile at the undeclared-but-defaulted path.
   const profiles = scanAgentProfiles(dir, manifest!);
   assert.ok(
      profiles.some((p) => p.relPath === 'docs/agents/core.md' && p.findings.length === 0),
      'profile under docs/agents/ is scanned and valid',
   );

   // freshness includes the profile's horizon (it carries an expired reviewAfter).
   const freshness = freshnessReport(dir, manifest!);
   assert.ok(
      freshness.expired.some((i) => i.path === 'docs/agents/core.md'),
      'profile freshness horizon is included',
   );

   // docs/agents/ is excluded from category content even when undeclared.
   const excluded = excludedFromCategories(manifest!);
   assert.equal(excluded('docs/agents/core.md'), true, 'docs/agents/ excluded from categories');
   const docs = scanCategories(dir, manifest!);
   assert.ok(!docs.some((d) => d.relPath === 'docs/agents/core.md'), 'agent profile is not category content');
});

test('corrupt stored index is artifact-parse', () => {
   const dir = copyExample();
   fs.writeFileSync(path.join(dir, 'docs', 'context-index.json'), '{ not json');
   const { manifest } = loadManifest(dir);
   const result = checkIndex(dir, manifest!);
   assert.equal(result.stale, true);
   assert.equal(result.findings[0].rule, 'artifact-parse');
});

test('corrupt changelog is artifact-parse', () => {
   const dir = copyExample();
   fs.writeFileSync(path.join(dir, 'docs', 'context-changelog.json'), '{ not json');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.equal(result.verified, false);
   assert.equal(result.findings[0].rule, 'artifact-parse');
});

test('changelog entry removal violates append-only', () => {
   const dir = tmpdir('leji-chrm-');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
   const rel = path.join('docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
   changelog.entries.pop();
   fs.writeFileSync(path.join(dir, rel), JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.ok(result.findings.some((f) => f.rule === 'changelog-append-only' && /removed/.test(f.message)));
});

test('duplicate agent-profile ids and unknown inherits are reported', () => {
   const dir = copyExample();
   fs.writeFileSync(
      path.join(dir, 'docs', 'agents', 'extra.md'),
      '---\nid: core\nname: Extra\nrole: extra\ninherits: ghost\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n---\n\n# Extra\n',
   );
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'id-duplicate'));
   assert.ok(result.findings.some((f) => f.rule === 'inherits-unknown' && f.severity === 'warning'));
});

test('frontmatter id wins over slug; invalid frontmatter id is id-pattern', () => {
   const dir = copyExample();
   fs.writeFileSync(path.join(dir, 'docs', 'domain', 'extra.md'), '---\nid: Bad_ID\n---\n\n# Extra Doc\n');
   const { manifest } = loadManifest(dir);
   const result = writeIndex(dir, manifest!);
   assert.ok(result.findings.some((f) => f.rule === 'id-pattern'));
});

test('slug collisions de-collide with the parent directory', () => {
   const dir = copyExample();
   fs.mkdirSync(path.join(dir, 'docs', 'domain', 'payments'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'domain', 'payments', 'glossary.md'), '# Payments Glossary\n');
   const { manifest } = loadManifest(dir);
   const result = writeIndex(dir, manifest!);
   const ids = result.index!.entries.map((e) => e.id);
   assert.equal(new Set(ids).size, ids.length, 'all ids unique');
   assert.ok(ids.includes('payments-glossary'));
});

test('a category path may declare a single file', () => {
   const dir = tmpdir('leji-file-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.categories.system = { paths: ['docs/system-notes.md'] };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   fs.writeFileSync(path.join(dir, 'docs', 'system-notes.md'), '# System Notes\n');
   const result = validateLayer(dir);
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
});

test('declared vendor adapter that redirects passes', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.vendorAdapters = ['CLAUDE.md'];
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Read docs/boot-profile.md and follow it.\n');
   const result = validateLayer(dir);
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
});

test('fsx helpers: walkMd on a file path, underPath edges', () => {
   assert.deepEqual(walkMd(exampleDir, 'docs/domain/glossary.md'), ['docs/domain/glossary.md']);
   assert.deepEqual(walkMd(exampleDir, 'leji.json'), []);
   assert.deepEqual(walkMd(exampleDir, 'docs/nonexistent/'), []);
   assert.equal(underPath('docs/domain/x.md', 'docs/'), true);
   assert.equal(underPath('docs', 'docs/'), true);
   assert.equal(underPath('docsx/y.md', 'docs/'), false);
});

test('audit: path traversal in declared paths is rejected by the manifest schema', () => {
   const dir = tmpdir('leji-trav-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.machine = { indexPath: '../escape-index.json' };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'manifest-schema'));
});

test('audit: malformed changelog entries shape reports findings without crashing', () => {
   const dir = copyExample();
   fs.writeFileSync(path.join(dir, 'docs', 'context-changelog.json'), '{ "schemaVersion": "1.0", "entries": {} }\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'artifact-schema'));
});

test('audit: decision records in a second mapped decisions path are found', () => {
   const dir = tmpdir('leji-dec2-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.categories.decisions.paths = ['docs/adr/', 'docs/decisions/'];
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   fs.mkdirSync(path.join(dir, 'docs', 'adr'));
   fs.writeFileSync(path.join(dir, 'docs', 'adr', 'note.md'), '# Note\n\nNot a decision record.\n');
   const result = validateLayer(dir);
   // The invalid file in the first path is reported, but the valid record in
   // the second path satisfies the decisions-populated requirement.
   assert.ok(result.findings.some((f) => f.rule === 'decision-frontmatter'));
   assert.ok(!result.findings.some((f) => f.rule === 'decisions-empty'));
});

test('audit: agents-map target outside the profiles dir owes valid frontmatter', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.agents.reviewer = 'docs/reviewer.md';
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   fs.writeFileSync(path.join(dir, 'docs', 'reviewer.md'), '# Reviewer\n\nNo frontmatter.\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'profile-frontmatter' && f.path === 'docs/reviewer.md'));
});

test('audit: index --check rejects an unsupported schemaVersion', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   writeIndex(dir, manifest!);
   const rel = path.join(dir, 'docs', 'context-index.json');
   const index = JSON.parse(fs.readFileSync(rel, 'utf8'));
   index.schemaVersion = '2.0';
   fs.writeFileSync(rel, JSON.stringify(index, null, 2) + '\n');
   const result = checkIndex(dir, manifest!);
   assert.equal(result.stale, true);
   assert.ok(result.findings.some((f) => f.rule === 'schema-version'));
});

test('audit: reordering keys in a committed changelog entry is not a violation', () => {
   const dir = tmpdir('leji-reord-');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
   const rel = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(rel, 'utf8'));
   // Reverse the key order of the first entry without changing values.
   changelog.entries[0] = Object.fromEntries(Object.entries(changelog.entries[0]).reverse());
   fs.writeFileSync(rel, JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.ok(!result.findings.some((f) => f.rule === 'changelog-append-only'));
});

test('audit: empty rootPath produces no bogus paths-outside-root warnings', () => {
   const dir = tmpdir('leji-emptyroot-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.rootPath = '';
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(!result.findings.some((f) => f.rule === 'paths-outside-root'));
});

test('quality: generated index content is exact for the example layer', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const result = writeIndex(dir, manifest!);
   const entries = result.index!.entries.map(({ lastModified: _lm, contentHash: _ch, ...rest }) => rest);
   assert.deepEqual(entries, [
      {
         id: 'adopt-leji',
         path: 'docs/decisions/0001-adopt-leji.md',
         title: 'Adopt the Leji context layer',
         category: 'decisions',
      },
      {
         id: 'glossary',
         path: 'docs/domain/glossary.md',
         title: 'Glossary',
         category: 'domain',
         summary: 'What invoice, credit note, and settlement mean at Acme.',
      },
      {
         id: 'system-invariants',
         path: 'docs/system/invariants.md',
         title: 'System Invariants',
         category: 'system',
         summary: 'Money handling, ledger append-only rule, service boundaries.',
         freshness: { reviewAfter: '2026-12-10' },
      },
   ]);
   assert.equal(result.index!.schemaVersion, '1.0');
   assert.equal(result.index!.rootPath, 'docs/');
   for (const entry of result.index!.entries) {
      assert.match(entry.contentHash!, /^sha256:[0-9a-f]{16}$/);
   }
});

test('quality: duplicate decision-record ids are reported', () => {
   const dir = copyExample();
   fs.writeFileSync(
      path.join(dir, 'docs', 'decisions', '0002-duplicate.md'),
      '---\nid: adopt-leji\ntitle: Duplicate\nstatus: accepted\ndate: 2026-06-12\n---\n\n# Duplicate\n',
   );
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'id-duplicate' && f.path === 'docs/decisions/0002-duplicate.md'));
});

test('quality: duplicate frontmatter ids across index docs are reported', () => {
   const dir = copyExample();
   fs.writeFileSync(path.join(dir, 'docs', 'domain', 'extra.md'), '---\nid: glossary\n---\n\n# Extra\n');
   const { manifest } = loadManifest(dir);
   const result = writeIndex(dir, manifest!);
   assert.ok(result.findings.some((f) => f.rule === 'id-duplicate'));
});

test('quality: governed layer with profiles and freshness verifies governed', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.conformance.claimedLevel = 'governed';
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   writeIndex(dir, manifest);
   const result = conformanceReport(dir);
   assert.equal(result.verifiedLevel, 'governed');
   assert.deepEqual(result.findings, []);
   const manual = result.items.filter((i) => i.status === 'manual').map((i) => i.id);
   assert.ok(manual.includes('review-gate') && manual.includes('ci-validates'));
});

test('quality: federated claim with a missing mount path fails sibling-mounts', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.conformance.claimedLevel = 'federated';
   manifest.federation = { mounts: [{ path: 'context/product', name: 'product', owner: { name: 'Jo' } }] };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   writeIndex(dir, manifest);
   const result = conformanceReport(dir);
   const item = result.items.find((i) => i.id === 'sibling-mounts');
   assert.equal(item!.status, 'fail');
   assert.ok(result.findings.some((f) => f.rule === 'conformance-claim'));
});

test('quality: duplicate YAML keys in frontmatter are invalid', () => {
   const dir = copyExample();
   fs.writeFileSync(
      path.join(dir, 'docs', 'agents', 'dup.md'),
      '---\nid: dup\nid: dup2\nname: D\nrole: d\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n---\n\n# D\n',
   );
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'profile-frontmatter' && f.path === 'docs/agents/dup.md'));
});

function gitSeedExample(prefix: string): string {
   const dir = tmpdir(prefix);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
   return dir;
}

test('compaction: dropping the oldest entry with a compaction entry passes', () => {
   const dir = gitSeedExample('leji-compact-');
   const rel = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(rel, 'utf8'));
   const droppedEntry = changelog.entries.shift();
   changelog.entries.push({
      id: 'compact-2026-06',
      date: '2026-06-12',
      type: 'compaction',
      summary: 'Compacted the oldest entry; full record in git history.',
      paths: ['docs/context-changelog.json'],
      compacted: { entries: 1, firstId: droppedEntry.id, lastId: droppedEntry.id },
   });
   fs.writeFileSync(rel, JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
   assert.equal(result.verified, true);
});

test('compaction: dropping the oldest entry without a compaction entry fails', () => {
   const dir = gitSeedExample('leji-compact2-');
   const rel = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(rel, 'utf8'));
   changelog.entries.shift();
   fs.writeFileSync(rel, JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.ok(
      result.findings.some((f) => f.rule === 'changelog-append-only' && /without a compaction entry/.test(f.message)),
   );
});

test('compaction: compacting to an empty changelog fails', () => {
   const dir = gitSeedExample('leji-compact3-');
   const rel = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(rel, 'utf8'));
   changelog.entries = [];
   fs.writeFileSync(rel, JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.ok(result.findings.some((f) => f.rule === 'changelog-append-only' && /compacted to empty/.test(f.message)));
});

// --- changelog compact ---

const CHANGELOG_REL = 'docs/context-changelog.json';

/** Seed a git-committed example whose changelog carries `count` dated entries. */
function seedWithEntries(prefix: string, count: number): string {
   const dir = tmpdir(prefix);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   const abs = path.join(dir, CHANGELOG_REL);
   const log = JSON.parse(fs.readFileSync(abs, 'utf8'));
   log.entries = Array.from({ length: count }, (_, i) => ({
      id: `e-${String(i + 1).padStart(2, '0')}`,
      date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')}`,
      type: 'added',
      summary: `Change ${i + 1}.`,
      paths: [`docs/file-${i + 1}.md`],
   }));
   fs.writeFileSync(abs, JSON.stringify(log, null, 2) + '\n');
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
   return dir;
}

test('compact --keep folds the oldest, keeps the newest N, appends a compaction entry, result validates', () => {
   const dir = seedWithEntries('leji-compact-keep-', 10);
   const { manifest } = loadManifest(dir);
   const result = compactChangelog(dir, manifest!, { keep: 4 });
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
   assert.equal(result.folded, 6);
   assert.equal(result.kept, 5); // 4 survivors + 1 compaction entry

   const log = JSON.parse(fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8'));
   const ids = log.entries.map((e: { id: string }) => e.id);
   // Oldest six (e-01..e-06) folded; newest four (e-07..e-10) survive.
   assert.deepEqual(ids.slice(0, 4), ['e-07', 'e-08', 'e-09', 'e-10']);
   const compaction = log.entries[log.entries.length - 1];
   assert.equal(compaction.type, 'compaction');
   assert.equal(compaction.compacted.entries, 6);
   assert.equal(compaction.compacted.firstId, 'e-01');
   assert.equal(compaction.compacted.lastId, 'e-06');
   assert.deepEqual(compaction.paths, [
      'docs/file-1.md',
      'docs/file-2.md',
      'docs/file-3.md',
      'docs/file-4.md',
      'docs/file-5.md',
      'docs/file-6.md',
   ]);

   // The compacted changelog passes append-only discipline against the git baseline.
   const check = checkChangelogAppendOnly(dir, CHANGELOG_REL);
   assert.deepEqual(
      check.findings.filter((f) => f.severity === 'error'),
      [],
   );
   // And the whole layer still validates clean (schema + currency + discipline).
   assert.ok(!validateLayer(dir).findings.some((f) => f.severity === 'error'), 'layer validates after compact');
});

test('compact --before folds entries dated before the cutoff', () => {
   const dir = seedWithEntries('leji-compact-before-', 10);
   const { manifest } = loadManifest(dir);
   // Entries e-01..e-28 are in 2026-01; e-29+ roll into 2026-02. With 10 entries
   // all are 2026-01; cut before 2026-01-06 folds e-01..e-05 (dates 01..05).
   const result = compactChangelog(dir, manifest!, { before: '2026-01-06' });
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
   assert.equal(result.folded, 5);
   const log = JSON.parse(fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8'));
   const compaction = log.entries[log.entries.length - 1];
   assert.equal(compaction.compacted.firstId, 'e-01');
   assert.equal(compaction.compacted.lastId, 'e-05');
   assert.ok(!checkChangelogAppendOnly(dir, CHANGELOG_REL).findings.some((f) => f.severity === 'error'));
});

test('compact with both flags folds their intersection', () => {
   const dir = seedWithEntries('leji-compact-both-', 10);
   const { manifest } = loadManifest(dir);
   // --keep 3 marks e-01..e-07 foldable; --before 2026-01-04 marks e-01..e-03.
   // The intersection (an entry must satisfy BOTH) is e-01..e-03.
   const result = compactChangelog(dir, manifest!, { keep: 3, before: '2026-01-04' });
   assert.equal(result.folded, 3);
   const log = JSON.parse(fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8'));
   const compaction = log.entries[log.entries.length - 1];
   assert.equal(compaction.compacted.firstId, 'e-01');
   assert.equal(compaction.compacted.lastId, 'e-03');
});

test('compact is a no-op when nothing folds', () => {
   const dir = seedWithEntries('leji-compact-noop-', 5);
   const { manifest } = loadManifest(dir);
   const before = fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8');
   const result = compactChangelog(dir, manifest!, { keep: 10 }); // keep more than exist
   assert.equal(result.folded, 0);
   assert.deepEqual(result.findings, []);
   assert.equal(fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8'), before, 'file unchanged on no-op');
});

test('compact dedupes the compaction id when one already exists for today', () => {
   const dir = seedWithEntries('leji-compact-dedupe-', 6);
   const today = new Date().toISOString().slice(0, 10);
   const abs = path.join(dir, CHANGELOG_REL);
   const log = JSON.parse(fs.readFileSync(abs, 'utf8'));
   log.entries[0].id = `compaction-${today}`; // collide with the id the compactor will pick
   fs.writeFileSync(abs, JSON.stringify(log, null, 2) + '\n');
   const { manifest } = loadManifest(dir);
   const result = compactChangelog(dir, manifest!, { keep: 2 });
   assert.ok(result.folded > 0);
   const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
   const compaction = after.entries[after.entries.length - 1];
   assert.equal(compaction.id, `compaction-${today}-2`);
});

// --- compactChangelog API-level argument validation (no file touched) ---

for (const keep of [0, -1, 2.5]) {
   test(`compact rejects keep=${keep} as invalid-argument without touching the file`, () => {
      const dir = seedWithEntries('leji-compact-badkeep-', 5);
      const before = fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8');
      const { manifest } = loadManifest(dir);
      const result = compactChangelog(dir, manifest!, { keep });
      assert.equal(result.folded, 0);
      assert.equal(result.kept, 0);
      assert.equal(result.path, CHANGELOG_REL);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].rule, 'invalid-argument');
      assert.equal(result.findings[0].severity, 'error');
      assert.match(result.findings[0].message, /keep must be a positive integer/);
      assert.equal(fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8'), before, 'file untouched on invalid keep');
   });
}

for (const before of ['2026-1-1', 'nope', '2026/01/01', '20260101']) {
   test(`compact rejects malformed before=${before} as invalid-argument`, () => {
      const dir = seedWithEntries('leji-compact-badbefore-', 5);
      const { manifest } = loadManifest(dir);
      const result = compactChangelog(dir, manifest!, { before });
      assert.equal(result.folded, 0);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].rule, 'invalid-argument');
      assert.match(result.findings[0].message, /before must be a YYYY-MM-DD date/);
   });
}

test('compact reports changelog-required when the changelog file is missing', () => {
   const dir = seedWithEntries('leji-compact-missing-', 5);
   fs.rmSync(path.join(dir, CHANGELOG_REL));
   const { manifest } = loadManifest(dir);
   const result = compactChangelog(dir, manifest!, { keep: 2 });
   assert.equal(result.folded, 0);
   assert.equal(result.kept, 0);
   assert.ok(result.findings.some((f) => f.rule === 'changelog-required' && f.severity === 'error'));
});

test('compact --before earlier than every entry is a no-op', () => {
   const dir = seedWithEntries('leji-compact-beforenoop-', 5);
   const { manifest } = loadManifest(dir);
   const before = fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8');
   // All seeded entries are dated 2026-01-xx; a 2025 cutoff folds nothing.
   const result = compactChangelog(dir, manifest!, { before: '2025-01-01' });
   assert.equal(result.folded, 0);
   assert.deepEqual(result.findings, []);
   assert.equal(result.kept, 5);
   assert.equal(fs.readFileSync(path.join(dir, CHANGELOG_REL), 'utf8'), before, 'file unchanged on no-op');
});

test('compact orders folds by the canonical (date, id) tiebreak when dates collide', () => {
   const dir = seedWithEntries('leji-compact-tiebreak-', 3);
   const abs = path.join(dir, CHANGELOG_REL);
   const log = JSON.parse(fs.readFileSync(abs, 'utf8'));
   // Three entries share one date; array order is shuffled so only the (date,id)
   // tiebreak can produce a deterministic firstId/lastId range.
   log.entries = [
      { id: 'b', date: '2026-01-01', type: 'added', summary: 'b', paths: ['docs/b.md'] },
      { id: 'c', date: '2026-01-01', type: 'added', summary: 'c', paths: ['docs/c.md'] },
      { id: 'a', date: '2026-01-01', type: 'added', summary: 'a', paths: ['docs/a.md'] },
   ];
   fs.writeFileSync(abs, JSON.stringify(log, null, 2) + '\n');
   const { manifest } = loadManifest(dir);
   const result = compactChangelog(dir, manifest!, { keep: 1 });
   assert.equal(result.folded, 2);
   const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
   const compaction = after.entries[after.entries.length - 1];
   // Canonical order is a,b,c; keep 1 folds a and b (oldest two by id).
   assert.equal(compaction.compacted.firstId, 'a');
   assert.equal(compaction.compacted.lastId, 'b');
   // The survivor is the canonically-newest entry, c.
   const survivors = after.entries.filter((e: { type: string }) => e.type !== 'compaction');
   assert.deepEqual(
      survivors.map((e: { id: string }) => e.id),
      ['c'],
   );
});

test('compact refuses to write through a symlinked ancestor that escapes the root', () => {
   const dir = seedWithEntries('leji-compact-symesc-', 6);
   const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-compact-outside-'));
   // Replace docs with a symlink to an outside dir, then point the changelog at a
   // real, foldable file living under that escaping path.
   fs.symlinkSync(outside, path.join(dir, 'docs', 'evil'));
   const rel = 'docs/evil/context-changelog.json';
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.machine = { ...(m.machine ?? {}), changelogPath: rel };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.writeFileSync(
      path.join(outside, 'context-changelog.json'),
      JSON.stringify(
         {
            schemaVersion: '1.0',
            entries: [
               { id: 'e-1', date: '2026-01-01', type: 'added', summary: 'one', paths: ['docs/a.md'] },
               { id: 'e-2', date: '2026-01-02', type: 'added', summary: 'two', paths: ['docs/b.md'] },
            ],
         },
         null,
         2,
      ) + '\n',
   );
   const { manifest } = loadManifest(dir);
   const result = compactChangelog(dir, manifest!, { keep: 1 });
   assert.equal(result.folded, 0);
   assert.ok(
      result.findings.some((f) => f.severity === 'error' && /resolves outside the layer root/.test(f.message)),
      'the escape is reported as an error finding',
   );
   // Nothing rewritten through the escaping path.
   const onDisk = JSON.parse(fs.readFileSync(path.join(outside, 'context-changelog.json'), 'utf8'));
   assert.equal(onDisk.entries.length, 2, 'original file left intact');
});

// --- seedChangelogIfMissing ---

test('seedChangelogIfMissing does not seed a core-level layer', () => {
   const dir = tmpdir('leji-seed-core-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const { manifest } = loadManifest(dir);
   const result = seedChangelogIfMissing(dir, manifest!);
   assert.equal(result, null);
   assert.equal(fs.existsSync(path.join(dir, 'docs', 'context-changelog.json')), false);
});

test('seedChangelogIfMissing writes a changelog for an indexed layer when missing', () => {
   const dir = tmpdir('leji-seed-indexed-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.conformance = { ...(m.conformance ?? {}), claimedLevel: 'indexed' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const { manifest } = loadManifest(dir);
   const rel = seedChangelogIfMissing(dir, manifest!);
   assert.equal(rel, 'docs/context-changelog.json');
   const abs = path.join(dir, rel!);
   assert.ok(fs.existsSync(abs));
   const log = JSON.parse(fs.readFileSync(abs, 'utf8'));
   assert.equal(log.entries[0].id, 'seed-changelog');
   assert.equal(log.entries[0].approvedBy, manifest!.owners.primary.name);
});

test('seedChangelogIfMissing does not re-seed when a changelog already exists', () => {
   const dir = tmpdir('leji-seed-present-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.conformance = { ...(m.conformance ?? {}), claimedLevel: 'indexed' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const abs = path.join(dir, 'docs', 'context-changelog.json');
   const sentinel = JSON.stringify({ schemaVersion: '1.0', entries: [] }, null, 2) + '\n';
   fs.writeFileSync(abs, sentinel);
   const { manifest } = loadManifest(dir);
   const result = seedChangelogIfMissing(dir, manifest!);
   assert.equal(result, null);
   assert.equal(fs.readFileSync(abs, 'utf8'), sentinel, 'existing changelog left untouched');
});

test('seedChangelogIfMissing refuses a path escaping the root via a symlinked ancestor', () => {
   const dir = tmpdir('leji-seed-symesc-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-seed-outside-'));
   fs.symlinkSync(outside, path.join(dir, 'docs', 'evil'));
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.conformance = { ...(m.conformance ?? {}), claimedLevel: 'indexed' };
   m.machine = { ...(m.machine ?? {}), changelogPath: 'docs/evil/context-changelog.json' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const { manifest } = loadManifest(dir);
   const result = seedChangelogIfMissing(dir, manifest!);
   assert.equal(result, null, 'nothing seeded when the path escapes the root');
   assert.equal(fs.existsSync(path.join(outside, 'context-changelog.json')), false, 'nothing written outside the root');
});

// --- serializeChangelog: extra-key preservation (covers the deterministic spill order) ---

test('serializeChangelog preserves unknown entry and top-level keys in deterministic order', () => {
   const out = serializeChangelog({
      $schema: 'https://leji.org/schemas/v1.0/context-changelog.schema.json',
      schemaVersion: '1.0',
      // Extra top-level keys beyond $schema/schemaVersion/entries must be preserved.
      metadata: { source: 'test' },
      entries: [{ id: 'x', date: '2026-01-01', type: 'added', summary: 's', zebra: 1, alpha: 2 }],
   });
   const parsed = JSON.parse(out);
   assert.deepEqual(parsed.metadata, { source: 'test' }, 'extra top-level key preserved');
   const topKeys = Object.keys(parsed);
   assert.equal(topKeys[0], '$schema');
   assert.equal(topKeys[1], 'schemaVersion');
   const keys = Object.keys(parsed.entries[0]);
   // Known keys first (schema order), then extras alphabetically: alpha before zebra.
   assert.ok(keys.indexOf('alpha') < keys.indexOf('zebra'), 'extra keys spill in sorted order');
   assert.ok(keys.indexOf('summary') < keys.indexOf('alpha'), 'known keys precede extras');
   assert.equal(out.endsWith('\n'), true, 'trailing newline');
});

test('viewer: generates viewer + sidebar that reflect the layer', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const result = generateViewer(dir, manifest!);
   assert.deepEqual(result.written, [
      'docs/.leji/viewer/index.html',
      'docs/.leji/viewer/_sidebar.md',
      'docs/.leji/viewer/assets/docsify-copy-code.min.js',
      'docs/.leji/viewer/assets/docsify-mermaid.js',
      'docs/.leji/viewer/assets/docsify-sidebar-collapse.min.css',
      'docs/.leji/viewer/assets/docsify-sidebar-collapse.min.js',
      'docs/.leji/viewer/assets/docsify.min.js',
      'docs/.leji/viewer/assets/leji-logo.svg',
      'docs/.leji/viewer/assets/mermaid.min.js',
      'docs/.leji/viewer/assets/prism-bash.min.js',
      'docs/.leji/viewer/assets/prism-json.min.js',
      'docs/.leji/viewer/assets/prism-markdown.min.js',
      'docs/.leji/viewer/assets/prism-typescript.min.js',
      'docs/.leji/viewer/assets/search.min.js',
      'docs/.leji/viewer/assets/viewer-boot.js',
      'docs/.leji/viewer/assets/vue.css',
      'docs/.leji/viewer/assets/zoom-image.min.js',
      'docs/overview.md',
   ]);
   const viewer = path.join(dir, 'docs', '.leji', 'viewer');
   const html = fs.readFileSync(path.join(viewer, 'index.html'), 'utf8');
   assert.ok(html.includes('acme-billing-context'), 'layer name baked into the JSON config');
   assert.ok(html.includes('viewer-boot.js'), 'boot script (carrying the frontmatter hook) is wired');
   const bootJs = fs.readFileSync(path.join(viewer, 'assets', 'viewer-boot.js'), 'utf8');
   assert.ok(bootJs.includes('stripFrontmatter'), 'frontmatter hook present in the vendored boot script');
   assert.ok(bootJs.includes("basePath: '/content/'"), 'content mount configured in the boot script');
   assert.ok(html.includes('"homepage":"overview.md"'), 'the overview is the homepage');
   assert.ok(html.includes('<title>acme-billing-context</title>'), 'escaped layer name in title');
   // Default theming: the Leji mark (in the name HTML, served relative to the page so
   // basePath does not break it) and the brand blue.
   assert.ok(html.includes('/assets/leji-logo.svg'), 'default Leji logo wired into the name');
   assert.ok(html.includes('"themeColor":"#223F93"'), 'default brand color wired');
   // Mermaid is on by default: the two scripts + their assets are present.
   assert.ok(html.includes('assets/mermaid.min.js'), 'mermaid script wired by default');
   assert.ok(html.includes('assets/docsify-mermaid.js'), 'mermaid plugin wired by default');
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'mermaid.min.js')), 'mermaid asset copied');
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'leji-logo.svg')), 'logo asset vendored');
   // The vendored assets (core + theme + search/collapse plugins) land alongside
   // the page (no remote CDN).
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'docsify.min.js')));
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'vue.css')));
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'search.min.js')));
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'docsify-sidebar-collapse.min.js')));
   assert.ok(!fs.existsSync(path.join(viewer, 'assets', 'PROVENANCE.txt')), 'provenance not copied');
   const sidebar = fs.readFileSync(path.join(viewer, '_sidebar.md'), 'utf8');
   assert.equal(
      sidebar,
      [
         '- [🤖 Boot profile](boot-profile.md)',
         '',
         '---',
         '',
         '- 📖 Domain',
         '  - [Glossary](domain/glossary.md)',
         '- ⚙️ System',
         '  - [System Invariants](system/invariants.md)',
         '- 🧭 Decisions',
         '  - [Adopt the Leji context layer](decisions/0001-adopt-leji.md)',
         '',
      ].join('\n'),
   );
   // Deterministic: regeneration is byte-identical.
   generateViewer(dir, manifest!);
   assert.equal(fs.readFileSync(path.join(viewer, '_sidebar.md'), 'utf8'), sidebar);
});

test('viewer: theme overrides (logo, primary color, category emoji) flow into the viewer', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   manifest!.viewer = {
      logo: 'assets/brand.svg',
      theme: { primary: '#FF6600' },
      categoryEmojis: { domain: '💰' },
   };
   generateViewer(dir, manifest!);
   const viewer = path.join(dir, 'docs', '.leji', 'viewer');
   const html = fs.readFileSync(path.join(viewer, 'index.html'), 'utf8');
   // A relative logo path is served from the content mount; absolute/url is used as-is.
   assert.ok(html.includes('/content/assets/brand.svg'), 'configured logo resolved under /content/');
   assert.ok(html.includes('"themeColor":"#FF6600"'), 'configured primary color wins');
   const sidebar = fs.readFileSync(path.join(viewer, '_sidebar.md'), 'utf8');
   assert.match(sidebar, /^- 💰 Domain$/m, 'category emoji override applied');
   assert.match(sidebar, /^- ⚙️ System$/m, 'unoverridden categories keep the default emoji');
});

test('viewer: seeds an editable overview homepage with a generated layer map', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const overview = path.join(dir, 'docs', 'overview.md');
   assert.ok(fs.existsSync(overview), 'overview.md seeded at the content root');
   const text = fs.readFileSync(overview, 'utf8');
   assert.match(text, /^# acme-billing-context$/m, 'titled with the layer name');
   assert.match(text, /<!-- leji:generated-map:start -->/, 'carries the regen markers');
   assert.match(text, /```mermaid\nflowchart TD/, 'the map is a mermaid flowchart');
   assert.match(text, /boot --> cat_domain/, 'boot links to the domain category');
   assert.match(text, /cat_domain --> n_glossary/, 'category links to its docs');
});

test('viewer: overview is seeded once; only the marked map block is regenerated', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const overview = path.join(dir, 'docs', 'overview.md');
   // The owner rewrites the prose but keeps the markers.
   const edited = `# My own title\n\nHand-written intro.\n\n<!-- leji:generated-map:start -->\nstale\n<!-- leji:generated-map:end -->\n\nMore prose.\n`;
   fs.writeFileSync(overview, edited);
   const result = generateViewer(dir, manifest!);
   const after = fs.readFileSync(overview, 'utf8');
   assert.match(after, /^# My own title$/m, 'owner prose preserved');
   assert.match(after, /More prose\./, 'trailing prose preserved');
   assert.match(after, /```mermaid\nflowchart TD/, 'the stale map block was refreshed');
   assert.ok(!after.includes('\nstale\n'), 'old map content replaced');
   assert.ok(
      !result.findings.some((f) => f.rule === 'overview-markers-missing'),
      'no warning when the markers are intact',
   );
});

test('viewer: an overview without markers is left untouched and warns', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const overview = path.join(dir, 'docs', 'overview.md');
   const custom = '# Fully custom\n\nNo markers here at all.\n';
   fs.writeFileSync(overview, custom);
   const result = generateViewer(dir, manifest!);
   assert.equal(fs.readFileSync(overview, 'utf8'), custom, 'a marker-less overview is never modified');
   assert.ok(
      result.findings.some((f) => f.rule === 'overview-markers-missing' && f.severity === 'warning'),
      'warns that the map was not refreshed',
   );
});

test('viewer build: exports a self-contained static folder carrying the protect warning', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   const r = buildViewer(dir, manifest!, 'out');
   assert.equal(r.out, 'out');
   const out = path.join(dir, 'out');
   // Chrome at the web root.
   assert.ok(fs.existsSync(path.join(out, 'index.html')));
   assert.ok(fs.existsSync(path.join(out, 'assets', 'docsify.min.js')));
   // The layer's markdown under /content/ (including the seeded overview + sidebar).
   assert.ok(fs.existsSync(path.join(out, 'content', 'boot-profile.md')));
   assert.ok(fs.existsSync(path.join(out, 'content', 'overview.md')));
   assert.ok(fs.existsSync(path.join(out, 'content', '_sidebar.md')));
   assert.ok(fs.existsSync(path.join(out, 'content', 'domain', 'glossary.md')));
   // The contained, regenerable .leji/ is never exported into the content.
   assert.ok(!fs.existsSync(path.join(out, 'content', '.leji')));
   // The protect-your-context warning rides in the exported index.html as a comment.
   const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
   assert.match(html, /^<!--/, 'warning comment is prepended');
   assert.match(html, /Host the exported folder behind internal authentication/);
});

test('viewer: mermaid disabled omits the scripts and skips the heavy asset', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   manifest!.viewer = { mermaid: false };
   const result = generateViewer(dir, manifest!);
   const viewer = path.join(dir, 'docs', '.leji', 'viewer');
   const html = fs.readFileSync(path.join(viewer, 'index.html'), 'utf8');
   assert.ok(!html.includes('mermaid.min.js'), 'no mermaid script when disabled');
   assert.ok(!html.includes('docsify-mermaid.js'), 'no mermaid plugin when disabled');
   assert.ok(!fs.existsSync(path.join(viewer, 'assets', 'mermaid.min.js')), 'mermaid asset not copied');
   assert.ok(!result.written.some((w) => w.includes('mermaid')), 'mermaid not in the written list');
   // The non-mermaid polish plugins still ship.
   assert.ok(html.includes('docsify-copy-code.min.js'), 'copy-code still wired when mermaid is off');
});

test('viewer: init --yes then viewer yields a browsable scaffold', async () => {
   const dir = tmpdir('leji-docs-init-');
   const { initLayer: init } = await import('../dist/index.js');
   await init({ dir, yes: true, name: 'demo-context' });
   const { manifest } = loadManifest(dir);
   const result = generateViewer(dir, manifest!);
   assert.equal(result.entries, 3);
   assert.ok(fs.existsSync(path.join(dir, 'docs', '.leji', 'viewer', 'index.html')));
});

test('init: writes .gitignore with .leji/ (idempotent)', async () => {
   const dir = tmpdir('leji-gitignore-');
   const { initLayer: init } = await import('../dist/index.js');
   await init({ dir, yes: true, name: 'demo-context' });
   const gitignore = path.join(dir, '.gitignore');
   assert.ok(fs.existsSync(gitignore), '.gitignore created at the repo root');
   const text = fs.readFileSync(gitignore, 'utf8');
   assert.ok(
      text.split('\n').includes('.leji/'),
      '.leji/ ignored so the generated viewer and onboarding brief stay out of VCS',
   );
   // Idempotent: an adopt-style second relevant run (here, ensure no duplication
   // when the entry is already present) leaves a single .leji/ line.
   const occurrences = text.split('\n').filter((l) => l === '.leji/').length;
   assert.equal(occurrences, 1, '.leji/ appears exactly once');
   // The .gitignore is not part of the written list.
   const result = await init({ dir: tmpdir('leji-gitignore2-'), yes: true });
   assert.ok(!result.written.includes('.gitignore'), '.gitignore is not in the written list');
});

test('viewer: serve serves the scaffold on localhost', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const { serveViewer: serve } = await import('../dist/index.js');
   const server = await serve(dir, 0, manifest!.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      // The viewer chrome is served at the web root, no redirect needed.
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /viewer-boot\.js/);
      // Viewer assets are served from the root.
      const asset = await fetch(`http://127.0.0.1:${port}/assets/docsify.min.js`);
      assert.equal(asset.status, 200);
      // The layer's markdown is mounted under /content/.
      const md = await fetch(`http://127.0.0.1:${port}/content/domain/glossary.md`);
      assert.equal(md.status, 200);
      // The generated sidebar is served as if at the content root.
      const sb = await fetch(`http://127.0.0.1:${port}/content/_sidebar.md`);
      assert.equal(sb.status, 200);
      // The internal .leji path is not reachable by a direct URL.
      const dotLeji = await fetch(`http://127.0.0.1:${port}/content/.leji/viewer/index.html`);
      assert.equal(dotLeji.status, 404, 'the .leji dir is reachable only through the mounts');
      const traversal = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
      assert.notEqual(traversal.status, 200, 'path traversal refused');
   } finally {
      server.close();
   }
});

test('viewer: port precedence is flag, then manifest viewer.port, then 5354', async () => {
   const { resolveViewerPort } = await import('../dist/index.js');
   const base = JSON.parse(fs.readFileSync(path.join(exampleDir, 'leji.json'), 'utf8'));
   assert.equal(resolveViewerPort(base), 5354);
   assert.equal(resolveViewerPort({ ...base, viewer: { port: 21300 } }), 21300);
   assert.equal(resolveViewerPort({ ...base, viewer: { port: 21300 } }, 4000), 4000);
   assert.equal(resolveViewerPort({ ...base, viewer: { port: 21300 } }, 0), 0);
});

test('viewer: manifest with a viewer block validates', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.viewer = { port: 21300 };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
});

// Changelog order is derived from (date, id), not array position
// (machine-readable-surface.md req 3): reordering the entries array is allowed.
test('changelog: reordering the entries array is not a violation', () => {
   const dir = gitSeedExample('leji-entry-reord-');
   const rel = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(rel, 'utf8'));
   changelog.entries.reverse();
   fs.writeFileSync(rel, JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.ok(!result.findings.some((f) => f.rule === 'changelog-append-only'));
});

test('findings: hasErrors is true only when an error-severity finding is present', () => {
   assert.equal(hasErrors([]), false);
   assert.equal(hasErrors([finding('r', 'warning', 'w')]), false);
   assert.equal(hasErrors([finding('r', 'warning', 'w'), finding('r', 'error', 'e')]), true);
});

test('findings: summarize counts errors and warnings independently', () => {
   const summary = summarize([finding('a', 'error', 'e1'), finding('b', 'warning', 'w1'), finding('c', 'error', 'e2')]);
   assert.deepEqual(summary, { errors: 2, warnings: 1 });
});

test('freshness: same-date items sort by path; distinct dates sort by date', () => {
   const dir = copyExample();
   // Three expired docs: two share one past horizon and one is earlier. This
   // exercises the date tie-break (sort by path) and the distinct-date
   // comparator branches in freshnessReport, all observable via expired.
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'b-doc.md'),
      '---\ntitle: B\nfreshness:\n  reviewAfter: 2021-05-05\n---\n\n# B\n',
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'a-doc.md'),
      '---\ntitle: A\nfreshness:\n  reviewAfter: 2021-05-05\n---\n\n# A\n',
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'c-doc.md'),
      '---\ntitle: C\nfreshness:\n  reviewAfter: 2020-01-01\n---\n\n# C\n',
   );
   const { manifest } = loadManifest(dir);
   const report = freshnessReport(dir, manifest!);
   const ordered = report.expired.map((i) => path.basename(i.path));
   const c = ordered.indexOf('c-doc.md');
   const a = ordered.indexOf('a-doc.md');
   const b = ordered.indexOf('b-doc.md');
   assert.ok(a !== -1 && b !== -1 && c !== -1, 'all three expired docs present');
   assert.ok(c < a, 'earlier date (c, 2020) sorts before the 2021 pair');
   assert.ok(a < b, 'same-date entries sort by path (a before b)');
   // declared counts every doc with a horizon, including the system invariants doc.
   assert.equal(report.declared, 4);
});

test('viewer: buildSidebar skips the boot profile and entries that fall outside rootPath', () => {
   const base = JSON.parse(fs.readFileSync(path.join(exampleDir, 'leji.json'), 'utf8'));
   // Boot profile outside rootPath: relativeToRoot returns null, so no boot line.
   const manifest = { ...base, bootProfilePath: 'README.md', rootPath: 'docs/' };
   const sidebar = buildSidebar(manifest, [
      { path: 'docs/domain/glossary.md', title: 'Glossary', category: 'domain' },
      // Entry outside rootPath is dropped (relativeToRoot returns null).
      { path: 'outside/notes.md', title: 'Outside', category: 'domain' },
   ]);
   assert.ok(!sidebar.includes('Boot profile'), 'boot profile outside root is omitted');
   assert.ok(sidebar.includes('Glossary'), 'in-root entry is kept');
   assert.ok(!sidebar.includes('Outside'), 'out-of-root entry is dropped');
});

test('changelog: a declared changelog that does not exist is changelog-required', () => {
   const dir = copyExample();
   const result = checkChangelogAppendOnly(dir, 'docs/missing-changelog.json');
   assert.equal(result.verified, false);
   assert.ok(result.findings.some((f) => f.rule === 'changelog-required'));
});

test('changelog: a new changelog not yet at HEAD verifies (nothing to diff)', () => {
   const dir = gitSeedExample('leji-newcl-');
   // A changelog file present in the working tree but never committed: gitShowHead
   // returns null, so there is no HEAD baseline to diff and the check passes.
   const rel = 'docs/fresh-changelog.json';
   fs.writeFileSync(
      path.join(dir, rel),
      JSON.stringify(
         {
            schemaVersion: '1.0',
            entries: [{ id: 'e-1', date: '2026-06-13', type: 'added', summary: 'x', paths: ['docs/x.md'] }],
         },
         null,
         2,
      ) + '\n',
   );
   const result = checkChangelogAppendOnly(dir, rel);
   assert.equal(result.verified, true);
   assert.ok(!result.findings.some((f) => f.rule === 'changelog-append-only'));
});

test('changelog: an unparseable HEAD baseline is treated as no baseline', () => {
   const dir = tmpdir('leji-headbad-');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   const rel = path.join('docs', 'context-changelog.json');
   // Commit a NON-JSON changelog as the HEAD baseline, then replace the working
   // tree with a valid one. The HEAD JSON.parse throws and the check returns
   // verified with no append-only violation.
   fs.writeFileSync(path.join(dir, rel), 'not json at head\n');
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
   fs.writeFileSync(
      path.join(dir, rel),
      JSON.stringify(
         {
            schemaVersion: '1.0',
            entries: [{ id: 'e-1', date: '2026-06-13', type: 'added', summary: 'x', paths: ['docs/x.md'] }],
         },
         null,
         2,
      ) + '\n',
   );
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.equal(result.verified, true);
   assert.ok(!result.findings.some((f) => f.rule === 'changelog-append-only'));
});

test('validate: indexed claim with no declared changelogPath resolves the default path', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   // indexed is already claimed; drop the changelog declaration entirely. The
   // example ships docs/context-changelog.json at the default path, so the
   // effective resolver finds it and validation does not report changelog-required.
   delete manifest.machine.changelogPath;
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(
      !result.findings.some((f) => f.rule === 'changelog-required'),
      'default changelog path is resolved, not reported missing',
   );
});

test('validate: indexed claim with no changelog at the default path is changelog-required', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   delete manifest.machine.changelogPath;
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   // Remove the default-path changelog so nothing resolves.
   fs.rmSync(path.join(dir, 'docs', 'context-changelog.json'));
   const result = validateLayer(dir);
   assert.ok(
      result.findings.some(
         (f) =>
            f.rule === 'changelog-required' &&
            f.path === 'docs/context-changelog.json' &&
            /does not exist/.test(f.message),
      ),
   );
});

test('validate: indexed claim with a declared but missing changelog is changelog-required', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.machine.changelogPath = 'docs/does-not-exist.json';
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(
      result.findings.some(
         (f) =>
            f.rule === 'changelog-required' &&
            f.path === 'docs/does-not-exist.json' &&
            /does not exist/.test(f.message),
      ),
   );
});

test('conformance: a schema-invalid changelog fails the indexed changelog item', () => {
   const dir = copyExample();
   // Break the changelog shape so checkChangelogAppendOnly yields error findings,
   // driving the conformance changelog item to a hard fail (not manual).
   fs.writeFileSync(path.join(dir, 'docs', 'context-changelog.json'), '{ "schemaVersion": "1.0", "entries": {} }\n');
   const result = conformanceReport(dir);
   const item = result.items.find((i) => i.id === 'changelog');
   assert.equal(item!.status, 'fail');
   assert.ok(item!.detail && item!.detail.length > 0, 'fail carries the first error message');
});

test('checkIndex: a parseable but schema-invalid stored index reports artifact-schema', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   writeIndex(dir, manifest!);
   const rel = path.join(dir, 'docs', 'context-index.json');
   const index = JSON.parse(fs.readFileSync(rel, 'utf8'));
   // Valid JSON, wrong shape: entries must be an array of objects.
   index.entries = 'not-an-array';
   fs.writeFileSync(rel, JSON.stringify(index, null, 2) + '\n');
   const result = checkIndex(dir, manifest!);
   assert.equal(result.stale, true);
   assert.ok(result.findings.some((f) => f.rule === 'artifact-schema'));
});

test('validate: a layer mapping neither domain nor system is categories-minimum', () => {
   const dir = tmpdir('leji-catmin-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   // Drop domain, leaving only decisions: the domain-or-system requirement fails.
   delete manifest.categories.domain;
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'categories-minimum' && f.path === 'leji.json'));
});

test('validate: a declared category path that does not exist is category-path-missing', () => {
   const dir = tmpdir('leji-catmiss-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.categories.domain.paths = ['docs/ghost/'];
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'category-path-missing' && f.path === 'docs/ghost/'));
});

// Changelog dates are UTC (machine-readable-surface.md req 6): a date-only value
// or a `…Z` timestamp is accepted; zoneless times and non-UTC offsets are not.
test('changelog: date accepts UTC forms and rejects offsets/zoneless times', async () => {
   const { schemaErrors } = await import('../dist/lib/schemas.js');
   const withDate = (date: string) => ({
      schemaVersion: '1.0',
      entries: [{ id: 'e-1', date, type: 'added', summary: 'x', paths: ['docs/x.md'] }],
   });
   const dateError = (date: string) =>
      schemaErrors('context-changelog', withDate(date)).some((e: string) => /date|pattern/i.test(e));

   assert.ok(!dateError('2026-06-13'), 'date-only is UTC start-of-day');
   assert.ok(!dateError('2026-06-13T15:04:05Z'), 'full Z timestamp is allowed');
   assert.ok(!dateError('2026-06-13T15:04:05.123Z'), 'fractional Z timestamp is allowed');
   assert.ok(dateError('2026-06-13T15:04:05'), 'zoneless time is rejected');
   assert.ok(dateError('2026-06-13T15:04:05+09:00'), 'non-UTC offset is rejected');
   assert.ok(dateError('June 13'), 'non-ISO date is rejected');
});

// --- in-place manifest text edits (byte-exact, the cross-SDK parity contract) ---

const MANIFEST_NO_AGENTS = `{
  "leji": "1.0",
  "categories": {},
  "owners": {
    "primary": { "name": "x" }
  }
}
`;

test('bindAgentInManifestText creates the agents map in schema position', () => {
   const res = bindAgentInManifestText(MANIFEST_NO_AGENTS, 'reviewer', 'docs/agents/reviewer.md');
   assert.equal(res.changed, true);
   assert.equal(
      res.text,
      `{
  "leji": "1.0",
  "categories": {},
  "agents": {
    "reviewer": "docs/agents/reviewer.md"
  },
  "owners": {
    "primary": { "name": "x" }
  }
}
`,
   );
});

test('bindAgentInManifestText prepends a second agent and is idempotent', () => {
   const one = bindAgentInManifestText(MANIFEST_NO_AGENTS, 'reviewer', 'docs/agents/reviewer.md').text;
   const two = bindAgentInManifestText(one, 'thought-partner', 'docs/agents/thought-partner.md');
   assert.equal(two.changed, true);
   assert.match(
      two.text,
      /"agents": \{\n {4}"thought-partner": "docs\/agents\/thought-partner.md",\n {4}"reviewer": "docs\/agents\/reviewer.md"\n {2}\},/,
   );
   // A name already bound leaves the text untouched.
   const again = bindAgentInManifestText(two.text, 'reviewer', 'docs/agents/reviewer.md');
   assert.equal(again.changed, false);
   assert.equal(again.text, two.text);
});

test('declareVendorAdapterInManifestText creates the array, prepends, and dedupes', () => {
   const created = declareVendorAdapterInManifestText(MANIFEST_NO_AGENTS, 'AGENTS.md');
   assert.equal(created.changed, true);
   assert.equal(
      created.text,
      `{
  "leji": "1.0",
  "categories": {},
  "vendorAdapters": [
    "AGENTS.md"
  ],
  "owners": {
    "primary": { "name": "x" }
  }
}
`,
   );
   const second = declareVendorAdapterInManifestText(created.text, 'CLAUDE.md');
   assert.match(second.text, /"vendorAdapters": \[\n {4}"CLAUDE.md",\n {4}"AGENTS.md"\n {2}\],/);
   const dupe = declareVendorAdapterInManifestText(second.text, 'AGENTS.md');
   assert.equal(dupe.changed, false);
   assert.equal(dupe.text, second.text);
});
