import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import {
   buildSidebar,
   buildManifestPage,
   ciProviderFromRemote,
   ensureCiWorkflow,
   ensureLocalHook,
   checkChangelogAppendOnly,
   checkIndex,
   compactChangelog,
   conformanceReport,
   freshnessReport,
   generateViewer,
   loadManifest,
   pickDocsRoot,
   seedChangelogIfMissing,
   serializeChangelog,
   statusReport,
   urlPathToRel,
   validateLayer,
   writeIndex,
} from '../dist/index.js';
import { bindAgentInManifestText } from '../dist/lib/manifest.js';
import {
   cacheKeyFor,
   hydrateMounts,
   mountStatus,
   normalizeSource,
   validTrackingRef,
   witnessRefFor,
} from '../dist/lib/mounts.js';
import { finding, hasErrors, summarize } from '../dist/lib/findings.js';
import { joinUnderRoot, walkMd, underPath } from '../dist/lib/fsx.js';
import { templatesDir } from '../dist/lib/schemas.js';
import { excludedFromCategories, scanAgentProfiles, scanCategories } from '../dist/lib/layer.js';
import { route } from '../dist/lib/route.js';
import { mermaidTextColor } from '../dist/commands/viewer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

function tmpdir(prefix: string): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Every entry under `dir` as `path -> bytes` (symlinks by their target), so a run
 * that must write nothing can be held to the whole tree rather than to one file. */
function treeSnapshot(dir: string): Record<string, string> {
   const out: Record<string, string> = {};
   const walk = (rel: string): void => {
      for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
         const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
         const abs = path.join(dir, childRel);
         if (entry.isSymbolicLink()) out[childRel] = `link:${fs.readlinkSync(abs)}`;
         else if (entry.isDirectory()) walk(childRel);
         else if (entry.isFile()) out[childRel] = fs.readFileSync(abs).toString('base64');
      }
   };
   walk('');
   return out;
}

// The example's git-tracked file list is invariant across a test-file run, so
// resolve it once instead of shelling out to git on every copyExample().
let trackedExampleFiles: string[] | undefined;
function exampleTrackedFiles(): string[] {
   if (!trackedExampleFiles) {
      trackedExampleFiles = execFileSync('git', ['ls-files', '-z'], { cwd: exampleDir, encoding: 'utf8' })
         .split('\0')
         .filter(Boolean);
   }
   return trackedExampleFiles;
}

function copyExample(): string {
   const dir = tmpdir('leji-unit-');
   // Conformance evaluates the directory it is given, so a layer outside a git
   // repository fails `core`'s git requirement. Any test asserting a verified level
   // has to run somewhere git can answer.
   execFileSync('git', ['init', '-q'], { cwd: dir });
   execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
   execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
   // Copy only git-tracked files so a polluted working tree (a local `leji
   // viewer`/`init` run leaving generated .leji/ output or a seeded root
   // overview.md) cannot leak into fixtures. Mirrors a clean checkout.
   for (const rel of exampleTrackedFiles()) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(exampleDir, rel), target);
   }
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
   const docs = scanCategories(dir, manifest!).docs;
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
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: dir });
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
   assert.ok(result.findings.some((f) => f.rule === 'inherits-unknown' && f.severity === 'error'));
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

test('a category index entry may be a single file', () => {
   const dir = tmpdir('leji-file-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.categories.system = { indexes: ['docs/context/system.md'] };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   fs.mkdirSync(path.join(dir, 'docs', 'context'), { recursive: true });
   fs.writeFileSync(
      path.join(dir, 'docs', 'context', 'system.md'),
      '# System\n\n```leji-index\n- path: docs/system-notes.md\n```\n',
   );
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
   // List a second decisions location in the decisions index file.
   fs.writeFileSync(
      path.join(dir, 'docs', 'context', 'decisions.md'),
      '# Decisions\n\n```leji-index\n- path: docs/adr/\n- path: docs/decisions/\n```\n',
   );
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
   index.schemaVersion = '9.9'; // a line this SDK does not support
   fs.writeFileSync(rel, JSON.stringify(index, null, 2) + '\n');
   const result = checkIndex(dir, manifest!);
   assert.equal(result.stale, true);
   assert.ok(result.findings.some((f) => f.rule === 'schema-version'));
});

test('audit: reordering keys in a committed changelog entry is not a violation', () => {
   const dir = tmpdir('leji-reord-');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: dir });
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
         kind: 'record',
         date: '2026-06-10',
      },
      {
         id: 'glossary',
         path: 'docs/domain/glossary.md',
         title: 'Glossary',
         category: 'domain',
         kind: 'intent',
         summary: 'What invoice, credit note, and settlement mean at Acme.',
      },
      {
         id: 'system-invariants',
         path: 'docs/system/invariants.md',
         title: 'System Invariants',
         category: 'system',
         kind: 'intent',
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
   // A committed baseline, because append-only discipline compares against HEAD and
   // an uncommitted tree correctly reports unverified rather than passing.
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['commit', '-qm', 'baseline'], { cwd: dir });
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

test('quality: a pinned, unhydrated mount passes sibling-mounts (availability never fails the claim)', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.conformance.claimedLevel = 'federated';
   manifest.federation = {
      mounts: [
         {
            name: 'product',
            source: 'https://github.com/acme/product-context',
            pin: 'a'.repeat(40),
            owner: { name: 'Jo' },
            categories: ['domain'],
            topics: ['billing'],
         },
      ],
   };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   writeIndex(dir, manifest);
   const result = conformanceReport(dir);
   // Declaration completeness passes; the mount being unhydrated here is honest
   // degraded availability (a validate warning), never a failed federated claim.
   assert.equal(result.items.find((i) => i.id === 'sibling-mounts')!.status, 'pass');
   assert.equal(result.items.find((i) => i.id === 'mount-routing')!.status, 'pass');
   const validation = validateLayer(dir);
   assert.ok(validation.findings.some((f) => f.rule === 'mount-unavailable' && f.severity === 'warning'));
});

test('quality: a federated claim with zero mounts does not machine-verify federated', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.conformance.claimedLevel = 'federated';
   // No federation.mounts at all: every federated item is process-attested, so the
   // machine has no evidence for federated and must not lift the verified level.
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = conformanceReport(dir);
   assert.notEqual(result.verifiedLevel, 'federated');
   assert.ok(result.findings.some((f) => f.rule === 'conformance-claim'));
});

test('quality: a hydrated mount reports no availability warning', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.federation = {
      mounts: [
         {
            name: 'product',
            source: 'https://github.com/acme/product-context',
            pin: 'a'.repeat(40),
            owner: { name: 'Jo' },
         },
      ],
   };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   // Availability is the published marker at the derived key: no state file exists to
   // point at a projection, so the cache key comes from the declaration itself.
   const mount = manifest.federation.mounts[0];
   const cacheKey = cacheKeyFor(normalizeSource(mount.source)!, mount.pin);
   const projection = path.join(dir, '.leji', 'mounts', 'cache', cacheKey, 'projection');
   fs.mkdirSync(projection, { recursive: true });
   fs.writeFileSync(path.join(projection, 'complete'), '');
   const result = validateLayer(dir);
   assert.ok(!result.findings.some((f) => f.rule === 'mount-unavailable'));
});

test('quality: a mount reusing the host layer name is a validation error', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.federation = {
      mounts: [
         {
            name: manifest.name,
            source: 'https://github.com/acme/self',
            pin: 'a'.repeat(40),
            owner: { name: 'Jo' },
         },
      ],
   };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'mount-self' && f.severity === 'error'));
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
   fs.cpSync(exampleDir, dir, { recursive: true });
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: dir });
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

test('compaction: a compaction entry that misrecords the dropped run fails', () => {
   const dir = gitSeedExample('leji-compact-forge-');
   const rel = path.join(dir, 'docs', 'context-changelog.json');
   const changelog = JSON.parse(fs.readFileSync(rel, 'utf8'));
   const droppedEntry = changelog.entries.shift();
   // Forge the audit record: claim a different count and a bogus firstId/lastId.
   changelog.entries.push({
      id: 'compact-2026-06',
      date: '2026-06-12',
      type: 'compaction',
      summary: 'A compaction entry whose recorded drop is wrong.',
      paths: ['docs/context-changelog.json'],
      compacted: { entries: 5, firstId: 'not-the-dropped-id', lastId: 'also-wrong' },
   });
   void droppedEntry;
   fs.writeFileSync(rel, JSON.stringify(changelog, null, 2) + '\n');
   const result = checkChangelogAppendOnly(dir, 'docs/context-changelog.json');
   assert.ok(
      result.findings.some(
         (f) => f.rule === 'changelog-append-only' && /compaction entry records .* but .* were dropped/.test(f.message),
      ),
   );
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
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: dir });
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

