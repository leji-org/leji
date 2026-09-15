import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseOverview, parseSidebar } from '../src/lib/hero-glimpse.ts';

// The homepage's viewer window is drawn from two files copied verbatim out of
// `leji export` over the hero fixture, and the SDK's site-hero test keeps those
// copies current. That pins the input. This file pins the reading of it: byte
// equality proves the window is fed today's output, not that the structure it
// draws (which document sits inside which group) survived the trip.
//
// So the expectation below is written out in full, by hand, from what the viewer
// actually shows for that layer. A generator change that reorders a group, drops
// the decisions index, or flattens the repository drawer lands here as a diff.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const glimpseDir = path.resolve(testDir, '..', 'src', 'data', 'hero-glimpse');
const sidebarMd = fs.readFileSync(path.join(glimpseDir, '_sidebar.md'), 'utf8');
const overviewMd = fs.readFileSync(path.join(glimpseDir, 'overview.md'), 'utf8');

/** The sidebar the viewer paints for the hero fixture, as a reader sees it. */
const SIDEBAR = {
   pins: ['🤖 Boot profile', '📄 Manifest'],
   groups: [
      { label: '🤖 Agents', entries: ['Agent Core'] },
      { label: '📖 Domain', entries: ['Glossary'] },
      { label: '⚙️ System', entries: ['Invariants'] },
      { label: '🛡️ Governance', entries: ['Imported Agents', 'Operating Rules'] },
      {
         label: '🧭 Decisions',
         entries: [
            'Decisions index',
            'Adopt the Leji context layer',
            'Adopt existing agent instructions into the context layer',
         ],
      },
   ],
   drawer: { label: 'Reference', entries: ['Architecture', 'Runbook'] },
};

test('the pinned sidebar parses to the structure the viewer shows', () => {
   assert.deepEqual(parseSidebar(sidebarMd), SIDEBAR);
});

// The check above only earns its keep if it can fail on a document going missing
// rather than only on a wholesale reshape. So: one entry removed from the pinned
// sidebar in memory, and the same comparison has to reject it, and reject it for
// that entry rather than for some incidental difference. The file on disk is untouched.
test('a sidebar missing one entry no longer matches the structure', () => {
   const cut = sidebarMd
      .split('\n')
      .filter((line) => !line.includes('[Decisions index]'))
      .join('\n');
   assert.notEqual(cut, sidebarMd, 'the mutation changed nothing, so this negative check proves nothing');

   const parsed = parseSidebar(cut);
   assert.throws(() => assert.deepEqual(parsed, SIDEBAR), assert.AssertionError);
   const decisions = parsed.groups.find((group) => group.label === '🧭 Decisions');
   assert.deepEqual(
      decisions?.entries,
      SIDEBAR.groups[4].entries.filter((entry) => entry !== 'Decisions index'),
      'the mismatch is not exactly the missing decisions index',
   );
});

test('the pinned overview parses to its heading, its prose and its map', () => {
   const overview = parseOverview(overviewMd);
   assert.equal(overview.title, 'acme-billing-context');
   assert.equal(overview.paragraphs.length, 2);
   assert.ok(
      overview.paragraphs[0].startsWith('This is the **Leji context layer** for `acme-billing-context`:'),
      `the first paragraph is not the seeded one: ${overview.paragraphs[0]}`,
   );
   assert.ok(
      overview.paragraphs[1].startsWith('This page is yours to edit.'),
      `the second paragraph is not the seeded one: ${overview.paragraphs[1]}`,
   );
   // The boot profile is the root the categories hang off, so it carries no count.
   assert.deepEqual(overview.map, {
      root: { label: '🤖 Boot profile', count: '' },
      categories: [
         { label: '📖 Domain', count: '1 doc' },
         { label: '⚙️ System', count: '1 doc' },
         { label: '🛡️ Governance', count: '2 docs' },
         { label: '🧭 Decisions', count: '2 docs' },
      ],
   });
});

// The map is a graph, and the window draws one arrangement of it: the root on the
// left, its categories beside it. Reading only the boxes would let the generator move
// an edge, hang a category off another category, or add a node the picture has no
// place for, while the drawing carried on showing the old shape. So the parser reads
// the relationships too and refuses what it cannot draw. These are the refusals, each
// on the pinned file mutated in memory; the file on disk is never touched.

