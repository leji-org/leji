// The translated schema reference: one projection of what a schema page renders, and
// the locale maps that supply each rendered string in another language.
//
// The projection is the single authority. The English page, a translated page, the
// field-table component and the completeness check all read the same tree, so what is
// rendered and what must be translated cannot drift apart: a string the page shows is
// a pointer in the tree, and a pointer in the tree is a key the locale map must carry.
// Strings the pages never render are not in the tree and are never translated.
//
// A pointer is a JSON pointer into the schema document itself, so a description shared
// by several fields through one `$defs` entry is one key rather than several, and every
// translation is bound to the exact place the English text lives.
//
// Everything here is pure but for `schemaMaps`, which reads the locale files, so the
// module loads under plain Node and the rules can be tested against data handed
// straight to them rather than only through a build.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { type ExampleFormat, SCHEMA_EXAMPLES, type SchemaExample, schemaExample } from './data/schema-examples.ts';
import type { SchemaLabelKey } from './data/schema-labels.ts';
import { REPO_ROOT } from './repo-root.ts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A schema, as far as this module reads one: an object of JSON Schema keywords. */
export type Schema = Record<string, any>;

/** A rendered type: either a chrome phrase the locale supplies, or the schema's own
 *  literal tokens (a JSON type identifier, or enum values), which are never translated.
 *  `values` carries those tokens into the phrase that frames them. */
export type FieldType = { literal: string } | { key: SchemaLabelKey; values?: string };

/** One rendered field of the field table, at the depth the table draws it. */
export interface ProjectedField {
   name: string;
   /** Where this field's description lives in the schema, or null where it has none. */
   pointer: string | null;
   text: string;
   required: boolean;
   type: FieldType;
   /** Rendered as literal source beneath the description. */
   pattern?: string;
   /** The `$ref` this field points at, which is what makes a shared shape shared. */
   ref: string | null;
   children: ProjectedField[];
   /** The one shape several sibling keys share, hoisted out of them; null otherwise. */
   shared: ProjectedField[] | null;
}

/** A rendered string and where it lives. */
export interface Projected {
   pointer: string;
   text: string;
}

/** The whole render tree of one schema page. */
export interface SchemaProjection {
   title: Projected | null;
   description: Projected | null;
   fields: ProjectedField[];
}

