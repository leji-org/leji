import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as Module from 'node:module';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ECOSYSTEM_TEXT } from '../dist/lib/ecosystem.js';
import {
   type EcosystemReport,
   detectEcosystem,
   renderEcosystemBlock,
   renderEcosystemLine,
   runnerArgv,
} from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const casesDir = path.join(repoRoot, 'fixtures', 'ecosystem');

/** The one committed formatting of an ecosystem `expected.json`: the report under
 * an `ecosystem` key, `JSON.stringify(…, null, 2)`, one trailing newline. Comparing
 * the bytes is what pins KEY ORDER — a deep-equal comparison would pass however the
 * three SDKs happened to order their fields, and the JSON is a public contract. */
function serialize(report: EcosystemReport): string {
   return JSON.stringify({ ecosystem: report }, null, 2) + '\n';
}

function tmpRoot(name: string): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), `leji-eco-${name}-`));
}

/** A root holding exactly the given files (contents may be empty: lockfiles are
 * presence-only evidence). */
function plant(name: string, files: Record<string, string>): string {
   const dir = tmpRoot(name);
   for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
   return dir;
}

const caseNames = fs.readdirSync(casesDir).sort();

test('fixtures/ecosystem: the family is populated', () => {
   assert.ok(caseNames.length >= 111, `expected the full ecosystem fixture family, found ${caseNames.length}`);
});

for (const name of caseNames) {
   const dir = path.join(casesDir, name);
   test(`ecosystem fixture ${name}`, () => {
      const expected = fs.readFileSync(path.join(dir, 'expected.json'), 'utf8');
      const report = detectEcosystem(dir);
      // Deep equality first: it names the field that diverged.
      assert.deepEqual({ ecosystem: report }, JSON.parse(expected));
      // Then the bytes, which additionally pin key order and formatting.
      assert.equal(serialize(report), expected);
   });
}

/**
 * The declaration scan's field-state matrix, as SHARED cases only. Every state
 * this contract has is a fixture the three SDKs run: an assertion that lives only
 * in TypeScript is a state the ports can diverge on in silence, which is how a
 * cross-implementation suite stays green over a contract that is already wrong.
 *
 * Two mechanisms keep it that way, and neither can drift:
 *  - the families below must exactly PARTITION the `scan-*` fixtures on disk, so a
 *    new case must be classified and a deleted one fails here;
 *  - `no scanner input lives only in TypeScript` refuses any manifest literal in
 *    this file, so a new assertion cannot be written inline instead.
 */
interface ScannerFamily {
   field: string;
   positive: string[];
   negative: string[];
}

