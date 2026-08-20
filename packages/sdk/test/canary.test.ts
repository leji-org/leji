import { strict as assert } from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as Module from 'node:module';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildViewer, generateViewer, loadManifest, serveViewer } from '../dist/index.js';

// The trust-domain boundary, driven from the shared fixtures: nothing under `.leji/`
// except `viewer/` is servable, and no export carries a byte of it. The fixtures own
// the request corpus (`trustCanary`) and the layout claims (`export.layout`), so all
// three SDKs answer identical requests against identical bytes.
//
// Scope: the four F8 layout fixtures — their layout roles, their golden export
// bytes, and their canary corpus. The general `export`-block harness (findings,
// `--strict` variants) takes every other fixture.
const LAYOUT_FIXTURES = [
   'valid-unified-leji-fresh',
   'valid-unified-leji-stale-tree',
   'valid-trust-canary-nested-root',
   'valid-trust-canary-dot-root',
];

/** The planted byte string. Spelled in each harness and deliberately in no
 * `expected.json`: under `rootPath: "."` a fixture's own metadata is exported like
 * any other file, so a token literal there would count as a leak. */
const TOKEN = 'LEJI-TRUST-CANARY';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');

interface Seed {
   from: string;
   to: string;
}

interface ExpectedExport {
   exit: number;
   out: string;
   layout?: {
      roles?: Record<string, string>;
      present?: string[];
      absent?: string[];
      preserved?: string[];
   };
   rerun?: { byteIdentical?: boolean };
   goldenTree: { status: 'pending' | 'baked' | 'none'; contentDir?: string; manifest?: string };
}

interface ExpectedCanary {
   topology: 'nested' | 'dot-root';
   plantedPaths: string[];
   serve: {
      requests: { path: string; status: number; note?: string }[];
      routeScan?: { assertNoTokenIn200Bodies?: boolean };
   };
   exportScan: { root: string; occurrences: number };
}

/** A fixture-declared path, as the README fixes it: repository-root-relative POSIX,
 * normalized, no `..` segment, never absolute. A violation is a harness error —
 * the fixture is the contract, so a malformed one fails loudly rather than being
 * repaired here. */
function fixtureRel(value: string, what: string): string {
   assert.ok(!path.posix.isAbsolute(value), `${what} must be relative: ${value}`);
   const normalized = path.posix.normalize(value).replace(/\/+$/, '');
   assert.equal(normalized, value.replace(/\/+$/, ''), `${what} must be normalized: ${value}`);
   assert.ok(!normalized.split('/').includes('..'), `${what} must not escape the fixture: ${value}`);
   return normalized;
}

/** Copy a committed seed's CONTENTS into `to`, which the harness creates. Regular
 * files and directories only: a symlink anywhere inside a seed is a harness error,
 * and no seed file is ever executed, so modes stay the platform's default. */
function copySeed(from: string, to: string): void {
   fs.mkdirSync(to, { recursive: true });
   for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), `seed carries a symlink: ${path.join(from, entry.name)}`);
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) {
         assert.ok(
            entry.name !== '.leji' && entry.name !== 'dist',
            `seed path component "${entry.name}" is gitignored at any depth; spell it under the seed name`,
         );
         copySeed(src, dest);
      } else {
         assert.ok(entry.isFile(), `seed carries a non-regular file: ${src}`);
         fs.copyFileSync(src, dest);
      }
   }
}

/** A pristine working copy of the fixture with every declared seed materialized. */
function materialize(name: string, seeds: Seed[]): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-canary-'));
   fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
   const targets: string[] = [];
   for (const seed of seeds) {
      const from = fixtureRel(seed.from, 'seed.from');
      const to = fixtureRel(seed.to, 'seed.to');
      const toAbs = path.join(dir, ...to.split('/'));
      // A pre-existing target means the working copy is not what the harness thinks
      // it is; overlapping targets are a fixture-authoring error, not something to
      // resolve by ordering.
      assert.ok(!fs.existsSync(toAbs), `seed target already exists: ${to}`);
      for (const other of targets) {
         assert.ok(to !== other && !to.startsWith(other + '/'), `seed targets overlap: ${to} and ${other}`);
      }
      targets.push(to);
      copySeed(path.join(dir, ...from.split('/')), toAbs);
   }
   return dir;
}

/** Every path under `dir` as `rel -> content digest` (directories as `rel/` -> ''),
 * so a comparison covers appearance and disappearance as well as content. */
function snapshot(dir: string, rel = '', acc = new Map<string, string>()): Map<string, string> {
   const abs = rel === '' ? dir : path.join(dir, rel);
   for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
         acc.set(childRel + '/', '');
         snapshot(dir, childRel, acc);
      } else if (entry.isFile()) {
         acc.set(
            childRel,
            crypto
               .createHash('sha256')
               .update(fs.readFileSync(path.join(dir, childRel)))
               .digest('hex'),
         );
      } else {
         acc.set(childRel, 'non-regular');
      }
   }
   return acc;
}

/** Files only, as export-root-relative POSIX paths. */
function filesUnder(dir: string, rel = '', acc: string[] = []): string[] {
   for (const entry of fs.readdirSync(rel === '' ? dir : path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) filesUnder(dir, childRel, acc);
      else acc.push(childRel);
   }
   return acc.sort();
}

/** A golden artifact at its declared name, or at the dot-prefixed name beside it:
 * a `rootPath: "."` fixture exports its own root, so a plainly named golden would
 * be exported into the next bake of itself. The dot form is skipped by the content
 * walk, which is what makes it committable there (fixtures/README.md). */
function goldenPath(fixtureRoot: string, declared: string, what: string): string {
   const [head, ...rest] = fixtureRel(declared, what).split('/');
   const plain = path.join(fixtureRoot, head, ...rest);
   return fs.existsSync(plain) ? plain : path.join(fixtureRoot, '.' + head, ...rest);
}

/** Recursive occurrences of the token under `dir` (absent dir counts as zero, which
 * is what a run that wrote no tree leaves behind). */
