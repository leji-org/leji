import * as path from 'node:path';
import { type Finding, finding } from './findings.js';
import { exists, isDir, isFile, readText, readTextWithin, realpathWithin, underPath, walkMd } from './fsx.js';
import { parseFrontmatter } from './frontmatter.js';
import { type DocKind, parseIndexFile } from './indexfile.js';
import {
   type CategoryId,
   type Manifest,
   CATEGORY_IDS,
   effectiveAgentProfilesPath,
   effectiveDecisionRecordsPath,
} from './manifest.js';
import { schemaErrors } from './schemas.js';
import { byteCompare } from './text.js';

export type { DocKind } from './indexfile.js';

export interface ScannedDoc {
   relPath: string;
   category: CategoryId;
   /** The document's resolved kind (winning selector, then frontmatter
    * override; decision-category documents are inherently records). */
   kind: DocKind;
   frontmatter: Record<string, unknown> | null;
   body: string;
}

export interface ScannedProfile {
   relPath: string;
   frontmatter: Record<string, unknown> | null;
   /** Document body after the frontmatter block; inheritance composes it. */
   body: string;
   findings: Finding[];
}

/** Files validate/index must not treat as category content (layer chrome).
 * READMEs are NOT chrome: a directory expansion skips them (repo furniture by
 * default), but an explicit file selector governs one deliberately, because in
 * real repositories section READMEs are often the section's landing document. */
export function excludedFromCategories(manifest: Manifest): (relPath: string) => boolean {
   const profilesDir = effectiveAgentProfilesPath(manifest);
   return (relPath: string) => {
      if (relPath === manifest.bootProfilePath) return true;
      if (underPath(relPath, profilesDir)) return true;
      return false;
   };
}

export interface CategoryScan {
   docs: ScannedDoc[];
   findings: Finding[];
}

/** An index entry as a selector: what it covers, and what the covered documents
 * are assigned (category from the manifest's index-file binding, kind from the
 * entry's block). Specificity: a direct file selector beats any directory
 * selector; between directory selectors, deeper beats shallower. */
interface Selector {
   path: string;
   category: CategoryId;
   kind: DocKind;
   indexRel: string;
   isFileSelector: boolean;
   depth: number;
   /** Markdown paths this selector resolves to. */
   covered: string[];
}

/** Ordered specificity rank; higher wins. File selectors outrank every
 * directory selector regardless of depth. */
function rank(s: Selector): number {
   return s.isFileSelector ? Number.MAX_SAFE_INTEGER : s.depth;
}

/** Expand one parsed entry to its markdown paths, with per-entry diagnostics
 * (a typo, a non-markdown file, and an empty directory each get a distinct
 * finding instead of collapsing to one warning). */
function expandEntry(
   root: string,
   indexRel: string,
   entryPath: string,
   findings: Finding[],
): { covered: string[]; isFileSelector: boolean; skippedReadmes: string[] } | null {
   const abs = path.join(root, entryPath);
   if (!exists(abs)) {
      findings.push(finding('index-entry-missing', 'error', `entry "${entryPath}" does not exist`, indexRel));
      return null;
   }
   if (isFile(abs)) {
      if (!entryPath.endsWith('.md')) {
         findings.push(
            finding('index-entry-not-markdown', 'error', `entry "${entryPath}" is not a markdown file`, indexRel),
         );
         return null;
      }
      const md = walkMd(root, entryPath); // [entryPath] unless a symlink escapes root
      if (md.length === 0) {
         findings.push(
            finding('index-entry-missing', 'error', `entry "${entryPath}" escapes the layer root`, indexRel),
         );
         return null;
      }
      return { covered: md, isFileSelector: true, skippedReadmes: [] };
   }
   if (isDir(abs)) {
      // Directory expansion skips READMEs (repo furniture by default); an
      // explicit file selector includes one deliberately. The skips are reported
      // so the carve-out is never silent (leji status surfaces them).
      const all = walkMd(root, entryPath);
      const md = all.filter((p) => path.posix.basename(p).toLowerCase() !== 'readme.md');
      const skippedReadmes = all.filter((p) => path.posix.basename(p).toLowerCase() === 'readme.md');
      if (md.length === 0) {
         findings.push(
            finding('index-entry-empty', 'warning', `directory entry "${entryPath}" contains no markdown`, indexRel),
         );
      }
      return { covered: md, isFileSelector: false, skippedReadmes };
   }
   findings.push(
      finding('index-entry-missing', 'error', `entry "${entryPath}" is neither a file nor a directory`, indexRel),
   );
   return null;
}

