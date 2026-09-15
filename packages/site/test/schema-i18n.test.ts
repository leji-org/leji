import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SCHEMA_EXAMPLES } from '../src/data/schema-examples.ts';
import { PAGE_KIND_KEYS, SCHEMA_LABEL_KEYS, SCHEMA_LABELS } from '../src/data/schema-labels.ts';
import {
   assertExamplesComplete,
   checkSchemaMap,
   checkedExample,
   compareStructure,
   exampleProjection,
   type JsonValue,
   type LocaleSchemaMap,
   localizeSchema,
   parseExample,
   parseFrontmatter,
   projectedStrings,
   readSchemaSources,
   renderExample,
   schemaInventory,
   schemaMapInputs,
   schemaProjection,
   schemaRouteFamily,
   validateLocalizedExample,
} from '../src/schema-i18n.ts';

// The translated schema reference, checked against the published schemas and against
// input nobody should ever write.
//
// The property under all of it: what a schema page renders and what a locale must
// translate are one answer. A string on the page is a pointer in the projection, a
// pointer in the projection is a key the locale map carries, and anything else — a
// missing key, a key nothing renders, a translation that broke the instance it renders,
// a route advertised without a page — fails the build rather than reaching a reader.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..', '..');
const sources = readSchemaSources(repoRoot);
const inputs = schemaMapInputs(sources);
const manifest = sources.find((source) => source.name === 'context-manifest')!;

const mapDir = path.join(testDir, '..', 'src', 'data', 'i18n', 'schemas');

/** A map with every string set to a marker, which is what a well-formed one looks like
 *  before anybody argues about the words. */
function stubMap(): LocaleSchemaMap {
   const blob = 'a'.repeat(40);
   return Object.fromEntries(
      sources.map((source) => {
         const projection = inputs.projections[source.name];
         return [
            source.name,
            {
               source: blob,
               strings: Object.fromEntries([...projection.schema.keys()].map((key) => [key, `translated ${key}`])),
               example: {
                  source: blob,
                  strings: Object.fromEntries([...projection.example.keys()].map((key) => [key, `dịch ${key}`])),
                  ...(projection.markdown ? { body: 'thân bài đã dịch' } : {}),
               },
            },
         ];
      }),
   );
}

// ---------------------------------------------------------------------------
// The projection: what the page renders is what the locale translates
// ---------------------------------------------------------------------------

test('a pointer names the place in the schema the rendered string actually lives', () => {
   const strings = projectedStrings(schemaProjection(manifest.schema));
   for (const [pointer, text] of strings) {
      const at = pointer
         .slice(1)
         .split('/')
         .reduce<any>((node, token) => node?.[token], manifest.schema);
      assert.equal(at, text, pointer);
   }
   assert.equal(strings.get('/title'), 'Leji context manifest (leji.json)');
   assert.ok(strings.has('/properties/viewer/properties/theme/properties/link/description'));
});

test('a description several fields share is one pointer, not one per field', () => {
   const strings = projectedStrings(schemaProjection(manifest.schema));
   const shared = [...strings.keys()].filter((key) => key.startsWith('/$defs/categoryMapping/'));
   assert.deepEqual(shared, ['/$defs/categoryMapping/properties/indexes/description']);
   const categories = schemaProjection(manifest.schema).fields.find((field) => field.name === 'categories')!;
   assert.equal(categories.shared?.length, 1, 'the shared shape is hoisted out of the five categories');
   assert.deepEqual(
      categories.children.map((child) => child.children.length),
      [0, 0, 0, 0, 0],
      'and no sibling repeats it',
   );
});

test('the schema keeps its own tokens: enum values and JSON types are never phrase keys', () => {
   const fields = schemaProjection(manifest.schema).fields;
   const conformance = fields.find((field) => field.name === 'conformance')!;
   const level = conformance.children.find((child) => child.name === 'claimedLevel')!;
   assert.deepEqual(level.type, { literal: '"core" · "indexed" · "governed" · "federated"' });
   assert.deepEqual(fields.find((field) => field.name === 'name')!.type, { literal: 'string' });
   assert.deepEqual(fields.find((field) => field.name === 'agents')!.type, { key: 'map' });
   assert.deepEqual(fields.find((field) => field.name === 'vendorAdapters')!.type, { key: 'arrayOfStrings' });
});

test('every rendered type shape has a phrase, and every phrase has a key on the inventory', () => {
   const seen = new Set<string>();
   const walk = (fields: ReturnType<typeof schemaProjection>['fields']) => {
      for (const field of fields) {
         if ('key' in field.type) seen.add(field.type.key);
         walk(field.children);
         if (field.shared) walk(field.shared);
      }
   };
   for (const source of sources) walk(schemaProjection(source.schema).fields);
   assert.ok(seen.size > 0, 'no phrases at all: the scan is broken, not the schemas');
   for (const key of seen) assert.ok(SCHEMA_LABEL_KEYS.includes(key as never), `${key} is not on the inventory`);
   assert.ok(seen.has('arrayOfEnum'), 'the published schemas do render an array of enum values');
});