function countToken(dir: string): { count: number; where: string[] } {
   if (!fs.existsSync(dir)) return { count: 0, where: [] };
   let count = 0;
   const where: string[] = [];
   const walk = (rel: string): void => {
      const abs = rel === '' ? dir : path.join(dir, rel);
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
         const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
         if (entry.isDirectory()) walk(childRel);
         else if (entry.isFile()) {
            const hits = fs.readFileSync(path.join(dir, childRel)).toString('binary').split(TOKEN).length - 1;
            if (hits > 0) {
               count += hits;
               where.push(childRel);
            }
         }
      }
   };
   walk('');
   return { count, where };
}

/** The stderr a build writes while it runs: check-before-act level-2 refusals are named there
 * and nowhere else, so every canary that expects one reads it here. */
function capture(): { restore: () => void; text: () => string } {
   const chunks: string[] = [];
   const orig = process.stderr.write.bind(process.stderr);
   (process.stderr as unknown as { write: unknown }).write = (s: unknown): boolean => {
      chunks.push(String(s));
      return true;
   };
   return {
      restore: () => {
         (process.stderr as unknown as { write: unknown }).write = orig;
      },
      text: () => chunks.join(''),
   };
}

/** Issue one request with the corpus's path EXACTLY as written — no URL parsing on
 * this side, or the encoded and malformed variants would be canonicalized before the
 * server ever saw them. */
function request(port: number, urlPath: string): Promise<{ status: number; body: string }> {
   return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
         const chunks: Buffer[] = [];
         res.on('data', (c: Buffer) => chunks.push(c));
         res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
   });
}