/** RFC 6901 escaping, so a key carrying `/` or `~` still names one place. */
function escapeToken(token: string): string {
   return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeToken(token: string): string {
   return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function pointerTokens(pointer: string): string[] {
   if (pointer === '') return [];
   if (!pointer.startsWith('/')) throw new Error(`not a JSON pointer: ${pointer}`);
   return pointer.slice(1).split('/').map(unescapeToken);
}

/** A `$ref` resolved against the root's `$defs`, with the pointer that names where it
 *  landed. An unresolvable ref stays where it is, exactly as the field table has always
 *  rendered it: the reference page shows the shape it can see. */
function resolveRef(root: Schema, node: any, pointer: string): { node: any; pointer: string } {
   if (node?.$ref) {
      const def = String(node.$ref).split('/').pop() as string;
      const target = root.$defs?.[def];
      if (target) return { node: target, pointer: `/$defs/${escapeToken(def)}` };
   }
   return { node, pointer };
}

/** The quoted enum values a type phrase frames, joined as the page prints them. */
function enumValues(values: unknown[]): string {
   return values.map((value) => `"${String(value)}"`).join(' · ');
}

const ARRAY_OF: Record<string, SchemaLabelKey> = {
   string: 'arrayOfStrings',
   number: 'arrayOfNumbers',
   boolean: 'arrayOfBooleans',
   integer: 'arrayOfIntegers',
};

/** The type the field table shows, with `$ref`s resolved to their target's type. */
function typeOf(root: Schema, prop: any): FieldType {
   if (!prop) return { key: 'value' };
   if (prop.$ref) return typeOf(root, resolveRef(root, prop, '').node);
   if (prop.enum) return { literal: enumValues(prop.enum) };
   if (prop.type === 'array') {
      const items = resolveRef(root, prop.items ?? {}, '').node;
      if (items.enum) return { key: 'arrayOfEnum', values: enumValues(items.enum) };
      if (items.properties || items.type === 'object') return { key: 'arrayOfObjects' };
      if (items.type === undefined) return { key: 'arrayOfItems' };
      const key = ARRAY_OF[items.type];
      if (!key) throw new Error(`no rendered phrase for an array of ${items.type}: add one to schema-labels.ts`);
      return { key };
   }
   if (prop.patternProperties) return { key: 'map' };
   return prop.type ? { literal: String(prop.type) } : { key: 'value' };
}

function childrenOf(root: Schema, prop: any, pointer: string, depth: number): ProjectedField[] {
   if (depth <= 0) return [];
   const target =
      prop.type === 'array' ? resolveRef(root, prop.items ?? {}, `${pointer}/items`) : resolveRef(root, prop, pointer);
   const required = new Set<string>(target.node.required ?? []);
   return Object.entries(target.node.properties ?? {}).map(([name, sub]: [string, any]) => {
      const at = `${target.pointer}/properties/${escapeToken(name)}`;
      return {
         name,
         pointer: typeof sub.description === 'string' ? `${at}/description` : null,
         text: sub.description ?? '',
         required: required.has(name),
         type: typeOf(root, sub),
         ref: sub.$ref ?? null,
         children: childrenOf(root, sub, at, depth - 1),
         shared: null,
      };
   });
}

/**
 * Siblings that all resolve to the same `$def` describe one shape, not several.
 * Rendering each in full repeats that shape verbatim per sibling: the five
 * category entries all point at `categoryMapping`, so its `indexes` description
 * was emitted five times. Hoist the shared shape and keep each sibling's own
 * description, which is the part that actually differs.
 */
function hoistSharedShape(sub: ProjectedField[]): { children: ProjectedField[]; shared: ProjectedField[] | null } {
   const refs = sub.map((entry) => entry.ref);
   const allSame = sub.length > 1 && refs[0] && refs.every((ref) => ref === refs[0]);
   const haveChildren = sub.every((entry) => entry.children.length > 0);
   if (!allSame || !haveChildren) return { children: sub, shared: null };
   return { children: sub.map((entry) => ({ ...entry, children: [] })), shared: sub[0].children };
}

function projectedString(text: unknown, pointer: string): Projected | null {
   return typeof text === 'string' ? { pointer, text } : null;
}

/** The render tree of one schema: its title and description, then every field the table
 *  draws, two levels deep with `$defs` resolved, exactly as the page shows them. */
export function schemaProjection(schema: Schema): SchemaProjection {
   const required = new Set<string>(schema.required ?? []);
   const fields = Object.entries(schema.properties ?? {})
      .filter(([name]) => name !== '$schema')
      .map(([name, prop]: [string, any]) => {
         const at = `/properties/${escapeToken(name)}`;
         return {
            name,
            pointer: typeof prop.description === 'string' ? `${at}/description` : null,
            text: prop.description ?? '',
            required: required.has(name),
            type: typeOf(schema, prop),
            pattern: prop.pattern,
            ref: prop.$ref ?? null,
            ...hoistSharedShape(childrenOf(schema, prop, at, 2)),
         };
      });
   return {
      title: projectedString(schema.title, '/title'),
      description: projectedString(schema.description, '/description'),
      fields,
   };
}

function collectFields(fields: ProjectedField[], out: Map<string, string>): void {
   for (const field of fields) {
      if (field.pointer) out.set(field.pointer, field.text);
      collectFields(field.children, out);
      if (field.shared) collectFields(field.shared, out);
   }
}

/** Every string the page renders from the schema, by where it lives. One entry per
 *  place, so a description several fields share is translated once. */
export function projectedStrings(projection: SchemaProjection): Map<string, string> {
   const out = new Map<string, string>();
   for (const entry of [projection.title, projection.description]) if (entry) out.set(entry.pointer, entry.text);
   collectFields(projection.fields, out);
   return out;
}

function setAt(root: any, pointer: string, value: string): void {
   const tokens = pointerTokens(pointer);
   let node = root;
   for (const token of tokens.slice(0, -1)) {
      node = node?.[token];
      if (node === undefined || node === null) throw new Error(`nothing to translate at ${pointer}`);
   }
   const last = tokens[tokens.length - 1];
   if (node?.[last] === undefined) throw new Error(`nothing to translate at ${pointer}`);
   node[last] = value;
}

/** The schema with every projected string replaced by the locale's. A deep copy: the
 *  schema itself is a published artifact and the raw file is served untouched. */
export function localizeSchema(schema: Schema, strings: Record<string, string>): Schema {
   const localized = structuredClone(schema) as Schema;
   for (const [pointer, text] of Object.entries(strings)) setAt(localized, pointer, text);
   return localized;
}

// ---------------------------------------------------------------------------
// The example instances
// ---------------------------------------------------------------------------

/** The keys whose string values are prose a reader reads, rather than data a tool
 *  matches on. Everything else in an instance (names, ids, paths, dates, hashes, enum
 *  values, and the keys themselves) is the machine surface and stays as published.
 *
 *  `role` is deliberately absent: in a mount record it is prose, but in an agent profile
 *  it is the role identifier bound in the manifest's agents map, and one key list cannot
 *  tell those apart. Translating an identifier would break the binding the example is
 *  there to show. */
const PROSE_KEYS = new Set([
   'description',
   'summary',
   'title',
   'purpose',
   'constraints',
   'mustAskWhen',
   'mustRefuseWhen',
]);

function walkProse(value: JsonValue, pointer: string, key: string | null, out: Projected[]): void {
   if (typeof value === 'string') {
      if (key !== null && PROSE_KEYS.has(key)) out.push({ pointer, text: value });
      return;
   }
   if (Array.isArray(value)) {
      // The key travels with the elements: `constraints` is prose, so each of its
      // strings is, and `paths` is not, so none of its are.
      value.forEach((item, index) => walkProse(item, `${pointer}/${index}`, key, out));
      return;
   }
   if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
         walkProse(child, `${pointer}/${escapeToken(name)}`, name, out);
      }
   }
}