const SCANNER_FAMILIES: ScannerFamily[] = [
   {
      field: 'project.dependencies',
      positive: [
         'scan-project-deps-inline',
         'scan-project-deps-multiline',
         'scan-project-deps-specifier',
         'scan-project-deps-spaced-header',
         'scan-project-deps-single-quoted',
      ],
      negative: ['scan-project-deps-absent', 'scan-project-deps-prefix-only', 'scan-project-deps-comment'],
   },
   {
      field: 'project.optional-dependencies',
      positive: ['scan-optional-deps-declared'],
      negative: ['scan-optional-deps-absent', 'scan-optional-deps-comment'],
   },
   {
      field: 'dependency-groups',
      positive: ['scan-dependency-groups-declared'],
      negative: [
         'scan-dependency-groups-absent',
         'scan-dependency-groups-comment',
         'scan-dependency-groups-triple-quoted',
      ],
   },
   {
      field: 'tool.uv dev-dependencies',
      positive: ['scan-tool-uv-dev-declared', 'scan-tool-uv-dev-marker'],
      negative: ['scan-tool-uv-dev-absent', 'scan-tool-uv-dev-comment', 'scan-tool-uv-other-field'],
   },
   {
      field: 'tool.poetry.dependencies',
      positive: ['scan-poetry-deps-key', 'scan-poetry-deps-quoted-key'],
      negative: ['scan-poetry-deps-absent', 'scan-poetry-deps-comment'],
   },
   {
      field: 'tool.poetry.dev-dependencies',
      positive: ['scan-poetry-dev-deps-key', 'scan-poetry-dev-deps-quoted-key'],
      negative: ['scan-poetry-dev-deps-absent', 'scan-poetry-dev-deps-comment'],
   },
   {
      field: 'tool.poetry.group.<x>.dependencies',
      positive: ['scan-poetry-group-key', 'scan-poetry-group-inline-table'],
      negative: ['scan-poetry-group-absent', 'scan-poetry-group-comment'],
   },
   {
      field: 'tool.pdm.dev-dependencies',
      positive: ['scan-pdm-dev-array', 'scan-pdm-dev-key'],
      negative: ['scan-pdm-dev-absent', 'scan-pdm-dev-comment'],
   },
   {
      field: 'Pipfile packages',
      positive: ['scan-pipfile-packages', 'scan-pipfile-packages-quoted-key'],
      negative: ['scan-pipfile-packages-absent', 'scan-pipfile-packages-comment'],
   },
   {
      field: 'Pipfile dev-packages',
      positive: ['scan-pipfile-dev-packages', 'scan-pipfile-dev-packages-bare-key'],
      negative: ['scan-pipfile-dev-packages-absent', 'scan-pipfile-dev-packages-comment'],
   },
   {
      field: 'requirements files',
      positive: ['scan-requirements-declared', 'scan-requirements-bare', 'scan-requirements-extras'],
      negative: [
         'scan-requirements-indented',
         'scan-requirements-comment',
         'scan-requirements-prefix-only',
         'scan-requirements-include-line',
      ],
   },
   {
      // A quoted element declares; the same text triple-quoted never does, on one
      // line as across several, because nothing here parses TOML.
      field: 'quoted and triple-quoted elements',
      positive: ['scan-plain-quoted-element'],
      negative: ['scan-triple-quoted-element', 'scan-triple-quoted-element-literal'],
   },
   {
      // A multi-line string is skipped whole, so neither its prose nor a table
      // header inside it can reach the scan. There is no positive: it never declares.
      field: 'multi-line strings',
      positive: [],
      negative: ['scan-multiline-basic-string', 'scan-multiline-literal-string', 'scan-multiline-string-hides-table'],
   },
   {
      // Uninspected fields of an inspected table, and tables that are not inspected
      // at all: the scan is field-specific because a false positive suppresses the
      // only offer the user gets.
      field: 'uninspected fields and tables',
      positive: [],
      negative: [
         'scan-project-description',
         'scan-project-keywords',
         'scan-project-classifiers',
         'scan-project-nested-array',
         'scan-unrelated-table-key',
         'scan-poetry-scripts-key',
         'scan-pipfile-scripts',
      ],
   },
   {
      field: 'go.mod tool directive',
      positive: ['scan-go-2.0'],
      negative: ['scan-go-closed-block', 'scan-go-comment', 'scan-go-1.9', 'scan-go-1.25'],
   },
];

/** The verdict a shared case pins, read from its committed expectation. */
function fixtureDeclared(name: string): boolean {
   const expected = JSON.parse(fs.readFileSync(path.join(casesDir, name, 'expected.json'), 'utf8'));
   assert.ok(expected.ecosystem.selected, `${name}: a scanner case always selects one manager`);
   return expected.ecosystem.selected.directDeclared;
}

test('fixtures/ecosystem: the scanner families partition every shared scan case', () => {
   const onDisk = caseNames.filter((n) => n.startsWith('scan-'));
   const claimed = SCANNER_FAMILIES.flatMap((f) => [...f.positive, ...f.negative]);
   assert.equal(new Set(claimed).size, claimed.length, 'no case is claimed by two families');
   // Set equality both ways: a new fixture must be classified, and a classified
   // case must exist. Neither list can quietly drift from the other.
   assert.deepEqual(claimed.slice().sort(), onDisk.slice().sort());
});

