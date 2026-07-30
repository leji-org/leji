import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
   type HydrateOutcome,
   cacheKeyFor,
   checkPinReachability,
   federationEnforcement,
   hydrateMounts,
   locateMount,
   mountStatus,
   normalizeSource,
   pinRefFor,
   runGit,
   verifyProjection,
   witnessRefFor,
} from '../dist/lib/mounts.js';
import { type Finding } from '../dist/lib/findings.js';
import { conformanceReport } from '../dist/index.js';
import { loadManifest } from '../dist/index.js';
import { run } from '../dist/index.js';
import { validateLayer } from '../dist/index.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const cliPath = path.join(pkgRoot, 'dist', 'cli.js');
const siblingExample = path.join(repoRoot, 'examples', 'multi-repo', 'product-context');
const hostExample = path.join(repoRoot, 'examples', 'multi-repo', 'core-context');

function tmpdir(prefix: string): string {
   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
   return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_DIR: undefined },
   }).trim();
}

/** A committed sibling repo (from the multi-repo example) plus a host with a
 * pinned mount and a machine-local hint pointing at the sibling checkout. */
function mountedPair(): { host: string; sibling: string; pin: string } {
   const dir = tmpdir('leji-mounts-');
   const sibling = path.join(dir, 'sibling');
   const host = path.join(dir, 'host');
   fs.cpSync(siblingExample, sibling, { recursive: true });
   git(sibling, 'init', '-q', '-b', 'main');
   git(sibling, 'add', '-A');
   git(sibling, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
   const pin = git(sibling, 'rev-parse', 'HEAD');
   fs.cpSync(hostExample, host, { recursive: true });
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = pin;
   m.federation.mounts[0].trackingRef = 'refs/heads/main';
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.mkdirSync(path.join(host, '.leji'), { recursive: true });
   fs.writeFileSync(
      path.join(host, '.leji', 'mounts.local.json'),
      JSON.stringify({ mounts: { 'acme-product-context': { repo: '../sibling' } } }) + '\n',
   );
   return { host, sibling, pin };
}

function commitFile(repo: string, name: string): string {
   fs.writeFileSync(path.join(repo, name), `# ${name}\n`);
   git(repo, 'add', '-A');
   git(repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', name);
   return git(repo, 'rev-parse', 'HEAD');
}

function storeFor(host: string, identity: string): string {
   return path.join(host, '.leji', 'mounts', 'store', crypto.createHash('sha256').update(identity).digest('hex'));
}

const ACME_IDENTITY = normalizeSource('https://github.com/acme/product-context')!;

/** In-process CLI run (cli.js is `process.exit(await run(argv))`), for the exit
 * code and the JSON envelope the library alone does not decide. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
   const lines: string[] = [];
   const origLog = console.log;
   console.log = (...a: unknown[]) => {
      lines.push(a.join(' '));
   };
   try {
      const code = await run(args);
      return { code, stdout: lines.join('\n') };
   } finally {
      console.log = origLog;
   }
}

/** Out-of-process CLI run, reserved for the publication properties only real
 * concurrency shows: several producers racing one cold cache key. */
function runCliProc(args: string[]): Promise<{ code: number; stdout: string }> {
   return new Promise((resolve) => {
      execFile(process.execPath, [cliPath, ...args], (error, stdout) => {
         resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout });
      });
   });
}

test('mounts: source normalization is canonical and credential-free', () => {
   assert.equal(normalizeSource('https://GitHub.com/Acme/Repo.git/'), 'https://github.com/Acme/Repo');
   assert.equal(normalizeSource('https://github.com/acme/repo.git'), 'https://github.com/acme/repo');
   assert.equal(normalizeSource('git@github.com:acme/repo.git'), 'ssh://git@github.com/acme/repo');
   assert.equal(normalizeSource('https://user:token@github.com/acme/repo'), 'https://github.com/acme/repo');
   assert.equal(normalizeSource('ssh://git@github.com/acme/repo/'), 'ssh://git@github.com/acme/repo');
   assert.equal(normalizeSource('/Users/someone/local/checkout'), null);
   assert.equal(normalizeSource('file:///x/y'), null);
   assert.equal(normalizeSource(''), null);
});

test('mounts: hydrate via a hint materializes a verified projection and clears the availability warning', () => {
   const { host, pin } = mountedPair();
   const { manifest } = loadManifest(host);
   const r = hydrateMounts(host, manifest!, {});
   assert.equal(r.fatal, undefined);
   assert.deepEqual(
      r.outcomes.map((o) => [o.name, o.status]),
      [['acme-product-context', 'hydrated']],
   );
   // The entry is published at the key derived from source and pin, and nothing
   // records that mapping: the declaration is the only thing that knows it.
   const identity = normalizeSource('https://github.com/acme/product-context')!;
   const entry = path.join(host, '.leji', 'mounts', 'cache', cacheKeyFor(identity, pin), 'projection');
   assert.ok(fs.existsSync(path.join(entry, 'complete')), 'the published entry carries its marker');
   assert.ok(!fs.existsSync(path.join(host, '.leji', 'mounts', 'state.json')), 'no state file is written');
   // locate reports present + verified with the projection path.
   const loc = locateMount(host, manifest!, 'acme-product-context');
   assert.equal(loc.present, true);
   assert.equal(loc.verified, true);
   assert.ok(loc.path && fs.existsSync(path.join(loc.path, 'leji.json')));
   // The sibling's own layer content is inside; nothing else of the repo is.
   assert.ok(fs.existsSync(path.join(loc.path!, 'boot-profile.md')));
   // validate no longer reports mount-unavailable.
   const v = validateLayer(host);
   assert.ok(!v.findings.some((f) => f.rule === 'mount-unavailable'));
   // A second hydrate is a cache hit.
   const again = hydrateMounts(host, manifest!, {});
   assert.deepEqual(
      again.outcomes.map((o) => o.status),
      ['cached'],
   );
});

test('mounts: status reports up-to-date, then behind with counts against the witness ref', () => {
   const { host, sibling } = mountedPair();
   const { manifest } = loadManifest(host);
   hydrateMounts(host, manifest!, {});
   let rows = mountStatus(host, manifest!, {});
   assert.equal(rows[0].pinReport.state, 'up-to-date');
   assert.equal(rows[0].pinReport.comparedRef, 'refs/heads/main');
   assert.equal(rows[0].pinReport.ancestryComplete, true);
   // The sibling moves on; the pin is now behind its witness.
   fs.writeFileSync(path.join(sibling, 'new-doc.md'), '# New\n');
   git(sibling, 'add', '-A');
   git(sibling, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'later');
   rows = mountStatus(host, manifest!, {});
   assert.equal(rows[0].pinReport.state, 'behind');
   assert.equal(rows[0].pinReport.behind, 1);
   assert.equal(rows[0].present, true);
});

test('mounts: status is unknown without a reachable object store and without a witness', () => {
   const { host } = mountedPair();
   const { manifest } = loadManifest(host);
   // Remove the hint: no store, no submodule -> unknown, never a guess.
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   const rows = mountStatus(host, manifest!, {});
   assert.equal(rows[0].pinReport.state, 'unknown');
   assert.equal(rows[0].present, false);
});

test('mounts: check-integrity detects a tampered projection; verify is null when unverifiable', () => {
   const { host } = mountedPair();
   const { manifest } = loadManifest(host);
   hydrateMounts(host, manifest!, {});
   const loc = locateMount(host, manifest!, 'acme-product-context');
   fs.appendFileSync(path.join(loc.path!, 'boot-profile.md'), 'tampered\n');
   const rows = mountStatus(host, manifest!, { checkIntegrity: true });
   assert.equal(rows[0].verified, false);
   // With the object store gone, verification is unverifiable (null), not a pass.
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   const mount = manifest!.federation!.mounts![0];
   assert.equal(verifyProjection(host, mount), null);
});

test('mounts: hydrate refuses while cache files are git-tracked in the host', () => {
   const { host } = mountedPair();
   git(host, 'init', '-q');
   fs.mkdirSync(path.join(host, '.leji', 'mounts'), { recursive: true });
   fs.writeFileSync(path.join(host, '.leji', 'mounts', 'poison.txt'), 'x\n');
   git(host, 'add', '-f', '.leji/mounts/poison.txt');
   const { manifest } = loadManifest(host);
   const r = hydrateMounts(host, manifest!, {});
   assert.ok(r.fatal && r.fatal.includes('never committed'));
   assert.deepEqual(r.outcomes, []);
});

test('mounts: a projection with an escaping symlink fails hydration as an error', async () => {
   const { host, sibling } = mountedPair();
   // Add an escaping symlink inside the sibling's rootPath and re-pin to it.
   fs.symlinkSync('../../outside.md', path.join(sibling, 'context', 'escape.md'));
   git(sibling, 'add', '-A');
   git(sibling, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'escape');
   const newPin = git(sibling, 'rev-parse', 'HEAD');
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = newPin;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const { manifest } = loadManifest(host);
   const r = hydrateMounts(host, manifest!, {});
   assert.equal(r.outcomes[0].status, 'error');
   assert.ok(r.outcomes[0].detail!.includes('escapes the projection'));
   // Nothing landed in the cache.
   assert.equal(locateMount(host, manifest!, 'acme-product-context').present, false);
   // A safety guard the projection refused to cross fails the run, unlike a pinned
   // layer that is merely absent or malformed.
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 1);
   assert.equal(JSON.parse(cli.stdout).ok, false);
});

