import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type ConformanceLevel, badgeMarkdown, badgeRun, renderBadge } from '../dist/index.js';
import { snapshotTree } from './helpers/snapshot.ts';

// Two halves of one contract. First the constants: every level rendered and
// byte-compared against `fixtures/badge/`, the sole oracle, plus the `--out`
// acceptance table and the existing-file rule over temp trees. Then the shared
// fixtures' `badge` blocks, driven through the real CLI as a process.

const execFileAsync = promisify(execFile);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const goldenDir = path.join(fixturesDir, 'badge');
const cli = path.join(pkgRoot, 'dist', 'cli.js');

const LEVELS: readonly ConformanceLevel[] = ['core', 'indexed', 'governed', 'federated'];

// --- the canonical bytes ------------------------------------------------------

test('every level renders the canonical badge byte for byte', () => {
   for (const level of LEVELS) {
      assert.equal(
         renderBadge(level),
         fs.readFileSync(path.join(goldenDir, `${level}.svg`), 'utf8'),
         `${level}.svg differs from the golden`,
      );
      assert.equal(
         badgeMarkdown(level, 'leji-badge.svg'),
         fs.readFileSync(path.join(goldenDir, `${level}.md`), 'utf8'),
         `${level}.md differs from the golden`,
      );
   }
});

test('the claim is structural: absent from the badge face, present in title, aria-label and alt', () => {
   for (const level of LEVELS) {
      const claim = `Leji 1.0 · ${level} · self-attested`;
      // The markdown fixture — the alt text an adopter pastes into a README — carries
      // the whole claim, which is what lets the face drop it.
      const md = fs.readFileSync(path.join(goldenDir, `${level}.md`), 'utf8');
      assert.ok(md.includes(`[![${claim}]`), `${level}.md must carry the full alt claim`);

      const svg = fs.readFileSync(path.join(goldenDir, `${level}.svg`), 'utf8');
      assert.ok(svg.includes(`<title>${claim}</title>`), `${level}.svg <title> must carry the claim`);
      assert.ok(svg.includes(`aria-label="${claim}"`), `${level}.svg aria-label must carry the claim`);

      // The visible segment is the level alone: the two `<text>` bodies are the
      // wordmark and the level, and `self-attested` appears nowhere a renderer draws.
      const drawn = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      assert.deepEqual(drawn, ['Leji 1.0', level], `${level}.svg draws the wordmark and the level, and nothing else`);
   }
});

test('the markdown carries the canonical --out value, not the default', () => {
   assert.equal(
      badgeMarkdown('governed', 'docs/badge.svg'),
      '[![Leji 1.0 · governed · self-attested](docs/badge.svg)](https://leji.org/agent-ready/)\n',
   );
});

// --- the `--out` acceptance rule ----------------------------------------------

/** A committed working copy of a fixture: the level a badge states needs a git
 * baseline, since the `indexed` changelog item is `unknown` until the changelog is
 * in HEAD (`fixtures/README.md` -> "The `badge` block"). */
function committedFixture(name: string): string {
   const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-badge-')));
   fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
   const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_DIR: undefined }, stdio: 'ignore' });
   };
   git('init', '-q');
   git('add', '-A');
   git('-c', 'user.name=Badge Test', '-c', 'user.email=badge@example.com', 'commit', '-q', '-m', 'seed');
   return dir;
}

