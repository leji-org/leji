import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import { guardRoot, isFile, resolvedWithinRoot, verifiedTargetRead, writeFileGuarded } from '../lib/fsx.js';
import { gitLastModified, gitToplevel } from '../lib/git.js';
import { duplicateIdFindings, scanCategories } from '../lib/layer.js';
import { type Manifest, effectiveIndexPath } from '../lib/manifest.js';
import { SDK_VERSION, SUPPORTED_LINES, schemaErrors } from '../lib/schemas.js';

/** One artifact's entry in the generated context index. */
export interface IndexEntry {
   id: string;
   path: string;
   title: string;
   category: string;
   /** The document's kind. Always emitted; consumers treat an absent
    * value (older indexes) as `intent`. */
   kind: 'intent' | 'record';
   /** A record's date, sourced only from valid frontmatter `date`. */
   date?: string;
   summary?: string;
   tags?: string[];
   owners?: string[];
   lastModified?: string;
   contentHash?: string;
   freshness?: { reviewAfter: string };
   links?: string[];
}

/** One federated sibling's routing record in the generated index, derived from
 * the manifest's federation.mounts. Routing metadata only, never sibling content. */
export interface IndexMount {
   name: string;
   source: string;
   pin: string;
   trackingRef?: string;
   owner: { name: string; contact?: string };
   role?: string;
   categories?: string[];
   topics?: string[];
   requiredWhen?: string[];
}

/** The generated machine index: every indexed artifact in the layer. */
export interface ContextIndex {
   $schema?: string;
   schemaVersion: string;
   generatedAt: string;
   generator?: { name?: string; version?: string };
   rootPath: string;
   entries: IndexEntry[];
   mounts?: IndexMount[];
}

export interface IndexResult {
   index: ContextIndex | null;
   findings: Finding[];
   /** Set by check(): true when the stored index no longer matches the tree. */
   stale?: boolean;
}

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function slugify(stem: string): string {
   return stem
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
}

function firstHeading(body: string): string | null {
   const m = /^#\s+(.+)$/m.exec(body);
   return m ? m[1].trim() : null;
}

