import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import { guardRoot, verifiedTargetRead, writeFileGuarded } from '../lib/fsx.js';
import { type Manifest, claimedLevel, effectiveChangelogPath, levelAtLeast } from '../lib/manifest.js';

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
 * Canonical changelog order (machine-readable-surface.md req 3): ascending `date`,
 * then `id` tiebreak. `date` is UTC so lexical compare is chronological; `id` is
 * unique so the pair is a total order.
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
 * Seed the machine changelog if the layer claims `indexed`+ and the file is missing
 * (lets `leji index` complete the indexed surface for a layer upgraded after init).
 * Returns the seeded path, or null when nothing was written (not indexed, already
 * present, or a symlink would escape the root). Never overwrites.
 *
 * "Missing" is decided by the exclusive create itself rather than by a pathname
 * check, because `existsSync` follows symlinks: a dangling link at the changelog
 * name reads as absent and the seed would be created at the link's destination. The
 * exclusive create judges the ORIGINAL entry, so any standing entry is the same
 * already-present no-op an existing changelog is.
 */
export function seedChangelogIfMissing(root: string, manifest: Manifest): string | null {
   if (!levelAtLeast(claimedLevel(manifest), 'indexed')) return null;
   const rel = effectiveChangelogPath(manifest);
   const abs = path.join(root, rel);
   const log: Changelog = {
      $schema: 'https://leji.org/schemas/v1.0/context-changelog.schema.json',
      schemaVersion: '1.0',
      entries: [
         {
            id: 'seed-changelog',
            date: today(),
            type: 'added',
            summary: 'Started the machine changelog for the indexed level.',
            paths: [rel],
            proposedBy: 'leji index',
            approvedBy: manifest.owners.primary.name,
         },
      ],
   };
   if (!writeFileGuarded(guardRoot(root), abs, null, serializeChangelog(log), { exclusive: true }).ok) return null;
   return rel;
}

/**
 * Compact the oldest changelog entries. An entry folds iff every ACTIVE flag marks
 * it foldable: `keep` ⇒ older than the newest `keep` entries; `before` ⇒ dated
 * strictly before `before`; inactive flags are neutral. Both predicates select a
 * prefix of canonical (date, id) order, so the folded set is a contiguous run from
 * the oldest end, as the append-only rule requires. Folded entries are dropped and
 * one `compaction` entry (count + removed id range) is appended; survivors keep
 * their original array order.
 */
export function compactChangelog(root: string, manifest: Manifest, opts: CompactOptions): CompactResult {
   const rel = effectiveChangelogPath(manifest);
   // Validate at the API level too: SDK callers must not fold with keep < 1 or a
   // malformed `before` date.
   if (opts.keep !== undefined && (!Number.isInteger(opts.keep) || opts.keep < 1)) {
      return {
         findings: [finding('invalid-argument', 'error', 'keep must be a positive integer', rel)],
         folded: 0,
         kept: 0,
         path: rel,
      };
   }
   if (opts.before !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(opts.before)) {
      return {
         findings: [finding('invalid-argument', 'error', 'before must be a YYYY-MM-DD date', rel)],
         folded: 0,
         kept: 0,
         path: rel,
      };
   }
   // Compaction rewrites the file it just read, so the bytes it folds come from the
   // verified read rather than from a pathname read once and written again: a refusal
   // (outside the layer root, a private role, an entry that is not a regular file) is
   // reported exactly as an unreadable artifact, and nothing is written.
   const rootReal = guardRoot(root);
   const read = verifiedTargetRead(rootReal, path.join(root, rel), null);
   if (read.status === 'refused') {
      return {
         findings: [finding('artifact-parse', 'error', `artifact ${rel} resolves outside the layer root`, rel)],
         folded: 0,
         kept: 0,
         path: rel,
      };
   }
   if (read.status === 'absent') {
      return {
         findings: [finding('changelog-required', 'error', `changelog ${rel} does not exist`, rel)],
         folded: 0,
         kept: 0,
         path: rel,
      };
   }
   let parsed: unknown;
   try {
      parsed = JSON.parse(read.bytes.toString('utf8'));
   } catch (e) {
      return {
         findings: [finding('artifact-parse', 'error', `invalid JSON: ${(e as Error).message}`, rel)],
         folded: 0,
         kept: 0,
         path: rel,
      };
   }
   const log = parsed as Changelog;
   const original = Array.isArray(log.entries)
      ? log.entries.filter((e): e is ChangelogEntry => e !== null && typeof e === 'object')
      : [];

   // Canonical order decides which entries are "oldest" and drives `keep`.
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
   if (!writeFileGuarded(guardRoot(root), abs, null, serializeChangelog(next)).ok) {
      return {
         findings: [finding('artifact-parse', 'error', `changelog path ${rel} resolves outside the layer root`, rel)],
         folded: 0,
         kept: original.length,
         path: rel,
      };
   }

   return { findings: [], folded: folded.length, kept: next.entries.length, path: rel };
}
