import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { adoptLayer, detectHosts, initLayer, validateLayer, writeIndex, loadManifest } from '../dist/index.js';

function tmpdir(): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), 'leji-onboarding-'));
}

test('init --dry-run writes nothing and reports the plan', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'some existing agent config\n');
   const result = await initLayer({ dir, yes: true, dryRun: true });

   assert.equal(result.dryRun, true);
   assert.deepEqual(result.written, []);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false, 'dry-run creates no manifest');

   const creates = result.plan.filter((e) => e.status === 'create').map((e) => e.rel);
   assert.ok(creates.includes('leji.json'));
   assert.ok(creates.includes('docs/.leji/onboarding-brief.md'));
   // The existing vendor file is detected and explicitly left untouched.
   const untouched = result.plan.find((e) => e.rel === 'CLAUDE.md');
   assert.equal(untouched?.status, 'wont-modify');
});

test('init writes the onboarding brief under a dot-dir, excluded from the index', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true, level: 'indexed', name: 'acme-context' });

   const brief = path.join(dir, 'docs', '.leji', 'onboarding-brief.md');
   assert.ok(fs.existsSync(brief), 'brief is written');

   const { manifest } = loadManifest(dir);
   const result = writeIndex(dir, manifest!);
   const indexedPaths = result.index!.entries.map((e) => e.path);
   assert.ok(
      !indexedPaths.some((p) => p.includes('.leji')),
      'the transient brief never appears in the generated index',
   );
});

test('validate --content warns on a fresh scaffold but never errors', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   const result = validateLayer(dir, { content: true });

   const rules = result.findings.map((f) => f.rule);
   assert.ok(rules.includes('content-identity'), 'flags the generic identity');
   assert.ok(rules.includes('content-placeholder'), 'flags placeholder text');
   assert.ok(rules.includes('content-thin'), 'flags thin categories');
   // Content findings are warning-only; the layer remains error-free.
   assert.equal(result.findings.filter((f) => f.severity === 'error').length, 0);
});

test('validate without --content does not emit content findings', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   const result = validateLayer(dir);
   assert.ok(!result.findings.some((f) => f.rule.startsWith('content-')));
});

test('a populated layer passes the content lint clean', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   // Replace the placeholder scaffold with real, repo-specific content.
   fs.writeFileSync(
      path.join(dir, 'docs', 'boot-profile.md'),
      [
         '# Boot Profile',
         '',
         '## Identity',
         '',
         'Acme is a B2B invoicing platform in production since 2024.',
         '',
         '## Loading',
         '',
         '- docs/system/invariants.md: the rules every change lives with',
         '',
         '## Posture',
         '',
         '- Proceed without asking: doc fixes.',
         '- Stop and ask: settlement math.',
         '- Never: bypass the ledger.',
         '',
         '## Maintenance',
         '',
         'Append to docs/decisions when you change this layer.',
         '',
      ].join('\n'),
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'glossary.md'),
      '---\nsummary: terms\n---\n\n# Glossary\n\n- Invoice: a request for payment.\n- Credit note: reduces an invoice.\n- Settlement: matching funds to invoices.\n',
   );
   fs.writeFileSync(
      path.join(dir, 'docs', 'system', 'invariants.md'),
      '---\nsummary: rules\n---\n\n# System Invariants\n\n- Money is integer minor units.\n- Invoices are immutable once sent.\n- The ledger is the source of truth.\n',
   );
   const result = validateLayer(dir, { content: true });
   assert.ok(
      !result.findings.some((f) => f.rule.startsWith('content-')),
      `expected no content findings, got: ${result.findings.map((f) => f.rule).join(', ')}`,
   );
});

test('detectHosts ranks confirmed > project-present > installed-likely (injected probes)', () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'codex config\n'); // codex: project-present
   const home = tmpdir();
   fs.mkdirSync(path.join(home, '.gemini')); // gemini: installed-likely
   const hosts = detectHosts({
      root: dir,
      homedir: home,
      platform: 'linux',
      hasBinary: (b) => b === 'claude', // claude: confirmed
   });
   assert.deepEqual(
      hosts.map((h) => h.id),
      ['claude-code', 'codex', 'gemini'],
   );
   assert.equal(hosts[0].strength, 'confirmed');
   assert.equal(hosts.find((h) => h.id === 'codex')?.strength, 'project-present');
   assert.equal(hosts.find((h) => h.id === 'gemini')?.strength, 'installed-likely');
});

