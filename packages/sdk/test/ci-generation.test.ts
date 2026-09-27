import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureCiWorkflow, ensureLocalHook } from '../dist/index.js';
import { CI_PROVIDERS, HOOK_BODY, HUSKY_BLOCK, KNOWN_GENERATED, ciVariants, shQuote } from '../dist/commands/init.js';
import { detectEcosystem, managerRunnerArgv, runnerArgv } from '../dist/lib/ecosystem.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const goldens = path.join(repoRoot, 'fixtures', 'ci-goldens');
const golden = (name: string) => fs.readFileSync(path.join(goldens, name), 'utf8');

const REL: Record<string, string> = {
   github: '.github/workflows/leji.yml',
   gitlab: '.gitlab-ci.yml',
   circleci: '.circleci/config.yml',
   azure: '.azure-pipelines/leji.yml',
};

function plant(files: Record<string, string>): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-ci-gen-'));
   for (const [rel, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), body);
   return dir;
}

/** The providers that own a whole file, and the committed bytes of their earlier releases. */
const WHOLE_FILE = ['github', 'circleci', 'azure'] as const;
const HISTORICAL = (p: string) => [
   `legacy-1.3-${p}-local.yml`,
   `legacy-1.3-${p}-fallback.yml`,
   `legacy-1.4-${p}-node-fallback.yml`,
];
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const declaredPkg = (extra = {}) =>
   JSON.stringify({ name: 'demo', devDependencies: { '@leji-org/leji': '^1' }, ...extra }, null, 2) + '\n';

/** A repository that declares the CLI and carries the manager's lock evidence. */
const ROOTS = {
   pnpm: { 'package.json': declaredPkg(), 'pnpm-lock.yaml': '' },
   npm: { 'package.json': declaredPkg(), 'package-lock.json': '' },
   uv: { 'pyproject.toml': '[project]\nname = "d"\nversion = "0"\ndependencies = ["leji"]\n', 'uv.lock': '' },
   go: {
      'go.mod': 'module example.com/d\n\ngo 1.24.0\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n',
   },
   undeclared: { 'package.json': '{"name":"demo"}\n', 'package-lock.json': '' },
   none: {},
};

// --- the goldens -----------------------------------------------------------

test('ci goldens: every generated variant matches its committed bytes', () => {
   const variants = ciVariants();
   assert.equal(variants.length, CI_PROVIDERS.length * 12, 'nine local managers plus three fallbacks per provider');
   for (const v of variants) {
      assert.equal(v.bytes, golden(`${v.provider}-${v.key}.yml`), `${v.provider}/${v.key}`);
   }
   // And nothing committed is orphaned: every golden is produced by the generator.
   const expected = new Set([
      ...variants.map((v) => `${v.provider}-${v.key}.yml`),
      ...['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pdm', 'pipenv', 'go', 'fallback'].flatMap((m) => [
         `hook-${m}.sh`,
         `husky-${m}.sh`,
      ]),
      ...WHOLE_FILE.flatMap((p) => HISTORICAL(p)),
      'action-pins.json',
   ]);
   assert.deepEqual(fs.readdirSync(goldens).sort(), [...expected].sort());
});

