import * as path from 'node:path';
import { type Finding, finding, sortFindings } from '../lib/findings.js';
import { exists, isFile, readText, underPath, walkMd } from '../lib/fsx.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { gitShowHead, gitToplevel } from '../lib/git.js';
import {
   duplicateIdFindings,
   readJsonArtifact,
   scanAgentProfiles,
   scanCategories,
   scanDecisionRecords,
} from '../lib/layer.js';
import {
   type Manifest,
   CATEGORY_IDS,
   claimedLevel,
   effectiveAgentProfilesPath,
   effectiveChangelogPath,
   effectiveDecisionRecordsPath,
   effectiveIndexPath,
   levelAtLeast,
   loadManifest,
} from '../lib/manifest.js';
import { SUPPORTED_LINES, schemaErrors } from '../lib/schemas.js';
import { checkIndex, stableStringify } from './indexgen.js';

/** Vendor entrypoint files checked for the redirect rule even when undeclared. */
export const KNOWN_VENDOR_FILES = [
   'CLAUDE.md',
   'AGENTS.md',
   'GEMINI.md',
   '.cursorrules',
   '.cursor/rules',
   '.windsurfrules',
   '.github/copilot-instructions.md',
];

export interface ValidateResult {
   findings: Finding[];
   manifest: Manifest | null;
}

interface ChangelogEntry {
   id?: string;
   date?: string;
   type?: string;
   [key: string]: unknown;
}

/**
 * Canonical changelog order (machine-readable-surface.md req 3): ascending by
 * `date`, then `id` as the tiebreak. `date` is UTC (date-only or `…Z`), so a
 * lexical compare of the string is chronological; `id` is unique, so the pair
 * is a total order.
 */
function compareByDateId(a: ChangelogEntry, b: ChangelogEntry): number {
   const ad = String(a.date ?? '');
   const bd = String(b.date ?? '');
   if (ad !== bd) return ad < bd ? -1 : 1;
   const ai = String(a.id ?? '');
   const bi = String(b.id ?? '');
   return ai < bi ? -1 : ai > bi ? 1 : 0;
}

function checkDeclaredFile(root: string, rel: string, what: string, findings: Finding[]): boolean {
   if (!isFile(path.join(root, rel))) {
      findings.push(finding('missing-declared-file', 'error', `${what} declared in leji.json does not exist`, rel));
      return false;
   }
   return true;
}

function checkBootProfile(root: string, manifest: Manifest, findings: Finding[]): void {
   const rel = manifest.bootProfilePath;
   if (!checkDeclaredFile(root, rel, 'boot profile', findings)) return;
   const text = readText(path.join(root, rel));

   const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].toLowerCase());
   for (const section of ['identity', 'loading', 'posture']) {
      if (!headings.some((h) => h.includes(section))) {
         findings.push(
            finding(
               'boot-profile-sections',
               'warning',
               `boot profile has no "${section}" heading; it must cover identity, loading, and posture`,
               rel,
            ),
         );
      }
   }

   const changelogPath = manifest.machine?.changelogPath;
   const decisionsPath = effectiveDecisionRecordsPath(manifest);
   const mentions = (p: string | undefined): boolean => {
      if (!p) return false;
      const base = p.endsWith('/') ? p.slice(0, -1) : p;
      return text.includes(base);
   };
   if (!mentions(changelogPath) && !mentions(decisionsPath)) {
      findings.push(
         finding(
            'boot-profile-maintenance',
            'warning',
            'boot profile references neither the declared changelog nor the decision-records location; state the maintenance duties',
            rel,
         ),
      );
   }
}