function contentHash(root: string, relPath: string): string {
   const buf = fs.readFileSync(path.join(root, relPath));
   return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function str(v: unknown): string | undefined {
   return typeof v === 'string' && v !== '' ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
   if (!Array.isArray(v)) return undefined;
   const out = v.filter((x): x is string => typeof x === 'string');
   return out.length > 0 ? out : undefined;
}

/** The stored index, or null when there is none this run can act on. Read through
 * the verified read, not by pathname: generation carries ids out of these bytes into
 * the index it writes back to this same path, so the file that was judged must be the
 * file that is read. Absent, unparsable, or a standing entry that cannot be verified
 * all mean "no stored index" — nothing is carried, and the write chokepoint judges the
 * destination again on its own. */
export function loadStoredIndex(root: string, manifest: Manifest): ContextIndex | null {
   const rel = effectiveIndexPath(manifest);
   const read = verifiedTargetRead(guardRoot(root), path.join(root, rel), null);
   if (read.status !== 'regular') return null;
   let data: unknown;
   try {
      data = JSON.parse(read.bytes.toString('utf8'));
   } catch {
      return null;
   }
   if (!data || typeof data !== 'object') return null;
   return data as ContextIndex;
}

/**
 * Generate the context index from the tree. Id stability priority: frontmatter
 * `id`, stored id for the same path, stored id for the same contentHash (a pure
 * move), then a filename slug (de-collided with the parent directory).
 */
export function generateIndex(root: string, manifest: Manifest): IndexResult {
   const findings: Finding[] = [];
   const scan = scanCategories(root, manifest);
   findings.push(...scan.findings);
   const docs = scan.docs;
   const stored = loadStoredIndex(root, manifest);
   const storedByPath = new Map<string, IndexEntry>();
   // Carry an id by content-hash only when the hash maps to exactly one stored entry:
   // byte-identical documents share a hash, so a carry would misattribute an id.
   const hashEntries = new Map<string, IndexEntry[]>();
   for (const entry of stored?.entries ?? []) {
      storedByPath.set(entry.path, entry);
      if (entry.contentHash) {
         const arr = hashEntries.get(entry.contentHash) ?? [];
         arr.push(entry);
         hashEntries.set(entry.contentHash, arr);
      }
   }
   const storedByHash = new Map<string, IndexEntry>();
   for (const [h, arr] of hashEntries) if (arr.length === 1) storedByHash.set(h, arr[0]);

   const inGit = gitToplevel(root) !== null;
   const today = new Date().toISOString().slice(0, 10);
   const used = new Map<string, string>();
   const entries: IndexEntry[] = [];

   for (const doc of docs) {
      const fm = doc.frontmatter ?? {};
      const hash = contentHash(root, doc.relPath);
      const carried = storedByPath.get(doc.relPath) ?? storedByHash.get(hash);

      let id = str(fm.id) ?? carried?.id;
      if (!id) {
         const stem = path.posix.basename(doc.relPath).replace(/\.md$/, '');
         id = slugify(stem);
         if (used.has(id)) {
            const parent = slugify(path.posix.basename(path.posix.dirname(doc.relPath)));
            id = parent ? `${parent}-${id}` : id;
         }
         let candidate = id;
         let n = 2;
         while (used.has(candidate)) candidate = `${id}-${n++}`;
         id = candidate;
      }
      if (!ID_PATTERN.test(id)) {
         findings.push(finding('id-pattern', 'error', `derived id "${id}" is not lowercase-hyphen`, doc.relPath));
      }
      if (used.has(id)) {
         findings.push(
            finding('id-duplicate', 'error', `index id "${id}" already used by ${used.get(id)}`, doc.relPath),
         );
      }
      used.set(id, doc.relPath);

      const entry: IndexEntry = {
         id,
         path: doc.relPath,
         title: str(fm.title) ?? firstHeading(doc.body) ?? path.posix.basename(doc.relPath).replace(/\.md$/, ''),
         category: doc.category,
         kind: doc.kind,
      };
      if (doc.kind === 'record') {
         // A record's date comes only from explicit, valid frontmatter; nothing
         // is scraped from prose or filename conventions.
         const d = str(fm.date);
         if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) entry.date = d;
      }
      const summary = str(fm.summary) ?? carried?.summary;
      if (summary) entry.summary = summary;
      const tags = strArray(fm.tags);
      if (tags) entry.tags = tags;
      const owners = strArray(fm.owners);
      if (owners) entry.owners = owners;
      entry.lastModified = (inGit ? gitLastModified(root, doc.relPath) : null) ?? today;
      entry.contentHash = hash;
      const freshness = fm.freshness as { reviewAfter?: unknown } | undefined;
      const reviewAfter = str(freshness?.reviewAfter);
      if (reviewAfter) entry.freshness = { reviewAfter };
      const links = strArray(fm.links);
      if (links) entry.links = links;
      entries.push(entry);
   }

   // Id churn: a stored id whose path is gone and that didn't reappear has vanished
   // (move + edit in one change set with no frontmatter `id` mints a fresh slug).
   // Inbound references now dangle; warn. A frontmatter `id` makes ids move-proof.
   const newIds = new Set(entries.map((e) => e.id));
   const currentPaths = new Set(docs.map((d) => d.relPath));
   for (const entry of stored?.entries ?? []) {
      if (!currentPaths.has(entry.path) && !newIds.has(entry.id)) {
         findings.push(
            finding(
               'id-vanished',
               'warning',
               `stored id "${entry.id}" (was ${entry.path}) did not reappear; references to it now dangle. Declare a frontmatter id to keep ids stable across moves.`,
               entry.path,
            ),
         );
      }
   }

   const mounts: IndexMount[] = (manifest.federation?.mounts ?? []).map((m) => {
      const rec: IndexMount = { name: m.name, source: m.source, pin: m.pin, owner: m.owner };
      if (m.trackingRef) rec.trackingRef = m.trackingRef;
      if (m.role) rec.role = m.role;
      if (m.categories && m.categories.length > 0) rec.categories = m.categories;
      if (m.topics && m.topics.length > 0) rec.topics = m.topics;
      if (m.requiredWhen && m.requiredWhen.length > 0) rec.requiredWhen = m.requiredWhen;
      return rec;
   });

   const index: ContextIndex = {
      $schema: 'https://leji.org/schemas/v1.0/context-index.schema.json',
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      generator: { name: 'leji', version: SDK_VERSION },
      rootPath: manifest.rootPath,
      entries,
   };
   if (mounts.length > 0) index.mounts = mounts;
   return { index, findings };
}

/** Fields compared for currency; volatile fields are deliberately excluded. */
function comparable(entry: IndexEntry): Omit<IndexEntry, 'lastModified'> {
   const { lastModified: _lastModified, ...rest } = entry;
   return rest;
}