test('--out accepts a repository-relative POSIX .svg path and rejects everything else', () => {
   const dir = committedFixture('valid-badge-governed');
   try {
      // Accepted, with the canonical POSIX form echoed back: a `.` segment is
      // dropped, and a nested target has its parent directories created.
      for (const [given, canonical] of [
         ['leji-badge.svg', 'leji-badge.svg'],
         ['./badge.svg', 'badge.svg'],
         ['docs/badge.svg', 'docs/badge.svg'],
         ['a/b/c-1_2.svg', 'a/b/c-1_2.svg'],
      ] as const) {
         const r = badgeRun(dir, given);
         assert.equal(r.usageError, undefined, `${given} must be accepted`);
         assert.equal(r.out, canonical, `${given} canonicalizes to ${canonical}`);
         assert.ok(fs.existsSync(path.join(dir, ...canonical.split('/'))), `${canonical} was written`);
      }
      // Rejected at argument parsing, before conformance runs: no level is reported
      // at all, and nothing is written.
      for (const bad of [
         '/abs.svg',
         '../x.svg',
         'docs/../x.svg',
         'a\\b.svg',
         'x.png',
         'x.svg ',
         'a//b.svg',
         'doc s/x.svg',
         'x.svg#frag',
         '.leji/x.svg',
         '.leji/dist/x.svg',
         '.leji/a/b/x.svg',
      ]) {
         const r = badgeRun(dir, bad);
         assert.ok(r.usageError !== undefined, `${bad} must be rejected`);
         assert.equal(r.out, null);
         assert.equal(r.level, null);
         assert.equal(r.claimedLevel, null, `${bad} reports no level`);
         assert.equal(r.verifiedLevel, null, `${bad} reports no level`);
      }
      // A directory at the target is a rejection too, and the directory survives it.
      fs.mkdirSync(path.join(dir, 'adir.svg'));
      assert.ok(badgeRun(dir, 'adir.svg').usageError !== undefined, 'a directory is never a badge target');
      assert.ok(fs.statSync(path.join(dir, 'adir.svg')).isDirectory());
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// --- the existing-file rule ---------------------------------------------------

test('the target file decides the action, by its bytes and nothing else', () => {
   const dir = committedFixture('valid-badge-governed');
   const target = path.join(dir, 'leji-badge.svg');
   try {
      // Absent: written.
      assert.equal(badgeRun(dir).action, 'wrote');
      assert.equal(fs.readFileSync(target, 'utf8'), renderBadge('governed'));

      // These exact bytes: unchanged, and not rewritten (the mtime stands).
      const before = fs.statSync(target).mtimeMs;
      assert.equal(badgeRun(dir).action, 'unchanged');
      assert.equal(fs.statSync(target).mtimeMs, before, 'an unchanged target is never rewritten');

      // Another canonical badge of this contract: overwritten, which is how a level
      // change regenerates. All three of the others, not just the neighbouring one.
      for (const level of LEVELS.filter((l) => l !== 'governed')) {
         fs.writeFileSync(target, renderBadge(level));
         assert.equal(badgeRun(dir).action, 'overwrote', `a stale ${level} badge regenerates`);
         assert.equal(fs.readFileSync(target, 'utf8'), renderBadge('governed'));
      }

      // Anything else: refused, exit 2's message, the file untouched and never
      // truncated. The levels are still reported, the rule running after conformance.
      const foreign = '<svg><!-- somebody elses file --></svg>\n';
      fs.writeFileSync(target, foreign);
      const r = badgeRun(dir);
      assert.equal(r.refusal, 'leji-badge.svg exists and is not a leji badge; remove or rename it');
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.equal(r.claimedLevel, 'governed');
      assert.equal(r.verifiedLevel, 'governed');
      assert.equal(fs.readFileSync(target, 'utf8'), foreign, 'a refusal never edits and never truncates');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a nested --out creates its parent directories only when the write happens', () => {
   const dir = committedFixture('valid-records'); // claims core, verifies core
   try {
      fs.writeFileSync(path.join(dir, 'leji-badge.svg'), 'not a badge\n');
      assert.ok(badgeRun(dir, 'docs/nested/badge.svg').out !== null);
      assert.ok(fs.existsSync(path.join(dir, 'docs', 'nested', 'badge.svg')));
      // The refusal path writes nothing, so it establishes no directory either.
      assert.ok(badgeRun(dir, 'leji-badge.svg').refusal !== undefined);
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a run that writes nothing establishes no directory on the way to not writing', () => {
   // Exit 1 (a claim this run refutes): the nested target and its parent are both
   // absent afterwards, so the directory is a consequence of the write and not of
   // the attempt.
   const failing = committedFixture('invalid-governed-no-profile');
   try {
      const r = badgeRun(failing, 'pub/x/badge.svg');
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.ok(r.findings.some((f) => f.severity === 'error'));
      assert.ok(!fs.existsSync(path.join(failing, 'pub', 'x', 'badge.svg')), 'the target was never created');
      assert.ok(!fs.existsSync(path.join(failing, 'pub', 'x')), 'the parent was never created');
      assert.ok(!fs.existsSync(path.join(failing, 'pub')), 'nor its parent');
   } finally {
      fs.rmSync(failing, { recursive: true, force: true });
   }

   // Exit 2 (a foreign file at a nested target whose parent already exists): the
   // parent is left exactly as it was and the target's bytes are untouched.
   const dir = committedFixture('valid-badge-governed');
   try {
      const parent = path.join(dir, 'pub');
      fs.mkdirSync(parent);
      fs.writeFileSync(path.join(parent, 'sibling.txt'), 'untouched\n');
      const foreign = 'not a badge\n';
      fs.writeFileSync(path.join(parent, 'badge.svg'), foreign);
      const before = snapshotTree(dir);
      const r = badgeRun(dir, 'pub/badge.svg');
      assert.equal(r.refusal, 'pub/badge.svg exists and is not a leji badge; remove or rename it');
      assert.equal(fs.readFileSync(path.join(parent, 'badge.svg'), 'utf8'), foreign, 'the target is byte-untouched');
      assert.deepEqual(snapshotTree(dir), before, 'the tree is untouched');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// --- containment: the resolved path decides, in both directions -----------------

test('a --out whose parent resolves outside the repository is refused, and reads nothing', () => {
   const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-outside-')));
   const dir = committedFixture('valid-badge-governed');
   try {
      // A file already standing at the escaped location: the run must neither read
      // it (it is not the target the check cleared) nor replace it.
      const planted = 'somebody elses file\n';
      fs.writeFileSync(path.join(outside, 'x.svg'), planted);
      fs.symlinkSync(outside, path.join(dir, 'pub'), 'dir');
      const before = snapshotTree(dir);

      const r = badgeRun(dir, 'pub/x.svg');
      assert.ok(r.usageError !== undefined || r.refusal !== undefined, 'the escape is refused');
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.equal(fs.readFileSync(path.join(outside, 'x.svg'), 'utf8'), planted, 'the outside file is untouched');
      assert.deepEqual(fs.readdirSync(outside).sort(), ['x.svg'], 'nothing was created outside the repository');
      assert.deepEqual(snapshotTree(dir), before, 'and nothing inside it');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
   }
});

test('a --out whose parent resolves into .leji/ is refused, at any depth', () => {
   const dir = committedFixture('valid-badge-governed');
   try {
      fs.mkdirSync(path.join(dir, '.leji', 'dist'), { recursive: true });
      fs.symlinkSync(path.join(dir, '.leji', 'dist'), path.join(dir, 'pub'), 'dir');
      const r = badgeRun(dir, 'pub/x.svg');
      assert.ok(r.usageError !== undefined || r.refusal !== undefined, '.leji/ is never a badge target');
      assert.equal(r.out, null);
      assert.deepEqual(fs.readdirSync(path.join(dir, '.leji', 'dist')), [], 'the private role stays empty');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a --out that is itself a symlink out of the repository is refused, target untouched', () => {
   const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-outside-')));
   const dir = committedFixture('valid-badge-governed');
   try {
      const planted = 'somebody elses file\n';
      const escaped = path.join(outside, 'foreign.svg');
      fs.writeFileSync(escaped, planted);
      fs.symlinkSync(escaped, path.join(dir, 'leji-badge.svg'));

      const r = badgeRun(dir);
      assert.ok(r.usageError !== undefined || r.refusal !== undefined, 'a link out of the repository is refused');
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.equal(fs.readFileSync(escaped, 'utf8'), planted, 'the link target is byte-untouched');
      assert.ok(fs.lstatSync(path.join(dir, 'leji-badge.svg')).isSymbolicLink(), 'the link itself is left alone');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
   }
});

test('a --out that is a dangling symlink inside the repository is refused, nothing created', () => {
   const dir = committedFixture('valid-badge-governed');
   try {
      // The link resolves to a missing file INSIDE the repository, so the resolved
      // destination is absent while the entry at the target path is not. A write
      // would follow the link and create the destination; a standing entry that
      // could not be verified as a badge is a refusal instead.
      fs.symlinkSync('missing-file.svg', path.join(dir, 'leji-badge.svg'));
      const before = snapshotTree(dir);

      const r = badgeRun(dir);
      assert.equal(
         r.refusal,
         'leji-badge.svg does not resolve to a regular file inside the repository; nothing was written',
         'a dangling in-repository link is refused, not written through',
      );
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.deepEqual(
         r.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
         [{ rule: 'badge-target-refused', severity: 'error', path: 'leji-badge.svg' }],
      );
      assert.ok(fs.lstatSync(path.join(dir, 'leji-badge.svg')).isSymbolicLink(), 'the link itself is left alone');
      assert.ok(!fs.existsSync(path.join(dir, 'missing-file.svg')), 'the link destination was never created');
      assert.deepEqual(snapshotTree(dir), before, 'the tree is untouched');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a --out that is a unix socket is refused as a document, not as a crash', async (t) => {
   const dir = committedFixture('valid-badge-governed');
   const target = path.join(dir, 'leji-badge.svg');
   let server: net.Server | null = null;
   try {
      // A socket is the non-regular entry that no earlier check rejects: it is not a
      // directory, and opening it fails with something other than ENOENT. Binding one
      // is not portable, so a platform that cannot is skipped rather than failed.
      try {
         server = await new Promise<net.Server>((resolve, reject) => {
            const s = net.createServer();
            s.once('error', reject);
            s.listen(target, () => resolve(s));
         });
      } catch (e) {
         t.skip(`this platform cannot bind a unix socket at the badge target: ${(e as Error).message}`);
         return;
      }
      assert.ok(fs.lstatSync(target).isSocket(), 'the target is a socket');
      const before = snapshotTree(dir);

      const r = badgeRun(dir);
      assert.equal(
         r.refusal,
         'leji-badge.svg does not resolve to a regular file inside the repository; nothing was written',
         'a socket at the target is refused, in the same words as every other standing entry',
      );
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.deepEqual(
         r.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
         [{ rule: 'badge-target-refused', severity: 'error', path: 'leji-badge.svg' }],
      );
      assert.ok(fs.lstatSync(target).isSocket(), 'the socket itself is left alone');
      assert.deepEqual(snapshotTree(dir), before, 'the tree is untouched');

      // Through the real bin: the refusal is the ordinary badge document at exit 2,
      // which is exactly what the escaping error used to deny this case.
      const cliRun = await runCliProc(['badge', '--root', dir, '--json']);
      assert.equal(cliRun.code, 2, 'the refusal exits 2');
      const doc = JSON.parse(cliRun.stdout) as BadgeDocument;
      assert.deepEqual(Object.keys(doc).sort(), [...DOCUMENT_KEYS].sort(), 'the exact JSON key set');
      assert.equal(doc.command, 'badge');
      assert.equal(doc.ok, false);
      assert.equal(doc.out, null);
      assert.equal(doc.level, null);
      assert.equal(doc.markdown, null);
      assert.equal(doc.action, null);
      assert.deepEqual(
         doc.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
         [{ rule: 'badge-target-refused', severity: 'error', path: 'leji-badge.svg' }],
      );
      assert.deepEqual(doc.summary, { errors: 1, warnings: 0 });
   } finally {
      server?.close();
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a --out symlinked to a unix socket in the repository is refused as a document too', async (t) => {
   const dir = committedFixture('valid-badge-governed');
   const sock = path.join(dir, 'sock');
   const target = path.join(dir, 'leji-badge.svg');
   let server: net.Server | null = null;
   try {
      // The link passes an entry-kind check that stops at the link itself, and the
      // verified open then follows it to the socket and raises before it can fstat.
      // So the kind that decides is the one at the END of the link.
      try {
         server = await new Promise<net.Server>((resolve, reject) => {
            const s = net.createServer();
            s.once('error', reject);
            s.listen(sock, () => resolve(s));
         });
      } catch (e) {
         t.skip(`this platform cannot bind a unix socket in the badge fixture: ${(e as Error).message}`);
         return;
      }
      fs.symlinkSync('sock', target);
      assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the target is a symlink');
      assert.ok(fs.statSync(target).isSocket(), 'and it resolves to the socket');
      const before = snapshotTree(dir);

      const r = badgeRun(dir);
      assert.equal(
         r.refusal,
         'leji-badge.svg does not resolve to a regular file inside the repository; nothing was written',
         'a link to a socket is refused, in the same words as the socket itself',
      );
      assert.equal(r.out, null);
      assert.equal(r.action, null);
      assert.deepEqual(
         r.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
         [{ rule: 'badge-target-refused', severity: 'error', path: 'leji-badge.svg' }],
      );
      assert.ok(fs.lstatSync(target).isSymbolicLink(), 'the link itself is left alone');
      assert.ok(fs.lstatSync(sock).isSocket(), 'and so is the socket it points at');
      assert.deepEqual(snapshotTree(dir), before, 'the tree is untouched');

      // Through the real bin: the ordinary badge document at exit 2, not the generic
      // handler's bare error.
      const cliRun = await runCliProc(['badge', '--root', dir, '--json']);
      assert.equal(cliRun.code, 2, 'the refusal exits 2');
      const doc = JSON.parse(cliRun.stdout) as BadgeDocument;
      assert.deepEqual(Object.keys(doc).sort(), [...DOCUMENT_KEYS].sort(), 'the exact JSON key set');
      assert.equal(doc.command, 'badge');
      assert.equal(doc.ok, false);
      assert.equal(doc.out, null);
      assert.equal(doc.level, null);
      assert.equal(doc.markdown, null);
      assert.equal(doc.action, null);
      assert.deepEqual(
         doc.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
         [{ rule: 'badge-target-refused', severity: 'error', path: 'leji-badge.svg' }],
      );
      assert.deepEqual(doc.summary, { errors: 1, warnings: 0 });
   } finally {
      server?.close();
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// --- the shared fixtures' `badge` blocks --------------------------------------

interface ExpectedBadge {
   args?: string[];
   exit: number;
   out: string | null;
   level: string | null;
   claimedLevel: string | null;
   verifiedLevel: string | null;
   golden: string | null;
   action: string | null;
   written?: boolean;
   preseed?: { path: string; from?: string; bytes?: string };
   rerun?: { action: string; byteIdentical: boolean };
}

interface CliResult {
   code: number;
   stdout: string;
}

/** The real bin, as a process: the exit code is the process's own. */
async function runCliProc(args: string[]): Promise<CliResult> {
   try {
      const { stdout } = await execFileAsync('node', [cli, ...args], { cwd: repoRoot });
      return { code: 0, stdout };
   } catch (e) {
      const err = e as { code?: number; stdout?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '' };
   }
}

/** Exactly the keys `--json` emits, under every outcome: a consumer parses one
 * document whether the run wrote a badge, refuted a claim, or refused a file. */
const DOCUMENT_KEYS = [
   'command',
   'ok',
   'findings',
   'summary',
   'out',
   'level',
   'claimedLevel',
   'verifiedLevel',
   'markdown',
   'action',
];

interface BadgeDocument {
   command: string;
   ok: boolean;
   findings: { rule: string; severity: string; path?: string; message: string }[];
   summary: { errors: number; warnings: number };
   out: string | null;
   level: string | null;
   claimedLevel: string | null;
   verifiedLevel: string | null;
   markdown: string | null;
   action: string | null;
}

/** A finding as `fixtures/README.md` -> "Matching rules" compares one: the triple
 * (rule, severity, path). Message text is implementation-specific and is never
 * compared — everything that identifies the finding is here. */
interface FindingKey {
   rule: string;
   severity: string;
   path?: string;
}

/**
 * The findings and the summary a `badge` block PINS — fixed by the block alone,
 * never read off the document being judged, so a different rule, an extra finding
 * or a missing one fails. Three outcomes exhaust the block: a success reports
 * nothing; an exit-2 refusal names the foreign file it would not overwrite; an
 * exit-1 run reports the conformance error that left nothing honest to state — the
 * claim gate when this run verified a level below the claim, `badge-unverified`
 * when it verified no level at all.
 */
function expectedDocument(
   block: ExpectedBadge,
   targetRel: string,
): { findings: FindingKey[]; summary: { errors: number; warnings: number } } {
   if (block.exit === 0) return { findings: [], summary: { errors: 0, warnings: 0 } };
   const refused: FindingKey =
      block.exit === 2
         ? { rule: 'badge-target-foreign', severity: 'error', path: targetRel }
         : {
              rule: block.verifiedLevel === null ? 'badge-unverified' : 'conformance-claim',
              severity: 'error',
              path: 'leji.json',
           };
   return { findings: [refused], summary: { errors: 1, warnings: 0 } };
}

/** The whole `--json` document against the block: the exact key set, and every
 * value the block fixes — including the findings and the summary, pinned above
 * rather than derived from the document, which is what makes a wrong rule or a
 * stray finding fail here. The summary's exact key set, its agreement with the
 * findings beside it, and `ok`'s agreement with both follow from comparing the
 * pinned pair, so they are asserted by that comparison and not again. */
function assertBadgeDocument(stdout: string, block: ExpectedBadge, targetRel: string, where: string): BadgeDocument {
   const doc = JSON.parse(stdout) as BadgeDocument;
   assert.deepEqual(Object.keys(doc).sort(), [...DOCUMENT_KEYS].sort(), `${where}: the exact JSON key set`);
   assert.equal(doc.command, 'badge', `${where}: command`);
   assert.equal(doc.out, block.out, `${where}: out`);
   assert.equal(doc.level, block.level, `${where}: level`);
   assert.equal(doc.claimedLevel, block.claimedLevel, `${where}: claimedLevel`);
   assert.equal(doc.verifiedLevel, block.verifiedLevel, `${where}: verifiedLevel`);
   assert.equal(doc.action, block.action, `${where}: action`);
   assert.equal(
      doc.markdown,
      block.level === null || block.out === null ? null : badgeMarkdown(block.level as ConformanceLevel, block.out),
      `${where}: markdown`,
   );
   assert.equal(doc.ok, block.exit === 0, `${where}: ok tracks the exit code`);
   const expected = expectedDocument(block, targetRel);
   assert.deepEqual(
      doc.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
      expected.findings,
      `${where}: the exact findings, on (rule, severity, path)`,
   );
   assert.deepEqual(doc.summary, expected.summary, `${where}: the literal summary`);
   return doc;
}

test('a --out usage error exits 2 and emits no JSON document at all', async () => {
   const dir = committedFixture('valid-badge-governed');
   try {
      for (const bad of ['x.png', '../x.svg', '/abs.svg', '.leji/x.svg']) {
         const r = await runCliProc(['badge', '--root', dir, '--json', '--out', bad]);
         assert.equal(r.code, 2, `${bad} is a usage error`);
         assert.equal(r.stdout.trim(), '', `${bad} writes nothing to stdout, so no level is reported`);
      }
      assert.ok(!fs.existsSync(path.join(dir, 'leji-badge.svg')), 'and nothing was written');
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

for (const name of fs.readdirSync(fixturesDir).sort()) {
   const expectedFile = path.join(fixturesDir, name, 'expected.json');
   if (!fs.existsSync(expectedFile)) continue;
   const block = (JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as { badge?: ExpectedBadge }).badge;
   if (!block) continue;

   test(`fixture ${name}: the badge block`, async () => {
      const dir = committedFixture(name);
      try {
         const targetRel = block.preseed?.path ?? block.out ?? 'leji-badge.svg';
         const target = path.join(dir, ...targetRel.split('/'));
         if (block.preseed) {
            const bytes = block.preseed.from
               ? fs.readFileSync(path.join(fixturesDir, ...block.preseed.from.split('/')))
               : Buffer.from(block.preseed.bytes ?? '', 'utf8');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, bytes);
         }
         const planted = block.preseed ? fs.readFileSync(target) : null;

         const args = block.args ?? ['badge'];
         const first = await runCliProc([...args, '--root', dir, '--json']);
         assert.equal(first.code, block.exit, `exit code for ${name}: ${first.stdout}`);
         // The document carries every outcome, refusals included: `ok:false` and the
         // rule that refused, at the target path, are pinned inside it.
         assertBadgeDocument(first.stdout, block, targetRel, `${name} (first run)`);

         if (block.golden !== null) {
            const golden = fs.readFileSync(path.join(fixturesDir, ...block.golden.split('/')));
            assert.deepEqual(fs.readFileSync(path.join(dir, ...block.out!.split('/'))), golden, 'the written bytes');
         }
         // `written: false` is two claims in one: the target does not exist after the
         // run, or — when `preseed` planted it — its planted bytes are still there.
         if (block.written === false) {
            if (planted === null) assert.ok(!fs.existsSync(target), `${targetRel} was never created`);
            else assert.deepEqual(fs.readFileSync(target), planted, `${targetRel} is byte-untouched`);
         }

         if (block.rerun) {
            const afterFirst = snapshotTree(dir);
            const second = await runCliProc([...args, '--root', dir, '--json']);
            assert.equal(second.code, 0, 'the steady state exits 0');
            // The whole document again, not just `action`: the steady state is the
            // same run reported the same way, with the write already done.
            assertBadgeDocument(
               second.stdout,
               { ...block, action: block.rerun.action, preseed: undefined },
               targetRel,
               `${name} (rerun)`,
            );
            if (block.rerun.byteIdentical) {
               assert.deepEqual(
                  snapshotTree(dir),
                  afterFirst,
                  'a second run is a byte-level no-op across the whole working tree',
               );
            }
         }
      } finally {
         fs.rmSync(dir, { recursive: true, force: true });
      }
   });
}