function checkCategories(root: string, manifest: Manifest, findings: Finding[]): void {
   const mapped = CATEGORY_IDS.filter((c) => manifest.categories[c]);
   if (!(mapped.includes('domain') || mapped.includes('system')) || !mapped.includes('decisions')) {
      findings.push(
         finding(
            'categories-minimum',
            'error',
            'a layer must map at least domain or system, plus decisions, to claim any conformance level',
            'leji.json',
         ),
      );
   }
   for (const category of mapped) {
      for (const declared of manifest.categories[category]!.paths) {
         if (!exists(path.join(root, declared))) {
            findings.push(finding('category-path-missing', 'error', `${category} path does not exist`, declared));
         } else if (walkMd(root, declared).length === 0) {
            findings.push(
               finding(
                  'category-empty',
                  'error',
                  `${category} path has no markdown content; an empty category must not be mapped`,
                  declared,
               ),
            );
         }
         if (!underPath(declared, manifest.rootPath)) {
            findings.push(
               finding(
                  'paths-outside-root',
                  'warning',
                  `${category} path falls outside rootPath ${manifest.rootPath}`,
                  declared,
               ),
            );
         }
      }
   }
   for (const [key, rel] of Object.entries(manifest.machine ?? {})) {
      if (typeof rel === 'string' && !underPath(rel, manifest.rootPath)) {
         findings.push(
            finding('paths-outside-root', 'warning', `machine.${key} falls outside rootPath ${manifest.rootPath}`, rel),
         );
      }
   }
}

function checkVendorAdapters(root: string, manifest: Manifest, findings: Finding[]): void {
   const declared = manifest.vendorAdapters ?? [];
   for (const rel of declared) {
      checkDeclaredFile(root, rel, 'vendor adapter', findings);
   }
   const candidates = new Set([...declared, ...KNOWN_VENDOR_FILES]);
   for (const rel of candidates) {
      const abs = path.join(root, rel);
      if (!isFile(abs)) continue;
      if (!readText(abs).includes(manifest.bootProfilePath)) {
         findings.push(
            finding(
               'vendor-adapter-redirect',
               'error',
               `vendor entrypoint does not redirect to the boot profile (${manifest.bootProfilePath})`,
               rel,
            ),
         );
      }
   }
}

function checkOwners(manifest: Manifest, findings: Finding[]): void {
   // A continuity owner exists to cover the primary's absence (governance.md
   // req 4), so naming the same person provides no continuity.
   const primary = manifest.owners?.primary?.name;
   const continuity = manifest.owners?.continuity?.name;
   if (primary && continuity && primary === continuity) {
      findings.push(
         finding(
            'continuity-self',
            'warning',
            "continuity owner exists to cover the primary's absence; naming the same person provides none",
            'leji.json',
         ),
      );
   }
}

function checkAgentsMap(root: string, manifest: Manifest, findings: Finding[]): void {
   const profilesDir = effectiveAgentProfilesPath(manifest);
   for (const [role, rel] of Object.entries(manifest.agents ?? {})) {
      if (!checkDeclaredFile(root, rel, `agents.${role} profile`, findings)) continue;
      // Targets under agentProfilesPath are validated by the directory scan;
      // targets outside it still owe a valid agent-profile frontmatter.
      if (underPath(rel, profilesDir)) continue;
      const fm = parseFrontmatter(readText(path.join(root, rel)));
      if (fm.error) {
         findings.push(finding('profile-frontmatter', 'error', fm.error, rel));
      } else if (!fm.data) {
         findings.push(finding('profile-frontmatter', 'error', 'missing YAML frontmatter', rel));
      } else {
         for (const err of schemaErrors('agent-profile', fm.data)) {
            findings.push(finding('profile-frontmatter', 'error', err, rel));
         }
      }
   }
}