/** Key-order-insensitive serialization, mirrored by the Python SDK. */
export function stableStringify(value: unknown): string {
   if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
   if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys
         .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
         .join(',')}}`;
   }
   return JSON.stringify(value);
}

/**
 * Check the stored index against a regeneration. `generatedAt`, `generator`, and
 * `lastModified` are excluded; `contentHash` catches drift deterministically.
 */
export function checkIndex(root: string, manifest: Manifest): IndexResult {
   const rel = effectiveIndexPath(manifest);
   const findings: Finding[] = [];
   if (!isFile(path.join(root, rel))) {
      findings.push(finding('index-required', 'error', `index ${rel} does not exist; run \`leji index\``, rel));
      return { index: null, findings, stale: true };
   }
   if (!resolvedWithinRoot(path.resolve(root), path.join(root, rel))) {
      findings.push(finding('artifact-parse', 'error', `artifact ${rel} resolves outside the layer root`, rel));
      return { index: null, findings, stale: true };
   }

   const stored = loadStoredIndex(root, manifest);
   if (!stored) {
      findings.push(finding('artifact-parse', 'error', 'stored index is not valid JSON', rel));
      return { index: null, findings, stale: true };
   }
   for (const err of schemaErrors('context-index', stored)) {
      findings.push(finding('artifact-schema', 'error', err, rel));
   }
   if (typeof stored.schemaVersion === 'string' && !SUPPORTED_LINES.includes(stored.schemaVersion)) {
      findings.push(
         finding(
            'schema-version',
            'error',
            `schemaVersion "${stored.schemaVersion}" is not supported by this SDK`,
            rel,
         ),
      );
   }
   if (findings.length > 0) return { index: stored, findings, stale: true };

   const regen = generateIndex(root, manifest);
   // If regeneration itself errors, the tree can't be indexed cleanly, so the stored
   // index can't be current: fail rather than compare a partial regen and falsely pass.
   const regenErrors = regen.findings.filter((f) => f.severity === 'error');
   if (regenErrors.length > 0) {
      findings.push(...regenErrors);
      return { index: stored, findings, stale: true };
   }
   const want = stableStringify({
      rootPath: regen.index!.rootPath,
      entries: regen.index!.entries.map(comparable),
      mounts: regen.index!.mounts ?? [],
   });
   const got = stableStringify({
      rootPath: stored.rootPath,
      entries: [...stored.entries].sort((a, b) => (a.path < b.path ? -1 : 1)).map(comparable),
      mounts: stored.mounts ?? [],
   });
   if (want !== got) {
      const wantPaths = new Set(regen.index!.entries.map((e) => e.path));
      const gotPaths = new Set(stored.entries.map((e) => e.path));
      const missing = [...wantPaths].filter((p) => !gotPaths.has(p));
      const extra = [...gotPaths].filter((p) => !wantPaths.has(p));
      const detail =
         missing.length > 0 || extra.length > 0
            ? ` (missing: ${missing.length}, removed: ${extra.length})`
            : ' (entry content drifted)';
      findings.push(
         finding('index-stale', 'error', `index no longer matches the tree${detail}; run \`leji index\``, rel),
      );
      return { index: stored, findings, stale: true };
   }
   return {
      index: stored,
      findings: [
         ...regen.findings,
         ...duplicateIdFindings(
            stored.entries.map((e) => ({ id: e.id, relPath: e.path })),
            'index',
         ),
      ],
      stale: false,
   };
}

const ENTRY_KEY_ORDER: (keyof IndexEntry)[] = [
   'id',
   'path',
   'title',
   'category',
   'kind',
   'date',
   'summary',
   'tags',
   'owners',
   'lastModified',
   'contentHash',
   'freshness',
   'links',
];

function orderedEntry(entry: IndexEntry): Record<string, unknown> {
   const out: Record<string, unknown> = {};
   for (const key of ENTRY_KEY_ORDER) {
      if (entry[key] !== undefined) out[key] = entry[key];
   }
   return out;
}

const MOUNT_KEY_ORDER: (keyof IndexMount)[] = [
   'name',
   'source',
   'pin',
   'trackingRef',
   'owner',
   'role',
   'categories',
   'topics',
   'requiredWhen',
];

function orderedMount(m: IndexMount): Record<string, unknown> {
   const out: Record<string, unknown> = {};
   for (const key of MOUNT_KEY_ORDER) {
      if (m[key] === undefined) continue;
      if (key === 'owner') {
         const o: Record<string, unknown> = { name: m.owner.name };
         if (m.owner.contact !== undefined) o.contact = m.owner.contact;
         out.owner = o;
      } else {
         out[key] = m[key];
      }
   }
   return out;
}

/** Serialize an index with stable key order, 2-space indent, trailing newline. */
export function serializeIndex(index: ContextIndex): string {
   const out: Record<string, unknown> = {
      $schema: index.$schema,
      schemaVersion: index.schemaVersion,
      generatedAt: index.generatedAt,
      generator: index.generator,
      rootPath: index.rootPath,
      entries: index.entries.map(orderedEntry),
   };
   if (index.mounts && index.mounts.length > 0) out.mounts = index.mounts.map(orderedMount);
   return JSON.stringify(out, null, 2) + '\n';
}

/** Generate and write the index to the effective path. */
export function writeIndex(root: string, manifest: Manifest): IndexResult {
   const rel = effectiveIndexPath(manifest);
   const result = generateIndex(root, manifest);
   // Refuse to write when generation hit a hard error: persisting a half-correct
   // index would be trusted by later reads.
   if (result.findings.some((f) => f.severity === 'error')) {
      return result;
   }
   if (result.index) {
      const abs = path.join(root, rel);
      // The write chokepoint judges the RESOLVED destination immediately before the
      // write, catching a symlinked ancestor before anything is created under it.
      if (!writeFileGuarded(guardRoot(root), abs, null, serializeIndex(result.index)).ok) {
         return {
            index: result.index,
            findings: [
               ...result.findings,
               finding('artifact-parse', 'error', `index path ${rel} resolves outside the layer root`, rel),
            ],
         };
      }
   }
   return result;
}
