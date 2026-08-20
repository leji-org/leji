import * as path from 'node:path';
import { type Finding, finding, sortFindings } from '../lib/findings.js';
import { gitToplevel } from '../lib/git.js';
import { exists, isFile } from '../lib/fsx.js';
import { scanAgentProfiles } from '../lib/layer.js';
import {
   type ConformanceLevel,
   type Manifest,
   CONFORMANCE_LEVELS,
   claimedLevel,
   effectiveChangelogPath,
   loadManifest,
} from '../lib/manifest.js';
import { checkIndex } from './indexgen.js';
import { checkChangelogAppendOnly, mountSurfacingFindings, validateLayer } from './validate.js';
import { freshnessReport } from './freshness.js';
import { checkPinReachability, normalizeSource } from '../lib/mounts.js';

export type ItemStatus = 'pass' | 'fail' | 'manual' | 'unknown' | 'not-applicable';

/** One conformance check and its outcome. The four non-passing outcomes mean four
 * different things and are deliberately not interchangeable:
 *
 * - `fail`: the evidence was gathered and the requirement is not met.
 * - `manual`: process-attested. No repository inspection can certify it (a review
 *   gate, a CI job, an external consumer); the team stands behind it.
 * - `unknown`: a machine requirement whose evidence was unobtainable in this run
 *   (pin reachability without source access; append-only discipline with no git
 *   baseline). It never awards a level and never refutes an honest claim.
 * - `not-applicable`: a conditional machine requirement that does not apply to this
 *   layer (the federated mount items when no mounts are declared). Not scored.
 *
 * Conformance evaluates the directory it is given, not a canonical layer that
 * directory might represent: a copy outside a git repository fails `core`'s git
 * requirement rather than leaving it unknown. */
export interface ChecklistItem {
   id: string;
   level: ConformanceLevel;
   description: string;
   status: ItemStatus;
   detail?: string;
}

/** Result of scoring a layer: claimed vs verified level plus per-item results. */
export interface ConformanceResult {
   claimedLevel: ConformanceLevel | null;
   /** Highest level whose machine-checkable items all pass. */
   verifiedLevel: ConformanceLevel | null;
   /** Count of the fixed set the spec tags `(process-attested)` (review gate, CI,
    * external consumption, stale-pin). Those are the only items ever reported
    * `manual`: unobtainable evidence is `unknown`, and a requirement that does not
    * apply to this layer is `not-applicable`. */
   processAttested: number;
   items: ChecklistItem[];
   findings: Finding[];
}

/** Items the spec tags `(process-attested)`: unconfirmable from the repo alone, so
 * always reported `manual` and never block a level. */
const PROCESS_ATTESTED_IDS = new Set(['review-gate', 'ci-validates', 'consumed-externally', 'stale-pin-reporting']);

/** `mount-discovery` states what it verifies and what it leaves to the team: the
 * enumeration, identity, and presence are machine-checked; the fidelity of the
 * authored free text to the declaration is not, and saying so is the honest claim. */
const MOUNT_DISCOVERY =
   "the boot profile carries a mount-surfacing block entry for every declared sibling, and the generated index carries the `mounts` routing array (enforced by index currency); what each sibling carries and when to read it are authored task language, whose fidelity to the declaration is the team's to attest";

function countProcessAttested(items: ChecklistItem[]): number {
   return items.filter((i) => PROCESS_ATTESTED_IDS.has(i.id)).length;
}

/**
 * Score the layer against the conformance checklists. Machine-checkable items
 * pass/fail; process items are `manual` and never block a level. A claim above
 * the verified level is an error.
 */
