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
   conformanceReport,
   freshnessReport,
   generateDocs,
   loadManifest,
   validateLayer,
   writeIndex,
} from '../dist/index.js';
import { finding, hasErrors, summarize } from '../dist/lib/findings.js';
import { walkMd, underPath } from '../dist/lib/fsx.js';

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

test('checkIndex/writeIndex without a declared indexPath report index-required', () => {
   const dir = tmpdir('leji-noidx-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), dir, { recursive: true });
   const { manifest } = loadManifest(dir);
   assert.equal(checkIndex(dir, manifest!).findings[0].rule, 'index-required');
   assert.equal(writeIndex(dir, manifest!).findings[0].rule, 'index-required');
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

test('docs: generates viewer + sidebar that reflect the layer', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const result = generateDocs(dir, manifest!);
   assert.deepEqual(result.written, [
      'docs/index.html',
      'docs/_sidebar.md',
      'docs/docs-viewer-assets/docsify-sidebar-collapse.min.css',
      'docs/docs-viewer-assets/docsify-sidebar-collapse.min.js',
      'docs/docs-viewer-assets/docsify.min.js',
      'docs/docs-viewer-assets/search.min.js',
      'docs/docs-viewer-assets/vue.css',
   ]);
   const html = fs.readFileSync(path.join(dir, 'docs', 'index.html'), 'utf8');
   assert.ok(html.includes('"name":"acme-billing-context"'), 'layer name baked into the JSON config');
   assert.ok(html.includes('stripFrontmatter'), 'frontmatter hook present');
   assert.ok(html.includes('"homepage":"boot-profile.md"'), 'boot profile is the homepage');
   assert.ok(html.includes('<title>acme-billing-context</title>'), 'escaped layer name in title');
   // The vendored assets (core + theme + search/collapse plugins) land alongside
   // the page (no remote CDN).
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'docs-viewer-assets', 'docsify.min.js')));
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'docs-viewer-assets', 'vue.css')));
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'docs-viewer-assets', 'search.min.js')));
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'docs-viewer-assets', 'docsify-sidebar-collapse.min.js')));
   assert.ok(!fs.existsSync(path.join(dir, 'docs', 'docs-viewer-assets', 'PROVENANCE.txt')), 'provenance not copied');
   const sidebar = fs.readFileSync(path.join(dir, 'docs', '_sidebar.md'), 'utf8');
   assert.equal(
      sidebar,
      [
         '- [Boot profile](boot-profile.md)',
         '',
         '---',
         '',
         '- Domain',
         '  - [Glossary](domain/glossary.md)',
         '- System',
         '  - [System Invariants](system/invariants.md)',
         '- Decisions',
         '  - [Adopt the Leji context layer](decisions/0001-adopt-leji.md)',
         '',
      ].join('\n'),
   );
   // Deterministic: regeneration is byte-identical.
   generateDocs(dir, manifest!);
   assert.equal(fs.readFileSync(path.join(dir, 'docs', '_sidebar.md'), 'utf8'), sidebar);
});

test('docs: init --yes then docs yields a browsable scaffold', async () => {
   const dir = tmpdir('leji-docs-init-');
   const { initLayer: init } = await import('../dist/index.js');
   await init({ dir, yes: true, name: 'demo-context' });
   const { manifest } = loadManifest(dir);
   const result = generateDocs(dir, manifest!);
   assert.equal(result.entries, 3);
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'index.html')));
});

test('docs: --serve serves the scaffold on localhost', async () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   generateDocs(dir, manifest!);
   const { serveDocs: serve } = await import('../dist/index.js');
   const server = await serve(dir, 0);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      const page = await fetch(`http://127.0.0.1:${port}/docs/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /stripFrontmatter/);
      // A directory request without a trailing slash redirects so the viewer's
      // relative asset paths resolve (e.g. /docs -> /docs/).
      const noSlash = await fetch(`http://127.0.0.1:${port}/docs`, { redirect: 'manual' });
      assert.equal(noSlash.status, 301);
      assert.equal(noSlash.headers.get('location'), '/docs/');
      const md = await fetch(`http://127.0.0.1:${port}/docs/domain/glossary.md`);
      assert.equal(md.status, 200);
      const traversal = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
      assert.notEqual(traversal.status, 200, 'path traversal refused');
   } finally {
      server.close();
   }
});

test('docs: port precedence is flag, then manifest docs.port, then 5354', async () => {
   const { resolveDocsPort } = await import('../dist/index.js');
   const base = JSON.parse(fs.readFileSync(path.join(exampleDir, 'leji.json'), 'utf8'));
   assert.equal(resolveDocsPort(base), 5354);
   assert.equal(resolveDocsPort({ ...base, docs: { port: 21300 } }), 21300);
   assert.equal(resolveDocsPort({ ...base, docs: { port: 21300 } }, 4000), 4000);
   assert.equal(resolveDocsPort({ ...base, docs: { port: 21300 } }, 0), 0);
});

test('docs: manifest with a docs block validates', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.docs = { port: 21300 };
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

test('docs: buildSidebar skips the boot profile and entries that fall outside rootPath', () => {
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

test('validate: indexed claim without any declared changelogPath is changelog-required', () => {
   const dir = copyExample();
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   // indexed is already claimed; drop the changelog declaration entirely.
   delete manifest.machine.changelogPath;
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
   const result = validateLayer(dir);
   assert.ok(
      result.findings.some(
         (f) => f.rule === 'changelog-required' && f.path === 'leji.json' && /no machine.changelogPath/.test(f.message),
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
