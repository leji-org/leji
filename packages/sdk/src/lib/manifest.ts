import * as path from 'node:path';
import { type Finding, finding } from './findings.js';
import { exists, isFile, readTextWithin } from './fsx.js';
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
   viewer?: {
      port?: number;
      logo?: string;
      theme?: { primary?: string };
      mermaid?: boolean;
      categoryEmojis?: Partial<Record<CategoryId, string>>;
   };
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
   // Confine the read: a symlinked leji.json that resolves outside the layer
   // root must not be read (an MCP exposes this read to an agent).
   const raw = readTextWithin(path.resolve(root), abs);
   if (raw === null) {
      return {
         manifest: null,
         findings: [
            finding(
               'manifest-parse',
               'error',
               `${MANIFEST_FILENAME} resolves outside the layer root`,
               MANIFEST_FILENAME,
            ),
         ],
      };
   }
   let data: unknown;
   try {
      data = JSON.parse(raw);
   } catch (e) {
      return {
         manifest: null,
         findings: [finding('manifest-parse', 'error', `invalid JSON: ${(e as Error).message}`, MANIFEST_FILENAME)],
      };
   }
   return validateManifestObject(data);
}

/**
 * Validate an already-parsed manifest object: supported spec line, then manifest
 * schema. Filesystem-independent, so a caller that holds the object directly (an
 * MCP validating a manifest supplied inline, say) can validate it without
 * writing it to disk. `loadManifest` calls this after read + parse.
 */
export function validateManifestObject(data: unknown): ManifestLoad {
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

// Effective foundational-path resolvers. The spec (machine-readable-surface.md)
// defines default locations under rootPath for the machine surface, so tooling
// resolves an undeclared path to its default rather than failing: leji.json
// lives at the repository root; everything else defaults under rootPath/.
export function effectiveIndexPath(manifest: Manifest): string {
   return manifest.machine?.indexPath ?? `${manifest.rootPath}context-index.json`;
}
export function effectiveChangelogPath(manifest: Manifest): string {
   return manifest.machine?.changelogPath ?? `${manifest.rootPath}context-changelog.json`;
}
export function effectiveAgentProfilesPath(manifest: Manifest): string {
   return manifest.machine?.agentProfilesPath ?? `${manifest.rootPath}agents/`;
}
export function effectiveDecisionRecordsPath(manifest: Manifest): string {
   return manifest.machine?.decisionRecordsPath ?? `${manifest.rootPath}decisions/`;
}

// --- In-place manifest text edits ---------------------------------------------
//
// `leji agent` (and any future post-init command that touches leji.json) edits
// the raw manifest text rather than parsing and re-serializing the whole object.
// This is deliberate: it preserves the user's field order, formatting, and any
// keys this SDK does not model, and it is the only way the three reference SDKs
// can produce byte-identical output (a generic parse + re-serialize diverges,
// e.g. Go alphabetizes map keys). The edits below assume the canonical two-space
// layout every SDK emits, and `owners` (a required key) as a stable anchor for
// inserting a new top-level key in schema position (right after `agents` would
// sit, before `owners`).

/** Insert `line` (already indented) as the first member directly after the line
 * that opens `marker` (e.g. `"agents": {` or `"vendorAdapters": [`). Prepending
 * sidesteps fixing up the previous last member's trailing comma. */
function insertAfterMarkerLine(text: string, marker: string, line: string): string {
   const at = text.indexOf(marker);
   if (at < 0) throw new Error(`leji.json: cannot locate ${JSON.stringify(marker)} to anchor the edit`);
   const nl = text.indexOf('\n', at);
   if (nl < 0) throw new Error(`leji.json: malformed ${JSON.stringify(marker)} block`);
   return text.slice(0, nl + 1) + line + '\n' + text.slice(nl + 1);
}

/** Insert a multi-line top-level block immediately before the `owners` key, so a
 * newly created `agents` / `vendorAdapters` key lands in schema position. */
function insertBeforeOwners(text: string, lines: string[]): string {
   const anchor = '\n  "owners":';
   const at = text.indexOf(anchor);
   if (at < 0) throw new Error('leji.json: cannot locate the "owners" key to anchor the edit');
   return text.slice(0, at + 1) + lines.join('\n') + '\n' + text.slice(at + 1);
}

/**
 * Bind a named agent to its profile path in the manifest's `agents` map. Creates
 * the map (before `owners`) when absent, otherwise prepends the entry. Idempotent:
 * an already-bound name leaves the text untouched.
 */
export function bindAgentInManifestText(
   text: string,
   name: string,
   profileRel: string,
): { text: string; changed: boolean } {
   const agents = (JSON.parse(text) as { agents?: Record<string, unknown> }).agents;
   if (agents && typeof agents === 'object' && name in agents) return { text, changed: false };
   const entry = `"${name}": "${profileRel}"`;
   if (!agents) {
      return { text: insertBeforeOwners(text, ['  "agents": {', `    ${entry}`, '  },']), changed: true };
   }
   return { text: insertAfterMarkerLine(text, '"agents": {', `    ${entry},`), changed: true };
}

/**
 * Declare a vendor adapter path in the manifest's `vendorAdapters` array. Creates
 * the array (before `owners`) when absent, otherwise prepends the entry.
 * Idempotent: an already-declared path leaves the text untouched.
 */
export function declareVendorAdapterInManifestText(text: string, adapter: string): { text: string; changed: boolean } {
   const arr = (JSON.parse(text) as { vendorAdapters?: unknown[] }).vendorAdapters;
   if (Array.isArray(arr) && arr.includes(adapter)) return { text, changed: false };
   const entry = `"${adapter}"`;
   if (!Array.isArray(arr)) {
      return { text: insertBeforeOwners(text, ['  "vendorAdapters": [', `    ${entry}`, '  ],']), changed: true };
   }
   return { text: insertAfterMarkerLine(text, '"vendorAdapters": [', `    ${entry},`), changed: true };
}
