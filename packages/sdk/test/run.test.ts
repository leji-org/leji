import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');
const fixture = (name: string) => path.join(repoRoot, 'fixtures', name);

interface Captured {
   code: number;
   out: string;
   err: string;
}

/** Run the CLI in-process (the same entry create-leji uses), capturing output. */
async function runInProcess(argv: string[]): Promise<Captured> {
   const outLines: string[] = [];
   const errLines: string[] = [];
   const origLog = console.log;
   const origError = console.error;
   console.log = (...args: unknown[]) => outLines.push(args.join(' '));
   console.error = (...args: unknown[]) => errLines.push(args.join(' '));
   try {
      const code = await run(argv);
      return { code, out: outLines.join('\n'), err: errLines.join('\n') };
   } finally {
      console.log = origLog;
      console.error = origError;
   }
}

test('run version', async () => {
   const r = await runInProcess(['version']);
   assert.equal(r.code, 0);
   assert.match(r.out, /^\d+\.\d+\.\d+$/);
});

test('--version and -v print the version; -V is not a version flag', async () => {
   const expected = (await runInProcess(['version'])).out;
   for (const flag of ['--version', '-v']) {
      const r = await runInProcess([flag]);
      assert.equal(r.code, 0, flag);
      assert.equal(r.out, expected, flag);
   }
   // -V was removed (no --verbose to guard against); it is now an unknown option.
   const dashV = await runInProcess(['-V']);
   assert.equal(dashV.code, 2);
   assert.match(dashV.err, /unknown option -V/);
});

test('-v short-circuits before a command runs (no side effects)', async () => {
   // -v anywhere wins over the command, so `init -v` prints the version and never
   // scaffolds. Run in a temp dir and assert nothing was written.
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-vflag-'));
   const r = await runInProcess(['init', '--dir', dir, '-v']);
   assert.equal(r.code, 0);
   assert.match(r.out, /^\d+\.\d+\.\d+$/);
   assert.equal(fs.existsSync(path.join(dir, 'leji.json')), false, '-v did not scaffold');
});

test('run usage paths: no command, help, unknown command, bad flag values', async () => {
   assert.equal((await runInProcess([])).code, 2);
   assert.equal((await runInProcess(['help'])).code, 0);
   assert.equal((await runInProcess(['frobnicate'])).code, 2);
   assert.equal((await runInProcess(['validate', '--root'])).code, 2);
   assert.equal((await runInProcess(['init', '--level', 'galactic'])).code, 2);
   assert.equal((await runInProcess(['changelog', 'frobnicate'])).code, 2);
});

test('run validate json on a failing fixture', async () => {
   const r = await runInProcess(['validate', '--root', fixture('invalid-bad-decision'), '--json']);
   assert.equal(r.code, 1);
   const payload = JSON.parse(r.out);
   assert.equal(payload.summary.errors, 2);
});

test('run validate on a missing manifest', async () => {
   const r = await runInProcess(['validate', '--root', fixture('invalid-no-manifest')]);
   assert.equal(r.code, 1);
   assert.match(r.out, /manifest-missing/);
});

test('run index and index --check against a temp copy', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const gen = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(gen.code, 0);
   assert.equal(JSON.parse(gen.out).entries, 3);
   const check = await runInProcess(['index', '--check', '--root', dir, '--json']);
   assert.equal(check.code, 0);
   assert.equal(JSON.parse(check.out).stale, false);
});

test('index auto-seeds the changelog when the layer claims indexed', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-idxcl-'));
   await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo-context']);
   // core init writes no changelog
   assert.equal(fs.existsSync(path.join(dir, 'docs', 'context-changelog.json')), false);
   // claim indexed, then index should complete the surface by seeding the changelog
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('"claimedLevel": "core"', '"claimedLevel": "indexed"'));
   const r = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(r.code, 0, r.out + r.err);
   assert.equal(JSON.parse(r.out).changelog, 'docs/context-changelog.json');
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'context-changelog.json')), 'changelog seeded');
   // a second index run does not re-seed (never overwrites an existing changelog)
   const again = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(JSON.parse(again.out).changelog, undefined, 'not re-seeded');
});

