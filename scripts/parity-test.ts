#!/usr/bin/env node
// Cross-SDK parity test: run the Node, Go, and Python CLIs on identical inputs
// and assert identical stdout, stderr, exit code, AND identical written file
// trees (bytes + mode + symlinks). Go and Python must match the Node reference;
// any divergence fails. Run: `npm run parity` (needs node, go, python3).
//
// Two environment modes:
//   neutralized: empty PATH + fresh HOME, so host detection finds nothing and the
//                git-config owner lookup fails the same way in all three.
//   real:        fake PATH with host stubs, HOME with config dirs, and a git repo
//                with a fixed identity, so detection, git-owner defaults, and
//                git-backed behavior are exercised deterministically.
// The declared nondeterministic fields (context-index.json `generatedAt`, the
// resolver sidecar's `hydratedAt`, and `mounts status`' `observedAt`) are
// normalized field-aware; everything else is compared exactly.
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
   } else if (/^\.leji\/mounts\/cache\/[0-9a-f]{64}\/projection\/metadata\.json$/.test(rel)) {
      // The resolver sidecar's observation time is the one volatile field.
      try {
         const obj = JSON.parse(buf.toString('utf8'));
         if (obj && typeof obj === 'object') obj.hydratedAt = '<HYDRATED_AT>';
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
         // The resolver's bare object store is git plumbing (same exclusion as
         // .git); the lockfile is transient concurrency state.
         if (rel === '.leji/mounts/store') continue;
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
   /** A second argv naming the same operation. Run over its own copy of the same
    * setup in every SDK and compared to that SDK's own run of `args`, so the two
    * names are proved co-equal per SDK as well as across them. */
   alias?: string[];
   /** Tokens appended to `args`, computed from the prepared run directory: for a
    * case whose argument names a commit the setup itself made. Every setup that
    * uses one pins its commit dates and identity, so all three captures compute
    * the same tokens. */
   extraArgs?: (dir: string) => string[];
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
/** An adopted repository still carrying its original, unwired vendor entrypoint:
 * the state `adopt --wire-adapters` finishes. `adopt` archives the entrypoint's
 * content under governance/ but never rewrites the file itself, so a second run is
 * the only way to convert it, and until that run existed the command printed a
 * remediation and exited 2, leaving the repository permanently non-conformant. */
function adoptedWithUnwiredEntrypoint(dir: string): void {
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests.\n');
   nodeRun(['adopt', '--yes'], dir);
}
/** The same repository with the wiring already applied, for the post-wiring
 * `validate` and the idempotent re-run. */
function adoptedAndWired(dir: string): void {
   adoptedWithUnwiredEntrypoint(dir);
   nodeRun(['adopt', '--yes', '--wire-adapters'], dir);
}
/** Wired, then the original entrypoint content put back, so the next wiring run
 * regenerates a migration doc byte-identical to the archive already on disk. The
 * archive is skipped rather than bumped to `imported-claude-2.md`; nothing but the
 * entrypoint is written. */
function adoptedWiredThenEntrypointRestored(dir: string): void {
   adoptedAndWired(dir);
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests.\n');
}
/** A layer that claims indexed but has no changelog yet (the upgrade case): core
 * init, then bump claimedLevel to indexed. `leji index` must seed the changelog. */
function indexedNoChangelog(dir: string): void {
   nodeRun(['init', '--yes', '--name', 'demo-context'], dir);
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('"claimedLevel": "core"', '"claimedLevel": "indexed"'));
}
/** A seeded layer whose domain index file carries the three rejected path shapes
 * (backslash, leading slash, `..` segment) plus a duplicated entry. The backslash
 * case is the one that catches a port quoting the path rather than interpolating
 * it raw: Go's %q escaped it to `docs\\bad.md` where Node and Python printed
 * `docs\bad.md`, so every one of these messages must compare byte for byte. */
function seedLayerBadIndexPaths(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, 'docs', 'context', 'domain.md'),
      '# Domain\n\n```leji-index\n- path: docs\\bad.md\n- path: /abs/bad.md\n- path: ../up/bad.md\n- path: docs/domain/\n- path: docs/domain/\n```\n',
   );
}
/**
 * A seeded layer whose domain index file opens with a UTF-8 byte order mark, and
 * carries an entry whose trailing comment is preceded by U+00A0 rather than by a
 * space. Both were reproduced divergences of the `leji-index` grammar before it
 * moved to the ASCII alphabet: the BOM parsed in Node and failed with
 * `index-file-parse` in Go and Python, and the NBSP opened a comment in Node and
 * Python but not in Go, so one entry named two different paths. Written as escapes,
 * never as literals, so the fixture is legible in a diff.
 */
function seedLayerNonAsciiIndexWhitespace(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, 'docs', 'context', 'domain.md'),
      '\ufeff# Domain\n\n```leji-index\n- path: docs/domain/\u00a0# a note\n```\n',
   );
}

/**
 * A seeded layer with two decision records whose supersession pointers carry
 * non-ASCII ids. `supersedes` and `supersededBy` are plain strings in the schema
 * (no pattern), so both records validate cleanly and the only thing under test is
 * the formatter: the id reaches the supersession diagnostics as authored text, and
 * Go's `%q` escaped it to a `\u` sequence where Node and Python interpolate the
 * rune raw. This is the measured reachable case behind the wider `%q` sweep, and
 * the same trap the index-entry path fell into.
 *
 * A duplicate non-ASCII `id` would exercise `id-duplicate` too, but `id` carries
 * the lowercase-hyphen pattern, so such a fixture also emits a schema-pattern
 * finding whose wording the three validators do not agree on (reported separately).
 * Pointing at the unpatterned fields isolates this defect from that one.
 */
function seedLayerNonAsciiSupersessionIds(dir: string): void {
   seedLayer(dir);
   const record = (file: string, id: string, fields: string): void =>
      fs.writeFileSync(
         path.join(dir, 'docs', 'decisions', file),
         `---\nid: ${id}\ntitle: ${id}\ndate: 2026-06-20\n${fields}---\n\n# ${id}\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\ne\n`,
      );
   // `supersedes` naming a record that does not exist, and `supersededBy` likewise:
   // two different converted formatters, one non-ASCII id each.
   record('alpha.md', 'alpha', 'status: accepted\nsupersedes: caf\u00e9-r\u00e9sum\u00e9\n');
   record('beta.md', 'beta', 'status: superseded\nsupersededBy: na\u00efve-\u00fcn\u00efcode\n');
}

/**
 * Layers that violate one schema constraint each, so every normalized violation
 * kind is compared byte for byte.
 *
 * The three validators (ajv, santhosh-tekuri, python-jsonschema) word and order the
 * same violation differently, and until these existed the harness's byte-identical
 * claim held only because no fixture violated a `pattern`, an `additionalProperties`
 * or anything else that reaches `schemaErrors`. A guarantee true by omission of the
 * failing cases is not a guarantee.
 */
function seedLayerWithManifest(dir: string, patch: (m: Record<string, unknown>) => void): void {
   seedLayer(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   patch(m);
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
}

/** Write an artifact verbatim over a seeded layer, for the non-manifest schemas. */
function seedLayerWithArtifact(dir: string, rel: string, body: string): void {
   seedLayer(dir);
   const abs = path.join(dir, ...rel.split('/'));
   fs.mkdirSync(path.dirname(abs), { recursive: true });
   fs.writeFileSync(abs, body);
}

const exampleDir = path.join(repoRoot, 'examples', 'monorepo');
function copyExample(dir: string): void {
   // Skip the gitignored `.leji` viewer dir (build output): copying a local one
   // pollutes the sandbox and collides with scenarios that plant their own (EEXIST).
   fs.cpSync(exampleDir, dir, {
      recursive: true,
      filter: (src) => path.basename(src) !== '.leji',
   });
}
const federatedHostDir = path.join(repoRoot, 'examples', 'multi-repo', 'core-context');
/** Federated host example (distribution.md Pattern 3): a layer that mounts a
 * sibling. Exercises the index `mounts` array and federated conformance, so
 * mount-handling drift fails parity. */
function copyFederatedHost(dir: string): void {
   fs.cpSync(federatedHostDir, dir, {
      recursive: true,
      filter: (src) => path.basename(src) !== '.leji',
   });
}

/** A federated host whose mount declares a locator no resolver can normalize. It
 * used to surface as `mount-unavailable`, a warning that reads as "not hydrated
 * here", and to pass conformance's `sibling-mounts` item outright. */
function unnormalizableMountSource(dir: string): void {
   copyFederatedHost(dir);
   patchMountField(dir, 'source', 'file:///srv/product-context');
}

/** A federated host whose mount declares a tracking ref the schema's permissive
 * pattern accepts and `validTrackingRef` refuses. Nothing reported it. */
function resolverIllegalTrackingRef(dir: string): void {
   copyFederatedHost(dir);
   patchMountField(dir, 'trackingRef', 'refs/heads/main@{1}');
}

/** Rewrite one field on the host's single declared mount, in the raw manifest text
 * order the file already has. */
function patchMountField(dir: string, key: string, value: string): void {
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0][key] = value;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
}

/** A federated host with a committed sibling repo inside the run dir and a
 * machine-local hint pointing at it. Commit timestamps are pinned so the sibling's
 * commit id — and with it every pin, cache key, and sidecar field — is identical
 * across the three captures. The index is regenerated (by the reference CLI, so
 * setup is uniform) after the re-pin. */
function mountedFederatedHost(dir: string): void {
   copyFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   fs.cpSync(path.join(repoRoot, 'examples', 'multi-repo', 'product-context'), sib, { recursive: true });
   git(sib, 'init', '-q', '-b', 'main');
   git(sib, 'add', '-A');
   git(sib, '-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
   const pin = git(sib, 'rev-parse', 'HEAD');
   repin(dir, PLACEHOLDER_PIN, pin);
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.writeFileSync(
      path.join(dir, '.leji', 'mounts.local.json'),
      JSON.stringify({ mounts: { 'acme-product-context': { repo: 'sibling' } } }) + '\n',
   );
   execFileSync(process.execPath, [nodeCli, 'index', '--root', dir], { env: realEnv, stdio: 'ignore' });
}
const PLACEHOLDER_PIN = '7d3f2a19c4e8b6a0d5f1c2e9b8a7f6d5c4b3a2e1';
const ACME_SOURCE = 'https://github.com/acme/product-context';
/** Pinned identity and dates, so every commit id — and with it every pin, cache
 * key, ref name, and sidecar field — is identical across the three captures. */
const parityGitEnv: NodeJS.ProcessEnv = {
   ...realEnv,
   GIT_DIR: undefined,
   GIT_AUTHOR_DATE: '2026-07-01T00:00:00 +0000',
   GIT_COMMITTER_DATE: '2026-07-01T00:00:00 +0000',
};
function git(cwd: string, ...args: string[]): string {
   return execFileSync('git', args, { cwd, env: parityGitEnv, encoding: 'utf8' }).trim();
}
function commitIn(repo: string, file: string): string {
   fs.writeFileSync(path.join(repo, file), `# ${file}\n`);
   git(repo, 'add', '-A');
   git(repo, '-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', file);
   return git(repo, 'rev-parse', 'HEAD');
}
/** Raw-text splice of the declared pin, the way the seed swap does it. */
function repin(dir: string, from: string, to: string): void {
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace(from, to));
}
function sha256hex(s: string): string {
   return crypto.createHash('sha256').update(s).digest('hex');
}
/** Build the managed store exactly as `mounts hydrate --fetch` leaves it: the pin
 * retained by refs/leji-pin/v1/ and the witness published under
 * refs/leji-witness/v1/. Built with plain git so no scenario needs the network,
 * and FETCH_HEAD (which records a per-capture path) is dropped. */
function managedStore(dir: string, pin: string, pinSourceRef: string, witnessRef = 'refs/heads/main'): void {
   const sib = path.join(dir, 'sibling');
   const srcKey = sha256hex(ACME_SOURCE);
   const store = path.join(dir, '.leji', 'mounts', 'store', srcKey);
   fs.mkdirSync(store, { recursive: true });
   git(dir, 'init', '--bare', '-q', store);
   git(store, 'fetch', sib, `+${pinSourceRef}:refs/leji-parity/pin-objects`);
   git(store, 'update-ref', `refs/leji-pin/v1/${srcKey}/${pin}`, pin);
   git(store, 'update-ref', '-d', 'refs/leji-parity/pin-objects');
   refreshManagedWitness(dir, witnessRef);
}
/** Republish the managed witness from the sibling's current ref, forced, as a
 * second `--fetch` would. */
function refreshManagedWitness(dir: string, witnessRef = 'refs/heads/main'): void {
   const srcKey = sha256hex(ACME_SOURCE);
   const store = path.join(dir, '.leji', 'mounts', 'store', srcKey);
   git(
      store,
      'fetch',
      path.join(dir, 'sibling'),
      `+${witnessRef}:refs/leji-witness/v1/${srcKey}/${sha256hex(witnessRef)}`,
   );
   fs.rmSync(path.join(store, 'FETCH_HEAD'), { force: true });
}
/** The mounted host, hydrated by the reference CLI so all three SDKs read one cache. */
function hydratedFederatedHost(dir: string): void {
   mountedFederatedHost(dir);
   execFileSync(process.execPath, [nodeCli, 'mounts', 'hydrate', '--root', dir], { env: realEnv, stdio: 'ignore' });
}
/** The mounted host with the managed store holding pin and witness at the same
 * commit: the resolver's own witness wins over the hint (managed provenance). */
function managedUpToDate(dir: string): void {
   mountedFederatedHost(dir);
   managedStore(dir, git(path.join(dir, 'sibling'), 'rev-parse', 'HEAD'), 'refs/heads/main');
}
/** The witness moved past the pin: behind by one. */
function managedBehind(dir: string): void {
   mountedFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   const pin = git(sib, 'rev-parse', 'HEAD');
   commitIn(sib, 'later.md');
   managedStore(dir, pin, 'refs/heads/main');
}
/** The pin sits past the witness on another ref: ahead by one. */
function managedAhead(dir: string): void {
   mountedFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   const seed = git(sib, 'rev-parse', 'HEAD');
   const pin = commitIn(sib, 'next.md');
   git(sib, 'branch', 'next');
   git(sib, 'reset', '-q', '--hard', seed);
   repin(dir, seed, pin);
   managedStore(dir, pin, 'refs/heads/next');
}
/** Pin and witness share an ancestor but neither reaches the other: diverged. */
function managedDiverged(dir: string): void {
   mountedFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   const seed = git(sib, 'rev-parse', 'HEAD');
   git(sib, 'checkout', '-q', '-b', 'side');
   const pin = commitIn(sib, 'side.md');
   git(sib, 'checkout', '-q', 'main');
   commitIn(sib, 'main.md');
   repin(dir, seed, pin);
   managedStore(dir, pin, 'refs/heads/side');
}
/** Pin and witness share no commit at all: unrelated, distinct from diverged. */
function managedUnrelated(dir: string): void {
   mountedFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   const seed = git(sib, 'rev-parse', 'HEAD');
   git(sib, 'checkout', '-q', '--orphan', 'other');
   const pin = commitIn(sib, 'orphan.md');
   git(sib, 'checkout', '-q', 'main');
   repin(dir, seed, pin);
   managedStore(dir, pin, 'refs/heads/other');
}
/** main is rewritten non-fast-forward after the witness was published; the forced
 * refspec must make the witness follow it. */
function managedForcePushed(dir: string): void {
   mountedFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   const pin = git(sib, 'rev-parse', 'HEAD');
   commitIn(sib, 'b.md');
   managedStore(dir, pin, 'refs/heads/main');
   git(sib, 'reset', '-q', '--hard', pin);
   commitIn(sib, 'c.md');
   refreshManagedWitness(dir);
}
/** A shallow store answers the counts it can and never claims complete ancestry. */
function managedShallow(dir: string): void {
   mountedFederatedHost(dir);
   const sib = path.join(dir, 'sibling');
   commitIn(sib, 'depth.md');
   const pin = git(sib, 'rev-parse', 'HEAD');
   repin(dir, git(sib, 'rev-parse', 'HEAD~1'), pin);
   const srcKey = sha256hex(ACME_SOURCE);
   const store = path.join(dir, '.leji', 'mounts', 'store', srcKey);
   fs.mkdirSync(store, { recursive: true });
   git(dir, 'init', '--bare', '-q', store);
   git(
      store,
      'fetch',
      '--depth',
      '1',
      `file://${sib}`,
      `+refs/heads/main:refs/leji-witness/v1/${srcKey}/${sha256hex('refs/heads/main')}`,
   );
   git(store, 'update-ref', `refs/leji-pin/v1/${srcKey}/${pin}`, pin);
   fs.rmSync(path.join(store, 'FETCH_HEAD'), { force: true });
}
/** No hint, no store, no submodule: the pin is unavailable and no count is
 * computed (the counts are absent keys, never nulls). */