test('init --agent wires a vendor redirect and still validates clean', async () => {
   const dir = tmpdir();
   const res = await initLayer({ dir, yes: true, agent: 'claude-code' });
   assert.ok(res.written.includes('CLAUDE.md'), 'adapter is created');
   assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /docs\/boot-profile\.md/);
   const { manifest } = loadManifest(dir);
   assert.deepEqual(manifest!.vendorAdapters, ['CLAUDE.md']);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('init --agent never overwrites an existing entrypoint', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'my own config\n');
   const res = await initLayer({ dir, yes: true, agent: 'claude-code' });
   assert.ok(!res.written.includes('CLAUDE.md'));
   assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'my own config\n');
   assert.ok(!loadManifest(dir).manifest!.vendorAdapters);
});

test('init --agent rejects an unknown host', async () => {
   const dir = tmpdir();
   await assert.rejects(() => initLayer({ dir, yes: true, agent: 'frobnicate' }), /unknown agent/);
});

test('adopt reuses an existing docs root and migrates vendor content (draft)', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs', 'README.md'), '# Docs\n');
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests. Use 3-space indent.\n');

   const res = await adoptLayer({ dir, yes: true });
   assert.equal(res.detectedRoot, 'docs/');
   assert.deepEqual(res.migrated, ['CLAUDE.md']);
   assert.equal(res.draft, true, 'a non-redirecting vendor file makes it a draft');

   // Original is untouched; content migrated into a Leji-owned governance doc.
   assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'Always run tests. Use 3-space indent.\n');
   const imported = path.join(dir, 'docs', 'governance', 'imported-claude.md');
   assert.ok(fs.existsSync(imported), 'migrated file exists with a single .md extension');
   assert.match(fs.readFileSync(imported, 'utf8'), /Always run tests/);
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'decisions', '0002-adopt-existing-agent-context.md')));

   // Draft is honest: the non-redirecting entrypoint makes validate error.
   const v = validateLayer(dir);
   assert.ok(v.findings.some((f) => f.rule === 'vendor-adapter-redirect' && f.severity === 'error'));
});

test('adopt --wire-adapters converts the entrypoint and validates clean core', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests.\n');

   const res = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.equal(res.draft, false);
   assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /docs\/boot-profile\.md/);
   assert.deepEqual(loadManifest(dir).manifest!.vendorAdapters, ['CLAUDE.md']);
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('adopt --dry-run shows convert vs leave-as-is and writes nothing', async () => {
   const dir = tmpdir();
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x\n');
   const res = await adoptLayer({ dir, yes: true, dryRun: true, wireAdapters: true });
   assert.deepEqual(res.written, []);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false);
   assert.equal(res.plan.find((e) => e.rel === 'CLAUDE.md')?.status, 'overwrite');
});

test('adopt refuses when a layer already exists', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   await assert.rejects(() => adoptLayer({ dir, yes: true }), /already has a Leji layer/);
});

test('init --agent + --reviewer wires a multi-agent setup that validates clean', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const res = await initLayer({ dir, yes: true, agent: 'claude-code', reviewer: 'codex' });
   const { manifest } = loadManifest(dir);
   // Primary adapter + reviewer role binding + reviewer adapter.
   assert.equal(manifest!.agents?.reviewer, 'docs/agents/reviewer.md');
   assert.ok(manifest!.vendorAdapters?.includes('CLAUDE.md'));
   assert.ok(manifest!.vendorAdapters?.includes('AGENTS.md'));
   const reviewer = fs.readFileSync(path.join(dir, 'docs', 'agents', 'reviewer.md'), 'utf8');
   assert.match(reviewer, /^role: reviewer$/m);
   assert.match(reviewer, /^host: codex$/m);
   assert.ok(res.written.includes('docs/agents/reviewer.md'));
   const v = validateLayer(dir);
   assert.equal(v.findings.filter((f) => f.severity === 'error').length, 0);
});

