import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The homepage hero shows a real `leji` session: adopt, validate, conformance. It is
// a hand-captured constant (`heroSession` in packages/site/src/pages/index.astro), so
// nothing at build time notices when the CLI's output moves underneath it. The
// control was a comment asking for a manual re-capture, and it missed three drifts.
// This test is the mechanical replacement: scaffold the fixture that comment
// documents, run the same three commands against the built CLI, and compare.
//
// The comparison is a projection, not a byte match, because the hero renders a
// condensed transcript:
//   cmd lines      `leji ` plus the argv this test passes.
//   adopt header   the "Wrote N files (context root: X):" line, verbatim.
//   adopt files    the CLI prints one indented line per written file; the hero shows
//                  the first three paths in the CLI's order, three-space indented,
//                  joined by three spaces, then three spaces and a `…`.
//   validate       the last non-empty stdout line (the command's summary), verbatim.
//   conformance    the same rule: the last non-empty line, which is the summary the
//                  hero shows rather than the per-item report above it.
//   gaps           the blank band the hero puts between stanzas.
// Nothing else about the output is pinned here, and every line the hero does show is.
//
// The fixture's temporary directory is elided from every projected line before the
// comparison. It is machine-specific, so a line carrying it could never match the
// hero; the placeholder makes such a line fail as drift rather than as a stray path.
//
// Known limit of reading the constant with a regex, stated rather than papered over:
// it wants the array literal formatted the way Prettier formats it today, one entry
// per line, each value a single-quoted string with no escape inside it, and `mark`
// the only extra property. Anything else fails the parse loudly, with the offending
// line quoted, rather than silently checking less. Widen the two patterns below when
// the literal legitimately grows a shape they do not cover.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const cli = path.join(packageDir, 'dist', 'cli.js');
const HERO_REL = 'packages/site/src/pages/index.astro';
const heroSource = path.join(repoRoot, ...HERO_REL.split('/'));

/** One rendered transcript line: a typed command, an output line, or the blank band
 * the hero puts between stanzas. */
type Line = { kind: 'cmd' | 'out'; text: string } | { kind: 'gap' };

/** The array literal, from its declaration to the first line that closes it. */
const HERO_BLOCK = /const heroSession = \[\n([\s\S]*?)\n\];/;
const HERO_GAP = /^\s*\{ gap: true \},?$/;
const HERO_ENTRY = /^\s*\{ (cmd|out): '([^'\\]*)'(?:, mark: '[a-z]+')? \},?$/;
/** The header `adopt` prints above its per-file lines, and one of those lines. */
const WROTE = /^Wrote \d+ files \(context root: .*\):$/;
const WRITTEN_FILE = /^ {3}(\S.*)$/;

function parseHeroSession(source: string): Line[] {
   const block = HERO_BLOCK.exec(source);
   assert.ok(block, `no heroSession array literal in ${HERO_REL}: this test cannot see the hero at all`);
   return block[1].split('\n').map((line) => {
      if (HERO_GAP.test(line)) return { kind: 'gap' } as Line;
      const entry = HERO_ENTRY.exec(line);
      assert.ok(entry, `heroSession entry is not a shape this test can read: ${line.trim()}`);
      return { kind: entry[1] as 'cmd' | 'out', text: entry[2] } as Line;
   });
}

/**
 * The fixture the hero's re-capture comment documents: a repository that already has
 * a docs/ tree and a non-empty AGENTS.md, committed. Committed for two reasons the
 * SDK enforces: `adopt` refuses a dirty working tree, and the `core` conformance item
 * asks the layer to live in a git repository.
 */
