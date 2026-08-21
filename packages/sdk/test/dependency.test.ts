import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type DependencyOffer, dependencyAddFailed, detectEcosystem, offerDependency } from '../dist/index.js';
import { ECOSYSTEM_TEXT } from '../dist/lib/ecosystem.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const casesDir = path.join(repoRoot, 'fixtures', 'ecosystem');

type SpawnResult = { error?: Error; status?: number | null; signal?: NodeJS.Signals | null };

/** A fake `HandoffIo`. Its `run` is the ONLY way this suite could reach a package
 * manager, and it records instead of spawning; `launch` throws, because the
 * declaration offer has no business launching an agent. */
function fakeIo(answer: string, result: SpawnResult = { status: 0 }) {
   const runs: { bin: string; args: string[]; cwd?: string; quiet: boolean }[] = [];
   const questions: string[] = [];
   const io = {
      async readLine(q: string) {
         questions.push(q);
         return answer;
      },
      launch(): SpawnResult {
         throw new Error('the dependency offer must never launch an agent');
      },
      run(bin: string, args: string[], cwd: string | undefined, opts: { quiet: boolean }): SpawnResult {
         runs.push({ bin, args, cwd, quiet: opts.quiet });
         return result;
      },
   };
   return { io, runs, questions };
}

/** Run the offer with console.log captured, so assertions read the printed block
 * and the outcome record together. */
async function offer(
   fixture: string,
   opts: { interactive: boolean; answer?: string; result?: SpawnResult },
): Promise<{ outcome: DependencyOffer; out: string; runs: { bin: string; args: string[]; cwd?: string }[] }> {
   const root = path.join(casesDir, fixture);
   const f = fakeIo(opts.answer ?? '', opts.result);
   const chunks: string[] = [];
   const log = console.log;
   console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(' ') + '\n');
   try {
      const outcome = await offerDependency({
         root,
         report: detectEcosystem(root),
         interactive: opts.interactive,
         io: f.io,
      });
      return { outcome, out: chunks.join(''), runs: f.runs };
   } finally {
      console.log = log;
   }
}

test('offerDependency: yes runs the manager add with argv and cwd, never a shell', async () => {
   const { outcome, out, runs } = await offer('node-pnpm-lock', { interactive: true, answer: 'y' });
   assert.equal(runs.length, 1);
   assert.equal(runs[0].bin, 'pnpm');
   assert.deepEqual(runs[0].args, ['add', '-D', '@leji-org/leji']);
   assert.equal(runs[0].cwd, path.join(casesDir, 'node-pnpm-lock'));
   assert.match(out, /Detected pnpm \(pnpm-lock\.yaml\)\./);
   assert.match(out, /Running: pnpm add -D @leji-org\/leji/);
   assert.match(out, /Declared @leji-org\/leji; a clean install now brings leji\./);
   assert.deepEqual(outcome, {
      offered: true,
      ran: true,
      command: ['pnpm', 'add', '-D', '@leji-org/leji'],
      exitCode: 0,
      signal: null,
   });
   assert.equal(dependencyAddFailed(outcome), false);
});

test('offerDependency: what the run will do is disclosed BEFORE the prompt', async () => {
   // Consent that is asked before the consequence is stated is not consent. The
   // line names the binary, that it runs here with this environment, and what that
   // ordinarily means: a registry call and possibly install scripts.
   const { out } = await offer('node-pnpm-lock', { interactive: true, answer: 'n' });
   const expected =
      'This runs pnpm here with your environment, as when you run it yourself: it will contact its registry and may run install scripts.';
   assert.ok(out.includes(expected), out);
   assert.equal(ECOSYSTEM_TEXT.consent.disclosure('pnpm'), expected, 'one byte-stable string, in the table');
   // Before the prompt, and after the block that names the command.
   assert.ok(out.indexOf('Detected pnpm') < out.indexOf(expected), 'the block comes first');

   // Non-interactive prints the block and nothing else: there is no prompt to
   // disclose for, and nothing can run.
   const quiet = await offer('node-pnpm-lock', { interactive: false });
   assert.ok(!quiet.out.includes('This runs'), quiet.out);
   assert.equal(quiet.runs.length, 0);

   // Every manager gets the line naming its own binary.
   for (const [fixture, bin] of [
      ['python-uv', 'uv'],
      ['go-1.24', 'go'],
      ['node-npm-lock', 'npm'],
   ] as const) {
      const r = await offer(fixture, { interactive: true, answer: 'n' });
      assert.ok(r.out.includes(`This runs ${bin} here with your environment`), `${fixture}: ${r.out}`);
   }
});