test('init --reviewer rejects an unknown host', async () => {
   const dir = tmpdir();
   await assert.rejects(() => initLayer({ dir, yes: true, reviewer: 'frobnicate' }), /unknown agent/);
});

test('conformance --explain guides toward the next level', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true }); // core, not indexed
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const { conformanceReport, renderExplain } = await import('../dist/index.js');
   const explain = renderExplain(conformanceReport(dir));
   assert.match(explain, /To reach "indexed"/);
   assert.match(explain, /validate --content/);
});

test('init --agent cursor wires a directory-style adapter that validates clean', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const res = await initLayer({ dir, yes: true, agent: 'cursor' });
   assert.ok(res.written.includes('.cursor/rules/leji.md'));
   assert.match(fs.readFileSync(path.join(dir, '.cursor', 'rules', 'leji.md'), 'utf8'), /docs\/boot-profile\.md/);
   assert.deepEqual(loadManifest(dir).manifest!.vendorAdapters, ['.cursor/rules/leji.md']);
   assert.equal(validateLayer(dir).findings.filter((f) => f.severity === 'error').length, 0);
});

test('init --ci writes a GitHub Actions validation workflow', async () => {
   const dir = tmpdir();
   const res = await initLayer({ dir, yes: true, ci: true });
   assert.ok(res.written.includes('.github/workflows/leji.yml'));
   assert.match(fs.readFileSync(path.join(dir, '.github', 'workflows', 'leji.yml'), 'utf8'), /leji@latest validate/);
});

test('adopt --wire-adapters migrates mixed redirect+instructions before overwriting', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   // A vendor file that mentions the boot path AND carries real instructions,
   // including an instruction sharing the SAME line as the boot-path reference.
   fs.writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      'Read docs/boot-profile.md first. Never deploy on Fridays.\nAlways run the full test suite before committing.\n',
   );
   const res = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.ok(res.migrated.includes('CLAUDE.md'), 'mixed file is migrated, not silently overwritten');
   const imported = fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), 'utf8');
   assert.match(imported, /Never deploy on Fridays/, 'same-line instructions are preserved');
   assert.match(imported, /Always run the full test suite/, 'multi-line instructions are preserved');
   assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /docs\/boot-profile\.md/);
});

