import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
   type ConformanceResult,
   SDK_VERSION,
   buildWritePlan,
   loadCliSpec,
   renderCommandHelp,
   renderDetect,
   renderExplain,
   renderUsage,
   run,
} from '../dist/index.js';
import { exitCodeColumn, helpRow, nameColumn, optionColumn, wrap } from '../dist/lib/text.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const goldensDir = path.join(repoRoot, 'fixtures', 'help-goldens');
const golden = (name: string) => fs.readFileSync(path.join(goldensDir, name), 'utf8');
const goldenName = (command: string) => command.replace(/ /g, '-') + '.txt';
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

/** U+2013 and U+2014: the house rule is that no line the CLI prints carries either. */
const DASHES = /[–—]/;

async function stdoutOf<T>(fn: () => T | Promise<T>): Promise<string> {
   const chunks: string[] = [];
   const log = console.log;
   const err = console.error;
   console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(' ') + '\n');
   console.error = () => {};
   try {
      await fn();
      return chunks.join('');
   } finally {
      console.log = log;
      console.error = err;
   }
}

// --- cli.json integrity: the grouping four consumers read ---------------------

test('cli.json: group ids are unique, every command is in one known group, aliases resolve', () => {
   const spec = loadCliSpec();
   const ids = spec.groups.map((g) => g.id);
   assert.deepEqual([...new Set(ids)], ids, 'group ids are unique');
   for (const g of spec.groups) assert.ok(g.title.length > 0, `${g.id} has a title`);
   const names = new Set(spec.commands.map((c) => c.name));
   for (const c of spec.commands) {
      assert.ok(typeof c.group === 'string' && ids.includes(c.group), `${c.name} names a declared group`);
      if (c.aliasOf === undefined) continue;
      assert.ok(names.has(c.aliasOf), `${c.name} aliases an existing command`);
      const primary = spec.commands.find((p) => p.name === c.aliasOf);
      assert.equal(primary!.aliasOf, undefined, `${c.name} aliases a primary, never another alias`);
   }
});

// --- the wrapper --------------------------------------------------------------

test('wrap: collapses whitespace, hangs continuations, and never breaks an oversized token', () => {
   assert.deepEqual(wrap('  one   two  ', 20, 0, 0), ['one two']);
   assert.deepEqual(wrap('', 20, 0, 0), []);
   assert.deepEqual(wrap('alpha beta gamma delta', 16, 0, 3), ['alpha beta gamma', '   delta']);
   // The continuation indent counts against the width, not only the first line.
   assert.deepEqual(wrap('alpha beta gamma delta', 16, 0, 8), ['alpha beta gamma', '        delta']);
   // A token wider than the line takes a line of its own rather than being split:
   // a URL or a flag spelling stays copyable.
   assert.deepEqual(wrap('see https://leji.org/cli/#mounts-update-pin now', 20, 0, 3), [
      'see',
      '   https://leji.org/cli/#mounts-update-pin',
      '   now',
   ]);
});

test('the top-level Usage line goes through the wrapper (shared long-usage vector)', () => {
   // No current command is long enough to wrap this line, so the contract is pinned on
   // a vector instead: every emitted field passes the wrapper, never just the ones the
   // data happens to overflow today.
   const usage =
      'Usage: leji mounts update-pin <name> [--to <oid>] [--allow-non-fast-forward] [--fetch] [--dry-run] [--root <dir>] [--json]';
   assert.equal(wrap(usage, 80, 0, 7).join('\n') + '\n', golden('wrap-long-usage.txt'));
   assert.match(renderUsage(), /\nUsage: leji <command> \[options\]\n/);
});

test('a label wider than its column takes the line alone (shared overlong-label vector)', () => {
   const label = '--allow-non-fast-forward-with-a-very-long-spelling <oid>';
   const summary =
      'Permit a target that is not a descendant of the current pin, in the one spelling long enough to outgrow its column.';
   assert.equal(helpRow(label, 23, summary).join('\n') + '\n', golden('row-overlong-label.txt'));
   // The clamp is what makes an overlong label reachable: past 27 characters the flag
   // outgrows its own column.
   assert.equal(optionColumn([label]), 33);
   // A label that exactly fills the column would leave no gap, so it takes the line too.
   assert.deepEqual(helpRow('--exactly-here', 17, 'summary'), ['   --exactly-here', '                 summary']);
});

test('a row pads by code points, not UTF-16 units (shared non-BMP row vector)', () => {
   // Two U+1F600 in the label: padding by UTF-16 units leaves the row two columns short
   // and misaligns every summary in the block.
   const label = '--emoji-\u{1F600}\u{1F600} <value>';
   const summary = 'A flag carrying astral characters, so a column padded in UTF-16 units misaligns this row by two.';
   assert.equal(helpRow(label, 23, summary).join('\n') + '\n', golden('row-non-bmp.txt'));
});

test('every dynamic label class resolves a bounded, code-point column', () => {
   assert.equal(optionColumn(['--json']), 23); // below the floor: [20, 30]
   assert.equal(optionColumn(['--a-flag-of-thirty-plus-characters <value>']), 33); // above the ceiling
   assert.equal(nameColumn(['leji']), 15); // below the floor: [12, 30]
   assert.equal(nameColumn(['a-command-name-long-enough-to-outgrow-its-bounded-column']), 33);
   assert.equal(exitCodeColumn(['0']), 6); // below the floor: [3, 8]
   assert.equal(exitCodeColumn(['0', '127']), 8);
   // Code points, not UTF-16 units: an astral label sizes its column by what it prints.
   assert.equal(optionColumn(['--emoji-\u{1F600}\u{1F600} <value>']), 24); // 18 code points, not 20 UTF-16 units
});