test('offerDependency: the prompt is the one the plan names, and Enter accepts', async () => {
   const root = path.join(casesDir, 'node-pnpm-lock');
   const f = fakeIo('');
   const log = console.log;
   console.log = () => {};
   try {
      await offerDependency({ root, report: detectEcosystem(root), interactive: true, io: f.io });
   } finally {
      console.log = log;
   }
   assert.deepEqual(f.questions, [ECOSYSTEM_TEXT.consent.prompt], 'one prompt, unchanged in wording');
   assert.equal(ECOSYSTEM_TEXT.consent.prompt, 'Run it now?');
   assert.equal(f.runs.length, 1, 'Enter is yes');
});

test('offerDependency: declining runs nothing and leaves the exit alone', async () => {
   for (const answer of ['n', 'no', 'q', 'N']) {
      const { outcome, out, runs } = await offer('node-pnpm-lock', { interactive: true, answer });
      assert.equal(runs.length, 0, `"${answer}" must not run the manager`);
      assert.equal(outcome.ran, false);
      assert.equal(outcome.offered, true);
      assert.equal(dependencyAddFailed(outcome), false);
      assert.match(out, /Skipped; declare it later with:\n {3}pnpm add -D @leji-org\/leji/);
   }
});

test('offerDependency: a non-zero add reports the exit and fails the run', async () => {
   const { outcome, out } = await offer('python-uv', {
      interactive: true,
      answer: 'y',
      result: { status: 1, signal: null },
   });
   assert.match(out, /^uv exited 1; run it yourself:$/m);
   assert.match(out, /^ {3}uv add --dev leji$/m);
   assert.equal(outcome.exitCode, 1);
   assert.equal(dependencyAddFailed(outcome), true);
});

test('offerDependency: a signalled add is reported by signal, not by exit code', async () => {
   // Node reports a signalled child as `status: null, signal: <name>`; the offer
   // must not read that null as "exited 0".
   const { outcome, out } = await offer('go-1.24', {
      interactive: true,
      answer: 'y',
      result: { status: null, signal: 'SIGTERM' },
   });
   assert.match(out, /^go was terminated \(SIGTERM\); run it yourself:$/m);
   assert.match(out, /^ {3}go get -tool github\.com\/leji-org\/leji\/packages\/sdk-go\/cmd\/leji@latest$/m);
   assert.deepEqual({ exitCode: outcome.exitCode, signal: outcome.signal }, { exitCode: null, signal: 'SIGTERM' });
   assert.equal(dependencyAddFailed(outcome), true);
});

test('offerDependency: a spawn error is a missing binary, not a failed add', async () => {
   // ENOENT surfaces on `error` with status AND signal null: reading it as an exit
   // code would report "exited 0" and pass a run in which nothing happened.
   const err = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' });
   const { outcome, out } = await offer('node-npm-lock', {
      interactive: true,
      answer: 'y',
      result: { error: err, status: null, signal: null },
   });
   assert.match(out, /^npm is not on your PATH; run it yourself once it is:$/m);
   assert.match(out, /^ {3}npm i -D @leji-org\/leji$/m);
   assert.deepEqual(
      { ran: outcome.ran, exitCode: outcome.exitCode, signal: outcome.signal },
      {
         ran: true,
         exitCode: null,
         signal: null,
      },
   );
   assert.equal(dependencyAddFailed(outcome), true);
});

test('offerDependency: a declared repository is told so and never prompted', async () => {
   const { outcome, out, runs } = await offer('node-declared', { interactive: true, answer: 'y' });
   assert.equal(runs.length, 0);
   assert.equal(outcome.offered, false);
   assert.equal(outcome.ran, false);
   assert.equal(out.trim(), 'The Leji CLI is already declared in package.json.');
});

test('offerDependency: non-interactive prints the block and runs nothing', async () => {
   for (const fixture of ['node-pnpm-lock', 'python-uv', 'go-1.24', 'node-two-lockfiles']) {
      const { outcome, out, runs } = await offer(fixture, { interactive: false, answer: 'y' });
      assert.equal(runs.length, 0, `${fixture}: nothing runs without a real terminal and a yes`);
      assert.equal(outcome.ran, false);
      assert.ok(out.trim().length > 0, `${fixture}: the block is printed in every mode`);
   }
});