function checkFederationMounts(root: string, manifest: Manifest, findings: Finding[]): void {
   const mounts = manifest.federation?.mounts ?? [];
   // Identity rules (distribution.md pattern 3): paths and names unique within
   // the manifest; a mount never reuses the host layer's own name.
   const seenPaths = new Set<string>();
   const seenNames = new Set<string>();
   for (const mount of mounts) {
      if (seenPaths.has(mount.path)) {
         findings.push(
            finding('mount-duplicate', 'error', `two mounts declare the same path "${mount.path}"`, mount.path),
         );
      } else {
         seenPaths.add(mount.path);
      }
      if (seenNames.has(mount.name)) {
         findings.push(
            finding('mount-duplicate', 'error', `two mounts declare the same name "${mount.name}"`, mount.path),
         );
      } else {
         seenNames.add(mount.name);
      }
      if (mount.name === manifest.name) {
         findings.push(
            finding('mount-self', 'error', `mount "${mount.name}" reuses the host layer's own name`, mount.path),
         );
      }
   }
   for (const mount of mounts) {
      const abs = path.join(root, mount.path);
      if (!exists(abs)) {
         findings.push(
            finding(
               'missing-declared-file',
               'error',
               `federation mount "${mount.name}" declared in leji.json does not exist`,
               mount.path,
            ),
         );
         continue;
      }
      const siblingManifest = path.join(abs, 'leji.json');
      if (!isFile(siblingManifest)) {
         findings.push(
            finding(
               'mount-not-a-layer',
               'warning',
               'mounted path carries no leji.json; a sibling layer brings its own manifest',
               mount.path,
            ),
         );
         continue;
      }
      try {
         const sibling = JSON.parse(readText(siblingManifest)) as { name?: unknown };
         if (typeof sibling.name === 'string' && sibling.name !== mount.name) {
            findings.push(
               finding(
                  'mount-name-mismatch',
                  'warning',
                  `mount declares name "${mount.name}" but the sibling manifest says "${sibling.name}"`,
                  mount.path,
               ),
            );
         }
      } catch {
         findings.push(finding('mount-not-a-layer', 'warning', 'mounted leji.json is not valid JSON', mount.path));
      }
   }
}

function checkProfilesAndDecisions(root: string, manifest: Manifest, findings: Finding[]): void {
   const profiles = scanAgentProfiles(root, manifest);
   const ids: { id: unknown; relPath: string }[] = [];
   const knownIds = new Set<string>();
   for (const p of profiles) {
      findings.push(...p.findings);
      ids.push({ id: p.frontmatter?.id, relPath: p.relPath });
      if (typeof p.frontmatter?.id === 'string') knownIds.add(p.frontmatter.id);
   }
   findings.push(...duplicateIdFindings(ids, 'agent profile'));
   for (const p of profiles) {
      const inherits = p.frontmatter?.inherits;
      if (typeof inherits === 'string' && !knownIds.has(inherits)) {
         findings.push(
            finding('inherits-unknown', 'warning', `inherits "${inherits}" but no profile declares that id`, p.relPath),
         );
      }
   }

   const decisions = scanDecisionRecords(root, manifest);
   const decisionIds: { id: unknown; relPath: string }[] = [];
   for (const d of decisions) {
      findings.push(...d.findings);
      decisionIds.push({ id: d.frontmatter?.id, relPath: d.relPath });
   }
   findings.push(...duplicateIdFindings(decisionIds, 'decision record'));

   if (decisions.filter((d) => d.findings.length === 0).length === 0) {
      const where = effectiveDecisionRecordsPath(manifest);
      findings.push(
         finding(
            'decisions-empty',
            'error',
            'no valid decision record found; core conformance requires at least one',
            where,
         ),
      );
   }
}

function checkSchemaVersion(rel: string, data: unknown, findings: Finding[]): void {
   const v = (data as { schemaVersion?: unknown })?.schemaVersion;
   if (typeof v === 'string' && !SUPPORTED_LINES.includes(v)) {
      findings.push(finding('schema-version', 'error', `schemaVersion "${v}" is not supported by this SDK`, rel));
   }
}

export interface ChangelogCheckResult {
   findings: Finding[];
   verified: boolean;
}

/**
 * Append-only discipline: every entry present at HEAD must be unchanged and in
 * the same position; new entries only append. Without a git baseline the
 * property is unverifiable and reported as a warning (error under --strict).
 */