test('seedChangelogIfMissing treats a dangling changelog link as present, never seeding through it', () => {
   // `existsSync` follows symlinks, so a dangling changelog link read as absent and the
   // seed was created at the link's missing destination. The exclusive create judges the
   // ORIGINAL entry, so any standing entry is the same no-op an existing changelog is.
   const dir = tmpdir('leji-seed-dangling-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.conformance = { ...(m.conformance ?? {}), claimedLevel: 'indexed' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const link = path.join(dir, 'docs', 'context-changelog.json');
   fs.symlinkSync('never-created.json', link);
   const { manifest } = loadManifest(dir);

   const result = seedChangelogIfMissing(dir, manifest!);

   assert.equal(result, null, 'a standing entry is never seeded through');
   assert.equal(
      fs.existsSync(path.join(dir, 'docs', 'never-created.json')),
      false,
      "the dangling link's destination is never created",
   );
   assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the planted link is left exactly as it was');
});

test('seedChangelogIfMissing refuses a changelog link resolving outside the repository', () => {
   const dir = tmpdir('leji-seed-outlink-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-seed-outside-link-'));
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.conformance = { ...(m.conformance ?? {}), claimedLevel: 'indexed' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.symlinkSync(path.join(outside, 'context-changelog.json'), path.join(dir, 'docs', 'context-changelog.json'));
   const { manifest } = loadManifest(dir);

   const result = seedChangelogIfMissing(dir, manifest!);

   assert.equal(result, null, 'nothing seeded through a link that leaves the repository');
   assert.equal(fs.existsSync(path.join(outside, 'context-changelog.json')), false, 'nothing written outside the root');
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

test('buildManifestPage: escapes hostile strings, covers drift states, byte-order sort, no timestamp', () => {
   const manifest = {
      leji: '1.0',
      name: 'demo | layer',
      description: 'line1\nline2 with | pipe',
      rootPath: 'docs/',
      bootProfilePath: 'docs/boot-profile.md',
      categories: { domain: { indexes: ['docs/context/domain.md'] } },
      agents: { 'z-role': 'docs/agents/Z.md', 'a-role': 'docs/agents/A.md' },
      owners: { primary: { name: 'Owner', contact: 'o@x.com' } },
      conformance: { claimedLevel: 'governed' },
      federation: {
         mounts: [
            {
               name: 'bravo',
               source: 'https://x/b',
               pin: 'abcdef1234567890',
               trackingRef: 'refs/heads/main',
               owner: { name: 'O|B' },
               role: 'role with | pipe and `tick`',
            },
            { name: 'alpha', source: 'https://x/a', pin: 'deadbeefcafe0000', owner: { name: 'O' }, role: 'r' },
            { name: 'charlie', source: 'https://x/c', pin: 'feedface00001111', owner: { name: '' } },
         ],
      },
   } as unknown as Parameters<typeof buildManifestPage>[0];
   const mk = (name: string, present: boolean, state: string, extra: Record<string, unknown> = {}) => ({
      name,
      sourceIdentity: `https://x/${name}`,
      pin: name === 'bravo' ? 'abcdef1234567890' : 'deadbeefcafe0000',
      trackingRef: name === 'bravo' ? 'refs/heads/main' : null,
      present,
      verified: null,
      pinReport: {
         state,
         comparedRef: null,
         comparisonRepository: null,
         witnessProvenance: null,
         ancestryComplete: true,
         observedAt: 'WALLCLOCK-SHOULD-NOT-RENDER',
         ...extra,
      },
   });
   const statuses = [
      mk('bravo', true, 'diverged', { ahead: 2, behind: 3 }),
      mk('alpha', false, 'unrelated'),
   ] as unknown as Parameters<typeof buildManifestPage>[1];
   const page = buildManifestPage(manifest, statuses);
   assert.ok(!page.includes('WALLCLOCK'), 'observedAt / wall-clock is never rendered (determinism)');
   assert.ok(page.indexOf('| alpha ') < page.indexOf('| bravo '), 'mounts sorted by byte order, not manifest order');
   assert.ok(page.includes('role with \\| pipe'), 'a pipe inside a cell is escaped, not a column break');
   assert.ok(page.includes('O\\|B'), 'a pipe in the owner cell is escaped');
   assert.ok(page.includes('diverged (ahead 2, behind 3)'), 'diverged drift label with counts');
   assert.ok(page.includes('| unknown |'), 'unknown drift label');
   assert.ok(page.includes('not hydrated') && /\| hydrated \|/.test(page), 'availability rendered both ways');
   assert.ok(page.indexOf('a-role') < page.indexOf('z-role'), 'agents sorted by byte order');
   assert.ok(page.includes('claims `governed`'), 'claimed conformance shown');
   assert.ok(page.includes('\\`tick'), 'a backtick inside a cell is escaped, not left active');
   assert.ok(page.includes('**Declared**') && page.includes('**Observed**'), 'the declared-vs-observed key is present');
   assert.ok(page.includes('**Declared index files:**'), 'categories shown as a count summary, not a path dump');
   assert.ok(page.includes('mounts hydrated locally'), 'federation shows an observed-state summary line');
   assert.ok(
      page.includes('· 2 drifting from pin'),
      'unrelated counts as drift and the count is always shown (bravo diverged + alpha unrelated)',
   );
   assert.ok(page.includes('unrelated'), 'the unrelated drift label is rendered');
   assert.ok(
      page.includes('**Roles**') && page.includes('- **alpha**: r'),
      'role descriptions move below the table as a per-mount list',
   );
   assert.ok(
      !/\| Mount \| Availability \| Drift \| Owner \| Pin \| Source \| Role \|/.test(page),
      'Role is no longer a table column',
   );
   // Declaration-driven, columns Mount|Availability|Drift|Owner|…: charlie has no status and no role/owner-name.
   assert.ok(
      /\| charlie \| unknown \| unknown \| — \|/.test(page),
      'no status → unknown availability+drift; absent owner → em dash',
   );
   assert.ok(
      page.includes('| unknown | unknown |'),
      'a declared mount with no status shows unknown availability + drift',
   );
   // Mermaid federation graph: flat host → mounts, index ids on the same byte-sorted order.
   assert.ok(page.includes('```mermaid') && page.includes('flowchart LR'), 'mermaid federation graph rendered');
   assert.ok(page.includes('host --> m0') && page.includes('host --> m2'), 'host edges to every declared mount');
   assert.ok(page.includes('m0["alpha"]'), 'first graph node is the byte-first mount (alpha)');
   const noMounts = buildManifestPage(
      { ...(manifest as object), federation: undefined } as typeof manifest,
      [] as typeof statuses,
   );
   assert.ok(noMounts.includes('No federated mounts are declared'), 'empty mounts handled, not an error');
});

test('viewer: generates viewer + sidebar that reflect the layer', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const result = generateViewer(dir, manifest!);
   assert.deepEqual(result.written, [
      '.leji/viewer/index.html',
      '.leji/viewer/_sidebar.md',
      '.leji/viewer/assets/docsify-copy-code.min.js',
      '.leji/viewer/assets/docsify-mermaid.js',
      '.leji/viewer/assets/docsify-sidebar-collapse.min.css',
      '.leji/viewer/assets/docsify-sidebar-collapse.min.js',
      '.leji/viewer/assets/docsify.min.js',
      '.leji/viewer/assets/leji-logo.svg',
      '.leji/viewer/assets/mermaid.min.js',
      '.leji/viewer/assets/prism-bash.min.js',
      '.leji/viewer/assets/prism-json.min.js',
      '.leji/viewer/assets/prism-markdown.min.js',
      '.leji/viewer/assets/prism-typescript.min.js',
      '.leji/viewer/assets/roboto-mono-400-latin-ext.woff2',
      '.leji/viewer/assets/roboto-mono-400-latin.woff2',
      '.leji/viewer/assets/roboto-mono-400-vietnamese.woff2',
      '.leji/viewer/assets/search.min.js',
      '.leji/viewer/assets/source-sans-pro-300-latin-ext.woff2',
      '.leji/viewer/assets/source-sans-pro-300-latin.woff2',
      '.leji/viewer/assets/source-sans-pro-300-vietnamese.woff2',
      '.leji/viewer/assets/source-sans-pro-400-latin-ext.woff2',
      '.leji/viewer/assets/source-sans-pro-400-latin.woff2',
      '.leji/viewer/assets/source-sans-pro-400-vietnamese.woff2',
      '.leji/viewer/assets/source-sans-pro-600-latin-ext.woff2',
      '.leji/viewer/assets/source-sans-pro-600-latin.woff2',
      '.leji/viewer/assets/source-sans-pro-600-vietnamese.woff2',
      '.leji/viewer/assets/third-party-licenses.txt',
      '.leji/viewer/assets/viewer-boot.js',
      '.leji/viewer/assets/vue.css',
      '.leji/viewer/assets/zoom-image.min.js',
      'docs/overview.md',
      '.leji/viewer/_manifest.md',
   ]);
   const viewer = path.join(dir, '.leji', 'viewer');
   // The Manifest page is generated chrome in the viewer dir (reserved underscore
   // name, collision-free) and pinned, like the sidebar.
   const manifestPage = fs.readFileSync(path.join(viewer, '_manifest.md'), 'utf8');
   assert.ok(manifestPage.startsWith('# '), 'manifest page has a title heading');
   assert.ok(/:\s*Manifest/.test(manifestPage), 'title ends with ": Manifest"');
   assert.ok(manifestPage.includes('## Identity') && manifestPage.includes('## Entrypoints'), 'core sections present');
   const sidebarMd = fs.readFileSync(path.join(viewer, '_sidebar.md'), 'utf8');
   assert.ok(sidebarMd.includes('[📄 Manifest](/_manifest.md)'), 'Manifest page is pinned in the sidebar');
   const html = fs.readFileSync(path.join(viewer, 'index.html'), 'utf8');
   assert.ok(html.includes('acme-billing-context'), 'layer name baked into the JSON config');
   assert.ok(html.includes('viewer-boot.js'), 'boot script (carrying the frontmatter hook) is wired');
   const bootJs = fs.readFileSync(path.join(viewer, 'assets', 'viewer-boot.js'), 'utf8');
   assert.ok(bootJs.includes('stripFrontmatter'), 'frontmatter hook present in the vendored boot script');
   // The content mount is the SDK's value, carried in the config block; the boot
   // script routes from it instead of hardcoding a root, which is what lets the
   // export flavor be relative.
   assert.ok(bootJs.includes('basePath: lejiContentBase'), 'the boot script routes from the generated base');
   assert.ok(html.includes('"basePath":"/content/"'), 'the served flavor mounts content at the app root');
   assert.ok(html.includes('"homepage":"overview.md"'), 'the overview is the homepage');
   assert.ok(html.includes('<title>acme-billing-context</title>'), 'escaped layer name in title');
   // Default theming: the Leji mark (in the name HTML, served relative to the page so
   // basePath does not break it) and the brand green, with the mermaid node-text
   // color the SDK computed for it (dark, at 5.14:1 against the accent).
   assert.ok(html.includes('/assets/leji-logo.svg'), 'default Leji logo wired into the name');
   assert.ok(html.includes('"themeColor":"#009F71"'), 'default brand color wired');
   assert.ok(
      html.includes('"lejiMermaidTextColor":"#1a1a1a"'),
      'the computed mermaid text color travels in the config',
   );
   // A configured accent is computed over too, not just the default: a dark accent
   // flips the mermaid node text to white, end to end through the generator.
   const darkDir = copyExample();
   const { manifest: darkManifest } = loadManifest(darkDir);
   darkManifest!.viewer = { theme: { primary: '#164E42' } };
   generateViewer(darkDir, darkManifest!);
   const darkHtml = fs.readFileSync(path.join(darkDir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(darkHtml.includes('"themeColor":"#164E42"'), 'configured accent wired');
   assert.ok(
      darkHtml.includes('"lejiMermaidTextColor":"#ffffff"'),
      'the mermaid text color is recomputed for the configured accent',
   );
   // Mermaid is on by default: the two scripts + their assets are present.
   assert.ok(html.includes('assets/mermaid.min.js'), 'mermaid script wired by default');
   assert.ok(html.includes('assets/docsify-mermaid.js'), 'mermaid plugin wired by default');
   assert.ok(fs.existsSync(path.join(viewer, 'assets', 'mermaid.min.js')), 'mermaid asset copied');
   // The mark is vendored by bytes, so its color travels with it: the default logo
   // wears the brand green, never the retired gold.
   const logoSvg = fs.readFileSync(path.join(viewer, 'assets', 'leji-logo.svg'), 'utf8');
   assert.match(logoSvg, /fill="#009F71"/i, 'the vendored mark is Leji green');
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
         '- [🤖 Boot profile](/boot-profile.md)',
         '- [📄 Manifest](/_manifest.md)',
         '',
         '---',
         '',
         '- **🤖 Agents**',
         '  - [Agent Core](/agents/core.md)',
         '  - [Thought Partner (Codex)](/agents/thought-partner.md)',
         '- **📖 Domain**',
         '  - [Glossary](/domain/glossary.md)',
         '- **⚙️ System**',
         '  - [Invariants](/system/invariants.md)',
         '- **🧭 Decisions**',
         '  - [Adopt the Leji context layer](/decisions/0001-adopt-leji.md)',
         '',
      ].join('\n'),
   );
   // Deterministic: regeneration is byte-identical.
   generateViewer(dir, manifest!);
   assert.equal(fs.readFileSync(path.join(viewer, '_sidebar.md'), 'utf8'), sidebar);
});

test('viewer: brand config (logo, primary color, title, favicon, pins) flows into the viewer', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   manifest!.viewer = {
      logo: 'assets/brand.svg',
      theme: { primary: '#FF6600' },
      title: 'Acme Billing',
      favicon: 'assets/icon.svg',
      pins: ['docs/domain/glossary.md', 'docs/nope.md'],
   };
   const result = generateViewer(dir, manifest!);
   const viewer = path.join(dir, '.leji', 'viewer');
   const html = fs.readFileSync(path.join(viewer, 'index.html'), 'utf8');
   // A relative logo path is served from the content mount; absolute/url is used as-is.
   assert.ok(html.includes('/content/assets/brand.svg'), 'configured logo resolved under /content/');
   assert.ok(html.includes('"themeColor":"#FF6600"'), 'configured primary color wins');
   assert.ok(html.includes('<title>Acme Billing</title>'), 'viewer.title drives the page title');
   assert.ok(html.includes('href="/content/assets/icon.svg"'), 'configured favicon resolved under /content/');
   const sidebar = fs.readFileSync(path.join(viewer, '_sidebar.md'), 'utf8');
   const top = sidebar.split('---')[0];
   assert.ok(top.includes('- [Glossary](/domain/glossary.md)'), 'pinned page renders in the top zone');
   assert.ok(
      result.findings.some((f) => f.rule === 'viewer-pin-missing' && f.path === 'docs/nope.md'),
      'a missing pin is surfaced, not silently dropped',
   );
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
   assert.match(text, /```mermaid\nflowchart LR/, 'the map is a mermaid flowchart');
   assert.match(text, /boot --> cat_domain/, 'boot links to the domain category');
   assert.match(text, /cat_domain\["📖 Domain · 1 doc"\]/, 'categories carry counts, never per-doc nodes');
   assert.ok(!text.includes('n_glossary'), 'no per-document nodes (unreadable at scale)');
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
   assert.match(after, /```mermaid\nflowchart LR/, 'the stale map block was refreshed');
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

test('viewer build: the default output is the dist role of the unified tree', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   const r = buildViewer(dir, manifest!);
   assert.equal(r.out.split(path.sep).join('/'), '.leji/dist', 'the default output is root .leji/dist');
   assert.ok(fs.existsSync(path.join(dir, '.leji', 'dist', 'index.html')));
   assert.ok(fs.existsSync(path.join(dir, '.leji', 'dist', 'content', 'boot-profile.md')));
   // The pre-1.4 locations are never created, and nothing reads or writes a tree
   // under the context root: a run leaves rootPath/.leji/ absent.
   assert.ok(!fs.existsSync(path.join(dir, 'docs', '.leji')), 'no tree under the context root');
   assert.ok(!fs.existsSync(path.join(dir, '.leji', 'viewer-dist')), 'the old output name is not used');
});

test('viewer build: --out never resolves inside .leji/ except exactly .leji/dist', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   // The roles are the tool's own: an export target inside any of them is refused,
   // including a role this version has never heard of, because the rule denies by
   // name rather than listing what to protect.
   for (const target of ['.leji', '.leji/mounts', '.leji/mounts/cache', '.leji/viewer', '.leji/work', '.leji/future']) {
      assert.throws(() => buildViewer(dir, manifest!, target), /reserved for the tool's own roles/, target);
   }
   // The canary bytes a refusal must never have touched: the private roles are still
   // exactly as planted.
   fs.mkdirSync(path.join(dir, '.leji', 'mounts', 'store'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji', 'mounts', 'store', 'keep'), 'private\n');
   assert.throws(() => buildViewer(dir, manifest!, '.leji/mounts'), /reserved for the tool's own roles/);
   assert.equal(fs.readFileSync(path.join(dir, '.leji', 'mounts', 'store', 'keep'), 'utf8'), 'private\n');
   // The reservation is exact, not a subtree: `.leji/dist` is a target a caller may
   // name, and everything under it is not — the export owns that directory whole.
   for (const nested of ['.leji/dist/subdir', '.leji/dist/a/b']) {
      assert.throws(() => buildViewer(dir, manifest!, nested), /never a path inside it/, nested);
   }
   // Spelling the same target absolutely is the same target: `--out` is resolved
   // before it is judged, so an absolute path reaches the reservation exactly as a
   // relative one does.
   for (const nested of [path.join(dir, '.leji', 'dist', 'subdir'), path.join(dir, '.leji', 'dist', 'a', 'b')]) {
      assert.throws(() => buildViewer(dir, manifest!, nested), /never a path inside it/, nested);
   }
   // The reserved role itself is the one accepted spelling.
   assert.doesNotThrow(() => buildViewer(dir, manifest!, '.leji/dist'));
   assert.ok(fs.existsSync(path.join(dir, '.leji', 'dist', 'index.html')));
});

/** Whether this directory sits on a filesystem that cannot tell `.leji` from
 * `.LEJI`. Asked of the volume rather than inferred from the platform: a
 * case-sensitive volume on macOS and a case-insensitive one on Linux both exist. */
function caseInsensitiveFs(dir: string): boolean {
   const probe = path.join(dir, 'leji-case-probe');
   fs.mkdirSync(probe, { recursive: true });
   try {
      return fs.existsSync(path.join(dir, 'LEJI-CASE-PROBE'));
   } finally {
      fs.rmSync(probe, { recursive: true, force: true });
   }
}

test('viewer build: --out is judged in resolved form, not as spelled', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   fs.mkdirSync(path.join(dir, '.leji', 'mounts', 'store'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji', 'mounts', 'store', 'keep'), 'private\n');
   // A symlink is a spelling, not an exemption: what the write would land in is what
   // the reservation judges, so an ordinary-looking --out that redirects into a
   // private role is refused exactly as the literal path is.
   fs.symlinkSync(path.join('.leji', 'mounts'), path.join(dir, 'redirect'));
   assert.throws(
      () => buildViewer(dir, manifest!, 'redirect/export'),
      /reserved for the tool's own roles/,
      'a redirected --out is refused',
   );
   assert.ok(!fs.existsSync(path.join(dir, '.leji', 'mounts', 'export')), 'and nothing was written through it');
   assert.equal(fs.readFileSync(path.join(dir, '.leji', 'mounts', 'store', 'keep'), 'utf8'), 'private\n');
   // Where the filesystem cannot tell the two spellings apart, `.LEJI/` names the
   // reserved role and is refused as one. Where it can, `.LEJI/` is an ordinary
   // directory name and there is nothing to assert, so the volume decides.
   if (caseInsensitiveFs(dir)) {
      assert.throws(
         () => buildViewer(dir, manifest!, '.LEJI/mounts/export'),
         /reserved for the tool's own roles/,
         'a case-variant spelling of a reserved role is the reserved role',
      );
      assert.ok(!fs.existsSync(path.join(dir, '.leji', 'mounts', 'export')), 'and nothing was written under it');
   }
   // The redirection rule is about the destination, not about symlinks: one that
   // lands somewhere ordinary still exports.
   fs.mkdirSync(path.join(dir, 'real-out'));
   fs.symlinkSync('real-out', path.join(dir, 'link-out'));
   assert.doesNotThrow(() => buildViewer(dir, manifest!, 'link-out'));
   assert.ok(fs.existsSync(path.join(dir, 'real-out', 'index.html')), 'the export landed in the resolved target');
});

test('viewer build: the export flavor is generated, and carries no root-absolute URL', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   buildViewer(dir, manifest!);
   const served = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   const exported = fs.readFileSync(path.join(dir, '.leji', 'dist', 'index.html'), 'utf8');
   // One code path, two flavors: the servable area holds the app-root base, the
   // export holds the relative one. index.html is the only file that differs.
   assert.ok(served.includes('"basePath":"/content/"'), 'the served flavor mounts content at the app root');
   assert.ok(served.includes('href="/assets/leji-logo.svg"'), 'the served favicon is app-root absolute');
   assert.ok(exported.includes('"basePath":"content/"'), 'the exported flavor mounts content relative to the page');
   assert.ok(!exported.includes('"basePath":"/content/"'), 'no export-flavored page keeps the app-root base');
   // The machine-checkable proxy gate for subpath hosting: nothing in the exported
   // shell — attributes or config — addresses the server root. (Sidebar link
   // destinations are route strings resolved against basePath, not fetch paths, and
   // live in _sidebar.md, not here.)
   const body = exported.slice(exported.indexOf('-->') + 3);
   assert.equal(
      (body.match(/(?:href|src)="\/[^"]*"/g) ?? []).join(', '),
      '',
      'no root-absolute href/src in the exported shell',
   );
   assert.equal(
      (body.match(/\\"\/(?:content|assets)\/[^\\"]*\\"/g) ?? []).join(', '),
      '',
      'no root-absolute URL inside the exported config block',
   );
   // The servable area never holds export-flavored bytes, and the two trees agree on
   // everything else the chrome ships.
   for (const rel of ['assets/viewer-boot.js', 'assets/docsify.min.js']) {
      assert.deepEqual(
         fs.readFileSync(path.join(dir, '.leji', 'dist', rel)),
         fs.readFileSync(path.join(dir, '.leji', 'viewer', rel)),
         `${rel} is flavor-neutral`,
      );
   }
});

test('viewer build: refuses an --out inside the context root, leaving governed content intact', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   const glossary = path.join(dir, 'docs', 'domain', 'glossary.md');
   const before = fs.readFileSync(glossary, 'utf8');
   // The reported reproduction: exporting into a governed directory used to rm -rf
   // it and then recurse into its own output until the paths grew too long.
   assert.throws(() => buildViewer(dir, manifest!, 'docs/domain'), /refusing to build the viewer/);
   assert.equal(fs.readFileSync(glossary, 'utf8'), before, 'governed content survives the refusal');
   // The context root itself, and a directory containing it, are refused too.
   assert.throws(() => buildViewer(dir, manifest!, 'docs'), /refusing to build the viewer/);
   assert.throws(() => buildViewer(dir, manifest!, '.'), /refusing to build the viewer/);
});

test('viewer build: clears a previous export, never a directory it did not write', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   // A fresh target, then the same target again: the second run recognizes its own
   // export by the marker comment and clears it.
   buildViewer(dir, manifest!, 'out');
   fs.writeFileSync(path.join(dir, 'out', 'stale.txt'), 'from the previous export');
   buildViewer(dir, manifest!, 'out');
   assert.ok(!fs.existsSync(path.join(dir, 'out', 'stale.txt')), 'a previous export is rebuilt clean');
   // An occupied directory that is not an export is somebody's content: refused.
   const occupied = path.join(dir, 'notes');
   fs.mkdirSync(occupied);
   fs.writeFileSync(path.join(occupied, 'keep.md'), '# keep');
   assert.throws(() => buildViewer(dir, manifest!, 'notes'), /neither empty nor a previous viewer export/);
   assert.ok(fs.existsSync(path.join(occupied, 'keep.md')), 'the occupied target is untouched');
   // An empty directory is fine.
   fs.mkdirSync(path.join(dir, 'empty'));
   assert.doesNotThrow(() => buildViewer(dir, manifest!, 'empty'));
});

test('viewer build: active file types are left out of the exported content', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   fs.writeFileSync(path.join(dir, 'docs', 'evil.html'), '<script>alert(1)</script>');
   fs.writeFileSync(path.join(dir, 'docs', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
   buildViewer(dir, manifest!, 'out');
   const out = path.join(dir, 'out');
   assert.ok(!fs.existsSync(path.join(out, 'content', 'evil.html')), 'no HTML in the exported content');
   // SVG stays a first-class asset: viewer.logo/viewer.favicon may point at one
   // under the context root, and an SVG in an <img> never executes script.
   assert.ok(fs.existsSync(path.join(out, 'content', 'evil.svg')), 'SVG is still exported');
   // The chrome's own vendored assets are untouched by the content-side exclusion.
   assert.ok(fs.existsSync(path.join(out, 'assets', 'docsify.min.js')));
   assert.ok(fs.existsSync(path.join(out, 'index.html')));
   // Only the prepended warning comment, not the page below it (whose favicon
   // link legitimately names the vendored leji-logo.svg).
   const warning = fs.readFileSync(path.join(out, 'index.html'), 'utf8').split('-->')[0];
   assert.match(warning, /Active file types/);
   assert.ok(!warning.includes('.svg'), 'the warning does not claim SVG is excluded');
});

test('viewer: a hostile manifest string cannot break out of its substitution site', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   // Both values name other placeholders: with sequential substitution passes they
   // were expanded a second time, injecting a literal </script> into the JSON island
   // and breaking out of the favicon's href attribute.
   manifest!.viewer = { title: '{{MERMAID_SCRIPTS}}', favicon: '{{DOCSIFY_CONFIG}}' };
   generateViewer(dir, manifest!);
   const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(html.includes('<title>{{MERMAID_SCRIPTS}}</title>'), 'the title stays a literal');
   assert.ok(html.includes('href="/content/{{DOCSIFY_CONFIG}}"'), 'the favicon stays inside its attribute');
   // The page keeps exactly the scripts the template declares: nothing injected.
   const expected = fs.readFileSync(path.join(templatesDir(), 'viewer', 'index.html'), 'utf8');
   assert.equal(
      (html.match(/<script/g) ?? []).length,
      (expected.match(/<script/g) ?? []).length + 2,
      'only the two mermaid scripts are added',
   );
});

/** The one message a rejected accent produces, spelled out here so a change to the
 * contract's wording fails the suite rather than shipping. */
function themeWarning(value: string): string {
   return `viewer.theme.primary "${value}" is not a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA); using #009F71`;
}

test('viewer: an unusable viewer.theme.primary is refused, not interpolated', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const injection = 'red; } body { display: none } /*';
   manifest!.viewer = { theme: { primary: injection } };
   const result = generateViewer(dir, manifest!);
   const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(html.includes('"themeColor":"#009F71"'), 'the accent falls back to the default');
   const warning = result.findings.find((f) => f.rule === 'viewer-theme-invalid' && f.severity === 'warning');
   assert.ok(warning, 'the rejected accent is surfaced, never silently dropped');
   assert.equal(warning!.message, themeWarning(injection));
   // A plain color is kept as authored.
   manifest!.viewer = { theme: { primary: '#ff0000' } };
   generateViewer(dir, manifest!);
   const ok = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(ok.includes('"themeColor":"#ff0000"'));
});

test('viewer: the accent is hex and nothing else', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const vectors: [string, boolean][] = [
      // The four lengths CSS defines, alpha forms included, case-insensitive.
      ['#0f7', true],
      ['#1234', true],
      ['#009F71', true],
      ['#AABBCCDD', true],
      // 5 and 7 digits are no CSS color at all: they used to reach the page as an
      // unusable accent with no warning, while the mermaid text color silently
      // defaulted, leaving accent and text computed from different colors.
      ['#12345', false],
      ['#1234567', false],
      // Keywords are not the contract, however real the name: acceptance used to
      // fall out of the injection guard rather than any design.
      ['navy', false],
      ['notacolor', false],
      ['transparent', false],
      // A trailing newline does not sneak a hex past the predicate, in any SDK:
      // the match is against the whole string, never up to a line end.
      ['#009F71\n', false],
   ];
   for (const [accent, accepted] of vectors) {
      manifest!.viewer = { theme: { primary: accent } };
      const result = generateViewer(dir, manifest!);
      const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
      const warnings = result.findings.filter((f) => f.rule === 'viewer-theme-invalid' && f.severity === 'warning');
      if (accepted) {
         assert.equal(warnings.length, 0, `${accent} is accepted silently`);
         assert.ok(html.includes(`"themeColor":"${accent}"`), `${accent} is kept as authored`);
      } else {
         assert.equal(warnings.length, 1, `${JSON.stringify(accent)} warns exactly once`);
         assert.equal(warnings[0].message, themeWarning(accent));
         assert.ok(html.includes('"themeColor":"#009F71"'), `${JSON.stringify(accent)} falls back to the default`);
      }
   }
});

/** WCAG contrast between two #rrggbb colors, computed here rather than imported:
 * the numbers below are the assertion, so they are derived independently of the
 * implementation under test. */
function contrast(a: string, b: string): number {
   const luminance = (hex: string): number => {
      const channel = (i: number): number => {
         const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
         return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
   };
   const [x, y] = [luminance(a), luminance(b)];
   return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('viewer: the mermaid text color is computed from the accent over every accepted form', () => {
   // The generator resolves what the boot script cannot: the alpha forms,
   // composited over the viewer's white content ground.
   const vectors: [string, string][] = [
      // The two brand accents, and the mid-gray class where neither #1a1a1a nor
      // #ffffff clears 4.5:1 and black buys the last half-stop.
      ['#009F71', '#1a1a1a'],
      ['#223F93', '#ffffff'],
      ['#777777', '#000000'],
      // #RGB expands like the boot script's fallback does.
      ['#0f7', '#1a1a1a'],
      // Alpha composites over white, which lightens: the same accent at half alpha
      // takes dark text, and a black at 47% is light enough for it too.
      ['#009F7180', '#1a1a1a'],
      ['#0007', '#1a1a1a'],
      // Named resolution is gone: navy would take white text if any keyword path
      // survived, so the dark default here is the proof it does not.
      ['navy', '#1a1a1a'],
      // Unresolvable by nature or by typo: the dark default, never a guess.
      ['currentColor', '#1a1a1a'],
      ['notacolor', '#1a1a1a'],
      ['#12345', '#1a1a1a'],
      // A dark accent takes white; the case of the authored hex does not matter.
      ['#1A1A1A', '#ffffff'],
      ['#000080', '#ffffff'],
   ];
   for (const [accent, want] of vectors) {
      assert.equal(mermaidTextColor(accent), want, `${accent} takes ${want}`);
   }
   // The default accent's choice is not merely dark, it is accessible: the numeric
   // ratio is what the rule is about, so it is asserted as a number.
   assert.ok(contrast('#009F71', '#1a1a1a') >= 4.5, 'the default accent clears WCAG AA against its text color');
   assert.ok(contrast('#223F93', '#ffffff') >= 4.5, 'a dark accent clears it against white');
   // The #777777 class: black is chosen because both candidates miss, not because
   // it wins outright over a passing option.
   assert.ok(contrast('#777777', '#1a1a1a') < 4.5 && contrast('#777777', '#ffffff') < 4.5, 'both candidates miss');
});

test('viewer: a sidebar label carrying HTML is escaped, not rendered', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   manifest!.viewer = { agentsLabel: '<img src=x onerror=alert(1)>' };
   generateViewer(dir, manifest!);
   const sidebar = fs.readFileSync(path.join(dir, '.leji', 'viewer', '_sidebar.md'), 'utf8');
   assert.ok(sidebar.includes('\\<img src=x onerror=alert(1)\\>'), 'the angle brackets are escaped');
   assert.ok(!/(^|[^\\])</m.test(sidebar), 'no unescaped angle bracket reaches the sidebar');
});

test('viewer: serve sends policy headers on every response and never an active content type', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   fs.writeFileSync(path.join(dir, 'docs', 'evil.html'), '<script>alert(1)</script>');
   fs.writeFileSync(path.join(dir, 'docs', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
   generateViewer(dir, manifest!);
   const { serveViewer: serve } = await import('../dist/index.js');
   const server = await serve(dir, 0, manifest!.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      // A governed .html is served inert: same-origin execution was the blocker.
      const evil = await fetch(`http://127.0.0.1:${port}/content/evil.html`);
      assert.equal(evil.status, 200);
      assert.equal(evil.headers.get('content-type'), 'text/plain; charset=utf-8');
      // SVG keeps its real type so a configured logo/favicon still renders. Its
      // inertness is the policy's job, not the content type's: the sandbox puts a
      // navigated or framed SVG in an opaque origin with scripting off.
      const svg = await fetch(`http://127.0.0.1:${port}/content/evil.svg`);
      assert.equal(svg.status, 200);
      assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
      assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox/);
      assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
      // Every route carries the policy, including the 404s and the chrome.
      for (const route of ['/', '/assets/docsify.min.js', '/content/domain/glossary.md', '/content/nope.md']) {
         const res = await fetch(`http://127.0.0.1:${port}${route}`);
         assert.equal(res.headers.get('x-content-type-options'), 'nosniff', route);
         assert.ok(res.headers.get('content-security-policy'), `${route} carries a policy`);
      }
      // The shell keeps its own policy; layer content gets the inert one.
      const shell = await fetch(`http://127.0.0.1:${port}/`);
      assert.match(shell.headers.get('content-security-policy') ?? '', /script-src 'self'/);
      assert.match(shell.headers.get('content-security-policy') ?? '', /frame-src 'none'/);
      const doc = await fetch(`http://127.0.0.1:${port}/content/domain/glossary.md`);
      assert.match(doc.headers.get('content-security-policy') ?? '', /sandbox/);
      // A NUL in the path is a clean 404, not a crash.
      assert.equal((await fetch(`http://127.0.0.1:${port}/content/%00`)).status, 404);
   } finally {
      server.close();
   }
});

test('viewer: serve answers only loopback Host names (DNS rebinding)', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const { serveViewer: serve } = await import('../dist/index.js');
   const server = await serve(dir, 0, manifest!.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   // fetch() refuses to set Host (a forbidden header), so drive a raw socket.
   const status = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
         const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
         });
         let buf = '';
         socket.on('data', (chunk) => (buf += chunk));
         socket.on('error', reject);
         socket.on('end', () => resolve(Number(buf.split(' ')[1])));
      });
   try {
      for (const host of ['localhost', 'localhost:5354', '127.0.0.1', '[::1]:5354']) {
         assert.equal(await status(host), 200, `${host} is the viewer's own name`);
      }
      for (const host of ['evil.example', 'rebound.example:5354']) {
         assert.equal(await status(host), 403, `${host} reached the loopback under another name`);
      }
   } finally {
      server.close();
   }
});