function fixture(): string {
   const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-site-hero-')));
   fs.mkdirSync(path.join(dir, 'docs'));
   fs.writeFileSync(path.join(dir, 'docs', 'overview.md'), '# Overview\n\nWhat this repository is for.\n');
   fs.writeFileSync(path.join(dir, 'docs', 'architecture.md'), '# Architecture\n\nHow the pieces fit together.\n');
   fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n\nHow agents work in this repository.\n');
   const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_DIR: undefined }, stdio: 'ignore' });
   };
   git('init', '-q');
   git('add', '-A');
   git('-c', 'user.name=Hero Test', '-c', 'user.email=hero@example.com', 'commit', '-q', '-m', 'seed');
   return dir;
}

/** The real bin, from the fixture directory, the way the re-capture comment runs it. */
function runCli(dir: string, args: string[]): string[] {
   const res = spawnSync('node', [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined },
   });
   assert.equal(res.status, 0, `leji ${args.join(' ')} exited ${res.status}\n${res.stderr}`);
   return res.stdout.split('\n').map((line) => line.split(dir).join('<fixture>'));
}

/** The one line the hero shows for validate and conformance. */
function summary(out: string[], command: string): string {
   const printed = out.filter((line) => line.trim() !== '');
   assert.ok(printed.length > 0, `leji ${command} printed nothing to summarize`);
   return printed[printed.length - 1];
}

function projectedSession(dir: string): Line[] {
   const adopt = ['adopt', '--yes', '--wire-adapters'];
   const out = runCli(dir, adopt);
   const header = out.findIndex((line) => WROTE.test(line));
   assert.notEqual(header, -1, `leji ${adopt.join(' ')} printed no "Wrote N files (context root: X):" line`);
   const written: string[] = [];
   for (const line of out.slice(header + 1)) {
      const file = WRITTEN_FILE.exec(line);
      if (!file) break;
      written.push(file[1]);
   }
   assert.ok(written.length >= 3, `adopt listed ${written.length} written files; the hero line shows three and a "…"`);
   return [
      { kind: 'cmd', text: `leji ${adopt.join(' ')}` },
      { kind: 'out', text: out[header] },
      { kind: 'out', text: `   ${written.slice(0, 3).join('   ')}   …` },
      { kind: 'gap' },
      { kind: 'cmd', text: 'leji validate' },
      { kind: 'out', text: summary(runCli(dir, ['validate']), 'validate') },
      { kind: 'gap' },
      { kind: 'cmd', text: 'leji conformance' },
      { kind: 'out', text: summary(runCli(dir, ['conformance']), 'conformance') },
   ];
}

function render(session: Line[]): string {
   return session.map((line) => (line.kind === 'gap' ? '   (gap)' : `   ${line.kind} | ${line.text}`)).join('\n');
}

let fixtureDir = '';
let hero: Line[] = [];
let projected: Line[] = [];

before(() => {
   fixtureDir = fixture();
   projected = projectedSession(fixtureDir);
   hero = parseHeroSession(fs.readFileSync(heroSource, 'utf8'));
});

after(() => {
   if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

test('the homepage hero transcript is what the CLI prints today', () => {
   assert.deepEqual(
      hero,
      projected,
      `the hero transcript no longer matches the CLI.\nhero (${HERO_REL}):\n${render(hero)}\n` +
         `projected (this run):\n${render(projected)}\n` +
         'Re-capture per the comment above heroSession, or fix what the CLI prints.',
   );
});

// The check above only earns its keep if it can fail. A green run over a parse that
// silently matched nothing, or over a comparison that compares nothing, would look
// identical. So: one character of one heroSession line, changed in memory, and the
// same comparison has to reject it. The file on disk is never touched.
test('a one-character edit to a heroSession line fails the comparison', () => {
   const source = fs.readFileSync(heroSource, 'utf8');
   const mutated = source.replace(/(\{ out: 'Wrote )(\d)/, (_m, head: string, digit: string) => {
      return `${head}${digit === '9' ? '8' : String(Number(digit) + 1)}`;
   });
   assert.notEqual(mutated, source, 'the mutation changed nothing, so this negative check proves nothing');
   assert.throws(() => assert.deepEqual(parseHeroSession(mutated), projected), assert.AssertionError);
});
