import { strict as assert } from 'node:assert';
import { execFile, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadManifest, replaceMountPinInManifestText, run, updatePinRun } from '../dist/index.js';
import {
   comparePins,
   mountStatus,
   normalizeSource,
   pinRefFor,
   retainPinInStore,
   selectComparison,
   witnessRefFor,
} from '../dist/lib/mounts.js';

// Three halves of one contract. First the pin-span scanner over its own byte
// fixtures — the only artifact here that needs no git at all. Then the two
// factorings out of `lib/mounts.ts`, checked against the callers they were taken
// from. Then the shared fixtures' `updatePin` block, driven through the real CLI as
// a process over a scaffold every SDK's harness builds identically
// (`fixtures/README.md` -> "The `updatePin` block").

const execFileAsync = promisify(execFile);
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const cli = path.join(pkgRoot, 'dist', 'cli.js');

const tmpdir = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

// --- the pin-span scanner -----------------------------------------------------

interface PinSpanCase {
   note: string;
   mount: string;
   from: string;
   to: string;
   outcome: 'replaced' | 'error';
   error?: 'not-located' | 'not-from' | 'duplicate-key';
}

const pinSpanDir = path.join(fixturesDir, 'manifest-pin-span');
for (const name of fs.readdirSync(pinSpanDir).sort()) {
   const dir = path.join(pinSpanDir, name);
   if (!fs.statSync(dir).isDirectory()) continue;
   const spec = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')) as PinSpanCase;

   test(`manifest-pin-span ${name}: ${spec.note}`, () => {
      const input = fs.readFileSync(path.join(dir, 'input.json'), 'utf8');
      if (spec.outcome === 'error') {
         const pattern =
            spec.error === 'not-located'
               ? /cannot locate the pin of mount/
               : spec.error === 'not-from'
                 ? /pin of mount .* is not/
                 : /duplicate key/;
         assert.throws(
            () => replaceMountPinInManifestText(input, spec.mount, spec.from, spec.to),
            (e: Error) => pattern.test(e.message),
            `${name}: the ${spec.error} refusal`,
         );
         return;
      }
      const expected = fs.readFileSync(path.join(dir, 'expected.json'), 'utf8');
      const got = replaceMountPinInManifestText(input, spec.mount, spec.from, spec.to);
      assert.equal(got.changed, true, `${name}: the span moved`);
      assert.equal(got.text, expected, `${name}: byte-exact output`);
      // Every case is a real manifest before and after: the edit never produces
      // something a parser would reject.
      assert.doesNotThrow(() => JSON.parse(got.text));
      // And the edit is confined: exactly the pin's own characters differ.
      assert.equal(got.text.length, input.length + spec.to.length - spec.from.length);
   });
}

test('a duplicate key on the path to the pin is refused, never resolved by picking one', () => {
   // The two readers of this document disagree: a lexical scan takes the FIRST
   // member, `JSON.parse` keeps the LAST. Rewriting the first span would report a
   // change that every parser of the result still reads as the old pin.
   const dir = path.join(pinSpanDir, 'error-duplicate-pin');
   const input = fs.readFileSync(path.join(dir, 'input.json'), 'utf8');
   const spec = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')) as PinSpanCase;
   const parsedPin = (JSON.parse(input) as { federation: { mounts: { pin: string }[] } }).federation.mounts[0].pin;
   assert.notEqual(parsedPin, spec.from, 'the parser reads the LAST pin, which is not the span a scan finds first');
   assert.throws(
      () => replaceMountPinInManifestText(input, spec.mount, spec.from, spec.to),
      /duplicate key "pin" in mount "product-context"/,
   );
   // Every key the scanner reads on its way to the pin carries the same rule.
   for (const [fixture, message] of [
      ['error-duplicate-federation', /duplicate key "federation" in the manifest root/],
      ['error-duplicate-mounts', /duplicate key "mounts" in "federation"/],
      ['error-duplicate-name', /duplicate key "name" in a federation mount/],
   ] as const) {
      const text = fs.readFileSync(path.join(pinSpanDir, fixture, 'input.json'), 'utf8');
      assert.throws(() => replaceMountPinInManifestText(text, 'product-context', spec.from, spec.to), message, fixture);
   }
});