test('localizing replaces the projected strings and touches nothing else', () => {
   const strings = { '/title': 'Tiêu đề', '/properties/name/description': 'Mô tả' };
   const localized = localizeSchema(manifest.schema, strings);
   assert.equal(localized.title, 'Tiêu đề');
   assert.equal(localized.properties.name.description, 'Mô tả');
   assert.equal(localized.$id, manifest.schema.$id);
   assert.equal(manifest.schema.title, 'Leji context manifest (leji.json)', 'the published schema is not mutated');
});

test('localizing a place the schema does not have fails rather than inventing one', () => {
   assert.throws(
      () => localizeSchema(manifest.schema, { '/properties/nope/description': 'x' }),
      /nothing to translate/,
   );
});

// ---------------------------------------------------------------------------
// The examples
// ---------------------------------------------------------------------------

test('every published example is rebuilt from its own projection byte for byte', () => {
   for (const source of sources) {
      assert.equal(renderExample(source.parsed), source.exampleRaw, source.example.file);
   }
});

test('the projection reads prose and leaves the machine surface alone', () => {
   const profile = sources.find((source) => source.name === 'agent-profile')!;
   assert.deepEqual(
      exampleProjection(profile.parsed.instance).map((one) => one.pointer),
      ['/purpose', '/invocation/constraints/0', '/invocation/constraints/1', '/mustAskWhen/0', '/mustAskWhen/1'],
   );
   const index = sources.find((source) => source.name === 'context-index')!;
   const pointers = exampleProjection(index.parsed.instance).map((one) => one.pointer);
   assert.ok(pointers.includes('/entries/1/summary'));
   assert.ok(!pointers.some((pointer) => pointer.endsWith('/path')), 'a path is not prose');
   assert.ok(!pointers.some((pointer) => pointer.endsWith('/id')), 'an id is not prose');
   assert.ok(!pointers.includes('/generator/name'), 'a tool name is not prose');
});

test('frontmatter that is not the shape Leji artifacts are written in fails loudly', () => {
   assert.throws(() => parseFrontmatter('id: one\n  ? weird', 0), /not a mapping, a scalar or a list item/);
   assert.throws(() => parseFrontmatter('id: one\nid: two', 0), /names id twice/);
});

test('a localized example that broke its own document fails before it renders', () => {
   const profile = sources.find((source) => source.name === 'agent-profile')!;
   const good = {
      source: 'b'.repeat(40),
      strings: Object.fromEntries(exampleProjection(profile.parsed.instance).map((one) => [one.pointer, 'đã dịch'])),
      body: '# thân bài',
   };
   assert.ok(checkedExample(profile.parsed, good, profile.schema, 'test').includes('đã dịch'));
   // A value that reopens the document as a different one is caught by reading the
   // rendered document back: here a second `id`, which the frontmatter cannot have.
   const broken = { ...good, strings: { ...good.strings, '/purpose': 'một dòng\nid: khác' } };
   assert.throws(() => checkedExample(profile.parsed, broken, profile.schema, 'test'), /names id twice/);
});

test('the structural comparison rejects a changed value the translation does not carry', () => {
   const english = { id: 'a', entries: [{ summary: 'one', path: 'docs/a.md' }] };
   const allowed = new Set(['/entries/0/summary']);
   compareStructure(english, { id: 'a', entries: [{ summary: 'một', path: 'docs/a.md' }] }, allowed);
   assert.throws(
      () => compareStructure(english, { id: 'a', entries: [{ summary: 'một', path: 'docs/b.md' }] }, allowed),
      /changes a value the translation does not carry/,
   );
   assert.throws(
      () => compareStructure(english, { id: 'a', entries: [{ summary: 'một' }] }, allowed),
      /changes the keys/,
   );
});

test('a localized example the schema will not accept fails against the whole schema', () => {
   const record = sources.find((source) => source.name === 'decision-record')!;
   const instance = record.parsed.instance as Record<string, JsonValue>;
   validateLocalizedExample(record.schema, instance, 'test');

   // A value of the wrong type, reported with the validator's own words rather than the
   // site's guess at which keyword failed.
   assert.throws(
      () => validateLocalizedExample(record.schema, { ...instance, deciders: 'Jo Lee' }, 'test'),
      /test: the localized example does not satisfy its schema: \/deciders must be array/,
   );
   // A required key the document lost. Nothing a per-pointer walk of the translated
   // strings could see: the key that went missing is not one of them.
   const { date: _date, ...withoutDate } = instance;
   assert.throws(
      () => validateLocalizedExample(record.schema, withoutDate, 'test'),
      /must have required property 'date'/,
   );
   // An enum value translated as though it were prose, when it is an identifier.
   assert.throws(
      () => validateLocalizedExample(record.schema, { ...instance, status: 'chấp nhận' }, 'test'),
      /\/status must be equal to one of the allowed values/,
   );
   // A string constraint on a field the translation does carry: length, and pattern.
   assert.throws(() => validateLocalizedExample(record.schema, { ...instance, title: '' }, 'test'), /NOT have fewer/);
   assert.throws(
      () => validateLocalizedExample(record.schema, { ...instance, id: 'Áp dụng' }, 'test'),
      /\/id must match pattern/,
   );
});