test('index does not seed a changelog on a core layer, and --check never seeds', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-idxcore-'));
   await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo-context']);
   const core = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(JSON.parse(core.out).changelog, undefined, 'core layer: no changelog');
   assert.equal(fs.existsSync(path.join(dir, 'docs', 'context-changelog.json')), false);
   // even when indexed is claimed, --check is read-only and must not seed
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('"claimedLevel": "core"', '"claimedLevel": "indexed"'));
   await runInProcess(['index', '--check', '--root', dir, '--json']);
   assert.equal(fs.existsSync(path.join(dir, 'docs', 'context-changelog.json')), false, '--check did not seed');
});

test('index refuses to write through a symlinked ancestor that escapes the root', async () => {
   const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-outside-'));
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-symesc-'));
   await runInProcess(['init', '--dir', dir, '--yes', '--level', 'indexed', '--name', 'demo']);
   // Point machine.indexPath under docs/evil, a symlink that escapes the layer root.
   fs.symlinkSync(outside, path.join(dir, 'docs', 'evil'));
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.machine = { ...(m.machine ?? {}), indexPath: 'docs/evil/context-index.json' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const r = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(r.code, 1, r.out + r.err);
   assert.ok(
      JSON.parse(r.out).findings.some((f: { message: string }) => /resolves outside the layer root/.test(f.message)),
      'the escape is reported as an error finding',
   );
   assert.equal(fs.existsSync(path.join(outside, 'context-index.json')), false, 'nothing is written outside the root');
});

test('run index against a missing manifest', async () => {
   const r = await runInProcess(['index', '--root', fixture('invalid-no-manifest')]);
   assert.equal(r.code, 1);
});

test('run changelog check without a declared changelog path', async () => {
   const r = await runInProcess(['changelog', 'check', '--root', fixture('valid-minimal-core'), '--json']);
   assert.equal(r.code, 1);
   const payload = JSON.parse(r.out);
   assert.ok(payload.findings.some((f: { rule: string }) => f.rule === 'changelog-required'));
});

test('run index on a core layer with no machine.indexPath writes the default and reports it', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-coreidx-'));
   fs.cpSync(fixture('valid-minimal-core'), dir, { recursive: true });
   const r = await runInProcess(['index', '--root', dir, '--json']);
   assert.equal(r.code, 0, r.out + r.err);
   const payload = JSON.parse(r.out);
   assert.equal(payload.written, 'docs/context-index.json');
   assert.ok(!payload.findings.some((f: { message: string }) => /not declared|no machine/.test(f.message)));
   assert.ok(fs.existsSync(path.join(dir, 'docs', 'context-index.json')), 'default index written');
});

test('run changelog check on a core layer resolves the default changelog path (no "not declared")', async () => {
   const r = await runInProcess(['changelog', 'check', '--root', fixture('valid-minimal-core'), '--json']);
   const payload = JSON.parse(r.out);
   // The default path resolves; the file is simply absent, so the finding is the
   // missing-file changelog-required, never a "not declared" error.
   for (const f of payload.findings as { message: string }[]) {
      assert.ok(!/not declared|no machine/.test(f.message), `no "not declared" message: ${f.message}`);
   }
   assert.ok(
      payload.findings.some(
         (f: { rule: string; message: string }) =>
            f.rule === 'changelog-required' && /docs\/context-changelog\.json does not exist/.test(f.message),
      ),
   );
});

test('run changelog compact without --keep or --before exits 2', async () => {
   const r = await runInProcess(['changelog', 'compact', '--root', exampleDir]);
   assert.equal(r.code, 2);
   assert.match(r.err, /changelog compact requires --keep or --before/);
});

test('run changelog compact --keep folds the oldest and reports counts', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-compact-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const r = await runInProcess(['changelog', 'compact', '--keep', '1', '--root', dir, '--json']);
   assert.equal(r.code, 0, r.out + r.err);
   const payload = JSON.parse(r.out);
   assert.equal(payload.folded, 1); // example has 2 entries; keep newest 1
   assert.equal(payload.kept, 2); // 1 survivor + the compaction entry
   const log = JSON.parse(fs.readFileSync(path.join(dir, 'docs', 'context-changelog.json'), 'utf8'));
   assert.equal(log.entries[log.entries.length - 1].type, 'compaction');
});