/** Every prose string inside an instance, by where it sits in that instance. */
export function exampleProjection(instance: JsonValue): Projected[] {
   const out: Projected[] = [];
   walkProse(instance, '', null, out);
   return out;
}

/** One scalar's place in the source text, so a translation is spliced where the value
 *  is rather than wherever its text happens to occur. */
interface Span {
   start: number;
   end: number;
}

export interface ParsedExample {
   format: ExampleFormat;
   /** What the schema validates: the JSON instance, or the parsed frontmatter. */
   instance: JsonValue;
   /** The markdown body beneath the frontmatter, trimmed; null for a JSON example. */
   body: string | null;
   /** The frontmatter block, `---` fences included; null for a JSON example. */
   frontmatter: string | null;
   /** Where each frontmatter scalar's value sits inside that block. */
   spans: Map<string, Span>;
}

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/;
/** A list item, a key opening a nested block, or a key with a scalar value. */
const ITEM = /^(\s*)- (.*)$/;
const BLOCK = /^(\s*)([A-Za-z_$][\w$-]*):[ \t]*$/;
const PAIR = /^(\s*)([A-Za-z_$][\w$-]*): (.*)$/;

/** A scalar's text and where it starts, quotes stripped where it carries them. */
function scalar(raw: string, lineStart: number, line: string): { text: string; start: number } {
   const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
   const text = quoted ? quoted[2] : raw;
   return { text, start: lineStart + line.length - raw.length + (quoted ? 1 : 0) };
}

function meaningful(line: string): boolean {
   return line.trim() !== '' && !line.trimStart().startsWith('#');
}

/** The YAML frontmatter of an example document, read as the flat scalar / sequence /
 *  mapping shape Leji's own artifacts are written in, and no more: an unrecognized
 *  construct fails the build rather than being silently dropped from a translation.
 *  Every scalar is read as a string, which is what the schemas declare these fields to
 *  be, and each records where it sits, so a localized document is the published file
 *  with its prose replaced in place rather than a re-serialization of it.
 *
 *  `offset` is where the block sits inside the text the spans are measured against. */