export function conformanceReport(root: string, opts: { federation?: boolean } = {}): ConformanceResult {
   const items: ChecklistItem[] = [];
   const findings: Finding[] = [];
   const { manifest } = loadManifest(root);

   const validation = validateLayer(root);
   const errorsBy = (rules: string[]): Finding[] =>
      validation.findings.filter((f) => f.severity === 'error' && rules.includes(f.rule));

   const add = (id: string, level: ConformanceLevel, description: string, status: ItemStatus, detail?: string) => {
      items.push(detail ? { id, level, description, status, detail } : { id, level, description, status });
   };

   // --- core ---
   const manifestErrors = errorsBy(['manifest-missing', 'manifest-parse', 'manifest-schema', 'manifest-line']);
   add(
      'manifest-valid',
      'core',
      'leji.json at the repository root, valid against the manifest schema',
      manifestErrors.length === 0 ? 'pass' : 'fail',
      manifestErrors[0]?.message,
   );

   // Git is a hard core MUST (context-layer.md). Conformance evaluates the directory
   // it was given, so "this copy is not in a repository" is gathered evidence, not
   // missing evidence: it is a `fail`. `validate` says the same thing in its
   // `git-required` finding; the two no longer contradict each other.
   const inGit = gitToplevel(root) !== null;
   add(
      'git',
      'core',
      'the context layer lives in a git repository, versioned with the work it describes',
      inGit ? 'pass' : 'fail',
      inGit ? undefined : 'not a git repository here; a degraded copy cannot verify conformance',
   );

   if (!manifest) {
      findings.push(...validation.findings.filter((f) => f.severity === 'error'));
      return {
         claimedLevel: null,
         verifiedLevel: null,
         processAttested: countProcessAttested(items),
         items,
         findings: sortFindings(findings),
      };
   }

   const bootErrors = errorsBy(['missing-declared-file', 'path-escapes-root']).filter(
      (f) => f.path === manifest.bootProfilePath,
   );
   add(
      'boot-profile',
      'core',
      'a boot profile at the declared path covering identity, loading, and posture',
      bootErrors.length === 0 ? 'pass' : 'fail',
      bootErrors[0]?.message,
   );

   const categoryErrors = errorsBy([
      'categories-minimum',
      'categories-intent-minimum',
      'category-index-missing',
      'index-file-missing',
      'index-file-parse',
      'category-conflict',
      'kind-invalid',
      'freshness-on-record',
      'index-entry-missing',
      'index-entry-not-markdown',
      'category-empty',
      'decisions-empty',
   ]);
   add(
      'categories',
      'core',
      'at least domain or system mapped and populated with at least one intent document, plus decisions with a real record',
      categoryErrors.length === 0 ? 'pass' : 'fail',
      categoryErrors[0]?.message,
   );

   add('owner', 'core', 'a named primary owner', manifest.owners?.primary?.name ? 'pass' : 'fail');

   const vendorErrors = errorsBy(['vendor-adapter-redirect']).concat(
      errorsBy(['missing-declared-file']).filter((f) => (manifest.vendorAdapters ?? []).includes(f.path ?? '')),
   );
   add(
      'vendor-redirects',
      'core',
      'vendor entrypoint files, if present, redirect to the boot profile',
      vendorErrors.length === 0 ? 'pass' : 'fail',
      vendorErrors[0]?.message,
   );

   // --- indexed ---
   const indexResult = checkIndex(root, manifest);
   add(
      'index-current',
      'indexed',
      'a generated context index, current with the tree',
      indexResult.stale === false ? 'pass' : 'fail',
      indexResult.findings[0]?.message,
   );

   const changelogRel = effectiveChangelogPath(manifest);
   if (isFile(path.join(root, changelogRel))) {
      const changelog = checkChangelogAppendOnly(root, changelogRel);
      const changelogErrors = changelog.findings.filter((f) => f.severity === 'error');
      if (changelogErrors.length > 0) {
         add(
            'changelog',
            'indexed',
            'a machine-readable changelog; layer changes append entries',
            'fail',
            changelogErrors[0].message,
         );
      } else if (!changelog.verified) {
         // The file is well-formed; what is missing is the prior committed state to
         // compare it against. That is unobtainable evidence, not a team practice,
         // so it is `unknown` and the level is not awarded from this copy.
         add(
            'changelog',
            'indexed',
            'a machine-readable changelog; layer changes append entries',
            'unknown',
            'append-only discipline unverifiable without a git baseline',
         );
      } else {
         add('changelog', 'indexed', 'a machine-readable changelog; layer changes append entries', 'pass');
      }
   } else {
      add(
         'changelog',
         'indexed',
         'a machine-readable changelog; layer changes append entries',
         'fail',
         `changelog ${changelogRel} does not exist`,
      );
   }

   // --- governed ---
   add('review-gate', 'governed', "layer changes ride the repository's review gate; people approve", 'manual');

   const validProfiles = scanAgentProfiles(root, manifest).filter((p) => p.findings.length === 0);
   // The checklist says "at least a core profile", so check the role rather than the
   // count: a layer carrying only a reviewer or release profile does not have the
   // shared posture the item exists to require.
   const hasCore = validProfiles.some((p) => (p.frontmatter as { role?: unknown } | null)?.role === 'core');
   add(
      'agent-profiles',
      'governed',
      'agent profiles (at least a core profile) valid against the profile schema',
      hasCore ? 'pass' : 'fail',
      hasCore
         ? undefined
         : validProfiles.length === 0
           ? 'no valid agent profile found'
           : 'no valid profile declares role "core"',
   );

   add(
      'ci-validates',
      'governed',
      'CI validates the surface: manifest, index currency, changelog discipline, profiles',
      'manual',
   );

   const freshness = freshnessReport(root, manifest);
   add(
      'freshness-declared',
      'governed',
      'freshness horizons are declared and checked (report-only is acceptable)',
      freshness.declared > 0 ? 'pass' : 'fail',
      freshness.declared === 0
         ? 'no freshness.reviewAfter declared anywhere'
         : `${freshness.declared} horizon(s) declared, ${freshness.expired.length} expired`,
   );

   // --- federated ---
   add(
      'consumed-externally',
      'federated',
      'the context layer is consumed by at least one other repository as a pinned mount',
      'manual',
   );
   add('stale-pin-reporting', 'federated', 'stale-pin reporting is in place', 'manual');
   const mounts = manifest.federation?.mounts ?? [];
   if (mounts.length > 0) {
      // A mount's declaration is complete when it carries a normalized source and a
      // full commit pin (schema-required; re-verified here so conformance stands
      // alone). Materialization is deliberately NOT a conformance input: an
      // unhydrated mount is honest degraded availability, never a failed claim.
      // Pin reachability from the source's advertised witness ref is the networked
      // check (`mounts status`); it reports `unknown` without source access and
      // unknown never awards the level.
      // "Normalized source" is checked with the resolver's own predicate, not with a
      // truthiness test standing in for it: a source that is merely nonempty is not
      // the thing the checklist line and distribution.md name, and an item that
      // passes on one claims evidence it never gathered.
      const badDecl = mounts
         .map((m) => ({
            name: m.name,
            defect:
               typeof m.source !== 'string' || normalizeSource(m.source) === null
                  ? 'declares a source that is not a normalizable locator'
                  : !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(m.pin ?? '')
                    ? 'lacks a full commit pin'
                    : null,
         }))
         .find((m) => m.defect !== null);
      add(
         'sibling-mounts',
         'federated',
         'sibling layers are declared as pinned mounts: a normalized source and a full commit pin, ownership intact',
         badDecl ? 'fail' : 'pass',
         badDecl ? `mount "${badDecl.name}" ${badDecl.defect}` : undefined,
      );
      // Pin reachability needs source access (the networked `--federation` probe);
      // without it the result is unknown, and unknown never awards the level.
      if (opts.federation) {
         let bad: { name: string; state: string; detail?: string } | undefined;
         for (const m of mounts) {
            const r = checkPinReachability(root, {
               name: m.name,
               source: m.source,
               pin: m.pin,
               trackingRef: m.trackingRef,
            });
            if (r.state !== 'reachable') {
               bad = { name: m.name, state: r.state, detail: r.detail };
               break;
            }
         }
         add(
            'pin-reachable',
            'federated',
            "each mount's pin is reachable from an advertised ref of its source",
            bad ? (bad.state === 'unreachable' ? 'fail' : 'unknown') : 'pass',
            bad ? `mount "${bad.name}": ${bad.detail ?? bad.state}` : undefined,
         );
      } else {
         add(
            'pin-reachable',
            'federated',
            "each mount's pin is reachable from an advertised ref of its source",
            'unknown',
            'needs source access; run `leji conformance --federation=verify`',
         );
      }
      const unrouted = mounts.filter(
         (m) =>
            !(m.categories && m.categories.length > 0) ||
            !((m.topics && m.topics.length > 0) || (m.requiredWhen && m.requiredWhen.length > 0)),
      );
      add(
         'mount-routing',
         'federated',
         'each mount carries routing metadata: categories, plus topics or requiredWhen',
         unrouted.length === 0 ? 'pass' : 'fail',
         unrouted.length > 0 ? `mount "${unrouted[0].name}" lacks categories and/or topics or requiredWhen` : undefined,
      );
      // Surfacing is read from the block scan, not from a substring test: a mount
      // name mentioned in unrelated prose or in an example used to count as
      // surfaced. The findings arrive in the check's own deterministic order, so
      // the detail below is the same first finding in every SDK.
      const surfacing = mountSurfacingFindings(root, manifest);
      add(
         'mount-discovery',
         'federated',
         MOUNT_DISCOVERY,
         surfacing.length === 0 ? 'pass' : 'fail',
         surfacing[0]?.message,
      );
   } else {
      // All four conditional mount items, in the same order as the branch above:
      // reporting two of them and dropping the other two made the checklist read as
      // though `pin-reachable` and `mount-routing` had simply not been considered.
      // `not-applicable` is not scored either way, so this changes the report, not
      // the level.
      add(
         'sibling-mounts',
         'federated',
         'sibling layers are mounted with ownership intact',
         'not-applicable',
         'no federation.mounts declared',
      );
      add(
         'pin-reachable',
         'federated',
         "each mount's pin is reachable from an advertised ref of its source",
         'not-applicable',
         'no federation.mounts declared',
      );
      add(
         'mount-routing',
         'federated',
         'each mount carries routing metadata: categories, plus topics or requiredWhen',
         'not-applicable',
         'no federation.mounts declared',
      );
      add('mount-discovery', 'federated', MOUNT_DISCOVERY, 'not-applicable', 'no federation.mounts declared');
   }

   // --- scoring ---
   let verified: ConformanceLevel | null = null;
   for (const level of CONFORMANCE_LEVELS) {
      const machineItems = items.filter(
         (i) => i.level === level && i.status !== 'manual' && i.status !== 'not-applicable',
      );
      // Machine-verified needs real evidence: every machine item passes AND there's
      // at least one. A level whose items are all process-attested never lifts it,
      // `unknown` never awards a level (evidence absent is not evidence), and a
      // requirement that does not apply here is not evidence either.
      if (machineItems.length === 0 || machineItems.some((i) => i.status === 'fail' || i.status === 'unknown')) break;
      verified = level;
   }

   const claimed = claimedLevel(manifest);
   // Verification answers "does the claim hold?", not "what could be claimed": never
   // report a verified level above the claim.
   if (verified !== null && CONFORMANCE_LEVELS.indexOf(verified) > CONFORMANCE_LEVELS.indexOf(claimed)) {
      verified = claimed;
   }
   // The claim gate matches the self-attestation posture: a claim is dishonest
   // when a machine item at or below it FAILS, or when a claimed level carries no
   // machine-evaluated evidence at all (the vacuity trap: e.g. federated with zero
   // mounts). `manual` never blocks a claim, and neither does `unknown`: absent
   // evidence caps the verified level, but an offline run does not refute a claim
   // the networked probe could confirm.
   const claimedIdx = CONFORMANCE_LEVELS.indexOf(claimed);
   let claimProblem = false;
   for (const level of CONFORMANCE_LEVELS.slice(0, claimedIdx + 1)) {
      // `not-applicable` is excluded alongside `manual`: a requirement that does not
      // apply here is not machine evidence, so a level carrying only such items is
      // still vacuous (federated with zero mounts is exactly that case).
      const evaluated = items.filter(
         (i) => i.level === level && i.status !== 'manual' && i.status !== 'not-applicable',
      );
      if (evaluated.length === 0 || evaluated.some((i) => i.status === 'fail')) {
         claimProblem = true;
         break;
      }
   }
   if (claimProblem) {
      findings.push(
         finding(
            'conformance-claim',
            'error',
            `claimed level "${claimed}" exceeds the verified level "${verified ?? 'none'}"`,
            'leji.json',
         ),
      );
   }

   return {
      claimedLevel: claimed,
      verifiedLevel: verified,
      processAttested: countProcessAttested(items),
      items,
      findings: sortFindings(findings),
   };
}