test('run changelog check on the example layer', async () => {
   const r = await runInProcess(['changelog', 'check', '--root', exampleDir]);
   assert.equal(r.code, 0);
});

test('run freshness human output and strict', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-fresh-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const invariants = path.join(dir, 'docs', 'system', 'invariants.md');
   fs.writeFileSync(
      invariants,
      fs.readFileSync(invariants, 'utf8').replace('reviewAfter: 2026-12-10', 'reviewAfter: 2020-01-01'),
   );
   const lax = await runInProcess(['freshness', '--root', dir]);
   assert.equal(lax.code, 0);
   assert.match(lax.out, /freshness-expired/);
   const strict = await runInProcess(['freshness', '--root', dir, '--strict']);
   assert.equal(strict.code, 1);
});

test('run conformance human output lists checklist items', async () => {
   const r = await runInProcess(['conformance', '--root', exampleDir]);
   assert.equal(r.code, 0);
   assert.match(r.out, /\[core\]/);
   assert.match(r.out, /manual/);
});

test('run conformance against a missing manifest', async () => {
   const r = await runInProcess(['conformance', '--root', fixture('invalid-no-manifest'), '--json']);
   assert.equal(r.code, 1);
   const payload = JSON.parse(r.out);
   assert.equal(payload.claimedLevel, 'none');
   assert.equal(payload.verifiedLevel, 'none');
});

test('run init --yes then validate through the dispatcher', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-init-'));
   const init = await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo-context']);
   assert.equal(init.code, 0);
   assert.match(init.out, /Wrote 7 files/);
   const again = await runInProcess(['init', '--dir', dir, '--yes']);
   assert.equal(again.code, 2);
   assert.match(again.err, /refuses to overwrite/);
});

test('conformance marks failing core items', async () => {
   const missing = await runInProcess(['conformance', '--root', fixture('invalid-missing-boot-profile'), '--json']);
   assert.equal(missing.code, 1);
   const payload = JSON.parse(missing.out);
   const boot = payload.items.find((i: { id: string }) => i.id === 'boot-profile');
   assert.equal(boot.status, 'fail');
   assert.equal(payload.verifiedLevel, 'none');

   const vendor = await runInProcess(['conformance', '--root', fixture('invalid-vendor-no-redirect'), '--json']);
   const item = JSON.parse(vendor.out).items.find((i: { id: string }) => i.id === 'vendor-redirects');
   assert.equal(item.status, 'fail');
});

test('run viewer generates the viewer and prints the serve hint', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-viewer-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const r = await runInProcess(['viewer', '--root', dir]);
   assert.equal(r.code, 0);
   assert.match(r.out, /serve locally: leji view/);
   assert.ok(fs.existsSync(path.join(dir, 'docs', '.leji', 'viewer', 'index.html')));
   assert.ok(fs.existsSync(path.join(dir, 'docs', '.leji', 'viewer', '_sidebar.md')));
});

test('run viewer against a missing manifest', async () => {
   const r = await runInProcess(['viewer', '--root', fixture('invalid-no-manifest')]);
   assert.equal(r.code, 1);
   assert.match(r.out, /manifest-missing/);
});

test('run viewer serve binds a server, serves the viewer, then exits on signal', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-serve-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   const { execFile } = await import('node:child_process');
   const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
   const child = execFile('node', [cliPath, 'viewer', 'serve', '--port', '0', '--root', dir]);
   try {
      // Wait for the "serving http://localhost:<port>/..." line to learn the port.
      const port = await new Promise<number>((resolve, reject) => {
         const timer = setTimeout(() => reject(new Error('timed out waiting for serve line')), 5000);
         child.stdout!.on('data', (chunk: Buffer) => {
            const m = /serving http:\/\/localhost:(\d+)\//.exec(chunk.toString());
            if (m) {
               clearTimeout(timer);
               resolve(Number(m[1]));
            }
         });
      });
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /viewer-boot\.js/);
   } finally {
      // SIGINT closes the server, resolving the keep-alive promise so run() returns.
      child.kill('SIGINT');
   }
});