function unresolvedMount(dir: string): void {
   copyFederatedHost(dir);
}
/** The same host with no declared witness ref at all. */
function witnesslessMount(dir: string): void {
   copyFederatedHost(dir);
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace(/\s*"trackingRef": "refs\/heads\/main",\n/, '\n'));
}
/** Two host submodules whose `.gitmodules` URLs both normalize to the mount's
 * source, so no single matching repository exists to consult. */
function twoMatchingSubmodules(dir: string): void {
   let modules = '';
   for (const name of ['one', 'two']) {
      const repo = path.join(dir, 'vendor', name);
      fs.mkdirSync(repo, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main', repo);
      modules += `[submodule "${name}"]\n\tpath = vendor/${name}\n\turl = ${ACME_SOURCE}\n`;
   }
   fs.writeFileSync(path.join(dir, '.gitmodules'), modules);
}
/** Two submodules claim the same source: ambiguity is its own answer, never a
 * report that the pin is unavailable in repositories nothing consulted. */
function ambiguousSubmodules(dir: string): void {
   copyFederatedHost(dir);
   twoMatchingSubmodules(dir);
}
/** The same ambiguity WITH a candidate that resolves the pin: the hint holds it,
 * but the sibling's branch was renamed off the declared witness ref, so no source
 * resolves the witness and the ambiguity branch is the only answer left. The
 * scenario above cannot reach that branch (nothing resolves the pin there either),
 * which is exactly the shape a real divergence hid in. */
function ambiguousWithResolvingCandidate(dir: string): void {
   mountedFederatedHost(dir);
   git(path.join(dir, 'sibling'), 'branch', '-m', 'main', 'renamed');
   twoMatchingSubmodules(dir);
}
/** A hydrated host whose published projection lost its completion marker. The
 * directory exists and the cache entry does not, so federation enforcement must
 * read it as not hydrated: the second of the two fixed divergences. */
function hydratedWithoutMarker(dir: string): void {
   hydratedFederatedHost(dir);
   const cache = path.join(dir, '.leji', 'mounts', 'cache');
   for (const key of fs.readdirSync(cache)) {
      fs.rmSync(path.join(cache, key, 'projection', 'complete'), { force: true });
   }
}
/** The example layer with a duplicate mount name beside a clean one, so `validate`
 * emits mount-duplicate + the availability warning identically across SDKs (the
 * severity split must not be TS-only). */
function duplicateMounts(dir: string): void {
   copyExample(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   const owner = { name: 'Jo' };
   const pin = 'a'.repeat(40);
   m.federation = {
      mounts: [
         { name: 'twin', source: 'https://github.com/acme/twin', pin, owner },
         { name: 'twin', source: 'https://github.com/acme/twin-2', pin, owner },
         { name: 'solo', source: 'https://github.com/acme/solo', pin, owner },
      ],
   };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
}

// --- text-identity fixtures: one byte order, raw UTF-8, scalar strings only ----
//
// U+E000 is one UTF-16 code unit and U+10000 is a surrogate pair, so JavaScript's
// default string order puts the astral name FIRST and UTF-8 byte order puts it
// SECOND. Go compares bytes and Python compares code points (the same order), so
// the byte order is the contract every SDK must produce.
const ASTRAL_MOUNT = 'mount-\u{10000}';
const PRIVATE_USE_MOUNT = 'mount-\u{E000}';
// U+2028 and U+2029 are ordinary characters in JSON: canonical output carries
// their raw UTF-8 bytes, never the \u2028 / \u2029 escapes some encoders emit.
const SEPARATOR_MOUNT = 'mount-\u2028\u2029';
/** Redeclare the federated host's mounts under `names`, all at the same sibling
 * revision, re-pointing the machine-local hint (when present) at each name and
 * regenerating the index with the reference CLI so setup stays uniform. */
function renameMounts(dir: string, names: string[]): void {
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   const declared = m.federation.mounts[0];
   m.federation.mounts = names.map((name: string) => ({ ...declared, name }));
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const hint = path.join(dir, '.leji', 'mounts.local.json');
   if (fs.existsSync(hint)) {
      fs.writeFileSync(
         hint,
         JSON.stringify({ mounts: Object.fromEntries(names.map((n) => [n, { repo: 'sibling' }])) }) + '\n',
      );
   }
   execFileSync(process.execPath, [nodeCli, 'index', '--root', dir], { env: realEnv, stdio: 'ignore' });
}
/** Two mount names declared in the order JavaScript would sort them, so any
 * surface still using the default comparator emits them the wrong way round. */
function byteOrderMounts(dir: string): void {
   copyFederatedHost(dir);
   renameMounts(dir, [ASTRAL_MOUNT, PRIVATE_USE_MOUNT]);
}
/** The same pair, hint-resolvable, so the resolver state file's keys are written. */
function byteOrderMountsHydrated(dir: string): void {
   mountedFederatedHost(dir);
   renameMounts(dir, [ASTRAL_MOUNT, PRIVATE_USE_MOUNT]);
}
/** A mount name carrying U+2028 and U+2029. */
function separatorMount(dir: string): void {
   copyFederatedHost(dir);
   renameMounts(dir, [SEPARATOR_MOUNT]);
}
/** A manifest string that is not a well-formed Unicode scalar sequence: a JSON
 * parser accepts the escaped lone surrogate, and strict UTF-8 encoding of one
 * raises in some runtimes and substitutes U+FFFD in others. It is refused at the
 * validation boundary, so it never reaches hashing, sorting, or output. */
function loneSurrogateManifest(dir: string): void {
   copyFederatedHost(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].name = 'mount-\ud800';
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
}
/** The same defect in a mount's declared `topics`, which routing compares against
 * the task's. Driven through file content, never argv: invalid UTF-8 in a command
 * line is not carried identically by the three runtimes (a known, logged
 * divergence), so the caller side of the same rule stays in the unit suites. */
function loneSurrogateTopic(dir: string): void {
   copyFederatedHost(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].topics = ['billing', 'topic-\ud800'];
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
}

// --- mount surfacing: the boot profile's leji-mounts block --------------------
//
// A host that declares `federation.mounts` surfaces each sibling in its boot
// profile (boot-profile.md requirement 9). `validate` reports every condition and
// `conformance` reports the first of them as `mount-discovery`'s detail, so each
// fixture pins BOTH the finding set and the deterministic order it arrives in.

/** A whole `- mount:` record and its indented fields. */
const MOUNT_RECORD = /- mount: .*\n(?: {2}.*\n)*/;
/** The federated host with its boot profile rewritten by `edit`. */
function bootProfileEdit(edit: (text: string) => string): (dir: string) => void {
   return (dir) => {
      copyFederatedHost(dir);
      const p = path.join(dir, 'docs', 'boot-profile.md');
      fs.writeFileSync(p, edit(fs.readFileSync(p, 'utf8')));
   };
}
/** The block stays, the mount it declares loses its entry (mount-surfacing-missing). */
const surfacingMissingEntry = bootProfileEdit((t) => t.replace(MOUNT_RECORD, ''));
/** The entry names a sibling the manifest does not declare, so the declared one is
 * also unsurfaced: unknown and missing, in that order. */
const surfacingUnknownEntry = bootProfileEdit((t) =>
   t.replace('- mount: acme-product-context', '- mount: acme-other-context'),
);
/** The entry's owner is not the declared `owner.name` (mount-surfacing-owner). */
const surfacingOwnerMismatch = bootProfileEdit((t) => t.replace('  owner: Product team', '  owner: Someone Else'));
/** The info string is the tag alone, so a fence carrying two more tokens is a
 * targeted syntax error naming the whole remainder, never an ignored fence. */
const surfacingFenceTokens = bootProfileEdit((t) => t.replace('```leji-mounts', '```leji-mounts extra tokens'));
/** A declared mount name with trailing padding: no block value could carry it, so
 * the finding points at the manifest (mount-name-line) beside the surfacing ones. */
function surfacingPaddedName(dir: string): void {
   copyFederatedHost(dir);
   renameMounts(dir, ['acme-product-context ']);
}
/** The block is there and the manifest declares no mounts at all: surfacing what
 * the layer does not mount is its own error, and conformance reads not-applicable. */
function surfacingBlockWithoutMounts(dir: string): void {
   copyFederatedHost(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   delete m.federation;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   execFileSync(process.execPath, [nodeCli, 'index', '--root', dir], { env: realEnv, stdio: 'ignore' });
}

// --- projection closure: siblings whose closure reaches outside rootPath -------

/** A federated host whose sibling is written here rather than copied, so the
 * sibling's manifest can be shaped per scenario. Committed at the pinned identity
 * and dates, so the commit id — and every cache key, ref and sidecar field derived
 * from it — is identical across the three captures; the hint and the regenerated
 * host index follow `mountedFederatedHost`. */
function siblingHost(files: Record<string, string>): (dir: string) => void {
   return (dir) => {
      copyFederatedHost(dir);
      const sib = path.join(dir, 'sibling');
      for (const [rel, body] of Object.entries(files)) {
         const abs = path.join(sib, ...rel.split('/'));
         fs.mkdirSync(path.dirname(abs), { recursive: true });
         fs.writeFileSync(abs, body);
      }
      git(sib, 'init', '-q', '-b', 'main');
      git(sib, 'add', '-A');
      git(sib, '-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
      repin(dir, PLACEHOLDER_PIN, git(sib, 'rev-parse', 'HEAD'));
      fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
      fs.writeFileSync(
         path.join(dir, '.leji', 'mounts.local.json'),
         JSON.stringify({ mounts: { 'acme-product-context': { repo: 'sibling' } } }) + '\n',
      );
      execFileSync(process.execPath, [nodeCli, 'index', '--root', dir], { env: realEnv, stdio: 'ignore' });
   };
}
/** A sibling whose closure is nowhere near its `rootPath`: the boot profile, the
 * category index and the machine index live in `meta/`, the bound profile in
 * `profiles/`, and one governed path the pinned index names sits in `outside/`.
 * `noise/` is in the repository and in no selection, so a projection that carries
 * it is projecting the repository rather than the layer. */
function closureSibling(manifest: Record<string, unknown>): Record<string, string> {
   return {
      'leji.json': JSON.stringify(manifest, null, 2) + '\n',
      'meta/boot-profile.md': '# Sibling boot profile\n',
      'meta/domain.md': '# Domain\n\n```leji-index\n- path: docs/domain/glossary.md\n```\n',
      'meta/context-index.json':
         JSON.stringify({ entries: [{ path: 'docs/domain/glossary.md' }, { path: 'outside/extra.md' }] }, null, 2) +
         '\n',
      'profiles/core.md': '---\nid: core\nname: Core\nrole: core\n---\n\n# Core\n',
      'docs/domain/glossary.md': '# Glossary\n',
      'outside/extra.md': '# Governed, and outside rootPath\n',
      'noise/unselected.md': '# In the repository, in no selection\n',
   };
}
/** The closure sibling's manifest, with `overrides` spliced in per scenario. */
function closureManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
   return {
      leji: '1.0',
      name: 'acme-product-context',
      description: 'Sibling whose projection closure reaches outside its rootPath.',
      rootPath: 'docs/',
      bootProfilePath: 'meta/boot-profile.md',
      categories: { domain: { indexes: ['meta/domain.md'] } },
      machine: { indexPath: 'meta/context-index.json', agentProfilesPath: 'profiles/' },
      agents: { core: 'profiles/core.md' },
      owners: { primary: { name: 'Rin Mehta' } },
      ...overrides,
   };
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
/** A clean git repo with a file under docs/.leji/ already tracked, for the
 * onboarding-workspace privacy preflight (init must refuse identically). */
function trackedLejiRepo(dir: string): void {
   const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
   };
   git('init', '-q');
   fs.mkdirSync(path.join(dir, 'docs', '.leji'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', '.leji', 'stale.md'), 'tracked artifact\n');
   git('add', '-A');
   git('-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
}

// --- self-projection: what `leji status` reports about this layer at HEAD ------
//
// These commit through the pinned-date helper rather than `gitLayer`'s plain one,
// because `status` prints HEAD's commit id: an unpinned committer date would give
// each capture a different sha and the scenario would fail on its own scaffolding.

/** Commit everything in `dir` at the pinned identity and dates. */
function commitLayer(dir: string): void {
   git(dir, 'init', '-q', '-b', 'main');
   git(dir, 'add', '-A');
   git(dir, '-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
}
/** The example layer committed whole: the closure enumerates completely at HEAD. */
function committedLayer(dir: string): void {
   copyExample(dir);
   commitLayer(dir);
}
/** An unborn repository: HEAD resolves to no commit, so there is nothing to judge
 * and no SDK may guess at a projection. */
function unbornLayer(dir: string): void {
   copyExample(dir);
   git(dir, 'init', '-q', '-b', 'main');
}
/** The bound agent profile exists on disk but was never committed: `validate` reads
 * the working tree and is clean, while the projection reads HEAD's object store and
 * is not. The pair is the point — one command's silence is not the other's. */
function untrackedBoundProfile(dir: string): void {
   copyExample(dir);
   const profile = path.join(dir, 'docs', 'agents', 'thought-partner.md');
   const body = fs.readFileSync(profile, 'utf8');
   fs.rmSync(profile);
   commitLayer(dir);
   fs.writeFileSync(profile, body);
}

// --- agent-profile inheritance (single level, resolved against the roster) -----

/** The example layer's inheriting profile re-pointed at `target`. */
function inheritsTarget(target: string): (dir: string) => void {
   return (dir) => {
      copyExample(dir);
      const profile = path.join(dir, 'docs', 'agents', 'thought-partner.md');
      fs.writeFileSync(profile, fs.readFileSync(profile, 'utf8').replace('inherits: core', `inherits: ${target}`));
   };
}
/** Two profiles declare `id: core`, so the target is not unique. The message lists
 * both paths, which pins the profile set's byte order as well as the rule. */
function ambiguousInheritsTarget(dir: string): void {
   copyExample(dir);
   const agents = path.join(dir, 'docs', 'agents');
   fs.copyFileSync(path.join(agents, 'core.md'), path.join(agents, 'core-twin.md'));
}
/** The base itself declares `inherits`, which the single level forbids: the core
 * profile and the profile extending it are each unusable, and both are flagged. */
function coreDeclaresInherits(dir: string): void {
   copyExample(dir);
   const core = path.join(dir, 'docs', 'agents', 'core.md');
   fs.writeFileSync(
      core,
      fs.readFileSync(core, 'utf8').replace('role: core\n', 'role: core\ninherits: thought-partner\n'),
   );
}
/** A base bound through the `agents` map from OUTSIDE the profiles directory, and
 * not a core profile. A bound profile is part of the roster wherever it sits, so
 * the target must be FOUND (not `inherits-unknown`) and then refused for its role. */
function outOfDirectoryBase(dir: string): void {
   inheritsTarget('outside-base')(dir);
   const mp = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.agents = { ...m.agents, 'outside-base': 'roster/base.md' };
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.mkdirSync(path.join(dir, 'roster'), { recursive: true });
   fs.writeFileSync(
      path.join(dir, 'roster', 'base.md'),
      '---\nid: outside-base\nname: Outside Base\nrole: reviewer\nrequiredRead:\n  - docs/boot-profile.md\nmustAskWhen:\n  - the change is not reviewable\n---\n\n# Outside Base\n',
   );
}

// An existing path outside any layer root. Symlinking a declared file here exercises
// the read-side confinement guards; the target string is byte-identical, so the tree
// snapshots stay comparable.
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
/** The example layer plus a real markdown file and an IN-REPO symlink to it inside a
 * category directory. The directory walk must skip the symlink in all three SDKs, or
 * the generated index diverges (the Python walk used to follow it). */
function symlinkedMdInCategory(dir: string): void {
   copyExample(dir);
   fs.writeFileSync(
      path.join(dir, 'docs', 'domain', 'real-extra.md'),
      '---\nsummary: extra\n---\n\n# Extra\n\n- a term\n',
   );
   fs.symlinkSync('real-extra.md', path.join(dir, 'docs', 'domain', 'linked-extra.md'));
}
/** The example layer with a governed doc moved AND edited (no frontmatter id), so its
 * slug-derived id vanishes: `index` warns identically across SDKs (id-vanished). */
function vanishedId(dir: string): void {
   copyExample(dir);
   const old = path.join(dir, 'docs', 'domain', 'glossary.md');
   const content = fs.readFileSync(old, 'utf8') + '\n- an added term that changes the content hash\n';
   fs.rmSync(old);
   fs.writeFileSync(path.join(dir, 'docs', 'domain', 'renamed-glossary.md'), content);
}
/** The example layer plus two markdown files under the governed root that no
 * category index lists, so the `index` generate run ends with its unindexed
 * count. The line is spec-pinned byte for byte, so any wording, pluralization or
 * dash divergence between the SDKs fails here. The zero case is the plain
 * `index generate` scenario: the example layer is fully indexed and must stay
 * silent in all three. */
function unindexedUnderRoot(dir: string): void {
   copyExample(dir);
   fs.mkdirSync(path.join(dir, 'docs', 'notes'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'docs', 'notes', 'loose.md'), '# Loose\n');
   fs.writeFileSync(path.join(dir, 'docs', 'stray.md'), '# Stray\n');
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
 * escaping the root: viewer generation refuses every write, so `export` must
 * abort with findings before any destructive cleanup (not report success). */
function symlinkedViewerDir(dir: string): void {
   copyExample(dir);
   const viewerDir = path.join(dir, 'docs', '.leji');
   fs.rmSync(viewerDir, { recursive: true, force: true });
   fs.symlinkSync('/etc', viewerDir);
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

// --- local-first CI variant: package.json declaring @leji-org/leji ---
/** Seeded layer whose package.json declares the dep (generation picks the local install). */
function seedLayerWithDep(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'demo', devDependencies: { '@leji-org/leji': '^1.3.0' } }, null, 2) + '\n',
   );
}
/** Seeded layer whose package.json is BOM-prefixed and declares the dep (BOM stripped -> local). */
function seedLayerWithDepBom(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, 'package.json'),
      '\ufeff' + JSON.stringify({ name: 'demo', dependencies: { '@leji-org/leji': '1.3.0' } }, null, 2) + '\n',
   );
}
/** Seeded layer whose package.json has `dependencies` as an array (not an object -> fallback). */
function seedLayerWithDepArray(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: ['@leji-org/leji'] }, null, 2) + '\n',
   );
}
/** Seeded layer whose package.json is unparseable (-> fallback). */
function seedLayerWithBadPkg(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(path.join(dir, 'package.json'), '{ not json\n');
}

// --- ci --hooks (real env: hook resolution shells out to git) ---
/** Seed a layer then `git init` in place, so `ci --hooks` has a real repo. */
function gitInitSeeded(dir: string): void {
   seedLayer(dir);
   execFileSync('git', ['init', '-q'], { cwd: dir, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
}
function setHooksPathAt(dir: string, value: string): void {
   execFileSync('git', ['config', 'core.hooksPath', value], {
      cwd: dir,
      env: { ...realEnv, GIT_DIR: undefined },
      stdio: 'ignore',
   });
}
function hooksCustom(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, 'githooks');
}
function hooksHuskyV9(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, '.husky/_');
}
function hooksHuskyV8(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, '.husky');
}
/** Custom in-repo hooks dir already holding a foreign (unmanaged) pre-commit. */
function hooksForeign(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, 'githooks');
   fs.mkdirSync(path.join(dir, 'githooks'), { recursive: true });
   fs.writeFileSync(path.join(dir, 'githooks', 'pre-commit'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
}
/** A global-style absolute hooksPath pointing outside the repo (fixed path so the
 * reported target is byte-identical across captures); nothing is written there. */
function hooksOutOfRoot(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, '/tmp/leji-parity-oob-hooks');
}
/** A husky v9 repo whose managed `.husky/pre-commit` was already written (idempotency). */
function hooksIdempotentV9(dir: string): void {
   hooksHuskyV9(dir);
   execFileSync(process.execPath, [nodeCli, 'ci', '--hooks', '--root', dir], { env: realEnv, stdio: 'ignore' });
}
/** A direct-`.husky` v8 repo whose managed hook is byte-current but non-executable
 * (the mode-only correction: rewritten executable, reported `updated`). */
