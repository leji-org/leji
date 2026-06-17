import { type Finding, finding, sortFindings } from '../lib/findings.js';
import { scanAgentProfiles, scanCategories } from '../lib/layer.js';
import { type Manifest } from '../lib/manifest.js';

export interface FreshnessItem {
   path: string;
   reviewAfter: string;
}

/** Freshness scan results: expired and upcoming review horizons. */
export interface FreshnessReport {
   /** reviewAfter date in the past. */
   expired: FreshnessItem[];
   /** reviewAfter within the next 30 days. */
   upcoming: FreshnessItem[];
   /** Total documents carrying a freshness horizon. */
   declared: number;
   findings: Finding[];
}

function reviewAfterOf(fm: Record<string, unknown> | null): string | null {
   const freshness = fm?.freshness as { reviewAfter?: unknown } | undefined;
   const v = freshness?.reviewAfter;
   return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * Report freshness horizons across category documents and agent profiles.
 * Report-only by default (warnings); --strict raises expired horizons to
 * errors. Scans documents directly so it works at any conformance level.
 */
export function freshnessReport(root: string, manifest: Manifest, strict = false): FreshnessReport {
   const today = new Date().toISOString().slice(0, 10);
   const horizon = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

   const items: FreshnessItem[] = [];
   for (const doc of scanCategories(root, manifest)) {
      const reviewAfter = reviewAfterOf(doc.frontmatter);
      if (reviewAfter) items.push({ path: doc.relPath, reviewAfter });
   }
   for (const profile of scanAgentProfiles(root, manifest)) {
      const reviewAfter = reviewAfterOf(profile.frontmatter);
      if (reviewAfter) items.push({ path: profile.relPath, reviewAfter });
   }
   items.sort((a, b) =>
      a.reviewAfter !== b.reviewAfter
         ? a.reviewAfter < b.reviewAfter
            ? -1
            : 1
         : a.path < b.path
           ? -1
           : a.path > b.path
             ? 1
             : 0,
   );

   const expired = items.filter((i) => i.reviewAfter < today);
   const upcoming = items.filter((i) => i.reviewAfter >= today && i.reviewAfter <= horizon);
   const findings = expired.map((i) =>
      finding('freshness-expired', strict ? 'error' : 'warning', `review horizon ${i.reviewAfter} has passed`, i.path),
   );
   return { expired, upcoming, declared: items.length, findings: sortFindings(findings) };
}