export function parseFrontmatter(block: string, offset: number): { data: JsonValue; spans: Map<string, Span> } {
   const spans = new Map<string, Span>();
   const root: Record<string, JsonValue> = {};
   const lines = block.split('\n');
   const starts: number[] = [];
   let at = offset;
   for (const line of lines) {
      starts.push(at);
      at += line.length + 1;
   }

   const stack: { indent: number; container: any; pointer: string }[] = [{ indent: -1, container: root, pointer: '' }];
   for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!meaningful(line)) continue;
      const item = ITEM.exec(line);
      const block_ = BLOCK.exec(line);
      const pair = PAIR.exec(line);
      const shape = item ?? block_ ?? pair;
      if (!shape) throw new Error(`frontmatter line is not a mapping, a scalar or a list item: ${line}`);
      const indent = shape[1].length;
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
      const frame = stack[stack.length - 1];

      if (item) {
         if (!Array.isArray(frame.container)) throw new Error(`a list item outside a list: ${line}`);
         const { text, start } = scalar(item[2], starts[index], line);
         spans.set(`${frame.pointer}/${frame.container.length}`, { start, end: start + text.length });
         frame.container.push(text);
         continue;
      }

      const key = (block_ ?? pair)![2];
      const pointer = `${frame.pointer}/${escapeToken(key)}`;
      if (key in frame.container) throw new Error(`frontmatter names ${key} twice`);
      if (pair) {
         const { text, start } = scalar(pair[3], starts[index], line);
         spans.set(pointer, { start, end: start + text.length });
         frame.container[key] = text;
         continue;
      }
      // A sequence and a mapping open the same way; the first line under the key says
      // which this is, so one frame per level covers both.
      const next = lines.slice(index + 1).find(meaningful);
      const list = next !== undefined && ITEM.test(next) && (ITEM.exec(next) as RegExpExecArray)[1].length > indent;
      const container = list ? [] : {};
      frame.container[key] = container;
      stack.push({ indent, container, pointer });
   }
   return { data: root as JsonValue, spans };
}

/** An example document, read for what its schema validates and for where its prose
 *  sits. */
export function parseExample(raw: string, format: ExampleFormat): ParsedExample {
   if (format === 'json') {
      return { format, instance: JSON.parse(raw) as JsonValue, body: null, frontmatter: null, spans: new Map() };
   }
   const found = FRONTMATTER.exec(raw);
   if (!found) throw new Error('a markdown example must open with YAML frontmatter');
   const { data, spans } = parseFrontmatter(found[2], found[1].length);
   return { format, instance: data, body: raw.slice(found[0].length).trim(), frontmatter: found[0], spans };
}

/** One locale's rendering of one example. */
export interface LocaleExample {
   /** The blob sha of the example file this translation follows. */
   source: string;
   strings: Record<string, string>;
   /** The localized markdown body; markdown examples only. */
   body?: string;
}

/** The instance with every projected prose string replaced by the locale's. */
export function localizeInstance(parsed: ParsedExample, strings: Record<string, string>): JsonValue {
   const localized = structuredClone(parsed.instance);
   for (const [pointer, text] of Object.entries(strings)) setAt(localized as any, pointer, text);
   return localized;
}

/** The file a translated example panel shows: the published document with its prose
 *  replaced where it sits, so indentation, ordering and every machine value are the
 *  publisher's rather than a renderer's. */
export function localizeExample(parsed: ParsedExample, entry: LocaleExample): string {
   if (parsed.format === 'json') return JSON.stringify(localizeInstance(parsed, entry.strings), null, 2);
   if (typeof entry.body !== 'string') throw new Error('a markdown example needs its localized body');
   const splices = Object.entries(entry.strings)
      .map(([pointer, text]) => {
         const span = parsed.spans.get(pointer);
         if (!span) throw new Error(`the example has no frontmatter value at ${pointer}`);
         return { span, text };
      })
      // Back to front, so an earlier splice never moves a later one's span.
      .sort((left, right) => right.span.start - left.span.start);
   let frontmatter = parsed.frontmatter as string;
   for (const { span, text } of splices) {
      frontmatter = frontmatter.slice(0, span.start) + text + frontmatter.slice(span.end);
   }
   return `${frontmatter}\n${entry.body}`;
}