function hooksV8NonExec(dir: string): void {
   hooksHuskyV8(dir);
   execFileSync(process.execPath, [nodeCli, 'ci', '--hooks', '--root', dir], { env: realEnv, stdio: 'ignore' });
   fs.chmodSync(path.join(dir, '.husky', 'pre-commit'), 0o644);
}
/** Seeded layer whose package.json has a NaN dep value (non-finite -> strict-parse fallback). */
function seedLayerWithDepNaN(dir: string): void {
   seedLayer(dir);
   fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"@leji-org/leji":NaN}}\n');
}
/** Husky v9 whose configured hooksPath carries a `..` segment (normalization to `.husky/_`). */
function hooksHuskyV9Dotdot(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, 'sub/../.husky/_');
}
/** Custom in-repo hooks dir whose managed hook is byte-current but non-executable (the
 * standalone mode-only correction; the exec bit is visible in the tree). */
function hooksCustomNonExec(dir: string): void {
   hooksCustom(dir);
   execFileSync(process.execPath, [nodeCli, 'ci', '--hooks', '--root', dir], { env: realEnv, stdio: 'ignore' });
   fs.chmodSync(path.join(dir, 'githooks', 'pre-commit'), 0o644);
}
/** A tilde core.hooksPath; with HOME fixed outside the repo (scenario env), the
 * effective hooks dir is out-of-root -> manual with a fixed reported target. */
function hooksTilde(dir: string): void {
   gitInitSeeded(dir);
   setHooksPathAt(dir, '~/hooks');
}
/** A main repo with a linked worktree; `ci --hooks --root wt` resolves the shared hooks
 * dir under the main repo, which is out-of-root of the worktree -> manual. */
function hooksLinkedWorktree(dir: string): void {
   const main = path.join(dir, 'main');
   fs.mkdirSync(main, { recursive: true });
   seedLayer(main);
   const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: main, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
   };
   git('init', '-q');
   git('add', '-A');
   git('-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
   git('worktree', 'add', '-q', path.join(dir, 'wt'));
}

/** A shared fixture copied in and committed. `leji badge` reports the level this
 * offline run verified, and the indexed changelog item is `unknown` without a
 * committed baseline, so an uncommitted copy of a governed fixture badges `core`.
 * Every badge scenario over a fixture therefore runs `real` and commits first. */
function gitFixture(name: string): (dir: string) => void {
   return (dir) => {
      fs.cpSync(path.join(repoRoot, 'fixtures', name), dir, { recursive: true });
      const git = (...a: string[]): void => {
         execFileSync('git', a, { cwd: dir, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
      };
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
   };
}
/** A committed governed layer whose `leji-badge.svg` is the *previous* level's
 * canonical badge: the level-change regeneration path. The tool recognizes its own
 * output by bytes alone, so this one overwrites where a foreign file refuses. */
function badgeStale(dir: string): void {
   gitFixture('valid-badge-governed-regen')(dir);
   fs.copyFileSync(path.join(repoRoot, 'fixtures', 'badge', 'indexed.svg'), path.join(dir, 'leji-badge.svg'));
}
/** A committed layer carrying a file at the badge path that is not a badge: the
 * refusal, which must leave those bytes exactly as they are in all three. */
function badgeForeignFile(dir: string): void {
   gitLayer(dir);
   fs.writeFileSync(path.join(dir, 'leji-badge.svg'), 'not a badge\n');
}
/** A committed layer whose badge target is a DANGLING symlink inside the repository:
 * a standing entry, never an absence, so the run refuses rather than writing through
 * it — and the link's destination is never created. */
function badgeTargetDangling(dir: string): void {
   gitLayer(dir);
   fs.symlinkSync('never-created.svg', path.join(dir, 'leji-badge.svg'));
}

const BADGE_SCENARIOS_ENABLED = true;
const BADGE_SCENARIOS: Scenario[] = [
   // --- badge (real: the level a badge states needs a git baseline) ---
   { name: 'badge on a committed layer', mode: 'real', setup: gitLayer, args: ['badge'] },
   { name: 'badge --out docs/badge.svg', mode: 'real', setup: gitLayer, args: ['badge', '--out', 'docs/badge.svg'] },
   { name: 'badge --json', mode: 'real', setup: gitLayer, args: ['badge', '--json'] },
   // The badge states what this offline run verified, never the claim: a declared
   // mount leaves `pin-reachable` unknown, so a federated claim badges `governed`.
   {
      name: 'badge caps a federated claim at the verified level',
      mode: 'real',
      setup: gitFixture('valid-badge-federated-capped'),
      args: ['badge', '--json'],
   },
   // A claim the run refutes writes nothing at all (exit 1), rather than badging
   // the lower level: the findings are the answer, not a downgrade.
   {
      name: 'badge on a failing claim',
      mode: 'real',
      setup: gitFixture('invalid-governed-no-profile'),
      args: ['badge'],
   },
   { name: 'badge regenerates a stale badge', mode: 'real', setup: badgeStale, args: ['badge'] },
   { name: 'badge refuses a foreign file', mode: 'real', setup: badgeForeignFile, args: ['badge'] },
   // A standing entry that is not a regular file inside the repository is refused as
   // the ordinary badge document at exit 2, and nothing is created through the link.
   {
      name: 'badge refuses a dangling target link',
      mode: 'real',
      setup: badgeTargetDangling,
      args: ['badge', '--json'],
   },
   // An accepted `--out` is echoed back in its canonical POSIX form — `.` segments
   // dropped — and that form is what stdout, the JSON and the markdown all carry.
   {
      name: 'badge --out ./x.svg canonicalizes',
      mode: 'real',
      setup: gitLayer,
      args: ['badge', '--out', './x.svg', '--json'],
   },
   // `--out` takes a repository-relative POSIX `.svg` path over [A-Za-z0-9._/-] and
   // nothing else; `.leji/` is tool domain and never a badge target. Each rejection
   // is exit 2, and the tree compare asserts nothing is written.
   { name: 'badge --out .leji/x.svg (reject)', setup: seedLayer, args: ['badge', '--out', '.leji/x.svg'] },
   { name: 'badge --out ../x.svg (reject)', setup: seedLayer, args: ['badge', '--out', '../x.svg'] },
   { name: 'badge --out absolute (reject)', setup: seedLayer, args: ['badge', '--out', '/abs.svg'] },
   { name: 'badge --out with a backslash (reject)', setup: seedLayer, args: ['badge', '--out', 'a\\b.svg'] },
   { name: 'badge --out a non-svg (reject)', setup: seedLayer, args: ['badge', '--out', 'x.png'] },
   // No endpoint, URL, host, token or destination parameter exists on this command.
   { name: 'badge --endpoint (reject)', setup: seedLayer, args: ['badge', '--endpoint', 'x'] },
];

// --- F9: the trust boundary (absolute containment, standing entries, verified reads) ---
// Every setup below plants its symlink with a FIXED target — an absolute path outside
// any layer, or a relative name that never resolves — so the planted link is
// byte-identical in all three captures and the tree snapshots stay comparable. What
// they pin is the refusal: identical exit, identical bytes, and a tree that shows the
// link exactly as it was planted with nothing created through it.

// A directory that exists outside any layer root. A `.leji/` role aliased here is the
// former relocate/publish alias, refused now by absolute containment.
const ESCAPE_DIR = '/etc';
/** The example layer whose default export role is symlinked OUT of the repository. */
function distSymlinkedOutside(dir: string): void {
   copyExample(dir);
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.symlinkSync(ESCAPE_DIR, path.join(dir, '.leji', 'dist'));
}
/** The example layer whose `--out published` target is symlinked out of the tree. */
function outSymlinkedOutside(dir: string): void {
   copyExample(dir);
   fs.symlinkSync(ESCAPE_DIR, path.join(dir, 'published'));
}
/** The example layer whose viewer role is symlinked out of the repository: generation
 * refuses the role, so the export aborts before any destructive cleanup. */
function viewerSymlinkedOutside(dir: string): void {
   copyExample(dir);
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.symlinkSync(ESCAPE_DIR, path.join(dir, '.leji', 'viewer'));
}
/** The example layer whose default output entry is a DANGLING symlink: a standing
 * entry, never an absence, so the build refuses before resolving it and the link's
 * destination is never created. */
function distDangling(dir: string): void {
   copyExample(dir);
   fs.mkdirSync(path.join(dir, '.leji'), { recursive: true });
   fs.symlinkSync(path.join('..', 'site'), path.join(dir, '.leji', 'dist'));
}
/** The same for a caller `--out` that is otherwise a legal target. */
function outDangling(dir: string): void {
   copyExample(dir);
   fs.symlinkSync('elsewhere', path.join(dir, 'published'));
}
/** An occupied `--out` whose marker file is a symlink OUT of the repository: the
 * marker that authorizes a recursive clear is read through the verified read, so a
 * source the rule refuses is not a previous export and the tree is refused rather
 * than deleted. */
function outMarkerSymlinked(dir: string): void {
   copyExample(dir);
   const out = path.join(dir, 'site');
   fs.mkdirSync(out, { recursive: true });
   fs.symlinkSync(ESCAPE_TARGET, path.join(out, 'index.html'));
}
/** An empty repository whose `.gitignore` is a symlink escaping the root: the ignore
 * line init merges goes through the chokepoint, so the write is refused and no layer
 * is scaffolded. */
function gitignoreSymlinkedOutside(dir: string): void {
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, '.gitignore'));
}
/** An empty repository whose leji.json name is a dangling symlink: the exclusive
 * create judges the standing entry, so this is the already-exists refusal and the
 * link's destination is never created. */
function manifestNameDangling(dir: string): void {
   fs.symlinkSync('never-created.json', path.join(dir, 'leji.json'));
}
/** A seeded layer whose agent profile name is a dangling symlink: both halves of the
 * binding are judged before either is written, so neither is. */
function agentProfileDangling(dir: string): void {
   seedLayer(dir);
   fs.mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true });
   fs.symlinkSync('never-created.md', path.join(dir, 'docs', 'agents', 'reviewer.md'));
}
/** A seeded layer whose agent-profiles directory is symlinked out of the repository. */
function agentProfilesDirOutside(dir: string): void {
   seedLayer(dir);
   fs.rmSync(path.join(dir, 'docs', 'agents'), { recursive: true, force: true });
   fs.symlinkSync(ESCAPE_DIR, path.join(dir, 'docs', 'agents'));
}
/** A seeded layer whose manifest is symlinked out of the repository, as `agent` meets
 * it: the manifest it would splice and write back is not inside the tree. */
function agentManifestOutside(dir: string): void {
   seedLayer(dir);
   fs.rmSync(path.join(dir, 'leji.json'), { force: true });
   fs.symlinkSync(ESCAPE_TARGET, path.join(dir, 'leji.json'));
}
/** The example layer with a standing entry at overview.md that is not a regular file:
 * the map is neither seeded through it nor refreshed from bytes read by pathname. */
function overviewStanding(plant: (abs: string) => void): (dir: string) => void {
   return (dir) => {
      copyExample(dir);
      const abs = path.join(dir, 'docs', 'overview.md');
      fs.rmSync(abs, { recursive: true, force: true });
      plant(abs);
   };
}
/** A layer claiming indexed whose changelog name is a dangling symlink: the seed's
 * exclusive create treats any standing entry as already present. */
function indexedDanglingChangelog(dir: string): void {
   indexedNoChangelog(dir);
   fs.symlinkSync('never-created.json', path.join(dir, 'docs', 'context-changelog.json'));
}
/** A seeded layer whose CI target is a dangling symlink, per provider: presence is
 * decided by the verified read, so the create never lands at the link's destination. */
function ciTargetDangling(rel: string): (dir: string) => void {
   return (dir) => {
      seedLayer(dir);
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync('never-created.yml', abs);
   };
}
/** An adopted repository whose vendor entrypoint is a dangling symlink: unverifiable
 * as a regular file inside the repository, so the wiring run treats it as absent. */
function adoptedWithDanglingEntrypoint(dir: string): void {
   fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Always run tests.\n');
   nodeRun(['adopt', '--yes'], dir);
   fs.rmSync(path.join(dir, 'CLAUDE.md'), { force: true });
   fs.symlinkSync('never-created.md', path.join(dir, 'CLAUDE.md'));
}
/** The federated host whose private mounts role is symlinked into ANOTHER private
 * role: the store, cache entry and staging destinations go through the chokepoint, so
 * the projection is never materialized through the planted link. */