test('mounts: hydrate --fetch pulls the pin from a source URL into the managed store', () => {
   const { host, sibling, pin } = mountedPair();
   // Point source at the sibling as a file-less URL is invalid by design; use the
   // hint-free path with a fetchable local bare mirror served via its path as the
   // fetch remote. normalizeSource rejects local paths for identity, so the
   // declared https source stays the identity while git fetches from it only in
   // real deployments. Here we emulate by seeding the store from the hint first.
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   const identity = normalizeSource('https://github.com/acme/product-context')!;
   const { manifest } = loadManifest(host);
   // Unavailable offline with no hint/store/submodule…
   let r = hydrateMounts(host, manifest!, {});
   assert.equal(r.outcomes[0].status, 'unavailable');
   // …but once the store holds the objects (as a --fetch would leave it), hydrate succeeds.
   const storeDir = path.join(host, '.leji', 'mounts', 'store');
   fs.mkdirSync(storeDir, { recursive: true });
   const key = crypto.createHash('sha256').update(identity).digest('hex');
   execFileSync('git', ['clone', '-q', '--bare', sibling, path.join(storeDir, key)], {
      env: { ...process.env, GIT_DIR: undefined },
   });
   r = hydrateMounts(host, manifest!, {});
   assert.equal(r.outcomes[0].status, 'hydrated');
   assert.equal(r.outcomes[0].objectSource, 'store');
   assert.equal(locateMount(host, manifest!, 'acme-product-context').pin, pin);
});

/** Route git's network protocols at the declared source URL to a local repo, so
 * the "networked" reachability probe runs hermetically (env flows into runGit). */
function withSourceRewrite<T>(sibling: string, fn: () => T): T {
   const prev = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
   };
   process.env.GIT_CONFIG_COUNT = '1';
   process.env.GIT_CONFIG_KEY_0 = `url.${sibling}.insteadOf`;
   process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/product-context';
   try {
      return fn();
   } finally {
      if (prev.count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prev.count;
      if (prev.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = prev.key;
      if (prev.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = prev.value;
   }
}

test('mounts: pin reachability is reachable via the advertised witness, unreachable off-history, unknown offline', () => {
   const { host, sibling, pin } = mountedPair();
   const mount = {
      name: 'acme-product-context',
      source: 'https://github.com/acme/product-context',
      pin,
      trackingRef: 'refs/heads/main',
   };
   // Offline (no rewrite): the fake source is unreachable -> unknown, never a guess.
   const offline = checkPinReachability(host, mount);
   assert.equal(offline.state, 'unknown');
   // With the source reachable: the pin is the witness tip -> reachable.
   const on = withSourceRewrite(sibling, () => checkPinReachability(host, mount));
   assert.equal(on.state, 'reachable');
   assert.equal(on.witnessRef, 'refs/heads/main');
   // A commit on an unadvertised side branch is not reachable from the witness.
   git(sibling, 'checkout', '-q', '-b', 'side');
   fs.writeFileSync(path.join(sibling, 'side.md'), '# side\n');
   git(sibling, 'add', '-A');
   git(sibling, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'side');
   const sidePin = git(sibling, 'rev-parse', 'HEAD');
   git(sibling, 'checkout', '-q', 'main');
   const off = withSourceRewrite(sibling, () => checkPinReachability(host, { ...mount, pin: sidePin }));
   assert.equal(off.state, 'unreachable');
   // Absent trackingRef, the witness resolves from the source's advertised HEAD.
   const head = withSourceRewrite(sibling, () =>
      checkPinReachability(host, { name: mount.name, source: mount.source, pin }),
   );
   assert.equal(head.state, 'reachable');
   assert.equal(head.witnessRef, 'refs/heads/main');
});

test('mounts: conformance pin-reachable is unknown offline and never awards federated', () => {
   const { host } = mountedPair();
   const { manifest } = loadManifest(host);
   hydrateMounts(host, manifest!, {});
   const report = conformanceReport(host);
   const item = report.items.find((i) => i.id === 'pin-reachable');
   assert.equal(item!.status, 'unknown');
   assert.notEqual(report.verifiedLevel, 'federated');
});

test('mounts: federation enforcement fails unhydrated or unverifiable mounts, passes verified ones', () => {
   const { host } = mountedPair();
   const { manifest } = loadManifest(host);
   // available: unhydrated -> error.
   let findings = federationEnforcement(host, manifest!, 'available', null);
   assert.equal(findings.length, 1);
   assert.match(findings[0].message, /not hydrated/);
   // Hydrated + verifiable via the hint -> clean.
   hydrateMounts(host, manifest!, {});
   findings = federationEnforcement(host, manifest!, 'available', null);
   assert.deepEqual(findings, []);
   // required: only task-routed mounts are enforced.
   findings = federationEnforcement(host, manifest!, 'required', new Set());
   assert.deepEqual(findings, []);
   // With the hint gone the cache is unverifiable, which enforcement rejects.
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   findings = federationEnforcement(host, manifest!, 'required', new Set(['acme-product-context']));
   assert.equal(findings.length, 1);
   assert.match(findings[0].message, /cannot be verified/);
});

test('mounts: --fetch owns the witness namespace, so status compares in the managed store even behind a hint', () => {
   const { host, sibling, pin } = mountedPair();
   // Local upload-pack refuses unadvertised object ids by default, as a host would.
   git(sibling, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
   const { manifest } = loadManifest(host);
   const r = withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(r.outcomes[0].status, 'hydrated');
   // The hint resolved the pin, and the store was populated anyway.
   assert.equal(r.outcomes[0].objectSource, 'hint');
   const store = storeFor(host, ACME_IDENTITY);
   assert.equal(git(store, 'rev-parse', witnessRefFor(ACME_IDENTITY, 'refs/heads/main')), pin);
   assert.equal(
      git(store, 'for-each-ref', '--format=%(refname)', 'refs/leji-witness/tmp'),
      '',
      'no temporary survives',
   );
   const rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'up-to-date');
   assert.equal(rep.comparisonRepository, 'managed-store');
   assert.equal(rep.witnessProvenance, 'managed');
   assert.equal(rep.ancestryComplete, true);
});

test('mounts: the managed witness follows a rewritten upstream; a failed refresh keeps the last known-good', () => {
   const { host, sibling, pin } = mountedPair();
   git(sibling, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
   const { manifest } = loadManifest(host);
   commitFile(sibling, 'b.md');
   withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(mountStatus(host, manifest!, {})[0].pinReport.behind, 1);
   // main is rewritten non-fast-forward: the forced refspec makes the witness follow.
   git(sibling, 'reset', '-q', '--hard', pin);
   const rewritten = commitFile(sibling, 'c.md');
   const cached = withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(cached.outcomes[0].status, 'cached', 'a cached projection never skips the witness refresh');
   const store = storeFor(host, ACME_IDENTITY);
   const witnessRef = witnessRefFor(ACME_IDENTITY, 'refs/heads/main');
   assert.equal(git(store, 'rev-parse', witnessRef), rewritten);
   assert.equal(mountStatus(host, manifest!, {})[0].pinReport.behind, 1);
   // A refresh that cannot reach the source leaves the last known-good witness.
   withSourceRewrite(path.join(sibling, 'gone'), () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(git(store, 'rev-parse', witnessRef), rewritten, 'the previous witness stays in place');
   const rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'behind');
   assert.equal(rep.witnessProvenance, 'managed');
});

test('mounts: an unmanaged witness is named by the repository it came from, or reported unavailable', () => {
   const { host, sibling } = mountedPair();
   const { manifest } = loadManifest(host);
   // Row 2 via the hint: the pin and refs/heads/main both come from the checkout.
   let rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.comparisonRepository, 'hint');
   assert.equal(rep.witnessProvenance, 'unmanaged');
   // Row 2 via the store, holding an ordinary refs/heads/main and no managed witness.
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   execFileSync('git', ['clone', '-q', '--bare', sibling, storeFor(host, ACME_IDENTITY)], {
      env: { ...process.env, GIT_DIR: undefined },
   });
   rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.comparisonRepository, 'managed-store');
   assert.equal(rep.witnessProvenance, 'unmanaged');
   assert.equal(rep.state, 'up-to-date');
   // Row 3: the pin resolves, the declared witness does not.
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].trackingRef = 'refs/heads/absent';
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   rep = mountStatus(host, loadManifest(host).manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'unknown');
   assert.equal(rep.reason, 'mount-witness-unavailable');
   assert.ok(!('behind' in rep) && !('ahead' in rep));
});