test('bare viewer rejects --open (a serve-only flag)', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-open-'));
   fs.cpSync(exampleDir, dir, { recursive: true });
   // --open belongs to `viewer serve`/`view`, not bare `viewer` (which only generates).
   const r = await runInProcess(['viewer', '--open', '--root', dir]);
   assert.equal(r.code, 2, r.out + r.err);
   assert.match(r.out + r.err, /not valid for "viewer"/);
});

test('view is a recognized command (dispatches; no manifest exits 1, never hangs)', async () => {
   // `view` (alias for `viewer serve`) must dispatch, not be an unknown command. On a
   // dir with no manifest it returns before binding a server, so this can't hang.
   const r = await runInProcess(['view', '--root', path.join(os.tmpdir(), 'leji-none-serve-xyz')]);
   assert.equal(r.code, 1);
   assert.match(r.out + r.err, /manifest-missing|no leji\.json/);
});

test('ci: writes the workflow when absent, is idempotent, and exits 1 with no manifest', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-ci-'));
   await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo']);
   const wf = path.join(dir, '.github', 'workflows', 'leji.yml');
   assert.equal(fs.existsSync(wf), false, 'core init writes no CI workflow');
   const first = await runInProcess(['ci', '--root', dir]);
   assert.equal(first.code, 0);
   assert.match(first.out, /Wrote .*leji\.yml/);
   assert.ok(fs.existsSync(wf), 'workflow written');
   const before = fs.readFileSync(wf, 'utf8');
   const again = await runInProcess(['ci', '--root', dir, '--json']);
   assert.equal(again.code, 0);
   assert.equal(JSON.parse(again.out).created, false, 'idempotent: not re-created');
   assert.equal(fs.readFileSync(wf, 'utf8'), before, 'existing workflow left untouched');
   const none = await runInProcess(['ci', '--root', path.join(os.tmpdir(), 'leji-none-ci-xyz')]);
   assert.equal(none.code, 1);
   assert.match(none.out + none.err, /manifest-missing|no leji\.json/);
});

const GITLAB_BLOCK = `# >>> leji ci (managed) >>>
leji-validate:
  image: node:22
  script:
    - npx -y @leji-org/leji@latest validate
# <<< leji ci (managed) <<<
`;

const CIRCLE_CONFIG = `version: 2.1
jobs:
  leji-validate:
    docker:
      - image: node:22
    steps:
      - checkout
      - run: npx -y @leji-org/leji@latest validate
workflows:
  leji:
    jobs:
      - leji-validate
`;

const CIRCLE_SNIPPET = `jobs:
  leji-validate:
    docker:
      - image: node:22
    steps:
      - checkout
      - run: npx -y @leji-org/leji@latest validate
workflows:
  leji:
    jobs:
      - leji-validate
`;

const AZURE_PIPELINE = `trigger:
  - main
pool:
  vmImage: ubuntu-latest
steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '22.x'
  - script: npx -y @leji-org/leji@latest validate
    displayName: leji validate
`;

async function seededCiDir(prefix: string): Promise<string> {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
   await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo']);
   return dir;
}

test('ci --provider github: explicit github matches the default, JSON carries provider/action/created', async () => {
   const dir = await seededCiDir('leji-ci-gh-');
   const r = await runInProcess(['ci', '--root', dir, '--provider', 'github', '--json']);
   assert.equal(r.code, 0);
   const j = JSON.parse(r.out);
   assert.equal(j.provider, 'github');
   assert.equal(j.action, 'created');
   assert.equal(j.created, true);
   assert.equal(j.workflow, '.github/workflows/leji.yml');
   assert.ok(fs.existsSync(path.join(dir, '.github', 'workflows', 'leji.yml')));
});

