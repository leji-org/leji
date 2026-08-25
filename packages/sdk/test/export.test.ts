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
import {
   buildLayerMap,
   buildViewer,
   generateViewer,
   loadCliSpec,
   loadManifest,
   renderCommandHelp,
   renderOverview,
   run,
   serveViewer,
} from '../dist/index.js';
// The lint class is the command's own policy, not SDK surface: it stays inside its
// module, which an in-repo test reads directly.
import { STRICT_LINT_RULES } from '../dist/commands/export.js';

// `leji export` and `leji viewer build`: one operation, two permanently supported
// names. What this file pins is the part of that operation the other suites cannot
// see: that the pipeline carries no network dependency (statically or as a
// subprocess), that the two names really are one code path, that the exported tree
// answers every route the local server does, that no destination flag exists, that
// `--strict` is scoped to the lint class, and that a failed run leaves an existing
// export byte-untouched.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const srcDir = path.join(repoRoot, 'packages', 'sdk', 'src');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');
const fixturesDir = path.join(repoRoot, 'fixtures');

/** realpath the temp dir: on macOS /tmp is a symlink, which the export resolves. */
function tmpCopy(from: string, prefix: string): string {
   const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
   fs.cpSync(from, dir, { recursive: true });
   return dir;
}

/** run() writes to the console; swallow it and hand back what it said. */
async function quiet<T>(fn: () => T | Promise<T>): Promise<{ value: T; stdout: string }> {
   const chunks: string[] = [];
   const log = console.log;
   const err = console.error;
   console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(' ') + '\n');
   console.error = () => {};
   try {
      return { value: await fn(), stdout: chunks.join('') };
   } finally {
      console.log = log;
      console.error = err;
   }
}

/** Every path under `dir` as `rel -> digest` (directories as `rel/` -> ''), so a
 * comparison covers appearance and disappearance as well as content. */
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

// --- module-graph -------------------------------------------------------------
// The structural prong of the no-network guarantee: the export module's transitive
// STATIC import set contains no network module and no fetch call. It catches the
// static introduction of a network dependency and nothing else; the subprocess spy
// below and the offline CI leg cover dynamic loading and side doors.

/** Every specifier `file` imports statically — `import` and `export … from` alike,
 * since a re-export pulls a module in exactly as an import does — plus any dynamic
 * `import()` it spells literally (a dynamic import of a network module would
 * otherwise read as absent). */
