import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifest, route, run } from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const exampleDir = path.join(repoRoot, 'examples', 'monorepo');

let trackedExampleFiles: string[] | undefined;
function exampleTrackedFiles(): string[] {
   if (!trackedExampleFiles) {
      trackedExampleFiles = execFileSync('git', ['ls-files', '-z'], { cwd: exampleDir, encoding: 'utf8' })
         .split('\0')
         .filter(Boolean);
   }
   return trackedExampleFiles;
}

/** A copy of the indexed example layer plus a spread of decision records that
 * exercise every routing match: unscoped, path-scoped, category-scoped, and the
 * non-binding statuses (superseded / proposed). */
function routingLayer(): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-route-'));
   for (const rel of exampleTrackedFiles()) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(exampleDir, rel), target);
   }
   const record = (id: string, fields: string): string =>
      `---\nid: ${id}\ntitle: ${id}\ndate: 2026-06-20\n${fields}---\n\n# ${id}\n\n## Context\nc\n\n## Decision\nd\n\n## Consequences\ne\n`;
   const decisions = path.join(dir, 'docs', 'decisions');
   fs.writeFileSync(path.join(decisions, 'dec-unscoped.md'), record('dec-unscoped', 'status: accepted\n'));
   fs.writeFileSync(
      path.join(decisions, 'dec-path.md'),
      record('dec-path', 'status: accepted\naffectedPaths:\n  - src/payments/\n'),
   );
   fs.writeFileSync(
      path.join(decisions, 'dec-system.md'),
      record('dec-system', 'status: accepted\naffectedCategories:\n  - system\n'),
   );
   fs.writeFileSync(
      path.join(decisions, 'dec-deprecated.md'),
      record('dec-deprecated', 'status: deprecated\naffectedPaths:\n  - docs/system/\n'),
   );
   fs.writeFileSync(
      path.join(decisions, 'dec-super.md'),
      record('dec-super', 'status: superseded\nsupersededBy: dec-system\naffectedCategories:\n  - system\n'),
   );
   fs.writeFileSync(
      path.join(decisions, 'dec-proposed.md'),
      record('dec-proposed', 'status: proposed\naffectedCategories:\n  - system\n'),
   );
   return dir;
}

/** id -> matchedBy for the routed decisions, for order-independent assertions. */
function matchMap(decisions: { id: string; matchedBy: string }[]): Record<string, string> {
   return Object.fromEntries(decisions.map((d) => [d.id, d.matchedBy]));
}

const coreContext = path.join(repoRoot, 'examples', 'multi-repo', 'core-context');

/** A copy of the federated host example whose one mount declares the given
 * `topics`, so topic matching runs against controlled values. That mount declares
 * categories [domain, decisions]. */
function mountLayer(topics: string[]): string {
   const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-topics-'));
   fs.cpSync(coreContext, dir, { recursive: true });
   const manifestPath = path.join(dir, 'leji.json');
   const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
   m.federation.mounts[0].topics = topics;
   fs.writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
   return dir;
}

/** In-process CLI run (cli.js is `process.exit(await run(argv))`), for the exit
 * code and the emitted text the library alone does not decide. */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
   const out: string[] = [];
   const err: string[] = [];
   const origLog = console.log;
   const origError = console.error;
   console.log = (...a: unknown[]) => {
      out.push(a.join(' '));
   };
   console.error = (...a: unknown[]) => {
      err.push(a.join(' '));
   };
   try {
      const code = await run(args);
      return { code, stdout: out.join('\n'), stderr: err.join('\n') };
   } finally {
      console.log = origLog;
      console.error = origError;
   }
}

const mountNames = (r: { mounts: { name: string }[] }): string[] => r.mounts.map((m) => m.name);

test('route: a file task path matches an ancestor-directory decision scope (overlap-aware)', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const r = route(dir, manifest!, { paths: ['src/payments/billing.ts'] });
   assert.equal(r.pathScoped, true);
   assert.deepEqual(r.categories, []); // an ungoverned source file selects no category
   assert.deepEqual(r.documents, []);
   assert.deepEqual(matchMap(r.decisions), { 'dec-path': 'path', 'dec-unscoped': 'unscoped' });
});

