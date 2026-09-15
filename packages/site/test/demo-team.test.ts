import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The site shows one demo team, everywhere it shows a fiction: the hero's terminal
// and viewer window, the manifest panel under them, and the worked example the spec
// pages render. Before, the homepage had one invented team and the example repository
// another, and a reader crossing between them met two companies.
//
// So this file checks the two halves of that. Under src/, the names the homepage
// retired are gone; a returning one would be a second fiction, not a typo. In the
// example layer, the manifest owner is the team, and the changelog's newest entry is
// the handover that put them there.
//
// What is deliberately not asserted: the example's older entries and its decision
// record. The example is a layer under Leji's own rules, and those rules make
// surviving changelog entries immutable, so ownership moves by an appended entry,
// and the history keeps the name it was written with. Nothing wider either:
// `jo@acme.example` is an ordinary placeholder in the SDK fixtures and stays one.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, '..', 'src');
const exampleDir = path.resolve(testDir, '..', '..', '..', 'examples', 'monorepo');

const TEAM = 'Acme Platform Team';
const CONTACT = 'platform@acme.example';
/** The names the homepage's single demo team replaced. */
const RETIRED = ['AI-native Team', 'ai-native-repo', 'ai-native-team-context', 'John Smith'];

/** Every file the site is built from. */
function sources(dir: string, out: string[] = []): string[] {
   for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) sources(abs, out);
      else if (entry.isFile()) out.push(abs);
   }
   return out;
}

const read = (abs: string): string => fs.readFileSync(abs, 'utf8');

test('no retired demo name survives under src/', () => {
   const found: string[] = [];
   for (const abs of sources(srcDir)) {
      const source = read(abs);
      for (const name of RETIRED) {
         if (source.includes(name)) found.push(`${path.relative(srcDir, abs)}: ${name}`);
      }
   }
   assert.deepEqual(found, [], `a retired demo name is back:\n${found.join('\n')}`);
});

test('the example layer is owned by the demo team', () => {
   const manifest = JSON.parse(read(path.join(exampleDir, 'leji.json'))) as {
      owners: { primary: { name: string; contact: string } };
   };
   assert.equal(manifest.owners.primary.name, TEAM);
   assert.equal(manifest.owners.primary.contact, CONTACT);
});

test('the example changelog closes on the handover to the demo team', () => {
   const changelog = JSON.parse(read(path.join(exampleDir, 'docs', 'context-changelog.json'))) as {
      entries: { summary: string; approvedBy?: string }[];
   };
   const latest = changelog.entries[changelog.entries.length - 1];
   assert.ok(latest, 'the example changelog records nothing at all');
   assert.equal(latest.approvedBy, TEAM, 'the newest example changelog entry is approved by someone else');
   assert.ok(
      latest.summary.includes(TEAM) && /ownership/i.test(latest.summary),
      `the newest example changelog entry does not record the handover: ${latest.summary}`,
   );
});
