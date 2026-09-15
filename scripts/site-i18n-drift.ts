#!/usr/bin/env node
// The translation drift gate. English is the page of record for every route, and a
// translated page records the git blob sha of the English source it follows. This
// script compares each recorded sha against the source's current blob and fails the
// site build when any English source has moved on, so a translation is updated or
// withdrawn before it is published rather than after a reader finds it stale.
//
// It reads the working tree, not git history: a blob sha is a pure function of the
// bytes (`sha1("blob <length>\0" + content)`, which is what `git hash-object` prints),
// and the repository disables end-of-line conversion, so the file on disk hashes to
// exactly what git recorded.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_EXAMPLES } from '../packages/site/src/data/schema-examples.ts';
import { parseSpecI18nId, specI18nId } from '../packages/site/src/spec-i18n.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Translated pages: `<locale>/<route>.astro` beside the English `<route>.astro`. */
const PAGES_DIR = 'packages/site/src/pages';
/** The translated specification: `<locale>/spec/<doc>.md` for the English `spec/<doc>.md`. */
const SPEC_I18N_DIR = 'packages/site/src/content/i18n';
const SPEC_DIR = 'spec';
/** One strings file per locale, which is what makes a locale a locale: the site fails
 *  to build a page in a language whose strings are not there, so the files are the
 *  roster and this gate never carries a second list of languages to keep in step. */
const STRINGS_DIR = 'packages/site/src/data/i18n';
/** One schema map per locale: the translated schema reference's text, keyed by where each
 *  string lives in the schema, with the revision of the schema and of its example. */
const SCHEMA_I18N_DIR = 'packages/site/src/data/i18n/schemas';
/** The schemas the maps translate, at their one canonical location. */
const SCHEMA_DIR = 'schemas';

/** `const source = '<sha>';` in a translated page's frontmatter script. */
const PAGE_SOURCE = /^const source = '([0-9a-f]{40})';$/m;
/** `source: '<sha>'` in a translated specification document's frontmatter. */
const CONTENT_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;
const CONTENT_SOURCE = /^source:\s*['"]?([0-9a-f]{40})['"]?\s*$/m;

/** A derived prose source: an English page whose text is not in the page file. */
export interface ProseSource {
   /** Repo-relative path of the prose the English page renders. */
   file: string;
   /** The blob of that prose the translations of this route follow. */
   source: string;
}

/** Two English pages are wrappers: `adoption` and `rationale` render markdown that
 *  lives in a repo-root README, so the page file changes only when its markup does.
 *  A translation records one sha and that sha is the wrapper's, which would leave the
 *  prose free to change underneath every translation without any recorded revision
 *  moving. The revision those READMEs are translated from therefore lives here, and a
 *  route in this map is checked against its prose blob in addition to its page blob.
 *  Retranslating either route updates the sha here along with the pages. */
export const PROSE_SOURCES: Record<string, ProseSource> = {
   [`${PAGES_DIR}/adoption.astro`]: {
      file: 'adoption/README.md',
      source: '064d34384831678b644214acacbadd4c6e051ac3',
   },
   [`${PAGES_DIR}/rationale.astro`]: {
      file: 'rationale/README.md',
      source: 'd3ef50d86250f662276b8647c36fb857c3bc2f2d',
   },
};

/** One translated page and the English source revision it follows. */
interface Recorded {
   /** `vi/quickstart`, as the failure names it. */
   page: string;
   /** Repo-relative path of the English source. */
   file: string;
   recorded: string;
}

export interface Drift extends Recorded {
   /** The source's blob today, or null where the English source is gone. */
   current: string | null;
}

export interface DriftReport {
   /** Recorded source revisions compared. */
   checked: number;
   /** Translated pages behind them. */
   pages: number;
   drifted: Drift[];
}

/** The blob sha git would record for these bytes. */
export function blobSha(content: Buffer): string {
   return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function listFiles(dir: string): string[] {
   if (!fs.existsSync(dir)) return [];
   const out: string[] = [];
   for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listFiles(full));
      else out.push(full);
   }
   return out;
}

/** Repo-relative, forward-slashed: the shape every path in this script is written in. */
function relPath(root: string, file: string): string {
   return path.relative(root, file).split(path.sep).join('/');
}

/** The languages the site ships, read off the one file each of them must have. */
function locales(root: string): string[] {
   const dir = path.join(root, STRINGS_DIR);
   if (!fs.existsSync(dir)) return [];
   return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.reference.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
}

/** The English page a translated page mirrors: the same route without its locale
 *  prefix. Every page under a locale is a translation and must say which revision it
 *  follows, so one that records nothing fails here rather than sitting outside the
 *  gate. The exception is the locale's `spec/` route, which is machinery that renders
 *  the translated documents; those carry their own recorded revisions as content. */