test('route: touching a governed document signals its category without expanding it', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const r = route(dir, manifest!, { paths: ['docs/system/invariants.md'] });
   // The path signals `system` for decision and mount matching, but expands nothing:
   // a path scope routes the entries it touches, never the whole category.
   assert.deepEqual(r.categories, []);
   assert.deepEqual(r.categorySignals, ['system']);
   assert.deepEqual(
      r.documents.map((d) => d.path),
      ['docs/system/invariants.md'],
   );
   // dec-system by category, dec-deprecated by its docs/system/ path scope, dec-unscoped always.
   // superseded and proposed never bind even though they name the system category.
   assert.deepEqual(matchMap(r.decisions), {
      'dec-deprecated': 'path',
      'dec-system': 'category',
      'dec-unscoped': 'unscoped',
   });
});

test('route: an explicitly named category routes that category without a path scope', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const r = route(dir, manifest!, { categories: ['domain'] });
   assert.equal(r.pathScoped, false);
   assert.deepEqual(r.categories, ['domain']);
   assert.deepEqual(
      r.documents.map((d) => d.path),
      ['docs/domain/glossary.md'],
   );
   assert.deepEqual(matchMap(r.decisions), { 'dec-unscoped': 'unscoped' });
});

test('route: empty scope routes only org-wide unscoped live decisions', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const r = route(dir, manifest!, {});
   assert.equal(r.pathScoped, false);
   assert.deepEqual(r.categories, []);
   assert.deepEqual(r.documents, []);
   assert.deepEqual(matchMap(r.decisions), { 'dec-unscoped': 'unscoped' });
});

test('route: a directory task path matches contained declared file scopes (bidirectional)', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   // The task scopes a whole directory; dec-deprecated declares a file under it.
   const r = route(dir, manifest!, { paths: ['docs/'] });
   assert.equal(r.decisions.find((d) => d.id === 'dec-deprecated')?.matchedBy, 'path');
});

test('route: a federated mount is task-relevant when its categories overlap the task', () => {
   const coreContext = path.join(repoRoot, 'examples', 'multi-repo', 'core-context');
   const { manifest } = loadManifest(coreContext);
   // The mount declares categories [domain, decisions].
   const domain = route(coreContext, manifest!, { categories: ['domain'] });
   assert.deepEqual(
      domain.mounts.map((m) => m.name),
      ['acme-product-context'],
   );
   // A category the mount does not carry routes no mount.
   const system = route(coreContext, manifest!, { categories: ['system'] });
   assert.deepEqual(system.mounts, []);
});

test('route: a directory path selects the entries beneath it, and no category', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const r = route(dir, manifest!, { paths: ['docs/system/'] });
   // Containment is bidirectional and lexical: the directory reaches what it contains.
   // A directory is not itself a governed document, so it infers no category at all.
   assert.deepEqual(r.categories, []);
   assert.deepEqual(r.categorySignals, []);
   assert.ok(r.documents.some((d) => d.path === 'docs/system/invariants.md'));
});

test('route: a trailing slash changes nothing', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const a = route(dir, manifest!, { paths: ['docs/system'] });
   const b = route(dir, manifest!, { paths: ['docs/system/'] });
   assert.deepEqual(a, b);
});

test('route: a topic the task names selects the mount declaring it, and nothing else', () => {
   const dir = mountLayer(['billing', 'product surface']);
   const { manifest } = loadManifest(dir);
   const topical = route(dir, manifest!, { topics: ['billing'] });
   assert.deepEqual(mountNames(topical), ['acme-product-context']);
   // Topics-only is a real scope, not an empty one: it routes mounts plus the
   // org-wide unscoped decisions, and reports that no path scope was evaluated.
   assert.equal(topical.pathScoped, false);
   // Mount-only: the topic enters neither category set and loads nothing.
   assert.deepEqual(topical.categories, []);
   assert.deepEqual(topical.categorySignals, []);
   assert.deepEqual(topical.documents, []);
   assert.deepEqual(topical.records, []);
   // A matched mount carries no requiredness, and the topic routes no decision:
   // the decisions are exactly the empty scope's org-wide ones.
   assert.deepEqual(Object.keys(topical.mounts[0]).sort(), ['name', 'pin']);
   assert.deepEqual(topical.decisions, route(dir, manifest!, {}).decisions);
   // A topic no mount declares selects nothing.
   assert.deepEqual(route(dir, manifest!, { topics: ['shipping'] }).mounts, []);
});

test('route: a category match and a topic match select the same mount exactly once', () => {
   const dir = mountLayer(['billing']);
   const { manifest } = loadManifest(dir);
   const byCategory = route(dir, manifest!, { categories: ['domain'] });
   assert.deepEqual(mountNames(byCategory), ['acme-product-context']);
   const byBoth = route(dir, manifest!, { categories: ['domain'], topics: ['billing'] });
   assert.deepEqual(byBoth.mounts, byCategory.mounts);
});