test('fixtures/ecosystem: every inspected field carries both verdicts as shared cases', () => {
   for (const family of SCANNER_FAMILIES) {
      for (const name of family.positive) {
         assert.equal(fixtureDeclared(name), true, `${family.field}: ${name} must declare`);
      }
      for (const name of family.negative) {
         assert.equal(fixtureDeclared(name), false, `${family.field}: ${name} must not declare`);
      }
      assert.ok(family.negative.length > 0, `${family.field}: a negative is what proves the scan is specific`);
   }
   // Every field that can be declared IN has a positive; the two families without
   // one are the ones where declaring is impossible by construction.
   const noPositive = SCANNER_FAMILIES.filter((f) => f.positive.length === 0).map((f) => f.field);
   assert.deepEqual(noPositive, ['multi-line strings', 'uninspected fields and tables']);
});

test('fixtures/ecosystem: the go directive threshold is pinned by shared cases', () => {
   const manager = (name: string): string =>
      JSON.parse(fs.readFileSync(path.join(casesDir, name, 'expected.json'), 'utf8')).ecosystem.selected.manager;
   // Tool dependencies need Go 1.24; the fixtures pin both sides of the boundary.
   assert.equal(manager('scan-go-1.9'), 'go-legacy');
   assert.equal(manager('go-1.23-legacy'), 'go-legacy');
   assert.equal(manager('go-no-directive'), 'go-legacy');
   assert.equal(manager('go-1.24'), 'go');
   assert.equal(manager('scan-go-1.25'), 'go');
   assert.equal(manager('scan-go-2.0'), 'go');
});

/**
 * The anti-drift guard, structural rather than a list of spellings. It reads its
 * own source, extracts every string and template literal, and refuses any whose
 * CONTENT reads as a manifest: a TOML table header at any spacing, a `go.mod`
 * directive or block opener, a requirements line, or a dependency-array
 * assignment. A curated list of substrings can always be spelled around
 * (`[ project ]` with spaces, a `tool (` block, a dotted or quoted key); a rule
 * about the SHAPE of the content cannot.
 *
 * Every bracket below is assembled from its character code, so no fragment of the
 * guard is itself a manifest literal.
 */
const LB = String.fromCharCode(91);
const RB = String.fromCharCode(93);
/** One TOML key: bare, dotted, or quoted. */
const TOML_KEY = LB + 'A-Za-z0-9_.' + String.fromCharCode(34) + "'-" + RB + '+';

const MANIFEST_SHAPES: { rule: string; re: RegExp }[] = [
   {
      rule: 'a TOML table header',
      re: new RegExp(
         '^\\s*\\' + LB + '\\s*\\' + LB + '?\\s*' + TOML_KEY + '(?:\\s*\\.\\s*' + TOML_KEY + ')*\\s*\\' + RB,
         'm',
      ),
   },
   { rule: 'a go.mod module directive', re: new RegExp('^\\s*module\\s+\\S', 'm') },
   { rule: 'a go.mod go directive', re: new RegExp('^\\s*go\\s+' + LB + '0-9' + RB, 'm') },
   { rule: 'a go.mod tool directive', re: new RegExp('^\\s*tool\\s+\\S', 'm') },
   { rule: 'a go.mod tool block', re: new RegExp('^\\s*tool\\s*\\(', 'm') },
   {
      rule: 'a requirement with a specifier or extras',
      re: new RegExp('^\\s*leji\\s*' + LB + '<>=~!;,' + LB + RB, 'm'),
   },
   {
      rule: 'a dependency array assignment',
      re: new RegExp('(?:^|\\s)(?:dependencies|dev-dependencies|dev)\\s*=\\s*\\' + LB, 'm'),
   },
];

/** A bare requirements BODY, which is a line that is only the name. Applied to
 * literals carrying a newline, so a plain `leji` argv element stays legal. */
const REQUIREMENT_LINE = new RegExp('^\\s*leji\\b', 'm');

/**
 * Every string and template literal in the source, with escapes decoded, so a
 * one-line manifest written with escaped newlines is judged by the lines it
 * actually holds. Comments are skipped (their prose carries apostrophes), and the
 * scan must end in code: ending inside a string would mean this reading of the
 * file is wrong, and the guard says so rather than passing vacuously.
 */