test('mounts: a gap in the counted range is unknown; a shallow store counts but never claims complete ancestry', () => {
   const { host, sibling, pin } = mountedPair();
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   const middle = commitFile(sibling, 'b.md');
   commitFile(sibling, 'c.md');
   const store = storeFor(host, ACME_IDENTITY);
   execFileSync('git', ['clone', '-q', '--bare', sibling, store], { env: { ...process.env, GIT_DIR: undefined } });
   // Both ends of the range resolve; a commit between them does not.
   fs.rmSync(path.join(store, 'objects', middle.slice(0, 2), middle.slice(2)));
   const { manifest } = loadManifest(host);
   let rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'unknown');
   assert.equal(rep.reason, 'mount-ancestry-incomplete');
   assert.equal(rep.ancestryComplete, false);
   assert.ok(!('behind' in rep) && !('ahead' in rep));
   // A shallow store answers the counts it can, and never claims complete ancestry.
   fs.rmSync(store, { recursive: true, force: true });
   execFileSync('git', ['clone', '-q', '--bare', '--depth', '1', `file://${sibling}`, store], {
      env: { ...process.env, GIT_DIR: undefined },
   });
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = git(sibling, 'rev-parse', 'HEAD');
   assert.notEqual(m.federation.mounts[0].pin, pin);
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   rep = mountStatus(host, loadManifest(host).manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'up-to-date');
   assert.equal(rep.behind, 0);
   assert.equal(rep.ancestryComplete, false);
});

test('mounts: disjoint histories are unrelated only when the comparison repository has complete ancestry', () => {
   const { host, sibling } = mountedPair();
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   commitFile(sibling, 'b.md');
   git(sibling, 'checkout', '-q', '--orphan', 'other');
   const orphan = commitFile(sibling, 'x.md');
   git(sibling, 'checkout', '-q', 'main');
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = orphan;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const store = storeFor(host, ACME_IDENTITY);
   execFileSync('git', ['clone', '-q', '--bare', sibling, store], { env: { ...process.env, GIT_DIR: undefined } });
   let rep = mountStatus(host, loadManifest(host).manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'unrelated');
   assert.equal(rep.ancestryComplete, true);
   assert.ok(rep.behind! > 0 && rep.ahead! > 0, 'both counts positive, with no merge base');
   // The same pair in a shallow store: a missing merge base is not evidence of
   // unrelated histories, so the honest answer is unknown.
   fs.rmSync(store, { recursive: true, force: true });
   execFileSync('git', ['clone', '-q', '--bare', '--depth', '1', '--no-single-branch', `file://${sibling}`, store], {
      env: { ...process.env, GIT_DIR: undefined },
   });
   rep = mountStatus(host, loadManifest(host).manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'unknown');
   assert.equal(rep.reason, 'mount-ancestry-incomplete');
   assert.equal(rep.ancestryComplete, false);
   assert.ok(!('behind' in rep) && !('ahead' in rep));
});