test('offerDependency: a print-only manager is never a prompt', async () => {
   // pip and pre-1.24 Go have no add command leji could run, so there is nothing to
   // consent to: the block carries the line to add instead.
   for (const [fixture, needle] of [
      ['python-bare-pyproject', 'pip install --group dev'],
      ['python-requirements-only', 'pip install -r requirements-dev.txt'],
      ['go-1.23-legacy', 'go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest'],
   ] as const) {
      const { outcome, out, runs } = await offer(fixture, { interactive: true, answer: 'y' });
      assert.equal(runs.length, 0, `${fixture}: nothing to run`);
      assert.equal(outcome.offered, false);
      assert.equal(outcome.command, null);
      assert.ok(out.includes(needle), `${fixture}: ${needle}`);
   }
});

test('offerDependency: no manager, no prompt (ambiguous, refused, unreadable, none, multiple)', async () => {
   for (const fixture of [
      'node-two-lockfiles',
      'node-refused-evidence',
      'node-unreadable-manifest',
      'node-packagemanager-unknown',
      'none',
      'multiple-ecosystems',
      'composite-ambiguity',
   ]) {
      const { outcome, runs } = await offer(fixture, { interactive: true, answer: 'y' });
      assert.equal(runs.length, 0, `${fixture}: leji never guesses a manager to run`);
      assert.equal(outcome.offered, false);
      assert.equal(outcome.ran, false);
      assert.equal(dependencyAddFailed(outcome), false);
   }
});

test('offerDependency: the offer writes nothing itself', async () => {
   // leji edits no manifest and no lockfile: the manager owns both formats. The
   // fixture root is byte-identical after an offer that was accepted (the fake
   // records the command instead of running it).
   const root = path.join(casesDir, 'node-pnpm-lock');
   const before = fs.readdirSync(root).map((n) => [n, fs.readFileSync(path.join(root, n), 'utf8')] as const);
   await offer('node-pnpm-lock', { interactive: true, answer: 'y' });
   const after = fs.readdirSync(root).map((n) => [n, fs.readFileSync(path.join(root, n), 'utf8')] as const);
   assert.deepEqual(after, before);
});

test('offerDependency: every consent path is reachable only through the injected io', async () => {
   // The guard behind every test above: with an io whose `run` throws, no path that
   // must not spawn can silently spawn. A real package manager is never reachable
   // from this suite, because `io` is always the fake.
   const explode = {
      async readLine() {
         return 'y';
      },
      launch(): SpawnResult {
         throw new Error('no launch');
      },
      run(): SpawnResult {
         throw new Error('a real package manager was almost spawned');
      },
   };
   const log = console.log;
   console.log = () => {};
   try {
      for (const fixture of ['node-declared', 'python-bare-pyproject', 'none', 'node-two-lockfiles']) {
         const root = path.join(casesDir, fixture);
         const outcome = await offerDependency({ root, report: detectEcosystem(root), interactive: true, io: explode });
         assert.equal(outcome.ran, false, fixture);
      }
      // And non-interactively, for a fixture that DOES have a command to run.
      const root = path.join(casesDir, 'node-pnpm-lock');
      const outcome = await offerDependency({ root, report: detectEcosystem(root), interactive: false, io: explode });
      assert.equal(outcome.ran, false);
   } finally {
      console.log = log;
   }
});

test('offerDependency: the temp-root case, where the offer is the whole output', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-dep-'));
   fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}\n');
   fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
   const f = fakeIo('yes');
   const chunks: string[] = [];
   const log = console.log;
   console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(' ') + '\n');
   let outcome: DependencyOffer;
   try {
      outcome = await offerDependency({ root: dir, report: detectEcosystem(dir), interactive: true, io: f.io });
   } finally {
      console.log = log;
   }
   assert.deepEqual(f.runs[0].args, ['add', '-D', '@leji-org/leji']);
   assert.equal(f.runs[0].bin, 'yarn');
   assert.equal(outcome.exitCode, 0);
   assert.match(chunks.join(''), /Detected yarn \(yarn\.lock\)\./);
});