/** Collect every selector across every mapped category, with parse/expansion
 * findings. Category order (CATEGORY_IDS) and entry order are preserved so
 * diagnostics are deterministic across the three SDKs. */
function collectSelectors(
   root: string,
   manifest: Manifest,
): {
   selectors: Selector[];
   findings: Finding[];
   skippedReadmes: { indexRel: string; path: string }[];
} {
   const selectors: Selector[] = [];
   const findings: Finding[] = [];
   const skippedReadmes: { indexRel: string; path: string }[] = [];
   for (const category of CATEGORY_IDS) {
      const mapping = manifest.categories[category];
      if (!mapping) continue;
      for (const indexRel of mapping.indexes) {
         const text = readTextWithin(path.resolve(root), path.join(root, indexRel));
         if (text === null) {
            findings.push(
               finding(
                  'index-file-missing',
                  'error',
                  `${category} index file is missing or escapes the layer root`,
                  indexRel,
               ),
            );
            continue;
         }
         const parsed = parseIndexFile(text);
         for (const err of parsed.errors) {
            findings.push(finding('index-file-parse', 'error', err, indexRel));
         }
         for (const entry of parsed.entries) {
            const expanded = expandEntry(root, indexRel, entry.path, findings);
            if (!expanded) continue;
            selectors.push({
               path: entry.path,
               category,
               kind: entry.kind,
               indexRel,
               isFileSelector: expanded.isFileSelector,
               depth: entry.path.replace(/\/+$/, '').split('/').length,
               covered: expanded.covered,
            });
            for (const rel of expanded.skippedReadmes) skippedReadmes.push({ indexRel, path: rel });
         }
      }
   }
   return { selectors, findings, skippedReadmes };
}

/**
 * Resolve one category's index files to the repo-relative markdown paths they
 * include, honoring selector specificity: a document covered by this category's
 * selectors but won by a more-specific selector of another category is excluded.
 * Problems surface as findings; never throws.
 */
export function resolveCategoryPaths(
   root: string,
   manifest: Manifest,
   category: CategoryId,
): { paths: string[]; findings: Finding[] } {
   const { assignments, findings } = resolveCategoryAssignments(root, manifest, { includeExcluded: true });
   const paths: string[] = [];
   for (const [relPath, a] of assignments) {
      if (a.category === category) paths.push(relPath);
   }
   return { paths, findings };
}

/** A document's resolved assignment: its single category, the winning
 * selector's kind (before any frontmatter override), and the index file that
 * declared the winning selector (the viewer groups by it). */
export interface Assignment {
   category: CategoryId;
   kind: DocKind;
   indexRel: string;
}

/**
 * Resolve the governed set without reading document frontmatter: each governed
 * path mapped to its single category and block kind by the most-specific
 * selector (file beats directory, deeper directory beats ancestor). Selectors of
 * equal specificity that disagree on category or kind are hard errors; identical
 * assignments resolve once. Broad selectors fully displaced by more-specific
 * ones are reported as `index-entry-shadowed` (informational; `leji status`
 * surfaces them). `scanCategories` adds frontmatter on top.
 */