test('mounts: a requested fetch that fails is visible, and stays availability rather than failure', async () => {
   const { host, sibling } = mountedPair();
   const { manifest } = loadManifest(host);
   // The hint resolves the pin offline, so the projection succeeds; the fetch that
   // was explicitly asked for did not, and that may not pass unreported.
   const r = withSourceRewrite(path.join(sibling, 'gone'), () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(r.outcomes[0].status, 'hydrated');
   assert.equal(r.outcomes[0].storeFetched, false);
   const cli = await withSourceRewrite(path.join(sibling, 'gone'), () =>
      runCli(['mounts', 'hydrate', '--fetch', '--json', '--root', host]),
   );
   const payload = JSON.parse(cli.stdout);
   // Hydrate is best-effort: an unreachable source is a mount staying unavailable,
   // not a declaration error, a safety violation, or an internal failure.
   assert.equal(cli.code, 0);
   assert.equal(payload.ok, true);
   assert.equal(payload.outcomes[0].storeFetched, false, 'the failed fetch is on the outcome');
   assert.deepEqual(
      payload.findings.map((f: { rule: string; severity: string; path: string }) => [f.rule, f.severity, f.path]),
      [['mount-store-fetch-failed', 'warning', 'acme-product-context']],
   );
   // Nothing is remembered anywhere: there is no sidecar to remember it in.
   assert.ok(!fs.existsSync(path.join(host, '.leji', 'mounts', 'state.json')), 'no state file is written');
   // No git text reaches the output: the detail is a stable, Leji-authored sentence.
   assert.ok(!JSON.stringify(payload).includes('fatal:'), 'git stderr never reaches canonical output');
});

test('mounts: a witness refresh that fails in this run is visible, and nothing about it is recorded', async () => {
   const { host, sibling } = mountedPair();
   git(sibling, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
   const { manifest } = loadManifest(host);
   // One successful --fetch leaves the store holding the pin, so the next run
   // attempts no store fetch at all: the witness refresh is the only half that can
   // fail, and it used to fail silently.
   withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   const r = withSourceRewrite(path.join(sibling, 'gone'), () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(r.outcomes[0].storeFetched, true, 'the store was established; only the refresh failed');
   assert.equal(r.outcomes[0].witnessRefreshFailed, true);
   const cli = await withSourceRewrite(path.join(sibling, 'gone'), () =>
      runCli(['mounts', 'hydrate', '--fetch', '--json', '--root', host]),
   );
   const payload = JSON.parse(cli.stdout);
   // Visibility, never failure: hydrate stays best-effort.
   assert.equal(cli.code, 0);
   assert.equal(payload.ok, true);
   assert.deepEqual(
      payload.findings.map((f: { rule: string; severity: string; path: string }) => [f.rule, f.severity, f.path]),
      [['mount-witness-refresh-failed', 'warning', 'acme-product-context']],
   );
   // Nothing about the failure persists, because nothing persists at all…
   assert.ok(!fs.existsSync(path.join(host, '.leji', 'mounts', 'state.json')), 'no state file is written');
   // …so an offline status, which cannot know a witness is fresh, says nothing of it.
   assert.ok(
      !JSON.stringify(mountStatus(host, manifest!, {}))
         .toLowerCase()
         .includes('refresh'),
   );
});

test('mounts: ambiguous submodules are reported as ambiguity, never as an absent pin', () => {
   const { host, sibling } = mountedPair();
   fs.rmSync(path.join(host, '.leji', 'mounts.local.json'));
   for (const name of ['one', 'two']) {
      execFileSync('git', ['clone', '-q', sibling, path.join(host, 'vendor', name)], {
         env: { ...process.env, GIT_DIR: undefined },
      });
   }
   fs.writeFileSync(
      path.join(host, '.gitmodules'),
      ['one', 'two']
         .map((n) => `[submodule "${n}"]\n\tpath = vendor/${n}\n\turl = https://github.com/acme/product-context\n`)
         .join(''),
   );
   const { manifest } = loadManifest(host);
   const rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.state, 'unknown');
   assert.equal(rep.reason, 'mount-source-ambiguous', 'unconsulted repositories are not an absent pin');
   assert.equal(rep.comparisonRepository, null);
});

test('mounts: submodule ambiguity outranks a candidate that resolves only the pin', () => {
   const { host, sibling, pin } = mountedPair();
   // The hint holds the pin and no longer resolves the witness ref…
   const hint = path.join(path.dirname(host), 'hint');
   execFileSync('git', ['clone', '-q', sibling, hint], { env: { ...process.env, GIT_DIR: undefined } });
   git(hint, 'checkout', '-q', '--detach', pin);
   git(hint, 'update-ref', '-d', 'refs/heads/main');
   fs.writeFileSync(
      path.join(host, '.leji', 'mounts.local.json'),
      JSON.stringify({ mounts: { 'acme-product-context': { repo: hint } } }) + '\n',
   );
   // …and two submodules match the source, so status walked past the hint into
   // repositories it never picked between.
   for (const name of ['one', 'two']) {
      execFileSync('git', ['clone', '-q', sibling, path.join(host, 'vendor', name)], {
         env: { ...process.env, GIT_DIR: undefined },
      });
   }
   fs.writeFileSync(
      path.join(host, '.gitmodules'),
      ['one', 'two']
         .map((n) => `[submodule "${n}"]\n\tpath = vendor/${n}\n\turl = https://github.com/acme/product-context\n`)
         .join(''),
   );
   const { manifest } = loadManifest(host);
   const rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.reason, 'mount-source-ambiguous', 'a pin-only candidate is not evidence about the witness');
   assert.equal(rep.comparisonRepository, null);
   // Hydration is unaffected: the hint holds the pin, and ambiguity only decides
   // what to say when nothing else resolves it.
   assert.equal(hydrateMounts(host, manifest!, {}).outcomes[0].objectSource, 'hint');
});

test('mounts: --fetch retains the pin by a resolver-owned ref, not just FETCH_HEAD', () => {
   const { host, sibling, pin } = mountedPair();
   git(sibling, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
   const { manifest } = loadManifest(host);
   // main moves past the pin, so the witness fetch overwrites FETCH_HEAD with a
   // different commit: only a ref of our own still retains the version of record.
   commitFile(sibling, 'b.md');
   withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   const store = storeFor(host, ACME_IDENTITY);
   assert.equal(git(store, 'rev-parse', pinRefFor(ACME_IDENTITY, pin)), pin);
   assert.notEqual(git(store, 'rev-parse', 'FETCH_HEAD'), pin);
   assert.ok(
      git(store, 'for-each-ref', '--format=%(refname)', 'refs/leji-pin').includes(pinRefFor(ACME_IDENTITY, pin)),
   );
});

test('mounts: git exit codes separate "no merge base" from a repository that cannot answer', () => {
   const { sibling } = mountedPair();
   const main = git(sibling, 'rev-parse', 'HEAD');
   git(sibling, 'checkout', '-q', '--orphan', 'other');
   const orphan = commitFile(sibling, 'x.md');
   git(sibling, 'checkout', '-q', 'main');
   // Exit 1 is the answer "these histories share no commit"…
   const answered = runGit(['-C', sibling, 'merge-base', main, orphan]);
   assert.equal(answered.ok, false);
   assert.equal(answered.code, 1);
   // …anything else is the repository failing to answer, never an answer.
   const failed = runGit(['-C', sibling, 'merge-base', main, 'f'.repeat(40)]);
   assert.equal(failed.ok, false);
   assert.notEqual(failed.code, 1);
   assert.equal(runGit(['-C', sibling, 'rev-parse', 'HEAD']).code, 0);
});

test('mounts: status walks past a candidate holding only the pin to one holding both operands', () => {
   const { host, sibling, pin } = mountedPair();
   // The hint holds the pin but no longer resolves the witness ref…
   const hint = path.join(path.dirname(host), 'hint');
   execFileSync('git', ['clone', '-q', sibling, hint], { env: { ...process.env, GIT_DIR: undefined } });
   git(hint, 'checkout', '-q', '--detach', pin);
   git(hint, 'update-ref', '-d', 'refs/heads/main');
   fs.writeFileSync(
      path.join(host, '.leji', 'mounts.local.json'),
      JSON.stringify({ mounts: { 'acme-product-context': { repo: hint } } }) + '\n',
   );
   // …while a submodule declared against the same source holds both.
   const sub = path.join(host, 'vendor', 'sibling');
   execFileSync('git', ['clone', '-q', sibling, sub], { env: { ...process.env, GIT_DIR: undefined } });
   fs.writeFileSync(
      path.join(host, '.gitmodules'),
      '[submodule "sibling"]\n\tpath = vendor/sibling\n\turl = https://github.com/acme/product-context\n',
   );
   const { manifest } = loadManifest(host);
   const rep = mountStatus(host, manifest!, {})[0].pinReport;
   assert.equal(rep.comparisonRepository, 'submodule', 'a pin-only hint never masks a source holding both');
   assert.equal(rep.witnessProvenance, 'unmanaged');
   assert.equal(rep.state, 'up-to-date');
});

// --- the publication protocol ------------------------------------------------
//
// There is no lock: every producer for a key stages byte-identical content, and
// `rename` alone decides which one publishes. These are the properties that
// decision has to hold, exercised against real git fixtures and, where only real
// concurrency shows them, real processes.

test('mounts: concurrent publishers on a cold cache publish exactly once, and leave no staging behind', async () => {
   const { host, pin } = mountedPair();
   const runs = await Promise.all(
      Array.from({ length: 4 }, () => runCliProc(['mounts', 'hydrate', '--json', '--root', host])),
   );
   assert.deepEqual(
      runs.map((r) => r.code),
      [0, 0, 0, 0],
      'a lost race is an ordinary outcome, never an error exit',
   );
   const statuses = runs.map((r) => JSON.parse(r.stdout).outcomes[0].status).sort();
   assert.deepEqual(statuses, ['cached', 'cached', 'cached', 'hydrated'], 'exactly one rename wins');
   const entry = path.join(host, '.leji', 'mounts', 'cache', cacheKeyFor(ACME_IDENTITY, pin));
   assert.ok(fs.existsSync(path.join(entry, 'projection', 'complete')), 'the winner published its marker');
   assert.deepEqual(fs.readdirSync(entry), ['projection'], 'every loser removed its own staging directory');
});

test('mounts: publishing onto an entry that already carries its marker is cached, and touches nothing', () => {
   const { host, pin } = mountedPair();
   const { manifest } = loadManifest(host);
   assert.equal(hydrateMounts(host, manifest!, {}).outcomes[0].status, 'hydrated');
   const entry = path.join(host, '.leji', 'mounts', 'cache', cacheKeyFor(ACME_IDENTITY, pin));
   const projection = path.join(entry, 'projection');
   // The sidecar carries this run's `hydratedAt`, so identical bytes prove the
   // published entry was left exactly as the first producer wrote it.
   const before = fs.readFileSync(path.join(projection, 'metadata.json'), 'utf8');
   const again = hydrateMounts(host, manifest!, {});
   assert.equal(again.outcomes[0].status, 'cached');
   assert.equal(again.outcomes[0].objectSource, undefined, 'a cache hit projects nothing');
   assert.equal(fs.readFileSync(path.join(projection, 'metadata.json'), 'utf8'), before);
   assert.deepEqual(fs.readdirSync(entry), ['projection']);
});

test('mounts: a projection without its marker is poison, and is never repaired', () => {
   const { host, pin } = mountedPair();
   const { manifest } = loadManifest(host);
   const entry = path.join(host, '.leji', 'mounts', 'cache', cacheKeyFor(ACME_IDENTITY, pin));
   const projection = path.join(entry, 'projection');
   fs.mkdirSync(projection, { recursive: true });
   fs.writeFileSync(path.join(projection, 'leji.json'), 'half a projection\n');
   const first = hydrateMounts(host, manifest!, {});
   assert.deepEqual(
      first.outcomes.map((o) => [o.status, o.detail]),
      [['error', 'the cache entry is incomplete and is not repaired automatically']],
   );
   // Nothing under the key counts as hydrated, because the marker is what counts.
   assert.equal(locateMount(host, manifest!, 'acme-product-context').present, false);
   assert.ok(validateLayer(host).findings.some((f) => f.rule === 'mount-unavailable'));
   // A second run says the same thing rather than deciding, from outside, that no
   // other producer is mid-publish.
   const second = hydrateMounts(host, manifest!, {});
   assert.deepEqual(second.outcomes, first.outcomes);
   assert.equal(fs.readFileSync(path.join(projection, 'leji.json'), 'utf8'), 'half a projection\n');
   assert.equal(fs.existsSync(path.join(projection, 'complete')), false);
   assert.deepEqual(fs.readdirSync(entry), ['projection'], 'the refusal leaves no staging behind');
});

test('mounts: a sibling whose rootPath tree is empty still publishes a non-empty projection', () => {
   const { host } = mountedPair();
   // A sibling that declares a rootPath holding nothing at the pin: the projection
   // is the manifest and the resolver's own two files, and nothing else.
   const empty = path.join(path.dirname(host), 'empty-sibling');
   fs.mkdirSync(empty, { recursive: true });
   fs.writeFileSync(
      path.join(empty, 'leji.json'),
      JSON.stringify(
         siblingManifest({
            rootPath: 'docs/',
            bootProfilePath: 'boot.md',
            // Outside the rootPath tree too, so "empty" stays the fixture's point.
            categories: { domain: { indexes: ['index/domain.md'] } },
         }),
         null,
         2,
      ) + '\n',
   );
   // The boot profile sits outside the (empty) rootPath tree: the closure carries
   // it anyway, which is the relocated-entrypoint case the closure rule exists for.
   fs.writeFileSync(path.join(empty, 'boot.md'), '# Boot\n');
   fs.mkdirSync(path.join(empty, 'index'), { recursive: true });
   fs.writeFileSync(path.join(empty, 'index', 'domain.md'), '# Domain index\n');
   git(empty, 'init', '-q', '-b', 'main');
   git(empty, 'add', '-A');
   git(empty, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
   const emptyPin = git(empty, 'rev-parse', 'HEAD');
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = emptyPin;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.writeFileSync(
      path.join(host, '.leji', 'mounts.local.json'),
      JSON.stringify({ mounts: { 'acme-product-context': { repo: '../empty-sibling' } } }) + '\n',
   );
   const { manifest } = loadManifest(host);
   assert.equal(hydrateMounts(host, manifest!, {}).outcomes[0].status, 'hydrated');
   const projection = path.join(host, '.leji', 'mounts', 'cache', cacheKeyFor(ACME_IDENTITY, emptyPin), 'projection');
   assert.deepEqual(fs.readdirSync(projection).sort(), ['boot.md', 'complete', 'index', 'leji.json', 'metadata.json']);
   // Publishing the marker inside the staged tree is what makes the rename
   // exclusive: POSIX replaces an empty destination directory, and a published
   // entry is never empty.
   const decoy = path.join(host, '.leji', 'mounts', 'decoy');
   fs.mkdirSync(decoy, { recursive: true });
   assert.throws(() => fs.renameSync(decoy, projection), 'an ordinary rename cannot replace a published entry');
   assert.equal(hydrateMounts(host, manifest!, {}).outcomes[0].status, 'cached');
});

// --- The projection closure --------------------------------------------------
//
// A layer projects as its manifest declares it, not as its directory layout
// happens to look: relocated machine artifacts, governed content outside
// rootPath and bound profiles outside the profiles tree all travel. An absent
// optional selection contributes nothing; an absent referenced file fails the
// closure with a stable code naming the artifact that declared it.

/**
 * A sibling manifest that validates against the canonical schema: the fixture's own
 * declarations laid over the fields every manifest must carry. The closure
 * schema-checks the pinned manifest, so a fixture about (say) relocated machine
 * artifacts still has to be a real manifest, not the two fields it happens to read.
 */
function siblingManifest(extra: Record<string, unknown>): Record<string, unknown> {
   return {
      leji: '1.0',
      name: 'acme-product-context',
      owners: { primary: { name: 'Sibling Owner' } },
      categories: { domain: { indexes: ['docs/index/domain.md'] } },
      ...extra,
   };
}

/** The one file `siblingManifest`'s category index makes closure-critical. Inside
 * `docs/`, so a fixture asserting the projected top level is unchanged by it. */
const SIBLING_INDEX_FILES: Record<string, string> = { 'docs/index/domain.md': '# Domain index\n' };

/** A pinned context index as its schema requires one. A closure fixture cares only
 * about which governed paths the index names; the required id/title/category on each
 * entry, and the header the schema requires, are filled in here. */
function storedIndex(entries: { path: string }[]): string {
   return (
      JSON.stringify(
         {
            schemaVersion: '1.0',
            generatedAt: '2026-01-01T00:00:00Z',
            rootPath: 'docs/',
            entries: entries.map((e, i) => ({
               id: `fixture-entry-${i}`,
               path: e.path,
               title: 'Fixture',
               category: 'domain',
            })),
         },
         null,
         2,
      ) + '\n'
   );
}

/** A pinned context changelog as its schema requires one (at least one entry). */
function storedChangelog(): string {
   return (
      JSON.stringify(
         {
            schemaVersion: '1.0',
            entries: [{ id: 'fixture-seed', date: '2026-01-01', type: 'added', summary: 'Fixture', paths: ['docs/'] }],
         },
         null,
         2,
      ) + '\n'
   );
}

/** A sibling built from an explicit manifest and file set, plus the `mountedPair()`
 * host re-pinned and re-hinted at it. Every closure fixture differs only in those
 * two, so the wiring is written once. A string manifest is written verbatim, for
 * the fixtures whose point is bytes an object cannot express. */
function customSibling(
   manifest: object | string,
   files: Record<string, string>,
   /** Symlinks to author before the commit, as relPath -> raw target. */
   links: Record<string, string> = {},
): { host: string; sibling: string; pin: string } {
   const { host } = mountedPair();
   const sibling = path.join(path.dirname(host), 'custom-sibling');
   fs.mkdirSync(sibling, { recursive: true });
   fs.writeFileSync(
      path.join(sibling, 'leji.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2) + '\n',
   );
   for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(sibling, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
   }
   for (const [rel, target] of Object.entries(links)) {
      const abs = path.join(sibling, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(target, abs);
   }
   git(sibling, 'init', '-q', '-b', 'main');
   git(sibling, 'add', '-A');
   git(sibling, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
   const pin = git(sibling, 'rev-parse', 'HEAD');
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = pin;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   fs.writeFileSync(
      path.join(host, '.leji', 'mounts.local.json'),
      JSON.stringify({ mounts: { 'acme-product-context': { repo: '../custom-sibling' } } }) + '\n',
   );
   return { host, sibling, pin };
}

/** Hydrate the host's single declared mount: its outcome, and where the entry lands. */
function hydrateOne(host: string, pin: string): { outcome: HydrateOutcome; projection: string } {
   const { manifest } = loadManifest(host);
   return {
      outcome: hydrateMounts(host, manifest!, {}).outcomes[0],
      projection: path.join(host, '.leji', 'mounts', 'cache', cacheKeyFor(ACME_IDENTITY, pin), 'projection'),
   };
}

test('mounts: relocated machine artifacts are projected from their declared paths', () => {
   const { host, pin } = customSibling(
      siblingManifest({
         rootPath: 'docs/',
         bootProfilePath: 'docs/boot-profile.md',
         machine: { indexPath: 'meta/context-index.json', changelogPath: 'meta/context-changelog.json' },
      }),
      {
         ...SIBLING_INDEX_FILES,
         'docs/boot-profile.md': '# Boot\n',
         'meta/context-index.json': storedIndex([]),
         'meta/context-changelog.json': storedChangelog(),
      },
   );
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   assert.deepEqual(fs.readdirSync(path.join(projection, 'meta')).sort(), [
      'context-changelog.json',
      'context-index.json',
   ]);
});

test('mounts: governed content outside rootPath is projected, because the pinned index names it', () => {
   const { host, pin } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      {
         ...SIBLING_INDEX_FILES,
         'docs/boot-profile.md': '# Boot\n',
         'docs/context-index.json': storedIndex([{ path: 'src/auth/DESIGN.md' }]),
         'src/auth/DESIGN.md': '# Auth design\n',
      },
   );
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   assert.ok(fs.existsSync(path.join(projection, 'src', 'auth', 'DESIGN.md')), 'the indexed path travels');
});

test('mounts: an agents binding outside the profiles tree is projected', () => {
   const { host, pin } = customSibling(
      siblingManifest({
         rootPath: 'docs/',
         bootProfilePath: 'docs/boot-profile.md',
         machine: { agentProfilesPath: 'docs/agents/' },
         agents: { reviewer: 'tools/review/profile.md' },
      }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n', 'tools/review/profile.md': '# Reviewer\n' },
   );
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   assert.ok(
      fs.existsSync(path.join(projection, 'tools', 'review', 'profile.md')),
      'the binding, not the tree, selects',
   );
});

test('mounts: a layer with no decisions tree and no generated index still projects', () => {
   const { host, pin } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n', 'docs/domain/overview.md': '# Overview\n' },
   );
   // Every optional selection is absent at once: git cannot represent an empty
   // directory, and a core layer has never generated an index. Absence is normal.
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   assert.deepEqual(fs.readdirSync(projection).sort(), ['complete', 'docs', 'leji.json', 'metadata.json']);
});

test('mounts: a dangling agents binding at the pin fails, naming the declaring artifact', async () => {
   const { host, pin } = customSibling(
      siblingManifest({
         rootPath: 'docs/',
         bootProfilePath: 'docs/boot-profile.md',
         agents: { reviewer: 'tools/review/profile.md' },
      }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' },
   );
   // Closure-critical content absent at the pin is degraded knowledge of the sibling,
   // not a guard this host crossed: the mount is unavailable, and hydrate stays
   // best-effort about it.
   const { outcome } = hydrateOne(host, pin);
   const detail = 'closure-critical path missing at the pin: agents.reviewer profile tools/review/profile.md';
   assert.deepEqual([outcome.status, outcome.detail], ['unavailable', detail]);
   // Exit 0, with the failure in findings[] as well as the outcome: the JSON
   // consumer's diagnostic interface is findings, and it carries the same sentence.
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 0);
   const out = JSON.parse(cli.stdout);
   assert.equal(out.ok, true);
   assert.deepEqual(
      out.findings.map((f: { rule: string; severity: string }) => [f.rule, f.severity]),
      [['mount-projection-failed', 'warning']],
   );
   assert.ok(out.findings[0].message.includes(detail), out.findings[0].message);
   assert.equal(out.findings[0].path, 'acme-product-context');
});

test('mounts: a pin no object store holds is unavailable before any closure runs', async () => {
   const { host } = mountedPair();
   // A well-formed pin the hint repository does not contain: resolution fails at the
   // object-source step, so the closure never runs and there is nothing to warn about
   // beyond the mount being unavailable.
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = 'b'.repeat(40);
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const { manifest } = loadManifest(host);
   const outcome = hydrateMounts(host, manifest!, {}).outcomes[0];
   assert.deepEqual(
      [outcome.status, outcome.detail],
      ['unavailable', 'no reachable object store holds the pin (declare a hint, or pass --fetch)'],
   );
   assert.equal(outcome.projectionFailed, undefined, 'no projection was attempted');
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 0);
   assert.deepEqual(JSON.parse(cli.stdout).findings, []);
});

test('mounts: a malformed string in the pinned manifest is an error, never unavailability', async () => {
   // Written as bytes, because the point is the unpaired surrogate that parses out of
   // them: valid JSON carrying a string the scalar gate exists to refuse.
   const { host, pin } = customSibling(
      '{"leji":"1.0","name":"acme-product-context","rootPath":"docs/","bootProfilePath":"docs/boot-profile.md","description":"\\ud800"}\n',
      { 'docs/boot-profile.md': '# Boot\n' },
   );
   const { outcome } = hydrateOne(host, pin);
   assert.deepEqual([outcome.status, outcome.detail], ['error', 'the pinned leji.json contains a malformed string']);
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 1);
   assert.equal(JSON.parse(cli.stdout).ok, false);
});

test('mounts: structurally malformed pinned content is unavailable, never a thrown error', async () => {
   // Valid JSON of the wrong shape at a point the closure dereferences. Each one
   // reaches a property access on something that is not a mapping, which throws
   // where the closure owes a tagged failure; all are ordinary sibling-shape
   // defects, so all are unavailability.
   const base = siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' });
   const boot = { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' };
   const cases: { what: string; manifest: object | string; files: Record<string, string>; detail: string }[] = [
      {
         what: 'a manifest that parses to null',
         manifest: 'null\n',
         files: {},
         detail: 'the pinned leji.json is not an object',
      },
      {
         what: 'category indexes as an object',
         manifest: { ...base, categories: { domain: { indexes: { first: 'docs/index.md' } } } },
         files: boot,
         detail: 'the pinned leji.json categories.domain has no indexes array',
      },
      {
         what: 'index entries as an object',
         manifest: base,
         files: { ...boot, 'docs/context-index.json': '{"entries": {"path": "docs/x.md"}}\n' },
         detail: 'the pinned context index has no entries array',
      },
      // A machine field of the wrong type either throws in the path helpers or reads
      // as absent and quietly defaults; both are worse than saying so.
      {
         what: 'machine.indexPath as a number',
         manifest: { ...base, machine: { indexPath: 3 } },
         files: boot,
         detail: 'the pinned leji.json machine.indexPath is not a string',
      },
      {
         what: 'machine.agentProfilesPath as an array',
         manifest: { ...base, machine: { agentProfilesPath: ['docs/agents/'] } },
         files: boot,
         detail: 'the pinned leji.json machine.agentProfilesPath is not a string',
      },
      {
         what: 'a null machine path, which would otherwise default silently',
         manifest: { ...base, machine: { changelogPath: null } },
         files: boot,
         detail: 'the pinned leji.json machine.changelogPath is not a string',
      },
   ];
   for (const c of cases) {
      const { host, pin } = customSibling(c.manifest, c.files);
      const { outcome } = hydrateOne(host, pin);
      assert.deepEqual([outcome.status, outcome.detail], ['unavailable', c.detail], c.what);
      const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
      assert.equal(cli.code, 0, c.what);
      assert.deepEqual(
         JSON.parse(cli.stdout).findings.map((f: { rule: string; severity: string }) => [f.rule, f.severity]),
         [['mount-projection-failed', 'warning']],
         c.what,
      );
   }
});

/** Raw-bytes git: stdin and stdout stay Buffers. A path with no UTF-8 form cannot
 * reach git through argv (Node encodes argv as UTF-8) and cannot be written to an
 * APFS filesystem at all, so it is built straight into a tree object instead. */
function gitRaw(cwd: string, args: string[], input?: Buffer): Buffer {
   return execFileSync('git', args, { cwd, input, env: { ...process.env, GIT_DIR: undefined } });
}

/** A filename with no decoding: 0xFF is not a legal UTF-8 lead byte. */
const BAD_PATH_BYTES = Buffer.from([0xff, 0x2e, 0x6d, 0x64]);

/**
 * Re-pin the sibling at a commit whose tree carries a path that is not valid
 * UTF-8, placed either beside the projection's selections or inside `docs/`.
 * `ls-tree -z` emits exactly the record format `mktree -z` consumes, so the
 * existing tree is reused verbatim and only the extra entry is authored here.
 */
function pinUndecodablePath(host: string, sibling: string, where: 'outside' | 'inside'): string {
   const oid = gitRaw(sibling, ['hash-object', '-w', '--stdin'], Buffer.from('# Bad\n')).toString('utf8').trim();
   const badEntry = Buffer.concat([Buffer.from(`100644 blob ${oid}\t`, 'utf8'), BAD_PATH_BYTES, Buffer.from([0])]);
   const mktree = (input: Buffer): string => gitRaw(sibling, ['mktree', '-z'], input).toString('utf8').trim();
   let rootTree: string;
   if (where === 'outside') {
      rootTree = mktree(Buffer.concat([gitRaw(sibling, ['ls-tree', '-z', 'HEAD']), badEntry]));
   } else {
      const docs = mktree(Buffer.concat([gitRaw(sibling, ['ls-tree', '-z', 'HEAD:docs']), badEntry]));
      const lejiJson = git(sibling, 'rev-parse', 'HEAD:leji.json');
      const nul = Buffer.from([0]);
      rootTree = mktree(
         Buffer.concat([
            Buffer.from(`100644 blob ${lejiJson}\tleji.json`, 'utf8'),
            nul,
            Buffer.from(`040000 tree ${docs}\tdocs`, 'utf8'),
            nul,
         ]),
      );
   }
   const pin = git(
      sibling,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit-tree',
      rootTree,
      '-m',
      'bad',
   );
   // Neither test means anything unless the bytes really landed in the tree, and a
   // silently-dropped entry would leave both of them passing.
   const listing = gitRaw(sibling, ['ls-tree', '-r', '-z', '--full-tree', pin]);
   assert.ok(listing.includes(BAD_PATH_BYTES), 'the pinned tree carries the undecodable path');
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = pin;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   return pin;
}

test('mounts: an undecodable path outside every selection is skipped, not failed', () => {
   const { host, sibling } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' },
   );
   // The enumeration is the whole repository, so it sees paths the projection never
   // selects. One of them being undecodable is another repository's business.
   const pin = pinUndecodablePath(host, sibling, 'outside');
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   assert.deepEqual(fs.readdirSync(projection).sort(), ['complete', 'docs', 'leji.json', 'metadata.json']);
});

test('mounts: an undecodable path under a selected prefix stays a safety error', async () => {
   const { host, sibling } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' },
   );
   // Inside the projection there is no skipping it: nothing can be materialized
   // under a name that has no UTF-8 form.
   const pin = pinUndecodablePath(host, sibling, 'inside');
   const { outcome } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'error');
   assert.ok(outcome.detail!.startsWith('non-UTF-8 path in the pinned tree: '), outcome.detail);
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 1);
});