/** The pinned overview with one line of its map replaced, removed, or added. */
function mutatedMap(edit: (lines: string[]) => string[]): string {
   const lines = overviewMd.split('\n');
   const start = lines.findIndex((line) => line.trim() === '<!-- leji:generated-map:start -->');
   const end = lines.findIndex((line) => line.trim() === '<!-- leji:generated-map:end -->');
   assert.ok(start !== -1 && end > start, 'the pinned overview has no map to mutate');
   const mutated = [...lines.slice(0, start + 1), ...edit(lines.slice(start + 1, end)), ...lines.slice(end)].join('\n');
   assert.notEqual(mutated, overviewMd, 'the mutation changed nothing, so this negative check proves nothing');
   return mutated;
}

test('a map with its edges removed is refused, not read as the same picture', () => {
   const cut = mutatedMap((map) => map.filter((line) => !line.includes('-->')));
   assert.throws(() => parseOverview(cut), /hangs "cat_domain" off nothing: it has no edge/);
});

test('a category hung off another category is refused', () => {
   const reparented = mutatedMap((map) =>
      map.map((line) => (line.includes('boot --> cat_system') ? line.replace('boot', 'cat_domain') : line)),
   );
   assert.throws(
      () => parseOverview(reparented),
      /hangs "cat_system" off "cat_domain" rather than off the root "boot"/,
   );
});

test('a node the map declares but never hangs off the root is refused', () => {
   const orphan = mutatedMap((map) => [...map.slice(0, -1), '  extra["📦 Extra · 1 doc"]', ...map.slice(-1)]);
   assert.throws(() => parseOverview(orphan), /hangs "extra" off nothing: it has no edge/);
   // The same node without a count is a second candidate root, refused by that rule.
   const second = mutatedMap((map) => [...map.slice(0, -1), '  extra["📦 Extra"]', ...map.slice(-1)]);
   assert.throws(() => parseOverview(second), /declares 2 nodes without a count, and exactly one is the root/);
});

test('a statement the glimpse cannot draw is refused, and named', () => {
   const styled = mutatedMap((map) => [...map.slice(0, -1), '  classDef highlight fill:#fff', ...map.slice(-1)]);
   assert.throws(() => parseOverview(styled), /statement this parser does not read: classDef highlight fill:#fff/);
   const dotted = mutatedMap((map) => map.map((line) => line.replace('boot --> cat_domain', 'boot -.-> cat_domain')));
   assert.throws(() => parseOverview(dotted), /statement this parser does not read: boot -\.-> cat_domain/);
});

// Every refusal above rests on a line with two constructs on it failing to match, so
// that it reaches the throw instead of being read as one construct with punctuation in
// the middle. That is a property of the patterns, not of the checks after them, and it
// holds only while no capture can run past its own closing delimiter. These three cover
// the file's three quoted-or-bracketed captures, one line each, two constructs each.

/** The pinned sidebar with its lines edited in memory. The file on disk is untouched. */
function mutatedSidebar(edit: (lines: string[]) => string[]): string {
   const mutated = edit(sidebarMd.split('\n')).join('\n');
   assert.notEqual(mutated, sidebarMd, 'the mutation changed nothing, so this negative check proves nothing');
   return mutated;
}

test('a sidebar line carrying two links is refused, pinned or indented', () => {
   const twoPins = mutatedSidebar((lines) => [...lines.slice(0, 1), '- [A](/a.md) [B](/b.md)', ...lines.slice(1)]);
   assert.throws(() => parseSidebar(twoPins), /pinned sidebar line is not a link: - \[A\]\(\/a\.md\) \[B\]\(\/b\.md\)/);

   const twoEntries = mutatedSidebar((lines) =>
      lines.map((line) => (line.includes('[Glossary]') ? '  - [A](/a.md) [B](/b.md)' : line)),
   );
   assert.throws(() => parseSidebar(twoEntries), /neither a group nor an entry: - \[A\]\(\/a\.md\) \[B\]\(\/b\.md\)/);
});

test('a group line carrying two bold spans is refused', () => {
   const twoLabels = mutatedSidebar((lines) =>
      lines.map((line) => (line === '- **📖 Domain**' ? '- **A** **B**' : line)),
   );
   assert.throws(() => parseSidebar(twoLabels), /neither a group nor an entry: - \*\*A\*\* \*\*B\*\*/);
});

test('a chained node declaration is refused, not absorbed into a label', () => {
   const chained = mutatedMap((map) =>
      map.map((line) =>
         line.includes('cat_domain["') ? '  cat_domain["📖 Domain · 1 doc"] --> extra["📦 Extra · 1 doc"]' : line,
      ),
   );
   assert.throws(
      () => parseOverview(chained),
      /statement this parser does not read: cat_domain\["📖 Domain · 1 doc"\] --> extra\["📦 Extra · 1 doc"\]/,
   );
});