test('the bounds hold through the renderers, on the shared synthetic spec', () => {
   // Rendered, not just computed: a bound that the column helper honors and the renderer
   // bypasses is exactly the defect this pins. The spec pushes every class past its
   // bound at once.
   const spec = JSON.parse(fs.readFileSync(path.join(goldensDir, 'bounds-spec.json'), 'utf8'));
   assert.equal(renderUsage(spec) + '\n', golden('bounds-usage.txt').replace('{{version}}', SDK_VERSION));
   const long = 'a-command-name-long-enough-to-outgrow-its-bounded-column';
   assert.equal(renderCommandHelp(long, spec) + '\n', golden('bounds-command.txt'));
});

test('wrap: measures width in code points, not UTF-16 units (the shared non-BMP vector)', () => {
   // Documented in fixtures/README.md: four U+1F600, two spaces, three ASCII words,
   // width 20, first line indented 0 and continuations 3. Measuring the emoji run as
   // 8 UTF-16 units instead of 4 code points breaks the line one word early.
   const input = '\u{1F600}\u{1F600}\u{1F600}\u{1F600}  alphabet six666 tail';
   assert.equal(wrap(input, 20, 0, 3).join('\n') + '\n', golden('wrap-non-bmp.txt'));
});

// --- the goldens --------------------------------------------------------------

test('help goldens: every rendered help matches its committed bytes', () => {
   const spec = loadCliSpec();
   assert.equal(renderUsage() + '\n', golden('usage.txt').replace('{{version}}', SDK_VERSION));
   for (const c of spec.commands) {
      assert.equal(renderCommandHelp(c.name) + '\n', golden(goldenName(c.name)), c.name);
   }
   // And nothing committed is orphaned: every golden is one of the surfaces above.
   const expected = new Set([
      'usage.txt',
      'wrap-non-bmp.txt',
      'wrap-long-usage.txt',
      'row-overlong-label.txt',
      'row-non-bmp.txt',
      'bounds-spec.json',
      'bounds-usage.txt',
      'bounds-command.txt',
      ...spec.commands.map((c) => goldenName(c.name)),
   ]);
   assert.deepEqual(new Set(fs.readdirSync(goldensDir)), expected);
});

test("help goldens: per-command help lists the command's own options and points at the globals", () => {
   const spec = loadCliSpec();
   const globals = spec.globalOptions.map((o) => o.flags);
   // Examples are commands to copy, never prose: they are printed as authored, so
   // the width contract covers everything above them.
   const prose = (help: string) => help.split('\nExamples:\n')[0].split('\n');
   for (const c of spec.commands) {
      const help = renderCommandHelp(c.name)!;
      assert.match(help, /\nGlobal options: see leji --help\.\n/, c.name);
      for (const g of globals) assert.ok(!help.includes(`   ${g}`), `${c.name} does not repeat ${g}`);
      for (const o of c.options) assert.ok(help.includes(`   ${o.flags}`), `${c.name} lists ${o.flags}`);
      assert.ok(
         prose(help).every((l) => [...l].length <= 80),
         `${c.name} wraps at 80 code points`,
      );
   }
   assert.ok(
      renderUsage()
         .split('\n')
         .every((l) => [...l].length <= 80),
      'top-level help wraps at 80 code points',
   );
});

// --- the em-dash house rule, checked on the bytes the CLI prints --------------

test('help output carries no em or en dash', () => {
   for (const file of fs.readdirSync(goldensDir)) {
      assert.ok(!DASHES.test(golden(file)), `${file} carries an em or en dash`);
   }
});

test('cli.json carries no em or en dash', () => {
   const raw = fs.readFileSync(path.join(pkgRoot, 'cli.json'), 'utf8');
   assert.ok(!DASHES.test(raw));
});

test('the CLI prose branches carry no em or en dash', async () => {
   // detect's host lines: synthetic hosts, so the branch runs wherever the suite does.
   const detect = renderDetect({
      hosts: [
         {
            id: 'codex',
            name: 'Codex CLI',
            strength: 'confirmed',
            onPath: true,
            inRepo: true,
            userConfig: false,
            adapter: 'AGENTS.md',
         },
      ],
      ecosystem: { selected: null, all: [], reason: 'none' },
   });
   assert.match(detect, /Codex CLI: binary on PATH/);
   assert.ok(!DASHES.test(detect));

   // conformance --explain's blocker details, likewise: the detail branch needs a
   // blocker that carries one, which a passing layer does not produce.
   const result: ConformanceResult = {
      claimedLevel: 'core',
      verifiedLevel: 'core',
      processAttested: 0,
      items: [
         {
            id: 'index-current',
            level: 'indexed',
            description: 'a generated context index, current with the tree',
            status: 'fail',
            detail: 'the stored index is stale',
         },
      ],
      findings: [],
   };
   const explain = renderExplain(result);
   assert.match(explain, /- a generated context index, current with the tree: the stored index is stale/);
   assert.ok(!DASHES.test(explain));

   // The conformance checklist's own detail column, from a real run.
   const checklist = await stdoutOf(() => run(['conformance', '--root', exampleDir]));
   assert.match(checklist, /freshness horizons are declared and checked \(report-only is acceptable\): /);
   assert.ok(!DASHES.test(checklist));

   // The write plan's read-only note is library data rather than a printed line, so
   // it is asserted where it is produced.
   const plan = buildWritePlan(exampleDir, [], ['README.md']);
   assert.equal(plan[0].note, 'existing file, read-only input; Leji will not modify it');
   assert.ok(!DASHES.test(plan.map((e) => e.note ?? '').join('\n')));
});