test('mounts: a governed path carrying glob metacharacters selects itself, not a pattern match', () => {
   // The closure enumerates the tree and selects by name. Handed to git as a
   // pathspec, `src/a[b].md` is a character class matching `src/ab.md`: the decoy
   // would travel and the real file would be reported missing at the pin.
   const { host, pin } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      {
         ...SIBLING_INDEX_FILES,
         'docs/boot-profile.md': '# Boot\n',
         'docs/context-index.json': storedIndex([{ path: 'src/a[b].md' }]),
         'src/a[b].md': '# Literal\n',
         'src/ab.md': '# Decoy\n',
      },
   );
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   assert.ok(fs.existsSync(path.join(projection, 'src', 'a[b].md')), 'the named file travels');
   assert.ok(!fs.existsSync(path.join(projection, 'src', 'ab.md')), 'the glob match does not');
});

test('mounts: the first missing closure-critical path is chosen by byte order, not map order', () => {
   const { host, pin } = customSibling(
      siblingManifest({
         rootPath: 'docs/',
         bootProfilePath: 'docs/boot-profile.md',
         agents: { zeta: 'tools/z.md', alpha: 'tools/a.md' },
      }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' },
   );
   // Both bindings dangle, and declaration order puts zeta first. Every SDK must
   // still name tools/a.md, or a Go map's random iteration decides which failure a
   // host is told about.
   const { outcome } = hydrateOne(host, pin);
   assert.deepEqual(
      [outcome.status, outcome.detail],
      ['unavailable', 'closure-critical path missing at the pin: agents.alpha profile tools/a.md'],
   );
});

test('mounts: a declared path escaping the repository fails the closure', () => {
   const { host, pin } = customSibling(siblingManifest({ rootPath: 'docs/', bootProfilePath: '../outside.md' }), {
      ...SIBLING_INDEX_FILES,
      'docs/keep.md': '# Keep\n',
   });
   const { outcome } = hydrateOne(host, pin);
   assert.deepEqual([outcome.status, outcome.detail], ['error', 'uncontained bootProfilePath: ../outside.md']);
});

test('mounts: overlapping selections are deduplicated, never projected twice', () => {
   const { host, pin } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      {
         ...SIBLING_INDEX_FILES,
         'docs/boot-profile.md': '# Boot\n',
         'docs/context-index.json': storedIndex([{ path: 'docs/domain/overview.md' }]),
         'docs/domain/overview.md': '# Overview\n',
      },
   );
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated');
   // The indexed path is inside the rootPath tree, so two selections reach it. The
   // projection is their union: the manifest, the boot profile, the index, the
   // category index file and the one governed document, counted once each.
   const metadata = JSON.parse(fs.readFileSync(path.join(projection, 'metadata.json'), 'utf8'));
   assert.equal(metadata.files, 5);
});

