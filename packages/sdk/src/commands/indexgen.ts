import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import { isFile, readText, realpathWithin } from '../lib/fsx.js';
import { gitLastModified, gitToplevel } from '../lib/git.js';
import { duplicateIdFindings, readJsonArtifact, scanCategories } from '../lib/layer.js';
import { type Manifest } from '../lib/manifest.js';
import { SDK_VERSION, SUPPORTED_LINES, schemaErrors } from '../lib/schemas.js';

/** One artifact's entry in the generated context index. */
export interface IndexEntry {
   id: string;
   path: string;
   title: string;
   category: string;
   summary?: string;
   tags?: string[];
   owners?: string[];
   lastModified?: string;
   contentHash?: string;
   freshness?: { reviewAfter: string };
   links?: string[];
}

/** The generated machine index: every indexed artifact in the layer. */
export interface ContextIndex {
   $schema?: string;
   schemaVersion: string;
   generatedAt: string;
   generator?: { name?: string; version?: string };
   rootPath: string;
   entries: IndexEntry[];
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

export function declaredIndexPath(manifest: Manifest): string | null {
   return manifest.machine?.indexPath ?? null;
}

export function loadStoredIndex(root: string, manifest: Manifest): ContextIndex | null {
   const rel = declaredIndexPath(manifest);
   if (!rel || !isFile(path.join(root, rel))) return null;
   const { data } = readJsonArtifact(root, rel);
   if (!data || typeof data !== 'object') return null;
   return data as ContextIndex;
}

/**
 * Generate the context index from the tree. Id stability, in priority order:
 * document frontmatter `id`, the stored index's id for the same path, the
 * stored index's id for the same contentHash (a pure move), then a filename
 * slug (de-collided with the parent directory).
 */
export function generateIndex(root: string, manifest: Manifest): IndexResult {
   const findings: Finding[] = [];
   const docs = scanCategories(root, manifest);
   const stored = loadStoredIndex(root, manifest);
   const storedByPath = new Map<string, IndexEntry>();
   const storedByHash = new Map<string, IndexEntry>();
   for (const entry of stored?.entries ?? []) {
      storedByPath.set(entry.path, entry);
      if (entry.contentHash) storedByHash.set(entry.contentHash, entry);
   }

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
      };
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

   const index: ContextIndex = {
      $schema: 'https://leji.org/schemas/v1.0/context-index.schema.json',
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      generator: { name: 'leji', version: SDK_VERSION },
      rootPath: manifest.rootPath,
      entries,
   };
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
 * Check the stored index against a regeneration. `generatedAt`, `generator`,
 * and `lastModified` are excluded from the comparison: content drift is what
 * `contentHash` catches deterministically.
 */
export function checkIndex(root: string, manifest: Manifest): IndexResult {
   const rel = declaredIndexPath(manifest);
   const findings: Finding[] = [];
   if (!rel || !isFile(path.join(root, rel))) {
      findings.push(
         finding(
            'index-required',
            'error',
            rel
               ? `declared index ${rel} does not exist; run \`leji index\``
               : 'no machine.indexPath declared in leji.json',
            rel ?? 'leji.json',
         ),
      );
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
   const want = stableStringify({
      rootPath: regen.index!.rootPath,
      entries: regen.index!.entries.map(comparable),
   });
   const got = stableStringify({
      rootPath: stored.rootPath,
      entries: [...stored.entries].sort((a, b) => (a.path < b.path ? -1 : 1)).map(comparable),
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
      findings: duplicateIdFindings(
         stored.entries.map((e) => ({ id: e.id, relPath: e.path })),
         'index',
      ),
      stale: false,
   };
}

const ENTRY_KEY_ORDER: (keyof IndexEntry)[] = [
   'id',
   'path',
   'title',
   'category',
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
   return JSON.stringify(out, null, 2) + '\n';
}

/** Generate and write the index to the declared path. */
export function writeIndex(root: string, manifest: Manifest): IndexResult {
   const rel = declaredIndexPath(manifest);
   if (!rel) {
      return {
         index: null,
         findings: [finding('index-required', 'error', 'no machine.indexPath declared in leji.json', 'leji.json')],
      };
   }
   const result = generateIndex(root, manifest);
   if (result.index) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (!realpathWithin(path.resolve(root), abs)) {
         return {
            index: result.index,
            findings: [
               ...result.findings,
               finding('artifact-parse', 'error', `index path ${rel} resolves outside the layer root`, rel),
            ],
         };
      }
      fs.writeFileSync(abs, serializeIndex(result.index));
   }
   return result;
}