function recordedPages(root: string): Recorded[] {
   const found: Recorded[] = [];
   for (const locale of locales(root)) {
      const localeDir = path.join(root, PAGES_DIR, locale);
      for (const file of listFiles(localeDir)) {
         if (!file.endsWith('.astro')) continue;
         const route = relPath(localeDir, file);
         if (route.startsWith('spec/')) continue;
         const recorded = PAGE_SOURCE.exec(fs.readFileSync(file, 'utf8'))?.[1];
         if (!recorded) {
            throw new Error(`${PAGES_DIR}/${locale}/${route} records no source blob for the English page it follows`);
         }
         found.push({ page: `${locale}/${route.replace(/\.astro$/, '')}`, file: `${PAGES_DIR}/${route}`, recorded });
      }
   }
   return found;
}

/** The English specification document a translated one mirrors. The overview is
 *  `spec/README.md`; every other document is named by its slug. */
function englishSpecFile(doc: string): string {
   return `${SPEC_DIR}/${doc === 'readme' ? 'README' : doc}.md`;
}

/** A translated schema page follows two English files, not one: the schema it renders
 *  and the example instance beside it. Both are read from the locale's map rather than
 *  from the page, because the page renders whatever the map holds and it is the text in
 *  the map that goes stale. An entry with no usable revision fails here: a translation
 *  the gate cannot compare is exactly what this gate exists to prevent. */
function recordedSchemas(root: string): Recorded[] {
   const dir = path.join(root, SCHEMA_I18N_DIR);
   if (!fs.existsSync(dir)) return [];
   const found: Recorded[] = [];
   for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const locale = name.slice(0, -'.json'.length);
      const map = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Record<
         string,
         { source?: string; example?: { source?: string } }
      >;
      for (const [schema, entry] of Object.entries(map)) {
         const example = SCHEMA_EXAMPLES[schema];
         if (!example)
            throw new Error(`${SCHEMA_I18N_DIR}/${name} translates ${schema}, which has no example instance`);
         for (const [page, file, recorded] of [
            [`${locale}/schemas/${schema}`, `${SCHEMA_DIR}/${schema}.schema.json`, entry?.source],
            [`${locale}/schemas/${schema} (example)`, example.file, entry?.example?.source],
         ] as const) {
            if (!recorded || !/^[0-9a-f]{40}$/.test(recorded)) {
               throw new Error(`${SCHEMA_I18N_DIR}/${name} records no source blob for ${file}`);
            }
            found.push({ page, file, recorded });
         }
      }
   }
   return found;
}

function recordedSpecDocs(root: string): Recorded[] {
   const found: Recorded[] = [];
   for (const file of listFiles(path.join(root, SPEC_I18N_DIR))) {
      if (!file.endsWith('.md')) continue;
      const rel = relPath(path.join(root, SPEC_I18N_DIR), file);
      if (!/^[^/]+\/spec\/[^/]+\.md$/.test(rel)) continue;
      const { locale, doc } = parseSpecI18nId(specI18nId(rel));
      const frontmatter = CONTENT_FRONTMATTER.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
      const recorded = CONTENT_SOURCE.exec(frontmatter)?.[1];
      if (!recorded) {
         throw new Error(`${SPEC_I18N_DIR}/${rel} records no source blob for the English document it follows`);
      }
      found.push({ page: `${locale}/spec/${doc}`, file: englishSpecFile(doc), recorded });
   }
   return found;
}

/** Every recorded source revision against the blob its English source hashes to now. */
export function checkDrift(root: string, proseSources: Record<string, ProseSource> = PROSE_SOURCES): DriftReport {
   const pages = [...recordedPages(root), ...recordedSchemas(root), ...recordedSpecDocs(root)].sort((a, b) =>
      a.page.localeCompare(b.page),
   );
   const current = new Map<string, string | null>();
   const blobOf = (file: string): string | null => {
      if (!current.has(file)) {
         const full = path.join(root, file);
         current.set(file, fs.existsSync(full) ? blobSha(fs.readFileSync(full)) : null);
      }
      return current.get(file)!;
   };

   const drifted: Drift[] = [];
   let checked = 0;
   for (const entry of pages) {
      const prose = proseSources[entry.file];
      for (const source of prose ? [entry, { ...entry, file: prose.file, recorded: prose.source }] : [entry]) {
         checked += 1;
         const blob = blobOf(source.file);
         if (blob !== source.recorded) drifted.push({ ...source, current: blob });
      }
   }
   return { checked, pages: pages.length, drifted };
}

function short(sha: string | null): string {
   return sha ? sha.slice(0, 7) : 'missing';
}

// Guarded so the checks above can be exercised against a fixture tree by a test that
// imports them, rather than only against the tree this file happens to sit in. The
// guard compares paths rather than reading `import.meta.main`, which is newer than the
// oldest Node this repository builds on and would read as "imported" there, silently
// turning a build gate into a no-op.
const invokedDirectly =
   process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
   const report = checkDrift(REPO_ROOT);
   if (report.drifted.length > 0) {
      for (const entry of report.drifted) {
         console.error(
            `${entry.page}: recorded ${short(entry.recorded)} vs current ${short(entry.current)} (${entry.file})`,
         );
      }
      console.error(
         `\n${report.drifted.length} translated page(s) follow an English revision that has moved; update each translation to the current English page and its recorded source, or withdraw the page`,
      );
      process.exit(1);
   }
   console.log(
      `site i18n drift: ${report.checked} recorded source revisions current across ${report.pages} translated pages`,
   );
}