function sourceLiterals(source: string): string[] {
   const out: string[] = [];
   let quote = '';
   let buf = '';
   let i = 0;
   while (i < source.length) {
      const c = source[i];
      if (quote === '') {
         if (c === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i++;
            continue;
         }
         if (c === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*' + '/', i + 2);
            i = end < 0 ? source.length : end + 2;
            continue;
         }
         if (c === "'" || c === '"' || c === '`') {
            quote = c;
            buf = '';
         }
         i++;
         continue;
      }
      if (c === '\\') {
         const next = source[i + 1] ?? '';
         buf += next === 'n' ? '\n' : next === 't' ? '\t' : next;
         i += 2;
         continue;
      }
      if (c === quote) {
         out.push(buf);
         quote = '';
         i++;
         continue;
      }
      buf += c;
      i++;
   }
   assert.equal(quote, '', 'the literal scan ended inside a string, so its reading of this file is not trustworthy');
   return out;
}

test('fixtures/ecosystem: no scanner input lives only in TypeScript', () => {
   const literals = sourceLiterals(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'));
   assert.ok(literals.length > 100, `the literal scan found ${literals.length} literals, so it proves nothing`);
   for (const literal of literals) {
      for (const shape of MANIFEST_SHAPES) {
         assert.ok(
            !shape.re.test(literal),
            `${shape.rule} belongs in fixtures/ecosystem, not inline here: ${JSON.stringify(literal.slice(0, 60))}`,
         );
      }
      if (literal.includes('\n')) {
         assert.ok(
            !REQUIREMENT_LINE.test(literal),
            `a requirements line belongs in fixtures/ecosystem, not inline: ${JSON.stringify(literal.slice(0, 60))}`,
         );
      }
   }
});

test('detectEcosystem: a report is the same object graph for selected and its element', () => {
   const report = detectEcosystem(path.join(casesDir, 'node-pnpm-lock'));
   assert.equal(report.all.length, 1);
   assert.deepEqual(report.selected, report.all[0]);
   assert.equal(report.reason, null);
});

// --- the runner a hook or CI job takes -------------------------------------

test('runnerArgv: the manager runner only when the repository declares the CLI', () => {
   assert.deepEqual(runnerArgv(detectEcosystem(path.join(casesDir, 'node-declared'))), [
      'npx',
      '--no-install',
      '@leji-org/leji',
   ]);
   // Detected but undeclared: the manager's runner would resolve nothing.
   assert.deepEqual(runnerArgv(detectEcosystem(path.join(casesDir, 'node-pnpm-lock'))), ['leji']);
   assert.deepEqual(runnerArgv(detectEcosystem(path.join(casesDir, 'go-declared-block'))), ['go', 'tool', 'leji']);
   assert.deepEqual(runnerArgv(detectEcosystem(path.join(casesDir, 'python-declared-pyproject-groups'))), [
      'uv',
      'run',
      'leji',
   ]);
   assert.deepEqual(runnerArgv(detectEcosystem(path.join(casesDir, 'none'))), ['leji']);
   assert.deepEqual(runnerArgv(detectEcosystem(path.join(casesDir, 'node-two-lockfiles'))), ['leji']);
});

// --- the printed block ------------------------------------------------------

test('renderEcosystemBlock: the offer names the manager, its evidence and one command', () => {
   assert.equal(
      renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'node-pnpm-lock'))),
      'Detected pnpm (pnpm-lock.yaml). To declare the Leji CLI as a dev dependency so a clean install brings leji, run:\n   pnpm add -D @leji-org/leji',
   );
   assert.equal(
      renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'node-declared'))),
      'The Leji CLI is already declared in package.json.',
   );
   const ambiguous = renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'node-two-lockfiles')));
   assert.equal(
      ambiguous,
      'Detected package.json with package-lock.json and yarn.lock; leji will not guess the package manager. Declare it with the one this repo uses:\n   npm i -D @leji-org/leji\n   yarn add -D @leji-org/leji',
   );
   // Every no-manager outcome still prints a block, and none of them prints a
   // command that would guess.
   for (const name of ['node-packagemanager-unknown', 'node-unreadable-manifest', 'node-refused-evidence']) {
      const block = renderEcosystemBlock(detectEcosystem(path.join(casesDir, name)));
      assert.ok(block.length > 0, `${name} prints a block`);
      assert.ok(!block.includes('   npm'), `${name} offers no guessed command`);
   }
   // A print-only manager prints what to add, never a command leji could run.
   const pip = renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'python-bare-pyproject')));
   assert.equal(pip, ECOSYSTEM_TEXT.pipGroups('pyproject.toml').join('\n'), 'the print-only block is the table');
   const requirements = renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'python-requirements-only')));
   assert.ok(requirements.includes('pip install -r requirements-dev.txt'), requirements);
   const legacy = renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'go-1.23-legacy')));
   assert.ok(legacy.includes('go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest'), legacy);
   const none = renderEcosystemBlock(detectEcosystem(path.join(casesDir, 'none')));
   assert.ok(none.includes('https://leji.org/quickstart/'), none);
});