function importsOf(file: string): string[] {
   const text = fs.readFileSync(file, 'utf8');
   const out: string[] = [];
   for (const m of text.matchAll(/(?:^|[\s;}])import\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) out.push(m[1]);
   for (const m of text.matchAll(/(?:^|[\s;}])export\s+[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
   for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
   for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
   return out;
}

/** The transitive closure of `entry` over relative specifiers, as absolute source
 * paths, plus every bare/builtin specifier reached along the way. */
function moduleGraph(entry: string): { files: string[]; external: Set<string> } {
   const files: string[] = [];
   const external = new Set<string>();
   const seen = new Set<string>();
   const stack = [entry];
   while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
      for (const spec of importsOf(file)) {
         if (!spec.startsWith('.')) {
            external.add(spec);
            continue;
         }
         // Authored TypeScript spells its own imports with the emitted `.js`.
         const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
         assert.ok(fs.existsSync(resolved), `${spec} from ${path.relative(srcDir, file)} resolves to a source file`);
         stack.push(resolved);
      }
   }
   return { files, external };
}

const NETWORK_MODULES = [
   'http',
   'https',
   'net',
   'dgram',
   'tls',
   'dns',
   'http2',
   'node:http',
   'node:https',
   'node:net',
   'node:dgram',
   'node:tls',
   'node:dns',
   'node:http2',
];

test('module-graph: the export module reaches no network module and calls no fetch', () => {
   // The parser reads every form a module can be pulled in by: `lib/layer.js` reaches
   // index.ts through `export … from` alone, so a parser that knew only `import`
   // would not see it — and a form the parser cannot see is how a network module
   // walks into the graph unnoticed.
   const barrel = importsOf(path.join(srcDir, 'index.ts'));
   assert.ok(barrel.includes('./lib/layer.js'), `re-export forms are parsed: ${barrel.join(', ')}`);

   const graph = moduleGraph(path.join(srcDir, 'commands', 'export.ts'));
   const reachable = graph.files.map((f) => path.relative(srcDir, f)).sort();
   // The graph is real: the export pulls in the chrome generation and the layer
   // libraries, so an empty or truncated walk cannot pass this test by accident.
   assert.ok(reachable.includes('commands/viewer.ts'), `the graph reaches the generator: ${reachable.join(', ')}`);
   assert.ok(reachable.length >= 8, `the graph is not truncated: ${reachable.join(', ')}`);
   assert.ok(!reachable.includes('commands/serve.ts'), 'the export never reaches the serve module');

   for (const mod of NETWORK_MODULES) {
      assert.ok(!graph.external.has(mod), `the export module graph imports ${mod}: ${[...graph.external].join(', ')}`);
   }
   for (const file of graph.files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!/\bfetch\s*\(/.test(text), `${path.relative(srcDir, file)} calls fetch()`);
      assert.ok(!/\bnew\s+WebSocket\b/.test(text), `${path.relative(srcDir, file)} opens a WebSocket`);
   }

   // Positive control: the serve module DOES import node:http, so the assertions
   // above are testing a real property rather than a detector that sees nothing.
   const serve = moduleGraph(path.join(srcDir, 'commands', 'serve.ts'));
   assert.ok(serve.external.has('node:http'), 'the serve module graph imports node:http');
});

// --- subprocess-spy -----------------------------------------------------------

test('subprocess-spy: an export run spawns git and nothing else', async () => {
   const dir = tmpCopy(exampleDir, 'leji-export-spy-');
   const require = createRequire(import.meta.url);
   const cp = require('node:child_process') as Record<string, unknown>;
   const launchers = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
   const originals = new Map(launchers.map((n) => [n, cp[n]]));
   const launched: string[] = [];
   for (const name of launchers) {
      const original = originals.get(name) as (...args: unknown[]) => unknown;
      cp[name] = (...args: unknown[]): unknown => {
         launched.push(String(args[0]));
         return original(...args);
      };
   }
   // Builtin ESM bindings are snapshotted at link time; this republishes the
   // patched CJS exports through them, so the SDK's own `import { execFileSync }`
   // sees the spy.
   Module.syncBuiltinESMExports();
   try {
      // The whole command, not just the build: the CLI entry, the manifest load
      // ahead of it, and the pipeline — so a spawn added anywhere on the export path
      // is seen, not only one inside `buildViewer`.
      const { value } = await quiet(() => run(['export', '--root', dir, '--json']));
      assert.equal(value, 0, 'the export ran to completion under the spy');
   } finally {
      for (const name of launchers) cp[name] = originals.get(name);
      Module.syncBuiltinESMExports();
   }
   // The spy sees something (git, for the index dates and the mount status), so a
   // silent no-op cannot pass; and everything it sees is git.
   assert.ok(launched.length > 0, 'the spy observed the subprocesses the export path uses');
   assert.deepEqual([...new Set(launched)], ['git'], `only git is spawned: ${[...new Set(launched)].join(', ')}`);
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- name-equivalence ---------------------------------------------------------

test('name-equivalence: `export` and `viewer build` write byte-identical trees', async () => {
   const a = tmpCopy(exampleDir, 'leji-export-name-a-');
   const b = tmpCopy(exampleDir, 'leji-export-name-b-');
   const first = await quiet(() => run(['export', '--root', a, '--json']));
   const second = await quiet(() => run(['viewer', 'build', '--root', b, '--json']));
   assert.equal(first.value, 0);
   assert.equal(second.value, 0);
   // The same JSON document under both names, `command` included: the second name
   // is the same operation, not a second command that resembles it.
   const docA = JSON.parse(first.stdout) as Record<string, unknown>;
   const docB = JSON.parse(second.stdout) as Record<string, unknown>;
   assert.equal(docA.command, 'export');
   assert.deepEqual(docB, docA);
   assert.equal(docA.out, path.join('.leji', 'dist'));

   assert.deepEqual([...snapshot(b).entries()].sort(), [...snapshot(a).entries()].sort(), 'identical working trees');
   fs.rmSync(a, { recursive: true, force: true });
   fs.rmSync(b, { recursive: true, force: true });
});

// --- route-equivalence --------------------------------------------------------

/** Issue one request with the path exactly as written. */
function request(port: number, urlPath: string): Promise<{ status: number; body: Buffer }> {
   return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
         const chunks: Buffer[] = [];
         res.on('data', (c: Buffer) => chunks.push(c));
         res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
   });
}

test('route-equivalence: every route the served layer names reads identically from the export', async () => {
   const dir = tmpCopy(exampleDir, 'leji-export-routes-');
   // The export carries the COMMITTED index; the server answers that route from a
   // live regeneration. They agree only when the stored index is current, which a
   // copy outside git is not (document dates fall back to filesystem mtimes), so the
   // layer is brought current first — the comparison below is then the real one.
   assert.equal(await quiet(() => run(['index', '--root', dir])).then((r) => r.value), 0);
   const { manifest } = loadManifest(dir);
   assert.ok(manifest);
   const built = buildViewer(dir, manifest);
   assert.ok(built.wrote);
   const outContent = path.join(dir, built.out, 'content');

   // The corpus: the two generated chrome pages served under the content root, every
   // link the sidebar names, and every document the stored index names. Enumerated
   // from the artifacts themselves, so a layer that grows a document grows the test.
   // `overview.md` is named explicitly: it is the homepage, so no sidebar entry
   // points at it, and it is the one page whose bytes are rendered rather than
   // copied. Served and exported must still be the same document.
   const routes = new Set<string>(['_sidebar.md', '_manifest.md', 'overview.md']);
   const sidebar = fs.readFileSync(path.join(outContent, '_sidebar.md'), 'utf8');
   for (const m of sidebar.matchAll(/]\((\/[^)]+)\)/g)) routes.add(m[1].replace(/^\//, ''));
   const indexRel = manifest.machine?.indexPath ?? 'context-index.json';
   const index = JSON.parse(fs.readFileSync(path.join(dir, indexRel), 'utf8')) as { entries: { path: string }[] };
   const base = manifest.rootPath.replace(/\/$/, '');
   const route = (repoRel: string): string => (base === '' || base === '.' ? repoRel : repoRel.slice(base.length + 1));
   for (const e of index.entries) routes.add(route(e.path));
   // The index itself is a route like any other, and the one the normalization is
   // for: the server answers it from a live regeneration, the export carries the
   // committed snapshot, and `generatedAt` is the only field allowed to differ.
   routes.add(route(indexRel));
   assert.ok(routes.size >= 6, `the corpus is not empty: ${[...routes].join(', ')}`);

   const server = await serveViewer(dir, 0, manifest.rootPath);
   const address = server.address();
   const port = typeof address === 'object' && address ? address.port : 0;
   try {
      for (const route of [...routes].sort()) {
         const served = await request(port, `/content/${route}`);
         assert.equal(served.status, 200, `the local server serves /content/${route}`);
         const exported = path.join(outContent, route);
         assert.ok(fs.existsSync(exported), `the export carries ${route}`);
         // `generatedAt` is the one declared volatile field; nothing else may differ.
         const normalize = (b: Buffer): string =>
            b.toString('utf8').replace(/"generatedAt":\s*"[^"]*"/g, '"generatedAt":"<normalized>"');
         assert.equal(
            normalize(fs.readFileSync(exported)),
            normalize(served.body),
            `served and exported bytes differ for ${route}`,
         );
      }
   } finally {
      server.close();
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- arg-rejection ------------------------------------------------------------

test('arg-rejection: export takes no destination flag, and its help names no network', async () => {
   const dir = tmpCopy(exampleDir, 'leji-export-args-');
   for (const argv of [
      ['export', '--endpoint', 'x'],
      ['export', '--url', 'https://example.invalid'],
      ['export', '--host', 'example.invalid'],
      ['export', '--token', 'secret'],
      ['export', '--port', '8080'],
      ['viewer', 'build', '--endpoint', 'x'],
   ]) {
      const { value } = await quiet(() => run([...argv, '--root', dir]));
      assert.equal(value, 2, `${argv.join(' ')} is a usage error`);
   }
   // The accept side of the same guarantee, under BOTH names: the allow-list the
   // rejection above consults is exactly the globals plus --out and --strict. Read
   // from cli.json, which is what the CLI itself rejects against — so a destination
   // flag cannot reach the surface without failing here.
   const spec = loadCliSpec();
   for (const name of ['export', 'viewer build']) {
      const cmd = spec.commands.find((c) => c.name === name);
      assert.ok(cmd, `${name} is a documented command`);
      const allowed = [...spec.globalOptions, ...cmd!.options]
         .flatMap((o) => o.flags.split(',').map((s) => s.trim().split(/\s+/)[0]))
         .sort();
      assert.deepEqual(allowed, ['--help', '--json', '--out', '--root', '--strict', '--version', '-h', '-v'], name);
      // And the help bytes a person reads describe no network operation: this command
      // writes files from files. The whole banned class against the real bytes, not a
      // selected few of them. The flag surface itself is the cli.json assertion above,
      // which holds whatever the help layout does; help only has to document it.
      const help = renderCommandHelp(name);
      assert.ok(help);
      for (const o of cmd!.options) assert.ok(help!.includes(`   ${o.flags}`), `${name} help documents ${o.flags}`);
      assert.match(help!, /\nGlobal options: see leji --help\.\n/);
      for (const word of [
         'endpoint',
         'token',
         'upload',
         'api key',
         's3://',
         'host',
         'url',
         'server',
         'network',
         'browser',
         'publish',
         'remote',
      ]) {
         assert.ok(!help!.toLowerCase().includes(word), `the ${name} help text carries no "${word}"`);
      }
   }
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- strict-scope and the byte-untouched target --------------------------------

test('strict: the gate is the lint class, and a failed run leaves the target byte-untouched', async () => {
   // A layer that reports a finding without failing generation: a viewer.homepage
   // that resolves to nothing is a warning, exported anyway.
   const dir = tmpCopy(path.join(fixturesDir, 'valid-unified-leji-fresh'), 'leji-export-strict-');
   const manifestPath = path.join(dir, 'leji.json');
   const declared = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
   declared.viewer = { homepage: 'no-such-page.md' };
   fs.writeFileSync(manifestPath, JSON.stringify(declared, null, 2) + '\n');

   const plain = await quiet(() => run(['export', '--root', dir, '--json']));
   assert.equal(plain.value, 0);
   const plainDoc = JSON.parse(plain.stdout) as { ok: boolean; findings: { rule: string }[] };
   assert.equal(plainDoc.ok, true);
   assert.ok(
      plainDoc.findings.some((f) => f.rule === 'viewer-path-missing'),
      `the layer reports a finding: ${JSON.stringify(plainDoc.findings)}`,
   );

   // `--strict` is scoped to the lint class, not to any finding: an ordinary viewer
   // warning stays a warning, and the export is still written.
   const strict = await quiet(() => run(['export', '--root', dir, '--strict', '--json']));
   assert.equal(strict.value, 0, 'an ordinary warning is not promoted by --strict');
   const strictDoc = JSON.parse(strict.stdout) as { ok: boolean; findings: unknown[] };
   assert.equal(strictDoc.ok, true);
   assert.deepEqual(strictDoc.findings, plainDoc.findings, 'the same findings, and still written');
   // The class the gate does promote is the rendering lint's, so F4's findings fail
   // a strict run the day they land. What that promotion DOES is pinned behaviorally
   // by the test below; this only names the class the gate is scoped to.
   assert.ok(STRICT_LINT_RULES.has('render-unsupported'), 'the lint class is what --strict promotes');

   const distDir = path.join(dir, '.leji', 'dist');
   const before = [...snapshot(distDir).entries()].sort();
   assert.ok(before.length > 0, 'an export exists to be protected');

   // An error finding fails the run through the same pre-clean gate: overview.md,
   // seeded by the runs above, redirected into a private role. Generation reaches it
   // after the chrome is written, so this run proves both halves of the pipeline
   // promise at once — the internal chrome IS regenerated, the target is not touched.
   fs.mkdirSync(path.join(dir, '.leji', 'mounts'), { recursive: true });
   fs.writeFileSync(path.join(dir, '.leji', 'mounts', 'stolen.md'), 'private\n');
   const overview = path.join(dir, 'docs', 'overview.md');
   assert.ok(fs.existsSync(overview), 'the seeded overview page is there to redirect');
   fs.rmSync(overview);
   fs.symlinkSync(path.join(dir, '.leji', 'mounts', 'stolen.md'), overview);
   const viewerDir = path.join(dir, '.leji', 'viewer');
   fs.rmSync(viewerDir, { recursive: true, force: true });

   const failed = await quiet(() => run(['export', '--root', dir, '--json']));
   assert.equal(failed.value, 1, 'an error finding fails the run');
   const failedDoc = JSON.parse(failed.stdout) as { ok: boolean; findings: { severity: string }[] };
   assert.equal(failedDoc.ok, false);
   assert.ok(
      failedDoc.findings.some((f) => f.severity === 'error'),
      `the run reports an error finding: ${JSON.stringify(failedDoc.findings)}`,
   );
   assert.deepEqual([...snapshot(distDir).entries()].sort(), before, 'the existing export is byte-untouched');
   assert.ok(fs.existsSync(path.join(viewerDir, 'index.html')), 'the internal chrome was regenerated regardless');
   assert.ok(fs.existsSync(path.join(viewerDir, 'assets')), 'the internal chrome carries its assets');

   // The same holds under the other name, and for a target that does not exist yet.
   fs.rmSync(distDir, { recursive: true, force: true });
   const other = await quiet(() => run(['viewer', 'build', '--root', dir, '--strict']));
   assert.equal(other.value, 1);
   assert.ok(!fs.existsSync(distDir), 'nothing was written at all');
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- the strict gate, driven by a real lint finding ----------------------------

test('strict: a lint finding is a warning by default and fails the run under --strict', async () => {
   const dir = tmpCopy(path.join(fixturesDir, 'valid-unified-leji-fresh'), 'leji-export-lint-');
   // A real unsupported construct in one of the layer's own documents: the rendering
   // lint reads the source the export carries, so the exit codes below are the gate's
   // answer to a finding the shipped pipeline produced and not to a planted one.
   const doc = path.join(dir, 'docs', 'domain', 'overview.md');
   fs.appendFileSync(doc, '\nA raw <span>element</span> in the prose.\n');

   // Default run: the lint finding is reported and the export is written anyway —
   // the layer's build never breaks on prose.
   const plain = await quiet(() => run(['export', '--root', dir, '--json']));
   assert.equal(plain.value, 0, 'an ordinary run exports despite the lint finding');
   const plainDoc = JSON.parse(plain.stdout) as {
      ok: boolean;
      findings: { rule: string; severity: string; path?: string; line?: number; construct?: string }[];
   };
   assert.equal(plainDoc.ok, true);
   assert.ok(
      plainDoc.findings.some(
         (f) =>
            f.rule === 'render-unsupported' &&
            f.severity === 'warning' &&
            f.path === 'docs/domain/overview.md' &&
            f.line === 5 &&
            f.construct === 'raw-html',
      ),
      `the lint finding reached the pipeline: ${JSON.stringify(plainDoc.findings)}`,
   );
   const distDir = path.join(dir, '.leji', 'dist');
   const before = [...snapshot(distDir).entries()].sort();
   assert.ok(before.length > 0, 'an export exists to be protected');

   // Same layer, same finding, `--strict`: the run fails and the export it would have
   // replaced is left exactly as it was. The chrome is removed first, so the assertion
   // that it was regenerated can actually fail: after the default run above it exists
   // already, and a strict gate moved ahead of regeneration would pass unnoticed.
   const viewerDir = path.join(dir, '.leji', 'viewer');
   fs.rmSync(viewerDir, { recursive: true, force: true });
   const strict = await quiet(() => run(['export', '--root', dir, '--strict', '--json']));
   assert.equal(strict.value, 1, 'the lint class fails a strict run');
   const strictDoc = JSON.parse(strict.stdout) as { ok: boolean; findings: { rule: string }[] };
   assert.equal(strictDoc.ok, false);
   assert.ok(strictDoc.findings.some((f) => f.rule === 'render-unsupported'));
   assert.deepEqual([...snapshot(distDir).entries()].sort(), before, 'the existing export is byte-untouched');
   // The internal chrome is regenerated regardless: the no-write promise is the
   // target's, per the pipeline order.
   assert.ok(fs.existsSync(path.join(viewerDir, 'index.html')), 'the chrome was regenerated');
   assert.ok(fs.existsSync(path.join(viewerDir, 'assets')), 'the internal chrome carries its assets');

   // One operation, two names: the gate answers the same under `viewer build`.
   const other = await quiet(() => run(['viewer', 'build', '--root', dir, '--strict', '--json']));
   assert.equal(other.value, 1, 'the gate holds under the other name');
   assert.deepEqual([...snapshot(distDir).entries()].sort(), before, 'and still byte-untouched');
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- canonical JSON on every path ---------------------------------------------

test('canonical-json: a failure before the pipeline emits the export document, under both names', async () => {
   const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leji-export-json-')));
   fs.writeFileSync(path.join(dir, 'leji.json'), '{ this is not a manifest\n');

   const first = await quiet(() => run(['export', '--root', dir, '--json']));
   const second = await quiet(() => run(['viewer', 'build', '--root', dir, '--json']));
   assert.equal(first.value, 1);
   assert.equal(second.value, 1);
   // One document shape for every outcome of this command: the pre-pipeline failure
   // is NOT reported in the generic `{command, ok, findings, summary}` envelope.
   const doc = JSON.parse(first.stdout) as Record<string, unknown>;
   assert.deepEqual(Object.keys(doc), ['command', 'ok', 'out', 'findings', 'warning']);
   assert.equal(doc.command, 'export');
   assert.equal(doc.ok, false);
   assert.equal(doc.out, path.join('.leji', 'dist'));
   assert.ok(
      (doc.findings as { severity: string }[]).some((f) => f.severity === 'error'),
      `the unreadable manifest is reported: ${JSON.stringify(doc.findings)}`,
   );
   assert.ok(typeof doc.warning === 'string' && (doc.warning as string).startsWith('This is your context layer'));
   assert.equal(second.stdout, first.stdout, 'byte-identical under both names');

   // A caller `--out` is reported as the caller wrote it, on the same shape.
   const withOut = await quiet(() => run(['export', '--root', dir, '--out', 'site', '--json']));
   assert.equal(withOut.value, 1);
   assert.equal((JSON.parse(withOut.stdout) as { out: string }).out, 'site');
   fs.rmSync(dir, { recursive: true, force: true });
});

// --- the exported overview carries the map; the lint reads the source ----------

test('overview: the exported copy carries the rendered map, and the lint judges the source bytes', async () => {
   const dir = tmpCopy(path.join(fixturesDir, 'valid-unified-leji-fresh'), 'leji-export-overview-');
   // An author's page: prose around the markers, and inside them a stale hand-edit
   // carrying an out-of-subset construct. The construct's line number is what proves
   // which bytes the lint read, since the substitution below changes every line after
   // the markers.
   const overview = path.join(dir, 'docs', 'overview.md');
   const source =
      '# The layer\n\nIntro prose.\n\n<!-- leji:generated-map:start -->\nA raw <span>element</span> left inside the markers.\n<!-- leji:generated-map:end -->\n\nClosing prose.\n';
   fs.writeFileSync(overview, source);

   const { value: exit, stdout } = await quiet(() => run(['export', '--root', dir, '--json']));
   assert.equal(exit, 0, `the export ran: ${stdout}`);
   const doc = JSON.parse(stdout) as { findings: { rule: string; path?: string; line?: number }[] };
   assert.ok(
      doc.findings.some((f) => f.rule === 'render-unsupported' && f.path === 'docs/overview.md' && f.line === 6),
      `the lint reported the construct at its line in the SOURCE: ${JSON.stringify(doc.findings)}`,
   );

   // The source is the author's file: untouched by an export that renders from it.
   assert.equal(fs.readFileSync(overview, 'utf8'), source, 'the export never writes the page it renders from');
   const exported = fs.readFileSync(path.join(dir, '.leji', 'dist', 'content', 'overview.md'), 'utf8');
   const { manifest } = loadManifest(dir);
   const entries = generateViewer(dir, manifest!).indexEntries;
   assert.equal(
      exported,
      renderOverview(source, manifest!, entries).text,
      'the exported copy is the source with the marked span substituted',
   );
   assert.ok(exported.includes('```mermaid\n' + buildLayerMap(manifest!, entries) + '\n```'), 'the map is the map');
   assert.match(exported, /^# The layer$/m, 'the prose around the markers rides along');
   assert.match(exported, /Closing prose\./, 'including what follows them');
   assert.ok(!exported.includes('<span>'), 'and the stale hand-edit between them is gone');
   fs.rmSync(dir, { recursive: true, force: true });
});

test('overview: an exported page without markers is the source, byte for byte', async () => {
   const dir = tmpCopy(path.join(fixturesDir, 'valid-unified-leji-fresh'), 'leji-export-nomarkers-');
   const overview = path.join(dir, 'docs', 'overview.md');
   const source = '# Fully custom\n\nNo markers here at all.\n';
   fs.writeFileSync(overview, source);
   const { value: exit } = await quiet(() => run(['export', '--root', dir, '--json']));
   assert.equal(exit, 0);
   assert.equal(fs.readFileSync(overview, 'utf8'), source, 'the source is untouched');
   assert.equal(
      fs.readFileSync(path.join(dir, '.leji', 'dist', 'content', 'overview.md'), 'utf8'),
      source,
      'with nowhere to render the map, the exported copy is the source',
   );
   fs.rmSync(dir, { recursive: true, force: true });
});