test('the pin span moves only for the addressed mount, and a no-op move writes nothing new', () => {
   const input = fs.readFileSync(path.join(pinSpanDir, 'shared-prefix', 'input.json'), 'utf8');
   const spec = JSON.parse(fs.readFileSync(path.join(pinSpanDir, 'shared-prefix', 'case.json'), 'utf8')) as PinSpanCase;
   // The neighbouring mount's pin is untouched by the move above it.
   const moved = replaceMountPinInManifestText(input, spec.mount, spec.from, spec.to).text;
   const before = JSON.parse(input) as { federation: { mounts: { name: string; pin: string }[] } };
   const after = JSON.parse(moved) as typeof before;
   assert.equal(after.federation.mounts[0].pin, before.federation.mounts[0].pin);
   assert.notEqual(after.federation.mounts[1].pin, before.federation.mounts[1].pin);
   // `from === to` is a no-op the caller can rely on, not a rewrite of equal bytes.
   const same = replaceMountPinInManifestText(input, spec.mount, spec.from, spec.from);
   assert.equal(same.changed, false);
   assert.equal(same.text, input);
});

// --- the acme-sibling scaffold ------------------------------------------------

/** The recipe's fixed commit ids. Every field a commit hashes is pinned by the
 * recipe (`fixtures/README.md`), so these are constants, not observations. */
const OID = {
   a: '6b06fe51a323212156bb267842bf10187ed4c20e',
   b: '3ff2a04361ca9d601180037bdfbc8b6c0a0a8723',
   s: '50305153f1a107c6871ab3b3047cb4c225603b0c',
   o: '0cb1fb59e73d78ff04cf41de7f177ea0fb940002',
};
const ACME_SOURCE = 'https://github.com/acme/product-context';
const ACME_IDENTITY = normalizeSource(ACME_SOURCE)!;

/** Author, committer, date, message and content are all fixed, so every commit id
 * the recipe produces is a constant an `expected.json` can carry. */
const recipeEnv: NodeJS.ProcessEnv = {
   ...process.env,
   GIT_DIR: undefined,
   GIT_AUTHOR_NAME: 'Leji Fixtures',
   GIT_AUTHOR_EMAIL: 'fixtures@leji.org',
   GIT_COMMITTER_NAME: 'Leji Fixtures',
   GIT_COMMITTER_EMAIL: 'fixtures@leji.org',
   GIT_AUTHOR_DATE: '2026-01-01T00:00:00 +0000',
   GIT_COMMITTER_DATE: '2026-01-01T00:00:00 +0000',
};

function git(cwd: string, ...args: string[]): string {
   return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd,
      env: recipeEnv,
      encoding: 'utf8',
   }).trim();
}

function commit(repo: string, file: string): string {
   fs.writeFileSync(path.join(repo, file), `# ${file.replace(/\.md$/, '')}\n`);
   git(repo, 'add', '-A');
   git(repo, 'commit', '-q', '-m', file.replace(/\.md$/, ''));
   return git(repo, 'rev-parse', 'HEAD');
}

/** The `acme-sibling` recipe, normative in `fixtures/README.md`: a → b on main, a
 * side branch off `a`, and an unrelated orphan branch. */
function buildAcmeSibling(dir: string): void {
   fs.mkdirSync(dir, { recursive: true });
   git(dir, 'init', '-q', '-b', 'main', '.');
   assert.equal(commit(dir, 'a.md'), OID.a, 'recipe commit a');
   assert.equal(commit(dir, 'b.md'), OID.b, 'recipe commit b');
   git(dir, 'checkout', '-q', '-b', 'side', OID.a);
   assert.equal(commit(dir, 's.md'), OID.s, 'recipe commit s');
   git(dir, 'checkout', '-q', '--orphan', 'other');
   git(dir, 'rm', '-q', '-rf', '.');
   assert.equal(commit(dir, 'o.md'), OID.o, 'recipe commit o');
   git(dir, 'checkout', '-q', 'main');
   // Fetching a commit by id is how the resolver retains a pin, so the recipe's
   // repository must serve one the way a real host does.
   git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
}