test('ci goldens: the hook bodies match, for every runner', () => {
   for (const m of ['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'pdm', 'pipenv', 'go']) {
      const argv = managerRunnerArgv(m)!;
      assert.equal(HOOK_BODY(argv), golden(`hook-${m}.sh`), m);
      assert.equal(HUSKY_BLOCK(argv), golden(`husky-${m}.sh`), m);
   }
   assert.equal(HOOK_BODY(['leji']), golden('hook-fallback.sh'));
   assert.equal(HUSKY_BLOCK(['leji']), golden('husky-fallback.sh'));
});

test('ci: the digests of this release, for the next release to append to KNOWN_GENERATED', () => {
   // Not an assertion about the registry's contents: the CURRENT variants are matched
   // by bytes, which is stronger than a digest. This prints what the NEXT release
   // must carry once these bytes are history.
   const lines = ciVariants().map((v) => `   '${sha256(v.bytes)}', // ${v.provider} ${v.key}`);
   assert.equal(lines.length, 48);
   if (process.env.LEJI_PRINT_CI_DIGESTS) console.log(lines.join('\n'));
});

test('ci pins: every action the GitHub template uses carries the tag action-pins.json records', () => {
   // The roster is the definition of "current": an action it does not name, a
   // reference that is not a release tag, or a tag other than the recorded one fails.
   // A floating major (`v7`) and an exact release (`v10.2.0`) are both tags, and the
   // emitted one must equal the recorded one exactly, so neither turns into the other.
   const { refreshed, ...pins } = JSON.parse(golden('action-pins.json')) as Record<string, string>;
   assert.match(refreshed, /^\d{4}-\d{2}-\d{2}$/, 'the roster records the day it was refreshed');
   let seen = 0;
   for (const v of ciVariants().filter((v) => v.provider === 'github')) {
      for (const line of v.bytes.split('\n').filter((l) => /\buses:/.test(l))) {
         seen++;
         const ref = /^\s*- uses: ([\w.-]+\/[\w.-]+)@(v\d+(?:\.\d+\.\d+)?)$/.exec(line);
         assert.ok(
            ref,
            `github/${v.key}: malformed reference, want <owner>/<name>@v<major>[.<minor>.<patch>]: ${line}`,
         );
         const [, action, tag] = ref;
         assert.ok(Object.hasOwn(pins, action), `github/${v.key}: ${action} is not in action-pins.json`);
         assert.equal(
            tag,
            pins[action],
            `github/${v.key}: ${action}@${tag}, but action-pins.json records ${pins[action]}`,
         );
      }
   }
   assert.ok(seen > 0, 'the GitHub template uses at least one action');
});

/** A registry's digests per provider, read from another SDK's source as text: only
 * the lines inside the registry literal, each under the provider block it sits in. */
function registryFromSource(file: string, opener: string): Record<string, string[]> {
   const src = fs.readFileSync(path.join(repoRoot, file), 'utf8');
   const start = src.indexOf(opener);
   assert.ok(start >= 0, `${file}: the registry "${opener}" was not found`);
   const out: Record<string, string[]> = {};
   let provider: string | null = null;
   for (const line of src.slice(start + opener.length, src.indexOf('\n}', start)).split('\n')) {
      const key = /^\s*"(\w+)":/.exec(line);
      if (key) out[(provider = key[1])] = [];
      const digest = /^\s*"([0-9a-f]{64})",/.exec(line);
      if (digest) {
         assert.ok(provider, `${file}: a digest outside any provider block`);
         out[provider].push(digest[1]);
      }
   }
   return out;
}

test('ci registry: the three SDKs register the same digests per provider, every earlier release among them', () => {
   const registries = {
      python: registryFromSource('packages/sdk-py/src/leji/cigen.py', 'KNOWN_GENERATED: dict[str, list[str]] = {'),
      go: registryFromSource(
         'packages/sdk-go/internal/commands/init/cigen.go',
         'var knownGenerated = map[string][]string{',
      ),
   };
   for (const [sdk, registry] of Object.entries(registries)) {
      assert.deepEqual(Object.keys(registry).sort(), [...CI_PROVIDERS].sort(), `${sdk}: the provider blocks`);
      for (const provider of CI_PROVIDERS) {
         assert.deepEqual(registry[provider].sort(), [...KNOWN_GENERATED[provider]].sort(), `${sdk}/${provider}`);
      }
   }
   // Equal sets could be equally incomplete: each must hold every committed earlier file.
   for (const provider of WHOLE_FILE) {
      for (const earlier of HISTORICAL(provider)) {
         assert.ok(
            KNOWN_GENERATED[provider].includes(sha256(golden(earlier))),
            `${provider}: ${earlier} is registered`,
         );
      }
   }
});

test(
   'ci registry: every whole file this release writes is registered, for the next release to recognize',
   {
      skip:
         process.env.LEJI_CI_DIGESTS_PENDING === '1'
            ? "LEJI_CI_DIGESTS_PENDING=1: this release's digests are appended at the release pre-flight"
            : false,
   },
   () => {
      const missing = ciVariants()
         .filter((v) => v.provider !== 'gitlab' && !KNOWN_GENERATED[v.provider].includes(sha256(v.bytes)))
         .map((v) => `${v.provider} ${v.key} ${sha256(v.bytes)}`);
      assert.deepEqual(missing, [], 'append these to the registry in all three SDKs (LEJI_PRINT_CI_DIGESTS=1)');
   },
);

// --- the table -------------------------------------------------------------

test('ci table: a declared, lock-evidenced repository gets its own manager job', () => {
   for (const [name, expected] of [
      ['pnpm', 'pnpm-local'],
      ['npm', 'npm-local'],
      ['uv', 'uv-local'],
      ['go', 'go-local'],
   ] as const) {
      const dir = plant(ROOTS[name]);
      for (const provider of CI_PROVIDERS) {
         const r = ensureCiWorkflow(dir, provider);
         assert.equal(r.action, 'created', `${name}/${provider}`);
         assert.equal(
            fs.readFileSync(path.join(dir, REL[provider]), 'utf8'),
            golden(`${provider}-${expected}.yml`),
            `${name}/${provider}`,
         );
      }
   }
});

test('ci table: local needs BOTH the declaration and the lock evidence', () => {
   // Declared but no lockfile: `npm ci`-class installs would fail before leji ran.
   const unlocked = plant({ 'package.json': declaredPkg() });
   ensureCiWorkflow(unlocked, 'github');
   assert.equal(
      fs.readFileSync(path.join(unlocked, REL.github), 'utf8'),
      golden('github-node-fallback.yml'),
      'declared without a lock takes the fallback',
   );
   // Locked but undeclared: `npx --no-install` would find nothing.
   const undeclared = plant(ROOTS.undeclared);
   ensureCiWorkflow(undeclared, 'github');
   assert.equal(fs.readFileSync(path.join(undeclared, REL.github), 'utf8'), golden('github-node-fallback.yml'));
});

test('ci table: each ecosystem falls back to a job that needs no manifest', () => {
   const cases: [Record<string, string>, string][] = [
      [ROOTS.none, 'node-fallback'],
      [ROOTS.undeclared, 'node-fallback'],
      [{ 'package.json': '{}\n', 'package-lock.json': '', 'yarn.lock': '' }, 'node-fallback'], // ambiguous
      [{ 'package.json': '{"packageManager":"hermit@1.0.0"}\n' }, 'node-fallback'], // unsupported
      [{ 'pyproject.toml': '[project]\nname = "d"\nversion = "0"\n' }, 'python-fallback'],
      [{ 'requirements.txt': 'requests\n' }, 'python-fallback'],
      [{ 'go.mod': 'module example.com/d\n\ngo 1.23\n' }, 'go-fallback'],
      [{ 'go.mod': 'module example.com/d\n\ngo 1.24.0\n' }, 'go-fallback'], // 1.24 but undeclared
      [{ 'package.json': '{}\n', 'pyproject.toml': '[project]\nname="d"\nversion="0"\n' }, 'node-fallback'], // multiple
   ];
   for (const [files, expected] of cases) {
      const dir = plant(files);
      ensureCiWorkflow(dir, 'github');
      assert.equal(fs.readFileSync(path.join(dir, REL.github), 'utf8'), golden(`github-${expected}.yml`), expected);
   }
});

test('ci table: the bootstrap disclosure appears exactly once, only where a tool is unpinned', () => {
   const note = /^\s*#\s(poetry|pdm|pipenv|uv) is installed unpinned here; pin it if your project pins it\.$/m;
   for (const v of ciVariants()) {
      const hits = v.bytes.split('\n').filter((l) => /is installed unpinned here/.test(l));
      const wantsNote = /^(poetry|pdm|pipenv)-local$/.test(v.key) || (v.key === 'uv-local' && v.provider !== 'github');
      assert.equal(hits.length, wantsNote ? 1 : 0, `${v.provider}/${v.key}`);
      if (wantsNote) assert.match(v.bytes, note, `${v.provider}/${v.key}`);
   }
   // uv on GitHub uses its own setup action, so nothing is pip-installed there.
   assert.match(golden('github-uv-local.yml'), /astral-sh\/setup-uv@v10\.2\.0/);
   assert.doesNotMatch(golden('github-uv-local.yml'), /pip install uv/);
   assert.match(golden('gitlab-uv-local.yml'), /pip install uv && uv sync --locked/);
});

test('ci: the marker names the generator version on every whole file, and never inside the GitLab block', () => {
   for (const v of ciVariants()) {
      if (v.provider === 'gitlab') {
         assert.doesNotMatch(v.bytes, /generated by leji ci \(managed\)/, 'the GitLab block keeps its own markers');
         assert.match(v.bytes, /^# >>> leji ci \(managed\) >>>\n/);
      } else {
         assert.match(v.bytes, /^# generated by leji ci \(managed\) v2\n/, `${v.provider}/${v.key}`);
      }
   }
});

// --- ownership -------------------------------------------------------------

test('ci ownership: a file generated by an EARLIER release is upgraded, not abandoned', () => {
   for (const provider of WHOLE_FILE) {
      for (const earlier of HISTORICAL(provider)) {
         const dir = plant(ROOTS.pnpm);
         const abs = path.join(dir, REL[provider]);
         fs.mkdirSync(path.dirname(abs), { recursive: true });
         fs.writeFileSync(abs, golden(earlier));
         const r = ensureCiWorkflow(dir, provider);
         assert.equal(r.action, 'updated', earlier);
         assert.equal(fs.readFileSync(abs, 'utf8'), golden(`${provider}-pnpm-local.yml`), earlier);
      }
   }
});

test('ci ownership: the legacy registry is scoped to its own provider', () => {
   // The same bytes are leji's workflow at one provider's path and somebody else's
   // file at another's. A digest match must therefore be provider-scoped, or a
   // hand-written Azure pipeline that happens to hold CircleCI-shaped bytes gets
   // silently replaced.
   const CROSS: [string, string][] = [
      ['github', 'legacy-1.3-circleci-local.yml'],
      ['github', 'legacy-1.3-azure-fallback.yml'],
      ['circleci', 'legacy-1.3-github-local.yml'],
      ['circleci', 'legacy-1.3-azure-local.yml'],
      ['azure', 'legacy-1.3-github-fallback.yml'],
      ['azure', 'legacy-1.3-circleci-fallback.yml'],
   ];
   for (const [provider, foreign] of CROSS) {
      const dir = plant(ROOTS.pnpm);
      const abs = path.join(dir, REL[provider]);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const bytes = golden(foreign);
      fs.writeFileSync(abs, bytes);
      const r = ensureCiWorkflow(dir, provider as 'github' | 'circleci' | 'azure');
      assert.equal(r.action, 'manual', `${foreign} at the ${provider} path is foreign`);
      assert.equal(fs.readFileSync(abs, 'utf8'), bytes, `${provider}: left untouched`);
   }
   // And the same bytes at their OWN provider's path are still recognized.
   for (const provider of ['github', 'circleci', 'azure'] as const) {
      const dir = plant(ROOTS.pnpm);
      const abs = path.join(dir, REL[provider]);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, golden(`legacy-1.3-${provider}-local.yml`));
      assert.equal(ensureCiWorkflow(dir, provider).action, 'updated', provider);
   }
});

test('ci ownership: a re-run is byte-identical and reported unchanged', () => {
   for (const provider of CI_PROVIDERS) {
      const dir = plant(ROOTS.uv);
      assert.equal(ensureCiWorkflow(dir, provider).action, 'created', provider);
      const after = fs.readFileSync(path.join(dir, REL[provider]), 'utf8');
      const again = ensureCiWorkflow(dir, provider);
      assert.equal(again.action, 'unchanged', provider);
      assert.equal(fs.readFileSync(path.join(dir, REL[provider]), 'utf8'), after, provider);
   }
});

test('ci ownership: a manager change rewrites the job leji owns', () => {
   const dir = plant(ROOTS.pnpm);
   const abs = path.join(dir, REL.github);
   fs.mkdirSync(path.dirname(abs), { recursive: true });
   // A file this generator wrote for a different manager: still leji's.
   fs.writeFileSync(abs, golden('github-npm-local.yml'));
   const r = ensureCiWorkflow(dir, 'github');
   assert.equal(r.action, 'updated');
   assert.equal(fs.readFileSync(abs, 'utf8'), golden('github-pnpm-local.yml'));
});

test('ci ownership: an edited generated file and a foreign file are both left alone', () => {
   for (const provider of WHOLE_FILE) {
      // Edited: the marker is still there, the bytes are not ours. The edit IS the
      // opt-out, so it is honored rather than overwritten, whether the file came from
      // this release or an earlier one.
      for (const base of [`${provider}-pnpm-local.yml`, `legacy-1.4-${provider}-node-fallback.yml`]) {
         const edited = plant(ROOTS.pnpm);
         const eAbs = path.join(edited, REL[provider]);
         fs.mkdirSync(path.dirname(eAbs), { recursive: true });
         const mine = golden(base) + '      - run: echo mine\n';
         fs.writeFileSync(eAbs, mine);
         const eRes = ensureCiWorkflow(edited, provider);
         assert.equal(eRes.action, 'manual', `${base} edited`);
         assert.ok(eRes.snippet, `${base} edited: a snippet to merge by hand`);
         assert.equal(fs.readFileSync(eAbs, 'utf8'), mine, `${base}: untouched`);
      }

      const foreign = plant(ROOTS.pnpm);
      const fAbs = path.join(foreign, REL[provider]);
      fs.mkdirSync(path.dirname(fAbs), { recursive: true });
      fs.writeFileSync(fAbs, 'name: someone-elses-pipeline\n');
      const fRes = ensureCiWorkflow(foreign, provider);
      assert.equal(fRes.action, 'manual', `${provider} foreign`);
      assert.equal(fs.readFileSync(fAbs, 'utf8'), 'name: someone-elses-pipeline\n', `${provider}: untouched`);
   }
});

test('ci ownership: GitLab still owns only its marked block', () => {
   const dir = plant(ROOTS.pnpm);
   const abs = path.join(dir, REL.gitlab);
   fs.writeFileSync(abs, 'stages:\n  - test\n');
   assert.equal(ensureCiWorkflow(dir, 'gitlab').action, 'updated');
   const merged = fs.readFileSync(abs, 'utf8');
   assert.ok(merged.startsWith('stages:\n  - test\n'), 'the surrounding config is preserved');
   assert.ok(merged.includes(golden('gitlab-pnpm-local.yml')), 'the managed block is exact');
});

// --- the hook --------------------------------------------------------------

test('hook: the runner is the repository’s when the CLI is declared, else the plain binary', () => {
   for (const [name, expected] of [
      ['pnpm', ['pnpm', 'exec', 'leji']],
      ['uv', ['uv', 'run', 'leji']],
      ['go', ['go', 'tool', 'leji']],
      ['undeclared', ['leji']],
      ['none', ['leji']],
   ] as const) {
      const dir = plant(ROOTS[name]);
      assert.deepEqual(runnerArgv(detectEcosystem(dir)), expected, name);
   }
});

test('hook: every argv element is single-quoted for sh, with the one legal escape', () => {
   assert.equal(shQuote('pnpm'), "'pnpm'");
   assert.equal(shQuote("we'ird"), "'we'\\''ird'");
   assert.equal(shQuote('a b'), "'a b'");
   assert.equal(shQuote('x$HOME'), "'x$HOME'");
   // The generated body never leaves an unquoted expansion, substitution or glob.
   const body = HOOK_BODY(['weird bin', "quo'te", '$HOME', '`cmd`', '*']);
   assert.match(body, /^'weird bin' 'quo'\\''te' '\$HOME' '`cmd`' '\*' validate \|\| exit 1$/m);
   // The stale-index message keeps its own shell quoting: the backticks stay literal.
   assert.match(body, /echo 'leji: stored index is stale; run `leji index` and stage the result\.' >&2/);
});

test('hook: the shim is gone; nothing reaches node_modules/.bin', () => {
   for (const argv of [['leji'], ['pnpm', 'exec', 'leji'], ['go', 'tool', 'leji']]) {
      const body = HOOK_BODY(argv);
      assert.doesNotMatch(body, /node_modules/);
      assert.doesNotMatch(body, /LEJI=/);
      assert.doesNotMatch(body, /\$LEJI/);
      assert.doesNotMatch(HUSKY_BLOCK(argv), /node_modules/);
   }
});

test('hook: written into a repository, it carries that repository’s runner', () => {
   const dir = plant(ROOTS.pnpm);
   execFileSync('git', ['init', '-q'], { cwd: dir });
   const r = ensureLocalHook(dir);
   assert.equal(r.action, 'created');
   const body = fs.readFileSync(path.join(dir, r.path), 'utf8');
   assert.equal(body, golden('hook-pnpm.sh'));
   assert.equal(ensureLocalHook(dir).action, 'unchanged', 'idempotent');
});