export function resolveCategoryAssignments(
   root: string,
   manifest: Manifest,
   opts: { includeExcluded?: boolean } = {},
): {
   assignments: Map<string, Assignment>;
   findings: Finding[];
   shadowed: { indexRel: string; path: string }[];
   skippedReadmes: { indexRel: string; path: string }[];
} {
   const excluded = excludedFromCategories(manifest);
   const { selectors, findings, skippedReadmes: rawSkips } = collectSelectors(root, manifest);

   // Group candidate selectors per document.
   const byDoc = new Map<string, Selector[]>();
   for (const s of selectors) {
      for (const relPath of s.covered) {
         if (!opts.includeExcluded && excluded(relPath)) continue;
         const arr = byDoc.get(relPath) ?? [];
         arr.push(s);
         byDoc.set(relPath, arr);
      }
   }

   const assignments = new Map<string, Assignment>();
   const winners = new Set<Selector>();
   for (const [relPath, cands] of [...byDoc.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const top = Math.max(...cands.map(rank));
      const best = cands.filter((s) => rank(s) === top);
      const first = best[0];
      const conflicting = best.filter((s) => s.category !== first.category || s.kind !== first.kind);
      if (conflicting.length > 0) {
         // Deterministic message: name the two clashing assignments in category order.
         const other = conflicting[0];
         findings.push(
            finding(
               'category-conflict',
               'error',
               `${relPath} is selected with equal specificity as ${first.category}/${first.kind} (${first.indexRel}) and ${other.category}/${other.kind} (${other.indexRel}); a document resolves to exactly one category and kind`,
               relPath,
            ),
         );
         continue;
      }
      for (const s of best) winners.add(s);
      assignments.set(relPath, { category: first.category, kind: first.kind, indexRel: first.indexRel });
   }

   // A selector that covered documents but won none is fully shadowed by
   // more-specific selectors: dead weight worth surfacing, never an error.
   const shadowed: { indexRel: string; path: string }[] = [];
   for (const s of selectors) {
      const coveredGoverned = s.covered.filter((p) => opts.includeExcluded || !excluded(p));
      if (coveredGoverned.length === 0) continue;
      if (!winners.has(s)) shadowed.push({ indexRel: s.indexRel, path: s.path });
   }

   // A README skipped by directory expansion is only reportable while it stays
   // ungoverned: an explicit file selector elsewhere resolves the carve-out.
   const seenSkip = new Set<string>();
   const skippedReadmes = rawSkips.filter(({ indexRel, path: rel }) => {
      if (assignments.has(rel)) return false;
      const key = `${indexRel}\u0000${rel}`;
      if (seenSkip.has(key)) return false;
      seenSkip.add(key);
      return true;
   });

   return { assignments, findings, shadowed, skippedReadmes };
}

/** The valid frontmatter kinds; anything else present is a hard error. */
const DOC_KINDS: readonly DocKind[] = ['intent', 'record'];

export function scanCategories(root: string, manifest: Manifest): CategoryScan {
   const { assignments, findings } = resolveCategoryAssignments(root, manifest);
   const docs: ScannedDoc[] = [];
   for (const [relPath, a] of [...assignments.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const text = readText(path.join(root, relPath));
      const fm = parseFrontmatter(text);
      // Decision-category documents are inherently records; their (closed)
      // schema rejects an explicit `kind`, so no override applies.
      let kind: DocKind = a.category === 'decisions' ? 'record' : a.kind;
      const fmKind = fm.data?.kind;
      if (fmKind !== undefined && a.category !== 'decisions') {
         if (typeof fmKind === 'string' && (DOC_KINDS as readonly string[]).includes(fmKind)) {
            // Frontmatter overrides the block kind, never the category.
            kind = fmKind as DocKind;
         } else {
            findings.push(
               finding(
                  'kind-invalid',
                  'error',
                  `frontmatter kind must be intent or record; got ${JSON.stringify(fmKind)}`,
                  relPath,
               ),
            );
         }
      }
      docs.push({ relPath, category: a.category, kind, frontmatter: fm.data, body: fm.body });
   }
   return { docs, findings };
}

/** One frontmatter artifact's text parsed and validated: an unparseable block, a
 * missing block, and every schema violation, each under the caller's rule name.
 * The single per-file path, so every scan that produces a `ScannedProfile`
 * produces the same findings for the same bytes and no caller can hand back an
 * artifact whose validity was never established. */
function scanFrontmatterArtifact(
   text: string,
   relPath: string,
   schemaName: 'agent-profile' | 'decision-record',
   rule: string,
): ScannedProfile {
   const fm = parseFrontmatter(text);
   const findings: Finding[] = [];
   if (fm.error) {
      findings.push(finding(rule, 'error', fm.error, relPath));
   } else if (!fm.data) {
      findings.push(finding(rule, 'error', 'missing YAML frontmatter', relPath));
   } else {
      for (const err of schemaErrors(schemaName, fm.data)) {
         findings.push(finding(rule, 'error', err, relPath));
      }
   }
   return { relPath, frontmatter: fm.data, body: fm.body, findings };
}

function scanFrontmatterArtifacts(
   root: string,
   dir: string,
   schemaName: 'agent-profile' | 'decision-record',
   rule: string,
): ScannedProfile[] {
   const out: ScannedProfile[] = [];
   for (const relPath of walkMd(root, dir)) {
      if (path.posix.basename(relPath).toLowerCase() === 'readme.md') continue;
      out.push(scanFrontmatterArtifact(readText(path.join(root, relPath)), relPath, schemaName, rule));
   }
   return out;
}

export function scanAgentProfiles(root: string, manifest: Manifest): ScannedProfile[] {
   const dir = effectiveAgentProfilesPath(manifest);
   return scanFrontmatterArtifacts(root, dir, 'agent-profile', 'profile-frontmatter');
}

/**
 * The profile set inheritance resolves against: the `agentProfilesPath` scan plus
 * any `agents`-bound profile living outside that directory (a bound profile is
 * part of the layer's roster wherever it sits, so it can be an inheritance target
 * and it counts toward target ambiguity). Sorted by path so ambiguity messages and
 * finding order are deterministic.
 *
 * Out-of-directory entries are validated here, by the same per-file path the
 * directory scan uses, so every profile in the set carries its own findings. A
 * profile whose validity was never established is exactly the one a resolver
 * would compose into an effective profile and a viewer would render as governing
 * posture. The agents-map check validates these files too and emits byte-identical
 * findings, so `profileInheritanceFindings` collapses the pair rather than
 * reporting either twice.
 */
export function scanProfileSet(root: string, manifest: Manifest): ScannedProfile[] {
   const profiles = scanAgentProfiles(root, manifest);
   const dir = effectiveAgentProfilesPath(manifest);
   const seen = new Set(profiles.map((p) => p.relPath));
   for (const rel of Object.values(manifest.agents ?? {})) {
      if (seen.has(rel) || underPath(rel, dir)) continue;
      const text = readTextWithin(path.resolve(root), path.join(root, rel));
      if (text === null) continue; // missing or escaping: the agents-map check owns that
      seen.add(rel);
      profiles.push(scanFrontmatterArtifact(text, rel, 'agent-profile', 'profile-frontmatter'));
   }
   return profiles.sort((a, b) => byteCompare(a.relPath, b.relPath));
}

/** Frontmatter arrays that compose across an inheritance edge. Every other field
 * is the derived profile's own; none of them is ever inherited. */
const POSTURE_KEYS = ['requiredRead', 'defaultContext', 'mustAskWhen', 'mustRefuseWhen'] as const;

/** The effective profile after single-level inheritance resolution. On a
 * resolution error `frontmatter` and `body` are null: there is no partial
 * effective profile to apply, only findings. */
export interface ResolvedProfile {
   frontmatter: Record<string, unknown> | null;
   body: string | null;
   /** `[baseId, derivedId]` when inheritance resolved, `[id]` when the profile
    * stands alone, empty on a resolution error. */
   sourceIds: string[];
   findings: Finding[];
}

/**
 * One body as the effective profile carries it. Both bodies are normative, so
 * only two things are canonicalized: line endings become LF, and the boundary
 * blank lines (the newline the frontmatter fence leaves in front, any run of
 * newlines at the end) collapse to one trailing newline. Nothing else is touched:
 * no whitespace is stripped from a line, so a leading indented code block and a
 * trailing hard break both survive resolution byte for byte.
 */
function bodyHalf(raw: string): string {
   return raw.replaceAll('\r\n', '\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
}

/** A profile id as the schema patterns it. Resolution interpolates ids into the
 * effective body's comment markers, so an id that is not identifier-shaped is
 * refused before interpolation rather than allowed to close or forge a marker. */
const PROFILE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Identity of a finding, so resolution never re-reports one a scan already carries.
 *
 * The separator is U+001F (ASCII UNIT SEPARATOR), written as an escape so this file
 * stays plain ASCII text: three literal NUL bytes used to sit here, which made every
 * `grep` treat the whole file as binary and skip it without saying so. It is also
 * why the relation has to be spelled the same in all three SDKs, where a space stood
 * in for it. A control character cannot appear in a governed path, a rule id, or a
 * severity, so unlike any graphic character it cannot make two different findings
 * key alike.
 */
const FINDING_KEY_SEP = '\u001f';

export function findingKey(f: Finding): string {
   return [f.path ?? '', f.rule, f.severity, f.message].join(FINDING_KEY_SEP);
}

/** A posture entry's identity for duplicate removal: the decoded string compared
 * by its UTF-8 encoding (JS string equality is the same relation for scalar
 * strings). Non-string entries are schema violations; key them structurally so
 * resolution stays total rather than throwing on an invalid profile. */
function postureKey(value: unknown): string {
   return typeof value === 'string' ? `s${value}` : `j${JSON.stringify(value) ?? 'undefined'}`;
}

/** Base entries in their authored order, then the derived entries that the base
 * does not already carry, in theirs. No sorting: authored order is loading intent.
 * A derived value that is not an array is a schema violation the authored-frontmatter
 * check already reports; it contributes nothing here rather than replacing the base. */
function composePosture(baseValue: unknown, derivedValue: unknown): unknown {
   if (!Array.isArray(derivedValue)) return Array.isArray(baseValue) ? [...baseValue] : derivedValue;
   if (!Array.isArray(baseValue)) return derivedValue;
   const inBase = new Set(baseValue.map(postureKey));
   return [...baseValue, ...derivedValue.filter((v) => !inBase.has(postureKey(v)))];
}

/**
 * Resolve one agent profile's `inherits` against the layer's profile set: single
 * level, to exactly one `role: core` base that itself inherits nothing. Posture
 * arrays union base-first with exact duplicates dropped; every other field,
 * `inherits` included, is the derived profile's own; both bodies are operative,
 * base first, each behind a marker naming its source. A profile that declares no
 * `inherits` resolves to itself.
 *
 * Resolution is all-or-nothing. A source profile carrying an error finding, an
 * inheritance that does not satisfy the single-level rules, or an effective
 * profile that would still lack `requiredRead` or `mustAskWhen` all come back as
 * findings with `frontmatter` and `body` null: there is no half-resolved profile
 * for a caller to apply. Never throws.
 */
export function resolveAgentProfile(derived: ScannedProfile, profiles: ScannedProfile[]): ResolvedProfile {
   const fm = derived.frontmatter;
   const derivedId = typeof fm?.id === 'string' ? fm.id : '';
   const inherits = fm?.inherits;
   const refuse = (findings: Finding[]): ResolvedProfile => ({
      frontmatter: null,
      body: null,
      sourceIds: [],
      findings,
   });
   const unresolved = (rule: string, message: string, at = derived.relPath): ResolvedProfile =>
      refuse([finding(rule, 'error', message, at)]);
   // A source the scan already found invalid is not resolvable material: its
   // findings carry forward rather than being restated in resolution's own words.
   const errorsOn = (p: ScannedProfile): Finding[] => p.findings.filter((f) => f.severity === 'error');

   if (fm === null) return refuse(errorsOn(derived));
   if (typeof inherits !== 'string') {
      const own = errorsOn(derived);
      return own.length > 0
         ? refuse(own)
         : { frontmatter: fm, body: bodyHalf(derived.body), sourceIds: [derivedId], findings: [] };
   }
   const derivedErrors = errorsOn(derived);
   if (derivedErrors.length > 0) return refuse(derivedErrors);

   // A core profile is the base of the single level, so it inherits nothing. This
   // also covers a core profile naming itself.
   if (fm.role === 'core') {
      return unresolved(
         'inherits-on-core',
         `role is core but inherits "${inherits}"; a core profile is the base of the single inheritance level and inherits nothing`,
      );
   }
   const targets = profiles.filter((p) => p.frontmatter?.id === inherits);
   if (targets.length === 0) {
      return unresolved('inherits-unknown', `inherits "${inherits}" but no profile declares that id`);
   }
   if (targets.length > 1) {
      return unresolved(
         'inherits-ambiguous-target',
         `inherits "${inherits}" but ${targets.length} profiles declare that id (${targets.map((t) => t.relPath).join(', ')}); the target must be unique`,
      );
   }
   const base = targets[0];
   // Covers a non-core profile naming itself: its own role is not core.
   if (base.frontmatter?.role !== 'core') {
      return unresolved(
         'inherits-target-not-core',
         `inherits "${inherits}" (${base.relPath}), whose role is ${JSON.stringify(base.frontmatter?.role ?? null)}, not "core"; a profile may only extend a core profile`,
      );
   }
   // The base must be a leaf of the single level. Without this, a derived profile
   // would resolve through an inheriting core and get an effective profile that
   // the single-level rule says cannot exist. The base carries its own
   // `inherits-on-core` from its own resolution; this one says why the derived
   // profile is unusable, so both files are flagged.
   if (typeof base.frontmatter.inherits === 'string') {
      return unresolved(
         'inherits-on-core',
         `inherits "${inherits}" (${base.relPath}), which itself declares inherits "${base.frontmatter.inherits}"; resolution is single level, so the base of an inheritance declares none`,
      );
   }
   const baseErrors = errorsOn(base);
   if (baseErrors.length > 0) return refuse(baseErrors);
   for (const p of [base, derived]) {
      const id = p.frontmatter?.id;
      if (typeof id !== 'string' || !PROFILE_ID.test(id)) {
         return unresolved(
            'profile-frontmatter',
            `id ${JSON.stringify(id ?? null)} is not a valid profile identifier; the resolved profile interpolates ids into its body's source markers`,
            p.relPath,
         );
      }
   }

   const baseFm = base.frontmatter;
   const effective: Record<string, unknown> = {};
   for (const [key, value] of Object.entries(fm)) {
      if (key === 'inherits') continue; // a resolution directive, never effective frontmatter
      effective[key] = (POSTURE_KEYS as readonly string[]).includes(key) ? composePosture(baseFm[key], value) : value;
   }
   // Posture the derived profile omits entirely still comes from the base.
   for (const key of POSTURE_KEYS) {
      if (key in effective || !Array.isArray(baseFm[key])) continue;
      effective[key] = [...(baseFm[key] as unknown[])];
   }
   // The resolved profile is what the spec's requirement binds, so it is checked
   // here too: a base that supplies neither leaves the role without the two fields
   // every profile must carry, and half a posture is worse than a refusal.
   for (const key of ['requiredRead', 'mustAskWhen'] as const) {
      const value = effective[key];
      if (!Array.isArray(value) || value.length === 0) {
         return unresolved(
            'profile-frontmatter',
            `the resolved profile has no ${key}: this profile omits it and its base ${base.relPath} does not supply it`,
         );
      }
   }
   return {
      frontmatter: effective,
      body: `<!-- inherited from: ${inherits} -->\n\n${bodyHalf(base.body)}\n<!-- ${derivedId} -->\n\n${bodyHalf(derived.body)}`,
      sourceIds: [inherits, derivedId],
      findings: [],
   };
}

/** Resolution findings for every profile in the set that declares `inherits`.
 * Findings the scan already carries are dropped: resolution propagates a source's
 * errors to its own callers, but a validator has reported those from the scan. */
export function profileInheritanceFindings(profiles: ScannedProfile[]): Finding[] {
   const alreadyReported = new Set(profiles.flatMap((p) => p.findings).map(findingKey));
   const findings: Finding[] = [];
   for (const p of profiles) {
      if (typeof p.frontmatter?.inherits !== 'string') continue;
      for (const f of resolveAgentProfile(p, profiles).findings) {
         if (!alreadyReported.has(findingKey(f))) findings.push(f);
      }
   }
   return findings;
}

export function scanDecisionRecords(root: string, manifest: Manifest): ScannedProfile[] {
   // Scanned from the declared records path and the decisions category's index
   // entries; a layer may use either or both.
   const relPaths = new Set<string>();
   for (const rel of walkMd(root, effectiveDecisionRecordsPath(manifest))) relPaths.add(rel);
   for (const rel of resolveCategoryPaths(root, manifest, 'decisions').paths) relPaths.add(rel);
   const out: ScannedProfile[] = [];
   for (const relPath of [...relPaths].sort()) {
      if (path.posix.basename(relPath).toLowerCase() === 'readme.md') continue;
      const text = readText(path.join(root, relPath));
      const fm = parseFrontmatter(text);
      const findings: Finding[] = [];
      if (fm.error) {
         findings.push(finding('decision-frontmatter', 'error', fm.error, relPath));
      } else if (!fm.data) {
         findings.push(finding('decision-frontmatter', 'error', 'missing YAML frontmatter', relPath));
      } else {
         for (const err of schemaErrors('decision-record', fm.data)) {
            findings.push(finding('decision-frontmatter', 'error', err, relPath));
         }
      }
      out.push({ relPath, frontmatter: fm.data, body: fm.body, findings });
   }
   return out;
}

/** Duplicate-id findings across a set of artifacts that carry an `id`. */
export function duplicateIdFindings(items: { id: unknown; relPath: string }[], scope: string): Finding[] {
   const seen = new Map<string, string>();
   const findings: Finding[] = [];
   for (const { id, relPath } of items) {
      if (typeof id !== 'string' || id === '') continue;
      const first = seen.get(id);
      if (first !== undefined && first !== relPath) {
         findings.push(finding('id-duplicate', 'error', `${scope} id "${id}" already used by ${first}`, relPath));
      } else {
         seen.set(id, relPath);
      }
   }
   return findings;
}

/** Read a declared JSON artifact; returns parsed value or a finding. */
export function readJsonArtifact(root: string, relPath: string): { data: unknown; finding?: Finding } {
   const abs = path.join(root, relPath);
   if (!isFile(abs)) {
      return { data: null };
   }
   if (!realpathWithin(path.resolve(root), abs)) {
      return {
         data: null,
         finding: finding('artifact-parse', 'error', `artifact ${relPath} resolves outside the layer root`, relPath),
      };
   }
   try {
      return { data: JSON.parse(readText(abs)) };
   } catch (e) {
      return {
         data: null,
         finding: finding('artifact-parse', 'error', `invalid JSON: ${(e as Error).message}`, relPath),
      };
   }
}
