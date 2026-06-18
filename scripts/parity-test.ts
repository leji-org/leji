#!/usr/bin/env node
// Cross-SDK parity test: run the Node, Go, and Python CLIs on identical inputs
// and assert identical stdout, stderr, exit code, AND identical written file
// trees (bytes + mode + symlinks). Go and Python must match the Node reference;
// any divergence fails. Run: `npm run parity` (needs node, go, python3).
//
// Two environment modes:
//   neutralized — empty PATH + fresh HOME, so host detection finds nothing and
//                 the git-config owner lookup fails the same way in all three.
//   real        — a fake PATH with executable host stubs, a HOME with host
//                 config dirs, and an initialized git repo with a fixed identity,
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
   // `gemini` (must NOT count as confirmed — exercises the executable-bit check).
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
      // eslint-disable-next-line no-control-regex
      const looksText = !buf.includes(0) && /^[\s\S]*$/.test(buf.toString('utf8'));
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
}

function nodeRun(args: string[], cwd: string): void {
   run(process.execPath, [nodeCli, ...args], cwd, neutralEnv);
}
/** Seed a core layer with the Node CLI (identical input for read commands). */
function seedLayer(dir: string): void {
   nodeRun(['init', '--yes', '--name', 'demo-context'], dir);
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

const SCENARIOS: Scenario[] = [
   // --- init / adopt (neutralized) ---
   { name: 'init core', setup: () => {}, args: ['init', '--yes', '--name', 'demo-context'] },
   { name: 'init indexed', setup: () => {}, args: ['init', '--yes', '--level', 'indexed', '--name', 'demo-context'] },
   { name: 'init --agent', setup: () => {}, args: ['init', '--yes', '--name', 'demo', '--agent', 'claude-code'] },
   {
      name: 'init multi-agent + ci',
      setup: () => {},
      args: ['init', '--yes', '--name', 'demo', '--agent', 'claude-code', '--reviewer', 'codex', '--ci'],
   },
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
   { name: 'changelog check on a core layer (default path)', setup: seedLayer, args: ['changelog', 'check'] },
   { name: 'docs', setup: copyExample, args: ['docs'] },
   // --- meta ---
   { name: '--version', setup: () => {}, args: ['--version'] },
   { name: '--help', setup: () => {}, args: ['--help'] },
   { name: 'unknown command', setup: () => {}, args: ['frobnicate'] },
   // --- real env: detection + git-backed behavior ---
   { name: 'detect --json (real PATH+HOME stubs)', mode: 'real', setup: () => {}, args: ['detect', '--json'] },
   {
      name: 'init in a real git repo (owner from git)',
      mode: 'real',
      setup: () => {},
      args: ['init', '--yes', '--name', 'demo-context'],
   },
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
   const r = runner(sc.args, dir, env);
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