test('every schema has an example and every example has a schema', () => {
   const inventory = sources.map((source) => source.name);
   assertExamplesComplete(inventory);
   assert.throws(() => assertExamplesComplete([...inventory, 'no-such-schema']), /no example instance/);
   assert.throws(() => assertExamplesComplete(inventory.slice(1)), /which is not a schema/);
   assert.deepEqual(Object.keys(SCHEMA_EXAMPLES).sort(), inventory);
});

// ---------------------------------------------------------------------------
// The locale maps
// ---------------------------------------------------------------------------

test('a map that does not name the schemas on disk fails, either way round', () => {
   const short = stubMap();
   delete short['decision-record'];
   assert.throws(() => checkSchemaMap('vi', short, inputs), /missing decision-record/);
   assert.throws(
      () => checkSchemaMap('vi', { ...stubMap(), 'no-such-schema': stubMap()['decision-record'] }, inputs),
      /no-such-schema/,
   );
});

test('a missing rendered string and a string nothing renders both fail, naming it', () => {
   const missing = stubMap();
   delete missing['decision-record'].strings['/properties/status/description'];
   assert.throws(() => checkSchemaMap('vi', missing, inputs), /missing \/properties\/status\/description/);

   const extra = stubMap();
   extra['decision-record'].strings['/properties/status/title'] = 'x';
   assert.throws(() => checkSchemaMap('vi', extra, inputs), /which nothing renders/);

   const blank = stubMap();
   blank['decision-record'].strings['/properties/status/description'] = '   ';
   assert.throws(() => checkSchemaMap('vi', blank, inputs), /no translation at/);
});

test('a missing example string, and a body only a markdown example has', () => {
   const missing = stubMap();
   delete missing['decision-record'].example.strings['/title'];
   assert.throws(() => checkSchemaMap('vi', missing, inputs), /'s example does not carry every string/);

   const noBody = stubMap();
   delete noBody['agent-profile'].example.body;
   assert.throws(() => checkSchemaMap('vi', noBody, inputs), /needs a localized body/);

   const strayBody = stubMap();
   strayBody['context-index'].example.body = 'nothing renders this';
   assert.throws(() => checkSchemaMap('vi', strayBody, inputs), /a body nothing renders/);
});

test('an entry with no usable revision fails: a translation the gate cannot compare', () => {
   const noSchemaBlob = stubMap();
   noSchemaBlob['context-index'].source = 'not-a-blob';
   assert.throws(() => checkSchemaMap('vi', noSchemaBlob, inputs), /no source blob for the schema/);

   const noExampleBlob = stubMap();
   noExampleBlob['context-index'].example.source = '';
   assert.throws(() => checkSchemaMap('vi', noExampleBlob, inputs), /no source blob for the example/);
});

test('every locale map that ships passes the same checks, and renders its examples', () => {
   const files = fs.existsSync(mapDir) ? fs.readdirSync(mapDir).filter((name) => name.endsWith('.json')) : [];
   assert.ok(files.length > 0, 'no schema translations at all: the scan is broken, not the source');
   for (const file of files) {
      const locale = file.slice(0, -'.json'.length);
      const map = checkSchemaMap(locale, JSON.parse(fs.readFileSync(path.join(mapDir, file), 'utf8')), inputs);
      for (const source of sources) {
         const entry = map[source.name];
         localizeSchema(source.schema, entry.strings);
         checkedExample(source.parsed, entry.example, source.schema, `${locale} ${source.name}`);
      }
   }
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('a locale serves the whole family once its route file exists, and none before', () => {
   const inventory = schemaInventory(fs.readdirSync(path.join(repoRoot, 'schemas')));
   assert.equal(inventory.length, 5);
   const withRoute = schemaRouteFamily(
      ['./pages/vi/schemas/[name].astro', './pages/vi/schemas/index.astro'],
      inventory,
   );
   assert.deepEqual(
      withRoute,
      inventory.map((name) => ({ locale: 'vi', routeKey: `/schemas/${name}` })),
   );
   assert.deepEqual(schemaRouteFamily(['./pages/ja/schemas/index.astro'], inventory), []);
   assert.deepEqual(schemaRouteFamily(['./pages/ja/quickstart.astro'], inventory), []);
});

test('the registry records no route for a dynamic route file, which is machinery', () => {
   const registry = fs.readFileSync(path.join(testDir, '..', 'src', 'i18n.ts'), 'utf8');
   assert.match(registry, /const DYNAMIC_ROUTE = /, 'src/i18n.ts no longer skips dynamic route files');
   assert.match(registry, /if \(DYNAMIC_ROUTE\.test\(file\)\) continue;/);
});

test('the English chrome is the inventory every locale is checked against', () => {
   assert.deepEqual(SCHEMA_LABEL_KEYS, Object.keys(SCHEMA_LABELS));
   assert.equal(SCHEMA_LABELS.linkTo.includes('{name}'), true);
   assert.equal(SCHEMA_LABELS.arrayOfEnum.includes('{values}'), true);
   assert.deepEqual(PAGE_KIND_KEYS, ['normative', 'reference', 'guide', 'background', 'governance']);
});