/** The English document, rebuilt from its own projection. The identity every translated
 *  rendering rests on: what this returns for the English strings is the published file
 *  byte for byte, so what it returns for a locale differs only where that locale's prose
 *  does. */
export function renderExample(parsed: ParsedExample): string {
   const strings = Object.fromEntries(exampleProjection(parsed.instance).map((entry) => [entry.pointer, entry.text]));
   return localizeExample(parsed, { source: '', strings, body: parsed.body ?? undefined });
}

/** Everything the English and localized instances must have in common: the same keys in
 *  the same order, the same shapes, and the same values everywhere the translation is
 *  not allowed to differ. A localized instance that moved a machine value fails here
 *  rather than shipping an example that no longer means what the schema says. */
export function compareStructure(english: JsonValue, localized: JsonValue, allowed: Set<string>, at = ''): void {
   const kindOf = (value: JsonValue) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
   const where = at || '/';
   if (kindOf(english) !== kindOf(localized)) {
      throw new Error(
         `the localized example changes the shape at ${where}: ${kindOf(english)} became ${kindOf(localized)}`,
      );
   }
   if (Array.isArray(english) && Array.isArray(localized)) {
      if (english.length !== localized.length) throw new Error(`the localized example changes the items at ${where}`);
      english.forEach((item, index) => compareStructure(item, localized[index], allowed, `${at}/${index}`));
      return;
   }
   if (english && localized && typeof english === 'object' && typeof localized === 'object') {
      const mine = Object.keys(english);
      const theirs = Object.keys(localized as object);
      if (mine.join(' ') !== theirs.join(' ')) {
         throw new Error(`the localized example changes the keys at ${where}: ${theirs.join(', ')}`);
      }
      for (const key of mine) {
         const child = (value: JsonValue) => (value as Record<string, JsonValue>)[key];
         compareStructure(child(english), child(localized), allowed, `${at}/${escapeToken(key)}`);
      }
      return;
   }
   if (english !== localized && !allowed.has(at)) {
      throw new Error(`the localized example changes a value the translation does not carry, at ${where}`);
   }
}

/** One compiled validator per schema object, so a page that checks five locales against
 *  one schema compiles it once. A fresh `Ajv2020` per schema rather than one shared
 *  instance: the published schemas carry `$id`s, every read of them produces a new object
 *  for the same `$id`, and one instance refuses to compile an `$id` twice. Options and
 *  draft are the SDK's (`packages/sdk/src/lib/schemas.ts`), so the site accepts and
 *  rejects exactly what `leji validate` does. */
const validators = new WeakMap<Schema, ValidateFunction>();

function validatorFor(schema: Schema): ValidateFunction {
   let validate = validators.get(schema);
   if (!validate) {
      validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
      validators.set(schema, validate);
   }
   return validate;
}

/** The localized instance against the whole schema it exemplifies. A translation may only
 *  replace prose, but "only prose" is a claim about the edit, not about the document it
 *  produces, so the document is validated rather than the edit: the same validator the
 *  SDK runs, reading the same schema, over the instance the page is about to print. */