test('init refuses to write through a symlinked context root that escapes the dir', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   // The context root `docs/` is a symlink to a real directory outside `dir`.
   fs.symlinkSync(outside, path.join(dir, 'docs'), 'dir');

   await assert.rejects(() => initLayer({ dir, yes: true }), /escapes the target/);

   // Nothing leaked into the outside directory through the escaping symlink.
   assert.deepEqual(fs.readdirSync(outside), [], 'no files written outside the target');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('adopt --wire-adapters refuses to overwrite a symlinked-outside vendor file', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const secretPath = path.join(outside, 'secret.txt');
   fs.writeFileSync(secretPath, 'OUTSIDE SECRET CONTENT\n');
   // CLAUDE.md is a symlink pointing at a file outside the repository.
   fs.symlinkSync(secretPath, path.join(dir, 'CLAUDE.md'));

   await adoptLayer({ dir, yes: true, wireAdapters: true });

   // The outside file is untouched and CLAUDE.md still points out (not overwritten).
   assert.equal(fs.readFileSync(secretPath, 'utf8'), 'OUTSIDE SECRET CONTENT\n');
   assert.ok(fs.lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), 'the symlink was not replaced');
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('adopt does not migrate a symlinked-outside vendor file', async () => {
   const dir = tmpdir();
   const outside = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const secretPath = path.join(outside, 'secret.txt');
   fs.writeFileSync(secretPath, 'TOP SECRET DO NOT MIGRATE\n');
   fs.symlinkSync(secretPath, path.join(dir, 'CLAUDE.md'));

   const res = await adoptLayer({ dir, yes: true });

   assert.ok(!res.migrated.includes('CLAUDE.md'), 'an escaping symlink is treated as absent');
   const importedDir = path.join(dir, 'docs', 'governance');
   if (fs.existsSync(importedDir)) {
      for (const f of fs.readdirSync(importedDir)) {
         if (f.startsWith('imported-')) {
            assert.ok(
               !fs.readFileSync(path.join(importedDir, f), 'utf8').includes('TOP SECRET'),
               'the outside secret was never read into an imported doc',
            );
         }
      }
   }
   fs.rmSync(dir, { recursive: true, force: true });
   fs.rmSync(outside, { recursive: true, force: true });
});

test('migrationDoc fences migrated content so raw HTML is shown verbatim', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Instructions.\n<script>alert(1)</script>\n');

   await adoptLayer({ dir, yes: true });

   const imported = fs.readFileSync(path.join(dir, 'docs', 'governance', 'imported-claude.md'), 'utf8');
   assert.match(imported, /```/, 'the migrated content is wrapped in a fenced code block');
   // The script text is present, inside the fence (not as a bare rendered line).
   const fenceMatch = imported.match(/(`{3,})\n([\s\S]*?)\n\1/);
   assert.ok(fenceMatch, 'a fenced code block delimits the imported content');
   assert.ok(fenceMatch![2].includes('<script>alert(1)</script>'), 'the raw script lives inside the fence');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('adopt does not re-migrate a file that is already the canonical redirect', async () => {
   const dir = tmpdir();
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const { adapterContent } = await import('../dist/index.js');
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), adapterContent('docs/boot-profile.md'));
   const res = await adoptLayer({ dir, yes: true, wireAdapters: true });
   assert.ok(!res.migrated.includes('CLAUDE.md'), 'an existing canonical redirect is left alone, not archived');
});

// --- render-function unit coverage (these were only exercised via CLI dispatch) ---

test('renderWritePlan labels every status and summarizes counts', async () => {
   const { renderWritePlan } = await import('../dist/index.js');
   const out = renderWritePlan([
      { rel: 'leji.json', status: 'create' },
      { rel: 'docs/boot-profile.md', status: 'skip-exists' },
      { rel: 'CLAUDE.md', status: 'overwrite', note: 'convert' },
      { rel: 'AGENTS.md', status: 'wont-modify', note: 'read-only' },
   ]);
   assert.match(out, /create .*leji\.json/);
   assert.match(out, /skip .*docs\/boot-profile\.md/);
   assert.match(out, /overwrite .*CLAUDE\.md/);
   assert.match(out, /Will NOT modify/);
   assert.match(out, /AGENTS\.md/);
   assert.match(out, /1 to create, 1 already present.*1 to convert/);
});

test('renderDetect handles the no-hosts case and the ranked case', async () => {
   const { renderDetect } = await import('../dist/index.js');
   assert.match(renderDetect([]), /No coding-agent hosts detected/);
   const ranked = renderDetect([
      {
         id: 'claude-code',
         name: 'Claude Code',
         strength: 'confirmed',
         onPath: true,
         inRepo: false,
         userConfig: false,
         adapter: 'CLAUDE.md',
      },
      {
         id: 'cursor',
         name: 'Cursor',
         strength: 'project-present',
         onPath: false,
         inRepo: true,
         userConfig: false,
         adapter: '.cursor/rules/leji.md',
      },
   ]);
   assert.match(ranked, /confirmed.*Claude Code.*binary on PATH.*CLAUDE\.md/);
   assert.match(ranked, /leji init --agent/);
});

test('renderExplain covers the federated (top) and all-pass branches', async () => {
   const { renderExplain } = await import('../dist/index.js');
   const top = renderExplain({
      claimedLevel: 'federated',
      verifiedLevel: 'federated',
      items: [],
      findings: [],
   });
   assert.match(top, /top conformance level/);
   // verified core, all indexed items pass -> "set conformance.claimedLevel"
   const allPass = renderExplain({
      claimedLevel: 'core',
      verifiedLevel: 'core',
      items: [
         { id: 'index-current', level: 'indexed', description: 'index', status: 'pass' },
         { id: 'changelog', level: 'indexed', description: 'changelog', status: 'pass' },
      ],
      findings: [],
   });
   assert.match(allPass, /all "indexed" checks already pass/);
});

