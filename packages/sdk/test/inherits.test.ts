import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { generateViewer, loadManifest, resolvedProfilePage, serveViewer, validateLayer } from '../dist/index.js';
import type { Manifest, ScannedProfile } from '../dist/index.js';
import { finding } from '../dist/lib/findings.js';
import { profileInheritanceFindings, resolveAgentProfile, scanProfileSet } from '../dist/lib/layer.js';
import { schemaErrors } from '../dist/lib/schemas.js';

/** Minimal posture a base must supply for a resolved profile to be complete. */
const BASE_POSTURE = { requiredRead: ['docs/boot-profile.md'], mustAskWhen: ['ask'] };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

function copyExample(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-inh-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   return dir;
}

/** Write an agent profile into a copied example layer. */
function writeProfile(dir: string, name: string, frontmatter: string, body = `\n# ${name}\n`): void {
   fs.writeFileSync(path.join(dir, 'docs', 'agents', `${name}.md`), `---\n${frontmatter}---\n${body}`);
}

/** Write a profile OUTSIDE the declared agentProfilesPath and return its rel. */
function writeOutOfDirProfile(dir: string, name: string, frontmatter: string, body = `\n# ${name}\n`): string {
   fs.mkdirSync(path.join(dir, 'docs', 'roles'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'roles', `${name}.md`), `---\n${frontmatter}---\n${body}`);
   return `docs/roles/${name}.md`;
}

