#!/usr/bin/env node
// Cross-SDK parity test: run the Node, Go, and Python CLIs on identical inputs
// and assert identical stdout, stderr, exit code, AND identical written file
// trees (bytes + mode + symlinks). Go and Python must match the Node reference;
// any divergence fails. Run: `npm run parity` (needs node, go, python3).
//
// Two environment modes:
//   neutralized: empty PATH + fresh HOME, so host detection finds nothing and
//                the git-config owner lookup fails the same way in all three.
//   real:        a fake PATH with executable host stubs, a HOME with host
//                config dirs, and an initialized git repo with a fixed identity,
//                 so detection, git-owner defaults, and git-backed behavior are
//                 exercised deterministically.
// The only nondeterministic field (context-index.json `generatedAt`, a per-run
// timestamp) is normalized field-aware; everything else is compared exactly.
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeCli = path.join(repoRoot, 'packages', 'sdk', 'dist', 'cli.js');
const goBin = path.join(os.tmpdir(), `leji-parity-go-${process.pid}`);
const pyVenv = path.join(repoRoot, 'packages', 'sdk-py', '.venv');
const pyCli = path.join(pyVenv, 'bin', 'leji');

function mkAbs(prefix: string): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// --- neutralized env: no PATH, fresh HOME ---
const neutralEnv = { PATH: mkAbs('leji-parity-empty-'), HOME: mkAbs('leji-parity-home-') };

// --- real env: fake host stubs on PATH (+ real git), HOME with config dirs ---
function gitDir(): string {
   try {
      return path.dirname(execFileSync('bash', ['-lc', 'command -v git'], { encoding: 'utf8' }).trim());
   } catch {
      return '/usr/bin';
   }
}
function makeRealEnv(): { PATH: string; HOME: string; GIT_CONFIG_GLOBAL: string } {
   const stubs = mkAbs('leji-parity-stubs-');
   // An executable `claude` stub (confirmed via PATH) and a non-executable
   // `gemini` (must NOT count as confirmed; exercises the executable-bit check).
   fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
   fs.writeFileSync(path.join(stubs, 'gemini'), 'not executable\n', { mode: 0o644 });
   const home = mkAbs('leji-parity-realhome-');
   fs.mkdirSync(path.join(home, '.codex')); // codex: installed-likely (user config)
   // A deterministic global git identity, isolated from the runner's real config.
   const gitconfig = path.join(home, '.gitconfig');
   fs.writeFileSync(gitconfig, '[user]\n  name = Parity Tester\n  email = parity@example.com\n');
   return { PATH: `${stubs}:${gitDir()}`, HOME: home, GIT_CONFIG_GLOBAL: gitconfig };
}
const realEnv = makeRealEnv();

function build(): void {
   console.log('building CLIs...');
   execFileSync('npm', ['run', 'build', '-w', 'packages/sdk'], { cwd: repoRoot, stdio: 'inherit' });
   execFileSync('go', ['build', '-o', goBin, './cmd/leji'], {
      cwd: path.join(repoRoot, 'packages', 'sdk-go'),
      stdio: 'inherit',
   });
   // Always (re)install the Python package so a stale console-script or changed
   // dependency cannot give a false pass.
   if (!fs.existsSync(path.join(pyVenv, 'bin', 'python'))) {
      execFileSync('python3', ['-m', 'venv', pyVenv], { stdio: 'inherit' });
   }
   execFileSync(path.join(pyVenv, 'bin', 'pip'), ['install', '-q', '-e', '.'], {
      cwd: path.join(repoRoot, 'packages', 'sdk-py'),
      stdio: 'inherit',
   });
}

interface RunResult {
   exit: number;
   stdout: string;
   stderr: string;
}

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): RunResult {
   try {
      const stdout = execFileSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { exit: 0, stdout, stderr: '' };
   } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { exit: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
   }
}

type Runner = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => RunResult;
const runners: Record<string, Runner> = {
   node: (args, cwd, env) => run(process.execPath, [nodeCli, ...args], cwd, env),
   go: (args, cwd, env) => run(goBin, args, cwd, env),
   py: (args, cwd, env) => run(pyCli, args, cwd, env),
};

/** Field-aware key for one file: symlinks by target, the index by its content
 * with the volatile `generatedAt` nulled, everything else by exact bytes (text
 * verbatim for a readable diff; binary by hash). Executable bit is recorded. */
