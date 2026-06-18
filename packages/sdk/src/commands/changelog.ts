import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import { realpathWithin } from '../lib/fsx.js';
import { readJsonArtifact } from '../lib/layer.js';
import { type Manifest, effectiveChangelogPath } from '../lib/manifest.js';

interface ChangelogEntry {
   id?: string;
   date?: string;
   type?: string;
   summary?: string;
   paths?: string[];
   [key: string]: unknown;
}

interface Changelog {
   $schema?: string;
   schemaVersion?: string;
   entries: ChangelogEntry[];
   [key: string]: unknown;
}

export interface CompactOptions {
   /** Fold every entry except the newest `keep`. */
   keep?: number;
   /** Fold every entry dated strictly before this `YYYY-MM-DD`. */
   before?: string;
}

export interface CompactResult {
   findings: Finding[];
   /** Number of entries folded into the compaction entry (0 = no-op). */
   folded: number;
   /** Number of surviving non-compaction entries plus the new compaction entry. */
   kept: number;
   /** Effective changelog path operated on. */
   path: string;
}

/**
 * Canonical changelog order (machine-readable-surface.md req 3): ascending by
 * `date`, then `id` as the tiebreak. `date` is UTC, so a lexical compare is
 * chronological; `id` is unique, so the pair is a total order.
 */
function compareByDateId(a: ChangelogEntry, b: ChangelogEntry): number {
   const ad = String(a.date ?? '');
   const bd = String(b.date ?? '');
   if (ad !== bd) return ad < bd ? -1 : 1;
   const ai = String(a.id ?? '');
   const bi = String(b.id ?? '');
   return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/** Schema field order for a serialized changelog entry, mirrored by the Python SDK. */
const ENTRY_KEY_ORDER = [
   'id',
   'date',
   'type',
   'summary',
   'paths',
   'categories',
   'decisionRefs',
   'proposedBy',
   'approvedBy',
   'breaking',
   'compacted',
];

function orderedEntry(entry: ChangelogEntry): Record<string, unknown> {
   const out: Record<string, unknown> = {};
   for (const key of ENTRY_KEY_ORDER) {
      if (entry[key] !== undefined) out[key] = entry[key];
   }
   // Preserve any extra keys (deterministic order) rather than dropping data.
   for (const key of Object.keys(entry).sort()) {
      if (!(key in out) && entry[key] !== undefined) out[key] = entry[key];
   }
   return out;
}

/** Serialize a changelog with stable key order, 2-space indent, trailing newline. */
export function serializeChangelog(log: Changelog): string {
   const out: Record<string, unknown> = {};
   if (log.$schema !== undefined) out.$schema = log.$schema;
   out.schemaVersion = log.schemaVersion ?? '1.0';
   for (const key of Object.keys(log).sort()) {
      if (key === '$schema' || key === 'schemaVersion' || key === 'entries') continue;
      out[key] = log[key];
   }
   out.entries = log.entries.map(orderedEntry);
   return JSON.stringify(out, null, 2) + '\n';
}

/** Today's date as `YYYY-MM-DD` (UTC). */
function today(): string {
   return new Date().toISOString().slice(0, 10);
}

/**
 * Compact the oldest entries of the changelog. An entry folds iff every ACTIVE
 * flag marks it foldable: `keep` ⇒ its canonical index is older than the newest
 * `keep` entries; `before` ⇒ its date is strictly before `before`. Inactive
 * flags are neutral. Because both predicates select a prefix of the canonical
 * (date, id) order, the folded set is always a contiguous run from the oldest
 * end — exactly what the append-only rule requires. The folded entries are
 * dropped and a single `compaction` entry is appended, recording the count and
 * the id range it removed. Surviving entries keep their original array order.
 */
export function compactChangelog(root: string, manifest: Manifest, opts: CompactOptions): CompactResult {
   const rel = effectiveChangelogPath(manifest);
   const { data, finding: parseFinding } = readJsonArtifact(root, rel);
   if (parseFinding) return { findings: [parseFinding], folded: 0, kept: 0, path: rel };
   if (!data) {
      return {
         findings: [finding('changelog-required', 'error', `changelog ${rel} does not exist`, rel)],
         folded: 0,
         kept: 0,
         path: rel,
      };
   }
   const log = data as Changelog;
   const original = Array.isArray(log.entries)
      ? log.entries.filter((e): e is ChangelogEntry => e !== null && typeof e === 'object')
      : [];

   // Canonical order decides which entries are "oldest"; the index of each
   // entry in that order drives the `keep` predicate.
   const canonical = [...original].sort(compareByDateId);
   const canonicalIndex = new Map<ChangelogEntry, number>();
   canonical.forEach((e, i) => canonicalIndex.set(e, i));

   const foldByKeep = (e: ChangelogEntry): boolean =>
      opts.keep === undefined || canonicalIndex.get(e)! < canonical.length - opts.keep;
   const foldByBefore = (e: ChangelogEntry): boolean => opts.before === undefined || String(e.date ?? '') < opts.before;

   const folded = canonical.filter((e) => foldByKeep(e) && foldByBefore(e));

   if (folded.length === 0) {
      return { findings: [], folded: 0, kept: original.length, path: rel };
   }

   const foldedSet = new Set(folded);
   const survivors = original.filter((e) => !foldedSet.has(e));

   const oldest = folded[0];
   const newest = folded[folded.length - 1];
   const pathsUnion = [...new Set(folded.flatMap((e) => (Array.isArray(e.paths) ? e.paths : [])))].sort();

   // De-dupe the compaction id against existing ids (-2, -3, …).
   const existingIds = new Set(original.map((e) => e.id));
   let id = `compaction-${today()}`;
   if (existingIds.has(id)) {
      let n = 2;
      while (existingIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
   }

   const compaction: ChangelogEntry = {
      id,
      date: today(),
      type: 'compaction',
      summary: `Compacted ${folded.length} ${folded.length === 1 ? 'entry' : 'entries'} (${oldest.date} through ${newest.date}).`,
      paths: pathsUnion.length > 0 ? pathsUnion : [rel],
      compacted: {
         entries: folded.length,
         firstId: String(oldest.id ?? ''),
         lastId: String(newest.id ?? ''),
      },
   };

   const next: Changelog = { ...log, entries: [...survivors, compaction] };

   const abs = path.join(root, rel);
   if (!realpathWithin(path.resolve(root), abs)) {
      return {
         findings: [finding('artifact-parse', 'error', `changelog path ${rel} resolves outside the layer root`, rel)],
         folded: 0,
         kept: original.length,
         path: rel,
      };
   }
   fs.mkdirSync(path.dirname(abs), { recursive: true });
   fs.writeFileSync(abs, serializeChangelog(next));

   return { findings: [], folded: folded.length, kept: next.entries.length, path: rel };
}