/**
 * Guidance (`conformance --explain`): what it takes to reach the next level above
 * the verified one, listing not-yet-passing items (manual ones flagged as process).
 */
export function renderExplain(result: ConformanceResult): string {
   const levels = CONFORMANCE_LEVELS;
   const verifiedIdx = result.verifiedLevel ? levels.indexOf(result.verifiedLevel) : -1;
   const lines = [`Verified level: ${result.verifiedLevel ?? 'none'} (claimed: ${result.claimedLevel ?? 'none'}).`];
   const nextIdx = verifiedIdx + 1;
   if (nextIdx >= levels.length) {
      lines.push('This layer is at the top conformance level (federated). Nothing further to reach.');
      return lines.join('\n');
   }
   const next = levels[nextIdx];
   // `not-applicable` is not a blocker: there is nothing for the team to do about a
   // requirement that does not apply to this layer, and listing it as a step reads as
   // an instruction.
   const blockers = result.items.filter(
      (i) => i.level === next && i.status !== 'pass' && i.status !== 'not-applicable',
   );
   lines.push('', `To reach "${next}":`);
   if (blockers.length === 0) {
      lines.push(`   - all "${next}" checks already pass; set conformance.claimedLevel to "${next}" in leji.json`);
   } else {
      for (const b of blockers) {
         const how =
            b.status === 'manual'
               ? ' (process step; tooling cannot verify)'
               : b.status === 'unknown'
                 ? ' (evidence unobtainable in this run; unknown never awards the level)'
                 : '';
         lines.push(`   - ${b.description}${b.detail ? `: ${b.detail}` : ''}${how}`);
      }
   }
   lines.push(
      '',
      'Content quality (not a conformance gate): run `leji validate --content` for placeholder and thin-content warnings.',
   );
   return lines.join('\n');
}