interface StoreSpec {
   pin: string | null;
   witnessRef: string | null;
   witnessOid: string | null;
   depth: number | null;
}

/** Build the managed store exactly as a successful `--fetch` leaves it. */
function buildStore(host: string, sibling: string, spec: StoreSpec): void {
   const key = crypto.createHash('sha256').update(ACME_IDENTITY).digest('hex');
   const store = path.join(host, '.leji', 'mounts', 'store', key);
   fs.mkdirSync(store, { recursive: true });
   git(host, 'init', '--bare', '-q', store);
   const depth = spec.depth === null ? [] : ['--depth', String(spec.depth)];
   if (spec.pin !== null) {
      git(store, 'fetch', '-q', ...depth, sibling, spec.pin);
      git(store, 'update-ref', pinRefFor(ACME_IDENTITY, spec.pin), spec.pin);
   }
   if (spec.witnessRef !== null && spec.witnessOid !== null) {
      git(
         store,
         'fetch',
         '-q',
         ...depth,
         sibling,
         `+${spec.witnessOid}:${witnessRefFor(ACME_IDENTITY, spec.witnessRef)}`,
      );
   }
   fs.rmSync(path.join(store, 'FETCH_HEAD'), { force: true });
}

// --- the two factorings, against the callers they came out of -----------------

