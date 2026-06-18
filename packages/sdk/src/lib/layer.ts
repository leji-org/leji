import * as path from 'node:path';
import { type Finding, finding } from './findings.js';
import { isFile, readText, realpathWithin, underPath, walkMd } from './fsx.js';
import { parseFrontmatter } from './frontmatter.js';
import {
   type CategoryId,
   type Manifest,
   CATEGORY_IDS,
   effectiveAgentProfilesPath,
   effectiveDecisionRecordsPath,
} from './manifest.js';
import { schemaErrors } from './schemas.js';

export interface ScannedDoc {
   relPath: string;
   category: CategoryId;
   frontmatter: Record<string, unknown> | null;
   body: string;
}

export interface ScannedProfile {
   relPath: string;
   frontmatter: Record<string, unknown> | null;
   findings: Finding[];
}

/** Files validate/index must not treat as category content. */
export function excludedFromCategories(manifest: Manifest): (relPath: string) => boolean {
   const profilesDir = effectiveAgentProfilesPath(manifest);
   return (relPath: string) => {
      if (relPath === manifest.bootProfilePath) return true;
      if (underPath(relPath, profilesDir)) return true;
      if (path.posix.basename(relPath).toLowerCase() === 'readme.md') return true;
      return false;
   };
}

/**
 * Collect category documents. A file matched by several category paths is
 * assigned once: longest declared path wins, manifest order breaks ties.
 */
export function scanCategories(root: string, manifest: Manifest): ScannedDoc[] {
   const excluded = excludedFromCategories(manifest);
   const byFile = new Map<string, { category: CategoryId; declaredLen: number }>();
   for (const category of CATEGORY_IDS) {
      const mapping = manifest.categories[category];
      if (!mapping) continue;
      for (const declared of mapping.paths) {
         for (const relPath of walkMd(root, declared)) {
            if (excluded(relPath)) continue;
            const prev = byFile.get(relPath);
            if (!prev || declared.length > prev.declaredLen) {
               byFile.set(relPath, { category, declaredLen: declared.length });
            }
         }
      }
   }
   const docs: ScannedDoc[] = [];
   for (const [relPath, { category }] of [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const text = readText(path.join(root, relPath));
      const fm = parseFrontmatter(text);
      docs.push({ relPath, category, frontmatter: fm.data, body: fm.body });
   }
   return docs;
}

function scanFrontmatterArtifacts(
   root: string,
   dir: string,
   schemaName: 'agent-profile' | 'decision-record',
   rule: string,
): ScannedProfile[] {
   const out: ScannedProfile[] = [];
   for (const relPath of walkMd(root, dir)) {
      if (path.posix.basename(relPath).toLowerCase() === 'readme.md') continue;
      const text = readText(path.join(root, relPath));
      const fm = parseFrontmatter(text);
      const findings: Finding[] = [];
      if (fm.error) {
         findings.push(finding(rule, 'error', fm.error, relPath));
      } else if (!fm.data) {
         findings.push(finding(rule, 'error', 'missing YAML frontmatter', relPath));
      } else {
         for (const err of schemaErrors(schemaName, fm.data)) {
            findings.push(finding(rule, 'error', err, relPath));
         }
      }
      out.push({ relPath, frontmatter: fm.data, findings });
   }
   return out;
}

export function scanAgentProfiles(root: string, manifest: Manifest): ScannedProfile[] {
   const dir = effectiveAgentProfilesPath(manifest);
   return scanFrontmatterArtifacts(root, dir, 'agent-profile', 'profile-frontmatter');
}

export function scanDecisionRecords(root: string, manifest: Manifest): ScannedProfile[] {
   // Scan the declared records path and every mapped decisions path; a layer
   // may map several and valid records can live in any of them.
   const dirs = new Set<string>();
   dirs.add(effectiveDecisionRecordsPath(manifest));
   for (const p of manifest.categories.decisions?.paths ?? []) dirs.add(p);
   const seen = new Set<string>();
   const out: ScannedProfile[] = [];
   for (const dir of dirs) {
      for (const scanned of scanFrontmatterArtifacts(root, dir, 'decision-record', 'decision-frontmatter')) {
         if (seen.has(scanned.relPath)) continue;
         seen.add(scanned.relPath);
         out.push(scanned);
      }
   }
   return out;
}

/** Duplicate-id findings across a set of artifacts that carry an `id`. */
export function duplicateIdFindings(items: { id: unknown; relPath: string }[], scope: string): Finding[] {
   const seen = new Map<string, string>();
   const findings: Finding[] = [];
   for (const { id, relPath } of items) {
      if (typeof id !== 'string' || id === '') continue;
      const first = seen.get(id);
      if (first !== undefined && first !== relPath) {
         findings.push(finding('id-duplicate', 'error', `${scope} id "${id}" already used by ${first}`, relPath));
      } else {
         seen.set(id, relPath);
      }
   }
   return findings;
}

/** Read a declared JSON artifact; returns parsed value or a finding. */
export function readJsonArtifact(root: string, relPath: string): { data: unknown; finding?: Finding } {
   const abs = path.join(root, relPath);
   if (!isFile(abs)) {
      return { data: null };
   }
   if (!realpathWithin(path.resolve(root), abs)) {
      return {
         data: null,
         finding: finding('artifact-parse', 'error', `artifact ${relPath} resolves outside the layer root`, relPath),
      };
   }
   try {
      return { data: JSON.parse(readText(abs)) };
   } catch (e) {
      return {
         data: null,
         finding: finding('artifact-parse', 'error', `invalid JSON: ${(e as Error).message}`, relPath),
      };
   }
}