test('viewer: mermaid disabled omits the scripts and skips the heavy asset', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   manifest!.viewer = { mermaid: false };
   const result = generateViewer(dir, manifest!);
   const viewer = path.join(dir, '.leji', 'viewer');
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
   assert.ok(fs.existsSync(path.join(dir, '.leji', 'viewer', 'index.html')));
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

test('init: a .gitignore symlinked out of the repository is refused, and the target is untouched', async () => {
   // Previously the one unguarded write in init: the `.leji/` ignore line went out
   // through whatever `.gitignore` resolved to. It now goes through the chokepoint,
   // so a planted link out of the tree is a refusal with nothing written through it.
   const dir = fs.realpathSync(tmpdir('leji-ignore-escape-'));
   const away = fs.realpathSync(tmpdir('leji-ignore-away-'));
   const target = path.join(away, 'gitignore');
   fs.writeFileSync(target, 'node_modules/\n');
   fs.symlinkSync(target, path.join(dir, '.gitignore'));
   const { initLayer: init } = await import('../dist/index.js');
   await assert.rejects(
      () => init({ dir, yes: true, name: 'demo-context' }),
      /refusing to write through a symlink that escapes the target/,
   );
   assert.equal(fs.readFileSync(target, 'utf8'), 'node_modules/\n', 'the out-of-tree file is byte-untouched');
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false, 'and the refusal came before any layer write');
});