test('renderEcosystemLine: one line, whatever the outcome', () => {
   const line = (name: string): string => renderEcosystemLine(detectEcosystem(path.join(casesDir, name)));
   assert.equal(line('node-pnpm-lock'), 'Ecosystem: pnpm (pnpm-lock.yaml); Leji CLI not declared');
   assert.equal(line('node-declared'), 'Ecosystem: npm (package-lock.json); Leji CLI declared');
   assert.equal(line('python-pipfile-only'), 'Ecosystem: pipenv (Pipfile); Leji CLI declared');
   assert.equal(line('python-tool-uv-no-lock'), 'Ecosystem: uv (pyproject.toml); Leji CLI not declared');
   assert.equal(line('none'), 'Ecosystem: none detected');
   for (const name of caseNames) assert.ok(!line(name).includes('\n'), `${name} renders one line`);
});

// --- evidence eligibility ---------------------------------------------------

test('detectEcosystem: a symlinked, dangling or non-regular manifest is refused, not read', () => {
   const outside = plant('outside', { 'package.json': JSON.stringify({ dependencies: { '@leji-org/leji': '1' } }) });

   const linked = tmpRoot('linked');
   fs.symlinkSync(path.join(outside, 'package.json'), path.join(linked, 'package.json'));
   const viaLink = detectEcosystem(linked);
   assert.equal(viaLink.reason, 'refused-evidence');
   assert.deepEqual(viaLink.all[0].evidence, ['package.json']);
   assert.equal(viaLink.all[0].directDeclared, false, 'a refused manifest is never read for a declaration');

   const dangling = tmpRoot('dangling');
   fs.symlinkSync(path.join(dangling, 'gone.json'), path.join(dangling, 'package.json'));
   assert.equal(detectEcosystem(dangling).reason, 'refused-evidence');

   // A directory standing where a lockfile belongs is a standing entry the run
   // could not verify, exactly like a link.
   const dirLock = plant('dirlock', { 'package.json': '{}' });
   fs.mkdirSync(path.join(dirLock, 'pnpm-lock.yaml'));
   const asDir = detectEcosystem(dirLock);
   assert.equal(asDir.reason, 'refused-evidence');
   assert.deepEqual(asDir.all[0].evidence, ['pnpm-lock.yaml']);

   // A symlink that stays inside the root is still not a regular file.
   const inside = plant('inside', { 'package.json': '{}', 'other.json': '{}' });
   fs.symlinkSync('./other.json', path.join(inside, 'pnpm-lock.yaml'));
   assert.equal(detectEcosystem(inside).reason, 'refused-evidence');

   const pyLinked = tmpRoot('pylinked');
   fs.symlinkSync(path.join(outside, 'package.json'), path.join(pyLinked, 'requirements.txt'));
   const py = detectEcosystem(pyLinked);
   assert.equal(py.reason, 'refused-evidence');
   assert.equal(py.all[0].ecosystem, 'python');
});