export function checkChangelogAppendOnly(root: string, rel: string, strict = false): ChangelogCheckResult {
   const findings: Finding[] = [];
   const { data, finding: parseFinding } = readJsonArtifact(root, rel);
   if (parseFinding) return { findings: [parseFinding], verified: false };
   if (!data) {
      return {
         findings: [finding('changelog-required', 'error', `changelog ${rel} does not exist`, rel)],
         verified: false,
      };
   }
   for (const err of schemaErrors('context-changelog', data)) {
      findings.push(finding('artifact-schema', 'error', err, rel));
   }
   checkSchemaVersion(rel, data, findings);
   // Schema findings above cover malformed shapes; guard so they can't crash us.
   const rawEntries = (data as { entries?: unknown }).entries;
   const entries: ChangelogEntry[] = Array.isArray(rawEntries)
      ? rawEntries.filter((e): e is ChangelogEntry => e !== null && typeof e === 'object')
      : [];
   findings.push(
      ...duplicateIdFindings(
         entries.map((e, i) => ({ id: e.id, relPath: `${rel}#${i}` })),
         'changelog',
      ).map((f) => ({ ...f, path: rel })),
   );

   if (gitToplevel(root) === null) {
      findings.push(
         finding(
            'changelog-unverifiable',
            strict ? 'error' : 'warning',
            'not a git repository; append-only discipline cannot be verified',
            rel,
         ),
      );
      return { findings, verified: false };
   }
   const headText = gitShowHead(root, rel);
   if (headText === null) {
      return { findings, verified: true };
   }
   let headEntries: ChangelogEntry[];
   try {
      const parsed = (JSON.parse(headText) as { entries?: unknown }).entries;
      headEntries = Array.isArray(parsed)
         ? parsed.filter((e): e is ChangelogEntry => e !== null && typeof e === 'object')
         : [];
   } catch {
      return { findings, verified: true };
   }
   // Discipline is set-keyed by `id` (machine-readable-surface.md req 3): order
   // is derived from (date, id), not array position, so reordering is fine.
   // Every entry present at HEAD must survive unchanged unless it was compacted
   // from the OLDEST end of the canonical order, with a `compaction` entry added.
   if (headEntries.length > 0 && entries.length === 0) {
      findings.push(
         finding(
            'changelog-append-only',
            'error',
            'changelog compacted to empty; the compaction entry must survive',
            rel,
         ),
      );
      return { findings, verified: true };
   }
   const newIds = new Set(entries.map((e) => e.id));
   const headById = new Map(headEntries.map((e) => [e.id, e] as const));
   const newById = new Map(entries.map((e) => [e.id, e] as const));

   // Surviving entries (present in both) are immutable. Key-order-insensitive:
   // reformatting an entry is not a change.
   for (const [id, headEntry] of headById) {
      const current = newById.get(id);
      if (current && stableStringify(current) !== stableStringify(headEntry)) {
         findings.push(
            finding(
               'changelog-append-only',
               'error',
               `entry "${id ?? '?'}" modified since HEAD; surviving entries are immutable`,
               rel,
            ),
         );
         return { findings, verified: true };
      }
   }

   // Any ids dropped since HEAD must be a contiguous run from the oldest end of
   // the canonical (date, id) order, never from the middle or the newest end.
   const headCanonical = [...headEntries].sort(compareByDateId);
   const droppedIds = headCanonical.filter((e) => !newIds.has(e.id)).map((e) => e.id);
   if (droppedIds.length > 0) {
      const n = droppedIds.length;
      const oldestPrefix = new Set(headCanonical.slice(0, n).map((e) => e.id));
      const fromOldestEnd = droppedIds.every((id) => oldestPrefix.has(id));
      if (!fromOldestEnd) {
         findings.push(
            finding(
               'changelog-append-only',
               'error',
               `${n} ${n === 1 ? 'entry' : 'entries'} removed from other than the oldest end since HEAD; only the oldest entries may be compacted`,
               rel,
            ),
         );
         return { findings, verified: true };
      }
      const appended = entries.filter((e) => !headById.has(e.id));
      if (!appended.some((e) => e.type === 'compaction')) {
         findings.push(
            finding(
               'changelog-append-only',
               'error',
               `${n} ${n === 1 ? 'entry' : 'entries'} removed since HEAD without a compaction entry recording the drop`,
               rel,
            ),
         );
      }
   }
   return { findings, verified: true };
}

