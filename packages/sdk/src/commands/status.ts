import * as path from 'node:path';
import { joinUnderRoot, stripSlash, underPath, walkTree } from '../lib/fsx.js';
import { resolveCategoryAssignments } from '../lib/layer.js';
import {
   type Manifest,
   CATEGORY_IDS,
   effectiveAgentProfilesPath,
   effectiveChangelogPath,
   effectiveIndexPath,
} from '../lib/manifest.js';
import { type SelfProjection, selfProjection } from '../lib/mounts.js';
import { loadStoredIndex } from './indexgen.js';

/** A dangling index entry: a path listed in a leji-index block that does not
 * resolve on disk (missing, escaping root, or not markdown). */
export interface DanglingEntry {
   indexFile: string;
   detail: string;
}

/** A broad index selector whose every covered document was won by more-specific
 * selectors: dead weight in the curated index, surfaced but never an error. */
export interface ShadowedSelector {
   indexFile: string;
   path: string;
}

/** Health report for a context layer. Non-failing: surfaces what to look at, does not gate. */
export interface StatusReport {
   /** Markdown under rootPath that no category index lists (reference content). */
   unindexed: string[];
   /** Index entries pointing at a path that does not resolve. */
   dangling: DanglingEntry[];
   /** Paths in the stored index that the index files no longer resolve to. */
   stale: string[];
   /** Governed paths not yet in the stored index (or all of them when no stored
    * index exists): the machine contract is behind the tree; run `leji index`. */
   pending: string[];
   /** Selectors fully displaced by more-specific selectors. */
   shadowed: ShadowedSelector[];
   /** READMEs inside listed directories that expansion skipped and no explicit
    * selector governs: the carve-out surfaced, never silent. */
   skippedReadmes: ShadowedSelector[];
   /** Would this layer, at HEAD, project completely if a host mounted it?
    * Judged against the object store, so it sees what a host's hydrate would see —
    * including a bound profile that exists on disk but is untracked. Report-only. */
   projection: SelfProjection;
}

/** Chrome files that are never category content, so never "unindexed". */
function isChrome(manifest: Manifest, rel: string): boolean {
   const profilesDir = effectiveAgentProfilesPath(manifest);
   const indexFiles = new Set<string>();
   for (const c of CATEGORY_IDS) for (const f of manifest.categories[c]?.indexes ?? []) indexFiles.add(f);
   const overviewRel = joinUnderRoot(manifest.rootPath, 'overview.md');
   const sidebarRel = joinUnderRoot(manifest.rootPath, '_sidebar.md');
   return (
      rel === manifest.bootProfilePath ||
      underPath(rel, profilesDir) ||
      indexFiles.has(rel) ||
      rel === overviewRel ||
      rel === sidebarRel ||
      rel === effectiveIndexPath(manifest) ||
      rel === effectiveChangelogPath(manifest) ||
      path.posix.basename(rel).toLowerCase() === 'readme.md'
   );
}

/** Pure computation; the CLI renders and decides exit. */
export function statusReport(root: string, manifest: Manifest): StatusReport {
   const resolved = resolveCategoryAssignments(root, manifest);
   const governed = new Set(resolved.assignments.keys());

   const rootDir = stripSlash(manifest.rootPath) || '.';
   const unindexed = walkTree(root, rootDir)
      .filter((rel) => !governed.has(rel) && !isChrome(manifest, rel))
      .sort();

   const dangling: DanglingEntry[] = resolved.findings
      .filter(
         (f) =>
            f.rule === 'index-file-missing' ||
            f.rule === 'index-entry-missing' ||
            f.rule === 'index-entry-not-markdown' ||
            // Parse-level problems include invalid or escaping entry paths
            // (`../x.md`, absolute, backslash); surface them so `status --strict`
            // fails on an entry that would otherwise be flagged nowhere else.
            f.rule === 'index-file-parse',
      )
      .map((f) => ({ indexFile: f.path ?? '', detail: f.message }));

   const stored = loadStoredIndex(root, manifest);
   const stale = (stored?.entries ?? [])
      .map((e) => e.path)
      .filter((p) => !governed.has(p))
      .sort();

   // The symmetric drift direction: governed on disk, absent from the stored
   // index (all governed paths when the index has never been generated).
   const storedPaths = new Set((stored?.entries ?? []).map((e) => e.path));
   const pending = [...governed].filter((p) => !storedPaths.has(p)).sort();

   const shadowed: ShadowedSelector[] = resolved.shadowed
      .map((s) => ({ indexFile: s.indexRel, path: s.path }))
      .sort((a, b) => (a.indexFile !== b.indexFile ? (a.indexFile < b.indexFile ? -1 : 1) : a.path < b.path ? -1 : 1));

   const skippedReadmes: ShadowedSelector[] = resolved.skippedReadmes
      .map((r) => ({ indexFile: r.indexRel, path: r.path }))
      .sort((a, b) => (a.indexFile !== b.indexFile ? (a.indexFile < b.indexFile ? -1 : 1) : a.path < b.path ? -1 : 1));

   return { unindexed, dangling, stale, pending, shadowed, skippedReadmes, projection: selfProjection(root) };
}