/**
 * Perform `swap` immediately after the FIRST `lstat` of `target`: the window
 * between the judgment of one probed name and the verified open that proves it.
 * Deterministic, not a race — the patched builtin performs the swap inline, so the
 * window is exercised on every run (the idiom the export canaries use).
 */
function swapAfterJudgment(target: string, swap: () => void): { fired: () => boolean; restore: () => void } {
   const require = createRequire(import.meta.url);
   const nodeFs = require('node:fs') as Record<string, unknown>;
   const lstatSync = nodeFs.lstatSync as (...args: unknown[]) => unknown;
   let fired = false;
   nodeFs.lstatSync = (...args: unknown[]): unknown => {
      const entry = lstatSync(...args);
      if (!fired && typeof args[0] === 'string' && path.resolve(args[0]) === target) {
         fired = true;
         swap();
      }
      return entry;
   };
   Module.syncBuiltinESMExports();
   return {
      fired: () => fired,
      restore: () => {
         nodeFs.lstatSync = lstatSync;
         Module.syncBuiltinESMExports();
      },
   };
}

test('check-before-act: an entry swapped to a link between the judgment and the open is refused, never read', () => {
   // The window inside the verification itself: package.json is a regular file of
   // this repository when it is judged and a link by the time it is opened. Nothing
   // has to be swapped back for a check that judges the entry once and then trusts
   // the open to pass, because the open resolves the link and verifies its target
   // perfectly well. What refuses it is the descriptor's own identity against a fresh
   // lstat of the NAME afterwards. Mutation that reddens: judge with lstat and take
   // the bytes back by path name (the pre-change shape) — the decoy's packageManager
   // and its declaration decide the answer.
   const dir = fs.realpathSync(
      plant('swap-judged', {
         'package.json': '{}',
         'decoy.json': JSON.stringify({ packageManager: 'pnpm@9.12.0', devDependencies: { '@leji-org/leji': '^1' } }),
      }),
   );
   const manifest = path.join(dir, 'package.json');
   const hook = swapAfterJudgment(manifest, () => {
      fs.unlinkSync(manifest);
      fs.symlinkSync(path.join(dir, 'decoy.json'), manifest);
   });
   let report: EcosystemReport;
   try {
      report = detectEcosystem(dir);
   } finally {
      hook.restore();
   }

   assert.ok(hook.fired(), 'the seam fired: a regular file at the lstat, a link at the open');
   assert.ok(fs.lstatSync(manifest).isSymbolicLink(), 'the entry really is a link now');
   assert.equal(report.reason, 'refused-evidence');
   assert.deepEqual(report.all[0].evidence, ['package.json']);
   assert.equal(report.all[0].manager, null, 'the swapped-in packageManager selected nothing');
   assert.equal(report.all[0].directDeclared, false, 'and the swapped-in target was never read');
});

test('check-before-act: a name renamed away and linked back to its own inode is refused', () => {
   // The case every comparison against the FIRST lstat accepts: the entry the run
   // judged is renamed and its old name becomes a link to that same inode, so each
   // identity the open can see agrees — the resolve lands on that file, the
   // descriptor's fstat is the judged inode, and the verified open's own recheck
   // matches. Only a FRESH lstat of the NAME catches it, because a symlink's inode is
   // never the inode of the file it points at, and a lockfile reached through a link
   // is not this repository's evidence. Mutation that reddens: compare the descriptor
   // with the initial stat instead of with a fresh one.
   const dir = fs.realpathSync(plant('relinked', { 'package.json': '{}', 'package-lock.json': '' }));
   const lock = path.join(dir, 'package-lock.json');
   const moved = path.join(dir, 'real.lock');
   const hook = swapAfterJudgment(lock, () => {
      fs.renameSync(lock, moved);
      fs.symlinkSync(moved, lock);
   });
   let report: EcosystemReport;
   try {
      report = detectEcosystem(dir);
   } finally {
      hook.restore();
   }

   assert.ok(hook.fired(), 'the seam fired: the name was relinked to its own inode');
   assert.ok(fs.lstatSync(lock).isSymbolicLink(), 'the entry really is a link now');
   assert.equal(fs.statSync(lock).ino, fs.statSync(moved).ino, 'and it points at the very inode that was judged');
   assert.equal(report.reason, 'refused-evidence');
   assert.deepEqual(report.all[0].evidence, ['package-lock.json']);
   assert.equal(report.all[0].lockEvidenced, false, 'the relinked name evidenced no manager');
});