/** Placeholder markers a freshly scaffolded layer carries until it is populated:
 * the `TODO:` lines init seeds, or any `<…>` angle-bracket stub. */
const PLACEHOLDER_RE = /\bTODO:|<[A-Za-z][^>\n]*>/;
/** High-stakes inferences an agent drafted but the owner has not confirmed yet:
 * `TODO(confirm-invariant|gate|owner): …` markers, or `UNCONFIRMED:` lines. The
 * `TODO(confirm-…)` form deliberately does not match PLACEHOLDER_RE's `TODO:`. */
const UNCONFIRMED_RE = /TODO\(confirm[-:][^)\n]*\)|UNCONFIRMED:/;
/** The generic identity init writes by default; real layers replace it. */
const GENERIC_IDENTITY = 'Shared context layer for this repository.';

/** Body text of the first heading whose title contains `heading`, up to the next heading. */
function sectionBody(text: string, heading: string): string {
   const re = new RegExp(`^#{1,6}\\s+.*${heading}.*$`, 'im');
   const m = re.exec(text);
   if (!m) return '';
   const rest = text.slice(m.index + m[0].length);
   const next = /^#{1,6}\s+/m.exec(rest);
   return (next ? rest.slice(0, next.index) : rest).trim();
}

/**
 * Opt-in content lint (`validate --content`): warning-only signals that a layer
 * is still a scaffold rather than real context — placeholder text, a generic
 * boot identity, thin domain/system categories. Never errors and never affects a
 * conformance level (conformance.md defines "populated" structurally); this is
 * guidance toward a layer worth reading.
 */
export function contentFindings(root: string, manifest: Manifest): Finding[] {
   const out: Finding[] = [];
   const bootRel = manifest.bootProfilePath;
   if (isFile(path.join(root, bootRel))) {
      const boot = readText(path.join(root, bootRel));
      if (PLACEHOLDER_RE.test(boot)) {
         out.push(
            finding(
               'content-placeholder',
               'warning',
               'boot profile still contains placeholder text (TODO: or <…>)',
               bootRel,
            ),
         );
      }
      const identity = sectionBody(boot, 'identity');
      if (identity === '' || identity.includes(GENERIC_IDENTITY) || PLACEHOLDER_RE.test(identity)) {
         out.push(
            finding(
               'content-identity',
               'warning',
               'boot profile Identity is empty or generic; say what this repository is, who it serves, and its stage',
               bootRel,
            ),
         );
      }
      if (UNCONFIRMED_RE.test(boot)) {
         out.push(
            finding(
               'content-unconfirmed',
               'warning',
               'boot profile has inferences awaiting owner confirmation',
               bootRel,
            ),
         );
      }
   }
   for (const cat of ['domain', 'system', 'practice', 'governance'] as const) {
      const mapping = manifest.categories[cat];
      if (!mapping) continue;
      let concrete = 0;
      for (const declared of mapping.paths) {
         for (const rel of walkMd(root, declared)) {
            const text = readText(path.join(root, rel));
            if (PLACEHOLDER_RE.test(text)) {
               out.push(
                  finding('content-placeholder', 'warning', `${cat} document still contains placeholder text`, rel),
               );
            }
            if (UNCONFIRMED_RE.test(text)) {
               out.push(
                  finding(
                     'content-unconfirmed',
                     'warning',
                     `${cat} document has inferences awaiting owner confirmation`,
                     rel,
                  ),
               );
            }
            for (const line of text.split('\n')) {
               if (/^\s*-\s+\S/.test(line) && !PLACEHOLDER_RE.test(line)) concrete++;
            }
         }
      }
      if ((cat === 'domain' || cat === 'system') && concrete < 3) {
         out.push(
            finding(
               'content-thin',
               'warning',
               `${cat} has ${concrete} concrete bullet${concrete === 1 ? '' : 's'}; aim for at least 3 repository-specific ones`,
               mapping.paths[0],
            ),
         );
      }
   }
   // Decisions an agent proposed but the owner has not yet accepted.
   for (const d of scanDecisionRecords(root, manifest)) {
      if (d.frontmatter?.status === 'proposed') {
         out.push(
            finding(
               'content-unconfirmed',
               'warning',
               `decision "${d.frontmatter.id ?? '?'}" is proposed; awaiting owner confirmation`,
               d.relPath,
            ),
         );
      }
   }
   return out;
}

