// The chrome words the schema reference renders in English: the field table's own
// vocabulary, and the classification eyebrow every page carries above its title.
//
// One typed module rather than an English locale file, for the same reason the
// navigation labels are one: English is the page of record, so its words are the
// definition and not a translation of anything, and this is the key inventory every
// other locale's set is checked against.
//
// What is deliberately absent: the JSON type identifiers (`string`, `object`,
// `integer`) and enum values. Those are the schema's own tokens, read the same in
// every language, so a translated page prints them literally rather than through a
// key nobody should ever translate.

/** The field table's words. `linkTo` names the deep-link anchor for assistive
 *  technology; `arrayOfEnum` places the schema's own enum values inside the phrase. */
export const SCHEMA_LABELS = {
   /** The badge on a required field, which is also its `title`. */
   required: 'required',
   /** Introduces a field's `pattern`, which follows as literal source. */
   pattern: 'Pattern',
   /** Heading over a shape several sibling keys share, rendered once for all of them. */
   sharedShape: 'Each key below takes the same shape:',
   /** The deep-link anchor's accessible name. `{name}` is the field's own key. */
   linkTo: 'Link to {name}',

   /** The rendered type phrases, one per shape the field table draws. */
   arrayOfObjects: 'array of objects',
   arrayOfItems: 'array of items',
   arrayOfStrings: 'array of strings',
   arrayOfNumbers: 'array of numbers',
   arrayOfBooleans: 'array of booleans',
   arrayOfIntegers: 'array of integers',
   /** An array whose items are one of a fixed set. `{values}` is that set, quoted and
    *  joined by the schema's own values, so it is never translated. */
   arrayOfEnum: 'array of {values}',
   map: 'map',
   value: 'value',
} as const;

/** Every schema-chrome word a locale authors. */
export type SchemaLabelKey = keyof typeof SCHEMA_LABELS;

/** One locale's schema chrome. */
export type SchemaStrings = Record<SchemaLabelKey, string>;

/** The inventory a locale's set is validated against. */
export const SCHEMA_LABEL_KEYS = Object.keys(SCHEMA_LABELS) as SchemaLabelKey[];

/** The specification line the two spec-governed eyebrows name. A version token, not a
 *  word: it reads the same in every language and is placed rather than translated. */
export const SPEC_LINE = 'spec 1.0';

/** The page classification eyebrow, one phrase per kind. `{spec}` is the specification
 *  line above, so a locale translates the classification and never the version. */
export const PAGE_KIND_LABELS = {
   /** The specification documents and the JSON Schemas: binding. */
   normative: '{spec} · normative',
   /** Describes tooling that implements the spec; the spec is the authority. */
   reference: '{spec} · reference',
   /** Task-shaped instructions for adopting it. Non-normative. */
   guide: 'guide',
   /** Why it is built this way. Non-normative. */
   background: 'background',
   /** How the project is run, versioned, and handed on. */
   governance: 'governance',
} as const;

/** Every page classification. */
export type PageKind = keyof typeof PAGE_KIND_LABELS;

/** One locale's eyebrow phrases. */
export type PageKindStrings = Record<PageKind, string>;

/** The inventory a locale's set is validated against. */
export const PAGE_KIND_KEYS = Object.keys(PAGE_KIND_LABELS) as PageKind[];