test('route: duplicate topics are one signal', () => {
   const dir = mountLayer(['billing']);
   const { manifest } = loadManifest(dir);
   assert.deepEqual(
      route(dir, manifest!, { topics: ['billing', 'billing'] }),
      route(dir, manifest!, { topics: ['billing'] }),
   );
});

test('route: topic matching is exact, never case-folded and never Unicode-normalized', () => {
   const composed = 'caf\u00e9'; // é as one scalar value
   const decomposed = 'cafe\u0301'; // e + combining acute: canonically equivalent, different bytes
   const dir = mountLayer(['billing', composed]);
   const { manifest } = loadManifest(dir);
   assert.deepEqual(route(dir, manifest!, { topics: ['Billing'] }).mounts, []);
   assert.deepEqual(route(dir, manifest!, { topics: [decomposed] }).mounts, []);
   // The byte-identical non-ASCII spelling does match.
   assert.deepEqual(mountNames(route(dir, manifest!, { topics: [composed] })), ['acme-product-context']);
});

test('route: a topic that spells a category id still selects by topic only', () => {
   const dir = mountLayer(['domain']);
   const { manifest } = loadManifest(dir);
   const byTopic = route(dir, manifest!, { topics: ['domain'] });
   assert.deepEqual(mountNames(byTopic), ['acme-product-context']);
   // Naming the category expands it; naming the same string as a topic does not.
   assert.ok(route(dir, manifest!, { categories: ['domain'] }).documents.length > 0);
   assert.deepEqual(byTopic.categories, []);
   assert.deepEqual(byTopic.categorySignals, []);
   assert.deepEqual(byTopic.documents, []);
   assert.deepEqual(byTopic.records, []);
});

test('route --json: topics are an input only, so a non-matching topic changes no byte of the output', async () => {
   const dir = mountLayer(['billing']);
   const asOf = ['--as-of', '2026-06-27'];
   const base = await runCli(['route', '--categories', 'domain', ...asOf, '--json', '--root', dir]);
   const unmatched = await runCli([
      'route',
      '--categories',
      'domain',
      '--topics',
      'shipping',
      ...asOf,
      '--json',
      '--root',
      dir,
   ]);
   assert.equal(base.code, 0);
   assert.equal(unmatched.code, 0);
   assert.equal(unmatched.stdout, base.stdout);
   const payload = JSON.parse(base.stdout);
   assert.deepEqual(Object.keys(payload), [
      'command',
      'ok',
      'asOf',
      'pathScoped',
      'categories',
      'categorySignals',
      'documents',
      'records',
      'decisions',
      'mounts',
   ]);
   assert.deepEqual(Object.keys(payload.mounts[0]), ['name', 'pin']);
});

test('route --topics: repeatable and whole-value; an empty or invalid occurrence is rejected', async () => {
   const dir = mountLayer(['product, surface', 'billing']);
   // Occurrences accumulate, and a value carrying a comma and spaces survives whole.
   const accumulated = await runCli([
      'route',
      '--topics',
      'shipping',
      '--topics',
      'product, surface',
      '--json',
      '--root',
      dir,
   ]);
   assert.equal(accumulated.code, 0);
   assert.deepEqual(mountNames(JSON.parse(accumulated.stdout)), ['acme-product-context']);
   // Exact duplicates count once.
   const duplicated = await runCli(['route', '--topics', 'billing', '--topics', 'billing', '--json', '--root', dir]);
   assert.equal(JSON.parse(duplicated.stdout).mounts.length, 1);
   // An empty occurrence is an error, never a silent non-match.
   const empty = await runCli(['route', '--topics', '', '--root', dir]);
   assert.equal(empty.code, 2);
   assert.match(empty.stderr, /non-empty topic/);
   // So is a string that is not Unicode scalar values (an unpaired surrogate).
   const lone = await runCli(['route', '--topics', '\ud800', '--root', dir]);
   assert.equal(lone.code, 2);
   assert.match(lone.stderr, /invalid topic/);
});