test('agent: a leji.json rewrite that would escape the repository is refused, and NOTHING is written', async () => {
   // The other formerly unguarded write: the in-place manifest edit that binds the
   // agent. Binding is two writes (a profile file and the manifest edit), so the
   // manifest is judged through the verified read BEFORE either happens: a run that
   // cannot finish must not half-finish. Nothing is written, anywhere.
   const dir = fs.realpathSync(copyExample());
   const away = fs.realpathSync(tmpdir('leji-agent-away-'));
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   const manifestAbs = path.join(dir, 'leji.json');
   const target = path.join(away, 'leji.json');
   fs.renameSync(manifestAbs, target);
   fs.symlinkSync(target, manifestAbs);
   const before = fs.readFileSync(target, 'utf8');
   const profileAbs = path.join(dir, 'docs', 'agents', 'reviewer.md');
   assert.equal(fs.existsSync(profileAbs), false, 'the profile does not exist before the run');
   const snapshot = treeSnapshot(dir);
   const { addAgent: bind } = await import('../dist/index.js');
   assert.throws(
      () => bind(dir, manifest, { name: 'reviewer', role: 'reviewer' }),
      /refusing to write through a symlink that escapes the target: "leji.json"/,
   );
   assert.equal(fs.readFileSync(target, 'utf8'), before, 'the out-of-tree manifest is byte-untouched');
   assert.equal(fs.existsSync(profileAbs), false, 'the profile was never written');
   assert.deepEqual(treeSnapshot(dir), snapshot, 'the whole tree is byte-identical to the pre-run snapshot');
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

// --- link classes stay inside the router ---
// A relative link on a nested page used to be resolved by the browser against the
// server root, leaving the SPA for a URL the server has no route for. The fix has
// two halves: Docsify's relativePath routing (so a link resolves against the
// document carrying it, exactly as the same file reads on disk) and generated
// sidebar destinations emitted app-root absolute (exempt from that resolution).
// These pin both halves, plus the click paths and the not-found contract.

/** Write `rel` (forward-slashed, repo-relative) under `dir`, creating its parents. */
function writeUnder(dir: string, rel: string, text: string): void {
   const abs = path.join(dir, ...rel.split('/'));
   fs.mkdirSync(path.dirname(abs), { recursive: true });
   fs.writeFileSync(abs, text);
}

/** Serve `dir`'s viewer on a free loopback port, returning the server and its port. */
async function serveOnFreePort(dir: string, rootRel: string): Promise<{ server: http.Server; port: number }> {
   const { serveViewer: serve } = await import('../dist/index.js');
   const server = await serve(dir, 0, rootRel);
   const address = server.address();
   return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

test('viewer: every sidebar destination, across all entry classes, is app-root absolute', () => {
   const dir = copyExample();
   // One layer carrying every sidebar entry class at once: a pinned boot profile,
   // the always-pinned Manifest chrome, a user pin, grouped index entries, and
   // documents nested two directories deep in both the governed and browse zones.
   writeUnder(dir, 'docs/domain/billing/settlement/netting.md', '# Netting\n');
   writeUnder(dir, 'docs/notes/team/onboarding/day-one.md', '# Day one\n');
   const { manifest } = loadManifest(dir);
   manifest!.viewer = { pins: ['docs/boot-profile.md', 'docs/domain/glossary.md'] };
   const result = generateViewer(dir, manifest!);
   assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      [],
   );
   const sidebar = fs.readFileSync(path.join(dir, '.leji', 'viewer', '_sidebar.md'), 'utf8');
   // Each class is present, so the sweep below is not vacuous.
   for (const dest of [
      '/boot-profile.md', // the pinned boot profile
      '/_manifest.md', // generated Manifest chrome
      '/domain/glossary.md', // a user pin in the top zone
      '/system/invariants.md', // a grouped index entry
      '/domain/billing/settlement/netting.md', // grouped, nested two deep
      '/notes/team/onboarding/day-one.md', // browse zone, nested two deep
   ]) {
      assert.ok(sidebar.includes(`](${dest})`), `${dest} is in the sidebar`);
   }
   // Every emitted destination, parsed rather than sampled: one bare rel anywhere
   // in the sidebar re-resolves against whatever nested route is current.
   const dests = [...sidebar.matchAll(/\]\(([^)]*)\)/g)].map((m) => m[1]);
   assert.ok(dests.length >= 6, 'the matrix produced links to sweep');
   for (const dest of dests) assert.ok(dest.startsWith('/'), `sidebar destination ${dest} is app-root absolute`);
});

test('viewer: a sidebar destination is escaped, app-root absolute, and idempotent', () => {
   const base = JSON.parse(fs.readFileSync(path.join(exampleDir, 'leji.json'), 'utf8'));
   // Boot profile outside rootPath: no boot line, so the pin is the first line and
   // buildSidebar's pins are the thinnest seam emitting one destination per input.
   const manifest = { ...base, bootProfilePath: 'README.md', rootPath: 'docs/' };
   // These vectors are shared verbatim with the Go and Python SDKs
   // (viewer_more_test.go, tests/test_units.py): the three must agree byte for byte.
   const vectors: [string, string][] = [
      ['a.md', '/a.md'],
      ['dir/b.md', '/dir/b.md'],
      // Already absolute: `//…` would be a protocol-relative external URL to Docsify.
      ['/a.md', '/a.md'],
      ['//a.md', '/a.md'],
      // Degenerate input passes through rather than becoming a bare `/`.
      ['', ''],
      ['a(b).md', '/a\\(b\\).md'],
      ['(x).md', '/\\(x\\).md'],
      ['a\\b.md', '/a\\\\b.md'],
   ];
   for (const [input, want] of vectors) {
      const sidebar = buildSidebar(manifest, [], [], [{ rel: input, title: 'x' }]);
      assert.equal(sidebar.split('\n')[0], `- [x](${want})`, `destination for ${JSON.stringify(input)}`);
   }
});

test('viewer: a document is served byte-identical, whatever link classes its body carries', async () => {
   const dir = copyExample();
   // One instance of every link class a real document mixes. Routing is config plus
   // the generated sidebar, never a transform over the author's markdown, so the
   // served bytes are the file's. How an image path resolves under relativePath is
   // a separate item and is deliberately not asserted here.
   const body = [
      '# Links',
      '',
      '- [parent](../target.md)',
      '- [sibling](sibling.md)',
      '- [root](/root-target.md)',
      '- [fragment](#fragment)',
      '- [doc fragment](target.md#fragment)',
      '- [query](target.md?q=1)',
      '- [external](https://leji.org/spec)',
      '',
      '![x](assets/x.svg)',
      '',
      '<img src="assets/x.svg">',
      '',
   ].join('\n');
   writeUnder(dir, 'docs/notes/deep/links.md', body);
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const { server, port } = await serveOnFreePort(dir, manifest!.rootPath);
   try {
      const res = await fetch(`http://127.0.0.1:${port}/content/notes/deep/links.md`);
      assert.equal(res.status, 200);
      assert.deepEqual(
         Buffer.from(await res.arrayBuffer()),
         fs.readFileSync(path.join(dir, 'docs', 'notes', 'deep', 'links.md')),
         'the viewer never rewrites document markdown',
      );
   } finally {
      server.close();
   }
});

test('viewer: the routing config ships in the served boot script and in the built one', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   // Both settings live in the boot script's static overlay, not the injected JSON
   // config block, so the assertion is on the asset text.
   const assertRouting = (boot: string, where: string): void => {
      assert.match(boot, /relativePath:\s*true/, `relativePath is on in the ${where} boot script`);
      assert.match(boot, /notFoundPage:\s*false/, `notFoundPage is off in the ${where} boot script`);
   };
   const { server, port } = await serveOnFreePort(dir, manifest!.rootPath);
   try {
      const asset = await fetch(`http://127.0.0.1:${port}/assets/viewer-boot.js`);
      assert.equal(asset.status, 200);
      assertRouting(await asset.text(), 'served');
   } finally {
      server.close();
   }
   buildViewer(dir, manifest!, 'out');
   assertRouting(fs.readFileSync(path.join(dir, 'out', 'assets', 'viewer-boot.js'), 'utf8'), 'built');
});