test('selectComparison and comparePins answer exactly what mountStatus reports', () => {
   const dir = tmpdir('leji-updatepin-sel-');
   const sibling = path.join(dir, 'sibling');
   const host = path.join(dir, 'host');
   buildAcmeSibling(sibling);
   for (const [pin, expected] of [
      [OID.a, 'behind'],
      [OID.b, 'up-to-date'],
      [OID.s, 'diverged'],
      [OID.o, 'unrelated'],
   ] as const) {
      fs.rmSync(host, { recursive: true, force: true });
      fs.cpSync(path.join(fixturesDir, 'warn-update-pin'), host, { recursive: true });
      repin(host, pin, 'keep');
      buildStore(host, sibling, { pin, witnessRef: 'refs/heads/main', witnessOid: OID.b, depth: null });
      const { manifest } = loadManifest(host);
      const row = mountStatus(host, manifest!, {})[0];
      assert.equal(row.pinReport.state, expected, `status says ${expected}`);
      const selection = selectComparison(
         host,
         { name: 'product-context', source: ACME_SOURCE, pin, trackingRef: 'refs/heads/main' },
         'refs/heads/main',
      );
      assert.ok(!('reason' in selection), 'the matrix selected a repository');
      if ('reason' in selection) return;
      // The helper reports the same repository, provenance and ref status does…
      assert.equal(selection.comparisonRepository, row.pinReport.comparisonRepository);
      assert.equal(selection.witnessProvenance, row.pinReport.witnessProvenance);
      assert.equal(selection.comparedRef, row.pinReport.comparedRef);
      assert.equal(selection.tipOid, OID.b, 'the single witness snapshot');
      // …and comparing against that one snapshot reproduces the report exactly.
      const cmp = comparePins(selection.repo, pin, selection.tipOid);
      assert.ok(!('reason' in cmp));
      if ('reason' in cmp) return;
      assert.equal(cmp.state, row.pinReport.state);
      assert.equal(cmp.behind, row.pinReport.behind);
      assert.equal(cmp.ahead, row.pinReport.ahead);
      assert.equal(cmp.ancestryComplete, row.pinReport.ancestryComplete);
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

test('selectComparison reports every degraded reason status reports, without selecting', () => {
   const dir = tmpdir('leji-updatepin-degraded-');
   const mount = { name: 'product-context', source: ACME_SOURCE, pin: OID.a, trackingRef: 'refs/heads/main' };
   // Nothing holds the pin.
   assert.deepEqual(selectComparison(dir, mount, 'refs/heads/main'), { reason: 'mount-pin-unavailable' });
   // A locator no resolver can normalize, and a ref the resolver refuses.
   assert.deepEqual(selectComparison(dir, { ...mount, source: 'file:///srv/x' }, 'refs/heads/main'), {
      reason: 'mount-source-unnormalizable',
   });
   assert.deepEqual(selectComparison(dir, mount, 'refs/heads/main@{1}'), { reason: 'mount-tracking-ref-invalid' });
   fs.rmSync(dir, { recursive: true, force: true });
});

test('retainPinInStore establishes the store and retains one commit, without touching the witness', () => {
   const dir = tmpdir('leji-updatepin-retain-');
   const sibling = path.join(dir, 'sibling');
   const host = path.join(dir, 'host');
   buildAcmeSibling(sibling);
   fs.mkdirSync(host);
   const mount = { name: 'product-context', source: sibling, pin: OID.a, trackingRef: 'refs/heads/main' };
   const first = retainPinInStore(host, mount, ACME_IDENTITY, OID.a);
   assert.notEqual(first.repo, null, first.error);
   assert.equal(git(first.repo!, 'rev-parse', pinRefFor(ACME_IDENTITY, OID.a)), OID.a);
   // The witness namespace belongs to the refresh, which this primitive is not.
   assert.equal(git(first.repo!, 'for-each-ref', '--format=%(refname)', 'refs/leji-witness'), '');
   // A second commit is retained beside the first, not instead of it.
   const second = retainPinInStore(host, mount, ACME_IDENTITY, OID.b);
   assert.notEqual(second.repo, null, second.error);
   assert.equal(git(second.repo!, 'rev-parse', pinRefFor(ACME_IDENTITY, OID.a)), OID.a);
   assert.equal(git(second.repo!, 'rev-parse', pinRefFor(ACME_IDENTITY, OID.b)), OID.b);
   // A source that serves nothing is a stated failure, never a partial success.
   const gone = retainPinInStore(host, { ...mount, source: path.join(dir, 'gone') }, ACME_IDENTITY, OID.s);
   assert.equal(gone.repo, null);
   assert.equal(gone.error, 'the pin could not be fetched from the source');
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- the shared fixtures' `updatePin` block -----------------------------------

interface UpdatePinCase {
   id: string;
   note: string;
   pin: string;
   trackingRef?: string | null;
   store: StoreSpec | null;
   hint: boolean;
   source: 'none' | 'local' | 'unreachable';
   args: string[];
   exit: number;
   action: string | null;
   from: string | null;
   to: string | null;
   reason: string | null;
   override: boolean;
   comparisonRepository?: string;
   comparedRef?: string;
   manifestGolden: string | null;
   written: boolean;
}

interface UpdatePinBlock {
   sibling: string;
   mount: string;
   cases: UpdatePinCase[];
}

/** Apply a case's declaration rewrite: the pin it starts from, and whether the
 * tracking ref is declared at all. A raw-text splice, as the fixture's own contract
 * requires — the harness never reserializes a manifest either. */
function repin(host: string, pin: string, trackingRef: string | null | 'keep'): void {
   const mp = path.join(host, 'leji.json');
   let text = fs.readFileSync(mp, 'utf8');
   text = text.replace(/("pin": ")[0-9a-f]{40}(")/, `$1${pin}$2`);
   if (trackingRef === null) text = text.replace(/\s*"trackingRef": "[^"]*",\n/, '\n');
   fs.writeFileSync(mp, text);
}

interface CliResult {
   code: number;
   stdout: string;
}

async function runCliProc(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
   try {
      const { stdout } = await execFileAsync('node', [cli, ...args], { cwd: repoRoot, env });
      return { code: 0, stdout };
   } catch (e) {
      const err = e as { code?: number; stdout?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '' };
   }
}

interface UpdatePinDocument {
   command: string;
   ok: boolean;
   findings: { rule: string; severity: string; path?: string; message: string }[];
   summary: { errors: number; warnings: number };
   mount: {
      name: string;
      sourceIdentity: string | null;
      trackingRef: string | null;
      from: string | null;
      to: string | null;
   };
   pinReport: Record<string, unknown> | null;
   action: string;
   override: boolean;
   reason?: string;
}

/** Exactly the keys `--json` emits, under every outcome that emits a document. */
const DOCUMENT_KEYS = ['command', 'ok', 'findings', 'summary', 'mount', 'pinReport', 'action', 'override'];

for (const name of fs.readdirSync(fixturesDir).sort()) {
   const expectedFile = path.join(fixturesDir, name, 'expected.json');
   if (!fs.existsSync(expectedFile)) continue;
   const block = (JSON.parse(fs.readFileSync(expectedFile, 'utf8')) as { updatePin?: UpdatePinBlock }).updatePin;
   if (!block) continue;

   for (const c of block.cases) {
      test(`fixture ${name}: the updatePin block, ${c.id}`, async () => {
         const dir = tmpdir('leji-updatepin-');
         try {
            const sibling = path.join(dir, 'sibling');
            const host = path.join(dir, 'host');
            buildAcmeSibling(sibling);
            fs.cpSync(path.join(fixturesDir, name), host, { recursive: true });
            repin(host, c.pin, c.trackingRef === undefined ? 'keep' : c.trackingRef);
            if (c.store) buildStore(host, sibling, c.store);
            if (c.hint) {
               fs.mkdirSync(path.join(host, '.leji'), { recursive: true });
               fs.writeFileSync(
                  path.join(host, '.leji', 'mounts.local.json'),
                  JSON.stringify({ mounts: { [block.mount]: { repo: sibling } } }) + '\n',
               );
            }
            // The declared source is a locator no test may actually reach, so it is
            // routed at git's own level: to the recipe repository for a run that
            // must succeed, and to a path that does not exist for one that must fail.
            const routed =
               c.source === 'none' ? null : c.source === 'local' ? sibling : path.join(dir, 'never-created');
            const env: NodeJS.ProcessEnv =
               routed === null
                  ? { ...process.env, GIT_DIR: undefined }
                  : {
                       ...process.env,
                       GIT_DIR: undefined,
                       GIT_CONFIG_COUNT: '1',
                       GIT_CONFIG_KEY_0: `url.${routed}.insteadOf`,
                       GIT_CONFIG_VALUE_0: ACME_SOURCE,
                    };

            const manifestPath = path.join(host, 'leji.json');
            const before = fs.readFileSync(manifestPath);
            const r = await runCliProc([...c.args, '--root', host, '--json'], env);
            assert.equal(r.code, c.exit, `${c.id}: exit code (${r.stdout})`);

            if (c.action === null) {
               // A usage error reports no outcome at all, and touches nothing.
               assert.equal(r.stdout.trim(), '', `${c.id}: no document`);
               assert.deepEqual(fs.readFileSync(manifestPath), before, `${c.id}: nothing written`);
               return;
            }
            const doc = JSON.parse(r.stdout) as UpdatePinDocument;
            const keys = [...DOCUMENT_KEYS, ...(c.reason === null ? [] : ['reason'])].sort();
            assert.deepEqual(Object.keys(doc).sort(), keys, `${c.id}: the exact JSON key set`);
            assert.equal(doc.command, 'mounts update-pin');
            assert.equal(doc.action, c.action, `${c.id}: action`);
            assert.equal(doc.override, c.override, `${c.id}: override`);
            assert.equal(doc.reason ?? null, c.reason, `${c.id}: reason`);
            assert.equal(doc.mount.from, c.from, `${c.id}: from`);
            assert.equal(doc.mount.to, c.to, `${c.id}: to`);
            assert.equal(doc.ok, c.reason === null, `${c.id}: ok tracks the refusal`);
            assert.deepEqual(
               doc.summary,
               { errors: c.reason === null ? 0 : 1, warnings: c.override ? 1 : 0 },
               `${c.id}: the literal summary`,
            );
            // The findings are what the block pins, never read off the document:
            // a refusal names its reason code, an override warns under its own.
            assert.deepEqual(
               doc.findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.path })),
               [
                  ...(c.reason === null ? [] : [{ rule: c.reason, severity: 'error', path: doc.mount.name }]),
                  ...(c.override
                     ? [{ rule: 'mount-pin-non-fast-forward-override', severity: 'warning', path: doc.mount.name }]
                     : []),
               ].sort((a, b) => (a.rule < b.rule ? -1 : 1)),
               `${c.id}: the exact findings`,
            );
            if (c.comparisonRepository !== undefined) {
               assert.equal(
                  doc.pinReport?.comparisonRepository,
                  c.comparisonRepository,
                  `${c.id}: comparisonRepository`,
               );
            }
            if (c.comparedRef !== undefined) {
               assert.equal(doc.pinReport?.comparedRef, c.comparedRef, `${c.id}: comparedRef`);
            }

            const after = fs.readFileSync(manifestPath);
            if (c.manifestGolden !== null) {
               const golden = fs.readFileSync(path.join(fixturesDir, ...c.manifestGolden.split('/')));
               assert.deepEqual(after, golden, `${c.id}: the written manifest bytes`);
            }
            // `written: false` is one claim: the manifest is byte-identical to the
            // manifest this run started from.
            if (!c.written) assert.deepEqual(after, before, `${c.id}: leji.json is byte-untouched`);
            // A `--fetch` run does the store acts it was asked for even when the
            // rewrite is suppressed: dry-run withholds the manifest, not the fetch.
            if (c.id === 'dry-run-fetch') {
               const key = crypto.createHash('sha256').update(ACME_IDENTITY).digest('hex');
               const store = path.join(host, '.leji', 'mounts', 'store', key);
               assert.ok(fs.existsSync(store), 'the managed store was established');
               assert.equal(git(store, 'rev-parse', pinRefFor(ACME_IDENTITY, OID.a)), OID.a, 'the pin was retained');
            }
            // Every fetch this command makes passes --no-write-fetch-head, so a run
            // that reached the source leaves no per-run record inside the store.
            if (c.source === 'local') {
               const key = crypto.createHash('sha256').update(ACME_IDENTITY).digest('hex');
               const store = path.join(host, '.leji', 'mounts', 'store', key);
               assert.equal(fs.existsSync(path.join(store, 'FETCH_HEAD')), false, `${c.id}: no FETCH_HEAD`);
            }
         } finally {
            fs.rmSync(dir, { recursive: true, force: true });
         }
      });
   }
}

// --- the branches no fixture can construct ------------------------------------

test('a declaration that changes under the run is refused, not overwritten', () => {
   const dir = tmpdir('leji-updatepin-race-');
   try {
      const sibling = path.join(dir, 'sibling');
      const host = path.join(dir, 'host');
      buildAcmeSibling(sibling);
      fs.cpSync(path.join(fixturesDir, 'warn-update-pin'), host, { recursive: true });
      repin(host, OID.a, 'keep');
      buildStore(host, sibling, { pin: OID.a, witnessRef: 'refs/heads/main', witnessOid: OID.b, depth: null });
      const { manifest } = loadManifest(host);
      // The comparison runs against the manifest object in hand; the file changes
      // its `source` before the verified read the rewrite makes.
      const mp = path.join(host, 'leji.json');
      const original = fs.readFileSync(mp, 'utf8');
      fs.writeFileSync(mp, original.replace(ACME_SOURCE, 'https://github.com/acme/moved-context'));
      const r = updatePinRun(host, manifest!, { name: 'product-context' });
      assert.equal(r.action, 'refused');
      assert.equal(r.reason, 'mount-declaration-changed');
      assert.equal(fs.readFileSync(mp, 'utf8'), original.replace(ACME_SOURCE, 'https://github.com/acme/moved-context'));
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a target that cannot be retained under --fetch refuses the move, manifest untouched', async () => {
   const dir = tmpdir('leji-updatepin-retain-fail-');
   try {
      const sibling = path.join(dir, 'sibling');
      const host = path.join(dir, 'host');
      buildAcmeSibling(sibling);
      fs.cpSync(path.join(fixturesDir, 'warn-update-pin'), host, { recursive: true });
      repin(host, OID.a, 'keep');
      fs.mkdirSync(path.join(host, '.leji'), { recursive: true });
      fs.writeFileSync(
         path.join(host, '.leji', 'mounts.local.json'),
         JSON.stringify({ mounts: { 'product-context': { repo: sibling } } }) + '\n',
      );
      const before = fs.readFileSync(path.join(host, 'leji.json'));
      // By the time the TARGET is retained the store already holds it, so the fetch
      // never runs and only the ref update can fail: the injection is the branch's
      // one reachable path. It names the TARGET, so retaining the current pin — the
      // act before the gate — still succeeds and the refusal is unambiguous.
      const r = await runCliProc(['mounts', 'update-pin', 'product-context', '--fetch', '--root', host, '--json'], {
         ...process.env,
         GIT_DIR: undefined,
         GIT_CONFIG_COUNT: '1',
         GIT_CONFIG_KEY_0: `url.${sibling}.insteadOf`,
         GIT_CONFIG_VALUE_0: ACME_SOURCE,
         LEJI_TEST_FAIL_PIN_REF: OID.b,
      });
      assert.equal(r.code, 1, r.stdout);
      const doc = JSON.parse(r.stdout) as UpdatePinDocument;
      assert.equal(doc.action, 'refused');
      assert.equal(doc.reason, 'mount-store-fetch-failed');
      assert.equal(doc.mount.to, OID.b, 'the target it declined to retain is still reported');
      assert.deepEqual(
         doc.findings.map((f) => f.rule),
         ['mount-store-fetch-failed'],
      );
      assert.deepEqual(fs.readFileSync(path.join(host, 'leji.json')), before, 'leji.json is byte-untouched');
      // The refusal leaves the CURRENT pin retained: fetched objects and refs stay,
      // which is exactly what the help text says a failed --fetch may leave behind.
      const key = crypto.createHash('sha256').update(ACME_IDENTITY).digest('hex');
      const store = path.join(host, '.leji', 'mounts', 'store', key);
      assert.equal(git(store, 'rev-parse', pinRefFor(ACME_IDENTITY, OID.a)), OID.a);
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

test('a target the manifest no longer pins from is refused by the scanner, at exit 2', async () => {
   const dir = tmpdir('leji-updatepin-span-');
   try {
      const sibling = path.join(dir, 'sibling');
      const host = path.join(dir, 'host');
      buildAcmeSibling(sibling);
      fs.cpSync(path.join(fixturesDir, 'warn-update-pin'), host, { recursive: true });
      repin(host, OID.a, 'keep');
      buildStore(host, sibling, { pin: OID.a, witnessRef: 'refs/heads/main', witnessOid: OID.b, depth: null });
      const { manifest } = loadManifest(host);
      // The mount is renamed on disk after the comparison: the declaration check
      // fires first, so the scanner's own refusal needs the name to still match
      // while the pin does not.
      const mp = path.join(host, 'leji.json');
      assert.throws(
         () => replaceMountPinInManifestText(fs.readFileSync(mp, 'utf8'), 'product-context', OID.s, OID.b),
         /pin of mount "product-context" is not/,
      );
      // And the same refusal reaches the CLI as exit 2 with no document at all.
      const r = await runCliProc(
         ['mounts', 'update-pin', 'product-context', '--to', 'z'.repeat(40), '--root', host, '--json'],
         { ...process.env, GIT_DIR: undefined },
      );
      assert.equal(r.code, 2, 'a malformed --to never reaches the scanner');
      assert.equal(r.stdout.trim(), '');
      assert.ok(manifest);
   } finally {
      fs.rmSync(dir, { recursive: true, force: true });
   }
});

// --- the CLI surface ----------------------------------------------------------

async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
   const log = console.log;
   const err = console.error;
   console.log = () => {};
   console.error = () => {};
   try {
      return await fn();
   } finally {
      console.log = log;
      console.error = err;
   }
}

test('run: the mounts sub-guard accepts update-pin and still rejects everything else', async () => {
   const dir = tmpdir('leji-updatepin-cli-');
   fs.cpSync(path.join(fixturesDir, 'warn-update-pin'), dir, { recursive: true });
   // Accepted spellings reach their command (never the sub-guard's exit 2)…
   for (const sub of ['hydrate', 'status', 'locate', 'update-pin']) {
      const argv = [
         'mounts',
         sub,
         ...(sub === 'locate' || sub === 'update-pin' ? ['product-context'] : []),
         '--root',
         dir,
      ];
      assert.notEqual(await quiet(() => run(argv)), 2, argv.join(' '));
   }
   // …and every other spelling, including a bare `mounts`, is the guard.
   for (const sub of [[], ['nope'], ['update'], ['updatepin'], ['update-pins'], ['Update-Pin']]) {
      assert.equal(await quiet(() => run(['mounts', ...sub, '--root', dir])), 2, `mounts ${sub.join(' ')}`);
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

test('run: update-pin takes exactly one positional, and only its declared flags', async () => {
   const dir = tmpdir('leji-updatepin-flags-');
   fs.cpSync(path.join(fixturesDir, 'warn-update-pin'), dir, { recursive: true });
   // The positional budget gains this command's one name, as `mounts locate` has.
   assert.notEqual(await quiet(() => run(['mounts', 'update-pin', 'product-context', '--root', dir])), 2);
   assert.equal(await quiet(() => run(['mounts', 'update-pin', 'product-context', 'surplus', '--root', dir])), 2);
   assert.equal(await quiet(() => run(['mounts', 'update-pin', '--root', dir])), 2, 'the name is required');
   // Flags declared on this command are accepted; a flag declared elsewhere is not,
   // and neither is a destination parameter, which this command has none of.
   assert.notEqual(
      await quiet(() => run(['mounts', 'update-pin', 'product-context', '--dry-run', '--fetch', '--root', dir])),
      2,
   );
   for (const argv of [
      ['mounts', 'update-pin', 'product-context', '--check-integrity'],
      ['mounts', 'update-pin', 'product-context', '--strict'],
      ['mounts', 'update-pin', 'product-context', '--endpoint', 'x'],
      ['mounts', 'status', '--to', OID.b],
      ['mounts', 'status', '--allow-non-fast-forward'],
   ]) {
      assert.equal(await quiet(() => run([...argv, '--root', dir])), 2, argv.join(' '));
   }
   // `--to` takes a full lowercase hex commit id in either spelling, and nothing else.
   assert.notEqual(
      await quiet(() => run(['mounts', 'update-pin', 'product-context', `--to=${OID.b}`, '--root', dir])),
      2,
   );
   assert.notEqual(
      await quiet(() => run(['mounts', 'update-pin', 'product-context', '--to', '0'.repeat(64), '--root', dir])),
      2,
   );
   for (const bad of ['xyz', OID.b.slice(0, 12), OID.b.toUpperCase(), '0'.repeat(41), '0'.repeat(63), '']) {
      assert.equal(
         await quiet(() => run(['mounts', 'update-pin', 'product-context', '--to', bad, '--root', dir])),
         2,
         `--to ${bad}`,
      );
   }
   assert.equal(
      await quiet(() => run(['mounts', 'update-pin', 'product-context', '--to', '--json', '--root', dir])),
      2,
   );
   // The override is meaningless without a named target, and says so.
   assert.equal(
      await quiet(() => run(['mounts', 'update-pin', 'product-context', '--allow-non-fast-forward', '--root', dir])),
      2,
   );
   fs.rmSync(dir, { recursive: true, force: true });
});

test('run: `mounts update-pin --help` exits 0 and names no network destination', async () => {
   const lines: string[] = [];
   const log = console.log;
   console.log = (...a: unknown[]) => {
      lines.push(a.join(' '));
   };
   try {
      assert.equal(await run(['mounts', 'update-pin', '--help']), 0);
   } finally {
      console.log = log;
   }
   const help = lines.join('\n');
   assert.match(help, /leji mounts update-pin/);
   // The only network vocabulary this command may carry is what `mounts hydrate`
   // already documents: the declared source, and nothing addressable by the caller.
   for (const banned of ['endpoint', 'token', 'upload', 'registry', 'api.', 'http://', 'account']) {
      assert.ok(!help.toLowerCase().includes(banned), `help must not mention "${banned}"`);
   }
});