test('mounts: a cache entry published under the old epoch is never served', () => {
   const { host, pin } = mountedPair();
   // An entry keyed under "1" holds a pre-closure projection of this exact pin. The
   // epoch is the whole invalidation mechanism, so it may not answer for it.
   const oldKey = crypto.createHash('sha256').update(`${ACME_IDENTITY}\n${pin}\n1`).digest('hex');
   const oldProjection = path.join(host, '.leji', 'mounts', 'cache', oldKey, 'projection');
   fs.mkdirSync(oldProjection, { recursive: true });
   fs.writeFileSync(path.join(oldProjection, 'complete'), '');
   const { outcome, projection } = hydrateOne(host, pin);
   assert.equal(outcome.status, 'hydrated', 'the old-epoch entry is not a cache hit');
   assert.notEqual(outcome.cacheKey, oldKey);
   assert.ok(fs.existsSync(path.join(projection, 'leji.json')), 'the new epoch extracted afresh');
});

test('mounts: the status projection sees an untracked bound profile that validate cannot', async () => {
   // The discover-before-host case: validation reads the working tree, where the
   // bound profile is right there, while the projection reads HEAD's object store,
   // where it was never committed. Only the second is what a host would get.
   const root = tmpdir('leji-selfproj-');
   const fixture = path.join(repoRoot, 'fixtures', 'valid-actors');
   const profileRel = path.join('docs', 'agents', 'reviewer.md');
   fs.cpSync(fixture, root, { recursive: true });
   fs.rmSync(path.join(root, profileRel));
   git(root, 'init', '-q', '-b', 'main');
   git(root, 'add', '-A');
   git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
   fs.cpSync(path.join(fixture, profileRel), path.join(root, profileRel));
   assert.deepEqual(
      validateLayer(root).findings.filter((f) => f.severity === 'error'),
      [],
      'the working tree is valid, which is exactly why validate cannot see this',
   );
   const r = await runCli(['status', '--json', '--root', root]);
   assert.equal(r.code, 0, 'the projection section diagnoses; it never gates');
   const projection = JSON.parse(r.stdout).projection;
   assert.equal(projection.state, 'fail');
   assert.ok(projection.detail.includes('agents.reviewer'), projection.detail);
});