/** Bind a role to a profile path in a copied example's manifest. */
function bindAgent(dir: string, role: string, rel: string): void {
   const manifestPath = path.join(dir, 'leji.json');
   const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   manifest.agents = { ...(manifest.agents ?? {}), [role]: rel };
   fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/** Frontmatter lines every valid profile in these fixtures carries. */
const POSTURE_YAML = 'requiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n';

const profile = (relPath: string, frontmatter: Record<string, unknown> | null, body = ''): ScannedProfile => ({
   relPath,
   frontmatter,
   body,
   findings: [],
});

// --- resolution: composition ---

test('resolve: posture unions base-first in authored order, dropping derived duplicates', () => {
   const base = profile('docs/agents/core.md', {
      id: 'core',
      name: 'Core',
      role: 'core',
      requiredRead: ['docs/boot-profile.md', 'docs/system/invariants.md'],
      mustAskWhen: ['b-first', 'b-second'],
      defaultContext: ['system'],
   });
   const derived = profile('docs/agents/reviewer.md', {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      inherits: 'core',
      // 'docs/boot-profile.md' repeats the base; 'zzz' sorts last but is authored first.
      requiredRead: ['zzz.md', 'docs/boot-profile.md', 'aaa.md'],
      mustAskWhen: ['d-only', 'b-second'],
      defaultContext: ['decisions', 'system'],
      mustRefuseWhen: ['refuse-this'],
   });
   const r = resolveAgentProfile(derived, [base, derived]);
   assert.deepEqual(r.findings, []);
   assert.deepEqual(r.sourceIds, ['core', 'reviewer']);
   assert.deepEqual(r.frontmatter!.requiredRead, [
      'docs/boot-profile.md',
      'docs/system/invariants.md',
      'zzz.md',
      'aaa.md',
   ]);
   assert.deepEqual(r.frontmatter!.mustAskWhen, ['b-first', 'b-second', 'd-only']);
   assert.deepEqual(r.frontmatter!.defaultContext, ['system', 'decisions']);
   // No cross-array dedup: the reader rule handles ask/refuse overlap, not resolution.
   assert.deepEqual(r.frontmatter!.mustRefuseWhen, ['refuse-this']);
});

test('resolve: every non-posture field is derived-local, and inherits is not effective frontmatter', () => {
   const base = profile('docs/agents/core.md', {
      id: 'core',
      name: 'Core',
      role: 'core',
      purpose: 'base purpose',
      version: '1.0',
      host: 'codex',
      invocation: { command: 'codex exec <prompt>' },
      escalation: 'base escalation',
      owners: ['base-owner'],
      freshness: { reviewAfter: '2030-01-01' },
      requiredRead: ['docs/boot-profile.md'],
      mustAskWhen: ['ask'],
   });
   const derived = profile('docs/agents/reviewer.md', {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      inherits: 'core',
   });
   const fm = resolveAgentProfile(derived, [base, derived]).frontmatter!;
   assert.equal(fm.inherits, undefined);
   for (const key of ['purpose', 'version', 'host', 'invocation', 'escalation', 'owners', 'freshness']) {
      assert.equal(fm[key], undefined, `${key} must never be inherited`);
   }
   assert.deepEqual([fm.id, fm.name, fm.role], ['reviewer', 'Reviewer', 'reviewer']);
   // Posture the derived profile omits entirely still comes from the base.
   assert.deepEqual(fm.requiredRead, ['docs/boot-profile.md']);
   assert.deepEqual(fm.mustAskWhen, ['ask']);
});

test('resolve: both bodies are operative, base first, behind source markers', () => {
   const base = profile(
      'docs/agents/core.md',
      { id: 'core', name: 'Core', role: 'core', ...BASE_POSTURE },
      '\n# Core\n\nBase text.\r\n',
   );
   const derived = profile(
      'docs/agents/reviewer.md',
      { id: 'reviewer', name: 'Reviewer', role: 'reviewer', inherits: 'core' },
      '\n# Reviewer\n\nDerived text.\n',
   );
   const body = resolveAgentProfile(derived, [base, derived]).body!;
   assert.equal(
      body,
      '<!-- inherited from: core -->\n\n# Core\n\nBase text.\n\n<!-- reviewer -->\n\n# Reviewer\n\nDerived text.\n',
   );
   assert.ok(!body.includes('\r'), 'LF endings only');
   assert.ok(body.endsWith('\n') && !body.endsWith('\n\n'), 'exactly one trailing newline');
});

test('resolve: composition alters neither body, only line endings and the file boundary', () => {
   // A leading indented code block and a trailing hard break are both body-significant
   // markdown that a trim() would destroy.
   const base = profile(
      'docs/agents/core.md',
      { id: 'core', name: 'Core', role: 'core', ...BASE_POSTURE },
      '\n    indented code\n\n> quoted\r\n\ttabbed\n',
   );
   const derived = profile(
      'docs/agents/reviewer.md',
      { id: 'reviewer', name: 'Reviewer', role: 'reviewer', inherits: 'core' },
      '\nline with a hard break  \n\n\n',
   );
   const body = resolveAgentProfile(derived, [base, derived]).body!;
   assert.ok(body.includes('<!-- inherited from: core -->\n\n    indented code\n'), JSON.stringify(body));
   assert.ok(body.includes('\n\ttabbed\n'), 'a tab-indented line survives');
   assert.ok(body.includes('> quoted\n') && !body.includes('\r'), 'CRLF inside a body becomes LF');
   assert.ok(body.endsWith('line with a hard break  \n'), JSON.stringify(body));
});

test('resolve: duplicates within one authored array survive; only cross-edge repeats drop', () => {
   const base = profile('docs/agents/core.md', {
      id: 'core',
      name: 'Core',
      role: 'core',
      requiredRead: ['a.md', 'a.md'],
      mustAskWhen: ['ask', 'ask'],
   });
   const derived = profile('docs/agents/reviewer.md', {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      inherits: 'core',
      requiredRead: ['b.md', 'b.md', 'a.md'],
      mustAskWhen: ['own', 'own'],
   });
   const fm = resolveAgentProfile(derived, [base, derived]).frontmatter!;
   // First-occurrence dedup applies across the edge only: the base's own repeat and
   // the derived profile's own repeat are authored intent and stay.
   assert.deepEqual(fm.requiredRead, ['a.md', 'a.md', 'b.md', 'b.md']);
   assert.deepEqual(fm.mustAskWhen, ['ask', 'ask', 'own', 'own']);
});

test('resolve: a profile with no inherits resolves to itself', () => {
   const solo = profile('docs/agents/core.md', { id: 'core', name: 'Core', role: 'core' }, '\n# Core\n');
   const r = resolveAgentProfile(solo, [solo]);
   assert.deepEqual(r.findings, []);
   assert.deepEqual(r.sourceIds, ['core']);
   assert.equal(r.body, '# Core\n');
});

// --- resolution: the four error findings ---

test('resolve: an unresolvable inheritance yields findings and no partial profile', () => {
   const core = profile('docs/agents/core.md', { id: 'core', name: 'Core', role: 'core' });
   const other = profile('docs/agents/other.md', { id: 'other', name: 'Other', role: 'other' });
   const dupe = profile('docs/agents/dupe.md', { id: 'core', name: 'Dupe', role: 'core' });

   const cases: { name: string; derived: ScannedProfile; set: ScannedProfile[]; rule: string }[] = [
      {
         name: 'unknown target',
         derived: profile('docs/agents/a.md', { id: 'a', name: 'A', role: 'a', inherits: 'ghost' }),
         set: [core],
         rule: 'inherits-unknown',
      },
      {
         name: 'ambiguous target',
         derived: profile('docs/agents/b.md', { id: 'b', name: 'B', role: 'b', inherits: 'core' }),
         set: [core, dupe],
         rule: 'inherits-ambiguous-target',
      },
      {
         name: 'target is not core',
         derived: profile('docs/agents/c.md', { id: 'c', name: 'C', role: 'c', inherits: 'other' }),
         set: [other],
         rule: 'inherits-target-not-core',
      },
      {
         name: 'self-reference by a non-core profile',
         derived: profile('docs/agents/d.md', { id: 'd', name: 'D', role: 'd', inherits: 'd' }),
         set: [],
         rule: 'inherits-target-not-core',
      },
      {
         name: 'core declares inherits',
         derived: profile('docs/agents/e.md', { id: 'e', name: 'E', role: 'core', inherits: 'core' }),
         set: [core],
         rule: 'inherits-on-core',
      },
      {
         name: 'core inherits itself',
         derived: profile('docs/agents/f.md', { id: 'f', name: 'F', role: 'core', inherits: 'f' }),
         set: [],
         rule: 'inherits-on-core',
      },
      {
         // Without this rule a derived profile would resolve through an inheriting
         // core and get an effective profile the single-level rule forbids.
         name: 'the base itself declares inherits',
         derived: profile('docs/agents/g.md', { id: 'g', name: 'G', role: 'g', inherits: 'core' }),
         set: [
            profile('docs/agents/grand.md', { id: 'grand', name: 'Grand', role: 'core', ...BASE_POSTURE }),
            profile('docs/agents/core.md', {
               id: 'core',
               name: 'Core',
               role: 'core',
               inherits: 'grand',
               ...BASE_POSTURE,
            }),
         ],
         rule: 'inherits-on-core',
      },
   ];

   for (const c of cases) {
      const r = resolveAgentProfile(c.derived, [...c.set, c.derived]);
      assert.equal(r.findings.length, 1, c.name);
      assert.equal(r.findings[0].rule, c.rule, c.name);
      assert.equal(r.findings[0].severity, 'error', c.name);
      assert.equal(r.findings[0].path, c.derived.relPath, c.name);
      // No partial effective profile survives a resolution error.
      assert.equal(r.frontmatter, null, c.name);
      assert.equal(r.body, null, c.name);
      assert.deepEqual(r.sourceIds, [], c.name);
   }
});

test('validate: each resolution error surfaces on the profile scan', () => {
   for (const [name, frontmatter, rule] of [
      ['ghost', 'id: ghosted\nname: G\nrole: g\ninherits: ghost\n', 'inherits-unknown'],
      ['notcore', 'id: notcore\nname: N\nrole: n\ninherits: thought-partner\n', 'inherits-target-not-core'],
      ['oncore', 'id: oncore\nname: O\nrole: core\ninherits: core\n', 'inherits-on-core'],
   ] as const) {
      const dir = copyExample();
      writeProfile(dir, name, frontmatter);
      const findings = validateLayer(dir).findings.filter((f) => f.path === `docs/agents/${name}.md`);
      assert.ok(
         findings.some((f) => f.rule === rule && f.severity === 'error'),
         `${name}: expected ${rule}, got ${JSON.stringify(findings)}`,
      );
   }
});

test('validate: two profiles declaring the target id are an ambiguous target', () => {
   const dir = copyExample();
   writeProfile(
      dir,
      'core-twin',
      'id: core\nname: Twin\nrole: core\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n',
   );
   const findings = validateLayer(dir).findings;
   assert.ok(
      findings.some(
         (f) =>
            f.rule === 'inherits-ambiguous-target' &&
            f.severity === 'error' &&
            f.path === 'docs/agents/thought-partner.md',
      ),
      JSON.stringify(findings),
   );
});

test('validate: a base that declares inherits breaks every profile that names it', () => {
   const dir = copyExample();
   writeProfile(
      dir,
      'grand',
      'id: grand\nname: Grand\nrole: core\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - always\n',
   );
   // Make the example's core profile inherit, so the single-level rule is violated
   // one hop above the profile that actually uses it.
   const coreRel = path.join(dir, 'docs', 'agents', 'core.md');
   fs.writeFileSync(coreRel, fs.readFileSync(coreRel, 'utf8').replace('role: core\n', 'role: core\ninherits: grand\n'));
   const findings = validateLayer(dir).findings;
   // The base is flagged on its own account...
   assert.ok(
      findings.some((f) => f.rule === 'inherits-on-core' && f.path === 'docs/agents/core.md'),
      JSON.stringify(findings),
   );
   // ...and so is the derived profile that can no longer resolve through it.
   assert.ok(
      findings.some(
         (f) =>
            f.rule === 'inherits-on-core' &&
            f.severity === 'error' &&
            f.path === 'docs/agents/thought-partner.md' &&
            /itself declares inherits/.test(f.message),
      ),
      JSON.stringify(findings),
   );
});

// --- resolution: source findings and the effective result ---

test('resolve: an error finding on either source refuses resolution and carries forward', () => {
   const schemaError = finding('profile-frontmatter', 'error', '/requiredRead must NOT have fewer than 1 items');
   const okBase = profile('docs/agents/core.md', { id: 'core', name: 'Core', role: 'core', ...BASE_POSTURE });
   const okDerived = profile('docs/agents/reviewer.md', {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      inherits: 'core',
   });

   for (const [name, base, derived] of [
      ['the base is invalid', { ...okBase, findings: [schemaError] }, okDerived],
      ['the derived profile is invalid', okBase, { ...okDerived, findings: [schemaError] }],
   ] as const) {
      const r = resolveAgentProfile(derived, [base, derived]);
      assert.deepEqual(r.findings, [schemaError], name);
      assert.equal(r.frontmatter, null, name);
      assert.equal(r.body, null, name);
      assert.deepEqual(r.sourceIds, [], name);
   }

   // A validator that already reported the scan's findings does not see them twice.
   const base = { ...okBase, findings: [schemaError] };
   assert.deepEqual(profileInheritanceFindings([base, okDerived]), []);
});

test('resolve: an effective profile still missing requiredRead or mustAskWhen is refused', () => {
   for (const [missing, basePosture] of [
      ['requiredRead', { mustAskWhen: ['ask'] }],
      ['mustAskWhen', { requiredRead: ['docs/boot-profile.md'] }],
   ] as const) {
      const base = profile('docs/agents/core.md', { id: 'core', name: 'Core', role: 'core', ...basePosture });
      const derived = profile('docs/agents/reviewer.md', {
         id: 'reviewer',
         name: 'Reviewer',
         role: 'reviewer',
         inherits: 'core',
      });
      const r = resolveAgentProfile(derived, [base, derived]);
      assert.equal(r.findings.length, 1, missing);
      assert.equal(r.findings[0].rule, 'profile-frontmatter', missing);
      assert.match(r.findings[0].message, new RegExp(`no ${missing}`), missing);
      assert.equal(r.frontmatter, null, missing);
      assert.equal(r.body, null, missing);
   }
});

test('resolve: an id that is not identifier-shaped never reaches the body markers', () => {
   const injected = 'x --> <script>alert(1)</script> <!-- y';
   const okBase = profile('docs/agents/core.md', { id: 'core', name: 'Core', role: 'core', ...BASE_POSTURE });

   const badDerived = profile('docs/agents/evil.md', {
      id: injected,
      name: 'Evil',
      role: 'evil',
      inherits: 'core',
   });
   const fromDerived = resolveAgentProfile(badDerived, [okBase, badDerived]);
   assert.equal(fromDerived.body, null);
   assert.equal(fromDerived.findings[0].rule, 'profile-frontmatter');
   assert.equal(fromDerived.findings[0].path, 'docs/agents/evil.md');

   const badBase = profile('docs/agents/core.md', { id: injected, name: 'Core', role: 'core', ...BASE_POSTURE });
   const derived = profile('docs/agents/reviewer.md', {
      id: 'reviewer',
      name: 'Reviewer',
      role: 'reviewer',
      inherits: injected,
   });
   const fromBase = resolveAgentProfile(derived, [badBase, derived]);
   assert.equal(fromBase.body, null);
   assert.equal(fromBase.findings[0].rule, 'profile-frontmatter');
   assert.equal(fromBase.findings[0].path, 'docs/agents/core.md');
});

// --- the profile set: agents-bound profiles outside agentProfilesPath ---

test('profile set: an out-of-directory profile is validated like a directory one', () => {
   const dir = copyExample();
   const rel = writeOutOfDirProfile(dir, 'outbase', `id: outbase\nname: Out\nrole: core\nhost: 5\n${POSTURE_YAML}`);
   bindAgent(dir, 'outbase', rel);
   const { manifest } = loadManifest(dir);
   const base = scanProfileSet(dir, manifest!).find((p) => p.relPath === rel)!;
   assert.ok(base, 'the bound out-of-directory profile joins the set');
   assert.ok(
      base.findings.some((f) => f.rule === 'profile-frontmatter' && f.severity === 'error' && /host/.test(f.message)),
      JSON.stringify(base.findings),
   );
});

test('resolve: an invalid out-of-directory base refuses resolution and carries its finding', () => {
   const dir = copyExample();
   const rel = writeOutOfDirProfile(dir, 'outbase', `id: outbase\nname: Out\nrole: core\nhost: 5\n${POSTURE_YAML}`);
   bindAgent(dir, 'outbase', rel);
   writeProfile(dir, 'derived', 'id: derived\nname: D\nrole: d\ninherits: outbase\n');
   const { manifest } = loadManifest(dir);
   const profiles = scanProfileSet(dir, manifest!);
   const base = profiles.find((p) => p.relPath === rel)!;
   const derived = profiles.find((p) => p.relPath === 'docs/agents/derived.md')!;
   const r = resolveAgentProfile(derived, profiles);
   assert.equal(r.frontmatter, null, 'no effective profile is composed from an invalid base');
   assert.equal(r.body, null);
   assert.deepEqual(r.sourceIds, []);
   assert.deepEqual(r.findings, base.findings);
});

test('resolve: an invalid out-of-directory derived profile refuses resolution', () => {
   const dir = copyExample();
   const rel = writeOutOfDirProfile(
      dir,
      'outderived',
      'id: outderived\nname: Out\nrole: out\ninherits: core\nhost: 5\n',
   );
   bindAgent(dir, 'outderived', rel);
   const { manifest } = loadManifest(dir);
   const profiles = scanProfileSet(dir, manifest!);
   const derived = profiles.find((p) => p.relPath === rel)!;
   assert.ok(derived.findings.length > 0, 'it carries its own schema findings');
   const r = resolveAgentProfile(derived, profiles);
   assert.equal(r.frontmatter, null);
   assert.equal(r.body, null);
   assert.deepEqual(r.findings, derived.findings);
});

test('resolve: a valid out-of-directory base still resolves', () => {
   const dir = copyExample();
   const rel = writeOutOfDirProfile(
      dir,
      'outbase',
      `id: outbase\nname: Out\nrole: core\n${POSTURE_YAML}`,
      '\nBASE PROSE\n',
   );
   bindAgent(dir, 'outbase', rel);
   writeProfile(dir, 'derived', 'id: derived\nname: D\nrole: d\ninherits: outbase\n', '\nDERIVED PROSE\n');
   const { manifest } = loadManifest(dir);
   const profiles = scanProfileSet(dir, manifest!);
   const derived = profiles.find((p) => p.relPath === 'docs/agents/derived.md')!;
   const r = resolveAgentProfile(derived, profiles);
   assert.deepEqual(r.findings, []);
   assert.deepEqual(r.sourceIds, ['outbase', 'derived']);
   assert.deepEqual(r.frontmatter!.requiredRead, ['docs/boot-profile.md']);
   assert.ok(r.body!.includes('BASE PROSE') && r.body!.includes('DERIVED PROSE'), r.body!);
});

test('validate: an invalid out-of-directory profile is reported once, not twice', () => {
   const dir = copyExample();
   const rel = writeOutOfDirProfile(dir, 'outbase', `id: outbase\nname: Out\nrole: core\nhost: 5\n${POSTURE_YAML}`);
   bindAgent(dir, 'outbase', rel);
   writeProfile(dir, 'derived', 'id: derived\nname: D\nrole: d\ninherits: outbase\n');
   const findings = validateLayer(dir).findings;
   assert.ok(
      findings.some((f) => f.path === rel && f.rule === 'profile-frontmatter' && f.severity === 'error'),
      JSON.stringify(findings),
   );
   // The agents-map check and resolution both validate this file; their findings
   // are byte-identical, so the pair collapses instead of double-reporting.
   const keys = findings.map((f) => `${f.path ?? ''}|${f.rule}|${f.severity}|${f.message}`);
   const repeated = keys.filter((k, i) => keys.indexOf(k) !== i);
   assert.deepEqual(repeated, [], `duplicated findings: ${JSON.stringify(repeated)}`);
});

// --- schema: the conditional requirement ---

test('schema: requiredRead and mustAskWhen are required only without inherits', () => {
   const withoutInherits = { id: 'a', name: 'A', role: 'a' };
   assert.ok(schemaErrors('agent-profile', withoutInherits).length > 0);
   assert.deepEqual(schemaErrors('agent-profile', { ...withoutInherits, inherits: 'core' }), []);
   assert.deepEqual(
      schemaErrors('agent-profile', { ...withoutInherits, requiredRead: ['docs/x.md'], mustAskWhen: ['ask'] }),
      [],
   );
});

test('schema: an explicitly empty posture array stays invalid, with or without inherits', () => {
   const base = { id: 'a', name: 'A', role: 'a', inherits: 'core' };
   assert.ok(schemaErrors('agent-profile', { ...base, requiredRead: [] }).length > 0);
   assert.ok(schemaErrors('agent-profile', { ...base, mustAskWhen: [] }).length > 0);
});

test('validate: a profile omitting both arrays under inherits validates', () => {
   const dir = copyExample();
   writeProfile(dir, 'lean', 'id: lean\nname: Lean\nrole: lean\ninherits: core\n');
   const findings = validateLayer(dir).findings.filter((f) => f.path === 'docs/agents/lean.md');
   assert.deepEqual(findings, []);
});

test('validate: an explicitly empty array under inherits is still rejected', () => {
   const dir = copyExample();
   writeProfile(dir, 'empty', 'id: empty\nname: Empty\nrole: empty\ninherits: core\nrequiredRead: []\n');
   const findings = validateLayer(dir).findings.filter((f) => f.path === 'docs/agents/empty.md');
   assert.ok(
      findings.some((f) => f.rule === 'profile-frontmatter' && f.severity === 'error'),
      JSON.stringify(findings),
   );
});

// --- viewer ---

test('viewer: an inheriting profile renders resolved, naming both sources', () => {
   const dir = copyExample();
   const { manifest } = loadManifest(dir);
   const page = resolvedProfilePage(dir, manifest!, 'docs/agents/thought-partner.md');
   assert.ok(page, 'the inheriting profile has a resolved page');
   assert.ok(page!.includes('<!-- inherited from: core -->'), 'base marker is kept');
   assert.ok(page!.includes('<!-- thought-partner -->'), 'derived marker is kept');
   assert.ok(page!.includes('docs/agents/core.md'), 'the base source is named');
   assert.ok(page!.includes('docs/agents/thought-partner.md'), 'the derived source is named');
   // Posture entries are labelled with the profile that supplied them.
   assert.ok(page!.includes('`docs/system/invariants.md` — from `core`'), page!);
   assert.ok(page!.includes('from `thought-partner`'), page!);
   // A profile with no inherits is served from disk as authored.
   assert.equal(resolvedProfilePage(dir, manifest!, 'docs/agents/core.md'), null);
   assert.equal(resolvedProfilePage(dir, manifest!, 'docs/domain/glossary.md'), null);
});

test('viewer: an unresolvable profile shows its findings, never the derived file', () => {
   const dir = copyExample();
   writeProfile(dir, 'broken', 'id: broken\nname: Broken\nrole: broken\ninherits: ghost\n', '\nDERIVED BODY MARKER\n');
   const { manifest } = loadManifest(dir);
   const page = resolvedProfilePage(dir, manifest!, 'docs/agents/broken.md')!;
   assert.ok(page.includes('does not resolve'), page);
   assert.ok(page.includes('inherits-unknown'), page);
   assert.ok(!page.includes('DERIVED BODY MARKER'), 'the derived file is not presented as effective');
});

test('viewer: a resolution that throws still refuses to hand back the derived file', () => {
   const dir = copyExample();
   writeProfile(dir, 'broken', 'id: broken\nname: Broken\nrole: broken\ninherits: core\n', '\nDERIVED BODY MARKER\n');
   // Binds the file (so it classifies as a profile) but makes the profile scan
   // throw: the branch that must never fall through to the file on disk.
   const hostile = { rootPath: 5, agents: { x: 'docs/agents/broken.md' } } as unknown as Manifest;
   const page = resolvedProfilePage(dir, hostile, 'docs/agents/broken.md');
   assert.ok(page, 'a committed profile always gets a page, never null');
   assert.ok(page!.includes('unresolved profile'), page!);
   assert.ok(!page!.includes('DERIVED BODY MARKER'), 'the derived file is not served on failure');
   // A document that is not half a profile is still handed back to the file on disk.
   assert.equal(resolvedProfilePage(dir, hostile, 'docs/domain/glossary.md'), null);
});

test('viewer serve: the HTTP route never serves an unresolvable profile as authored', async () => {
   const dir = copyExample();
   writeProfile(dir, 'broken', 'id: broken\nname: Broken\nrole: broken\ninherits: ghost\n', '\nDERIVED BODY MARKER\n');
   const { manifest } = loadManifest(dir);
   generateViewer(dir, manifest!);
   const server = await serveViewer(dir, 0, manifest!.rootPath);
   try {
      const port = (server.address() as AddressInfo).port;
      const get = async (p: string) => {
         const res = await fetch(`http://127.0.0.1:${port}${p}`);
         return { status: res.status, text: await res.text() };
      };
      const broken = await get('/content/agents/broken.md');
      assert.equal(broken.status, 200);
      assert.ok(!broken.text.includes('DERIVED BODY MARKER'), broken.text);
      assert.ok(broken.text.includes('inherits-unknown'), broken.text);

      // The resolved and the untouched cases still behave.
      const resolved = await get('/content/agents/thought-partner.md');
      assert.ok(resolved.text.includes('resolved profile'), resolved.text);
      const core = await get('/content/agents/core.md');
      assert.ok(core.text.startsWith('---'), 'a profile that inherits nothing is served from disk');
   } finally {
      server.close();
   }
});

// --- live evidence: this repository's own profiles ---

test("this layer's own inheriting profiles resolve cleanly", () => {
   const { manifest } = loadManifest(repoRoot);
   const profiles = scanProfileSet(repoRoot, manifest!);
   const inheriting = profiles.filter((p) => typeof p.frontmatter?.inherits === 'string');
   assert.ok(
      inheriting.some((p) => p.relPath === 'docs/agents/reviewer.md'),
      'docs/agents/reviewer.md declares inherits',
   );
   for (const p of inheriting) {
      const r = resolveAgentProfile(p, profiles);
      assert.deepEqual(r.findings, [], p.relPath);
      assert.equal(r.sourceIds[0], 'core', p.relPath);
      assert.ok(Array.isArray(r.frontmatter!.requiredRead), p.relPath);
      assert.ok(r.body!.startsWith('<!-- inherited from: core -->'), p.relPath);
   }
});
