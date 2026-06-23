import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundled, drift-checked copies of the canonical spec and schemas, vendored from
// the repo-root spec/ and schemas/ by scripts/sync-assets.ts (no forked spec).
// Resolved relative to the built file: dist/ -> package root -> assets/.
const assetsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const specDir = path.join(assetsDir, 'spec');
const schemasDir = path.join(assetsDir, 'schemas');

const SPEC_SUFFIX = '.md';
const SCHEMA_SUFFIX = '.schema.json';

let specIdsCache: string[] | null = null;
let schemaNamesCache: string[] | null = null;

function listBasenames(dir: string, suffix: string): string[] {
   return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, -suffix.length))
      .sort();
}

/** Spec document ids (the spec/*.md basenames), sorted. */
export function specIds(): string[] {
   return (specIdsCache ??= listBasenames(specDir, SPEC_SUFFIX));
}

/** Schema names (the schemas/*.schema.json basenames), sorted. */
export function schemaNames(): string[] {
   return (schemaNamesCache ??= listBasenames(schemasDir, SCHEMA_SUFFIX));
}

/**
 * Read one spec document by id, or null when the id is not a known document.
 * The id is matched against the enumerated set (a basename never contains a path
 * separator), so a caller cannot use it to traverse out of the bundle.
 */
export function readSpec(id: string): string | null {
   if (!specIds().includes(id)) return null;
   return fs.readFileSync(path.join(specDir, id + SPEC_SUFFIX), 'utf8');
}

/** The whole spec, concatenated in id order, each part labelled by its source path. */
export function readSpecFull(): string {
   return specIds()
      .map((id) => `<!-- spec/${id}${SPEC_SUFFIX} -->\n\n${readSpec(id)!}`)
      .join('\n\n---\n\n');
}

/** Read one schema by name as raw JSON text, or null when the name is unknown. */
export function readSchema(name: string): string | null {
   if (!schemaNames().includes(name)) return null;
   return fs.readFileSync(path.join(schemasDir, name + SCHEMA_SUFFIX), 'utf8');
}

/** One spec section: a heading and its body, used by search_spec. */
export interface SpecSection {
   specId: string;
   heading: string;
   body: string;
}

/** Split a spec document into sections at markdown headings (the heading line is
 * kept with its section). Content before the first heading is a "(preamble)". */
export function specSections(id: string, md: string): SpecSection[] {
   return md
      .split(/^(?=#{1,6}\s)/m)
      .map((part) => {
         const m = /^(#{1,6})\s+(.+)$/m.exec(part);
         return { specId: id, heading: m ? m[2].trim() : '(preamble)', body: part.trim() };
      })
      .filter((s) => s.body.length > 0);
}
