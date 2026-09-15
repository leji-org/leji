import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blobSha, checkDrift, PROSE_SOURCES, type ProseSource } from '../../../scripts/site-i18n-drift.ts';

// The drift gate, checked against trees built for it rather than against the site.
// The site's own tree is the one thing these assertions cannot use: it is current by
// definition on the day it ships, so nothing in it can show what the gate does when a
// translation falls behind, which is the only behaviour worth having.
//
// The property under all of it: a translated page is compared against every English
// file its reader sees, and a page the gate does not compare cannot exist.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..', '..');

const ENGLISH_QUICKSTART = 'a quickstart, in English\n';
const ENGLISH_ADOPTION_PAGE = '<Doc>the adoption wrapper</Doc>\n';
const ENGLISH_ADOPTION_PROSE = '# Adoption\n\nthe prose the wrapper renders\n';
const ENGLISH_SPEC_README = '# The specification\n';

const temps: string[] = [];

function write(root: string, rel: string, content: string): void {
   const full = path.join(root, rel);
   fs.mkdirSync(path.dirname(full), { recursive: true });
   fs.writeFileSync(full, content);
}

function sha(root: string, rel: string): string {
   return blobSha(fs.readFileSync(path.join(root, rel)));
}

/** A minimal repository: one locale, a plain page, a wrapper page over repo-root prose,
 *  one specification document, and the locale's specification route, which records
 *  nothing because it renders the documents rather than translating anything. */
function tree(): string {
   const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-i18n-drift-'));
   temps.push(root);

   write(root, 'spec/README.md', ENGLISH_SPEC_README);
   write(root, 'adoption/README.md', ENGLISH_ADOPTION_PROSE);
   write(root, 'packages/site/src/pages/quickstart.astro', ENGLISH_QUICKSTART);
   write(root, 'packages/site/src/pages/adoption.astro', ENGLISH_ADOPTION_PAGE);
   // The reference file documents the strings; it is not a language and must not be
   // read as one, or the gate would look for pages under `src/pages/en.reference`.
   write(root, 'packages/site/src/data/i18n/en.reference.json', '{}\n');
   write(root, 'packages/site/src/data/i18n/vi.json', '{}\n');

   write(
      root,
      'packages/site/src/pages/vi/quickstart.astro',
      page(sha(root, 'packages/site/src/pages/quickstart.astro')),
   );
   write(root, 'packages/site/src/pages/vi/adoption.astro', page(sha(root, 'packages/site/src/pages/adoption.astro')));
   write(
      root,
      'packages/site/src/pages/vi/spec/[...slug].astro',
      '---\nimport Base from "../../../layouts/Base.astro";\n---\n',
   );
   write(root, 'packages/site/src/content/i18n/vi/spec/readme.md', doc(sha(root, 'spec/README.md')));
   return root;
}

function page(source: string): string {
   return `---\nconst source = '${source}';\n---\n\n<p>bản dịch</p>\n`;
}

function doc(source: string): string {
   return `---\nsource: "${source}"\n---\n\n# Đặc tả\n`;
}

/** The schema reference is two more families per schema a locale translates: the schema
 *  it renders and the example instance beside it, both read from the locale's map rather
 *  than from a page, because the page renders whatever the map holds. A real schema name
 *  and its real example path, because the shipped inventory is what names the file. */
const ENGLISH_SCHEMA = '{ "title": "Leji context manifest (leji.json)" }\n';
const ENGLISH_EXAMPLE = '{ "description": "a manifest" }\n';

function withSchemaMap(root: string, sources?: { schema: string; example: string }): string {
   write(root, 'schemas/context-manifest.schema.json', ENGLISH_SCHEMA);
   write(root, 'examples/monorepo/leji.json', ENGLISH_EXAMPLE);
   write(
      root,
      'packages/site/src/data/i18n/schemas/vi.json',
      JSON.stringify({
         'context-manifest': {
            source: sources?.schema ?? sha(root, 'schemas/context-manifest.schema.json'),
            strings: { '/title': 'Context manifest của Leji (leji.json)' },
            example: {
               source: sources?.example ?? sha(root, 'examples/monorepo/leji.json'),
               strings: { '/description': 'một manifest' },
            },
         },
      }),
   );
   return root;
}

/** What the shipped map declares for the wrapper page this tree has. */
function proseMap(root: string, source = sha(root, 'adoption/README.md')): Record<string, ProseSource> {
   return { 'packages/site/src/pages/adoption.astro': { file: 'adoption/README.md', source } };
}