test('ci --provider gitlab: creates the managed block, is idempotent', async () => {
   const dir = await seededCiDir('leji-ci-gl-');
   const gl = path.join(dir, '.gitlab-ci.yml');
   const created = await runInProcess(['ci', '--root', dir, '--provider', 'gitlab', '--json']);
   assert.equal(created.code, 0);
   const j = JSON.parse(created.out);
   assert.equal(j.provider, 'gitlab');
   assert.equal(j.action, 'created');
   assert.equal(fs.readFileSync(gl, 'utf8'), GITLAB_BLOCK, 'new file is exactly the managed block');
   const again = await runInProcess(['ci', '--root', dir, '--provider', 'gitlab', '--json']);
   assert.equal(JSON.parse(again.out).action, 'unchanged');
   assert.equal(fs.readFileSync(gl, 'utf8'), GITLAB_BLOCK, 'idempotent byte-for-byte');
});

test('ci --provider gitlab: appends to an existing config, byte-exactly, for every trailing-newline case', async () => {
   const cases: Array<[string, string, string]> = [
      ['trailing newline', 'stages:\n  - test\n', 'stages:\n  - test\n' + '\n' + GITLAB_BLOCK],
      ['no trailing newline', 'stages:\n  - test', 'stages:\n  - test' + '\n\n' + GITLAB_BLOCK],
      ['empty file', '', GITLAB_BLOCK],
   ];
   for (const [label, base, expected] of cases) {
      const dir = await seededCiDir('leji-ci-glm-');
      const gl = path.join(dir, '.gitlab-ci.yml');
      fs.writeFileSync(gl, base);
      const r = await runInProcess(['ci', '--root', dir, '--provider', 'gitlab']);
      assert.equal(r.code, 0, label);
      assert.equal(fs.readFileSync(gl, 'utf8'), expected, `${label}: byte-exact merge`);
      const again = await runInProcess(['ci', '--root', dir, '--provider', 'gitlab', '--json']);
      assert.equal(JSON.parse(again.out).action, 'unchanged', `${label}: idempotent re-run`);
   }
});

test('ci --provider gitlab: replaces a stale managed block, preserving surrounding content', async () => {
   const dir = await seededCiDir('leji-ci-glr-');
   const gl = path.join(dir, '.gitlab-ci.yml');
   const stale = '# >>> leji ci (managed) >>>\nleji-validate:\n  image: node:18\n# <<< leji ci (managed) <<<\n';
   fs.writeFileSync(gl, 'before:\n  keep: 1\n\n' + stale + '\nafter:\n  keep: 2\n');
   const r = await runInProcess(['ci', '--root', dir, '--provider', 'gitlab']);
   assert.equal(r.code, 0);
   const out = fs.readFileSync(gl, 'utf8');
   assert.equal(out, 'before:\n  keep: 1\n\n' + GITLAB_BLOCK + '\nafter:\n  keep: 2\n');
   assert.ok(!out.includes('node:18'), 'stale block replaced');
});

test('ci --provider circleci: creates when absent, prints a snippet (no edit) when present', async () => {
   const dir = await seededCiDir('leji-ci-cc-');
   const cc = path.join(dir, '.circleci', 'config.yml');
   const created = await runInProcess(['ci', '--root', dir, '--provider', 'circleci', '--json']);
   assert.equal(created.code, 0);
   assert.equal(JSON.parse(created.out).action, 'created');
   assert.equal(fs.readFileSync(cc, 'utf8'), CIRCLE_CONFIG, 'created config is byte-exact');
   const before = fs.readFileSync(cc, 'utf8');
   const manual = await runInProcess(['ci', '--root', dir, '--provider', 'circleci', '--json']);
   assert.equal(manual.code, 0);
   const j = JSON.parse(manual.out);
   assert.equal(j.action, 'manual');
   assert.equal(j.created, false);
   assert.equal(j.snippet, CIRCLE_SNIPPET, 'manual snippet is byte-exact');
   assert.equal(fs.readFileSync(cc, 'utf8'), before, 'existing config left untouched');
});