test('detectEcosystem: a descriptor that fails to close does not discard the answer', () => {
   // The close comes after the verdict and after the bytes: it can no longer change
   // either, so a failure there is swallowed rather than allowed to unwind the read.
   // Mutation that reddens: close in a bare `finally`, and the throw reaches the
   // operational catch, turning a manifest that was read cleanly into an unreadable
   // one. The hook closes the descriptor for real before throwing, so nothing leaks.
   const dir = fs.realpathSync(plant('closefail', { 'package.json': '{ "packageManager": "yarn@4.1.0" }' }));
   const require = createRequire(import.meta.url);
   const nodeFs = require('node:fs') as Record<string, unknown>;
   const closeSync = nodeFs.closeSync as (fd: number) => void;
   let threw = 0;
   nodeFs.closeSync = (fd: number): void => {
      closeSync(fd);
      threw += 1;
      throw new Error('injected close failure');
   };
   Module.syncBuiltinESMExports();
   let report: EcosystemReport;
   try {
      report = detectEcosystem(dir);
   } finally {
      nodeFs.closeSync = closeSync;
      Module.syncBuiltinESMExports();
   }

   assert.ok(threw > 0, 'the close really failed, on the classification and on the read');
   assert.equal(report.reason, null, 'a failed close is not an unreadable manifest');
   assert.equal(report.selected?.manager, 'yarn', 'the bytes taken from the descriptor still decide');
});

test('detectEcosystem: a manifest this run cannot open is unreadable, never refused', (t) => {
   // The other half of the verified-read composition: what the run could not COMPLETE
   // on an entry it never saw contradicted is not a refusal. A regular file of this
   // repository whose open is denied keeps the outcome it has always had — the
   // manifest is unreadable, so neither the lockfile nor the ecosystem default is
   // consulted — while a swap stays `refused-evidence` above. Mutation that reddens:
   // collapse every failure in `verify` to `refused`, and this reports
   // refused-evidence instead.
   const dir = fs.realpathSync(plant('denied', { 'package.json': '{}', 'package-lock.json': '' }));
   const manifest = path.join(dir, 'package.json');
   fs.chmodSync(manifest, 0o000);
   try {
      fs.closeSync(fs.openSync(manifest, 'r'));
      t.skip('the mode is not enforced here (root, or a filesystem that ignores it)');
      return;
   } catch {
      /* denied, which is the state under test */
   }
   let report: EcosystemReport;
   try {
      report = detectEcosystem(dir);
   } finally {
      fs.chmodSync(manifest, 0o644);
   }

   assert.equal(report.reason, 'unreadable-manifest');
   assert.equal(report.all[0].manager, null);
   assert.deepEqual(report.all[0].evidence, []);
});

test('detectEcosystem: an unreadable manifest consults neither locks nor defaults', () => {
   const broken = plant('broken', { 'package.json': '{ "name": ', 'package-lock.json': '' });
   const report = detectEcosystem(broken);
   assert.equal(report.reason, 'unreadable-manifest');
   assert.equal(report.all[0].manager, null);
   assert.deepEqual(report.all[0].evidence, []);
   assert.equal(report.all[0].add, null);

   // Valid JSON that is not an object cannot carry a field either.
   assert.equal(detectEcosystem(plant('array', { 'package.json': '[]' })).reason, 'unreadable-manifest');
   // A BOM is stripped, exactly once, before the strict parse.
   const bom = plant('bom', { 'package.json': '﻿{ "packageManager": "yarn@4.1.0" }' });
   assert.equal(detectEcosystem(bom).selected?.manager, 'yarn');
   // An unreadable pyproject refuses the ecosystem rather than falling back to pip.
   const pyDir = tmpRoot('pyunreadable');
   fs.mkdirSync(path.join(pyDir, 'pyproject.toml'));
   assert.equal(detectEcosystem(pyDir).reason, 'refused-evidence');
});

