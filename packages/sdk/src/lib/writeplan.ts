import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The disposition of a single path in a planned operation. Leji writes only the
 * files it owns and never overwrites; the plan makes that contract visible before
 * a single byte is written (the preview / `--dry-run` surface).
 */
export type PlanStatus = 'create' | 'skip-exists' | 'wont-modify' | 'overwrite';

/** A file Leji intends to write, with its content. */
export interface PlannedWrite {
   rel: string;
   content: string;
}

/** One classified path in a write plan. */
export interface PlanEntry {
   rel: string;
   status: PlanStatus;
   note?: string;
}

/**
 * Classify each intended write against the filesystem (`create` when absent,
 * `skip-exists` when a path is already there and Leji refuses to overwrite),
 * record foreign files Leji explicitly will not touch (`wont-modify`), and mark
 * the few paths the user has explicitly consented to overwrite (`overwrite`,
 * e.g. converting a vendor entrypoint to a redirect after migrating its content).
 */
export function buildWritePlan(
   rootAbs: string,
   writes: PlannedWrite[],
   wontModify: string[] = [],
   overwrite: string[] = [],
): PlanEntry[] {
   const allowOverwrite = new Set(overwrite);
   const entries: PlanEntry[] = [];
   for (const w of writes) {
      const exists = fs.existsSync(path.resolve(rootAbs, w.rel));
      if (exists && allowOverwrite.has(w.rel)) {
         entries.push({
            rel: w.rel,
            status: 'overwrite',
            note: 'convert to a boot-profile redirect (content migrated first)',
         });
      } else {
         entries.push({ rel: w.rel, status: exists ? 'skip-exists' : 'create' });
      }
   }
   for (const rel of wontModify) {
      entries.push({
         rel,
         status: 'wont-modify',
         note: 'existing file, read-only input — Leji will not modify it',
      });
   }
   return entries;
}

const LABEL: Record<PlanStatus, string> = {
   create: 'create     ',
   'skip-exists': 'skip       ',
   'wont-modify': 'leave as-is',
   overwrite: 'overwrite  ',
};

/** Render a write plan as a human-readable preview block. */
export function renderWritePlan(entries: PlanEntry[]): string {
   const creates = entries.filter((e) => e.status === 'create').length;
   const skips = entries.filter((e) => e.status === 'skip-exists').length;
   const overwrites = entries.filter((e) => e.status === 'overwrite').length;
   const untouched = entries.filter((e) => e.status === 'wont-modify');
   const lines = ['Plan:'];
   for (const e of entries) {
      if (e.status === 'wont-modify') continue;
      lines.push(`   ${LABEL[e.status]} ${e.rel}`);
   }
   if (untouched.length > 0) {
      lines.push('', 'Will NOT modify (existing files Leji learns from, never rewrites):');
      for (const e of untouched) lines.push(`   ${LABEL[e.status]} ${e.rel}`);
   }
   const overwritePart = overwrites > 0 ? `, ${overwrites} to convert (with your consent)` : '';
   lines.push('', `Summary: ${creates} to create, ${skips} already present (left untouched)${overwritePart}.`);
   return lines.join('\n');
}