test('validate --content thin-category boundary: 2 bullets warns, 3 does not', async () => {
   const two = tmpdir();
   await initLayer({ dir: two, yes: true });
   fs.writeFileSync(
      path.join(two, 'docs', 'domain', 'glossary.md'),
      '# Glossary\n\n- Real term one.\n- Real term two.\n',
   );
   assert.ok(
      validateLayer(two, { content: true }).findings.some(
         (f) => f.rule === 'content-thin' && f.path === 'docs/domain/',
      ),
      'two concrete bullets is still thin',
   );

   const three = tmpdir();
   await initLayer({ dir: three, yes: true });
   fs.writeFileSync(path.join(three, 'docs', 'domain', 'glossary.md'), '# Glossary\n\n- One.\n- Two.\n- Three.\n');
   assert.ok(
      !validateLayer(three, { content: true }).findings.some(
         (f) => f.rule === 'content-thin' && f.path === 'docs/domain/',
      ),
      'three concrete bullets clears the thin threshold',
   );
});

test('validate --content flags an angle-bracket placeholder, not just TODO', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   fs.writeFileSync(
      path.join(dir, 'docs', 'system', 'invariants.md'),
      '# Invariants\n\n- <describe an invariant here>\n',
   );
   const placeholders = validateLayer(dir, { content: true }).findings.filter((f) => f.rule === 'content-placeholder');
   assert.ok(placeholders.some((f) => f.path === 'docs/system/invariants.md'));
});

test('detectHosts requires an executable bit on POSIX (non-executable file is not confirmed)', () => {
   const root = tmpdir();
   const binDir = tmpdir();
   fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\n', { mode: 0o755 }); // executable
   fs.writeFileSync(path.join(binDir, 'codex'), 'plain text\n', { mode: 0o644 }); // NOT executable
   const home = tmpdir();
   const hosts = detectHosts({ root, env: { PATH: binDir }, homedir: home, platform: 'linux' });
   const claude = hosts.find((h) => h.id === 'claude-code');
   const codex = hosts.find((h) => h.id === 'codex');
   assert.equal(claude?.onPath, true, 'executable claude is confirmed on PATH');
   // codex has no executable on PATH and no repo/user signal, so it is absent.
   assert.equal(codex, undefined, 'a non-executable file named codex is not a confirmed host');
});

test('validate --content flags unconfirmed inferences and proposed decisions', async () => {
   const dir = tmpdir();
   await initLayer({ dir, yes: true });
   // An agent-drafted, owner-unconfirmed invariant marker.
   fs.writeFileSync(
      path.join(dir, 'docs', 'system', 'invariants.md'),
      '# System Invariants\n\n- TODO(confirm-invariant): money is integer minor units\n',
   );
   // An agent-proposed decision, not yet owner-accepted.
   fs.writeFileSync(
      path.join(dir, 'docs', 'decisions', '0002-proposed.md'),
      '---\nid: use-postgres\ntitle: Use Postgres\nstatus: proposed\ndate: 2026-06-18\n---\n\n# Use Postgres\n\n## Context\nx\n## Decision\ny\n## Consequences\nz\n',
   );
   const result = validateLayer(dir, { content: true });
   const unconfirmed = result.findings.filter((f) => f.rule === 'content-unconfirmed');
   assert.ok(
      unconfirmed.some((f) => f.path === 'docs/system/invariants.md'),
      'flags the TODO(confirm-…) marker',
   );
   assert.ok(
      unconfirmed.some((f) => /proposed/.test(f.message)),
      'flags the status: proposed decision',
   );
   // Warning-only: an unconfirmed layer is not an error.
   assert.equal(result.findings.filter((f) => f.severity === 'error').length, 0);
   // The TODO(confirm-…) marker must NOT also trip the plain content-placeholder rule.
   assert.ok(!result.findings.some((f) => f.rule === 'content-placeholder' && f.path === 'docs/system/invariants.md'));
});