function fileKey(abs: string, rel: string): string {
   const lst = fs.lstatSync(abs);
   if (lst.isSymbolicLink()) return `symlink -> ${fs.readlinkSync(abs)}`;
   const buf = fs.readFileSync(abs);
   const execBit = lst.mode & 0o111 ? 'x' : '-';
   let body: string;
   if (rel.endsWith('context-index.json')) {
      try {
         const obj = JSON.parse(buf.toString('utf8'));
         if (obj && typeof obj === 'object') obj.generatedAt = '<GENERATED_AT>';
         body = JSON.stringify(obj, null, 2);
      } catch {
         body = buf.toString('utf8');
      }
   } else {
      const looksText = !buf.includes(0);
      body = looksText
         ? buf.toString('utf8')
         : `binary sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
   }
   return `[${execBit}]\n${body}`;
}

/** Snapshot a tree: files (with field-aware key), symlinks, and empty dirs. */
function snapshot(dir: string): string {
   const entries: string[] = [];
   const walk = (d: string): void => {
      const items = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      if (items.length === 0 && d !== dir) {
         entries.push(`=== ${path.relative(dir, d).split(path.sep).join('/')}/ (empty dir) ===`);
      }
      for (const it of items) {
         // .git is input scaffolding (created per-dir, never written by Leji); its
         // object hashes differ by construction, so it is not part of parity.
         if (it.name === '.git') continue;
         const abs = path.join(d, it.name);
         const rel = path.relative(dir, abs).split(path.sep).join('/');
         if (it.isSymbolicLink()) entries.push(`=== ${rel} ===\nsymlink -> ${fs.readlinkSync(abs)}`);
         else if (it.isDirectory()) walk(abs);
         else entries.push(`=== ${rel} ===\n${fileKey(abs, rel)}`);
      }
   };
   walk(dir);
   entries.sort();
   return entries.join('\n');
}

interface Scenario {
   name: string;
   mode?: 'neutral' | 'real';
   setup: (dir: string) => void;
   args: string[];
   /** Extra env vars merged into the run (e.g. test-only fault injection). */
   env?: Record<string, string>;
}

function nodeRun(args: string[], cwd: string): void {
   run(process.execPath, [nodeCli, ...args], cwd, neutralEnv);
}
/** Seed a core layer with the Node CLI (identical input for read commands). */
function seedLayer(dir: string): void {
   nodeRun(['init', '--yes', '--name', 'demo-context'], dir);
}
/** A seeded layer that already has one agent wired, for the `agent` append /
 * idempotency scenarios (the first binding must be identical across SDKs). */
function seedWithAgent(dir: string): void {
   seedLayer(dir);
   nodeRun(['agent', '--host', 'codex', '--name', 'reviewer'], dir);
}
/** A layer that claims indexed but has no changelog yet (the upgrade case): core
 * init, then bump claimedLevel to indexed. `leji index` must seed the changelog. */
function indexedNoChangelog(dir: string): void {
   nodeRun(['init', '--yes', '--name', 'demo-context'], dir);
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('"claimedLevel": "core"', '"claimedLevel": "indexed"'));
}
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');
function copyExample(dir: string): void {
   fs.cpSync(exampleDir, dir, { recursive: true });
}
/** A git repo with the layer committed, for the real-env git-backed scenarios. */
function gitLayer(dir: string): void {
   copyExample(dir);
   const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
   };
   git('init', '-q');
   git('add', '-A');
   git('-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
}
/** A git repo with an uncommitted (untracked) file, for the init/adopt dirty-guard. */
function dirtyGitRepo(dir: string): void {
   execFileSync('git', ['init', '-q'], { cwd: dir, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
   fs.writeFileSync(path.join(dir, 'NOTES.md'), 'work in progress\n');
}

// An existing path outside any layer root, identical across the three runs (each
// run gets its own temp root). Symlinking a declared file here exercises the
// read-side confinement guards; the symlink target string is byte-identical, so
// the tree snapshots stay comparable.
const ESCAPE_TARGET = '/etc/hosts';
/** Replace a declared file in the example layer with a symlink escaping the root. */
function symlinkOver(rel: string): (dir: string) => void {
   return (dir) => {
      copyExample(dir);
      const p = path.join(dir, rel);
      fs.rmSync(p, { force: true });
      fs.symlinkSync(ESCAPE_TARGET, p);
   };
}
/** The example layer plus a symlink in the content tree that escapes the root, for
 * the viewer-export symlink-skip contract. */
function symlinkInContent(dir: string): void {
   copyExample(dir);
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, 'docs', 'evil-link.md'));
}
/** Seeded layer with a pre-existing .gitlab-ci.yml (trailing newline) for the merge case. */
function seedLayerWithGitlab(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages:\n  - test\n');
}
/** Seeded layer with a .gitlab-ci.yml lacking a trailing newline (the \n\n separator). */
function seedLayerWithGitlabNoNl(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), 'stages:\n  - test');
}
/** Seeded layer that already carries the managed gitlab block (idempotency). */
function seedLayerWithGitlabManaged(dir: string): void {
   seedLayer(dir);
   nodeRun(['ci', '--provider', 'gitlab'], dir);
}
/** Seeded layer with a pre-existing .circleci/config.yml (manual-snippet case). */
function seedLayerWithCircle(dir: string): void {
   seedLayer(dir);
   fs.mkdirSync(path.join(dir, '.circleci'), { recursive: true });
   fs.writeFileSync(
      path.join(dir, '.circleci', 'config.yml'),
      'version: 2.1\njobs:\n  build:\n    docker:\n      - image: node:22\n',
   );
}
/** Seeded layer whose .gitlab-ci.yml is a symlink escaping the root (refusal). */
function seedLayerGitlabSymlink(dir: string): void {
   seedLayer(dir);
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, '.gitlab-ci.yml'));
}
/** Seeded layer with an empty .gitlab-ci.yml (the empty-file merge case). */
function seedLayerWithGitlabEmpty(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(path.join(dir, '.gitlab-ci.yml'), '');
}
/** Seeded layer with a STALE managed block + surrounding content (block replacement). */
function seedLayerWithGitlabStale(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, '.gitlab-ci.yml'),
      'before:\n  keep: 1\n\n# >>> leji ci (managed) >>>\nleji-validate:\n  image: node:18\n# <<< leji ci (managed) <<<\n\nafter:\n  keep: 2\n',
   );
}
/** Seeded layer with TWO managed blocks (the first is replaced, the rest dropped). */
function seedLayerWithGitlabDuplicate(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, '.gitlab-ci.yml'),
      'before:\n  keep: 1\n\n# >>> leji ci (managed) >>>\nleji-validate:\n  image: node:18\n# <<< leji ci (managed) <<<\n\nmiddle:\n  keep: 2\n\n# >>> leji ci (managed) >>>\nleji-validate:\n  image: node:20\n# <<< leji ci (managed) <<<\n\nafter:\n  keep: 3\n',
   );
}
/** Seeded layer that already carries the GitHub workflow (the already-present case). */
function seedLayerWithGithub(dir: string): void {
   seedLayer(dir);
   nodeRun(['ci', '--provider', 'github'], dir);
}
/** Seeded layer whose .github/workflows is a symlink escaping the root (refusal). */
function seedLayerGithubParentSymlink(dir: string): void {
   seedLayer(dir);
   fs.mkdirSync(path.join(dir, '.github'), { recursive: true });
   fs.symlinkSync('/etc', path.join(dir, '.github', 'workflows'));
}
/** Seeded layer whose .circleci is a symlink escaping the root (refusal). */
function seedLayerCircleParentSymlink(dir: string): void {
   seedLayer(dir);
   fs.symlinkSync('/etc', path.join(dir, '.circleci'));
}
/** Seeded layer that already carries the azure pipeline file (idempotency). */
function seedLayerWithAzure(dir: string): void {
   seedLayer(dir);
   nodeRun(['ci', '--provider', 'azure'], dir);
}
/** Seeded layer whose .azure-pipelines is a symlink escaping the root (refusal). */
function seedLayerAzureParentSymlink(dir: string): void {
   seedLayer(dir);
   fs.symlinkSync('/etc', path.join(dir, '.azure-pipelines'));
}
/** Seeded layer whose GitHub workflow FILE is a symlink to an existing path outside
 * the root: the target exists, so it must be refused before the exists short-circuit. */
function seedLayerGithubTargetSymlink(dir: string): void {
   seedLayer(dir);
   fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, '.github', 'workflows', 'leji.yml'));
}
/** Seeded layer whose GitHub workflow dir is read-only: the write fails, and the
 * normalized OS-text-free error must be byte-identical across SDKs. (As root, perms
 * are bypassed so all three create the file instead; still identical across SDKs.) */
function seedLayerGithubUnwritable(dir: string): void {
   seedLayer(dir);
   const wf = path.join(dir, '.github', 'workflows');
   fs.mkdirSync(wf, { recursive: true });
   fs.chmodSync(wf, 0o555);
}
/** Seeded layer whose .github exists but is read-only and .github/workflows is absent:
 * creating the workflows dir fails, exercising the normalized mkdir-failure path. */
function seedLayerGithubUnwritableParent(dir: string): void {
   seedLayer(dir);
   const gh = path.join(dir, '.github');
   fs.mkdirSync(gh, { recursive: true });
   fs.chmodSync(gh, 0o555);
}
/** Seeded layer whose CircleCI config FILE is a symlink escaping the root (refusal). */
function seedLayerCircleTargetSymlink(dir: string): void {
   seedLayer(dir);
   fs.mkdirSync(path.join(dir, '.circleci'), { recursive: true });
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, '.circleci', 'config.yml'));
}
/** Seeded layer whose Azure pipeline FILE is a symlink escaping the root (refusal). */
function seedLayerAzureTargetSymlink(dir: string): void {
   seedLayer(dir);
   fs.mkdirSync(path.join(dir, '.azure-pipelines'), { recursive: true });
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, '.azure-pipelines', 'leji.yml'));
}
/** Seed a layer, then plant `<rel>.leji-tmp` (the atomic-write sibling) as a symlink
 * escaping the root: the write must refuse it rather than follow it through. */
function seedLayerTempSymlink(rel: string): (dir: string) => void {
   return (dir) => {
      seedLayer(dir);
      const tmp = path.join(dir, `${rel}.leji-tmp`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.symlinkSync(ESCAPE_TARGET, tmp);
   };
}
/** The example layer whose contained viewer dir (rootPath/.leji) is a symlink
 * escaping the root: viewer generation refuses every write, so `viewer build` must
 * abort with findings before any destructive cleanup (not report success). */
function symlinkedViewerDir(dir: string): void {
   copyExample(dir);
   fs.symlinkSync('/etc', path.join(dir, 'docs', '.leji'));
}
/** The example layer with an agent declared OUTSIDE the agent-profiles directory,
 * symlinked to escape the root, to exercise the agents-map confinement guard
 * (the `_check_agents_map` path, not the directory scan's symlink skip). */
function symlinkedAgentOutsideProfiles(dir: string): void {
   copyExample(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.agents = { ...(m.agents ?? {}), external: 'docs/external-agent.md' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, 'docs', 'external-agent.md'));
}

const SCENARIOS: Scenario[] = [
   // --- init / adopt (neutralized) ---
   { name: 'init core', setup: () => {}, args: ['init', '--yes', '--name', 'demo-context'] },
   { name: 'init indexed', setup: () => {}, args: ['init', '--yes', '--level', 'indexed', '--name', 'demo-context'] },
   { name: 'init --agent', setup: () => {}, args: ['init', '--yes', '--name', 'demo', '--agent', 'claude-code'] },
   {
      name: 'init --agent + agent (post-init reviewer)',
      setup: seedLayer,
      args: ['agent', '--host', 'codex', '--name', 'reviewer'],
   },
   {
      name: 'agent --json (post-init reviewer)',
      setup: seedLayer,
      args: ['agent', '--host', 'codex', '--name', 'reviewer', '--json'],
   },
   {
      name: 'agent appends a second binding (--role)',
      setup: seedWithAgent,
      args: ['agent', '--host', 'claude-code', '--name', 'thought-partner', '--role', 'advisor'],
   },
   {
      name: 'agent is idempotent (re-run same args)',
      setup: seedWithAgent,
      args: ['agent', '--host', 'codex', '--name', 'reviewer'],
   },
   { name: 'agent with no manifest', setup: () => {}, args: ['agent', '--host', 'codex', '--name', 'reviewer'] },
   { name: 'agent without --host (resident, no vendor file)', setup: seedLayer, args: ['agent', '--name', 'porter'] },
   {
      name: 'init --dry-run with existing vendor file',
      setup: (d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'pre-existing config\n'),
      args: ['init', '--yes', '--dry-run'],
   },
   {
      name: 'init refusal (layer already exists)',
      setup: (d) => seedLayer(d),
      args: ['init', '--yes'],
   },
   {
      name: 'init --agent cursor (directory-style)',
      setup: () => {},
      args: ['init', '--yes', '--name', 'demo', '--agent', 'cursor'],
   },
   {
      name: 'adopt draft (existing docs + mixed vendor file)',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs'));
         fs.writeFileSync(path.join(d, 'docs', 'README.md'), '# Docs\n');
         fs.writeFileSync(
            path.join(d, 'CLAUDE.md'),
            'Read docs/boot-profile.md first. Never deploy Fridays.\nRun tests.\n',
         );
      },
      args: ['adopt', '--yes'],
   },
   {
      name: 'adopt --wire-adapters',
      setup: (d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'Always run tests.\n'),
      args: ['adopt', '--yes', '--wire-adapters'],
   },
   {
      name: 'adopt --dry-run',
      setup: (d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'x\n'),
      args: ['adopt', '--yes', '--dry-run'],
   },
   { name: 'detect --json (no hosts)', setup: () => {}, args: ['detect', '--json'] },
   { name: 'start with no manifest', setup: () => {}, args: ['start'] },
   // --- read commands on the indexed example (neutralized) ---
   { name: 'validate --content', setup: seedLayer, args: ['validate', '--content'] },
   {
      name: 'validate --content with unconfirmed inferences',
      setup: (d) => {
         seedLayer(d);
         fs.writeFileSync(
            path.join(d, 'docs', 'system', 'invariants.md'),
            '# System Invariants\n\n- TODO(confirm-invariant): money is integer minor units\n',
         );
      },
      args: ['validate', '--content'],
   },
   { name: 'conformance --explain', setup: seedLayer, args: ['conformance', '--explain'] },
   { name: 'validate', setup: copyExample, args: ['validate'] },
   { name: 'validate --json', setup: copyExample, args: ['validate', '--json'] },
   {
      // A fixture whose errors carry Leji's OWN messages (exit 1 + error JSON).
      // We avoid fixtures that trip a JSON-schema enum/type error: that message
      // text is generated by each SDK's schema library (ajv / Go / jsonschema)
      // and intentionally is NOT required to match (the shared-fixtures harness
      // compares rule/severity/path for those, not the library message).
      name: 'validate (error fixture, Leji messages)',
      setup: (d) => fs.cpSync(path.join(repoRoot, 'fixtures', 'invalid-missing-boot-profile'), d, { recursive: true }),
      args: ['validate', '--json'],
   },
   { name: 'conformance', setup: copyExample, args: ['conformance'] },
   { name: 'conformance --json', setup: copyExample, args: ['conformance', '--json'] },
   { name: 'index generate', setup: copyExample, args: ['index'] },
   { name: 'index --check', setup: copyExample, args: ['index', '--check'] },
   {
      name: 'index --check (stale)',
      setup: (d) => fs.cpSync(path.join(repoRoot, 'fixtures', 'invalid-stale-index'), d, { recursive: true }),
      args: ['index', '--check', '--json'],
   },
   { name: 'freshness', setup: copyExample, args: ['freshness'] },
   { name: 'freshness --json', setup: copyExample, args: ['freshness', '--json'] },
   { name: 'changelog check', setup: copyExample, args: ['changelog', 'check'] },
   { name: 'changelog check --strict', setup: copyExample, args: ['changelog', 'check', '--strict'] },
   { name: 'changelog compact --keep', setup: copyExample, args: ['changelog', 'compact', '--keep', '1'] },
   { name: 'changelog compact --before', setup: copyExample, args: ['changelog', 'compact', '--before', '2030-01-01'] },
   { name: 'changelog compact (no flag) errors', setup: copyExample, args: ['changelog', 'compact'] },
   // Core layer with no declared machine paths: index/changelog resolve to defaults.
   { name: 'index on a core layer (default path)', setup: seedLayer, args: ['index'] },
   { name: 'ci writes the workflow (seeded layer)', setup: seedLayer, args: ['ci'] },
   { name: 'ci --provider github (explicit)', setup: seedLayer, args: ['ci', '--provider', 'github'] },
   { name: 'ci --provider github (create, --json)', setup: seedLayer, args: ['ci', '--provider', 'github', '--json'] },
   { name: 'ci --provider github (already present)', setup: seedLayerWithGithub, args: ['ci', '--provider', 'github'] },
   {
      name: 'ci --provider github (already present, --json)',
      setup: seedLayerWithGithub,
      args: ['ci', '--provider', 'github', '--json'],
   },
   { name: 'ci --provider gitlab (create)', setup: seedLayer, args: ['ci', '--provider', 'gitlab'] },
   { name: 'ci --provider gitlab (create, --json)', setup: seedLayer, args: ['ci', '--provider', 'gitlab', '--json'] },
   {
      name: 'ci --provider gitlab (merge, trailing nl)',
      setup: seedLayerWithGitlab,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider gitlab (merge -> updated, --json)',
      setup: seedLayerWithGitlab,
      args: ['ci', '--provider', 'gitlab', '--json'],
   },
   {
      name: 'ci --provider gitlab (merge, no trailing nl)',
      setup: seedLayerWithGitlabNoNl,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider gitlab (merge, no trailing nl, --json)',
      setup: seedLayerWithGitlabNoNl,
      args: ['ci', '--provider', 'gitlab', '--json'],
   },
   {
      name: 'ci --provider gitlab (merge into empty file)',
      setup: seedLayerWithGitlabEmpty,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider gitlab (merge into empty file, --json)',
      setup: seedLayerWithGitlabEmpty,
      args: ['ci', '--provider', 'gitlab', '--json'],
   },
   {
      name: 'ci --provider gitlab (replace stale managed block)',
      setup: seedLayerWithGitlabStale,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider gitlab (collapse duplicate managed blocks)',
      setup: seedLayerWithGitlabDuplicate,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider gitlab (collapse duplicate managed blocks, --json)',
      setup: seedLayerWithGitlabDuplicate,
      args: ['ci', '--provider', 'gitlab', '--json'],
   },
   {
      name: 'ci --provider gitlab (replace stale managed block, --json)',
      setup: seedLayerWithGitlabStale,
      args: ['ci', '--provider', 'gitlab', '--json'],
   },
   {
      name: 'ci --provider gitlab (idempotent on managed block)',
      setup: seedLayerWithGitlabManaged,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider gitlab (symlinked target refused)',
      setup: seedLayerGitlabSymlink,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider github (escaping parent dir refused)',
      setup: seedLayerGithubParentSymlink,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider github (escaping target symlink refused)',
      setup: seedLayerGithubTargetSymlink,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider github (unwritable target dir)',
      setup: seedLayerGithubUnwritable,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider github (unwritable parent dir, mkdir fails)',
      setup: seedLayerGithubUnwritableParent,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider github (write fails after temp; cleans up, no partial)',
      setup: seedLayer,
      args: ['ci', '--provider', 'github'],
      env: { LEJI_TEST_FAIL_RENAME: '1' },
   },
   {
      name: 'ci --provider gitlab (merge write fails after temp; original intact)',
      setup: seedLayerWithGitlab,
      args: ['ci', '--provider', 'gitlab'],
      env: { LEJI_TEST_FAIL_RENAME: '1' },
   },
   {
      name: 'ci --provider circleci (escaping parent dir refused)',
      setup: seedLayerCircleParentSymlink,
      args: ['ci', '--provider', 'circleci'],
   },
   {
      name: 'ci --provider circleci (escaping target symlink refused)',
      setup: seedLayerCircleTargetSymlink,
      args: ['ci', '--provider', 'circleci'],
   },
   { name: 'ci --provider circleci (create)', setup: seedLayer, args: ['ci', '--provider', 'circleci'] },
   {
      name: 'ci --provider circleci (create, --json)',
      setup: seedLayer,
      args: ['ci', '--provider', 'circleci', '--json'],
   },
   {
      name: 'ci --provider circleci (exists -> manual)',
      setup: seedLayerWithCircle,
      args: ['ci', '--provider', 'circleci'],
   },
   {
      name: 'ci --provider circleci (exists -> manual, --json)',
      setup: seedLayerWithCircle,
      args: ['ci', '--provider', 'circleci', '--json'],
   },
   { name: 'ci --provider azure (create)', setup: seedLayer, args: ['ci', '--provider', 'azure'] },
   { name: 'ci --provider azure (create, --json)', setup: seedLayer, args: ['ci', '--provider', 'azure', '--json'] },
   { name: 'ci --provider azure (idempotent)', setup: seedLayerWithAzure, args: ['ci', '--provider', 'azure'] },
   {
      name: 'ci --provider azure (idempotent, --json)',
      setup: seedLayerWithAzure,
      args: ['ci', '--provider', 'azure', '--json'],
   },
   {
      name: 'ci --provider azure (escaping parent dir refused)',
      setup: seedLayerAzureParentSymlink,
      args: ['ci', '--provider', 'azure'],
   },
   {
      name: 'ci --provider azure (escaping target symlink refused)',
      setup: seedLayerAzureTargetSymlink,
      args: ['ci', '--provider', 'azure'],
   },
   {
      name: 'ci --provider github (escaping temp symlink refused)',
      setup: seedLayerTempSymlink('.github/workflows/leji.yml'),
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider gitlab (escaping temp symlink refused)',
      setup: seedLayerTempSymlink('.gitlab-ci.yml'),
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider circleci (escaping temp symlink refused)',
      setup: seedLayerTempSymlink('.circleci/config.yml'),
      args: ['ci', '--provider', 'circleci'],
   },
   {
      name: 'ci --provider azure (escaping temp symlink refused)',
      setup: seedLayerTempSymlink('.azure-pipelines/leji.yml'),
      args: ['ci', '--provider', 'azure'],
   },
   { name: 'ci --provider bogus (reject)', setup: seedLayer, args: ['ci', '--provider', 'bogus'] },
   {
      name: 'ci --provider bogus (reject before manifest, no layer)',
      setup: () => {},
      args: ['ci', '--provider', 'bogus'],
   },
   { name: 'ci (valid provider, no manifest)', setup: () => {}, args: ['ci'] },
   { name: 'ci (valid provider, no manifest, --json)', setup: () => {}, args: ['ci', '--json'] },
   { name: 'ci --provider (missing value)', setup: seedLayer, args: ['ci', '--provider'] },
   { name: 'validate --provider (scope reject)', setup: seedLayer, args: ['validate', '--provider', 'github'] },
   { name: 'index auto-seeds the changelog (indexed claim, none yet)', setup: indexedNoChangelog, args: ['index'] },
   { name: 'changelog check on a core layer (default path)', setup: seedLayer, args: ['changelog', 'check'] },
   { name: 'viewer', setup: copyExample, args: ['viewer'] },
   {
      name: 'viewer (mermaid disabled)',
      setup: (d) => {
         copyExample(d);
         const mp = path.join(d, 'leji.json');
         const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
         m.viewer = { ...(m.viewer ?? {}), mermaid: false };
         fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
      },
      args: ['viewer'],
   },
   { name: 'viewer build (static export)', setup: copyExample, args: ['viewer', 'build', '--out', 'site'] },
   { name: 'viewer build default out (.leji/viewer-dist)', setup: copyExample, args: ['viewer', 'build'] },
   {
      name: 'viewer build --out ../escape (reject)',
      setup: copyExample,
      args: ['viewer', 'build', '--out', '../escape'],
   },
   { name: 'viewer build --out . (root, reject)', setup: copyExample, args: ['viewer', 'build', '--out', '.'] },
   {
      name: 'viewer build --out absolute (reject)',
      setup: copyExample,
      args: ['viewer', 'build', '--out', '/tmp/leji-parity-out-abs'],
   },
   { name: 'viewer build skips a symlinked content file', setup: symlinkInContent, args: ['viewer', 'build'] },
   { name: 'viewer build aborts on an escaping viewer dir', setup: symlinkedViewerDir, args: ['viewer', 'build'] },
   {
      name: 'symlinked agent outside profiles dir (validate)',
      setup: symlinkedAgentOutsideProfiles,
      args: ['validate'],
   },
   { name: 'symlinked leji.json refused (manifest confinement)', setup: symlinkOver('leji.json'), args: ['validate'] },
   { name: 'symlinked boot profile (validate)', setup: symlinkOver('docs/boot-profile.md'), args: ['validate'] },
   { name: 'symlinked boot profile (conformance)', setup: symlinkOver('docs/boot-profile.md'), args: ['conformance'] },
   {
      name: 'symlinked context-index.json (artifact confinement)',
      setup: symlinkOver('docs/context-index.json'),
      args: ['index', '--check'],
   },
   {
      name: 'symlinked agent profile (validate)',
      setup: symlinkOver('docs/agents/thought-partner.md'),
      args: ['validate'],
   },
   // --- meta ---
   { name: '--version', setup: () => {}, args: ['--version'] },
   { name: '-v', setup: () => {}, args: ['-v'] },
   { name: '--help', setup: () => {}, args: ['--help'] },
   { name: 'unknown command', setup: () => {}, args: ['frobnicate'] },
   // Numeric-flag range guards reject pre-dispatch (exit 2, no writes) in all
   // three SDKs; the empty setup + tree compare also asserts nothing is written.
   { name: 'view --port out of range (range error)', setup: () => {}, args: ['view', '--port', '99999'] },
   { name: 'changelog compact --keep 0 (range error)', setup: () => {}, args: ['changelog', 'compact', '--keep', '0'] },
   // --- real env: detection + git-backed behavior ---
   { name: 'detect --json (real PATH+HOME stubs)', mode: 'real', setup: () => {}, args: ['detect', '--json'] },
   {
      name: 'init in a real git repo (owner from git)',
      mode: 'real',
      setup: () => {},
      args: ['init', '--yes', '--name', 'demo-context'],
   },
   {
      name: 'init refuses on a dirty git tree',
      mode: 'real',
      setup: dirtyGitRepo,
      args: ['init', '--yes', '--name', 'demo'],
   },
   {
      name: 'init --dry-run is allowed on a dirty git tree',
      mode: 'real',
      setup: dirtyGitRepo,
      args: ['init', '--yes', '--name', 'demo', '--dry-run'],
   },
   { name: 'adopt refuses on a dirty git tree', mode: 'real', setup: dirtyGitRepo, args: ['adopt', '--yes'] },
   { name: 'validate on a committed git layer', mode: 'real', setup: gitLayer, args: ['validate'] },
   { name: 'conformance on a committed git layer', mode: 'real', setup: gitLayer, args: ['conformance', '--json'] },
   { name: 'changelog check on a committed git layer', mode: 'real', setup: gitLayer, args: ['changelog', 'check'] },
];

function firstDiff(a: string, b: string): string {
   const al = a.split('\n');
   const bl = b.split('\n');
   for (let i = 0; i < Math.max(al.length, bl.length); i++) {
      if (al[i] !== bl[i]) {
         return `  line ${i + 1}:\n    node:  ${JSON.stringify(al[i])}\n    other: ${JSON.stringify(bl[i])}`;
      }
   }
   return '  (no line diff; lengths differ)';
}

interface Captured {
   exit: number;
   stdout: string;
   stderr: string;
   tree: string;
}

function capture(runner: Runner, sc: Scenario, env: NodeJS.ProcessEnv): Captured {
   const dir = path.join(mkAbs(`leji-parity-`), 'repo');
   fs.mkdirSync(dir);
   sc.setup(dir);
   const r = runner(sc.args, dir, sc.env ? { ...env, ...sc.env } : env);
   return { exit: r.exit, stdout: r.stdout, stderr: r.stderr, tree: snapshot(dir) };
}

function diffProblems(ref: Captured, other: Captured, sdk: string): string[] {
   const problems: string[] = [];
   if (other.exit !== ref.exit) problems.push(`${sdk}: exit ${other.exit} != node ${ref.exit}`);
   if (other.stdout !== ref.stdout) problems.push(`${sdk}: stdout differs\n${firstDiff(ref.stdout, other.stdout)}`);
   if (other.stderr !== ref.stderr) problems.push(`${sdk}: stderr differs\n${firstDiff(ref.stderr, other.stderr)}`);
   if (other.tree !== ref.tree) problems.push(`${sdk}: file tree differs\n${firstDiff(ref.tree, other.tree)}`);
   return problems;
}

/** Prove the comparator can fail: two deliberately different captures must be
 * reported as divergent. Guards against a refactor that makes compare a no-op. */
function selfTest(): void {
   const a: Captured = { exit: 0, stdout: 'x', stderr: '', tree: '=== f ===\n[-]\nA' };
   const b: Captured = { exit: 0, stdout: 'y', stderr: '', tree: '=== f ===\n[-]\nB' };
   if (diffProblems(a, b, 'self').length === 0) {
      throw new Error('parity self-test failed: the comparator did not detect a known divergence');
   }
}

function main(): number {
   build();
   selfTest();
   let failures = 0;
   for (const sc of SCENARIOS) {
      const env = sc.mode === 'real' ? realEnv : neutralEnv;
      const ref = capture(runners.node, sc, env);
      const problems = [
         ...diffProblems(ref, capture(runners.go, sc, env), 'go'),
         ...diffProblems(ref, capture(runners.py, sc, env), 'py'),
      ];
      if (problems.length === 0) {
         console.log(`PASS  ${sc.name}`);
      } else {
         failures++;
         console.log(`FAIL  ${sc.name}`);
         for (const p of problems) console.log('   ' + p.replace(/\n/g, '\n   '));
      }
   }
   console.log(`\n${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios in parity across node/go/python.`);
   return failures === 0 ? 0 : 1;
}

process.exit(main());