/**
 * Full layer validation: manifest, level-aware artifact requirements, schema
 * checks, frontmatter contracts, lint rules. Index and changelog are required
 * from `indexed`; at least one valid agent profile from `governed`. Artifacts
 * present below their required level are still schema-validated. With
 * `opts.content`, appends the warning-only content lint.
 */
export function validateLayer(root: string, opts: { content?: boolean } = {}): ValidateResult {
   const { manifest, findings } = loadManifest(root);
   if (!manifest) return { findings: sortFindings(findings), manifest: null };

   const level = claimedLevel(manifest);

   // Git is required at core conformance and above (context-layer.md, Requirements):
   // history, checkout currency, and append-only integrity all derive from it. A
   // non-git working copy is a degraded read, not a canonical layer; warn rather
   // than pass it silently.
   if (gitToplevel(root) === null) {
      findings.push(
         finding(
            'git-required',
            'warning',
            'context layer is not in a git repository; core conformance requires git (a degraded, no-git copy cannot claim conformance)',
            'leji.json',
         ),
      );
   }

   checkBootProfile(root, manifest, findings);
   checkCategories(root, manifest, findings);
   checkVendorAdapters(root, manifest, findings);
   checkOwners(manifest, findings);
   checkAgentsMap(root, manifest, findings);
   checkFederationMounts(root, manifest, findings);
   checkProfilesAndDecisions(root, manifest, findings);

   const indexRel = effectiveIndexPath(manifest);
   const indexExists = isFile(path.join(root, indexRel));
   if (levelAtLeast(level, 'indexed') || indexExists) {
      if (!levelAtLeast(level, 'indexed') && indexExists) {
         const stored = readJsonArtifact(root, indexRel);
         if (stored.finding) findings.push(stored.finding);
         else {
            for (const err of schemaErrors('context-index', stored.data)) {
               findings.push(finding('artifact-schema', 'error', err, indexRel));
            }
            checkSchemaVersion(indexRel, stored.data, findings);
         }
      } else {
         // checkIndex covers schema, schemaVersion, and currency.
         findings.push(...checkIndex(root, manifest).findings);
      }
   }

   const changelogRel = effectiveChangelogPath(manifest);
   const changelogExists = isFile(path.join(root, changelogRel));
   if (levelAtLeast(level, 'indexed') && !changelogExists) {
      findings.push(finding('changelog-required', 'error', `changelog ${changelogRel} does not exist`, changelogRel));
   } else if (changelogExists) {
      findings.push(...checkChangelogAppendOnly(root, changelogRel).findings);
   }

   if (levelAtLeast(level, 'governed')) {
      const profiles = scanAgentProfiles(root, manifest);
      if (profiles.filter((p) => p.findings.length === 0).length === 0) {
         findings.push(
            finding(
               'profile-required',
               'error',
               'governed conformance requires at least one valid agent profile',
               effectiveAgentProfilesPath(manifest),
            ),
         );
      }
   }

   if (opts.content) findings.push(...contentFindings(root, manifest));

   return { findings: sortFindings(findings), manifest };
}