test('detectEcosystem: no walk-up — a parent manifest never answers for the root', () => {
   const parent = plant('parent', { 'package.json': '{}', 'package-lock.json': '' });
   const child = path.join(parent, 'child');
   fs.mkdirSync(child);
   assert.deepEqual(detectEcosystem(child), { selected: null, all: [], reason: 'none' });
});

// --- packageManager grammar --------------------------------------------------

test('detectEcosystem: packageManager wins, and a value it cannot parse never falls through', () => {
   const pm = (value: string, extra: Record<string, string> = {}): EcosystemReport =>
      detectEcosystem(plant('pm', { 'package.json': JSON.stringify({ packageManager: value }), ...extra }));
   assert.equal(pm('pnpm@9.12.0').selected?.manager, 'pnpm');
   assert.equal(pm('bun@1.1.30+e1f2a3b4c5').selected?.manager, 'bun');
   assert.equal(pm('yarn@4.1.0-rc.1').selected?.manager, 'yarn');
   assert.equal(pm('npm').selected?.manager, 'npm', 'the version is optional in the grammar');
   assert.equal(pm('pnpm@9.12.0', { 'yarn.lock': '' }).selected?.manager, 'pnpm');
   for (const bad of ['pnpm@@9', 'pnpm@', '@9.12.0', 'Pnpm@9.12.0', 'pnpm 9.12.0', '', 'hermit@1.0.0']) {
      const report = pm(bad, { 'package-lock.json': '' });
      assert.equal(report.reason, 'unsupported-manager', `"${bad}" is not a manager leji knows`);
      assert.equal(report.all[0].source, 'packageManager');
      assert.deepEqual(report.all[0].candidates, []);
      assert.equal(report.all[0].add, null);
   }
   // A non-string value is a present value that does not parse.
   const numeric = detectEcosystem(plant('pmnum', { 'package.json': '{ "packageManager": 9 }' }));
   assert.equal(numeric.reason, 'unsupported-manager');
});

// --- the declaration rules, only ever through the detector ------------------

test('node declaration: the same rules, reached only through the eligibility path', () => {
   const declared = (pkg: string): boolean => {
      const dir = plant('decl', { 'package.json': pkg, 'package-lock.json': '' });
      return detectEcosystem(dir).selected!.directDeclared;
   };
   assert.equal(declared('{"devDependencies":{"@leji-org/leji":"^1"}}'), true);
   assert.equal(declared('{"dependencies":{"@leji-org/leji":"^1"}}'), true);
   // One BOM is stripped before the strict parse.
   assert.equal(declared('\ufeff{"devDependencies":{"@leji-org/leji":"^1"}}'), true);
   // A dependency map that is not a JSON object holds no key: absent, never an error.
   assert.equal(declared('{"devDependencies":["@leji-org/leji"]}'), false);
   assert.equal(declared('{"devDependencies":{"leji":"^1"}}'), false, 'the name is exact');
   // An unparseable manifest is unreadable, not undeclared: nothing is inferred.
   const broken = plant('decl', { 'package.json': 'not json', 'package-lock.json': '' });
   assert.equal(detectEcosystem(broken).reason, 'unreadable-manifest');
   // And a manifest that fails eligibility is never read for a declaration at all.
   const linked = tmpRoot('decl-link');
   const outside = plant('decl-outside', { 'package.json': '{"dependencies":{"@leji-org/leji":"1"}}' });
   fs.symlinkSync(path.join(outside, 'package.json'), path.join(linked, 'package.json'));
   const report = detectEcosystem(linked);
   assert.equal(report.reason, 'refused-evidence');
   assert.equal(report.all[0].directDeclared, false);
});