/** Resolve a markdown destination the way Docsify's relativePath routing does:
 * against the linking document's own directory, except a leading-slash
 * destination, which is app-root (content-root) absolute. */
function resolveRoute(fromRel: string, dest: string): string {
   if (dest.startsWith('/')) return dest.slice(1);
   return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), dest));
}

test('viewer: the links a nested page carries resolve to documents the server actually has', async () => {
   const dir = copyExample();
   writeUnder(dir, 'docs/practice/feature-workflow.md', '# Feature workflow\n');
   writeUnder(dir, 'docs/work/spec.md', '# Spec\n');
   writeUnder(
      dir,
      'docs/work/README.md',
      [
         '# Work',
         '',
         '- [workflow](../practice/feature-workflow.md)',
         '- [spec](spec.md)',
         '- [glossary](/domain/glossary.md)',
         '',
      ].join('\n'),
   );
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const { server, port } = await serveOnFreePort(dir, manifest!.rootPath);
   try {
      for (const dest of ['../practice/feature-workflow.md', 'spec.md', '/domain/glossary.md']) {
         const target = resolveRoute('work/README.md', dest);
         const res = await fetch(`http://127.0.0.1:${port}/content/${target}`);
         assert.equal(res.status, 200, `${dest} routes to /content/${target}`);
      }
      // The pre-fix escape: the same `../` destination resolved against the server
      // root instead of the router. The server has no such route, which is exactly
      // why the link must stay in-app.
      const escaped = await fetch(`http://127.0.0.1:${port}/practice/feature-workflow.md`);
      assert.equal(escaped.status, 404, 'leaving the router lands on a URL the server cannot answer');
   } finally {
      server.close();
   }
});

test('viewer: an unknown document route 404s, and there is no _404.md to chase', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const result = generateViewer(dir, manifest!);
   const viewer = path.join(dir, '.leji', 'viewer');
   // The config disables Docsify's secondary _404.md fetch (pinned by the routing
   // config test above) and the viewer generates no such page. That the browser
   // therefore makes exactly one failing request is verified at the browser level,
   // not here.
   assert.ok(!fs.existsSync(path.join(viewer, '_404.md')), 'no _404.md in the generated viewer');
   assert.ok(!result.written.some((w) => w.endsWith('_404.md')), '_404.md is not written anywhere');
   const { server, port } = await serveOnFreePort(dir, manifest!.rootPath);
   try {
      const missing = await fetch(`http://127.0.0.1:${port}/content/does-not-exist.md`);
      assert.equal(missing.status, 404, 'the missing document itself is the one 404');
   } finally {
      server.close();
   }
});

// --- a raw-HTML image resolves against its document, like the markdown form ---
// Docsify's relativePath routing resolves the markdown image form against the
// document carrying it; a raw-HTML `<img src="assets/x.svg">` passed through
// untouched, so the browser resolved it against the server root and any nested
// page 404ed. The boot script now resolves it at render time, leaving the served
// document bytes alone. The rule is a pure function in the asset, pinned below by
// golden vectors; that it ships is pinned on both the served and the built script.

/** The canonical viewer boot script's text — the asset both modes ship verbatim. */
function bootAssetText(): string {
   return fs.readFileSync(path.join(templatesDir(), 'viewer', 'assets', 'viewer-boot.js'), 'utf8');
}

/** Cut `function <name>(…) {…}` out of asset source, terminated by its
 * column-zero closing brace. Marker matching over source is fine here: this is
 * test tooling reading a file the suite owns, at a shape the suite fixes. */
function extractFunction(source: string, name: string): string {
   const start = source.indexOf(`function ${name}(`);
   assert.notEqual(start, -1, `${name} is declared in the boot asset`);
   const end = source.indexOf('\n}\n', start);
   assert.notEqual(end, -1, `${name}'s declaration terminates`);
   return source.slice(start, end + 3);
}

test('viewer: the boot asset rewrites exactly the document-relative image srcs', () => {
   // The fail-without-the-change gate: before the fix no such function exists, and
   // every rewrite vector below is a src the browser resolved against the server
   // root. Evaluated in a vm rather than imported: the asset is browser code
   // shipped verbatim, so the vectors run against the bytes that ship.
   const context = vm.createContext({ URL });
   vm.runInContext(extractFunction(bootAssetText(), 'lejiResolveImgSrc'), context);
   const resolve = (src: string, docDir: string, base = '/content/'): string | null =>
      vm.runInContext(
         `lejiResolveImgSrc(${JSON.stringify(src)}, ${JSON.stringify(docDir)}, ${JSON.stringify(base)})`,
         context,
      );
   const vectors: [string, string, string | null][] = [
      // Rewritten: resolved under the document's own directory, suffixes kept.
      ['assets/p.svg', 'notes/deep', '/content/notes/deep/assets/p.svg'],
      ['./assets/p.svg', 'notes/deep', '/content/notes/deep/assets/p.svg'],
      ['../shared/x.svg', 'notes/deep', '/content/notes/shared/x.svg'],
      ['a.svg?v=1#f', 'notes/deep', '/content/notes/deep/a.svg?v=1#f'],
      // Left as authored (null): empty, fragment-only, query-only, root-relative,
      // backslash-led, protocol-relative, and any scheme reference whatever its case.
      ['', 'notes/deep', null],
      ['#f', 'notes/deep', null],
      ['?q', 'notes/deep', null],
      ['/x.svg', 'notes/deep', null],
      ['\\x.svg', 'notes/deep', null],
      ['//cdn/x.svg', 'notes/deep', null],
      ['http://x/y.svg', 'notes/deep', null],
      ['HTTPS://x/y.svg', 'notes/deep', null],
      ['data:image/svg+xml,x', 'notes/deep', null],
      ['blob:http://x/y', 'notes/deep', null],
      // Traversal out of the content mount is refused, never clamped.
      ['../../../../etc/x.svg', 'notes/deep', null],
      // Containment vectors from the independent review: the disguises that pass a
      // literal prefix check but not the server's own canonicalization — encoded
      // traversal, malformed encoding, and a scheme hidden behind whitespace (the
      // entry preprocessing makes classification see what the URL parser sees —
      // edge trim plus tab/LF/CR removed anywhere — so both the padded scheme and
      // one split by an interior tab, LF, or CR are caught as schemes, including
      // when they name the synthetic origin the resolution base uses). Legitimate
      // encoding still rewrites, the emitted src keeps its encoded form, and a
      // padded relative path still resolves.
      ['..%2f..%2f..%2fassets/viewer-boot.js', 'notes/deep', null],
      ['a%5c..%5c..%5c..%5c..%5cx.svg', 'notes/deep', null],
      ['%zz.svg', 'notes/deep', null],
      ['\thttps://host/content/x.svg', 'notes/deep', null],
      [' https://host/content/x.svg', 'notes/deep', null],
      [' http://leji.invalid/content/x.svg', 'notes/deep', null],
      ['\thttp://leji.invalid/content/x.svg', 'notes/deep', null],
      ['h\tttp://leji.invalid/content/x.svg', 'notes/deep', null],
      ['ht\ntp://leji.invalid/content/x.svg', 'notes/deep', null],
      ['htt\rp://leji.invalid/content/x.svg', 'notes/deep', null],
      [' assets/p.svg', 'notes/deep', '/content/notes/deep/assets/p.svg'],
      ['my%20file.svg', 'notes/deep', '/content/notes/deep/my%20file.svg'],
   ];
   for (const [src, docDir, want] of vectors) {
      assert.equal(resolve(src, docDir), want, `${JSON.stringify(src)} from ${JSON.stringify(docDir)}`);
   }
   // The export flavor re-bases the same decisions onto a relative content mount, so
   // a subpath-hosted page resolves the rewritten src against itself. Classification
   // is unchanged: what was left as authored stays left as authored.
   assert.equal(resolve('assets/p.svg', 'notes/deep', 'content/'), 'content/notes/deep/assets/p.svg');
   assert.equal(resolve('../shared/x.svg', 'notes/deep', 'content/'), 'content/notes/shared/x.svg');
   assert.equal(resolve('/x.svg', 'notes/deep', 'content/'), null);
   assert.equal(resolve('../../../../etc/x.svg', 'notes/deep', 'content/'), null);
});

test('viewer: the boot asset falls back to a WCAG-correct text color, and yields to the config', () => {
   // The fallback only runs for a viewer tree generated before the SDK computed the
   // color; correctness still matters, because such a tree is the one nobody
   // regenerates. Run against the shipped bytes, like the resolver vectors above.
   const boot = bootAssetText();
   const context = vm.createContext({ Math });
   vm.runInContext(extractFunction(boot, 'lejiMermaidTextColor'), context);
   const pick = (accent: unknown): string =>
      vm.runInContext(`lejiMermaidTextColor(${JSON.stringify(accent)})`, context);
   const vectors: [unknown, string][] = [
      ['#009F71', '#1a1a1a'],
      ['#223F93', '#ffffff'],
      // The pre-fix brightness rule put white on this one; both candidates in fact
      // miss 4.5:1, so black is the readable choice.
      ['#777777', '#000000'],
      ['#0f7', '#1a1a1a'],
      ['#000', '#ffffff'],
      // The alpha forms, which only the generator composites, and everything no
      // accent can be — a keyword, malformed hex, nothing — keep the dark default.
      ['navy', '#1a1a1a'],
      ['#0007', '#1a1a1a'],
      ['#12345', '#1a1a1a'],
      ['', '#1a1a1a'],
      [null, '#1a1a1a'],
   ];
   for (const [accent, want] of vectors) {
      assert.equal(pick(accent), want, `${JSON.stringify(accent)} takes ${want}`);
   }
   // Precedence: the generated field wins whenever the config carries one, so a
   // freshly generated tree never recomputes a narrower answer in the browser.
   assert.match(
      boot,
      /window\.\$docsify\.lejiMermaidTextColor \|\|\s*lejiMermaidTextColor\(window\.\$docsify\.themeColor\)/,
      'the config field takes precedence over the local fallback',
   );
});

test('viewer: the image resolver ships in the served boot script and in the built one', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   // The resolver and its render-time hook live in the boot script's static body,
   // not the injected JSON config block, so the assertion is on the asset text.
   const assertResolver = (boot: string, where: string): void => {
      assert.match(boot, /function lejiResolveImgSrc\(/, `the resolver is in the ${where} boot script`);
      assert.match(boot, /hook\.afterEach\(/, `the render-time hook is registered in the ${where} boot script`);
      assert.match(boot, /querySelectorAll\('img\[src\]'\)/, `img[src] is walked in the ${where} boot script`);
   };
   const { server, port } = await serveOnFreePort(dir, manifest!.rootPath);
   try {
      const asset = await fetch(`http://127.0.0.1:${port}/assets/viewer-boot.js`);
      assert.equal(asset.status, 200);
      assertResolver(await asset.text(), 'served');
   } finally {
      server.close();
   }
   buildViewer(dir, manifest!, 'out');
   assertResolver(fs.readFileSync(path.join(dir, 'out', 'assets', 'viewer-boot.js'), 'utf8'), 'built');
});

test('viewer: a nested document and the binary asset it links survive both modes verbatim', async () => {
   const dir = copyExample();
   const { buildViewer } = await import('../dist/index.js');
   // A depth-2 document naming a sibling asset directory: the resolver rewrites
   // that class at render time, in the browser, so the file on the way out — the
   // document's markdown and the bytes behind the link alike — must be untouched.
   // Real binary content (NUL and high bytes), so "identical" is a byte claim.
   const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from([0x00, 0xff, 0xfe, 0x0a]),
      Buffer.from('%%EOF\n'),
   ]);
   const doc = ['# Report', '', '[report](assets/r.pdf)', ''].join('\n');
   writeUnder(dir, 'docs/notes/deep/report.md', doc);
   const assetAbs = path.join(dir, 'docs', 'notes', 'deep', 'assets', 'r.pdf');
   fs.mkdirSync(path.dirname(assetAbs), { recursive: true });
   fs.writeFileSync(assetAbs, pdf);
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const { server, port } = await serveOnFreePort(dir, manifest!.rootPath);
   try {
      const asset = await fetch(`http://127.0.0.1:${port}/content/notes/deep/assets/r.pdf`);
      assert.equal(asset.status, 200, 'the linked asset is served from under the content mount');
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), pdf, 'the served asset is byte-identical');
      const md = await fetch(`http://127.0.0.1:${port}/content/notes/deep/report.md`);
      assert.equal(md.status, 200);
      assert.deepEqual(Buffer.from(await md.arrayBuffer()), Buffer.from(doc), 'the document is served verbatim');
   } finally {
      server.close();
   }
   buildViewer(dir, manifest!, 'out');
   assert.deepEqual(
      fs.readFileSync(path.join(dir, 'out', 'content', 'notes', 'deep', 'assets', 'r.pdf')),
      pdf,
      'the exported asset is byte-identical',
   );
});

// --- the retired palette never returns to the shipped chrome ---
// The default viewer chrome and the schema's accent example wore the retired
// blue/gold before the Leji-green sweep. The canonical files and the copies each
// SDK vendors are separate bytes on disk (synced by scripts/sync-assets.ts), so a
// revert, a hand-edited copy, or a tint written in another encoding is a brand
// regression nothing else here would catch. Both encodings are scanned: the hex
// forms and the same values as rgb()/rgba() channels.
const RETIRED_PALETTE: RegExp[] = [
   /#223f93/i,
   /#ffbd6e/i,
   /#162960/i,
   /#f8f9fa/i,
   /34\s*,\s*63\s*,\s*147/,
   /255\s*,\s*189\s*,\s*110/,
   /22\s*,\s*41\s*,\s*96/,
];

