import * as path from 'node:path';
import { type Finding, finding } from './findings.js';
import { exists, isFile, readText } from './fsx.js';
import { SUPPORTED_LINES, schemaErrors } from './schemas.js';

export const CATEGORY_IDS = ['domain', 'system', 'practice', 'governance', 'decisions'] as const;
/** A context category: `domain`, `system`, `practice`, `governance`, or `decisions`. */
export type CategoryId = (typeof CATEGORY_IDS)[number];

export const CONFORMANCE_LEVELS = ['core', 'indexed', 'governed', 'federated'] as const;
/** A conformance level, lowest to highest: `core`, `indexed`, `governed`, `federated`. */
export type ConformanceLevel = (typeof CONFORMANCE_LEVELS)[number];

export interface Owner {
   name: string;
   contact?: string;
}

/** A parsed `leji.json`: the root descriptor of a context layer. */
export interface Manifest {
   $schema?: string;
   leji: string;
   name: string;
   description?: string;
   rootPath: string;
   bootProfilePath: string;
   categories: Partial<Record<CategoryId, { paths: string[] }>>;
   machine?: {
      indexPath?: string;
      changelogPath?: string;
      agentProfilesPath?: string;
      decisionRecordsPath?: string;
   };
   agents?: Record<string, string>;
   docs?: { port?: number };
   owners: { primary: Owner; continuity?: Owner };
   conformance?: { claimedLevel?: ConformanceLevel; claimedAt?: string };
   federation?: { mounts?: { path: string; name: string; owner: Owner; role?: string; source?: string }[] };
   vendorAdapters?: string[];
}

export interface ManifestLoad {
   manifest: Manifest | null;
   findings: Finding[];
}

export const MANIFEST_FILENAME = 'leji.json';

/**
 * Load and structurally validate leji.json at the repository root: existence,
 * JSON parse, declared spec line, manifest schema. Content-level checks
 * (paths existing, categories populated) live in the validate command.
 */
export function loadManifest(root: string): ManifestLoad {
   const abs = path.join(root, MANIFEST_FILENAME);
   if (!exists(abs) || !isFile(abs)) {
      return {
         manifest: null,
         findings: [
            finding('manifest-missing', 'error', `no ${MANIFEST_FILENAME} at the repository root`, MANIFEST_FILENAME),
         ],
      };
   }
   let data: unknown;
   try {
      data = JSON.parse(readText(abs));
   } catch (e) {
      return {
         manifest: null,
         findings: [finding('manifest-parse', 'error', `invalid JSON: ${(e as Error).message}`, MANIFEST_FILENAME)],
      };
   }
   const findings: Finding[] = [];
   const line = (data as { leji?: unknown })?.leji;
   if (typeof line === 'string' && /^\d+\.\d+$/.test(line) && !SUPPORTED_LINES.includes(line)) {
      findings.push(
         finding(
            'manifest-line',
            'error',
            `declared spec line "${line}" is not supported by this SDK (supported: ${SUPPORTED_LINES.join(', ')})`,
            MANIFEST_FILENAME,
         ),
      );
      return { manifest: null, findings };
   }
   for (const err of schemaErrors('context-manifest', data)) {
      findings.push(finding('manifest-schema', 'error', err, MANIFEST_FILENAME));
   }
   if (findings.some((f) => f.rule === 'manifest-schema')) {
      return { manifest: null, findings };
   }
   return { manifest: data as Manifest, findings };
}

/** Effective conformance claim: absent claim is treated as core. */
export function claimedLevel(manifest: Manifest): ConformanceLevel {
   return manifest.conformance?.claimedLevel ?? 'core';
}

export function levelAtLeast(level: ConformanceLevel, threshold: ConformanceLevel): boolean {
   return CONFORMANCE_LEVELS.indexOf(level) >= CONFORMANCE_LEVELS.indexOf(threshold);
}