function mountsRoleAliasedIntoAnotherRole(dir: string): void {
   mountedFederatedHost(dir);
   fs.rmSync(path.join(dir, '.leji', 'mounts'), { recursive: true, force: true });
   fs.mkdirSync(path.join(dir, '.leji', 'work', 'planted'), { recursive: true });
   fs.symlinkSync(path.join('work', 'planted'), path.join(dir, '.leji', 'mounts'));
}
/** The same alias, pointing out of the repository. */
function mountsRoleAliasedOutside(dir: string): void {
   mountedFederatedHost(dir);
   fs.rmSync(path.join(dir, '.leji', 'mounts'), { recursive: true, force: true });
   fs.symlinkSync(ESCAPE_DIR, path.join(dir, '.leji', 'mounts'));
}

// --- F3: `mounts update-pin` (held until the ports land) ----------------------
// The pin move is the one federation command that WRITES the manifest, so these
// scenarios compare the written tree as closely as the output: a refusal must leave
// leji.json byte-identical in all three, and an update must change exactly the pin.

/** A managed store holding the pin and NO witness at all: the row-1 operand is
 * there and the row-2 walk finds nothing that resolves the ref. */
function storeWithoutWitness(dir: string): void {
   mountedFederatedHost(dir);
   fs.rmSync(path.join(dir, '.leji', 'mounts.local.json'));
   const sib = path.join(dir, 'sibling');
   const pin = git(sib, 'rev-parse', 'HEAD');
   const srcKey = sha256hex(ACME_SOURCE);
   const store = path.join(dir, '.leji', 'mounts', 'store', srcKey);
   fs.mkdirSync(store, { recursive: true });
   git(dir, 'init', '--bare', '-q', store);
   git(store, 'fetch', sib, `+${pin}:refs/leji-parity/pin-objects`);
   git(store, 'update-ref', `refs/leji-pin/v1/${srcKey}/${pin}`, pin);
   git(store, 'update-ref', '-d', 'refs/leji-parity/pin-objects');
   fs.rmSync(path.join(store, 'FETCH_HEAD'), { force: true });
}

/** The witness is one commit ahead of the pin, but the store holds both as shallow
 * roots: it can count, and cannot say whether one reaches the other. */
function managedShallowBehind(dir: string): void {
   mountedFederatedHost(dir);
   fs.rmSync(path.join(dir, '.leji', 'mounts.local.json'));
   const sib = path.join(dir, 'sibling');
   const pin = git(sib, 'rev-parse', 'HEAD');
   commitIn(sib, 'later.md');
   const srcKey = sha256hex(ACME_SOURCE);
   const store = path.join(dir, '.leji', 'mounts', 'store', srcKey);
   fs.mkdirSync(store, { recursive: true });
   git(dir, 'init', '--bare', '-q', store);
   git(sib, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
   git(
      store,
      'fetch',
      '--depth',
      '1',
      `file://${sib}`,
      `+refs/heads/main:refs/leji-witness/v1/${srcKey}/${sha256hex('refs/heads/main')}`,
   );
   git(store, 'fetch', '--depth', '1', `file://${sib}`, pin);
   git(store, 'update-ref', `refs/leji-pin/v1/${srcKey}/${pin}`, pin);
   fs.rmSync(path.join(store, 'FETCH_HEAD'), { force: true });
}

/** The declared source is a locator no test may reach, so `--fetch` scenarios route
 * it at git's own level. The mirror lives at a FIXED path outside the run directory
 * — the scenario env has to name it as a constant, and the tree snapshot covers the
 * run directory alone — and every capture rebuilds it from its own sibling, whose
 * commit ids the pinned dates make identical anyway. */
const UPDATE_PIN_SOURCE = path.join(os.tmpdir(), 'leji-parity-update-pin-source');
function publishUpdatePinSource(dir: string): void {
   fs.rmSync(UPDATE_PIN_SOURCE, { recursive: true, force: true });
   git(dir, 'clone', '-q', '--bare', path.join(dir, 'sibling'), UPDATE_PIN_SOURCE);
   git(UPDATE_PIN_SOURCE, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
}
/** The host resolves the pin through a hint only; the source is reachable. */
function fetchableHintOnly(dir: string): void {
   managedBehindHintOnly(dir);
   publishUpdatePinSource(dir);
}
/** `managedBehind` without the store: the witness moved on, and only the hint
 * resolves anything until `--fetch` establishes the managed store. */
function managedBehindHintOnly(dir: string): void {
   mountedFederatedHost(dir);
   commitIn(path.join(dir, 'sibling'), 'later.md');
}
/** No trackingRef declared at all, with a reachable source: `--fetch` has to
 * resolve the advertised default branch and report it. */
function fetchableWitnessless(dir: string): void {
   fetchableHintOnly(dir);
   const mp = path.join(dir, 'leji.json');
   fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace(/\s*"trackingRef": "refs\/heads\/main",\n/, '\n'));
}
/** The store already holds the pin, so retention succeeds without the network and
 * the witness refresh is the act that fails. */
function fetchUnreachableWithStore(dir: string): void {
   storeWithoutWitness(dir);
}
const UPDATE_PIN_FETCH_ENV = {
   GIT_CONFIG_COUNT: '1',
   GIT_CONFIG_KEY_0: `url.${UPDATE_PIN_SOURCE}.insteadOf`,
   GIT_CONFIG_VALUE_0: ACME_SOURCE,
};
const UPDATE_PIN_UNREACHABLE_ENV = {
   GIT_CONFIG_COUNT: '1',
   GIT_CONFIG_KEY_0: `url.${UPDATE_PIN_SOURCE}-never-created.insteadOf`,
   GIT_CONFIG_VALUE_0: ACME_SOURCE,
};

/** The witness tip the setup left on the sibling's main: what `--to` names. */
const siblingTip = (dir: string): string => git(path.join(dir, 'sibling'), 'rev-parse', 'refs/heads/main');
const ABSENT_OID = 'f'.repeat(40);
const UP = ['mounts', 'update-pin', 'acme-product-context'];

const UPDATE_PIN_SCENARIOS_ENABLED = true;
const UPDATE_PIN_SCENARIOS: Scenario[] = [
   // --- the offline matrix ---
   { name: 'mounts update-pin (witness ahead, human)', mode: 'real', setup: managedBehind, args: UP },
   { name: 'mounts update-pin --json (witness ahead)', mode: 'real', setup: managedBehind, args: [...UP, '--json'] },
   {
      name: 'mounts update-pin --json (already the target)',
      mode: 'real',
      setup: managedUpToDate,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (diverged, refused)',
      mode: 'real',
      setup: managedDiverged,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (unrelated, refused)',
      mode: 'real',
      setup: managedUnrelated,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (no witness resolves)',
      mode: 'real',
      setup: storeWithoutWitness,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (no reachable pin)',
      mode: 'real',
      setup: unresolvedMount,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (shallow store, ancestry incomplete)',
      mode: 'real',
      setup: managedShallowBehind,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (no trackingRef, offline)',
      mode: 'real',
      setup: witnesslessMount,
      args: [...UP, '--json'],
   },
   {
      name: 'mounts update-pin --json (unknown mount)',
      mode: 'real',
      setup: managedBehind,
      args: ['mounts', 'update-pin', 'no-such-mount', '--json'],
   },
   {
      name: 'mounts update-pin --json (--dry-run writes nothing)',
      mode: 'real',
      setup: managedBehind,
      args: [...UP, '--dry-run', '--json'],
   },
   // --- an explicit target, and the narrow override ---
   {
      name: 'mounts update-pin --json (--to a held descendant)',
      mode: 'real',
      setup: managedBehind,
      args: [...UP, '--json', '--to'],
      extraArgs: (dir) => [siblingTip(dir)],
   },
   {
      name: 'mounts update-pin --json (--to=<oid>, the attached spelling)',
      mode: 'real',
      setup: managedBehind,
      args: [...UP, '--json'],
      extraArgs: (dir) => [`--to=${siblingTip(dir)}`],
   },
   {
      name: 'mounts update-pin --json (--to nothing holds)',
      mode: 'real',
      setup: managedBehind,
      args: [...UP, '--json', '--to', ABSENT_OID],
   },
   {
      name: 'mounts update-pin --json (--to + --allow-non-fast-forward on a diverged pin)',
      mode: 'real',
      setup: managedDiverged,
      args: [...UP, '--json', '--allow-non-fast-forward', '--to'],
      extraArgs: (dir) => [siblingTip(dir)],
   },
   {
      // A dry run still exercises the override: same warning, same override:true,
      // and the manifest is byte-identical in all three.
      name: 'mounts update-pin --json (--dry-run with the non-fast-forward override)',
      mode: 'real',
      setup: managedDiverged,
      args: [...UP, '--json', '--dry-run', '--allow-non-fast-forward', '--to'],
      extraArgs: (dir) => [siblingTip(dir)],
   },
   // --- `--fetch`: the declared source, and nothing else ---
   {
      name: 'mounts update-pin --json (--fetch establishes the managed comparison)',
      mode: 'real',
      setup: fetchableHintOnly,
      args: [...UP, '--fetch', '--json'],
      env: UPDATE_PIN_FETCH_ENV,
   },
   {
      name: 'mounts update-pin --json (--fetch --dry-run: the store acts happen, the rewrite does not)',
      mode: 'real',
      setup: fetchableHintOnly,
      args: [...UP, '--fetch', '--dry-run', '--json'],
      env: UPDATE_PIN_FETCH_ENV,
   },
   {
      name: 'mounts update-pin --json (--fetch resolves the advertised default ref)',
      mode: 'real',
      setup: fetchableWitnessless,
      args: [...UP, '--fetch', '--json'],
      env: UPDATE_PIN_FETCH_ENV,
   },
   {
      name: 'mounts update-pin --json (--fetch cannot retain the current pin, refused)',
      mode: 'real',
      setup: unresolvedMount,
      args: [...UP, '--fetch', '--json'],
      env: UPDATE_PIN_UNREACHABLE_ENV,
   },
   {
      name: 'mounts update-pin --json (--fetch cannot refresh the witness, refused)',
      mode: 'real',
      setup: fetchUnreachableWithStore,
      args: [...UP, '--fetch', '--json'],
      env: UPDATE_PIN_UNREACHABLE_ENV,
   },
   // --- the command surface: every rejection, in all three ---
   { name: 'mounts update-pin (missing name)', mode: 'real', setup: managedBehind, args: ['mounts', 'update-pin'] },
   { name: 'mounts update-pin (surplus positional)', mode: 'real', setup: managedBehind, args: [...UP, 'extra'] },
   {
      name: 'mounts update-pin --allow-non-fast-forward alone (reject)',
      mode: 'real',
      setup: managedBehind,
      args: [...UP, '--allow-non-fast-forward'],
   },
   { name: 'mounts update-pin --to xyz (reject)', setup: seedLayer, args: [...UP, '--to', 'xyz'] },
   { name: 'mounts update-pin --to (missing value)', setup: seedLayer, args: [...UP, '--to'] },
   {
      name: 'mounts update-pin --to (an abbreviated id, reject)',
      setup: seedLayer,
      args: [...UP, '--to', '7d3f2a19c4e8'],
   },
   { name: 'mounts update-pin --to (uppercase hex, reject)', setup: seedLayer, args: [...UP, '--to', 'A'.repeat(40)] },
   { name: 'mounts update-pin --to (41 hex, reject)', setup: seedLayer, args: [...UP, '--to', '0'.repeat(41)] },
   {
      name: 'mounts update-pin --to (64 hex, accepted shape)',
      mode: 'real',
      setup: managedBehind,
      args: [...UP, '--json', '--to', '0'.repeat(64)],
   },
   { name: 'mounts update-pin --endpoint (reject)', setup: seedLayer, args: [...UP, '--endpoint', 'x'] },
   { name: 'mounts update-pin --check-integrity (reject)', setup: seedLayer, args: [...UP, '--check-integrity'] },
   { name: 'mounts status --to (reject)', setup: seedLayer, args: ['mounts', 'status', '--to', '0'.repeat(40)] },
   {
      name: 'mounts status --allow-non-fast-forward (reject)',
      setup: seedLayer,
      args: ['mounts', 'status', '--allow-non-fast-forward'],
   },
   // The sub-guard's accepted and rejected spellings, in one place.
   { name: 'mounts update-pin --help', setup: seedLayer, args: ['mounts', 'update-pin', '--help'] },
   { name: 'mounts updatepin (reject)', setup: seedLayer, args: ['mounts', 'updatepin', 'x'] },
   { name: 'mounts update-pins (reject)', setup: seedLayer, args: ['mounts', 'update-pins', 'x'] },
   { name: 'mounts Update-Pin (reject)', setup: seedLayer, args: ['mounts', 'Update-Pin', 'x'] },
   { name: 'mounts update (reject)', setup: seedLayer, args: ['mounts', 'update', 'x'] },
   { name: 'mounts (bare, reject)', setup: seedLayer, args: ['mounts'] },
];

/**
 * Planted dependency roots for the `detect` ecosystem scenarios. Each is one of
 * the miniature repositories `fixtures/ecosystem/` pins, planted here so that the
 * three CLIs are compared on the same human line and the same `--json` block —
 * the fixtures pin what the report SAYS, these pin that all three say it
 * identically. Lockfiles are presence-only, so every one of them is empty.
 */
const ECOSYSTEM_ROOTS: { name: string; plant: (dir: string) => void }[] = [
   {
      name: 'npm lockfile, CLI declared',
      plant: (d) => {
         fs.writeFileSync(
            path.join(d, 'package.json'),
            '{\n  "name": "demo",\n  "devDependencies": { "@leji-org/leji": "^1" }\n}\n',
         );
         fs.writeFileSync(path.join(d, 'package-lock.json'), '');
      },
   },
   {
      name: 'pnpm lockfile, CLI undeclared',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "name": "demo"\n}\n');
         fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
      },
   },
   {
      name: 'uv',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname = "demo"\nversion = "0.1.0"\n');
         fs.writeFileSync(path.join(d, 'uv.lock'), '');
      },
   },
   {
      name: 'go 1.24, tool declared',
      plant: (d) =>
         fs.writeFileSync(
            path.join(d, 'go.mod'),
            'module example.com/demo\n\ngo 1.24.0\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n',
         ),
   },
   {
      name: 'two Node lockfiles',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "name": "demo"\n}\n');
         fs.writeFileSync(path.join(d, 'package-lock.json'), '');
         fs.writeFileSync(path.join(d, 'yarn.lock'), '');
      },
   },
   {
      name: 'Node and Python',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "name": "demo"\n}\n');
         fs.writeFileSync(path.join(d, 'package-lock.json'), '');
         fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname = "demo"\nversion = "0.1.0"\n');
         fs.writeFileSync(path.join(d, 'uv.lock'), '');
      },
   },
   { name: 'no manifest', plant: () => {} },
];

const ECOSYSTEM_SCENARIOS: Scenario[] = ECOSYSTEM_ROOTS.flatMap((root) => [
   { name: `detect --json (${root.name})`, setup: root.plant, args: ['detect', '--json'] },
   { name: `detect (${root.name})`, setup: root.plant, args: ['detect'] },
]);

/**
 * The declaration step over the same planted roots. `--yes` is never a consent, so
 * no package manager runs in any of these: what is compared is the block all three
 * SDKs print, the plan-then-block order under `--dry-run`, and the single `--json`
 * document. A divergence here is a divergence in the words an adopter is told to
 * run, which is the whole contract of the step.
 */
/** `adopt` reaches the same declaration step as `init`, from a repository that
 * already has docs: same block, same suppression under `--json`, and it must not
 * diverge between the two commands or across the SDKs. */
const ADOPT_SCENARIOS: Scenario[] = ECOSYSTEM_ROOTS.flatMap((root) => {
   const setup = (d: string): void => {
      fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(d, 'docs', 'README.md'), '# Docs\n');
      root.plant(d);
   };
   return [
      { name: `adopt --yes (${root.name})`, setup, args: ['adopt', '--yes'] },
      { name: `adopt --yes --json (${root.name})`, setup, args: ['adopt', '--yes', '--json'] },
   ];
});