/** Canonical chrome + schema, then every tree `npm run assets` syncs them into,
 * plus the per-SDK generators that bake the default accent into their own source
 * (unsynced bytes, so only a scan of all three catches one SDK reverting alone). */
const BRANDED_FILES: string[] = [
   ...[
      'templates',
      'packages/sdk/templates',
      'packages/sdk-py/src/leji/_assets/templates',
      'packages/sdk-go/internal/assets/templates',
   ].flatMap((base) =>
      ['viewer/index.html', 'viewer/assets/vue.css', 'viewer/assets/viewer-boot.js', 'viewer/assets/leji-logo.svg'].map(
         (rel) => `${base}/${rel}`,
      ),
   ),
   ...[
      'schemas',
      'packages/sdk/schemas',
      'packages/sdk-py/src/leji/_assets/schemas',
      'packages/sdk-go/internal/assets/schemas',
      'packages/mcp/assets/schemas',
   ].map((base) => `${base}/context-manifest.schema.json`),
   'packages/sdk/src/commands/viewer.ts',
   'packages/sdk-go/internal/commands/viewer/viewer.go',
   'packages/sdk-py/src/leji/viewer_cmd.py',
];

test('viewer: no shipped chrome or schema copy carries the retired palette', () => {
   for (const rel of BRANDED_FILES) {
      const abs = path.join(repoRoot, rel);
      // A moved or renamed copy fails here rather than passing by absence.
      assert.ok(fs.existsSync(abs), `${rel} exists (the scan covers every synced copy)`);
      const text = fs.readFileSync(abs, 'utf8');
      for (const pattern of RETIRED_PALETTE) {
         assert.ok(!pattern.test(text), `${rel} carries no ${pattern.source}`);
      }
   }
});

test('viewer: serve refuses a rootRel that escapes the layer root', async () => {
   const dir = copyExample();
   const { serveViewer: serve } = await import('../dist/index.js');
   // serveViewer validates synchronously (like its realpathSync); the async thunk
   // turns that synchronous throw into the rejection assert.rejects awaits.
   await assert.rejects(async () => serve(dir, 0, '..'), /escapes the layer root/);
   await assert.rejects(async () => serve(dir, 0, '../..'), /escapes the layer root/);
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

test('viewer: buildSidebar skips an out-of-root boot profile and renders plain entries', () => {
   const base = JSON.parse(fs.readFileSync(path.join(exampleDir, 'leji.json'), 'utf8'));
   // Boot profile outside rootPath: relativeToRoot returns null, so no boot line.
   const manifest = { ...base, bootProfilePath: 'README.md', rootPath: 'docs/' };
   const sidebar = buildSidebar(manifest, [
      {
         label: '💰 Finance',
         entries: [
            { rel: 'domain/glossary.md', title: 'Glossary' },
            { rel: 'records/status.md', title: 'Status' },
         ],
      },
      { label: 'Empty group', entries: [] },
   ]);
   assert.ok(!sidebar.includes('Boot profile'), 'boot profile outside root is omitted');
   assert.ok(sidebar.includes('- **💰 Finance**'), 'group label is the index-file H1, verbatim, bold');
   assert.ok(sidebar.includes('  - [Glossary](/domain/glossary.md)'), 'entries render as plain links');
   assert.ok(!sidebar.includes('lj-rec'), 'no record badges in the sidebar: kind and date are page-chip metadata now');
   assert.ok(!sidebar.includes('Empty group'), 'empty groups are skipped');
});

test('changelog: a declared changelog that does not exist is changelog-required', () => {
   const dir = copyExample();
   const result = checkChangelogAppendOnly(dir, 'docs/missing-changelog.json');
   assert.equal(result.verified, false);
   assert.ok(result.findings.some((f) => f.rule === 'changelog-required'));
});

test('changelog: a new changelog not yet at HEAD is unverifiable, not verified', () => {
   const dir = gitSeedExample('leji-newcl-');
   // A changelog file present in the working tree but never committed: gitShowHead
   // returns null, so there is no baseline. Nothing is violated, but nothing is
   // established either, and those are different: the check reports unverified, which
   // conformance surfaces as `unknown` rather than awarding `indexed`.
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
   assert.equal(result.verified, false);
   assert.ok(!result.findings.some((f) => f.rule === 'changelog-append-only'));
});

test('changelog: an unparseable HEAD baseline yields no baseline, so unverifiable', () => {
   const dir = tmpdir('leji-headbad-');
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.cpSync(exampleDir, dir, { recursive: true });
   const rel = path.join('docs', 'context-changelog.json');
   // Commit a NON-JSON changelog as the HEAD baseline, then replace the working
   // tree with a valid one. The HEAD JSON.parse throws and the check returns
   // verified with no append-only violation.
   fs.writeFileSync(path.join(dir, rel), 'not json at head\n');
   execFileSync('git', ['add', '-A'], { cwd: dir });
   execFileSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-qm', 'seed'], { cwd: dir });
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
   assert.equal(result.verified, false);
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

test('validate: a category index file that does not exist is category-index-missing', () => {
   const dir = tmpdir('leji-catmiss-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.categories.domain.indexes = ['docs/context/ghost.md'];
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(result.findings.some((f) => f.rule === 'category-index-missing' && f.path === 'docs/context/ghost.md'));
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
   assert.ok(dateError('2026-06-13T15:04:05'), 'zoneless time is rejected');
   assert.ok(dateError('2026-06-13T15:04:05+09:00'), 'non-UTC offset is rejected');
   assert.ok(dateError('June 13'), 'non-ISO date is rejected');
   // Fractional seconds are rejected because they falsify the spec's own guarantee
   // that a lexical sort of `date` is a chronological sort: "…05.1Z" sorts before
   // "…05Z" while being later, and compaction picks the oldest run by that order.
   assert.ok(dateError('2026-06-13T15:04:05.123Z'), 'fractional seconds are rejected');
   // Calendar-ranged, so a shape that can never be a date cannot enter the changelog
   // and drive a destructive compaction.
   assert.ok(dateError('2026-99-99'), 'an impossible month and day are rejected');
   assert.ok(dateError('2026-13-01'), 'month 13 is rejected');
   assert.ok(dateError('2026-06-13T99:99:99Z'), 'an impossible time is rejected');
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

test('joinUnderRoot treats "." and "" as the repo root (no hidden .context/)', () => {
   assert.equal(joinUnderRoot('docs/', 'context/'), 'docs/context/');
   assert.equal(joinUnderRoot('.', 'context/'), 'context/');
   assert.equal(joinUnderRoot('', 'context/'), 'context/');
   assert.equal(joinUnderRoot('.', '.leji/onboarding-brief.md'), '.leji/onboarding-brief.md');
});

test('status reports unindexed reference, dangling entries, and stale index paths', () => {
   const dir = tmpdir('leji-status-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const { manifest } = loadManifest(dir);
   writeIndex(dir, manifest!); // stored index is current with the tree
   // (a) a reference doc that no category index lists
   fs.writeFileSync(path.join(dir, 'docs', 'notes.md'), '# Notes\n\nReference, not governed.\n');
   // (b) a dangling entry, and (c) drop docs/domain/ so its stored entry goes stale
   fs.writeFileSync(
      path.join(dir, 'docs', 'context', 'domain.md'),
      '# Domain\n\n```leji-index\n- path: docs/ghost.md\n```\n',
   );
   const report = statusReport(dir, manifest!);
   assert.ok(report.unindexed.includes('docs/notes.md'), 'unindexed lists the reference doc');
   assert.ok(
      report.dangling.some((d) => d.detail.includes('docs/ghost.md')),
      'dangling lists the missing entry',
   );
   assert.ok(
      report.stale.some((p) => p.startsWith('docs/domain/')),
      'stale lists the stored path no longer resolved',
   );
});

test('status flags an escaping index entry as dangling (so --strict fails)', () => {
   const dir = tmpdir('leji-status-escape-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   fs.writeFileSync(
      path.join(dir, 'docs', 'context', 'domain.md'),
      '# Domain\n\n```leji-index\n- path: ../escape.md\n```\n',
   );
   const { manifest } = loadManifest(dir);
   const report = statusReport(dir, manifest!);
   assert.ok(
      report.dangling.some((d) => /escape\.md/.test(d.detail)),
      'an escaping entry path is surfaced as a dangling item',
   );
});

/** Generate (without writing) for a fixture dir, so fixtures stay pristine. */
function writeIndexTo(dir: string, manifest: NonNullable<ReturnType<typeof loadManifest>['manifest']>) {
   const copy = tmpdir('leji-idx-copy-');
   fs.cpSync(dir, copy, { recursive: true });
   return writeIndex(copy, manifest);
}

// --- intent/records ---

test('records: valid-records fixture resolves kinds by block and file-selector override', () => {
   const dir = path.join(repoRoot, 'fixtures', 'valid-records');
   const { manifest } = loadManifest(dir);
   const scan = scanCategories(dir, manifest!);
   const kinds = new Map(scan.docs.map((d) => [d.relPath, d.kind]));
   assert.equal(kinds.get('docs/domain/overview.md'), 'intent');
   assert.equal(kinds.get('docs/records/2026-07-03-status.md'), 'record');
   assert.equal(kinds.get('docs/records/ledger.md'), 'record');
   // The file selector beats the record directory selector.
   assert.equal(kinds.get('docs/records/escalation-policy.md'), 'intent');
   // Decision-category documents are inherently records.
   assert.equal(kinds.get('docs/decisions/0001-adopt-leji.md'), 'record');
});

test('records: frontmatter kind overrides the block kind; an invalid kind is an error', () => {
   const dir = tmpdir('leji-kind-fm-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-records'), dir, { recursive: true });
   fs.writeFileSync(
      path.join(dir, 'docs', 'records', 'pinned.md'),
      '---\nkind: intent\n---\n\n# Pinned\n\nA record-directory file declaring itself intent.\n',
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'bad.md'),
      '---\nkind: sometimes\n---\n\n# Bad\n\nInvalid kind value.\n',
   );
   const { manifest } = loadManifest(dir);
   const scan = scanCategories(dir, manifest!);
   const kinds = new Map(scan.docs.map((d) => [d.relPath, d.kind]));
   assert.equal(kinds.get('docs/records/pinned.md'), 'intent');
   assert.ok(scan.findings.some((f) => f.rule === 'kind-invalid' && f.path === 'docs/domain/bad.md'));
});

test('records: route separates intent documents from record candidates', () => {
   const dir = path.join(repoRoot, 'fixtures', 'valid-records');
   const { manifest } = loadManifest(dir);
   const result = route(dir, manifest!, { paths: ['docs/records/ledger.md'], categories: ['domain'] });
   const docPaths = result.documents.map((d) => d.path);
   assert.ok(docPaths.includes('docs/domain/overview.md'));
   assert.ok(
      docPaths.includes('docs/records/escalation-policy.md'),
      'the intent-overridden file routes as required context',
   );
   assert.ok(!docPaths.some((p) => p.startsWith('docs/records/2')), 'records never route as documents');
   const byPath = new Map(result.records.map((r) => [r.path, r]));
   assert.deepEqual(byPath.get('docs/records/2026-07-03-status.md'), {
      path: 'docs/records/2026-07-03-status.md',
      category: 'domain',
      date: '2026-07-03',
      required: false,
   });
   assert.deepEqual(byPath.get('docs/records/ledger.md'), {
      path: 'docs/records/ledger.md',
      category: 'domain',
      date: null,
      required: true,
   });
   // Decision records route via `decisions`, never as generic records.
   assert.ok(!byPath.has('docs/decisions/0001-adopt-leji.md'));
});

test('records: freshness skips records; the index carries kind and record dates', () => {
   const dir = path.join(repoRoot, 'fixtures', 'valid-records');
   const { manifest } = loadManifest(dir);
   const report = freshnessReport(dir, manifest!);
   assert.equal(report.declared, 0, 'no intent doc in the fixture declares a horizon');
   const result = writeIndexTo(dir, manifest!);
   const entries = new Map(result.index!.entries.map((e) => [e.path, e]));
   assert.equal(entries.get('docs/records/2026-07-03-status.md')?.kind, 'record');
   assert.equal(entries.get('docs/records/2026-07-03-status.md')?.date, '2026-07-03');
   assert.equal(entries.get('docs/records/ledger.md')?.kind, 'record');
   assert.equal(entries.get('docs/records/ledger.md')?.date, undefined);
   assert.equal(entries.get('docs/records/escalation-policy.md')?.kind, 'intent');
});

test('records: a fully displaced broad selector is reported as shadowed by status', () => {
   const dir = tmpdir('leji-shadow-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-records'), dir, { recursive: true });
   // Shrink the record directory to only the file the intent selector steals.
   fs.rmSync(path.join(dir, 'docs', 'records', '2026-07-03-status.md'));
   fs.rmSync(path.join(dir, 'docs', 'records', 'ledger.md'));
   const { manifest } = loadManifest(dir);
   const report = statusReport(dir, manifest!);
   assert.deepEqual(report.shadowed, [{ indexFile: 'docs/context/domain.md', path: 'docs/records/' }]);
});

test('viewer: homepage, favicon, and pins accept repo-relative and root-relative forms', () => {
   const dir = copyExample();
   fs.writeFileSync(path.join(dir, 'docs', 'HOME.md'), '# Home\n');
   const { manifest } = loadManifest(dir);
   manifest!.viewer = {
      mermaid: false,
      homepage: 'docs/HOME.md', // repo-relative: normalized to HOME.md
      favicon: 'docs/HOME.md', // repo-relative: content URL must not double the root
      pins: ['domain/glossary.md'], // rootPath-relative pin (canonical form is repo-relative)
   };
   const result = generateViewer(dir, manifest!);
   assert.ok(!result.findings.some((f) => f.rule === 'viewer-path-missing'));
   const html = fs.readFileSync(path.join(dir, '.leji', 'viewer', 'index.html'), 'utf8');
   assert.ok(html.includes('"homepage":"HOME.md"'), 'repo-relative homepage normalized');
   assert.ok(html.includes('/content/HOME.md'), 'favicon URL normalized under the content mount');
   const sidebar = fs.readFileSync(path.join(dir, '.leji', 'viewer', '_sidebar.md'), 'utf8');
   assert.ok(
      sidebar.split('---')[0].includes('](/domain/glossary.md)'),
      'rootPath-relative pin resolves into the top zone',
   );
   // An unresolvable homepage is kept as authored and warned about, never silent.
   manifest!.viewer = { mermaid: false, homepage: 'docs/NOPE.md' };
   const bad = generateViewer(dir, manifest!);
   assert.ok(bad.findings.some((f) => f.rule === 'viewer-path-missing'));
});

test('ci: provider inference from the origin remote', () => {
   assert.equal(ciProviderFromRemote('git@github.com:acme/app.git'), 'github');
   assert.equal(ciProviderFromRemote('git@gitlab.com:acme/app.git'), 'gitlab');
   assert.equal(ciProviderFromRemote('https://gitlab.example.co/acme/app.git'), 'gitlab');
   assert.equal(ciProviderFromRemote('https://dev.azure.com/acme/app/_git/app'), 'azure');
   assert.equal(ciProviderFromRemote('https://bitbucket.org/acme/app.git'), null);
   assert.equal(ciProviderFromRemote(null), null);
});

test('ci --hooks: managed pre-commit hook is created, idempotent, and never clobbers', () => {
   const dir = gitSeedExample('leji-hook-');
   const first = ensureLocalHook(dir);
   assert.equal(first.action, 'created');
   const second = ensureLocalHook(dir);
   assert.equal(second.action, 'unchanged');
   const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
   assert.ok((fs.statSync(hookPath).mode & 0o111) !== 0, 'hook is executable');
   fs.writeFileSync(hookPath, '#!/bin/sh\necho custom hook\n');
   const third = ensureLocalHook(dir);
   assert.equal(third.action, 'manual', 'unmanaged hook is never clobbered');
   assert.equal(third.reason, 'foreign-hook');
   // The scalar shim is gone: the hook runs the repository's own runner argv,
   // each element single-quoted for sh. This repo declares nothing, so it is `leji`.
   assert.match(third.snippet ?? '', /^'leji' validate \|\| exit 1$/m);
   assert.doesNotMatch(third.snippet ?? '', /node_modules/);
   assert.match(fs.readFileSync(hookPath, 'utf8'), /custom hook/, 'foreign hook untouched');
});

test('ci --hooks: husky (.husky/_) merges a managed block into .husky/pre-commit, leaving its content', () => {
   const dir = gitSeedExample('leji-hook-husky-');
   execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
   const huskyPre = path.join(dir, '.husky', 'pre-commit');
   fs.mkdirSync(path.dirname(huskyPre), { recursive: true });
   fs.writeFileSync(huskyPre, '#!/bin/sh\nnpm test\n');
   const r = ensureLocalHook(dir);
   assert.equal(r.path, '.husky/pre-commit');
   assert.equal(r.action, 'updated');
   assert.equal(r.managed, 'block');
   const merged = fs.readFileSync(huskyPre, 'utf8');
   assert.match(merged, /npm test/, 'existing husky content untouched');
   assert.match(merged, /# >>> leji hooks \(managed\) >>>/);
   assert.match(merged, /^'leji' validate \|\| exit 1$/m);
   assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), '.git/hooks not written');
   assert.equal(ensureLocalHook(dir).action, 'unchanged', 'rerun is idempotent');
});

test('ci --hooks: husky repo without .husky/pre-commit creates an executable shebang + block', () => {
   const dir = gitSeedExample('leji-hook-husky-new-');
   execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir });
   const r = ensureLocalHook(dir);
   assert.equal(r.path, '.husky/pre-commit');
   assert.equal(r.action, 'created');
   assert.equal(r.managed, 'block');
   const huskyPre = path.join(dir, '.husky', 'pre-commit');
   const body = fs.readFileSync(huskyPre, 'utf8');
   assert.ok(body.startsWith('#!/bin/sh\n'), 'shebang first');
   assert.match(body, /# <<< leji hooks \(managed\) <<</);
   assert.ok((fs.statSync(huskyPre).mode & 0o111) !== 0, 'husky hook is executable');
   assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
});

test('ci --hooks: direct .husky (v8) hook is executable and mode-corrected on rerun', () => {
   const dir = gitSeedExample('leji-hook-v8-');
   execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: dir });
   const first = ensureLocalHook(dir);
   assert.equal(first.action, 'created');
   assert.equal(first.path, '.husky/pre-commit');
   assert.equal(first.managed, 'block');
   const huskyPre = path.join(dir, '.husky', 'pre-commit');
   assert.ok((fs.statSync(huskyPre).mode & 0o111) !== 0, 'created executable');
   assert.equal(ensureLocalHook(dir).action, 'unchanged', 'byte-current second run');
   // A byte-current but non-executable direct .husky hook is a mode-only correction.
   fs.chmodSync(huskyPre, 0o644);
   const corrected = ensureLocalHook(dir);
   assert.equal(corrected.action, 'updated', 'mode-only correction is updated');
   assert.ok((fs.statSync(huskyPre).mode & 0o111) !== 0, 're-made executable');
});

test('ci --hooks: a custom core.hooksPath dir gets a managed hook file', () => {
   const dir = gitSeedExample('leji-hook-custom-');
   execFileSync('git', ['config', 'core.hooksPath', 'githooks'], { cwd: dir });
   const r = ensureLocalHook(dir);
   assert.equal(r.path, 'githooks/pre-commit');
   assert.equal(r.action, 'created');
   assert.equal(r.managed, 'file');
   const custom = path.join(dir, 'githooks', 'pre-commit');
   assert.ok((fs.statSync(custom).mode & 0o111) !== 0, 'custom hook is executable');
   assert.match(fs.readFileSync(custom, 'utf8'), /# leji pre-commit \(managed\)/);
   assert.match(fs.readFileSync(custom, 'utf8'), /^'leji' validate \|\| exit 1$/m, 'runs the repository runner');
   assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
});

test('ci --hooks: a core.hooksPath outside the repo is never written, reported manual', () => {
   const dir = gitSeedExample('leji-hook-escape-');
   const outside = tmpdir('leji-hook-outside-');
   execFileSync('git', ['config', 'core.hooksPath', outside], { cwd: dir });
   const r = ensureLocalHook(dir);
   assert.equal(r.action, 'manual', 'an escaping hooks path is never written');
   assert.equal(r.managed, 'file');
   assert.equal(r.reason, 'outside-root');
   assert.equal(r.path, `${outside}/pre-commit`, 'reports the computed target');
   assert.match(r.snippet ?? '', /^'leji' validate \|\| exit 1$/m);
   assert.ok(!fs.existsSync(path.join(outside, 'pre-commit')), 'nothing written outside the repo');
   assert.ok(!fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')));
});

test('ci --hooks: a byte-current .git/hooks/pre-commit that lost its exec bit is mode-corrected', () => {
   const dir = gitSeedExample('leji-hook-modefix-');
   assert.equal(ensureLocalHook(dir).action, 'created');
   const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
   assert.ok((fs.statSync(hookPath).mode & 0o111) !== 0, 'created executable');
   assert.equal(ensureLocalHook(dir).action, 'unchanged', 'byte-current second run');
   fs.chmodSync(hookPath, 0o644);
   const corrected = ensureLocalHook(dir);
   assert.equal(corrected.action, 'updated', 'mode-only correction is updated');
   assert.ok((fs.statSync(hookPath).mode & 0o111) !== 0, 're-made executable');
});

test('ci --hooks: a relative out-of-root core.hooksPath reports a normalized target', () => {
   const dir = gitSeedExample('leji-hook-relesc-');
   execFileSync('git', ['config', 'core.hooksPath', '../sibling-ext/.husky/_'], { cwd: dir });
   const r = ensureLocalHook(dir);
   assert.equal(r.action, 'manual');
   assert.equal(r.reason, 'outside-root');
   assert.equal(r.managed, 'block');
   const expected = path.join(path.dirname(dir), 'sibling-ext', '.husky', 'pre-commit');
   assert.equal(r.path, expected, 'the reported target is lexically normalized (no ..)');
   assert.ok(!r.path.includes('..'), 'no unnormalized .. in the reported path');
});

test('ci: local-first CI variant when the repo declares @leji-org/leji', () => {
   const dir = gitSeedExample('leji-ci-local-');
   fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { '@leji-org/leji': '^1.3.0' } }),
   );
   // The generated job runs `npm ci`, which needs an npm lockfile: declaring the
   // dependency is necessary but not sufficient.
   fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
   ensureCiWorkflow(dir, 'github');
   const wf = fs.readFileSync(path.join(dir, '.github', 'workflows', 'leji.yml'), 'utf8');
   assert.match(wf, /- run: npm ci/);
   assert.match(wf, /npx --no-install @leji-org\/leji validate/);
   assert.ok(!wf.includes('npx -y @leji-org/leji@1'), 'no floating fallback when the dep is local');
});