test('route: an invalid caller topic is an input error, never a silent non-match', () => {
   const dir = mountLayer(['billing']);
   const { manifest } = loadManifest(dir);
   assert.throws(() => route(dir, manifest!, { topics: [''] }), /invalid task topic: empty string/);
   assert.throws(() => route(dir, manifest!, { topics: ['billing', ''] }), /invalid task topic: empty string/);
   assert.throws(() => route(dir, manifest!, { topics: ['\ud800'] }), /invalid task topic: lone surrogate/);
   // A non-string reaches the library only by a cast, but silently dropping it
   // would return a plausible empty match the caller cannot tell from a real one.
   assert.throws(() => route(dir, manifest!, { topics: [7 as unknown as string] }), /invalid task topic: not a string/);
   // A matched surrogate pair is one scalar value and stays valid.
   assert.deepEqual(route(dir, manifest!, { topics: ['🚀'] }).mounts, []);
});

test('route: an invalid declared mount topic is an input error naming the mount', () => {
   const dir = mountLayer(['billing']);
   const { manifest } = loadManifest(dir);
   // loadManifest refuses both shapes on disk (schema minLength, and the manifest
   // scalar gate), so this guard covers the caller that holds a Manifest object
   // directly instead of reading one through loadManifest.
   const withEmpty = JSON.parse(JSON.stringify(manifest));
   withEmpty.federation.mounts[0].topics = ['billing', ''];
   assert.throws(
      () => route(dir, withEmpty, { topics: ['billing'] }),
      /invalid mount topic on "acme-product-context": empty string/,
   );
   const withSurrogate = JSON.parse(JSON.stringify(manifest));
   withSurrogate.federation.mounts[0].topics = ['\ud800'];
   assert.throws(
      () => route(dir, withSurrogate, { topics: ['billing'] }),
      /invalid mount topic on "acme-product-context": lone surrogate/,
   );
   // The third defect class on the mount side: a manifest object held in memory
   // can carry a non-string where the schema would have refused one on disk.
   const withNonString = JSON.parse(JSON.stringify(manifest));
   withNonString.federation.mounts[0].topics = ['billing', 7 as unknown as string];
   assert.throws(
      () => route(dir, withNonString, { topics: ['billing'] }),
      /invalid mount topic on "acme-product-context": not a string/,
   );
   // Both sides are checked whatever the task named, so an identical lone
   // surrogate on each side can never match its way through.
   assert.throws(() => route(dir, withSurrogate, {}), /invalid mount topic/);
   assert.throws(() => route(dir, withSurrogate, { topics: ['\ud800'] }), /invalid task topic: lone surrogate/);
});

test('route: task paths normalize before matching, on both sides of the comparison', () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   const governed = 'docs/system/invariants.md';
   const canonical = route(dir, manifest!, { paths: [governed] });
   // Every spelling Requirement 6 normalizes away has to route identically. The
   // gap this closes: `--federation=required` passed open on the second and third
   // because neither is a key in the governed-document map, so neither signalled
   // its category and neither routed the mounts the task actually touches.
   for (const spelling of [
      `./${governed}`,
      `${governed}/`,
      `docs/./system//invariants.md`,
      `docs/x/../system/invariants.md`,
   ]) {
      const r = route(dir, manifest!, { paths: [spelling] });
      assert.deepEqual(r.categorySignals, canonical.categorySignals, spelling);
      assert.deepEqual(
         r.documents.map((d) => d.path),
         canonical.documents.map((d) => d.path),
         spelling,
      );
      assert.deepEqual(matchMap(r.decisions), matchMap(canonical.decisions), spelling);
   }
   // The repository root is a real scope, not an empty one: it contains everything.
   for (const rootSpelling of ['.', './', 'docs/..']) {
      assert.equal(route(dir, manifest!, { paths: [rootSpelling] }).pathScoped, true, rootSpelling);
   }
});

test('route: a task path with no root-relative form is an input error, never a silent non-match', async () => {
   const dir = routingLayer();
   const { manifest } = loadManifest(dir);
   for (const bad of ['/etc/passwd', '../outside.md', 'docs/../../outside.md']) {
      assert.throws(() => route(dir, manifest!, { paths: [bad] }), /invalid task path/, bad);
   }
   // Exit 2 through both commands that take a task scope, so a federation gate can
   // never read "you spelled it wrongly" as "this task touches no mount".
   const routed = await runCli(['route', '--paths', '/etc/passwd', '--root', dir]);
   assert.equal(routed.code, 2);
   assert.match(routed.stderr, /^leji: invalid task path "\/etc\/passwd": /m);
   const validated = await runCli(['validate', '--federation=required', '--paths', '../outside.md', '--root', dir]);
   assert.equal(validated.code, 2);
   assert.match(validated.stderr, /invalid task path "\.\.\/outside\.md"/);
});