const DEPENDENCY_SCENARIOS: Scenario[] = ECOSYSTEM_ROOTS.flatMap((root) => [
   {
      name: `init --yes (${root.name})`,
      setup: root.plant,
      args: ['init', '--yes', '--name', 'demo-context'],
   },
   {
      name: `init --yes --dry-run (${root.name})`,
      setup: root.plant,
      args: ['init', '--yes', '--dry-run', '--name', 'demo-context'],
   },
   {
      name: `init --yes --json (${root.name})`,
      setup: root.plant,
      args: ['init', '--yes', '--json', '--name', 'demo-context'],
   },
]);

/**
 * `leji ci` over planted roots, for every provider. What is compared is the
 * generated bytes (the file tree is part of every capture), the action reported,
 * and the ownership decision: an owned legacy file is upgraded, a foreign one is
 * left alone with a snippet. Nothing here runs a package manager or a CI tool.
 */
const CI_ROOTS: { name: string; plant: (dir: string) => void }[] = [
   {
      name: 'pnpm declared + locked',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "devDependencies": { "@leji-org/leji": "^1" }\n}\n');
         fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
      },
   },
   {
      name: 'npm declared + locked',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "devDependencies": { "@leji-org/leji": "^1" }\n}\n');
         fs.writeFileSync(path.join(d, 'package-lock.json'), '');
      },
   },
   {
      name: 'uv declared + locked',
      plant: (d) => {
         fs.writeFileSync(
            path.join(d, 'pyproject.toml'),
            '[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = ["leji"]\n',
         );
         fs.writeFileSync(path.join(d, 'uv.lock'), '');
      },
   },
   {
      name: 'go 1.24 tool declared',
      plant: (d) =>
         fs.writeFileSync(
            path.join(d, 'go.mod'),
            'module example.com/demo\n\ngo 1.24.0\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n',
         ),
   },
   {
      name: 'undeclared',
      plant: (d) => {
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "name": "demo"\n}\n');
         fs.writeFileSync(path.join(d, 'package-lock.json'), '');
      },
   },
   { name: 'no manifest', plant: () => {} },
];

const CI_PROVIDER_NAMES = ['github', 'gitlab', 'circleci', 'azure'] as const;

/** Where each provider's generated artifact lives, and what an existing file at
 * that path can be. Ownership is provider-scoped, so every plant has to be too: a
 * legacy GitHub workflow sitting at the Azure path is a FOREIGN file there. */
const CI_TARGET: Record<(typeof CI_PROVIDER_NAMES)[number], string> = {
   github: '.github/workflows/leji.yml',
   gitlab: '.gitlab-ci.yml',
   circleci: '.circleci/config.yml',
   azure: '.azure-pipelines/leji.yml',
};

function writeAt(dir: string, rel: string, body: string): void {
   const abs = path.join(dir, rel);
   fs.mkdirSync(path.dirname(abs), { recursive: true });
   fs.writeFileSync(abs, body);
}

function goldenBytes(name: string): string {
   return fs.readFileSync(path.join(repoRoot, 'fixtures', 'ci-goldens', name), 'utf8');
}

/** A repository that declares the CLI, so the upgrade lands on a manager job that
 * differs from whatever was standing there. */
function declaredPnpm(d: string): void {
   fs.writeFileSync(path.join(d, 'package.json'), '{\n  "devDependencies": { "@leji-org/leji": "^1" }\n}\n');
   fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
}

/** Ownership scenarios, one per provider: what leji generated in 1.3.x is upgraded;
 * what someone else wrote is never touched. GitLab owns a marked block inside a
 * shared file, so its two cases are a foreign pipeline WITH our block (merged in
 * place) and a foreign pipeline without one (block appended). */
const CI_OWNERSHIP_SCENARIOS: Scenario[] = CI_PROVIDER_NAMES.flatMap((provider) => {
   const owned: Scenario =
      provider === 'gitlab'
         ? {
              name: 'ci --provider gitlab (foreign job plus our block)',
              setup: (d) => {
                 seedLayer(d);
                 declaredPnpm(d);
                 writeAt(
                    d,
                    CI_TARGET.gitlab,
                    'stages:\n  - test\n\ntheirs:\n  stage: test\n  script:\n    - echo mine\n\n' +
                       goldenBytes('gitlab-node-fallback.yml'),
                 );
              },
              args: ['ci', '--provider', 'gitlab'],
           }
         : {
              name: `ci --provider ${provider} (legacy owned file at its own path)`,
              setup: (d) => {
                 seedLayer(d);
                 declaredPnpm(d);
                 writeAt(d, CI_TARGET[provider], goldenBytes(`legacy-1.3-${provider}-fallback.yml`));
              },
              args: ['ci', '--provider', provider],
           };
   const foreign: Scenario = {
      name: `ci --provider ${provider} (foreign file at its own path)`,
      setup: (d) => {
         seedLayer(d);
         declaredPnpm(d);
         writeAt(
            d,
            CI_TARGET[provider],
            provider === 'gitlab'
               ? 'stages:\n  - test\ntheirs:\n  script:\n    - echo mine\n'
               : 'name: someone-elses-pipeline\n',
         );
      },
      args: ['ci', '--provider', provider],
   };
   // A file another provider's generator wrote is foreign here: same bytes, wrong
   // path, never replaced.
   const crossed: Scenario[] =
      provider === 'gitlab'
         ? []
         : [
              {
                 name: `ci --provider ${provider} (another provider's legacy bytes at this path)`,
                 setup: (d) => {
                    seedLayer(d);
                    declaredPnpm(d);
                    const other = provider === 'github' ? 'circleci' : 'github';
                    writeAt(d, CI_TARGET[provider], goldenBytes(`legacy-1.3-${other}-local.yml`));
                 },
                 args: ['ci', '--provider', provider],
              },
           ];
   return [owned, foreign, ...crossed];
});

const CI_SCENARIOS: Scenario[] = CI_ROOTS.flatMap((root) =>
   CI_PROVIDER_NAMES.map((provider) => ({
      name: `ci --provider ${provider} (${root.name})`,
      setup: (d: string) => {
         seedLayer(d);
         root.plant(d);
      },
      args: ['ci', '--provider', provider],
   })),
);

/** `ci --hooks` needs a real git repository, so it runs in the real-env mode the
 * git-backed scenarios use. The hook body carries the detected runner. */
const CI_HOOK_SCENARIOS: Scenario[] = [
   {
      name: 'ci --hooks (pnpm declared)',
      mode: 'real',
      setup: (d) => {
         gitInitSeeded(d);
         fs.writeFileSync(path.join(d, 'package.json'), '{\n  "devDependencies": { "@leji-org/leji": "^1" }\n}\n');
         fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
      },
      args: ['ci', '--hooks'],
   },
   {
      name: 'ci --hooks (go tool declared)',
      mode: 'real',
      setup: (d) => {
         gitInitSeeded(d);
         fs.writeFileSync(
            path.join(d, 'go.mod'),
            'module example.com/demo\n\ngo 1.24.0\n\ntool github.com/leji-org/leji/packages/sdk-go/cmd/leji\n',
         );
      },
      args: ['ci', '--hooks'],
   },
];

// --- `leji start` preflight (fixtures/start-preflight) ------------------------
// Each case is ONE argv over a seeded root: the state is set up, the CLI reports it,
// and the three SDKs must print the same bytes. No case is a multi-step harness and
// no case is produced by one CLI for the others; the "after fixes" state is seeded
// like every other one. Every run gets a PATH of its OWN stubs plus git, so what the
// probe and host detection find is exactly what the case declares and never whatever
// the machine running the suite has installed.

/** A stub directory: one `sh` script per name, plus a link to the real git. */
function startStubs(spec: Record<string, string>): string {
   const dir = mkAbs('leji-parity-start-');
   for (const [name, body] of Object.entries(spec)) {
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
   }
   fs.symlinkSync(path.join(gitDir(), 'git'), path.join(dir, 'git'));
   return dir;
}

const VERSION_STUB = 'echo 1.4.0';
const OLD_VERSION_STUB = 'echo 0.9.3';

/** The bin shim a Node package manager's install puts in the tree. The `cli` probe
 * executes this file directly and never asks a package manager to run a script for it,
 * so a declared Node fixture answers through this and through nothing else. */