test('ci: a pnpm repository gets pnpm, never `npm ci`, and an unlocked one falls back', () => {
   // The generated job installs with the manager the repository actually uses: a
   // pnpm repo that declares the CLI installs from ITS lockfile and runs the local
   // binary through pnpm. `npm ci` here would fail before Leji ran.
   const dir = gitSeedExample('leji-ci-pnpm-');
   fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { '@leji-org/leji': '^1.3.0' } }),
   );
   fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
   ensureCiWorkflow(dir, 'github');
   const wf = fs.readFileSync(path.join(dir, '.github', 'workflows', 'leji.yml'), 'utf8');
   assert.ok(!wf.includes('npm ci'), 'no npm ci in a pnpm repository');
   assert.match(wf, /- run: corepack enable && pnpm install --frozen-lockfile/);
   assert.match(wf, /- run: pnpm exec leji validate/);
   assert.ok(!wf.includes('npx -y @leji-org/leji@1'), 'declared + locked is never the fallback');

   // Declared with no lockfile at all: nothing to install from, so the job that
   // needs no manifest is the honest one.
   const unlocked = gitSeedExample('leji-ci-nolock-');
   fs.writeFileSync(
      path.join(unlocked, 'package.json'),
      JSON.stringify({ devDependencies: { '@leji-org/leji': '^1.3.0' } }),
   );
   ensureCiWorkflow(unlocked, 'github');
   const fallback = fs.readFileSync(path.join(unlocked, '.github', 'workflows', 'leji.yml'), 'utf8');
   assert.match(fallback, /npx -y @leji-org\/leji@1 validate/, 'falls back to the pinned npx form');
});

test('ci: npx @1 fallback when no package.json (or an unparseable one) declares the dep', () => {
   const noPkg = gitSeedExample('leji-ci-npx-');
   ensureCiWorkflow(noPkg, 'github');
   const wf = fs.readFileSync(path.join(noPkg, '.github', 'workflows', 'leji.yml'), 'utf8');
   assert.match(wf, /- run: npx -y @leji-org\/leji@1 validate/);
   assert.ok(!wf.includes('npm ci'), 'no local install without the dep');
   const badPkg = gitSeedExample('leji-ci-bad-');
   fs.writeFileSync(path.join(badPkg, 'package.json'), '{ not json');
   ensureCiWorkflow(badPkg, 'gitlab');
   const gl = fs.readFileSync(path.join(badPkg, '.gitlab-ci.yml'), 'utf8');
   assert.match(gl, /- npx -y @leji-org\/leji@1 validate/);
});

test('ci: package.json parsing — BOM is stripped and detected; an array field is ignored', () => {
   // A BOM-prefixed valid manifest still detects the declared dep (local-first).
   const bomDir = gitSeedExample('leji-ci-bom-');
   fs.writeFileSync(
      path.join(bomDir, 'package.json'),
      '\ufeff' + JSON.stringify({ dependencies: { '@leji-org/leji': '1.3.0' } }),
   );
   fs.writeFileSync(path.join(bomDir, 'package-lock.json'), '{"lockfileVersion":3}');
   ensureCiWorkflow(bomDir, 'github');
   assert.match(
      fs.readFileSync(path.join(bomDir, '.github', 'workflows', 'leji.yml'), 'utf8'),
      /npx --no-install @leji-org\/leji validate/,
      'BOM stripped, dep detected',
   );
   // `dependencies` as a JSON array is not an object, so it is treated as absent.
   const arrDir = gitSeedExample('leji-ci-arr-');
   fs.writeFileSync(path.join(arrDir, 'package.json'), JSON.stringify({ dependencies: ['@leji-org/leji'] }));
   ensureCiWorkflow(arrDir, 'gitlab');
   assert.match(
      fs.readFileSync(path.join(arrDir, '.gitlab-ci.yml'), 'utf8'),
      /- npx -y @leji-org\/leji@1 validate/,
      'array dependencies field falls back',
   );
   // A non-finite JSON constant (NaN) fails the strict parse -> fallback (matches Go).
   const nanDir = gitSeedExample('leji-ci-nan-');
   fs.writeFileSync(path.join(nanDir, 'package.json'), '{"dependencies":{"@leji-org/leji":NaN}}');
   ensureCiWorkflow(nanDir, 'github');
   assert.match(
      fs.readFileSync(path.join(nanDir, '.github', 'workflows', 'leji.yml'), 'utf8'),
      /- run: npx -y @leji-org\/leji@1 validate/,
      'NaN value falls back',
   );
});