test('ci --provider azure: dedicated pipeline file + activation note (JSON and human), idempotent, byte-exact', async () => {
   const d1 = await seededCiDir('leji-ci-az-');
   const az = path.join(d1, '.azure-pipelines', 'leji.yml');
   const created = await runInProcess(['ci', '--root', d1, '--provider', 'azure', '--json']);
   assert.equal(created.code, 0);
   const j = JSON.parse(created.out);
   assert.equal(j.provider, 'azure');
   assert.equal(j.action, 'created');
   assert.equal(j.created, true);
   assert.equal(j.workflow, '.azure-pipelines/leji.yml');
   assert.match(j.note, /Azure Pipelines does not auto-run/);
   assert.equal(fs.readFileSync(az, 'utf8'), AZURE_PIPELINE, 'pipeline file is byte-exact');
   const again = await runInProcess(['ci', '--root', d1, '--provider', 'azure', '--json']);
   assert.equal(JSON.parse(again.out).action, 'unchanged', 'idempotent');
   // a fresh create prints the activation note in human output
   const d2 = await seededCiDir('leji-ci-az2-');
   const h = await runInProcess(['ci', '--root', d2, '--provider', 'azure']);
   assert.match(h.out, /Wrote .*\.azure-pipelines\/leji\.yml/);
   assert.match(h.out, /Azure Pipelines does not auto-run this file/);
});

test('ci --provider: invalid value and missing value both fail with usage exit 2', async () => {
   const dir = await seededCiDir('leji-ci-bad-');
   const bad = await runInProcess(['ci', '--root', dir, '--provider', 'bogus']);
   assert.equal(bad.code, 2);
   assert.match(bad.err, /unknown provider "bogus"; expected github, gitlab, circleci, or azure/);
   const missing = await runInProcess(['ci', '--root', dir, '--provider']);
   assert.equal(missing.code, 2);
   assert.match(missing.err, /--provider requires a value/);
});