after(() => {
   for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

test('a blob sha is the one git records, so the gate can read the tree instead of history', () => {
   const rel = 'packages/site/src/pages/quickstart.astro';
   const git = spawnSync('git', ['hash-object', rel], { cwd: repoRoot, encoding: 'utf8' });
   assert.equal(git.status, 0, git.stderr);
   assert.equal(sha(repoRoot, rel), git.stdout.trim());
});

test('a tree whose translations follow the current English revisions passes', () => {
   const root = tree();
   const report = checkDrift(root, proseMap(root));
   assert.deepEqual(report.drifted, []);
   assert.equal(report.pages, 3);
   // Three pages, and the wrapper page compared against its prose as well.
   assert.equal(report.checked, 4);
});

test('an English page that moved names the translation and both revisions', () => {
   const root = tree();
   const recorded = sha(root, 'packages/site/src/pages/quickstart.astro');
   write(root, 'packages/site/src/pages/quickstart.astro', `${ENGLISH_QUICKSTART}a new paragraph\n`);
   const { drifted } = checkDrift(root, proseMap(root));
   assert.deepEqual(drifted, [
      {
         page: 'vi/quickstart',
         file: 'packages/site/src/pages/quickstart.astro',
         recorded,
         current: sha(root, 'packages/site/src/pages/quickstart.astro'),
      },
   ]);
});

test('prose behind a wrapper page drifts even though the page it wraps has not', () => {
   const root = tree();
   const recorded = sha(root, 'adoption/README.md');
   const map = proseMap(root, recorded);
   write(root, 'adoption/README.md', `${ENGLISH_ADOPTION_PROSE}\na paragraph the translation has never seen\n`);
   const { drifted } = checkDrift(root, map);
   assert.deepEqual(drifted, [
      {
         page: 'vi/adoption',
         file: 'adoption/README.md',
         recorded,
         current: sha(root, 'adoption/README.md'),
      },
   ]);
   // The wrapper page itself is untouched, which is exactly why its own sha proves
   // nothing about the prose a reader of that route sees.
   assert.equal(
      fs.readFileSync(path.join(root, 'packages/site/src/pages/adoption.astro'), 'utf8'),
      ENGLISH_ADOPTION_PAGE,
   );
});

test('a translated specification document follows the English document it renders', () => {
   const root = tree();
   const recorded = sha(root, 'spec/README.md');
   write(root, 'spec/README.md', `${ENGLISH_SPEC_README}\nnormative text that changed\n`);
   const { drifted } = checkDrift(root, proseMap(root));
   assert.deepEqual(drifted, [
      { page: 'vi/spec/readme', file: 'spec/README.md', recorded, current: sha(root, 'spec/README.md') },
   ]);
});

test('an English source that is gone is drift, not a page the gate quietly passes', () => {
   const root = tree();
   const recorded = sha(root, 'packages/site/src/pages/quickstart.astro');
   fs.rmSync(path.join(root, 'packages/site/src/pages/quickstart.astro'));
   const { drifted } = checkDrift(root, proseMap(root));
   assert.deepEqual(drifted, [
      { page: 'vi/quickstart', file: 'packages/site/src/pages/quickstart.astro', recorded, current: null },
   ]);
});

test('a translated page that records no revision fails rather than escaping the gate', () => {
   const root = tree();
   write(root, 'packages/site/src/pages/vi/mcp.astro', '---\n---\n\n<p>bản dịch</p>\n');
   assert.throws(() => checkDrift(root, proseMap(root)), /vi\/mcp\.astro records no source blob/);
});

test('a locale that translates a schema follows both the schema and its example', () => {
   const root = withSchemaMap(tree());
   const report = checkDrift(root, proseMap(root));
   assert.deepEqual(report.drifted, []);
   // The three pages of the base tree, plus the schema and the example beside it.
   assert.equal(report.pages, 5);
   assert.equal(report.checked, 6);
});

test('an edited schema drifts every locale that maps it', () => {
   const root = withSchemaMap(tree());
   const recorded = sha(root, 'schemas/context-manifest.schema.json');
   write(root, 'schemas/context-manifest.schema.json', '{ "title": "Leji context manifest", "type": "object" }\n');
   const { drifted } = checkDrift(root, proseMap(root));
   assert.deepEqual(drifted, [
      {
         page: 'vi/schemas/context-manifest',
         file: 'schemas/context-manifest.schema.json',
         recorded,
         current: sha(root, 'schemas/context-manifest.schema.json'),
      },
   ]);
});

test('an edited example drifts the translation of the page that shows it', () => {
   const root = withSchemaMap(tree());
   const recorded = sha(root, 'examples/monorepo/leji.json');
   write(root, 'examples/monorepo/leji.json', '{ "description": "a manifest with one more field", "leji": "1.0" }\n');
   const { drifted } = checkDrift(root, proseMap(root));
   assert.deepEqual(drifted, [
      {
         page: 'vi/schemas/context-manifest (example)',
         file: 'examples/monorepo/leji.json',
         recorded,
         current: sha(root, 'examples/monorepo/leji.json'),
      },
   ]);
});

test('a map entry with no usable revision fails rather than escaping the gate', () => {
   const root = withSchemaMap(tree(), { schema: '', example: '' });
   assert.throws(() => checkDrift(root, proseMap(root)), /records no source blob for schemas\/context-manifest/);
});

test('the shipped prose map names files this repository actually has', () => {
   for (const [wrapper, prose] of Object.entries(PROSE_SOURCES)) {
      assert.ok(fs.existsSync(path.join(repoRoot, wrapper)), wrapper);
      assert.ok(fs.existsSync(path.join(repoRoot, prose.file)), prose.file);
   }
});