export function validateLocalizedExample(schema: Schema, instance: JsonValue, label: string): void {
   const validate = validatorFor(schema);
   if (validate(instance)) return;
   const said = (validate.errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message}`).join('; ');
   throw new Error(`${label}: the localized example does not satisfy its schema: ${said}`);
}

/** One locale's example panel, checked on the way out: the rendered document reads back
 *  as the instance it claims to be, differs from the published one only in the prose the
 *  locale carries, and still validates against the schema it exemplifies.
 *
 *  The two checks answer different questions and neither covers the other. The schema says
 *  what any conforming instance may be; the structural comparison says what *this* instance
 *  must stay, key order and every machine value included: so a translation that swapped one
 *  valid path, id or date for another is caught there while validating perfectly. */
export function checkedExample(parsed: ParsedExample, entry: LocaleExample, schema: Schema, label: string): string {
   const text = localizeExample(parsed, entry);
   const localized = localizeInstance(parsed, entry.strings);
   const reread = parseExample(text, parsed.format).instance;
   compareStructure(localized, reread, new Set());
   compareStructure(parsed.instance, localized, new Set(Object.keys(entry.strings)));
   validateLocalizedExample(schema, localized, label);
   return text;
}

// ---------------------------------------------------------------------------
// The locale maps
// ---------------------------------------------------------------------------

/** One schema's entry in a locale's map. */
export interface LocaleSchema {
   /** The blob sha of the schema file this translation follows. */
   source: string;
   strings: Record<string, string>;
   example: LocaleExample;
}

export type LocaleSchemaMap = Record<string, LocaleSchema>;

const BLOB = /^[0-9a-f]{40}$/;

/** The schemas this repository publishes, for the translation registry, which needs the
 *  inventory while the Astro configuration loads.
 *
 *  Read through the bundler rather than off the filesystem, because that is the only
 *  answer that does not depend on where the process was started or where the module ended
 *  up. A cwd-relative path breaks when the site is previewed from the repository root, as
 *  the end-to-end suite does; a path resolved from `import.meta.url` breaks in the other
 *  direction, because a bundled chunk's URL is the chunk's, not this file's. The glob is
 *  resolved against this source file at transform time, so both are settled at once, and
 *  it is lazy: only the names are wanted, never the schemas themselves. */
export function publishedSchemaNames(): string[] {
   const files = import.meta.glob('../../../schemas/*.schema.json');
   return schemaInventory(Object.keys(files).map((file) => file.slice(file.lastIndexOf('/') + 1)));
}

/** The schema names a directory listing holds, which is the inventory every other answer
 *  is measured against: the routes a locale advertises, and the keys its map carries. */
export function schemaInventory(files: string[]): string[] {
   return files
      .filter((file) => file.endsWith('.schema.json'))
      .map((file) => file.replace(/\.schema\.json$/, ''))
      .sort();
}

function exactly(where: string, what: string, expected: string[], actual: string[]): void {
   const missing = expected.filter((key) => !actual.includes(key));
   const extra = actual.filter((key) => !expected.includes(key));
   if (missing.length === 0 && extra.length === 0) return;
   const said = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      extra.length > 0 ? `carries ${extra.join(', ')}, which nothing renders` : '',
   ].filter(Boolean);
   throw new Error(`${where} ${what}: ${said.join('; ')}`);
}

/** What one locale's map is checked against: the schemas on disk, and what each schema
 *  page renders from the schema and from its example. */
export interface SchemaMapInputs {
   inventory: string[];
   projections: Record<string, { schema: Map<string, string>; example: Map<string, string>; markdown: boolean }>;
}

/** One locale's map, whole: the schemas it names are exactly the ones on disk, and each
 *  entry's keys are exactly what its page renders. No English fallback anywhere: a
 *  missing string fails the build, because the alternative is a page half in a language
 *  nobody chose. */
export function checkSchemaMap(locale: string, raw: unknown, inputs: SchemaMapInputs): LocaleSchemaMap {
   const file = `src/data/i18n/schemas/${locale}.json`;
   if (!raw || typeof raw !== 'object') throw new Error(`${file} is not an object`);
   const map = raw as LocaleSchemaMap;
   exactly(file, 'does not name the schemas on disk', inputs.inventory, Object.keys(map).sort());

   for (const [name, entry] of Object.entries(map)) {
      const where = `${file} ${name}`;
      if (!BLOB.test(entry?.source ?? '')) throw new Error(`${where} records no source blob for the schema it follows`);
      if (!BLOB.test(entry.example?.source ?? '')) {
         throw new Error(`${where} records no source blob for the example it follows`);
      }
      const expected = inputs.projections[name];
      const strings = entry.strings ?? {};
      const example = entry.example.strings ?? {};
      exactly(
         where,
         'does not carry every string the page renders',
         [...expected.schema.keys()].sort(),
         Object.keys(strings).sort(),
      );
      exactly(
         `${where}'s example`,
         'does not carry every string the page renders',
         [...expected.example.keys()].sort(),
         Object.keys(example).sort(),
      );
      for (const [pointer, text] of Object.entries({ ...strings, ...example })) {
         if (typeof text !== 'string' || text.trim() === '')
            throw new Error(`${where} has no translation at ${pointer}`);
      }
      const body = entry.example.body;
      const needsBody = expected.markdown;
      if (needsBody ? typeof body !== 'string' || body.trim() === '' : body !== undefined) {
         throw new Error(`${where}'s example ${needsBody ? 'needs a localized body' : 'has a body nothing renders'}`);
      }
   }
   return map;
}