for (const name of LAYOUT_FIXTURES) {
   const expected = JSON.parse(fs.readFileSync(path.join(fixturesDir, name, 'expected.json'), 'utf8')) as {
      seeds?: Seed[];
      export?: ExpectedExport;
      trustCanary?: ExpectedCanary;
   };
   const expectedExport = expected.export;
   const canary = expected.trustCanary;
   assert.ok(expectedExport, `${name} declares an export block`);

   test(`fixture ${name}: the unified layout, the canary corpus, and idempotency`, async () => {
      const dir = materialize(name, expected.seeds ?? []);
      const { manifest } = loadManifest(dir);
      assert.ok(manifest, 'the fixture manifest loads');

      // The planted bytes are really planted: without this the scans below could
      // pass over a fixture that plants nothing.
      const plantedBefore = new Map<string, string>();
      for (const rel of canary?.plantedPaths ?? []) {
         const abs = path.join(dir, ...fixtureRel(rel, 'plantedPaths entry').split('/'));
         const text = fs.readFileSync(abs, 'utf8');
         assert.ok(text.includes(TOKEN), `${rel} carries the canary token`);
         plantedBefore.set(rel, text);
      }
      // Every path the fixture says must survive the run, as it stands before it.
      const preservedBefore = new Map<string, string>();
      for (const rel of expectedExport.layout?.preserved ?? []) {
         const abs = path.join(dir, ...fixtureRel(rel, 'preserved entry').split('/'));
         assert.ok(fs.existsSync(abs), `preserved path exists before the run: ${rel}`);
         if (fs.statSync(abs).isFile()) preservedBefore.set(rel, fs.readFileSync(abs, 'utf8'));
      }

      // --- the run -------------------------------------------------------------
      const first = buildViewer(dir, manifest);
      const exit = first.findings.some((f) => f.severity === 'error') ? 1 : 0;
      assert.equal(exit, expectedExport.exit, `exit code (findings: ${JSON.stringify(first.findings)})`);
      assert.equal(first.out.split(path.sep).join('/'), expectedExport.out, 'the declared output directory');

      // --- layout --------------------------------------------------------------
      for (const [role, roleDir] of Object.entries(expectedExport.layout?.roles ?? {})) {
         const abs = path.join(dir, ...fixtureRel(roleDir, `role ${role}`).split('/'));
         assert.ok(fs.existsSync(abs) && fs.statSync(abs).isDirectory(), `role ${role} established at ${roleDir}`);
      }
      for (const rel of expectedExport.layout?.present ?? []) {
         const abs = path.join(dir, ...fixtureRel(rel, 'present entry').split('/'));
         assert.ok(fs.existsSync(abs), `present after the run: ${rel}`);
      }
      for (const rel of expectedExport.layout?.absent ?? []) {
         const abs = path.join(dir, ...fixtureRel(rel, 'absent entry').split('/'));
         assert.ok(!fs.existsSync(abs), `never created: ${rel}`);
      }
      for (const [rel, before] of preservedBefore) {
         const abs = path.join(dir, ...rel.split('/'));
         assert.ok(fs.existsSync(abs), `still present after the run: ${rel}`);
         assert.equal(fs.readFileSync(abs, 'utf8'), before, `byte-identical after the run: ${rel}`);
      }

      // --- the golden tree -----------------------------------------------------
      const out = path.join(dir, ...fixtureRel(expectedExport.out, 'export out').split('/'));
      if (expectedExport.goldenTree.status === 'baked') {
         const fixtureRoot = path.join(fixturesDir, name);
         const contentDir = goldenPath(fixtureRoot, expectedExport.goldenTree.contentDir!, 'goldenTree.contentDir');
         const manifestFile = goldenPath(fixtureRoot, expectedExport.goldenTree.manifest!, 'goldenTree.manifest');
         const written = filesUnder(out);
         const inContent = written.filter((f) => f.startsWith('content/'));
         const outside = written.filter((f) => !f.startsWith('content/'));

         // The committed bytes ARE the export's content tree: same paths, same bytes,
         // in both directions, so a file that appears or disappears fails here.
         assert.deepEqual(
            inContent.map((f) => f.slice('content/'.length)),
            filesUnder(contentDir),
            `${name}: the golden content tree lists exactly what the export wrote`,
         );
         for (const rel of filesUnder(contentDir)) {
            assert.deepEqual(
               fs.readFileSync(path.join(out, 'content', ...rel.split('/'))),
               fs.readFileSync(path.join(contentDir, ...rel.split('/'))),
               `${name}: exported bytes differ from the golden for content/${rel}`,
            );
         }

         // Everything else — chrome, vendored assets, fonts — by digest and size. The
         // two sets are disjoint by construction and exhaustive by this comparison.
         const goldenManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
            version: number;
            files: Record<string, { sha256: string; size: number }>;
         };
         assert.equal(goldenManifest.version, 1, 'the manifest states its version');
         assert.deepEqual(
            Object.keys(goldenManifest.files),
            outside,
            `${name}: the manifest pins every file outside content/`,
         );
         for (const rel of outside) {
            const bytes = fs.readFileSync(path.join(out, ...rel.split('/')));
            assert.equal(
               crypto.createHash('sha256').update(bytes).digest('hex'),
               goldenManifest.files[rel].sha256,
               rel,
            );
            assert.equal(bytes.length, goldenManifest.files[rel].size, `${rel} size`);
         }
      }

      // --- the export-side scan ------------------------------------------------
      if (canary) {
         const scanRoot = path.join(dir, ...fixtureRel(canary.exportScan.root, 'exportScan.root').split('/'));
         const found = countToken(scanRoot);
         assert.equal(
            found.count,
            canary.exportScan.occurrences,
            `canary occurrences in ${canary.exportScan.root}: ${found.where.join(', ')}`,
         );
      }

      // --- the serve corpus ----------------------------------------------------
      if (canary) {
         const server = await serveViewer(dir, 0, manifest.rootPath);
         const address = server.address();
         const port = typeof address === 'object' && address ? address.port : 0;
         try {
            for (const want of canary.serve.requests) {
               const res = await request(port, want.path);
               assert.equal(res.status, want.status, `${want.path}${want.note ? ` — ${want.note}` : ''}`);
               if (res.status === 200 && canary.serve.routeScan?.assertNoTokenIn200Bodies !== false) {
                  assert.ok(!res.body.includes(TOKEN), `no canary byte in the 200 body of ${want.path}`);
               }
            }
         } finally {
            server.close();
         }
      }

      // --- idempotency ---------------------------------------------------------
      if (expectedExport.rerun?.byteIdentical) {
         const afterFirst = snapshot(dir);
         buildViewer(dir, manifest);
         const afterSecond = snapshot(dir);
         assert.deepEqual(
            [...afterSecond.entries()].sort(),
            [...afterFirst.entries()].sort(),
            'a second run is a byte-level no-op across the whole working tree',
         );
      }

      // The planted bytes are still exactly as planted: the tool never read them
      // into anything, and never rewrote them either.
      for (const [rel, before] of plantedBefore) {
         assert.equal(fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'), before, `untouched: ${rel}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
   });
}

// The one boundary a fixture cannot plant (a seed carries no symlinks) and the one
// the dot convention cannot hold: under `rootPath: "."` the trust domain really is
// inside the content mount, so a symlink there resolves INSIDE the mount root and
// passes every containment check. Only the by-name whitelist refuses it — remove
// the `servablePath` calls in the serve path and this test serves the canary.
test('the servable-roots whitelist refuses a content symlink into a private role', async () => {
   const dir = materialize('valid-trust-canary-dot-root', [{ from: '.leji-seed', to: '.leji' }]);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   fs.symlinkSync(path.join('.leji', 'work', 'proposal.md'), path.join(dir, 'leak.md'));
   fs.symlinkSync(path.join('.leji', 'work'), path.join(dir, 'leakdir'));
   // Generate the chrome (and an export) with the symlinks already planted, so the
   // serve legs run against a complete layer and the export legs see the bait.
   buildViewer(dir, manifest);
   const server = await serveViewer(dir, 0, manifest.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      for (const route of ['/content/leak.md', '/content/leakdir/proposal.md']) {
         const res = await request(port, route);
         assert.equal(res.status, 404, `${route} is denied by name, whatever it resolves to`);
         assert.ok(!res.body.includes(TOKEN), `no canary byte in the response to ${route}`);
      }
      // The servable role still serves through its own mount: the whitelist denies
      // the other roles, not the chrome.
      assert.equal((await request(port, '/index.html')).status, 200);
   } finally {
      server.close();
   }
   // And the export never followed it either (symlinks are skipped, and the target
   // is outside the enumerated roots).
   assert.equal(countToken(path.join(dir, '.leji', 'dist')).count, 0, 'no canary byte in the export');
   assert.ok(!fs.existsSync(path.join(dir, '.leji', 'dist', 'content', 'leak.md')), 'the symlink is not exported');
   fs.rmSync(dir, { recursive: true, force: true });
});

// The vectors below share the reason the test above lives here rather than in a
// fixture: they need a symlink (a seed carries none by contract — copySeed refuses
// one) or a hostile manifest, which is a per-SDK hazard rather than a shared
// contract the fixtures publish. So they are constructed at runtime, over a
// fixture's own layer and its own planted bytes, and they stay in this file because
// what they pin is the trust boundary the fixtures pin everywhere else.
//
// Each takes a path that reaches the private roles WITHOUT touching the ordinary
// content walk: the profile overlay renders its own pages, the sidebar lifts labels
// out of the profile scan, the export copies the chrome by name, and `--out` is the
// caller's own path. The dot convention and the content walk's symlink skip say
// nothing about any of them.

/** The dot-root canary layer with its seed materialized: the topology where the
 * trust domain sits inside the content mount, so a symlink into it resolves inside
 * every containment check and only the by-name whitelist refuses it. */
function canaryLayer(): string {
   return materialize('valid-trust-canary-dot-root', [{ from: '.leji-seed', to: '.leji' }]);
}

test('the whitelist refuses a bound agent profile that resolves into a private role', async () => {
   const dir = canaryLayer();
   // A profile pair the resolver really composes: an ordinary base under the layer's
   // agents directory, and a derived half planted in the onboarding workspace, bound
   // into the roster by a symlink at the content root. Without the whitelist on the
   // profile sources, the resolved page renders the planted half verbatim — the
   // overlay answers before the content mount ever judges the path.
   fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
   fs.writeFileSync(
      path.join(dir, 'agents', 'core.md'),
      [
         '---',
         'id: core',
         'name: Core',
         'role: core',
         'requiredRead:',
         '  - boot-profile.md',
         'mustAskWhen:',
         '  - anything is unclear',
         '---',
         '',
         'Base body.',
         '',
      ].join('\n'),
   );
   fs.writeFileSync(
      path.join(dir, '.leji', 'work', 'leak-profile.md'),
      ['---', 'id: leak', 'name: Leak', 'role: leak', 'inherits: core', '---', '', `Planted: ${TOKEN}`, ''].join('\n'),
   );
   fs.symlinkSync(path.join('.leji', 'work', 'leak-profile.md'), path.join(dir, 'leak.md'));
   const manifestPath = path.join(dir, 'leji.json');
   const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
   declared.agents = { leak: 'leak.md' };
   fs.writeFileSync(manifestPath, JSON.stringify(declared, null, 2) + '\n');

   const { manifest } = loadManifest(dir);
   assert.ok(manifest, 'the layer still loads with the profile bound');
   buildViewer(dir, manifest);
   const server = await serveViewer(dir, 0, manifest.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      const res = await request(port, '/content/leak.md');
      assert.equal(res.status, 404, 'the profile overlay refuses a source it may not read');
      assert.ok(!res.body.includes(TOKEN), 'no canary byte in the response');
      // The overlay still resolves the profiles it may read.
      assert.equal((await request(port, '/content/agents/core.md')).status, 200);
   } finally {
      server.close();
   }
   const found = countToken(path.join(dir, '.leji', 'dist'));
   assert.equal(found.count, 0, `no canary byte in the export: ${found.where.join(', ')}`);
   assert.ok(!fs.existsSync(path.join(dir, '.leji', 'dist', 'content', 'leak.md')), 'and no page written for it');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the sidebar lifts no label out of a profiles directory that is a private role', async () => {
   const dir = canaryLayer();
   // The same scan, reached the other way: a declared `agentProfilesPath` naming a
   // private role needs no symlink at all. The page itself was always refused, but
   // the sidebar built its label from the file's frontmatter — bytes of a private
   // file, served in a 200 body and copied into the export.
   fs.writeFileSync(
      path.join(dir, '.leji', 'work', 'p.md'),
      [
         '---',
         'id: planted',
         `name: ${TOKEN}`,
         'role: planted',
         'requiredRead:',
         '  - boot-profile.md',
         'mustAskWhen:',
         '  - anything is unclear',
         '---',
         '',
         'Body.',
         '',
      ].join('\n'),
   );
   const manifestPath = path.join(dir, 'leji.json');
   const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
   declared.machine = { agentProfilesPath: '.leji/work/' };
   fs.writeFileSync(manifestPath, JSON.stringify(declared, null, 2) + '\n');
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   buildViewer(dir, manifest);
   const found = countToken(path.join(dir, '.leji', 'dist'));
   assert.equal(found.count, 0, `no canary byte in the export: ${found.where.join(', ')}`);
   const server = await serveViewer(dir, 0, manifest.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      const sidebar = await request(port, '/content/_sidebar.md');
      assert.equal(sidebar.status, 200, 'the live sidebar still builds');
      assert.ok(!sidebar.body.includes(TOKEN), 'and carries no byte of the planted profile');
   } finally {
      server.close();
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- The check-before-act invariant on WRITE/CLEAR targets ----------------------------------
// One structural rule: every location the tool writes into or clears is realpath-
// resolved and validated against its role BEFORE the operation — never after, never
// conditionally. These pin the two write-side vectors two review rounds left open.

test('check-before-act: generation refuses a .leji/viewer aliased into a private role, before writing a byte', () => {
   const dir = canaryLayer();
   // Point the servable role at another private role, bytes of its own already there.
   // Before the check-before-act rule, generation wrote the chrome THROUGH the link into the trust domain and
   // only the export's later identity check noticed — after the mutation. The aliased
   // directory is snapshotted WHOLE, so any pre-refusal write (not just an overwrite of
   // one planted file) is caught.
   const aliased = path.join(dir, '.leji', 'work', 'chrome');
   fs.mkdirSync(path.join(aliased, 'assets'), { recursive: true });
   fs.writeFileSync(path.join(aliased, 'assets', 'planted.txt'), `${TOKEN}\n`);
   fs.symlinkSync(path.join('work', 'chrome'), path.join(dir, '.leji', 'viewer'));
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   const before = [...snapshot(aliased).entries()].sort();

   const gen = generateViewer(dir, manifest);
   assert.ok(
      gen.findings.some((f) => f.rule === 'viewer-target-refused' && f.severity === 'error'),
      'generation refuses with a hard error (non-zero exit)',
   );
   assert.equal(gen.written.length, 0, 'and writes nothing');
   assert.deepEqual([...snapshot(aliased).entries()].sort(), before, 'the aliased private role is byte-identical');

   // buildViewer regenerates first, so it inherits the refusal and never reaches the
   // destructive clean/copy: no export is produced either.
   const built = buildViewer(dir, manifest);
   assert.ok(
      built.findings.some((f) => f.rule === 'viewer-target-refused'),
      'the export inherits the refusal',
   );
   assert.deepEqual([...snapshot(aliased).entries()].sort(), before, 'still untouched after buildViewer');
   assert.ok(!fs.existsSync(path.join(dir, '.leji', 'dist')), 'no export was written');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('check-before-act: a DEFAULT-output build refuses when .leji/dist resolves into a private role', () => {
   const dir = canaryLayer();
   // The surviving default-bypass vector: the reservation used to be conditioned on a
   // caller --out, so a default .leji/dist redirected into the trust domain slipped
   // through. Now the default is validated identically — before any clear or write.
   const planted = path.join(dir, '.leji', 'mounts', 'store', 'x');
   fs.mkdirSync(planted, { recursive: true });
   fs.writeFileSync(path.join(planted, 'planted'), `${TOKEN}\n`);
   fs.symlinkSync(path.join('mounts', 'store', 'x'), path.join(dir, '.leji', 'dist'));
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   const before = [...snapshot(path.join(dir, '.leji', 'mounts')).entries()].sort();
   assert.throws(
      () => buildViewer(dir, manifest, undefined),
      /reserved for the tool's own roles/,
      'the default output is refused, not written',
   );
   assert.deepEqual(
      [...snapshot(path.join(dir, '.leji', 'mounts')).entries()].sort(),
      before,
      'nothing was cleared or written in the private role',
   );
   assert.equal(fs.readFileSync(path.join(planted, 'planted'), 'utf8'), `${TOKEN}\n`, 'the planted bytes are intact');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('check-before-act: an out-of-repository .leji/viewer or .leji/dist alias is REFUSED, and nothing is written outside', () => {
   // Containment is absolute: every write this tool makes lands inside the repository
   // it was pointed at. A `.leji/viewer` or `.leji/dist` symlinked to a real, empty
   // destination outside the tree — once a supported relocate/publish alias — is a
   // hard refusal now, with nothing written through it. A user who wants the export
   // elsewhere copies the finished folder there.
   const chromeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-chrome-'));
   const relocated = canaryLayer();
   fs.symlinkSync(chromeHome, path.join(relocated, '.leji', 'viewer'));
   const { manifest } = loadManifest(relocated);
   assert.ok(manifest);
   const built = buildViewer(relocated, manifest, undefined);
   assert.ok(
      built.findings.some((f) => f.rule === 'viewer-target-refused'),
      'the relocated viewer role is refused',
   );
   assert.equal(built.wrote, false, 'and the export never runs');
   assert.deepEqual(fs.readdirSync(chromeHome), [], 'nothing was written into the out-of-tree viewer home');

   const publish = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-publish-'));
   const published = canaryLayer();
   fs.symlinkSync(publish, path.join(published, '.leji', 'dist'));
   const { manifest: m2 } = loadManifest(published);
   assert.ok(m2);
   assert.throws(
      () => buildViewer(published, m2, undefined),
      /resolves outside the repository/,
      'the out-of-tree publish target is refused, not written',
   );
   assert.deepEqual(fs.readdirSync(publish), [], 'nothing was written into the out-of-tree publish root');

   fs.rmSync(relocated, { recursive: true, force: true });
   fs.rmSync(published, { recursive: true, force: true });
   fs.rmSync(chromeHome, { recursive: true, force: true });
   fs.rmSync(publish, { recursive: true, force: true });
});

test('check-before-act level-2: the boundary skip warns once on stderr, and a clean build is silent', () => {
   // A servable-looking source (an .md at the content root) whose resolved path lands
   // in a private role: withheld from serve and export, and — unlike an ordinary
   // skip — it says why, exactly once, on stderr (never stdout, never --json).
   const dir = canaryLayer();
   fs.symlinkSync(path.join('.leji', 'work', 'proposal.md'), path.join(dir, 'leak.md'));
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   let cap = capture();
   try {
      buildViewer(dir, manifest, undefined);
   } finally {
      cap.restore();
   }
   const warnings = cap
      .text()
      .split('\n')
      .filter((l) => l.startsWith('skipped leak.md:'));
   assert.equal(warnings.length, 1, `the withheld source is named exactly once: ${JSON.stringify(cap.text())}`);
   assert.match(warnings[0], /resolves into \.leji\/work \(private\); not served or exported/);
   assert.equal(countToken(path.join(dir, '.leji', 'dist')).count, 0, 'and no canary byte reached the export');
   fs.rmSync(dir, { recursive: true, force: true });

   // A clean layer (no cross-role source) says nothing on stderr.
   const clean = canaryLayer();
   const { manifest: m2 } = loadManifest(clean);
   assert.ok(m2);
   cap = capture();
   try {
      buildViewer(clean, m2, undefined);
   } finally {
      cap.restore();
   }
   assert.equal(
      cap
         .text()
         .split('\n')
         .filter((l) => l.startsWith('skipped ')).length,
      0,
      'a clean build emits no boundary-skip warning',
   );
   fs.rmSync(clean, { recursive: true, force: true });
});

test('check-before-act: an ancestor swapped to a symlink AFTER enumeration is never followed at use', () => {
   // The check/use gap on the READ side. The content walk enumerates a real directory;
   // before the export uses what it enumerated, that directory becomes a symlink into
   // a private role. Every later read or copy BY PATH then goes through the link, with
   // the walk's checks all behind it — and a revalidation that lstats the final
   // component alone follows the swapped ancestor to a perfectly ordinary file. So a
   // carried source is resolved, its RESOLVED path judged, and its bytes taken from the
   // descriptor `fstat` proved a regular file: the check and the use hold one inode.
   // Mutation that reddens: revalidate with lstat and read/copy by path again — the
   // planted bytes below are linted and land in the export.
   const dir = fs.realpathSync(canaryLayer());
   fs.writeFileSync(path.join(dir, 'domain', 'asset.txt'), 'an ordinary carried asset\n');
   const decoy = path.join(dir, '.leji', 'work', 'swapped');
   fs.mkdirSync(decoy, { recursive: true });
   fs.writeFileSync(path.join(decoy, 'overview.md'), `# planted ${TOKEN}\n`);
   fs.writeFileSync(path.join(decoy, 'asset.txt'), `${TOKEN}\n`);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);

   // The swap, at the one moment that matters: after the export walk has read
   // `domain/`'s entries and before it uses any of them. Generation runs first and
   // walks the same tree, so the hook arms only once the export resolves its own
   // output target — the first thing the pipeline does after generating. Builtin ESM
   // bindings are snapshotted at link time, hence the CJS patch plus the resync (the
   // idiom the export suite's subprocess spy uses).
   const require = createRequire(import.meta.url);
   const nodeFs = require('node:fs') as Record<string, unknown>;
   const readdirSync = nodeFs.readdirSync as (...args: unknown[]) => unknown;
   const realpathSync = nodeFs.realpathSync as { native: (p: string) => string };
   const nativeRealpath = realpathSync.native;
   const domainDir = path.join(dir, 'domain');
   const distDir = path.join(dir, '.leji', 'dist');
   let armed = false;
   let swapped = false;
   realpathSync.native = (p: string): string => {
      if (typeof p === 'string' && path.resolve(p) === distDir) armed = true;
      return nativeRealpath(p);
   };
   nodeFs.readdirSync = (...args: unknown[]): unknown => {
      const entries = readdirSync(...args);
      if (armed && !swapped && typeof args[0] === 'string' && path.resolve(args[0]) === domainDir) {
         swapped = true;
         fs.renameSync(domainDir, path.join(dir, 'domain-real'));
         fs.symlinkSync(path.join('.leji', 'work', 'swapped'), domainDir);
      }
      return entries;
   };
   Module.syncBuiltinESMExports();
   const cap = capture();
   try {
      buildViewer(dir, manifest, undefined);
   } finally {
      cap.restore();
      nodeFs.readdirSync = readdirSync;
      realpathSync.native = nativeRealpath;
      Module.syncBuiltinESMExports();
   }

   assert.ok(swapped, 'the ancestor was swapped between the walk and the use');
   assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'the export still ran to completion');
   const found = countToken(distDir);
   assert.equal(found.count, 0, `no planted byte reached the export: ${found.where.join(', ')}`);
   for (const rel of ['overview.md', 'asset.txt']) {
      assert.ok(
         !fs.existsSync(path.join(distDir, 'content', 'domain', rel)),
         `the redirected source is dropped rather than followed: ${rel}`,
      );
   }
   // A source that now resolves into a private role is a level-2 refusal: dropping it
   // silently would leave an operator with a quietly shorter export and no reason.
   const warnings = cap
      .text()
      .split('\n')
      .filter((l) => l.startsWith('skipped domain/'));
   assert.ok(warnings.length > 0, `the redirected sources are named on stderr: ${JSON.stringify(cap.text())}`);
   for (const line of warnings) {
      assert.match(line, /resolves into \.leji\/work \(private\); not served or exported/);
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

test('check-before-act: an ancestor swapped between the check and the open is caught by the post-open recheck', () => {
   // The residual the descriptor pinning left: the swap lands AFTER the realpath that
   // authorized the source and BEFORE the open on it, so the open follows the new link
   // and the descriptor holds planted bytes while every check has already passed on the
   // authorized path. `fstat` cannot see it — the decoy is a perfectly ordinary regular
   // file. The recheck after the open resolves the source once more and requires the
   // same location AND the same inode, so the bytes about to be read are proved to be
   // the ones the check judged. Mutation that reddens: drop the recheck and trust
   // `fstat` alone — the planted bytes below land in the export.
   const dir = fs.realpathSync(canaryLayer());
   const decoy = path.join(dir, '.leji', 'work', 'swapped');
   fs.mkdirSync(decoy, { recursive: true });
   fs.writeFileSync(path.join(decoy, 'overview.md'), `# planted ${TOKEN}\n`);
   fs.writeFileSync(path.join(decoy, 'asset.txt'), `${TOKEN}\n`);
   fs.writeFileSync(path.join(dir, 'domain', 'asset.txt'), 'an ordinary carried asset\n');
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);

   // The swap, at the one moment the recheck exists for: the source's realpath has
   // just been resolved and authorized, and the ancestor becomes a symlink before the
   // open on that path. Deterministic, not a race — the patched resolver performs it
   // inline, so the window is exercised on every run. Generation runs first over the
   // same tree, so — as in the enumeration canary — the hook arms only once the export
   // resolves its own output target.
   const require = createRequire(import.meta.url);
   const nodeFs = require('node:fs') as Record<string, unknown>;
   const realpathSync = nodeFs.realpathSync as { native: (p: string) => string };
   const nativeRealpath = realpathSync.native;
   const domainDir = path.join(dir, 'domain');
   const distDir = path.join(dir, '.leji', 'dist');
   let armed = false;
   let swapped = false;
   realpathSync.native = (p: string): string => {
      if (typeof p === 'string' && path.resolve(p) === distDir) armed = true;
      const real = nativeRealpath(p);
      if (armed && !swapped && path.dirname(real) === domainDir) {
         swapped = true;
         fs.renameSync(domainDir, path.join(dir, 'domain-real'));
         fs.symlinkSync(path.join('.leji', 'work', 'swapped'), domainDir);
      }
      return real;
   };
   Module.syncBuiltinESMExports();
   const cap = capture();
   try {
      buildViewer(dir, manifest, undefined);
   } finally {
      cap.restore();
      realpathSync.native = nativeRealpath;
      Module.syncBuiltinESMExports();
   }

   assert.ok(swapped, 'the ancestor was swapped between the check and the open');
   assert.ok(fs.existsSync(path.join(distDir, 'index.html')), 'the export still ran to completion');
   const found = countToken(distDir);
   assert.equal(found.count, 0, `no planted byte reached the export: ${found.where.join(', ')}`);
   for (const rel of ['overview.md', 'asset.txt']) {
      assert.ok(
         !fs.existsSync(path.join(distDir, 'content', 'domain', rel)),
         `the source whose path and descriptor diverged is dropped, never read: ${rel}`,
      );
   }
   const warnings = cap
      .text()
      .split('\n')
      .filter((l) => l.startsWith('skipped domain/'));
   assert.ok(warnings.length > 0, `the divergent source is named on stderr: ${JSON.stringify(cap.text())}`);
   for (const line of warnings) {
      assert.match(line, /resolves into \.leji\/work \(private\); not served or exported/);
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the export refuses an --out that resolves into a private role', () => {
   // The nested topology, deliberately: with the content root a subdirectory, an
   // --out at the repository root is a legitimate destination, so the reservation is
   // the only rule standing between a redirected path and the private domain.
   const dir = materialize('valid-trust-canary-nested-root', [{ from: '.leji-seed', to: '.leji' }]);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   // Proof the destination is otherwise open: an ordinary sibling path exports.
   assert.doesNotThrow(() => buildViewer(dir, manifest, 'plain-out'));
   assert.ok(fs.existsSync(path.join(dir, 'plain-out', 'index.html')), 'an ordinary --out at the root exports');
   // The same path, redirected: the reservation judges where the write would land,
   // so the private role is refused however the destination is spelled.
   fs.symlinkSync(path.join('.leji', 'mounts'), path.join(dir, 'redirect'));
   assert.throws(
      () => buildViewer(dir, manifest, 'redirect/export'),
      /reserved for the tool's own roles/,
      'a redirected --out is refused',
   );
   assert.ok(!fs.existsSync(path.join(dir, '.leji', 'mounts', 'export')), 'nothing was written into the private role');
   // The refusal is not destructive either: the planted bytes are as planted.
   const plantedRel = path.join('.leji', 'mounts', 'store', 'x', 'planted');
   assert.ok(fs.readFileSync(path.join(dir, plantedRel), 'utf8').includes(TOKEN), 'the private role is intact');
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- Check-before-act completeness: the overview.md write sites and the resolver's dangling paths.
// These pin the write sites two review rounds after the first left them: overview.md
// (seed AND refresh) is a content write that used to be guarded by containment only,
// and a nested/chained/unresolvable `--out` whose real destination the resolver used
// to rebuild lexically. Each hard-refusal case names, in its comment, the mutation
// that reddens it.

/** Whether this directory sits on a filesystem that cannot tell `.leji` from
 * `.LEJI` — asked of the volume, so a case-variant assertion runs only where the
 * fold is real. */
function foldsCase(dir: string): boolean {
   const probe = path.join(dir, 'leji-case-probe');
   fs.mkdirSync(probe, { recursive: true });
   try {
      return fs.existsSync(path.join(dir, 'LEJI-CASE-PROBE'));
   } finally {
      fs.rmSync(probe, { recursive: true, force: true });
   }
}

test('check-before-act: generation refuses an overview.md SEED aliased into a private role, before writing through it', () => {
   // rootPath ".", so overview.md is seeded at the repository root. A symlink there
   // into a private role is contained (inside the repo) yet crosses the trust
   // boundary: containment-only was the gap. The target dangles, so the seed WOULD
   // create it inside the role. Mutation that reddens: revert the overview guard to
   // resolvedWithinRoot-only (no writableTarget) — the seed writes through and
   // .leji/work/new.md appears.
   for (const role of ['work', 'mounts'] as const) {
      const dir = canaryLayer();
      const roleDir = path.join(dir, '.leji', role);
      fs.mkdirSync(roleDir, { recursive: true });
      fs.symlinkSync(path.join('.leji', role, 'new.md'), path.join(dir, 'overview.md'));
      const { manifest } = loadManifest(dir);
      assert.ok(manifest);
      const before = [...snapshot(roleDir).entries()].sort();

      const gen = generateViewer(dir, manifest);
      assert.ok(
         gen.findings.some(
            (f) =>
               f.rule === 'viewer-target-refused' &&
               f.severity === 'error' &&
               f.message.includes('overview.md') &&
               f.message.includes(`.leji/${role} (private)`),
         ),
         `generation refuses the overview.md seed into .leji/${role} with a hard error`,
      );
      assert.ok(!gen.written.includes('overview.md'), 'overview.md is not reported written');
      assert.ok(!fs.existsSync(path.join(roleDir, 'new.md')), 'nothing was written through the alias');
      assert.deepEqual([...snapshot(roleDir).entries()].sort(), before, `the aliased .leji/${role} is byte-identical`);
      fs.rmSync(dir, { recursive: true, force: true });
   }

   // Generation-side case variant: a `.LEJI/` spelling of a role folds to the role on
   // a case-insensitive volume, so the resolved target is judged, not the spelling.
   const dir = canaryLayer();
   if (foldsCase(dir)) {
      fs.mkdirSync(path.join(dir, '.leji', 'work'), { recursive: true });
      fs.symlinkSync(path.join('.LEJI', 'work', 'case.md'), path.join(dir, 'overview.md'));
      const { manifest } = loadManifest(dir);
      assert.ok(manifest);
      const gen = generateViewer(dir, manifest);
      assert.ok(
         gen.findings.some((f) => f.rule === 'viewer-target-refused' && /overview\.md/.test(f.message)),
         'a case-variant overview.md alias is refused as the role it folds to',
      );
      assert.ok(!fs.existsSync(path.join(dir, '.leji', 'work', 'case.md')), 'nothing written through the case variant');
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

test('check-before-act: the overview.md REFRESH refuses an alias into a private role before reading or writing it', () => {
   // overview.md is a symlink to an EXISTING private file carrying the generated-map
   // markers: the refresh branch (isFile true) used to resolvedWithinRoot-check, read
   // it, and rewrite the map block THROUGH the link. The check now runs on the
   // resolved path before the read. Mutation that reddens: revert to
   // resolvedWithinRoot-only — the private file is read and its map block rewritten.
   const dir = canaryLayer();
   const target = path.join(dir, '.leji', 'mounts', 'existing.md');
   fs.mkdirSync(path.dirname(target), { recursive: true });
   const original = `# private ${TOKEN}\n<!-- leji:generated-map:start -->STALE<!-- leji:generated-map:end -->\n`;
   fs.writeFileSync(target, original);
   fs.symlinkSync(path.join('.leji', 'mounts', 'existing.md'), path.join(dir, 'overview.md'));
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);

   const gen = generateViewer(dir, manifest);
   assert.ok(
      gen.findings.some(
         (f) =>
            f.rule === 'viewer-target-refused' &&
            f.severity === 'error' &&
            f.message.includes('overview.md') &&
            f.message.includes('.leji/mounts (private)'),
      ),
      'the refresh refuses the alias with a hard error',
   );
   assert.equal(
      fs.readFileSync(target, 'utf8'),
      original,
      'the private file was neither read-then-rewritten nor touched',
   );
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the export refuses a NESTED dangling --out whose intermediate component redirects into a private role', () => {
   // `redirect/export` where `redirect` is a DANGLING symlink into a private role: a
   // write would follow it, but the resolver used to climb past the dangling
   // component and rebuild `redirect/export` lexically (outside .leji/), so the check
   // passed and a target created afterward raced the write into the role. The
   // resolver now follows the dangling intermediate link. Mutation that reddens:
   // revert resolvedPath's intermediate-symlink follow (climb-past) — outAbs reads as
   // outside .leji/ and the build is not refused.
   const dir = materialize('valid-trust-canary-nested-root', [{ from: '.leji-seed', to: '.leji' }]);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   // redirect -> .leji/mounts/ghost, and ghost does NOT exist: a dangling intermediate.
   fs.symlinkSync(path.join('.leji', 'mounts', 'ghost'), path.join(dir, 'redirect'));
   const mountsBefore = [...snapshot(path.join(dir, '.leji', 'mounts')).entries()].sort();
   assert.throws(
      () => buildViewer(dir, manifest, 'redirect/export'),
      /reserved for the tool's own roles/,
      'a nested dangling --out into a private role is refused',
   );
   assert.ok(
      !fs.existsSync(path.join(dir, '.leji', 'mounts', 'ghost')),
      'the dangling target was not created by the build',
   );
   assert.deepEqual(
      [...snapshot(path.join(dir, '.leji', 'mounts')).entries()].sort(),
      mountsBefore,
      'nothing was cleared or written in the private role',
   );

   // The created-after-validation race, closed: even once the target exists, the same
   // resolved path is judged, so the build still refuses (never a one-time dangling
   // fluke that a real directory would slip past).
   fs.mkdirSync(path.join(dir, '.leji', 'mounts', 'ghost'), { recursive: true });
   assert.throws(
      () => buildViewer(dir, manifest, 'redirect/export'),
      /reserved for the tool's own roles/,
      'and refused again once the target is a real directory',
   );
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the export refuses a CHAINED dangling --out that ends in a private role', () => {
   // redirect -> hop -> .leji/work/ghost, every hop dangling: the resolver follows the
   // chain of intermediate dangling links to the real destination. Mutation that
   // reddens: revert resolvedPath's intermediate-symlink follow — the chain is rebuilt
   // lexically as outside .leji/ and the build is not refused.
   const dir = materialize('valid-trust-canary-nested-root', [{ from: '.leji-seed', to: '.leji' }]);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   fs.symlinkSync('hop', path.join(dir, 'redirect'));
   fs.symlinkSync(path.join('.leji', 'work', 'ghost'), path.join(dir, 'hop'));
   const workBefore = [...snapshot(path.join(dir, '.leji', 'work')).entries()].sort();
   assert.throws(
      () => buildViewer(dir, manifest, 'redirect/export'),
      /reserved for the tool's own roles/,
      'a chained dangling --out into a private role is refused',
   );
   assert.deepEqual(
      [...snapshot(path.join(dir, '.leji', 'work')).entries()].sort(),
      workBefore,
      'nothing was cleared or written in the private role',
   );
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the export treats an UNRESOLVABLE --out (permission/I/O) as a failure, not as absent', (t) => {
   // A non-ENOENT resolution failure (here an unreadable intermediate directory) must
   // FAIL the check, never be rebuilt lexically as a not-yet-created target. Mutation
   // that reddens: make resolvedPath return the lexical path on a non-ENOENT error —
   // the build proceeds instead of refusing. Skipped as root, which bypasses the mode.
   if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('running as root bypasses directory permissions; the EACCES cannot be constructed');
      return;
   }
   const dir = materialize('valid-trust-canary-nested-root', [{ from: '.leji-seed', to: '.leji' }]);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   const noperm = path.join(dir, 'noperm');
   fs.mkdirSync(path.join(noperm, 'sub'), { recursive: true });
   fs.chmodSync(noperm, 0o000);
   try {
      assert.throws(
         () => buildViewer(dir, manifest, 'noperm/sub/export'),
         /cannot be resolved \(permission or I\/O error\)/,
         'an unresolvable --out is refused, not treated as an absent write target',
      );
   } finally {
      fs.chmodSync(noperm, 0o755);
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

test('the export refuses a DANGLING output entry, default or --out, and creates nothing', () => {
   // A dangling symlink is a standing entry under both forms — never written through,
   // never read as absent. The output used to be resolved before anything judged it,
   // so `.leji/dist -> site` with `site` missing BECAME its own destination: statSync
   // reported absence, "clearable" followed, and the export created and filled the
   // link's target. The original entry is judged first now. Mutation that reddens:
   // drop the lstat on the original entry — the build writes through the link.
   const dir = materialize('valid-trust-canary-nested-root', [{ from: '.leji-seed', to: '.leji' }]);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   // Settle the internal chrome first: every build regenerates it, so the comparison
   // below measures the export's destructive half and nothing else.
   generateViewer(dir, manifest);

   fs.symlinkSync(path.join('..', 'site'), path.join(dir, '.leji', 'dist'));
   fs.symlinkSync('elsewhere', path.join(dir, 'published'));
   const before = [...snapshot(dir).entries()].sort();

   assert.throws(
      () => buildViewer(dir, manifest, undefined),
      /it is a dangling symlink/,
      'the default output is refused before it is resolved',
   );
   assert.throws(
      () => buildViewer(dir, manifest, 'published'),
      /it is a dangling symlink/,
      'and so is a caller --out that is otherwise a legal target',
   );

   assert.ok(fs.lstatSync(path.join(dir, '.leji', 'dist')).isSymbolicLink(), 'the default link is left in place');
   assert.ok(fs.lstatSync(path.join(dir, 'published')).isSymbolicLink(), 'the --out link is left in place');
   assert.ok(!fs.existsSync(path.join(dir, 'site')), 'the default link destination was never created');
   assert.ok(!fs.existsSync(path.join(dir, 'elsewhere')), 'the --out link destination was never created');
   assert.deepEqual([...snapshot(dir).entries()].sort(), before, 'and the tree is byte-identical');
   fs.rmSync(dir, { recursive: true, force: true });
});