test('mounts: the status projection is ok on a committed layer and no-commit before the first commit', async () => {
   const { sibling } = mountedPair();
   let r = await runCli(['status', '--json', '--root', sibling]);
   const ok = JSON.parse(r.stdout).projection;
   assert.equal(ok.state, 'ok');
   assert.ok(ok.files > 0);
   assert.match(ok.commit, /^[0-9a-f]{40}$/, 'the report names the commit it judged');
   // An unborn HEAD has nothing to judge, and the section says so rather than failing.
   const fresh = tmpdir('leji-unborn-');
   fs.cpSync(siblingExample, fresh, { recursive: true });
   git(fresh, 'init', '-q', '-b', 'main');
   r = await runCli(['status', '--json', '--root', fresh]);
   assert.deepEqual(JSON.parse(r.stdout).projection, { state: 'no-commit' });
});

/**
 * A `reference-transaction` hook in the managed store, firing only on the
 * canonical witness ref. `abort` fails the swap the way a lock, a permission
 * error or a full disk does. `publish` writes `oid` into the ref and then fails,
 * which is the state a run finds when another writer published between its read
 * of <oldvalue> and its own swap; the interleaving itself is not reachable in a
 * single process, so the fixture reproduces what it leaves behind.
 */
function witnessTransactionHook(store: string, witnessRef: string, mode: 'abort' | 'publish', oid?: string): void {
   const hooks = path.join(store, 'hooks');
   fs.mkdirSync(hooks, { recursive: true });
   const publish =
      mode === 'publish'
         ? `mkdir -p "$(dirname "${store}/${witnessRef}")"\nprintf '%s\\n' '${oid}' > "${store}/${witnessRef}"\n`
         : '';
   fs.writeFileSync(
      path.join(hooks, 'reference-transaction'),
      // Each stdin line is "<old> <new> <ref>"; every other ref (the fetched
      // temporary, the pin ref) passes through untouched.
      `#!/bin/sh\n[ "$1" = prepared ] || exit 0\ngrep -q " ${witnessRef}$" || exit 0\n${publish}exit 1\n`,
      { mode: 0o755 },
   );
}

test('mounts: a lost compare-and-swap is a confirmed mismatch; an operational failure never reads as success', async () => {
   const { host, sibling, pin } = mountedPair();
   git(sibling, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
   const { manifest } = loadManifest(host);
   const store = storeFor(host, ACME_IDENTITY);
   const witnessRef = witnessRefFor(ACME_IDENTITY, 'refs/heads/main');
   // The witness ref does not exist yet, so this run swaps against "must not exist"
   // — and finds another writer's commit there instead. That is a race it lost, not
   // a failure: the published witness stands and nothing is reported.
   fs.mkdirSync(store, { recursive: true });
   assert.ok(runGit(['init', '--bare', '-q', store]).ok);
   witnessTransactionHook(store, witnessRef, 'publish', pin);
   let r = withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(r.outcomes[0].witnessRefreshFailed, undefined, 'another writer publishing is a valid outcome');
   assert.equal(git(store, 'rev-parse', witnessRef), pin, "the other writer's witness stands");
   // The same failed swap, with the ref holding exactly what this run expected: no
   // one published, so this is the disk, the permissions or a lock, and it may not
   // pass as a refresh that happened.
   witnessTransactionHook(store, witnessRef, 'abort');
   r = withSourceRewrite(sibling, () => hydrateMounts(host, manifest!, { fetch: true }));
   assert.equal(r.outcomes[0].storeFetched, true, 'the store was established; only the swap failed');
   assert.equal(r.outcomes[0].witnessRefreshFailed, true);
   assert.equal(git(store, 'rev-parse', witnessRef), pin, 'the previous witness stays in place');
   const cli = await withSourceRewrite(sibling, () =>
      runCli(['mounts', 'hydrate', '--fetch', '--json', '--root', host]),
   );
   assert.equal(cli.code, 0);
   assert.deepEqual(
      JSON.parse(cli.stdout).findings.map((f: { rule: string; severity: string }) => [f.rule, f.severity]),
      [['mount-witness-refresh-failed', 'warning']],
   );
});

// --- The canonical-schema gate, and the portability rules the closure holds -----
//
// Everything below is a rule the three SDKs have to answer identically. Each test
// names the divergence it closes, because the fixture on its own does not show it.

/**
 * Re-pin the sibling at a commit whose tree carries authored entries the working
 * tree cannot hold: a mode/content pair per path, staged straight into the index.
 * A case-insensitive filesystem cannot hold two names that fold together, and no
 * filesystem holds a zero-byte symlink, so these are built rather than written.
 */
function pinWithEntries(
   host: string,
   sibling: string,
   entries: { mode: string; content: Buffer; relPath: string }[],
): string {
   for (const e of entries) {
      // Content stays a Buffer end to end: a symlink target's point can be bytes
      // that no string round-trips, and Buffer.from(string) would substitute them.
      const oid = gitRaw(sibling, ['hash-object', '-w', '--stdin'], e.content).toString('utf8').trim();
      git(sibling, 'update-index', '--add', '--cacheinfo', `${e.mode},${oid},${e.relPath}`);
   }
   const tree = git(sibling, 'write-tree');
   const pin = git(
      sibling,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit-tree',
      tree,
      '-m',
      'authored',
   );
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].pin = pin;
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   return pin;
}

test('mounts: a pinned manifest missing a schema-required field is unavailable', async () => {
   // `categories` is schema-required and the closure never dereferences an absent
   // one, so no shape guard could see this: the ad-hoc checks passed a manifest no
   // `leji validate` would accept, and the projection published it.
   const manifest = siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' });
   delete manifest.categories;
   const { host, pin } = customSibling(manifest, { 'docs/boot-profile.md': '# Boot\n' });
   const { outcome } = hydrateOne(host, pin);
   assert.deepEqual(
      [outcome.status, outcome.detail],
      ['unavailable', 'the pinned leji.json does not validate against the manifest schema'],
   );
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 0);
   assert.deepEqual(
      JSON.parse(cli.stdout).findings.map((f: { rule: string; severity: string }) => [f.rule, f.severity]),
      [['mount-projection-failed', 'warning']],
   );
});

test('mounts: a pinned index that fails its schema is unavailable', async () => {
   // Entries carrying a path and nothing else drove the content closure: `id`,
   // `title` and `category` are schema-required on each entry, and the header the
   // schema requires was not checked at all.
   const { host, pin } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      {
         ...SIBLING_INDEX_FILES,
         'docs/boot-profile.md': '# Boot\n',
         'docs/context-index.json': JSON.stringify({ entries: [{ path: 'docs/domain/overview.md' }] }, null, 2) + '\n',
         'docs/domain/overview.md': '# Overview\n',
      },
   );
   const { outcome } = hydrateOne(host, pin);
   assert.deepEqual(
      [outcome.status, outcome.detail],
      ['unavailable', 'the pinned context index does not validate against the index schema'],
   );
   const cli = await runCli(['mounts', 'hydrate', '--json', '--root', host]);
   assert.equal(cli.code, 0);
   assert.deepEqual(
      JSON.parse(cli.stdout).findings.map((f: { rule: string }) => f.rule),
      ['mount-projection-failed'],
   );
});

test('mounts: a pinned changelog that fails its schema is unavailable', () => {
   const { host, pin } = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      {
         ...SIBLING_INDEX_FILES,
         'docs/boot-profile.md': '# Boot\n',
         // A born-empty changelog: valid JSON, invalid against its schema (minItems 1).
         'docs/context-changelog.json': '{"schemaVersion": "1.0", "entries": []}\n',
      },
   );
   assert.deepEqual(
      [hydrateOne(host, pin).outcome.status, hydrateOne(host, pin).outcome.detail],
      ['unavailable', 'the pinned context changelog does not validate against the changelog schema'],
   );
});