/** The locale maps, as the build sees them. Vite resolves the glob; the checks above are
 *  where the contract lives, so a test exercises them without a build. */
export function schemaMaps(): Record<string, unknown> {
   return import.meta.glob('./data/i18n/schemas/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
}

/** One locale's checked map. */
export function schemaMap(locale: string, inputs: SchemaMapInputs): LocaleSchemaMap {
   const raw = schemaMaps()[`./data/i18n/schemas/${locale}.json`];
   if (!raw) throw new Error(`no schema translations for ${locale}: add src/data/i18n/schemas/${locale}.json`);
   return checkSchemaMap(locale, raw, inputs);
}

/** The schema routes a locale serves, from route-file evidence and the inventory alone.
 *
 *  A locale serves every schema the directory holds once its dynamic route file exists,
 *  because that file is what emits them; the map is checked content, never evidence that
 *  a page is there. Delete the route file and the family goes with it, which is what
 *  keeps the alternates, the selector and the sitemap from advertising a 404. */
export function schemaRouteFamily(routeFiles: string[], inventory: string[]): { locale: string; routeKey: string }[] {
   const out: { locale: string; routeKey: string }[] = [];
   for (const file of routeFiles) {
      const found = /(?:^|\/)pages\/([a-z0-9-]+)\/schemas\/\[name\]\.astro$/.exec(file);
      if (!found) continue;
      for (const name of inventory) out.push({ locale: found[1], routeKey: `/schemas/${name}` });
   }
   return out;
}

/** One schema as the pages read it: the published file, the instance beside it, and both
 *  parsed once for whatever the page does with them. */
export interface SchemaSource {
   name: string;
   /** `<name>.schema.json`, which is also the raw file's served name. */
   file: string;
   /** The schema exactly as published, which is what the schema tab prints. */
   raw: string;
   schema: Schema;
   example: SchemaExample;
   /** The example exactly as published, trailing whitespace trimmed. */
   exampleRaw: string;
   parsed: ParsedExample;
}

/** Every schema and its example, read from the repository the site is built in. One
 *  reader for every page that shows them, so no two pages can disagree about what is
 *  published. The root defaults to where this module found the repository, so a page
 *  never has to work it out from the working directory; a test passes its own. */
export function readSchemaSources(root: string = REPO_ROOT): SchemaSource[] {
   const dir = path.join(root, 'schemas');
   const inventory = schemaInventory(fs.readdirSync(dir));
   assertExamplesComplete(inventory);
   return inventory.map((name) => {
      const file = `${name}.schema.json`;
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const example = schemaExample(name);
      const exampleRaw = fs.readFileSync(path.join(root, example.file), 'utf-8').trimEnd();
      return {
         name,
         file,
         raw,
         schema: JSON.parse(raw) as Schema,
         example,
         exampleRaw,
         parsed: parseExample(exampleRaw, example.format),
      };
   });
}

/** What a locale's map is measured against, derived from the published files alone. */
export function schemaMapInputs(sources: SchemaSource[]): SchemaMapInputs {
   return {
      inventory: sources.map((source) => source.name),
      projections: Object.fromEntries(
         sources.map((source) => [
            source.name,
            {
               schema: projectedStrings(schemaProjection(source.schema)),
               example: new Map(exampleProjection(source.parsed.instance).map((one) => [one.pointer, one.text])),
               markdown: source.example.format === 'markdown',
            },
         ]),
      ),
   };
}

/** Every schema has an example and every example has a schema: the pages draw both
 *  panels, so a schema published without an instance to show fails the build rather than
 *  rendering a reference page with half its evidence missing. */
export function assertExamplesComplete(inventory: string[]): void {
   for (const name of inventory) schemaExample(name);
   for (const name of Object.keys(SCHEMA_EXAMPLES)) {
      if (!inventory.includes(name))
         throw new Error(`src/data/schema-examples.ts names ${name}, which is not a schema`);
   }
}
