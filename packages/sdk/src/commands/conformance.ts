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
   loadManifest,
} from '../lib/manifest.js';
import { checkIndex } from './indexgen.js';
import { checkChangelogAppendOnly, validateLayer } from './validate.js';
import { freshnessReport } from './freshness.js';

export type ItemStatus = 'pass' | 'fail' | 'manual';

export interface ChecklistItem {
   id: string;
   level: ConformanceLevel;
   description: string;
   status: ItemStatus;
   detail?: string;
}

export interface ConformanceResult {
   claimedLevel: ConformanceLevel | null;
   /** Highest level whose machine-checkable items all pass. */
   verifiedLevel: ConformanceLevel | null;
   items: ChecklistItem[];
   findings: Finding[];
}

/**
 * Score the layer against the conformance checklists. Machine-checkable items
 * pass or fail; process items (review gate, CI, federation consumers) are
 * reported as `manual` and never block a level. A claim above the verified
 * level is an error.
 */
export function conformanceReport(root: string): ConformanceResult {
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

   // Git is a hard core MUST (context-layer.md). Deliberately reported as `manual`
   // (not `fail`) when git can't be resolved, so the scorer stays usable on degraded
   // copies and detached checkouts; the requirement is surfaced loudly by `validate`
   // (the `git-required` finding), which is where enforcement lives. This mirrors the
   // changelog item's "unverifiable without a git baseline" handling.
   const inGit = gitToplevel(root) !== null;
   add(
      'git',
      'core',
      'the context layer lives in a git repository, versioned with the work it describes',
      inGit ? 'pass' : 'manual',
      inGit ? undefined : 'not resolvable to a git repository here; verify in the canonical repository',
   );

   if (!manifest) {
      findings.push(...validation.findings.filter((f) => f.severity === 'error'));
      return { claimedLevel: null, verifiedLevel: null, items, findings: sortFindings(findings) };
   }

   const bootErrors = errorsBy(['missing-declared-file']).filter((f) => f.path === manifest.bootProfilePath);
   add(
      'boot-profile',
      'core',
      'a boot profile at the declared path covering identity, loading, and posture',
      bootErrors.length === 0 ? 'pass' : 'fail',
      bootErrors[0]?.message,
   );

   const categoryErrors = errorsBy([
      'categories-minimum',
      'category-path-missing',
      'category-empty',
      'decisions-empty',
   ]);
   add(
      'categories',
      'core',
      'at least domain or system mapped and populated, plus decisions with a real record',
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

   const changelogRel = manifest.machine?.changelogPath;
   if (changelogRel && isFile(path.join(root, changelogRel))) {
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
         add(
            'changelog',
            'indexed',
            'a machine-readable changelog; layer changes append entries',
            'manual',
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
         changelogRel ? `declared changelog ${changelogRel} does not exist` : 'no machine.changelogPath declared',
      );
   }

   // --- governed ---
   add('review-gate', 'governed', "layer changes ride the repository's review gate; people approve", 'manual');

   const validProfiles = scanAgentProfiles(root, manifest).filter((p) => p.findings.length === 0);
   add(
      'agent-profiles',
      'governed',
      'agent profiles (at least a core profile) valid against the profile schema',
      validProfiles.length > 0 ? 'pass' : 'fail',
      validProfiles.length === 0 ? 'no valid agent profile found' : undefined,
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
      'the context layer is consumed by at least one other repository as a pinned docs-only mount',
      'manual',
   );
   add('stale-pin-reporting', 'federated', 'stale-pin reporting is in place', 'manual');
   const mounts = manifest.federation?.mounts ?? [];
   if (mounts.length > 0) {
      const missing = mounts.filter((m) => !exists(path.join(root, m.path)));
      add(
         'sibling-mounts',
         'federated',
         'sibling layers are mounted with ownership intact',
         missing.length === 0 ? 'pass' : 'fail',
         missing.length > 0 ? `mount path ${missing[0].path} does not exist` : undefined,
      );
   } else {
      add(
         'sibling-mounts',
         'federated',
         'sibling layers are mounted with ownership intact',
         'manual',
         'no federation.mounts declared',
      );
   }

   // --- scoring ---
   let verified: ConformanceLevel | null = null;
   for (const level of CONFORMANCE_LEVELS) {
      const machineItems = items.filter((i) => i.level === level && i.status !== 'manual');
      if (machineItems.some((i) => i.status === 'fail')) break;
      verified = level;
   }

   const claimed = claimedLevel(manifest);
   // Verification answers "does the claim hold?", not "what could be claimed":
   // never report a verified level above the claim (manual items make higher
   // levels unknowable to tooling anyway).
   if (verified !== null && CONFORMANCE_LEVELS.indexOf(verified) > CONFORMANCE_LEVELS.indexOf(claimed)) {
      verified = claimed;
   }
   if (verified === null || CONFORMANCE_LEVELS.indexOf(claimed) > CONFORMANCE_LEVELS.indexOf(verified)) {
      findings.push(
         finding(
            'conformance-claim',
            'error',
            `claimed level "${claimed}" exceeds the verified level "${verified ?? 'none'}"`,
            'leji.json',
         ),
      );
   }

   return { claimedLevel: claimed, verifiedLevel: verified, items, findings: sortFindings(findings) };
}
