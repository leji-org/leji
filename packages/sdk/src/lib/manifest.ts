import * as path from 'node:path';
import { type Finding, finding } from './findings.js';
import { exists, isFile, joinUnderRoot, readTextWithin } from './fsx.js';
import { SUPPORTED_LINES, schemaErrors } from './schemas.js';
import { isScalarString } from './text.js';

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
   categories: Partial<Record<CategoryId, { indexes: string[] }>>;
   machine?: {
      indexPath?: string;
      changelogPath?: string;
      agentProfilesPath?: string;
      decisionRecordsPath?: string;
   };
   agents?: Record<string, string>;
   /** Optional actor registry. Keys are stable actor ids; each actor declares the
    * roles it can fill and a command template per role, because one actor can need
    * different invocations in different roles. */
   actors?: Record<string, { roles: string[]; commands: Record<string, string> }>;
   viewer?: {
      port?: number;
      logo?: string;
      title?: string;
      agentsLabel?: string;
      favicon?: string;
      homepage?: string;
      pins?: (string | { path: string; label?: string })[];
      groupOrder?: string[];
      theme?: { primary?: string };
      mermaid?: boolean;
      poweredBy?: boolean;
      categoryEmojis?: Partial<Record<CategoryId, string>>;
   };
   owners: { primary: Owner; continuity?: Owner };
   conformance?: { claimedLevel?: ConformanceLevel; claimedAt?: string };
   federation?: {
      mounts?: {
         name: string;
         source: string;
         pin: string;
         trackingRef?: string;
         owner: Owner;
         role?: string;
         categories?: string[];
         topics?: string[];
         requiredWhen?: string[];
      }[];
   };
   vendorAdapters?: string[];
}

export interface ManifestLoad {
   manifest: Manifest | null;
   findings: Finding[];
}

export const MANIFEST_FILENAME = 'leji.json';

/**
 * Load and structurally validate leji.json: existence, JSON parse, declared spec
 * line, manifest schema. Content-level checks (paths exist, categories populated)
 * live in the validate command.
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
   // Confine the read: a symlinked leji.json resolving outside the layer root
   // must not be read (an MCP exposes this read to an agent).
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

/** Every string in a parsed JSON value, object keys included, is a well-formed
 * Unicode scalar sequence. */
export function allStringsScalar(v: unknown): boolean {
   if (typeof v === 'string') return isScalarString(v);
   if (Array.isArray(v)) return v.every(allStringsScalar);
   if (typeof v === 'object' && v !== null) {
      return Object.entries(v).every(([k, val]) => isScalarString(k) && allStringsScalar(val));
   }
   return true;
}

/** True when any category maps to an object carrying the removed 1.2 `paths` key. */
function declaresCategoryPaths(data: unknown): boolean {
   const cats = (data as { categories?: unknown })?.categories;
   if (typeof cats !== 'object' || cats === null || Array.isArray(cats)) return false;
   return Object.values(cats).some(
      (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && 'paths' in (v as object),
   );
}

/**
 * Validate an already-parsed manifest object: supported spec line, then schema.
 * Filesystem-independent, so a caller holding the object inline (e.g. an MCP) can
 * validate without writing to disk. `loadManifest` calls this after read + parse.
 */
export function validateManifestObject(data: unknown): ManifestLoad {
   const findings: Finding[] = [];
   // Before anything reads a value: a manifest string that is not a well-formed
   // Unicode scalar sequence is refused whole, never carried into a hash, a sort,
   // or output. The message quotes nothing back — echoing the offending text is
   // exactly the outcome the check exists to prevent.
   if (!allStringsScalar(data)) {
      return {
         manifest: null,
         findings: [
            finding(
               'manifest-not-scalar',
               'error',
               `${MANIFEST_FILENAME} carries a string that is not a well-formed Unicode scalar sequence (an unpaired surrogate)`,
               MANIFEST_FILENAME,
            ),
         ],
      };
   }
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
      // The 1.2 category shape fails as a pile of raw schema text ("must NOT have
      // additional properties"), which never names the thing to change. One sentence
      // turns that into an actionable read.
      if (declaresCategoryPaths(data)) {
         findings.push(
            finding(
               'manifest-schema',
               'error',
               'a category declares "paths", the 1.2 form: 1.3 categories declare "indexes" instead (see "Migrating a 1.2 manifest" in the changelog)',
               MANIFEST_FILENAME,
            ),
         );
      }
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

// Effective foundational-path resolvers. Per machine-readable-surface.md, an
// undeclared path resolves to its default location under rootPath/.
export function effectiveIndexPath(manifest: Manifest): string {
   return manifest.machine?.indexPath ?? joinUnderRoot(manifest.rootPath, 'context-index.json');
}
export function effectiveChangelogPath(manifest: Manifest): string {
   return manifest.machine?.changelogPath ?? joinUnderRoot(manifest.rootPath, 'context-changelog.json');
}
export function effectiveAgentProfilesPath(manifest: Manifest): string {
   return manifest.machine?.agentProfilesPath ?? joinUnderRoot(manifest.rootPath, 'agents/');
}
export function effectiveDecisionRecordsPath(manifest: Manifest): string {
   return manifest.machine?.decisionRecordsPath ?? joinUnderRoot(manifest.rootPath, 'decisions/');
}

// --- In-place manifest text edits ---------------------------------------------
//
// `leji agent` edits the raw manifest text rather than parse + re-serialize, to
// preserve the user's field order, formatting, and unmodeled keys, and so all
// three reference SDKs produce byte-identical output (a generic re-serialize
// diverges, e.g. Go alphabetizes map keys). The edits assume the canonical
// two-space layout, and use `owners` (required) as the anchor for inserting a new
// top-level key in schema position (before `owners`).

/** Insert `line` (already indented) as the first member after the line opening
 * `marker` (e.g. `"agents": {`). Prepending sidesteps the previous member's
 * trailing comma. */
function insertAfterMarkerLine(text: string, marker: string, line: string): string {
   const at = text.indexOf(marker);
   if (at < 0) throw new Error(`leji.json: cannot locate ${JSON.stringify(marker)} to anchor the edit`);
   const nl = text.indexOf('\n', at);
   if (nl < 0) throw new Error(`leji.json: malformed ${JSON.stringify(marker)} block`);
   return text.slice(0, nl + 1) + line + '\n' + text.slice(nl + 1);
}

/** Insert a multi-line top-level block immediately before the `owners` key, so a
 * newly created `agents` key lands in schema position. */
function insertBeforeOwners(text: string, lines: string[]): string {
   const anchor = '\n  "owners":';
   const at = text.indexOf(anchor);
   if (at < 0) throw new Error('leji.json: cannot locate the "owners" key to anchor the edit');
   return text.slice(0, at + 1) + lines.join('\n') + '\n' + text.slice(at + 1);
}

/**
 * Bind a named agent to its profile path in the `agents` map. Creates the map
 * (before `owners`) when absent, else prepends. Idempotent: an already-bound name
 * leaves the text untouched.
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