test('ci: refuses to write through a symlink that escapes the root', async () => {
   // GitLab guards before it reads/rewrites, so a symlinked target file pointing
   // outside the root is refused outright (no read, no write).
   {
      const dir = await seededCiDir('leji-ci-sym-gl-');
      fs.symlinkSync('/etc/hosts', path.join(dir, '.gitlab-ci.yml'));
      const r = await runInProcess(['ci', '--root', dir, '--provider', 'gitlab']);
      assert.equal(r.code, 2);
      assert.match(r.err, /refusing to write through a symlink that escapes the target/);
   }
   // Every provider guards before touching the target, so a final-file symlink that
   // escapes the root is refused outright (no read, no write) even when it exists.
   for (const [provider, targetRel] of [
      ['github', '.github/workflows/leji.yml'],
      ['circleci', '.circleci/config.yml'],
      ['azure', '.azure-pipelines/leji.yml'],
   ] as const) {
      const dir = await seededCiDir('leji-ci-sym-target-');
      const target = path.join(dir, targetRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync('/etc/hosts', target);
      const r = await runInProcess(['ci', '--root', dir, '--provider', provider]);
      assert.equal(r.code, 2, `${provider}: escaping target symlink refused`);
      assert.match(r.err, /refusing to write through a symlink that escapes the target/);
   }
   // A symlinked PARENT directory that escapes the root is likewise caught before
   // any write happens.
   for (const [provider, parentRel] of [
      ['github', '.github/workflows'],
      ['circleci', '.circleci'],
      ['azure', '.azure-pipelines'],
   ] as const) {
      const dir = await seededCiDir('leji-ci-sym-parent-');
      const parent = path.join(dir, parentRel);
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      fs.symlinkSync('/etc', parent);
      const r = await runInProcess(['ci', '--root', dir, '--provider', provider]);
      assert.equal(r.code, 2, `${provider}: escaping parent dir refused`);
      assert.match(r.err, /refusing to write through a symlink that escapes the target/);
   }
   // The atomic-write sibling temp path (`<target>.leji-tmp`) must also be guarded.
   for (const [provider, targetRel] of [
      ['github', '.github/workflows/leji.yml'],
      ['gitlab', '.gitlab-ci.yml'],
      ['circleci', '.circleci/config.yml'],
      ['azure', '.azure-pipelines/leji.yml'],
   ] as const) {
      const dir = await seededCiDir('leji-ci-sym-tmp-');
      const tmp = path.join(dir, `${targetRel}.leji-tmp`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.symlinkSync('/etc/hosts', tmp);
      const r = await runInProcess(['ci', '--root', dir, '--provider', provider]);
      assert.equal(r.code, 2, `${provider}: escaping temp symlink refused`);
      assert.match(r.err, /refusing to write through a symlink that escapes the target/);
   }
});

test('ci: an unwritable target dir yields a normalized, OS-text-free error', async () => {
   // Root bypasses permission bits, so the write would succeed; skip there.
   if (typeof process.getuid === 'function' && process.getuid() === 0) return;
   const dir = await seededCiDir('leji-ci-unwritable-');
   const wf = path.join(dir, '.github', 'workflows');
   fs.mkdirSync(wf, { recursive: true });
   fs.chmodSync(wf, 0o555);
   try {
      const r = await runInProcess(['ci', '--root', dir, '--provider', 'github']);
      assert.equal(r.code, 2);
      assert.match(r.err, /^leji: cannot write "\.github\/workflows\/leji\.yml": permission denied$/m);
   } finally {
      fs.chmodSync(wf, 0o755); // restore so the temp tree can be cleaned up
   }
});

test('ci: a write failure after the temp file cleans up, leaving no partial artifact', async () => {
   const dir = await seededCiDir('leji-ci-failrename-');
   process.env.LEJI_TEST_FAIL_RENAME = '1';
   try {
      const r = await runInProcess(['ci', '--root', dir, '--provider', 'github']);
      assert.equal(r.code, 2);
      assert.match(r.err, /cannot write "\.github\/workflows\/leji\.yml"/);
      assert.ok(!r.err.includes('permission denied'), 'generic write error, not a permission error');
      assert.equal(fs.existsSync(path.join(dir, '.github', 'workflows', 'leji.yml')), false);
      assert.equal(fs.existsSync(path.join(dir, '.github', 'workflows', 'leji.yml.leji-tmp')), false);
   } finally {
      delete process.env.LEJI_TEST_FAIL_RENAME;
   }
});

test('start: no manifest exits 1; on a layer (non-TTY) it falls back to the boot commands, never hangs', async () => {
   const none = await runInProcess(['start', '--root', path.join(os.tmpdir(), 'leji-none-start-xyz')]);
   assert.equal(none.code, 1);
   assert.match(none.out + none.err, /manifest-missing|no leji\.json/);
   // A real core layer, non-TTY: interactive=false → print the boot commands, exit 0.
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-start-'));
   await runInProcess(['init', '--dir', dir, '--yes', '--name', 'demo']);
   const ok = await runInProcess(['start', '--root', dir]);
   assert.equal(ok.code, 0, ok.out + ok.err);
   assert.match(ok.out, /To enter this context layer/);
});

test('init interactive forces domain when both domain and system are declined', async () => {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-run-force-'));
   // name, description, root, owner name, owner contact, domain n, system n,
   // practice n, governance n, indexed n
   const answers = ['', '', '', 'Jo', '', 'n', 'n', 'n', 'n', 'n'];
   const { execFile } = await import('node:child_process');
   const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
   const result = await new Promise<{ code: number; out: string }>((resolve) => {
      let out = '';
      const child = execFile('node', [cliPath, 'init', '--dir', dir], (error) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out });
      });
      child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
      child.stdin!.write(answers.join('\n') + '\n');
      child.stdin!.end();
   });
   assert.equal(result.code, 0);
   const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'leji.json'), 'utf8'));
   assert.ok(manifest.categories.domain, 'domain was forced in');
   // Gating guard: stdin is a pipe (not a TTY), so the handoff offer must NOT fire
   // even if a real agent binary is on PATH. The static instructions print instead.
   assert.doesNotMatch(result.out, /Hand the scaffold to|Detected coding agents|Starting /);
   assert.match(result.out, /populate from your actual repository/);
});