function installNodeBin(dir: string, body: string): void {
   const binDir = path.join(dir, 'node_modules', '.bin');
   fs.mkdirSync(binDir, { recursive: true });
   fs.writeFileSync(path.join(binDir, 'leji'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** The CLI resolves and answers; one host is on PATH and reports the server as
 * unregistered. The ordinary joiner state. `leji` here is the AMBIENT binary, what an
 * undeclared repository reaches; a declared Node repository answers through its own
 * installed shim instead, which the setup writes into the tree. */
const STUBS_RESOLVABLE = startStubs({ leji: VERSION_STUB, claude: 'exit 1' });
/** Nothing answers: every probe fails closed. */
const STUBS_UNRESOLVABLE = startStubs({ claude: 'exit 1' });
/** A resolvable CLI older than the minimum for the layer's spec line. */
const STUBS_OLD = startStubs({ leji: OLD_VERSION_STUB, claude: 'exit 1' });
/** Two launchable hosts and no `--agent`: the unresolved MCP row. */
const STUBS_TWO_HOSTS = startStubs({ leji: VERSION_STUB, claude: 'exit 1', codex: 'exit 1' });
/** The state after the personal fixes: the host reports the server registered. */
const STUBS_REGISTERED = startStubs({ leji: VERSION_STUB, claude: 'exit 0' });
/** The Python and Go variants, where the runner is the manager's own. */
const STUBS_UV = startStubs({ uv: VERSION_STUB, leji: VERSION_STUB, claude: 'exit 1' });
const STUBS_GO = startStubs({ go: VERSION_STUB, leji: VERSION_STUB, claude: 'exit 1' });

/** One seeded root from `fixtures/start-preflight/`, committed, with the state a
 * committed fixture cannot carry: the installed Node bin shim (`node_modules` is not
 * committable), the git-side hooks configuration, and an installed clone hook. Every
 * one of them is written statically, by a file copy or a `git config`, never by running
 * a CLI, so no implementation ever produces another's input. */
function preflightFixture(
   name: string,
   after?: (dir: string) => void,
   shim: string | null = VERSION_STUB,
): (dir: string) => void {
   return (dir) => {
      fs.cpSync(path.join(repoRoot, 'fixtures', 'start-preflight', name), dir, { recursive: true });
      const pkg = path.join(dir, 'package.json');
      if (shim !== null && fs.existsSync(pkg) && fs.readFileSync(pkg, 'utf8').includes('@leji-org/leji')) {
         installNodeBin(dir, shim);
      }
      const git = (...a: string[]): void => {
         execFileSync('git', a, { cwd: dir, env: { ...realEnv, GIT_DIR: undefined }, stdio: 'ignore' });
      };
      git('init', '-q');
      git('add', '-A');
      git('-c', 'user.name=Parity Tester', '-c', 'user.email=parity@example.com', 'commit', '-q', '-m', 'seed');
      after?.(dir);
   };
}

/** `core.hooksPath` pointing at a directory inside the working tree: husky's, or a
 * plain `githooks/`. Both are committed state, so both are shared gaps. */
function hooksPathAt(value: string): (dir: string) => void {
   return (dir) => execFileSync('git', ['config', 'core.hooksPath', value], { cwd: dir, stdio: 'ignore' });
}

/** The clone hook already installed. The bytes come from the committed golden the CI
 * generator is checked against, copied in as a file: the "after the fixes" state is
 * seeded like every other one, never produced by running one CLI for the other two. */
function installedHook(dir: string): void {
   const hooks = path.join(dir, '.git', 'hooks');
   fs.mkdirSync(hooks, { recursive: true });
   const target = path.join(hooks, 'pre-commit');
   fs.copyFileSync(path.join(repoRoot, 'fixtures', 'ci-goldens', 'hook-npm.sh'), target);
   fs.chmodSync(target, 0o755);
}

/** Enabled with the Go and Python ports: the definitions were the contract, and all
 * three implementations now satisfy it. */
const START_PREFLIGHT_SCENARIOS_ENABLED = true;

/** One state, both output modes: the human block and the machine document. */
function startCases(name: string, setup: (dir: string) => void, stubs: string): Scenario[] {
   return [
      { name: `start (${name})`, mode: 'real', setup, args: ['start'], env: { PATH: stubs } },
      { name: `start --json (${name})`, mode: 'real', setup, args: ['start', '--json'], env: { PATH: stubs } },
   ];
}

const START_PREFLIGHT_SCENARIOS: Scenario[] = [
   ...startCases('declared, resolvable', preflightFixture('node-declared'), STUBS_RESOLVABLE),
   // No installed shim at all: the row says the CLI is not installed here, and no
   // package manager is invoked to find out.
   ...startCases('declared, not installed', preflightFixture('node-declared', undefined, null), STUBS_UNRESOLVABLE),
   // Installed, but the shim itself fails: the same fail-closed row, one step later.
   ...startCases('declared, unresolvable', preflightFixture('node-declared', undefined, 'exit 1'), STUBS_UNRESOLVABLE),
   ...startCases(
      'declared, below the spec line minimum',
      preflightFixture('node-declared', undefined, OLD_VERSION_STUB),
      STUBS_OLD,
   ),
   ...startCases('undeclared', preflightFixture('node-undeclared'), STUBS_RESOLVABLE),
   ...startCases('several hosts, no --agent', preflightFixture('node-declared'), STUBS_TWO_HOSTS),
   ...startCases('.mcp.json present', preflightFixture('node-mcp-json'), STUBS_RESOLVABLE),
   ...startCases('hook shared via husky', preflightFixture('husky', hooksPathAt('.husky/_')), STUBS_RESOLVABLE),
   ...startCases(
      'hooksPath inside the worktree',
      preflightFixture('githooks', hooksPathAt('githooks')),
      STUBS_RESOLVABLE,
   ),
   ...startCases('after the fixes', preflightFixture('node-mcp-json', installedHook), STUBS_REGISTERED),
   ...startCases('uv', preflightFixture('python-uv'), STUBS_UV),
   ...startCases('go tool', preflightFixture('go-tool'), STUBS_GO),
   // `--agent` pins the host the MCP rows answer for, in both modes.
   {
      name: 'start --agent claude-code --json (declared)',
      mode: 'real',
      setup: preflightFixture('node-declared'),
      args: ['start', '--agent', 'claude-code', '--json'],
      env: { PATH: STUBS_TWO_HOSTS },
   },
   {
      name: 'start --agent bogus --json (usage error)',
      mode: 'real',
      setup: preflightFixture('node-declared'),
      args: ['start', '--agent', 'bogus', '--json'],
      env: { PATH: STUBS_RESOLVABLE },
   },
];

// --- hand-off to a repository's own CLI (fixtures/handoff) --------------------
// What the three CLIs can be compared on here is the NON-delegating outcome only: a
// successful hand-off is per-runtime by construction (a Node repository's installed
// copy is a Node CLI, and only the Node CLI would reach it), so it is proved in each
// SDK's own suite over these same committed roots. What every runtime owes, and what
// these cases assert, is that a repository which does not qualify is answered by the
// CLI that was invoked, byte for byte identically.

/** One seeded root from `fixtures/handoff/`, with the installed state a committed
 * fixture cannot carry: `node_modules` is not committable, so the package metadata,
 * its entry, and the manager's bin shim are written here, statically. */
function handoffFixture(name: string, version: string | null): (dir: string) => void {
   return (dir) => {
      fs.cpSync(path.join(repoRoot, 'fixtures', 'handoff', name), dir, { recursive: true });
      if (version === null) return;
      const pkgDir = path.join(dir, 'node_modules', '@leji-org', 'leji');
      const entry = path.join(pkgDir, 'dist', 'cli.js');
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      // The marker no case here may reach: if one ever does, its output is nothing
      // any of the three CLIs prints, so the comparison fails loudly.
      fs.writeFileSync(entry, "#!/usr/bin/env node\nconsole.log('handoff:node');\nprocess.exit(3);\n", {
         mode: 0o755,
      });
      fs.writeFileSync(
         path.join(pkgDir, 'package.json'),
         JSON.stringify({ name: '@leji-org/leji', version, bin: { leji: 'dist/cli.js' } }, null, 2) + '\n',
      );
      const binDir = path.join(dir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.symlinkSync(path.relative(binDir, entry), path.join(binDir, 'leji'));
   };
}

const HANDOFF_SCENARIOS: Scenario[] = [
   // Installed, but never declared: the repository asked for nothing.
   { name: '--version (handoff: undeclared)', setup: handoffFixture('node-undeclared', '1.4.0'), args: ['--version'] },
   // Declared and installed, but older than the layer's spec line requires.
   {
      name: '--version (handoff: below the minimum)',
      setup: handoffFixture('node-below-minimum', '0.9.3'),
      args: ['--version'],
   },
   // Go declares the tool and has no installed executable: the not-applicable branch.
   { name: '--version (handoff: go tool)', setup: handoffFixture('go-tool', null), args: ['--version'] },
];

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
   // The agents.default selects-vs-loads guidance must be byte-identical across
   // SDKs, in the human line and in the JSON `note` field alike.
   { name: 'agent --name default (selects-vs-loads note)', setup: seedLayer, args: ['agent', '--name', 'default'] },
   {
      name: 'agent --name default --json (note field)',
      setup: seedLayer,
      args: ['agent', '--name', 'default', '--json'],
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
   // The second step of the two-step adoption, against a layer that already exists.
   // The whole sequence is user-facing output no scenario covered: the wiring run,
   // the conformant end state it produces, the idempotent re-run, and the archive
   // skip that keeps a re-wire from bumping the migration doc to `-2`.
   {
      name: 'adopt --wire-adapters against an existing layer',
      setup: adoptedWithUnwiredEntrypoint,
      args: ['adopt', '--yes', '--wire-adapters'],
   },
   {
      name: 'adopt --wire-adapters --dry-run against an existing layer (wire-only header)',
      setup: adoptedWithUnwiredEntrypoint,
      args: ['adopt', '--yes', '--wire-adapters', '--dry-run'],
   },
   { name: 'validate after wiring an existing layer', setup: adoptedAndWired, args: ['validate'] },
   {
      name: 'adopt --wire-adapters is idempotent (nothing left to wire)',
      setup: adoptedAndWired,
      args: ['adopt', '--yes', '--wire-adapters'],
   },
   {
      name: 'adopt --wire-adapters skips a byte-identical existing archive',
      setup: adoptedWiredThenEntrypointRestored,
      args: ['adopt', '--yes', '--wire-adapters'],
   },
   {
      name: 'adopt --dry-run',
      setup: (d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'x\n'),
      args: ['adopt', '--yes', '--dry-run'],
   },
   // An index already on disk. `adopt` does not overwrite it: it points the manifest
   // at a fresh non-colliding path, so the plan reads `create docs/leji-context-index.json`.
   // This pins that rename across the three SDKs.
   {
      name: 'adopt --dry-run over an existing index',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
         fs.writeFileSync(path.join(d, 'docs', 'glossary.md'), '# Glossary\n\nTenant: an account.\n');
         fs.writeFileSync(path.join(d, 'docs', 'context-index.json'), '{}\n');
      },
      args: ['adopt', '--yes', '--dry-run'],
   },
   // `init` does not rename: it points at the declared index path, so an existing
   // file there is regenerated. The plan must say `overwrite`, because the default
   // classification (`skip-exists`) would promise a file is left alone that the
   // index write then replaces.
   {
      name: 'init --dry-run over an existing index',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
         fs.writeFileSync(path.join(d, 'docs', 'context-index.json'), '{}\n');
      },
      args: ['init', '--yes', '--name', 'demo-context', '--dry-run'],
   },
   // `leji index` on a tree that cannot be indexed. The generator declines to write,
   // so no SDK may claim the file as written or seed a changelog off it. TypeScript
   // had this rule and the other two did not, which is invisible to a comparison
   // harness only while the divergence is absent.
   {
      name: 'index on a tree that cannot be indexed',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs', 'domain'), { recursive: true });
         fs.writeFileSync(
            path.join(d, 'docs', 'domain', 'glossary.md'),
            '---\nid: Not_Valid_ID\n---\n\n# Glossary\n\nTenant: an account.\n',
         );
      },
      args: ['index'],
   },
   // A tree that cannot be indexed: the frontmatter id is not lowercase-hyphen, so
   // generation fails. All three must decline to write the index, decline to claim
   // it, print the finding, and exit nonzero. Without this the failure path is
   // pinned in one SDK only and the other two can regress while parity stays green.
   {
      name: 'adopt a tree that cannot be indexed',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs', 'domain'), { recursive: true });
         fs.writeFileSync(
            path.join(d, 'docs', 'domain', 'glossary.md'),
            '---\nid: Not_Valid_ID\n---\n\n# Glossary\n\nTenant: an account.\n',
         );
      },
      args: ['adopt', '--yes'],
   },
   { name: 'detect --json (no hosts)', setup: () => {}, args: ['detect', '--json'] },
   // `detect` also reports the repository's own dependency ecosystem, so both of
   // its output forms are compared over planted roots.
   ...ECOSYSTEM_SCENARIOS,
   // The declaration offer prints in every mode except --json, and runs nothing
   // under --yes: all three SDKs must say the same words in the same order.
   ...DEPENDENCY_SCENARIOS,
   ...ADOPT_SCENARIOS,
   // The generated CI job and hook: bytes, action, and the ownership decision.
   ...CI_SCENARIOS,
   ...CI_OWNERSHIP_SCENARIOS,
   ...CI_HOOK_SCENARIOS,
   { name: 'start with no manifest', setup: () => {}, args: ['start'] },
   // --- working mode (solo / team) ---
   { name: 'init --mode solo', setup: () => {}, args: ['init', '--yes', '--mode', 'solo', '--name', 'demo-context'] },
   {
      name: 'init --mode team (explicit)',
      setup: () => {},
      args: ['init', '--yes', '--mode', 'team', '--name', 'demo-context'],
   },
   {
      name: 'init --mode solo --level indexed (seeded changelog, no dot-paths)',
      setup: () => {},
      args: ['init', '--yes', '--mode', 'solo', '--level', 'indexed', '--name', 'demo-context'],
   },
   {
      name: 'init --mode solo --dry-run',
      setup: () => {},
      args: ['init', '--yes', '--mode', 'solo', '--dry-run', '--name', 'demo-context'],
   },
   { name: 'init --mode bogus (reject)', setup: () => {}, args: ['init', '--yes', '--mode', 'bogus'] },
   { name: 'init --mode (missing value)', setup: () => {}, args: ['init', '--yes', '--mode'] },
   {
      name: 'adopt --mode solo (existing docs root)',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs'));
         fs.writeFileSync(path.join(d, 'docs', 'README.md'), '# Docs\n');
      },
      args: ['adopt', '--yes', '--mode', 'solo'],
   },
   {
      name: 'adopt --mode solo (doc/ root variant)',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'doc'));
         fs.writeFileSync(path.join(d, 'doc', 'README.md'), '# Docs\n');
      },
      args: ['adopt', '--yes', '--mode', 'solo'],
   },
   {
      name: 'adopt --mode solo --dry-run',
      setup: (d) => fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'x\n'),
      args: ['adopt', '--yes', '--mode', 'solo', '--dry-run'],
   },
   {
      name: 'adopt --mode solo (existing identity.md skipped)',
      setup: (d) => {
         fs.mkdirSync(path.join(d, 'docs', 'domain'), { recursive: true });
         fs.writeFileSync(path.join(d, 'docs', 'domain', 'identity.md'), '# Mine already\n');
      },
      args: ['adopt', '--yes', '--mode', 'solo'],
   },
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
   {
      // The boot-agents-default warning message must be byte-identical across SDKs.
      name: 'validate (boot-agents-default warning)',
      setup: (d) => fs.cpSync(path.join(repoRoot, 'fixtures', 'warn-boot-agents-default'), d, { recursive: true }),
      args: ['validate', '--json'],
   },
   // Agent-profile inheritance: single level, to exactly one `role: core` base that
   // declares none itself, resolved against the whole roster (bound out-of-directory
   // profiles included). Each error case must agree on rule, severity, path and exit
   // code; the clean case is the `validate --json` scenario above, whose example
   // layer already carries a profile that inherits and resolves.
   {
      name: 'validate --json (inherits an id no profile declares)',
      setup: inheritsTarget('nope'),
      args: ['validate', '--json'],
   },
   {
      name: 'validate --json (inherits an ambiguous target)',
      setup: ambiguousInheritsTarget,
      args: ['validate', '--json'],
   },
   {
      name: 'validate --json (inherits a target whose role is not core)',
      setup: inheritsTarget('thought-partner'),
      args: ['validate', '--json'],
   },
   {
      name: 'validate --json (a core profile declares inherits)',
      setup: coreDeclaresInherits,
      args: ['validate', '--json'],
   },
   {
      name: 'validate --json (out-of-directory bound base, not core)',
      setup: outOfDirectoryBase,
      args: ['validate', '--json'],
   },
   { name: 'conformance', setup: copyExample, args: ['conformance'] },
   { name: 'conformance --json', setup: copyExample, args: ['conformance', '--json'] },
   // --- federation (distribution.md Pattern 3): host that mounts a sibling ---
   { name: 'validate federated host', setup: copyFederatedHost, args: ['validate'] },
   { name: 'validate (duplicate mount name + availability)', setup: duplicateMounts, args: ['validate', '--json'] },
   // Mount surfacing (boot-profile.md requirement 9). `validate` reports every
   // condition and `conformance` reports the FIRST of them as `mount-discovery`'s
   // detail, so each fixture pins the finding set and the order it arrives in. The
   // clean pass and the no-mounts/no-block not-applicable case are the federated-host
   // and example-layer scenarios already here.
   {
      name: 'validate --json (mount surfacing: a declared mount has no entry)',
      setup: surfacingMissingEntry,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (mount surfacing: a declared mount has no entry)',
      setup: surfacingMissingEntry,
      args: ['conformance', '--json'],
   },
   {
      name: 'validate --json (mount surfacing: entry names an undeclared mount)',
      setup: surfacingUnknownEntry,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (mount surfacing: entry names an undeclared mount)',
      setup: surfacingUnknownEntry,
      args: ['conformance', '--json'],
   },
   {
      name: 'validate --json (mount surfacing: owner differs from the declaration)',
      setup: surfacingOwnerMismatch,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (mount surfacing: owner differs from the declaration)',
      setup: surfacingOwnerMismatch,
      args: ['conformance', '--json'],
   },
   {
      name: 'validate --json (mount surfacing: two-token fence info string)',
      setup: surfacingFenceTokens,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (mount surfacing: two-token fence info string)',
      setup: surfacingFenceTokens,
      args: ['conformance', '--json'],
   },
   {
      name: 'validate --json (mount surfacing: a padded declared mount name)',
      setup: surfacingPaddedName,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (mount surfacing: a padded declared mount name)',
      setup: surfacingPaddedName,
      args: ['conformance', '--json'],
   },
   {
      name: 'validate --json (mount surfacing: a block with no mounts declared)',
      setup: surfacingBlockWithoutMounts,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (mount surfacing: a block with no mounts declared)',
      setup: surfacingBlockWithoutMounts,
      args: ['conformance', '--json'],
   },
   {
      name: 'mounts hydrate (hint object store)',
      mode: 'real',
      setup: mountedFederatedHost,
      args: ['mounts', 'hydrate'],
   },
   {
      name: 'mounts hydrate --json (cached second run)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['mounts', 'hydrate', '--json'],
   },
   // The projection closure and its failure classes. The closure is the union of the
   // manifest, the rootPath tree, the boot profile, the machine artifacts, the bound
   // profiles, the category indexes and the pinned index's governed paths, wherever
   // they live. The class decides the outcome: a pinned layer that is absent or
   // malformed leaves the mount `unavailable` (hydrate stays best-effort, exit 0),
   // while a safety guard the projection refuses to cross is an `error` (exit 1).
   {
      // The tree compare is the assertion: every out-of-rootPath closure member is
      // projected and `noise/unselected.md` is not.
      name: 'mounts hydrate --json (closure reaches outside rootPath)',
      mode: 'real',
      setup: siblingHost(closureSibling(closureManifest())),
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      name: 'mounts hydrate --json (dangling agents binding -> unavailable)',
      mode: 'real',
      setup: siblingHost(
         closureSibling(closureManifest({ agents: { core: 'profiles/core.md', reviewer: 'profiles/missing.md' } })),
      ),
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      // Two missing bindings: the named one is the byte-lesser path, which pins a
      // deterministic first failure across Go's randomized map iteration.
      name: 'mounts hydrate --json (two dangling bindings name the byte-lesser path)',
      mode: 'real',
      setup: siblingHost(
         closureSibling(closureManifest({ agents: { alpha: 'profiles/zzz.md', beta: 'profiles/aaa.md' } })),
      ),
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      name: 'mounts hydrate --json (escaping bootProfilePath -> error)',
      mode: 'real',
      setup: siblingHost(closureSibling(closureManifest({ bootProfilePath: '../escape.md' }))),
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      name: 'mounts hydrate --json (machine.indexPath is not a string -> unavailable)',
      mode: 'real',
      setup: siblingHost(
         closureSibling(closureManifest({ machine: { indexPath: 7, agentProfilesPath: 'profiles/' } })),
      ),
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      name: 'mounts locate --json (hydrated)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['mounts', 'locate', 'acme-product-context', '--json'],
   },
   {
      name: 'mounts status (up-to-date witness)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['mounts', 'status'],
   },
   // `mounts status --json` across the availability matrix: the managed witness
   // and every drift state it reports, the unmanaged fallback, and each degraded
   // row (stable reason code, omitted counts, three-valued fields).
   {
      name: 'mounts status --json (managed witness, up-to-date)',
      mode: 'real',
      setup: managedUpToDate,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (managed witness, behind)',
      mode: 'real',
      setup: managedBehind,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (managed witness, ahead)',
      mode: 'real',
      setup: managedAhead,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (managed witness, diverged)',
      mode: 'real',
      setup: managedDiverged,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (managed witness, unrelated)',
      mode: 'real',
      setup: managedUnrelated,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (managed witness follows a force-push)',
      mode: 'real',
      setup: managedForcePushed,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (shallow store, ancestry incomplete)',
      mode: 'real',
      setup: managedShallow,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (unmanaged witness via the hint)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (no reachable pin, counts omitted)',
      mode: 'real',
      setup: unresolvedMount,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (no trackingRef declared)',
      mode: 'real',
      setup: witnesslessMount,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts status --json (ambiguous submodules)',
      mode: 'real',
      setup: ambiguousSubmodules,
      args: ['mounts', 'status', '--json'],
   },
   {
      // A fixed divergence. The scenario above has no candidate resolving the pin,
      // so it never reaches the branch where ambiguity outranks one: this fixture
      // does, and all three must answer unknown / mount-source-ambiguous.
      name: 'mounts status --json (ambiguity outranks a pin-only candidate)',
      mode: 'real',
      setup: ambiguousWithResolvingCandidate,
      args: ['mounts', 'status', '--json'],
   },
   // Text identity: one UTF-8 byte order on every sorted surface (mount rows,
   // findings, resolver state keys), raw UTF-8 for every scalar, and no
   // non-scalar string reaching hashing, sorting, or output at all.
   {
      name: 'validate --json (findings sort by UTF-8 bytes, not UTF-16 code units)',
      setup: byteOrderMounts,
      args: ['validate', '--json'],
   },
   {
      name: 'mounts status --json (rows sort by UTF-8 bytes, not UTF-16 code units)',
      mode: 'real',
      setup: byteOrderMounts,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'mounts hydrate --json (resolver state keys sort by UTF-8 bytes)',
      mode: 'real',
      setup: byteOrderMountsHydrated,
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      name: 'mounts status --json (U+2028/U+2029 carried as raw UTF-8, never escaped)',
      mode: 'real',
      setup: separatorMount,
      args: ['mounts', 'status', '--json'],
   },
   {
      name: 'validate --json (a lone surrogate in the manifest is refused)',
      setup: loneSurrogateManifest,
      args: ['validate', '--json'],
   },
   {
      name: 'validate --federation=available (unhydrated)',
      mode: 'real',
      setup: mountedFederatedHost,
      args: ['validate', '--federation=available', '--json'],
   },
   {
      name: 'validate --federation=required --paths (hydrated)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['validate', '--federation=required', '--paths', 'docs/domain/'],
   },
   {
      // A fixed divergence. A projection directory without its completion marker is
      // not a cache entry, and enforcement must say so in all three: the directory
      // existing proves nothing.
      name: 'validate --federation=available (projection dir without its marker)',
      mode: 'real',
      setup: hydratedWithoutMarker,
      args: ['validate', '--federation=available', '--json'],
   },
   // The `leji-index` grammar's whitespace alphabet: ASCII space and tab, with a
   // leading BOM stripped before parsing. Both inputs used to answer differently in
   // each SDK, on files no fixture covered.
   {
      name: 'validate --json (BOM and U+00A0 in an index file: one grammar, one answer)',
      setup: seedLayerNonAsciiIndexWhitespace,
      args: ['validate', '--json'],
   },
   {
      name: 'index --check --json (BOM and U+00A0 in an index file)',
      setup: seedLayerNonAsciiIndexWhitespace,
      args: ['index', '--check', '--json'],
   },
   // Task-path normalization (Requirement 6). `./x` and `x/` used to route nothing
   // and signal no category, which is how `--federation=required` passed open.
   {
      name: 'route --paths ./ spelling --json',
      setup: copyExample,
      args: ['route', '--paths', './docs/system/invariants.md', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'route --paths trailing-slash spelling --json',
      setup: copyExample,
      args: ['route', '--paths', 'docs/system/invariants.md/', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'route --paths absolute (rejected, exit 2)',
      setup: copyExample,
      args: ['route', '--paths', '/etc/passwd', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'validate --federation=required --paths ./ spelling (gate must not pass open)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['validate', '--federation=required', '--paths', './docs/domain/'],
   },
   {
      name: 'validate --federation=required --paths trailing slash (gate must not pass open)',
      mode: 'real',
      setup: hydratedFederatedHost,
      args: ['validate', '--federation=required', '--paths', 'docs/domain//'],
   },
   // Federation declaration validity: an unnormalizable source and a tracking ref
   // the schema accepts but the resolver refuses are both manifest errors now, and
   // conformance's sibling-mounts item tests the source it claims to test.
   {
      name: 'validate --json (unnormalizable mount source is an error, not availability)',
      setup: unnormalizableMountSource,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (unnormalizable mount source fails sibling-mounts)',
      setup: unnormalizableMountSource,
      args: ['conformance', '--json'],
   },
   {
      name: 'validate --json (a tracking ref the resolver refuses is an error)',
      setup: resolverIllegalTrackingRef,
      args: ['validate', '--json'],
   },
   {
      name: 'conformance --json (all four mount items reported when none are declared)',
      setup: copyExample,
      args: ['conformance', '--json'],
   },
   // A non-ASCII id reaches the message formatters as authored text. Go's `%q`
   // escaped it to a `\u` sequence; Node and Python interpolated it raw.
   {
      name: 'validate --json (non-ASCII supersession ids are interpolated raw)',
      setup: seedLayerNonAsciiSupersessionIds,
      args: ['validate', '--json'],
   },
   {
      name: 'validate (non-ASCII supersession ids, human output)',
      setup: seedLayerNonAsciiSupersessionIds,
      args: ['validate'],
   },
   // `--explain` is presentation, so it stays out of the machine payload: Node used
   // to add an `explanation` field that Go and Python never emitted, and no scenario
   // combined the two flags, so the gate never saw it.
   {
      name: 'conformance --json --explain (explanation is not in the machine payload)',
      setup: copyExample,
      args: ['conformance', '--json', '--explain'],
   },
   {
      name: 'conformance --explain (human output still renders it)',
      setup: copyExample,
      args: ['conformance', '--explain'],
   },
   // One scenario per normalized schema-violation kind. Each was un-comparable
   // before: the three validators phrase and order these differently, and no fixture
   // reached any of them.
   {
      name: 'schema kinds: required (manifest missing every required key)',
      setup: (d) => seedLayerWithArtifact(d, 'leji.json', '{}\n'),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: additionalProperties + required (1.2-shaped categories.<id>.paths)',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.categories = { domain: { paths: ['docs/domain/'] } };
         }),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: pattern on a non-ASCII decision id',
      setup: (d) =>
         seedLayerWithArtifact(
            d,
            'docs/decisions/bad-id.md',
            '---\nid: caf\u00e9-r\u00e9sum\u00e9\ntitle: T\ndate: 2026-06-20\nstatus: accepted\n---\n\n# T\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\ne\n',
         ),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: type (schemaVersion as a number)',
      setup: (d) =>
         seedLayerWithArtifact(
            d,
            'docs/context-index.json',
            '{"schemaVersion": 1, "generatedAt": "2026-01-01T00:00:00Z", "rootPath": "docs/", "entries": []}\n',
         ),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: enum (an unknown decision status)',
      setup: (d) =>
         seedLayerWithArtifact(
            d,
            'docs/decisions/bad-status.md',
            '---\nid: bad-status\ntitle: T\ndate: 2026-06-20\nstatus: partially-accepted\n---\n\n# T\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\ne\n',
         ),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: minItems + minLength (empty changelog, empty index title)',
      setup: (d) => {
         seedLayerWithArtifact(d, 'docs/context-changelog.json', '{"schemaVersion": "1.0", "entries": []}\n');
         fs.writeFileSync(
            path.join(d, 'docs', 'context-index.json'),
            '{"schemaVersion": "1.0", "generatedAt": "2026-01-01T00:00:00Z", "rootPath": "docs/", "entries": [{"id": "a", "path": "docs/domain/glossary.md", "title": "", "category": "domain"}]}\n',
         );
      },
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: minProperties (categories declared empty)',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.categories = {};
         }),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: minimum + maximum (viewer.port out of range)',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.viewer = { port: 0 };
         }),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: uniqueItems (an actor declaring one role twice)',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.actors = { codex: { roles: ['reviewer', 'reviewer'], commands: { reviewer: { run: 'x' } } } };
         }),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: propertyNames (an unknown viewer.categoryEmojis key)',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.viewer = { categoryEmojis: { nope: 'x' } };
         }),
      args: ['validate', '--json'],
   },
   {
      // anyOf is a wrapper like `if`: the branch failures beneath it are what is
      // wrong, and the three validators disagreed about whether the wrapper itself
      // was reported (Node emitted it, Go dropped it, Python emitted only it).
      name: 'schema kinds: anyOf branches (a non-string, non-object viewer pin)',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.viewer = { pins: [123] };
         }),
      args: ['validate', '--json'],
   },
   {
      name: 'schema kinds: several at once, ordering is a total order',
      setup: (d) =>
         seedLayerWithManifest(d, (m) => {
            m.categories = { domain: { paths: ['docs/domain/'] } };
            m.viewer = { port: 99999, categoryEmojis: { nope: 'x' } };
            delete m.owners;
         }),
      args: ['validate', '--json'],
   },
   { name: 'index --check federated host', setup: copyFederatedHost, args: ['index', '--check'] },
   { name: 'conformance federated host --json', setup: copyFederatedHost, args: ['conformance', '--json'] },
   // The unindexed nudge, both cases: this layer is fully indexed, so the run ends
   // at the `ok (...)` summary and no SDK may add a line; the pair below carries
   // the nonzero count, whose line is compared byte for byte like any other stdout.
   { name: 'index generate', setup: copyExample, args: ['index'] },
   { name: 'index generate (unindexed count reported)', setup: unindexedUnderRoot, args: ['index'] },
   { name: 'index --json (unindexed count, no trailing line)', setup: unindexedUnderRoot, args: ['index', '--json'] },
   { name: 'index generate (in-repo symlinked md skipped)', setup: symlinkedMdInCategory, args: ['index'] },
   { name: 'index generate (id vanished warning)', setup: vanishedId, args: ['index'] },
   { name: 'index --check', setup: copyExample, args: ['index', '--check'] },
   {
      name: 'index --check (stale)',
      setup: (d) => fs.cpSync(path.join(repoRoot, 'fixtures', 'invalid-stale-index'), d, { recursive: true }),
      args: ['index', '--check', '--json'],
   },
   { name: 'freshness', setup: copyExample, args: ['freshness'] },
   { name: 'freshness --json', setup: copyExample, args: ['freshness', '--json'] },
   // route: --as-of is fixed so document expiry is deterministic across SDKs.
   {
      name: 'route --paths (with freshness)',
      setup: copyExample,
      args: ['route', '--paths', 'docs/system/invariants.md', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'route --paths (expired horizon)',
      setup: copyExample,
      args: ['route', '--paths', 'docs/system/invariants.md', '--as-of', '2027-01-01', '--json'],
   },
   {
      name: 'route --categories (human)',
      setup: copyExample,
      args: ['route', '--categories', 'domain', '--as-of', '2026-06-27'],
   },
   { name: 'route empty scope --json', setup: copyExample, args: ['route', '--as-of', '2026-06-27', '--json'] },
   {
      name: 'route federated host (mounts) --json',
      setup: copyFederatedHost,
      args: ['route', '--categories', 'domain', '--as-of', '2026-06-27', '--json'],
   },
   // The routing semantics settled for 1.3: a path selects the entries it reaches and
   // SIGNALS their category without expanding it; only a named category expands one.
   // Each of these pins a distinct half of that split across all three SDKs.
   {
      name: 'route --paths directory (selects beneath, expands nothing)',
      setup: copyExample,
      args: ['route', '--paths', 'docs/system/', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'route --paths directory without trailing slash (identical)',
      setup: copyExample,
      args: ['route', '--paths', 'docs/system', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'route --paths and --categories together (signalled beside expanded)',
      setup: copyExample,
      args: [
         'route',
         '--paths',
         'docs/system/invariants.md',
         '--categories',
         'domain',
         '--as-of',
         '2026-06-27',
         '--json',
      ],
   },
   {
      // A path scope must still reach its mounts: mounts match the SIGNALLED set, so
      // narrowing expansion must not narrow federated sibling selection.
      name: 'route federated host, path-scoped (mounts via signals) --json',
      setup: copyFederatedHost,
      // The path must signal the category the mount declares, or the scenario passes
      // with an empty mounts array and proves nothing.
      args: ['route', '--paths', 'docs/domain/glossary.md', '--as-of', '2026-06-27', '--json'],
   },
   { name: 'route with no manifest', setup: () => {}, args: ['route', '--as-of', '2026-06-27', '--json'] },
   // Topic routing: a task-named topic matches a mount's declared `topics` by exact
   // string equality and selects the mount ALONE — no category expands, no document
   // or record loads, no decision routes. Each occurrence of the repeatable flag is
   // one whole topic: never comma-split, never trimmed.
   {
      name: 'route --topics selects a mount by topic alone (no paths, no categories)',
      setup: copyFederatedHost,
      args: ['route', '--topics', 'billing', '--as-of', '2026-06-27', '--json'],
   },
   {
      name: 'route --categories + --topics (both signals match, one mount row)',
      setup: copyFederatedHost,
      args: ['route', '--categories', 'domain', '--topics', 'billing', '--as-of', '2026-06-27', '--json'],
   },
   {
      // Two occurrences, one of them multi-word: the space-bearing topic must reach
      // the comparison whole, so a port that splits or trims matches nothing.
      name: 'route --topics repeated, a multi-word topic survives whole',
      setup: copyFederatedHost,
      args: ['route', '--topics', 'product surface', '--topics', 'billing', '--as-of', '2026-06-27', '--json'],
   },
   {
      // The no-topics half of the same layer: adding the signal must not have moved
      // a byte of the answer a caller who names none still gets.
      name: 'route --json without --topics on a mounts-declaring layer',
      setup: copyFederatedHost,
      args: ['route', '--as-of', '2026-06-27', '--json'],
   },
   { name: 'route --topics "" (empty occurrence rejected)', setup: copyFederatedHost, args: ['route', '--topics', ''] },
   {
      // A topic that is not a well-formed scalar sequence, carried as a JSON escape
      // in the manifest. All three refuse the layer whole at the manifest gate, so
      // the defect never reaches routing: what this pins is that the error path is
      // the SAME one in every SDK, message and exit code included. Routing's own
      // `invalid mount topic` message is unreachable through the CLI (the other
      // defect class, an empty topic, is a schema error whose text is the schema
      // library's and is deliberately outside this harness) and is a unit-suite case.
      name: 'route (a lone surrogate in a declared mount topic is refused)',
      setup: loneSurrogateTopic,
      args: ['route', '--topics', 'billing', '--as-of', '2026-06-27', '--json'],
   },
   { name: 'status', setup: copyExample, args: ['status'] },
   { name: 'status --strict --json', setup: copyExample, args: ['status', '--strict', '--json'] },
   {
      name: 'status --strict --json (stale index fixture)',
      setup: (d) => fs.cpSync(path.join(repoRoot, 'fixtures', 'invalid-stale-index'), d, { recursive: true }),
      args: ['status', '--strict', '--json'],
   },
   // `status`' projection section: would this layer, at HEAD, project completely if a
   // host mounted it? Judged against the object store, so it sees what a host's
   // hydrate would see — which is not what the working tree shows.
   {
      name: 'status --json (committed layer, projection ok)',
      mode: 'real',
      setup: committedLayer,
      args: ['status', '--json'],
   },
   {
      name: 'status --json (unborn repo, no commit to judge)',
      mode: 'real',
      setup: unbornLayer,
      args: ['status', '--json'],
   },
   {
      name: 'validate (untracked bound profile: clean)',
      mode: 'real',
      setup: untrackedBoundProfile,
      args: ['validate'],
   },
   {
      name: 'status --json (untracked bound profile: projection fails)',
      mode: 'real',
      setup: untrackedBoundProfile,
      args: ['status', '--json'],
   },
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
   // Local-first CI: a package.json declaring @leji-org/leji picks the lockfile-pinned
   // install for every provider; a repo without one (the scenarios above) stays on npx@1.
   {
      name: 'ci --provider github (local-first, dep declared)',
      setup: seedLayerWithDep,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider gitlab (local-first, dep declared)',
      setup: seedLayerWithDep,
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider circleci (local-first, dep declared)',
      setup: seedLayerWithDep,
      args: ['ci', '--provider', 'circleci'],
   },
   {
      name: 'ci --provider azure (local-first, dep declared)',
      setup: seedLayerWithDep,
      args: ['ci', '--provider', 'azure'],
   },
   {
      name: 'ci --provider github (local-first via BOM package.json)',
      setup: seedLayerWithDepBom,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider github (array dependencies -> fallback)',
      setup: seedLayerWithDepArray,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider github (unparseable package.json -> fallback)',
      setup: seedLayerWithBadPkg,
      args: ['ci', '--provider', 'github'],
   },
   // ci --hooks: hook resolution shells out to git, so these run in the real env.
   { name: 'ci --hooks (default .git/hooks)', mode: 'real', setup: gitInitSeeded, args: ['ci', '--hooks'] },
   { name: 'ci --hooks (default, --json)', mode: 'real', setup: gitInitSeeded, args: ['ci', '--hooks', '--json'] },
   { name: 'ci --hooks (custom in-repo hooksPath)', mode: 'real', setup: hooksCustom, args: ['ci', '--hooks'] },
   { name: 'ci --hooks (husky .husky/_)', mode: 'real', setup: hooksHuskyV9, args: ['ci', '--hooks'] },
   {
      name: 'ci --hooks (husky .husky/_, --json)',
      mode: 'real',
      setup: hooksHuskyV9,
      args: ['ci', '--hooks', '--json'],
   },
   { name: 'ci --hooks (direct .husky v8)', mode: 'real', setup: hooksHuskyV8, args: ['ci', '--hooks'] },
   {
      name: 'ci --hooks (direct .husky v8, non-exec -> mode correction)',
      mode: 'real',
      setup: hooksV8NonExec,
      args: ['ci', '--hooks'],
   },
   { name: 'ci --hooks (existing foreign hook -> manual)', mode: 'real', setup: hooksForeign, args: ['ci', '--hooks'] },
   {
      name: 'ci --hooks (existing foreign hook -> manual, --json)',
      mode: 'real',
      setup: hooksForeign,
      args: ['ci', '--hooks', '--json'],
   },
   {
      name: 'ci --hooks (out-of-root hooksPath -> manual)',
      mode: 'real',
      setup: hooksOutOfRoot,
      args: ['ci', '--hooks'],
   },
   { name: 'ci --hooks (idempotent second run)', mode: 'real', setup: hooksIdempotentV9, args: ['ci', '--hooks'] },
   {
      name: 'ci --provider github (NaN dependency -> fallback)',
      setup: seedLayerWithDepNaN,
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --hooks (husky hooksPath with .. normalized)',
      mode: 'real',
      setup: hooksHuskyV9Dotdot,
      args: ['ci', '--hooks'],
   },
   {
      name: 'ci --hooks (custom dir non-exec -> standalone mode correction)',
      mode: 'real',
      setup: hooksCustomNonExec,
      args: ['ci', '--hooks'],
   },
   {
      name: 'ci --hooks (out-of-root hooksPath -> manual, --json)',
      mode: 'real',
      setup: hooksOutOfRoot,
      args: ['ci', '--hooks', '--json'],
   },
   {
      name: 'ci --hooks (tilde core.hooksPath -> manual out-of-root)',
      mode: 'real',
      setup: hooksTilde,
      args: ['ci', '--hooks'],
      env: { HOME: '/tmp/leji-parity-tilde-home' },
   },
   {
      name: 'ci --hooks (linked worktree resolves shared hooks dir)',
      mode: 'real',
      setup: hooksLinkedWorktree,
      args: ['ci', '--hooks', '--root', 'wt'],
   },
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
   { name: 'export --out site (static export)', setup: copyExample, args: ['export', '--out', 'site'] },
   { name: 'export default out (.leji/dist)', setup: copyExample, args: ['export'] },
   {
      // The static export writes the RESOLVED page for an inheriting profile, so the
      // viewer artifacts are byte-compared like any other written tree. The resolved
      // page rides the two scenarios above (the example layer's profile inherits and
      // resolves); this one pins the other half — a profile that does not resolve
      // exports its findings page, never the derived file as if it were effective.
      name: 'export (unresolved inheriting profile exports a findings page)',
      setup: inheritsTarget('nope'),
      args: ['export'],
   },
   {
      name: 'export --out ../escape (reject)',
      setup: copyExample,
      args: ['export', '--out', '../escape'],
   },
   { name: 'export --out . (root, reject)', setup: copyExample, args: ['export', '--out', '.'] },
   {
      name: 'export --out absolute (reject)',
      setup: copyExample,
      args: ['export', '--out', '/tmp/leji-parity-out-abs'],
   },
   { name: 'export skips a symlinked content file', setup: symlinkInContent, args: ['export'] },
   { name: 'export aborts on an escaping viewer dir', setup: symlinkedViewerDir, args: ['export'] },
   // The two names are one operation (A2): each SDK's `viewer build` run must match
   // its own `export` run byte for byte, and all three must agree with each other.
   {
      name: 'export and viewer build are the same operation (alias equivalence)',
      setup: copyExample,
      args: ['export'],
      alias: ['viewer', 'build'],
   },
   // --- F9: the trust boundary, command by command ---
   {
      name: 'export (.leji/dist symlinked out of the repository)',
      setup: distSymlinkedOutside,
      args: ['export'],
   },
   {
      name: 'export --out published (symlinked out of the repository)',
      setup: outSymlinkedOutside,
      args: ['export', '--out', 'published'],
   },
   {
      name: 'viewer (.leji/viewer symlinked out of the repository)',
      setup: viewerSymlinkedOutside,
      args: ['viewer'],
   },
   {
      name: 'export (.leji/viewer symlinked out of the repository)',
      setup: viewerSymlinkedOutside,
      args: ['export'],
   },
   {
      name: 'export (dangling .leji/dist refused before it is resolved)',
      setup: distDangling,
      args: ['export'],
   },
   {
      name: 'export --out published (dangling symlink refused)',
      setup: outDangling,
      args: ['export', '--out', 'published'],
   },
   {
      name: 'export --out site (an escaping index.html is not a previous export)',
      setup: outMarkerSymlinked,
      args: ['export', '--out', 'site'],
   },
   {
      name: 'viewer (overview.md is a dangling symlink)',
      setup: overviewStanding((abs) => fs.symlinkSync('never-created.md', abs)),
      args: ['viewer'],
   },
   {
      name: 'viewer (overview.md is a directory)',
      setup: overviewStanding((abs) => fs.mkdirSync(abs)),
      args: ['viewer'],
   },
   {
      name: 'init (.gitignore symlinked out of the repository)',
      setup: gitignoreSymlinkedOutside,
      args: ['init', '--yes', '--name', 'demo-context'],
   },
   {
      name: 'init (a dangling leji.json is an existing layer)',
      setup: manifestNameDangling,
      args: ['init', '--yes', '--name', 'demo-context'],
   },
   {
      name: 'agent (a dangling profile name writes neither half)',
      setup: agentProfileDangling,
      args: ['agent', '--host', 'codex', '--name', 'reviewer'],
   },
   {
      name: 'agent (agent-profiles dir symlinked out of the repository)',
      setup: agentProfilesDirOutside,
      args: ['agent', '--host', 'codex', '--name', 'reviewer'],
   },
   {
      name: 'agent (leji.json symlinked out of the repository)',
      setup: agentManifestOutside,
      args: ['agent', '--host', 'codex', '--name', 'reviewer'],
   },
   {
      name: 'index (a dangling changelog link is already present)',
      setup: indexedDanglingChangelog,
      args: ['index'],
   },
   {
      name: 'ci --provider github (dangling target refused)',
      setup: ciTargetDangling('.github/workflows/leji.yml'),
      args: ['ci', '--provider', 'github'],
   },
   {
      name: 'ci --provider gitlab (dangling target refused)',
      setup: ciTargetDangling('.gitlab-ci.yml'),
      args: ['ci', '--provider', 'gitlab'],
   },
   {
      name: 'ci --provider circleci (dangling target refused)',
      setup: ciTargetDangling('.circleci/config.yml'),
      args: ['ci', '--provider', 'circleci'],
   },
   {
      name: 'ci --provider azure (dangling target refused)',
      setup: ciTargetDangling('.azure-pipelines/leji.yml'),
      args: ['ci', '--provider', 'azure'],
   },
   {
      name: 'adopt --wire-adapters (a dangling vendor entrypoint is absent)',
      mode: 'real',
      setup: adoptedWithDanglingEntrypoint,
      args: ['adopt', '--yes', '--wire-adapters'],
   },
   {
      name: 'mounts hydrate (.leji/mounts aliased into another private role)',
      mode: 'real',
      setup: mountsRoleAliasedIntoAnotherRole,
      args: ['mounts', 'hydrate', '--json'],
   },
   {
      name: 'mounts hydrate (.leji/mounts aliased out of the repository)',
      mode: 'real',
      setup: mountsRoleAliasedOutside,
      args: ['mounts', 'hydrate', '--json'],
   },
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
   // Per-command help (`leji <command> --help`): adopt covers description + details
   // + options + examples; the two-word form covers the changelog subcommand path.
   { name: 'adopt --help', setup: () => {}, args: ['adopt', '--help'] },
   { name: 'changelog compact --help', setup: () => {}, args: ['changelog', 'compact', '--help'] },
   // `start` is the only command whose flag column contains a multibyte character
   // ("-- <host flags…>"), so it is the one fixture that catches a help renderer
   // measuring column width in bytes rather than runes.
   { name: 'start --help', setup: () => {}, args: ['start', '--help'] },
   // An alias has help of its own (`view` is `viewer serve`), so the renderer that
   // folds it into one line in the top-level list must still resolve it here.
   { name: 'view --help', setup: () => {}, args: ['view', '--help'] },
   { name: 'index file with rejected path shapes', setup: seedLayerBadIndexPaths, args: ['validate'] },
   // Input the documented contract forbids. These silently produced a plausible,
   // empty result before: the caller could not tell "nothing routes here" from "you
   // typed it wrong", which the routing rules explicitly forbid presenting as scoped.
   // Surplus positionals: Python rejected them, the other two ignored them, so a typo
   // was accepted by two implementations out of three.
   { name: 'surplus positional after a command', setup: () => {}, args: ['validate', 'extra'] },
   { name: 'surplus positional after a two-word command', setup: () => {}, args: ['changelog', 'check', 'extra'] },
   { name: 'route --as-of a non-date', setup: () => {}, args: ['route', '--as-of', 'not-a-date'] },
   { name: 'route --as-of a date that does not exist', setup: () => {}, args: ['route', '--as-of', '2026-02-30'] },
   { name: 'route --categories a typo', setup: () => {}, args: ['route', '--categories', 'domian'] },
   {
      name: 'changelog compact --before a date that does not exist',
      setup: () => {},
      args: ['changelog', 'compact', '--before', '2026-99-99'],
   },
   { name: 'unknown command', setup: () => {}, args: ['frobnicate'] },
   // Unknown *option* is a different path from unknown command, and it is decided
   // by the argv parser ahead of every other check. These pin that ordering: an
   // undeclared flag beats --help, beats an unknown command, and beats the
   // per-command allow-list, while a flag that is merely wrong for this command
   // still reports "is not valid for". Python reached the allow-list for all four
   // until 1.3.0, so it said `--zzz is not valid for "route"` where Node and Go
   // said `unknown option --zzz`.
   { name: 'unknown option', setup: () => {}, args: ['route', '--zzz'] },
   { name: 'unknown option beats --help', setup: () => {}, args: ['route', '--zzz', '--help'] },
   { name: 'unknown option beats unknown command', setup: () => {}, args: ['frobnicate', '--zzz'] },
   { name: 'unknown option with an inline value', setup: () => {}, args: ['route', '--zzz=1'] },
   { name: 'known flag on the wrong command', setup: () => {}, args: ['route', '--content'] },
   // Left-to-right: whichever error comes first in argv wins, so an unknown flag
   // before a valueless value flag reports the unknown one, and after it doesn't.
   { name: 'unknown option before a valueless value flag', setup: () => {}, args: ['route', '--zzz', '--root'] },
   { name: 'valueless value flag before an unknown option', setup: () => {}, args: ['route', '--root', '--zzz'] },
   // Numeric-flag range guards reject pre-dispatch (exit 2, no writes) in all
   // three SDKs; the empty setup + tree compare also asserts nothing is written.
   { name: 'view --port out of range (range error)', setup: () => {}, args: ['view', '--port', '99999'] },
   { name: 'changelog compact --keep 0 (range error)', setup: () => {}, args: ['changelog', 'compact', '--keep', '0'] },
   // A numeric flag takes a plain decimal integer and nothing else. Each of these
   // was accepted by exactly one or two of the three: Node's `Number()` also reads
   // 0x10, 1e3, and ' 8 '; Python's `int()` reads ' 8 ' and '1_0'; Go's Atoi reads
   // none of them but overflowed where the other two kept counting.
   { name: 'view --port hex', setup: () => {}, args: ['view', '--port', '0x10'] },
   { name: 'view --port exponent', setup: () => {}, args: ['view', '--port', '1e3'] },
   { name: 'view --port padded with spaces', setup: () => {}, args: ['view', '--port', ' 8 '] },
   { name: 'view --port underscore separator', setup: () => {}, args: ['view', '--port', '1_0'] },
   { name: 'changelog compact --keep a float', setup: () => {}, args: ['changelog', 'compact', '--keep', '1.5'] },
   {
      name: 'changelog compact --keep beyond every SDK integer',
      setup: () => {},
      args: ['changelog', 'compact', '--keep', '999999999999999999999'],
   },
   // The numeric guard is part of the argv scan, so it is decided ahead of the
   // per-command allow-list: `--port` is not valid for `viewer build` either way,
   // but all three must report the same one of the two errors.
   {
      name: 'bad --port on a command that does not take it',
      setup: () => {},
      args: ['viewer', 'build', '--port', 'abc'],
   },
   // The enum flags carried the same ordering split as the numeric ones: Python
   // checked the word after the per-command allow-list, so a command that does not
   // declare the flag reported `is not valid for` where Node and Go named the enum.
   {
      name: 'bad --mode on a command that does not take it',
      setup: () => {},
      args: ['viewer', 'build', '--mode', 'bogus'],
   },
   {
      name: 'bad --level on a command that does not take it',
      setup: () => {},
      args: ['index', '--level', 'bogus'],
   },
   // `--` is declared on `start` only. It was accepted on every command and
   // silently swallowed what followed, so `leji validate -- --bogus` exited 0 on a
   // layer that validates: a typo'd flag reported success on a validation command.
   { name: 'validate -- swallows a typo (rejected)', setup: seedLayer, args: ['validate', '--', '--bogus'] },
   { name: 'changelog check -- (rejected)', setup: seedLayer, args: ['changelog', 'check', '--', '--bogus'] },
   { name: 'start -- host flags (declared, accepted)', setup: seedLayer, args: ['start', '--', '--chrome'] },
   // Globals written before the command. Node and Go scan a flat argv and take them
   // anywhere; Python's argparse bound each option to the parser declaring it, so
   // these were `unrecognized arguments` exit 2 there and exit 0 in the other two.
   { name: 'global --json before the command', setup: seedLayer, args: ['--json', 'validate'] },
   { name: 'global --root before the command', setup: seedLayer, args: ['--root', '.', 'validate'] },
   { name: 'global before a two-word command', setup: seedLayer, args: ['--json', 'changelog', 'check'] },
   { name: 'command flag before the command', setup: seedLayer, args: ['--strict', 'status'] },
   // cli.json used to say `--dry-run` is never blocked; the existing-layer refusal
   // blocks it in all three, deliberately, and only the dirty-tree refusal exempts it.
   { name: 'adopt --dry-run on a layer that already exists', setup: seedLayer, args: ['adopt', '--yes', '--dry-run'] },
   // --- real env: detection + git-backed behavior ---
   { name: 'detect --json (real PATH+HOME stubs)', mode: 'real', setup: () => {}, args: ['detect', '--json'] },
   {
      name: 'init in a real git repo (owner from git)',
      mode: 'real',
      setup: () => {},
      args: ['init', '--yes', '--name', 'demo-context'],
   },
   // The harness runs every CLI with stdin on the null device, which is a character
   // device: Go's stat-based TTY test called that interactive, so it printed the host
   // menu and blocked on a line that never arrives, where Node's isTTY and Python's
   // isatty printed the fallback. Only `real` mode detects hosts, and no scenario
   // reached host detection before, so nothing caught it. `leji start < /dev/zero`
   // hung forever on the same path.
   {
      name: 'start on a seeded layer with hosts detected (non-TTY stdin)',
      mode: 'real',
      setup: seedLayer,
      args: ['start'],
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
   {
      name: 'init --mode solo in a real git repo',
      mode: 'real',
      setup: () => {},
      args: ['init', '--yes', '--mode', 'solo', '--name', 'demo-context'],
   },
   {
      name: 'init refuses while .leji/ files are tracked',
      mode: 'real',
      setup: trackedLejiRepo,
      args: ['init', '--yes', '--mode', 'solo', '--name', 'demo'],
   },
   { name: 'validate on a committed git layer', mode: 'real', setup: gitLayer, args: ['validate'] },
   { name: 'conformance on a committed git layer', mode: 'real', setup: gitLayer, args: ['conformance', '--json'] },
   { name: 'changelog check on a committed git layer', mode: 'real', setup: gitLayer, args: ['changelog', 'check'] },
   ...(BADGE_SCENARIOS_ENABLED ? BADGE_SCENARIOS : []),
   ...(UPDATE_PIN_SCENARIOS_ENABLED ? UPDATE_PIN_SCENARIOS : []),
   ...(START_PREFLIGHT_SCENARIOS_ENABLED ? START_PREFLIGHT_SCENARIOS : []),
   ...HANDOFF_SCENARIOS,
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
   const argv = sc.extraArgs ? [...sc.args, ...sc.extraArgs(dir)] : sc.args;
   const r = runner(argv, dir, sc.env ? { ...env, ...sc.env } : env);
   // Absolute run-dir paths in output (e.g. `mounts locate`) are per-capture by
   // construction; normalize so byte comparison sees the same text. `observedAt`
   // is the second declared non-deterministic field (after the index's
   // `generatedAt`), normalized field-aware by the same rule.
   const norm = (s: string): string =>
      s
         .split(dir)
         .join('<ROOT>')
         .replace(/("observedAt": ")[^"]*"/g, '$1<OBSERVED_AT>"');
   return { exit: r.exit, stdout: norm(r.stdout), stderr: norm(r.stderr), tree: snapshot(dir) };
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
      const captures: Record<string, Captured> = {
         node: capture(runners.node, sc, env),
         go: capture(runners.go, sc, env),
         py: capture(runners.py, sc, env),
      };
      const ref = captures.node;
      const problems = [...diffProblems(ref, captures.go, 'go'), ...diffProblems(ref, captures.py, 'py')];
      if (sc.alias) {
         const aliased: Scenario = { ...sc, args: sc.alias };
         for (const sdk of Object.keys(runners)) {
            problems.push(
               ...diffProblems(captures[sdk], capture(runners[sdk], aliased, env), `${sdk} \`${sc.alias.join(' ')}\``),
            );
         }
      }
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