test('mounts: the closure walks categories in document order, not sorted order', () => {
   // Declaration order decides which defect is reached first, and these two carry
   // different classes: sorted traversal reaches `domain` (availability, exit 0),
   // the document reaches `system` (safety, exit 1). Go sorted and the other two did
   // not, so one pinned tree exited 0 under two SDKs and 1 under the third.
   const { host, pin } = customSibling(
      siblingManifest({
         rootPath: 'docs/',
         bootProfilePath: 'docs/boot-profile.md',
         categories: {
            system: { indexes: ['../escape.md'] },
            domain: { indexes: ['docs/index/missing.md'] },
         },
      }),
      { 'docs/boot-profile.md': '# Boot\n' },
   );
   const { outcome } = hydrateOne(host, pin);
   assert.deepEqual([outcome.status, outcome.detail], ['error', 'uncontained categories.system index: ../escape.md']);
});

test('mounts: the projection path limit is measured in UTF-8 bytes', () => {
   // One constant, one unit. `p.length` here counts UTF-16 code units, Python counts
   // code points and Go counts bytes, so a path of astral characters crossed the
   // same declared 4096 limit at three different lengths. Declared paths reach the
   // check without ever being written, which is the only way to test a length no
   // filesystem accepts.
   const astral = '\u{1F600}'; // 1 code point, 2 UTF-16 code units, 4 UTF-8 bytes
   const at = (repeats: number): string => `docs/${astral.repeat(repeats)}.md`;
   const near = customSibling(siblingManifest({ rootPath: 'docs/', bootProfilePath: at(1000) }), {
      ...SIBLING_INDEX_FILES,
   });
   // 4,008 bytes: inside the limit, so the path is contained and merely absent.
   assert.deepEqual(
      [hydrateOne(near.host, near.pin).outcome.status, hydrateOne(near.host, near.pin).outcome.detail],
      ['unavailable', `closure-critical path missing at the pin: bootProfilePath ${at(1000)}`],
   );
   // 4,408 bytes: over the limit in bytes, and only in bytes.
   const over = customSibling(siblingManifest({ rootPath: 'docs/', bootProfilePath: at(1100) }), {
      ...SIBLING_INDEX_FILES,
   });
   assert.deepEqual(
      [hydrateOne(over.host, over.pin).outcome.status, hydrateOne(over.host, over.pin).outcome.detail],
      ['error', `uncontained bootProfilePath: ${at(1100)}`],
   );
});

test('mounts: an ordinary directory symlink is inside the projection, not an escape', () => {
   // `ln -s sub/ link` resolves to `docs/sub/`, which is no projected path and no
   // declared prefix, so the trailing slash alone refused a conforming sibling under
   // Node and Python while Go, whose path.Join Cleans it away, hydrated it.
   const { host, pin, projection } = (() => {
      const built = customSibling(
         siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
         { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n', 'docs/sub/page.md': '# Page\n' },
         { 'docs/link': 'sub/' },
      );
      const one = hydrateOne(built.host, built.pin);
      return { ...built, ...one };
   })();
   void pin;
   assert.equal(fs.readlinkSync(path.join(projection, 'docs', 'link')), 'sub/', 'the target travels verbatim');
   void host;
   // The containment guard itself is unchanged: an escaping target carrying the same
   // trailing slash is still refused.
   const escaping = customSibling(
      siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
      { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' },
      { 'docs/link': '../../etc/' },
   );
   const bad = hydrateOne(escaping.host, escaping.pin).outcome;
   assert.deepEqual([bad.status, bad.detail], ['error', 'symlink docs/link escapes the projection']);
});

test('mounts: an empty or undecodable symlink target is refused, not decoded three ways', () => {
   const build = (content: Buffer, detail: string) => {
      const { host, sibling } = customSibling(
         siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
         { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n', 'docs/sub/page.md': '# Page\n' },
      );
      const pin = pinWithEntries(host, sibling, [{ mode: '120000', content, relPath: 'docs/link' }]);
      const { outcome } = hydrateOne(host, pin);
      assert.deepEqual([outcome.status, outcome.detail], ['error', detail], content.toString('hex'));
   };
   // Zero bytes: no `ln -s` produces it, the system call that would materialize it
   // fails, and resolving it read as the containing directory in Python and as the
   // entry itself in Node and Go.
   build(Buffer.alloc(0), 'symlink target is empty in docs/link');
   // Not valid UTF-8: Node and Python substituted U+FFFD and wrote different bytes
   // than Go, under the same cache key.
   build(
      Buffer.concat([Buffer.from('sub/', 'utf8'), Buffer.from([0xff])]),
      'symlink target is not valid UTF-8 in docs/link',
   );
});

test('mounts: case-collision detection folds ASCII only, identically everywhere', () => {
   const build = (names: string[]) => {
      const { host, sibling } = customSibling(
         siblingManifest({ rootPath: 'docs/', bootProfilePath: 'docs/boot-profile.md' }),
         { ...SIBLING_INDEX_FILES, 'docs/boot-profile.md': '# Boot\n' },
      );
      const pin = pinWithEntries(
         host,
         sibling,
         names.map((relPath) => ({ mode: '100644', content: Buffer.from(`# ${relPath}\n`, 'utf8'), relPath })),
      );
      return hydrateOne(host, pin).outcome;
   };
   // ASCII still collides: this is what the guard is for.
   const ascii = build(['docs/Page.md', 'docs/page.md']);
   assert.equal(ascii.status, 'error');
   assert.match(ascii.detail!, /^case collision in the pinned tree: docs\/[Pp]age\.md$/);
   // Non-ASCII does not, in any SDK. The cost is real and deliberate: a
   // case-insensitive filesystem may still fold these together. A shared Unicode
   // table was rejected because table versions differ across runtimes, and three
   // runtime-specific lowercase mappings are not a contract at all.
   assert.equal(build(['docs/Ä.md', 'docs/ä.md']).status, 'hydrated');
});

test('mounts: a malformed source or trackingRef is a manifest error, not degraded availability', () => {
   // distribution.md calls a malformed `source` or `pin` a manifest error. Ordinary
   // validation turned an unnormalizable source into `mount-unavailable`, a warning
   // that reads as "not hydrated here"; the schema's tracking-ref pattern accepted
   // anything under refs/heads/ or refs/tags/, including refs the resolver refuses.
   const withMount = (patch: Record<string, unknown>): Finding[] => {
      const { host } = mountedPair();
      const mp = path.join(host, 'leji.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      Object.assign(m.federation.mounts[0], patch);
      fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
      return validateLayer(host).findings;
   };
   const badSource = withMount({ source: 'file:///srv/product-context' });
   assert.ok(
      badSource.some((f) => f.rule === 'mount-source' && f.severity === 'error'),
      JSON.stringify(badSource),
   );
   // Availability is not reported for a mount whose declaration is already a lie.
   assert.ok(!badSource.some((f) => f.rule === 'mount-unavailable'));
   // Schema-legal (refs/heads/ + something), resolver-illegal (`..` and `@{`).
   for (const ref of ['refs/heads/../evil', 'refs/heads/main@{1}', 'refs/heads/main.lock']) {
      assert.ok(
         withMount({ trackingRef: ref }).some((f) => f.rule === 'mount-tracking-ref' && f.severity === 'error'),
         ref,
      );
   }
   assert.ok(!withMount({ trackingRef: 'refs/tags/v1.0.0' }).some((f) => f.rule === 'mount-tracking-ref'));
});

test('mounts: conformance sibling-mounts tests the normalized source it claims to', () => {
   // The item said "a normalized source and a full commit pin" and tested that the
   // source was a nonempty string: a `file://` locator no resolver can normalize
   // passed the federated checklist.
   const { host } = mountedPair();
   const mp = path.join(host, 'leji.json');
   const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
   m.federation.mounts[0].source = 'file:///srv/product-context';
   fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\n');
   const item = conformanceReport(host).items.find((i) => i.id === 'sibling-mounts');
   assert.equal(item?.status, 'fail');
   assert.equal(item?.detail, 'mount "acme-product-context" declares a source that is not a normalizable locator');
});

test('mounts: conformance reports all four mount items as n/a when none are declared', () => {
   // Two of the four used to be dropped, so the checklist read as though pin
   // reachability and routing metadata had simply not been considered. `n/a` is not
   // scored either way, so this changes the report, not the level.
   const root = tmpdir('leji-nomounts-');
   fs.cpSync(path.join(repoRoot, 'fixtures', 'valid-minimal-core'), root, { recursive: true });
   const federated = conformanceReport(root).items.filter((i) => i.level === 'federated');
   assert.deepEqual(
      federated.map((i) => [i.id, i.status]),
      [
         ['consumed-externally', 'manual'],
         ['stale-pin-reporting', 'manual'],
         ['sibling-mounts', 'not-applicable'],
         ['pin-reachable', 'not-applicable'],
         ['mount-routing', 'not-applicable'],
         ['mount-discovery', 'not-applicable'],
      ],
   );
});
