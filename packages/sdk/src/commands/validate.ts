import * as path from 'node:path';
import { type Finding, finding, sortFindings } from '../lib/findings.js';
import { exists, isFile, readText, readTextWithin, resolvedWithinRoot, underPath } from '../lib/fsx.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { gitShowHead, gitToplevel } from '../lib/git.js';
import {
   type ScannedProfile,
   duplicateIdFindings,
   findingKey,
   profileInheritanceFindings,
   readJsonArtifact,
   scanAgentProfiles,
   scanCategories,
   scanDecisionRecords,
   scanProfileSet,
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
import { parseMountBlocks, valueRepresentationError } from '../lib/mountblock.js';
import { cacheKeyFor, normalizeSource, validTrackingRef } from '../lib/mounts.js';
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
 * `date`, then `id`. `date` is UTC, so a lexical compare is chronological; `id`
 * is unique, so the pair is a total order.
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
   const text = readTextWithin(path.resolve(root), path.join(root, rel));
   if (text === null) {
      findings.push(finding('path-escapes-root', 'error', 'boot profile resolves outside the layer root', rel));
      return;
   }

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
      for (const indexRel of manifest.categories[category]!.indexes) {
         if (!isFile(path.join(root, indexRel))) {
            findings.push(
               finding('category-index-missing', 'error', `${category} index file does not exist`, indexRel),
            );
         } else if (!underPath(indexRel, manifest.rootPath)) {
            findings.push(
               finding(
                  'paths-outside-root',
                  'warning',
                  `${category} index file falls outside rootPath ${manifest.rootPath}`,
                  indexRel,
               ),
            );
         }
      }
   }
   // Surface index parse/resolution/conflict findings, and require every mapped
   // category to resolve to at least one governed document (empty isn't populated).
   const scan = scanCategories(root, manifest);
   findings.push(...scan.findings);
   const populated = new Set(scan.docs.map((d) => d.category));
   for (const category of mapped) {
      if (!populated.has(category)) {
         findings.push(
            finding(
               'category-empty',
               'error',
               `${category} resolves to no governed documents; map index entries that exist, or remove the category`,
               manifest.categories[category]!.indexes[0],
            ),
         );
      }
   }
   // The domain/system minimum needs at least one intent document: a layer of
   // records alone preserves history but carries no operating context.
   const minimumMapped = mapped.filter((c) => c === 'domain' || c === 'system');
   const minimumPopulated = minimumMapped.some((c) => populated.has(c));
   if (
      minimumPopulated &&
      !scan.docs.some((d) => (d.category === 'domain' || d.category === 'system') && d.kind === 'intent')
   ) {
      findings.push(
         finding(
            'categories-intent-minimum',
            'error',
            'domain/system must include at least one intent document; records alone carry no operating context',
            'leji.json',
         ),
      );
   }
   // Freshness horizons are an intent mechanism; on a record they promise a
   // currency the document cannot have.
   for (const doc of scan.docs) {
      if (doc.kind !== 'record') continue;
      const fresh = doc.frontmatter?.freshness as { reviewAfter?: unknown } | undefined;
      if (fresh?.reviewAfter !== undefined) {
         findings.push(
            finding(
               'freshness-on-record',
               'error',
               'a record carries no review horizon (its date is its currency); remove freshness.reviewAfter or reclassify the document as intent',
               doc.relPath,
            ),
         );
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
      // A vendor entrypoint symlinking outside root is not read (adopt treats such
      // files as absent too).
      if (!resolvedWithinRoot(path.resolve(root), abs)) continue;
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
   // Continuity owner covers the primary's absence (governance.md req 4); the same
   // person provides no continuity.
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

/**
 * Semantic checks the manifest schema cannot express. The shape of `actors` is
 * schema-checked; what is left is the cross-field relation between an actor's
 * declared roles and its per-role commands, and the collision between an actor-role
 * command and a bound profile's own `invocation`. Both are structural
 * contradictions, not policy: nothing here judges how many actors a role should have
 * or whether it needs a profile.
 */
function checkActors(root: string, manifest: Manifest, findings: Finding[]): void {
   const actors = manifest.actors;
   if (!actors) return;
   const actorBackedRoles = new Set<string>();
   // Sorted, not insertion order: Go's map iteration is random so it must sort, and
   // raw SDK finding order is part of what the three implementations agree on.
   for (const actorId of Object.keys(actors).sort()) {
      const actor = actors[actorId];
      const roles = actor.roles ?? [];
      const commandRoles = Object.keys(actor.commands ?? {}).sort();
      for (const role of roles) actorBackedRoles.add(role);
      // The key set must equal the role list in both directions: a role with no
      // command cannot be invoked, and a command for an undeclared role has no
      // defined relationship to eligibility.
      for (const role of roles) {
         if (!commandRoles.includes(role)) {
            findings.push(
               finding(
                  'actor-command-missing',
                  'error',
                  `actor "${actorId}" declares role "${role}" with no command for it`,
                  'leji.json',
               ),
            );
         }
      }
      for (const role of commandRoles) {
         if (!roles.includes(role)) {
            findings.push(
               finding(
                  'actor-command-unclaimed',
                  'error',
                  `actor "${actorId}" has a command for role "${role}", which it does not declare in roles`,
                  'leji.json',
               ),
            );
         }
      }
   }
   // An actor-backed role whose profile also carries `invocation` has two
   // authoritative commands and no defined precedence. Rather than invent one, the
   // layer is asked to pick a single source.
   const profilesDir = effectiveAgentProfilesPath(manifest);
   for (const [role, rel] of Object.entries(manifest.agents ?? {})) {
      if (!actorBackedRoles.has(role)) continue;
      const abs = path.join(root, rel);
      if (!isFile(abs)) continue;
      void profilesDir;
      const fm = parseFrontmatter(readTextWithin(path.resolve(root), abs) ?? '');
      const data = fm.data as { invocation?: unknown } | null;
      if (data && data.invocation !== undefined) {
         findings.push(
            finding(
               'actor-profile-invocation',
               'error',
               `role "${role}" is actor-backed, but its profile also declares invocation; declare the command in one place`,
               rel,
            ),
         );
      }
   }
}

function checkAgentsMap(root: string, manifest: Manifest, findings: Finding[]): void {
   const profilesDir = effectiveAgentProfilesPath(manifest);
   for (const [role, rel] of Object.entries(manifest.agents ?? {})) {
      if (!checkDeclaredFile(root, rel, `agents.${role} profile`, findings)) continue;
      // Targets under agentProfilesPath are covered by the directory scan; those
      // outside it still owe valid agent-profile frontmatter.
      if (underPath(rel, profilesDir)) continue;
      const text = readTextWithin(path.resolve(root), path.join(root, rel));
      if (text === null) {
         findings.push(
            finding('path-escapes-root', 'error', `agents.${role} profile resolves outside the layer root`, rel),
         );
         continue;
      }
      const fm = parseFrontmatter(text);
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

/** Warn when `agents.default` is bound AND the boot profile references that profile's
 * declared path. Binding a profile at the `default` key never causes it to load (only
 * the boot profile's own instructions do), so a boot profile that unconditionally
 * loads it is indirection, not routing: the two should be one canonical boot document. */
function checkBootAgentsDefault(root: string, manifest: Manifest, findings: Finding[]): void {
   const defaultRel = manifest.agents?.default;
   if (!defaultRel) return;
   const boot = readTextWithin(path.resolve(root), path.join(root, manifest.bootProfilePath));
   if (boot === null || !boot.includes(defaultRel)) return;
   findings.push(
      finding(
         'boot-agents-default',
         'warning',
         'agents.default is bound but never auto-loaded; a boot profile that unconditionally loads it should be one canonical boot document (fold the default profile in)',
         'leji.json',
      ),
   );
}

function checkFederationMounts(root: string, manifest: Manifest, findings: Finding[]): void {
   const mounts = manifest.federation?.mounts ?? [];
   // Three separated concerns (distribution.md pattern 3): declaration validity is
   // an error (the manifest lies); local availability is a warning (degraded
   // knowledge, never the build); materialization integrity belongs to
   // `mounts status`, not ordinary validation. Schema requiredness already
   // guarantees name/source/pin on every declared mount.
   const seenNames = new Set<string>();
   const badNames = new Set<string>();
   for (const mount of mounts) {
      if (seenNames.has(mount.name)) {
         findings.push(
            finding('mount-duplicate', 'error', `two mounts declare the same name "${mount.name}"`, mount.name),
         );
         badNames.add(mount.name);
      } else {
         seenNames.add(mount.name);
      }
      if (mount.name === manifest.name) {
         findings.push(
            finding('mount-self', 'error', `mount "${mount.name}" reuses the host layer's own name`, mount.name),
         );
         badNames.add(mount.name);
      }
      // The resolver's own predicates, not a second reading of them: a source the
      // resolver cannot normalize and a trackingRef it will not follow are exactly
      // the "malformed source or pin" distribution.md calls a manifest error. Left as
      // availability, an unnormalizable source read as a mount that merely is not
      // hydrated here, which is a warning, and the lie went out as degraded weather.
      if (typeof mount.source !== 'string' || normalizeSource(mount.source) === null) {
         findings.push(
            finding(
               'mount-source',
               'error',
               `mount "${mount.name}" declares a source that is not a normalizable locator; use an https://, ssh://, or SCP-style remote URL`,
               mount.name,
            ),
         );
         badNames.add(mount.name);
      }
      if (mount.trackingRef !== undefined && !validTrackingRef(mount.trackingRef)) {
         findings.push(
            finding(
               'mount-tracking-ref',
               'error',
               `mount "${mount.name}" declares a trackingRef that is not a fully qualified branch or tag (refs/heads/... or refs/tags/...)`,
               mount.name,
            ),
         );
         badNames.add(mount.name);
      }
   }
   // Availability is reported only for cleanly declared mounts (never for a name
   // the manifest lies about), once per name.
   const warned = new Set<string>();
   for (const mount of mounts) {
      if (badNames.has(mount.name) || warned.has(mount.name)) continue;
      warned.add(mount.name);
      if (mountProjectionDir(root, mount) === null) {
         findings.push(
            finding(
               'mount-unavailable',
               'warning',
               `mount "${mount.name}" is not hydrated here; sibling knowledge is degraded, never the build. Run \`leji mounts hydrate\`.`,
               mount.name,
            ),
         );
      }
   }
}

/**
 * Mount surfacing (boot-profile.md requirement 9): a host that declares
 * `federation.mounts` surfaces each sibling in its boot profile through a
 * `leji-mounts` block, so an agent discovers siblings in the task-language
 * entrypoint without reading the manifest. Every condition below is an error, and
 * findings accumulate; nothing stops at the first.
 *
 * | Condition | Code |
 * |---|---|
 * | mounts declared, boot profile carries no `leji-mounts` block | `mount-surfacing-block` |
 * | no mounts declared, any `leji-mounts` block (an empty one included) | `mount-surfacing-block` |
 * | malformed line, unknown/duplicate/missing field, empty or padded value | `mount-surfacing-syntax` |
 * | an entry naming a mount the manifest does not declare | `mount-surfacing-unknown` |
 * | more than one entry for one declared mount | `mount-surfacing-duplicate` |
 * | a declared mount with no entry | `mount-surfacing-missing` |
 * | an entry whose `owner` differs from the declared `owner.name` | `mount-surfacing-owner` |
 * | a declared `name` no block value could carry | `mount-name-line` |
 * | a declared `owner.name` no block value could carry | `mount-owner-name-line` |
 *
 * Order is deterministic and independent of the finding sort applied downstream:
 * the block finding, then syntax findings in document order, then entry findings
 * in document order, then missing/owner findings in declared-mount order, then the
 * manifest-side identity findings in declared-mount order, `mount-name-line` before
 * `mount-owner-name-line` for the same mount. `conformance` reports the first of them.
 *
 * What is deliberately not checked: whether `carries` and `read-when` faithfully
 * describe the sibling. That is authored task language; presence is machine-checked
 * and fidelity is the team's to attest.
 */
export function mountSurfacingFindings(root: string, manifest: Manifest): Finding[] {
   const mounts = manifest.federation?.mounts ?? [];
   const rel = manifest.bootProfilePath;
   const findings: Finding[] = [];
   const text = readTextWithin(path.resolve(root), path.join(root, rel));
   if (text === null) {
      // The structural pass already reports the missing or escaping boot profile;
      // with mounts declared it is also a surfacing failure, which conformance reads.
      if (mounts.length > 0) {
         findings.push(
            finding(
               'mount-surfacing-block',
               'error',
               'boot profile is missing or unreadable, so it surfaces none of the declared mounts',
               rel,
            ),
         );
      }
      return findings;
   }

   const parsed = parseMountBlocks(text);
   if (mounts.length === 0) {
      if (parsed.sawBlock) {
         findings.push(
            finding(
               'mount-surfacing-block',
               'error',
               'this layer declares no federation.mounts; remove the leji-mounts block',
               rel,
            ),
         );
      }
      return findings;
   }

   // Declared order, first occurrence per name: a repeated name is `mount-duplicate`
   // in the manifest check, and must not also cascade through surfacing.
   const declared: typeof mounts = [];
   const declaredNames = new Set<string>();
   for (const mount of mounts) {
      if (declaredNames.has(mount.name)) continue;
      declaredNames.add(mount.name);
      declared.push(mount);
   }

   if (!parsed.sawBlock) {
      findings.push(
         finding(
            'mount-surfacing-block',
            'error',
            `${declared.length} mount(s) declared but the boot profile carries no leji-mounts block; surface each sibling there`,
            rel,
         ),
      );
   }
   for (const err of parsed.errors) {
      findings.push(finding('mount-surfacing-syntax', 'error', `line ${err.line}: ${err.message}`, rel));
   }

   const surfaced = new Map<string, string>(); // mount name -> the owner its first entry names
   for (const entry of parsed.entries) {
      if (!declaredNames.has(entry.mount)) {
         findings.push(
            finding(
               'mount-surfacing-unknown',
               'error',
               `line ${entry.line}: entry names "${entry.mount}", which this layer does not declare as a mount`,
               rel,
            ),
         );
         continue;
      }
      if (surfaced.has(entry.mount)) {
         findings.push(
            finding(
               'mount-surfacing-duplicate',
               'error',
               `line ${entry.line}: mount "${entry.mount}" is surfaced more than once; each declared mount gets exactly one entry`,
               rel,
            ),
         );
         continue;
      }
      surfaced.set(entry.mount, entry.owner);
   }

   for (const mount of declared) {
      const owner = surfaced.get(mount.name);
      if (owner === undefined) {
         if (parsed.sawBlock) {
            findings.push(
               finding(
                  'mount-surfacing-missing',
                  'error',
                  `declared mount "${mount.name}" has no entry in the leji-mounts block`,
                  rel,
               ),
            );
         }
      } else if (owner !== mount.owner?.name) {
         findings.push(
            finding(
               'mount-surfacing-owner',
               'error',
               `mount "${mount.name}" is surfaced with owner "${owner}" but is declared with owner "${mount.owner?.name ?? ''}"`,
               rel,
            ),
         );
      }
   }

   // An identity the block could never carry: the declaration itself is at fault, so
   // the finding points at the manifest rather than at the boot profile. Both
   // identity fields are free strings in the schema (`name` and `owner.name` carry
   // only minLength), so both are checked, name first for the same mount.
   for (const mount of declared) {
      const badName = valueRepresentationError(mount.name);
      if (badName) {
         findings.push(
            finding(
               'mount-name-line',
               'error',
               `mount "${mount.name}" declares a name no leji-mounts entry could carry: ${badName}`,
               'leji.json',
            ),
         );
      }
      const badOwner = valueRepresentationError(mount.owner?.name ?? '');
      if (badOwner) {
         findings.push(
            finding(
               'mount-owner-name-line',
               'error',
               `mount "${mount.name}" declares an owner name no leji-mounts entry could carry: ${badOwner}`,
               'leji.json',
            ),
         );
      }
   }
   return findings;
}

/** Resolve a mount's hydrated projection directory, or null when it is not
 * materialized here. The cache key is derived from the declaration itself, so there
 * is no state file to read and nothing to fall out of step with the manifest; a
 * projection counts only when it carries its completion marker, since a directory
 * without one is an entry that was never published. */
export function mountProjectionDir(
   root: string,
   mount: { name: string; source?: string; pin?: string },
): string | null {
   if (typeof mount.source !== 'string' || typeof mount.pin !== 'string') return null;
   const identity = normalizeSource(mount.source);
   if (identity === null) return null;
   const projection = path.join(root, '.leji', 'mounts', 'cache', cacheKeyFor(identity, mount.pin), 'projection');
   return isFile(path.join(projection, 'complete')) ? projection : null;
}

function checkProfilesAndDecisions(root: string, manifest: Manifest, findings: Finding[]): void {
   const profiles = scanAgentProfiles(root, manifest);
   const ids: { id: unknown; relPath: string }[] = [];
   for (const p of profiles) {
      findings.push(...p.findings);
      ids.push({ id: p.frontmatter?.id, relPath: p.relPath });
   }
   findings.push(...duplicateIdFindings(ids, 'agent profile'));
   // Authored frontmatter validates against the schema above; `inherits` is
   // operative, so every profile that declares one is also resolved, and a
   // resolution that cannot complete is an error (the derived file alone is not
   // the profile). Resolved against the whole roster, bound out-of-directory
   // profiles included.
   findings.push(...profileInheritanceFindings(scanProfileSet(root, manifest)));

   const decisions = scanDecisionRecords(root, manifest);
   const decisionIds: { id: unknown; relPath: string }[] = [];
   for (const d of decisions) {
      findings.push(...d.findings);
      decisionIds.push({ id: d.frontmatter?.id, relPath: d.relPath });
   }
   findings.push(...duplicateIdFindings(decisionIds, 'decision record'));
   checkSupersession(decisions, findings);

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

interface SupersedeRec {
   id: string;
   status: string;
   supersedes?: string;
   supersededBy?: string;
   relPath: string;
}

/**
 * Cross-record supersession integrity (decisions.md). The schema enforces the
 * within-record half; this enforces the across-record half: for `B supersedes A`,
 * A must exist, be `superseded`, and point `supersededBy` back at B (and the
 * mirror for `supersededBy`). `supersededBy` on a non-`superseded` record and
 * supersession cycles are rejected. Otherwise a forgotten flip leaves both
 * decisions live in routing.
 */
function checkSupersession(decisions: ScannedProfile[], findings: Finding[]): void {
   const recs: SupersedeRec[] = [];
   const byId = new Map<string, SupersedeRec>();
   for (const d of decisions) {
      const fm = d.frontmatter;
      if (!fm || typeof fm.id !== 'string') continue;
      const rec: SupersedeRec = {
         id: fm.id,
         status: typeof fm.status === 'string' ? fm.status : '',
         supersedes: typeof fm.supersedes === 'string' ? fm.supersedes : undefined,
         supersededBy: typeof fm.supersededBy === 'string' ? fm.supersededBy : undefined,
         relPath: d.relPath,
      };
      recs.push(rec);
      if (!byId.has(rec.id)) byId.set(rec.id, rec);
   }
   const err = (msg: string, relPath: string): void => {
      findings.push(finding('decision-supersession', 'error', msg, relPath));
   };

   for (const r of recs) {
      if (r.supersededBy !== undefined && r.status !== 'superseded') {
         err(`supersededBy is set but status is "${r.status || 'unset'}", not "superseded"`, r.relPath);
      }
      if (r.supersedes !== undefined) {
         const target = byId.get(r.supersedes);
         if (!target) {
            err(`supersedes "${r.supersedes}" but no decision record has that id`, r.relPath);
         } else {
            if (target.status !== 'superseded') {
               err(
                  `is superseded by "${r.id}", so its status must be "superseded" but is "${target.status || 'unset'}"`,
                  target.relPath,
               );
            }
            if (target.supersededBy !== r.id) {
               err(`is superseded by "${r.id}", but its supersededBy does not point back to "${r.id}"`, target.relPath);
            }
         }
      }
      if (r.supersededBy !== undefined) {
         const successor = byId.get(r.supersededBy);
         if (!successor) {
            err(`supersededBy "${r.supersededBy}" but no decision record has that id`, r.relPath);
         } else if (successor.supersedes !== r.id) {
            err(`supersededBy "${r.supersededBy}", but that record does not declare supersedes "${r.id}"`, r.relPath);
         }
      }
   }

   // Cycle detection over supersedes edges (id -> the id it supersedes).
   const color = new Map<string, number>(); // 0 unvisited, 1 in-progress, 2 done
   const onCycle = new Set<string>();
   const visit = (id: string, stack: string[]): void => {
      const c = color.get(id) ?? 0;
      if (c === 2) return;
      if (c === 1) {
         for (const cyc of stack.slice(stack.indexOf(id))) onCycle.add(cyc);
         return;
      }
      color.set(id, 1);
      stack.push(id);
      const r = byId.get(id);
      if (r?.supersedes !== undefined && byId.has(r.supersedes)) visit(r.supersedes, stack);
      stack.pop();
      color.set(id, 2);
   };
   for (const r of recs) visit(r.id, []);
   for (const r of recs) {
      if (onCycle.has(r.id)) err(`decision "${r.id}" is part of a supersession cycle`, r.relPath);
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
 * Append-only discipline: entries present at HEAD must survive unchanged; new
 * entries only append (oldest-end compaction excepted). Without a git baseline
 * this is unverifiable — warning, or error under --strict.
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
      // No committed state to compare against: an unborn repository, or a changelog
      // not yet in HEAD. Append-only discipline is unverifiable here, not satisfied.
      // Reporting it verified is how a fresh `git init` came to verify `indexed`.
      return { findings, verified: false };
   }
   let headEntries: ChangelogEntry[];
   try {
      const parsed = (JSON.parse(headText) as { entries?: unknown }).entries;
      headEntries = Array.isArray(parsed)
         ? parsed.filter((e): e is ChangelogEntry => e !== null && typeof e === 'object')
         : [];
   } catch {
      // The HEAD blob is unparseable, so it yields no baseline to compare against.
      return { findings, verified: false };
   }
   // Set-keyed by `id` (machine-readable-surface.md req 3): order derives from
   // (date, id), not array position, so reordering is fine. HEAD entries survive
   // unchanged unless compacted from the OLDEST end with a `compaction` entry added.
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
      const appendedCompactions = entries.filter((e) => !headById.has(e.id) && e.type === 'compaction');
      if (appendedCompactions.length === 0) {
         findings.push(
            finding(
               'changelog-append-only',
               'error',
               `${n} ${n === 1 ? 'entry' : 'entries'} removed since HEAD without a compaction entry recording the drop`,
               rel,
            ),
         );
      } else if (appendedCompactions.length > 1) {
         findings.push(
            finding(
               'changelog-append-only',
               'error',
               `${appendedCompactions.length} compaction entries were appended for one drop; a drop records exactly one`,
               rel,
            ),
         );
      } else {
         // The appended compaction entry must record the dropped run: count and
         // first/last id in canonical (date, id) order.
         const c = appendedCompactions[0].compacted;
         const rec = c && typeof c === 'object' ? (c as Record<string, unknown>) : {};
         const cEntries = typeof rec.entries === 'number' ? rec.entries : undefined;
         const cFirst = typeof rec.firstId === 'string' ? rec.firstId : undefined;
         const cLast = typeof rec.lastId === 'string' ? rec.lastId : undefined;
         const firstDropped = droppedIds[0];
         const lastDropped = droppedIds[n - 1];
         if (cEntries !== n || cFirst !== firstDropped || cLast !== lastDropped) {
            findings.push(
               finding(
                  'changelog-append-only',
                  'error',
                  `compaction entry records ${cEntries ?? '?'} entries (${cFirst ?? '?'}..${cLast ?? '?'}) but ${n} were dropped (${firstDropped}..${lastDropped})`,
                  rel,
               ),
            );
         }
      }
   }
   return { findings, verified: true };
}

/** Scaffold placeholder markers: seeded `TODO:` lines or `<…>` angle-bracket stubs. */
const PLACEHOLDER_RE = /\bTODO:|<[A-Za-z][^>\n]*>/;
/** Unconfirmed agent inferences: `TODO(confirm-…)` or `UNCONFIRMED:` lines. The
 * `TODO(confirm-…)` form deliberately does not match PLACEHOLDER_RE's `TODO:`. */
const UNCONFIRMED_RE = /TODO\(confirm[-:][^)\n]*\)|UNCONFIRMED:/;
/** The generic identity init writes by default; real layers replace it. */
const GENERIC_IDENTITY = 'Shared context layer for this repository.';

/** Body text of the first heading whose title contains `heading`, up to the next heading. */
function sectionBody(text: string, heading: string): string {
   // Substring-test heading titles linearly; avoids a backtracking regex (ReDoS).
   const needle = heading.toLowerCase();
   let bodyStart = -1;
   for (const m of text.matchAll(/^#{1,6}[ \t]+(.*)$/gm)) {
      const at = m.index ?? 0;
      if (bodyStart === -1) {
         if (m[1].toLowerCase().includes(needle)) bodyStart = at + m[0].length;
      } else {
         return text.slice(bodyStart, at).trim();
      }
   }
   return bodyStart === -1 ? '' : text.slice(bodyStart).trim();
}

/**
 * Opt-in content lint (`validate --content`): warning-only signals that a layer is
 * still a scaffold — placeholder text, generic boot identity, thin domain/system.
 * Never errors or affects conformance level (conformance.md defines "populated"
 * structurally); this is guidance toward a layer worth reading.
 */
export function contentFindings(root: string, manifest: Manifest): Finding[] {
   const out: Finding[] = [];
   const bootRel = manifest.bootProfilePath;
   // A boot profile symlinking outside root is skipped (the structural pass flags
   // it). Content lint is advisory, so an unreadable boot profile yields nothing.
   const boot = readTextWithin(path.resolve(root), path.join(root, bootRel));
   if (boot !== null) {
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
   const docsByCat = new Map<string, { relPath: string; text: string }[]>();
   for (const doc of scanCategories(root, manifest).docs) {
      const arr = docsByCat.get(doc.category) ?? [];
      arr.push({ relPath: doc.relPath, text: readText(path.join(root, doc.relPath)) });
      docsByCat.set(doc.category, arr);
   }
   for (const cat of ['domain', 'system', 'practice', 'governance'] as const) {
      const mapping = manifest.categories[cat];
      if (!mapping) continue;
      const docs = docsByCat.get(cat) ?? [];
      let concrete = 0;
      for (const { relPath, text } of docs) {
         if (PLACEHOLDER_RE.test(text)) {
            out.push(
               finding('content-placeholder', 'warning', `${cat} document still contains placeholder text`, relPath),
            );
         }
         if (UNCONFIRMED_RE.test(text)) {
            out.push(
               finding(
                  'content-unconfirmed',
                  'warning',
                  `${cat} document has inferences awaiting owner confirmation`,
                  relPath,
               ),
            );
         }
         for (const line of text.split('\n')) {
            if (/^\s*-\s+\S/.test(line) && !PLACEHOLDER_RE.test(line)) concrete++;
         }
      }
      if ((cat === 'domain' || cat === 'system') && concrete < 3) {
         out.push(
            finding(
               'content-thin',
               'warning',
               `${cat} has ${concrete} concrete bullet${concrete === 1 ? '' : 's'}; aim for at least 3 repository-specific ones`,
               mapping.indexes[0],
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
 * Full layer validation: manifest, level-aware artifact requirements, schema,
 * frontmatter, lint. Index and changelog required from `indexed`; one valid agent
 * profile from `governed`. Artifacts present below their required level are still
 * schema-validated. With `opts.content`, appends the warning-only content lint.
 */
export function validateLayer(root: string, opts: { content?: boolean } = {}): ValidateResult {
   const { manifest, findings } = loadManifest(root);
   if (!manifest) return { findings: sortFindings(findings), manifest: null };

   const level = claimedLevel(manifest);

   // Git is required at core and above (context-layer.md, Requirements): history,
   // currency, and append-only integrity derive from it. A non-git copy is a
   // degraded read, not a canonical layer — warn rather than pass silently.
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
   checkActors(root, manifest, findings);
   checkBootAgentsDefault(root, manifest, findings);
   checkFederationMounts(root, manifest, findings);
   findings.push(...mountSurfacingFindings(root, manifest));
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
         // checkIndex covers schema, schemaVersion, and currency. It re-runs the
         // category scan to generate the expected index, so every parse, conflict and
         // resolution finding the scan above already contributed comes back a second
         // time; one bad index-file line was reported twice. Deduplicated by the same
         // identity relation resolution uses, because two findings with the same rule,
         // severity, message and path are the same finding to every reader.
         const alreadyReported = new Set(findings.map(findingKey));
         for (const f of checkIndex(root, manifest).findings) {
            if (!alreadyReported.has(findingKey(f))) findings.push(f);
         }
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