test('mounts: the witness ref scheme is fixed-length and injective, and rejects unusable tracking refs', () => {
   assert.ok(validTrackingRef('refs/heads/main') && validTrackingRef('refs/tags/v1.2.3'));
   assert.ok(validTrackingRef('refs/heads/release/1.x'), 'a slashed branch name is ordinary');
   // Everything `git check-ref-format` rejects is a manifest error, not a refresh
   // that quietly does something else.
   const bad = [
      'main',
      'refs/remotes/origin/main',
      'refs/heads/*',
      'refs/heads/a b',
      'refs/heads/x^{}',
      'refs/heads/a..b',
      'refs/heads/a@{0}',
      'refs/heads//b',
      'refs/heads/b/',
      'refs/heads/b.',
      'refs/heads/.hidden',
      'refs/heads/a/.hidden',
      'refs/heads/b.lock',
      'refs/heads/a.lock/b',
      'refs/heads/a\\b',
      'refs/heads/a\tb',
      'refs/heads/a\u0000b',
      'refs/heads/',
   ];
   for (const ref of bad) assert.equal(validTrackingRef(ref), false, JSON.stringify(ref));
   // Both components are fixed-length hex: no per-component filesystem limit to
   // outgrow, and no case fold that collides two declarations.
   const identity = 'https://github.com/acme/product-context';
   const ref = witnessRefFor(identity, 'refs/heads/main');
   assert.match(ref, /^refs\/leji-witness\/v1\/[0-9a-f]{64}\/[0-9a-f]{64}$/);
   assert.equal(witnessRefFor(identity, `refs/heads/${'x'.repeat(2000)}`).length, ref.length, 'fixed length');
   assert.notEqual(ref, witnessRefFor(identity, 'refs/heads/Main'));
   assert.notEqual(ref, witnessRefFor('https://github.com/acme/other', 'refs/heads/main'));
});

test('mounts: status takes one clock reading per run and omits counts it did not compute', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.federation = {
      mounts: [
         { name: 'zeta', source: 'https://github.com/acme/zeta', pin: 'a'.repeat(40), owner: { name: 'Jo' } },
         {
            name: 'alpha',
            source: 'not-a-locator',
            pin: 'b'.repeat(40),
            trackingRef: 'refs/heads/main',
            owner: { name: 'Jo' },
         },
      ],
   };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const rows = mountStatus(dir, JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {
      now: () => new Date('2020-01-02T03:04:05.000Z'),
   });
   assert.deepEqual(
      rows.map((r) => r.name),
      ['alpha', 'zeta'],
      'rows sort by name, not manifest order',
   );
   assert.deepEqual(
      rows.map((r) => r.pinReport.observedAt),
      ['2020-01-02T03:04:05.000Z', '2020-01-02T03:04:05.000Z'],
      'one injectable clock reading for the whole execution',
   );
   assert.equal(rows[0].pinReport.reason, 'mount-source-unnormalizable');
   assert.equal(rows[1].pinReport.reason, 'mount-no-tracking-ref');
   // Uncomputed counts are absent keys, never nulls; the schema key order is fixed.
   for (const row of rows) {
      assert.ok(!('behind' in row.pinReport) && !('ahead' in row.pinReport));
      assert.deepEqual(Object.keys(row.pinReport), [
         'state',
         'comparedRef',
         'comparisonRepository',
         'witnessProvenance',
         'ancestryComplete',
         'reason',
         'observedAt',
      ]);
      assert.equal(row.pinReport.comparisonRepository, null);
      assert.equal(row.pinReport.witnessProvenance, null);
   }
});

test('mounts: a hydrate declaration error never echoes the declaration back into its detail', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.federation = {
      mounts: [
         // A source may be a local checkout path, and a path is machine-specific.
         {
            name: 'local',
            source: '/Users/someone/checkouts/product-context',
            pin: 'a'.repeat(40),
            owner: { name: 'Jo' },
         },
         {
            name: 'tracked',
            source: 'https://github.com/acme/product-context',
            pin: 'b'.repeat(40),
            trackingRef: 'main',
            owner: { name: 'Jo' },
         },
      ],
   };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const r = hydrateMounts(dir, JSON.parse(fs.readFileSync(manifestPath, 'utf8')), {});
   assert.deepEqual(
      r.outcomes.map((o) => [o.name, o.status, o.detail]),
      [
         ['local', 'error', 'source is not a normalizable locator'],
         ['tracked', 'error', 'trackingRef is not a fully qualified branch or tag'],
      ],
   );
   assert.ok(!JSON.stringify(r.outcomes).includes('/Users/'), 'no filesystem path reaches canonical output');
});

// --- viewer route keys are separator-agnostic ---
// The server matches routes against a forward-slashed prefix. Deriving the key
// with the platform's `path.normalize` produced backslashes on Windows, so every
// `/content/*` request missed its branch and fell through to the chrome mount as
// a 404. These pin the contract on any platform: the key is always forward-slashed,
// and traversal collapses whichever separator the request used.
test('urlPathToRel yields forward-slashed route keys and collapses traversal', () => {
   assert.equal(urlPathToRel('/content/boot-profile.md'), 'content/boot-profile.md');
   assert.equal(urlPathToRel('/content/agents/core.md'), 'content/agents/core.md');
   assert.equal(urlPathToRel('/content/_sidebar.md'), 'content/_sidebar.md');
   assert.equal(urlPathToRel('/'), '');
   assert.equal(urlPathToRel('/assets/app.js'), 'assets/app.js');
   // One request path, one route key, whichever separator it used. Containment is
   // enforced separately in serveFrom and does not depend on this.
   assert.equal(urlPathToRel('/content/..\\..\\etc\\passwd'), 'etc/passwd');
   assert.equal(urlPathToRel('/content/../../etc/passwd'), 'etc/passwd');
   assert.equal(urlPathToRel('/content\\agents\\core.md'), 'content/agents/core.md');
   // One key per request, so trailing and repeated separators cannot produce a
   // second spelling. All three SDKs are pinned to this same table.
   assert.equal(urlPathToRel(''), '');
   assert.equal(urlPathToRel('.'), '');
   assert.equal(urlPathToRel('/content'), 'content');
   assert.equal(urlPathToRel('/content/'), 'content');
   assert.equal(urlPathToRel('//content//core.md'), 'content/core.md');
   assert.equal(urlPathToRel('../../x'), 'x');
   // Every key a route test compares against is forward-slashed.
   for (const u of ['/content/a.md', '/content\\a.md', '/content/sub\\a.md']) {
      assert.ok(!urlPathToRel(u).includes('\\'), `no backslash survives in ${u}`);
      assert.ok(urlPathToRel(u).startsWith('content/'), `content prefix matches for ${u}`);
   }
});

// --- adoption records the docs root as it is named on disk ---
// Detection tested `isDir(root/'docs')`, which succeeds on a case-insensitive
// filesystem when the directory is `Docs`, and then recorded the candidate string
// rather than the entry, so the manifest carried a path that does not match disk.
// On a case-sensitive filesystem the same test missed and adoption scaffolded a
// second directory beside the existing one.
test('adopt detects an existing docs root by its real name, whatever its case', () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-case-'));
   try {
      fs.mkdirSync(path.join(dir, 'Docs'));
      fs.writeFileSync(path.join(dir, 'Docs', 'note.md'), '# note\n');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
      const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
      const out = execFileSync(process.execPath, [cli, 'adopt', '--dry-run', '--yes'], {
         cwd: dir,
         encoding: 'utf8',
      });
      assert.ok(out.includes('Docs/'), 'the write plan uses the real directory name');
      assert.ok(!/(^|[^A-Za-z])docs\//.test(out), 'no lowercase docs/ path is planned');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// A case-sensitive filesystem can carry both spellings; the exact match wins so
// detection does not depend on directory-entry order.
test('adopt prefers an exact docs-root match over a case-insensitive one', (t) => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-case2-'));
   try {
      fs.mkdirSync(path.join(dir, 'Docs'));
      try {
         fs.mkdirSync(path.join(dir, 'docs'));
      } catch {
         t.skip('case-insensitive filesystem: both spellings cannot exist at once');
         return;
      }
      fs.writeFileSync(path.join(dir, 'docs', 'note.md'), '# note\n');
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
      const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
      const out = execFileSync(process.execPath, [cli, 'adopt', '--dry-run', '--yes'], { cwd: dir, encoding: 'utf8' });
      assert.ok(/(^|[^A-Za-z])docs\//m.test(out), 'the exact-case candidate wins when both exist');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// The helper test above guards the helper; this guards that the server routes
// through it, which is the defect a unit test on a pure function cannot see.
test('serveViewer routes a backslash-separated request to the content mount', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-route-'));
   try {
      fs.mkdirSync(path.join(dir, 'docs'));
      fs.writeFileSync(path.join(dir, 'docs', 'note.md'), '# note\n');
      const { serveViewer } = await import('../dist/index.js');
      const server = await serveViewer(dir, 0, 'docs/');
      const port = (server.address() as { port: number }).port;
      const get = (p: string): Promise<{ status: number; body: string }> =>
         new Promise((res, rej) => {
            const req = http.get({ host: '127.0.0.1', port, path: p }, (r: any) => {
               let b = '';
               r.on('data', (c: Buffer) => (b += c));
               r.on('end', () => res({ status: r.statusCode ?? 0, body: b }));
            });
            req.on('error', rej);
         });
      try {
         const fwd = await get('/content/note.md');
         assert.equal(fwd.status, 200, 'forward-slashed content path is served');
         assert.match(fwd.body, /# note/);
         // Percent-encoded backslash: the same document, through the same mount.
         const back = await get('/content%5Cnote.md');
         assert.equal(back.status, 200, 'backslash-separated content path reaches the same mount');
         assert.match(back.body, /# note/);
         // Containment still refuses an escape, whichever separator is used.
         assert.equal((await get('/content/..%5C..%5Cetc%5Cpasswd')).status, 404);
         // A "//"-leading target is a path, not a protocol-relative URL: parsing it
         // against a base would move "content" into the host and lose the segment.
         const dbl = await get('//content//note.md');
         assert.equal(dbl.status, 200, 'repeated separators reach the same mount');
         assert.match(dbl.body, /# note/);
      } finally {
         server.close();
      }
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// Directory-entry order is unspecified, so the choice must be a function of the
// set and not of the order it arrives in. Injected rather than read from a
// filesystem: two readdir calls return the same order, so a filesystem-backed
// test would pass with the ordering rule reverted.
test('pickDocsRoot chooses the same root whatever order the names arrive in', () => {
   assert.equal(pickDocsRoot(['Docs', 'DOCS']), 'DOCS/');
   assert.equal(pickDocsRoot(['DOCS', 'Docs']), 'DOCS/');
   assert.equal(pickDocsRoot(['Docs', 'docs', 'DOCS']), 'docs/', 'exact spelling wins over any variant');
   assert.equal(pickDocsRoot(['docs', 'Docs']), 'docs/');
   // Candidate precedence is unchanged: docs before doc before documentation.
   assert.equal(pickDocsRoot(['documentation', 'doc', 'docs']), 'docs/');
   assert.equal(pickDocsRoot(['documentation', 'DOC']), 'DOC/');
   assert.equal(pickDocsRoot([]), null);
   assert.equal(pickDocsRoot(['src', 'lib']), null);
   // Unicode folding would match this onto 'docs'; plain lowercasing must not.
   assert.equal(pickDocsRoot(['docſ']), null);
});

// A documentation root may be a directory symlink; detection follows it, as it
// did before entry types were read directly.
test('adopt detects a symlinked docs root', (t) => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-symlink-'));
   try {
      fs.mkdirSync(path.join(dir, 'shared'));
      fs.writeFileSync(path.join(dir, 'shared', 'note.md'), '# note\n');
      fs.mkdirSync(path.join(dir, 'repo'));
      try {
         fs.symlinkSync(path.join(dir, 'shared'), path.join(dir, 'repo', 'documentation'), 'dir');
      } catch {
         t.skip('symlinks unavailable on this platform');
         return;
      }
      const repo = path.join(dir, 'repo');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
      const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
      const out = execFileSync(process.execPath, [cli, 'adopt', '--dry-run', '--yes'], { cwd: repo, encoding: 'utf8' });
      // A non-default spelling on purpose: with `docs` the fallback is also `docs/`,
      // so the assertion could not tell detection from the default.
      assert.ok(/documentation\//.test(out), 'the symlinked root is detected');
      assert.ok(!/(^|[^A-Za-z])docs\//m.test(out), 'no second tree is scaffolded at the default path');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});
