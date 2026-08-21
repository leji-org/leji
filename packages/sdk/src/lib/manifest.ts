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

// --- The mount pin span -------------------------------------------------------
//
// `leji mounts update-pin` moves one declared pin. The agent edits above anchor on
// the canonical two-space layout, which the manifest schema does not require, so a
// pin move gets a lexical scanner instead: it walks the document as JSON tokens,
// finds `federation.mounts[i]` whose `name` equals the addressed mount, and returns
// the byte span of THAT object's `pin` string value. Only that span is replaced.
// Nothing is reserialized or normalized, so field order, indentation, line endings,
// escapes, unmodeled keys, and every other byte of the file survive untouched.

/** A lexical failure: the document is not shaped the way a manifest is. Callers
 * turn it into the same "cannot locate" refusal as a missing mount, because both
 * mean the same thing operationally — this text has no such pin to move. */
class PinScanError extends Error {}

/**
 * A duplicate key on the path to the pin. JSON does not forbid one, and the two
 * readers of this document disagree about which wins: a lexical scan takes the
 * FIRST member, `JSON.parse` keeps the LAST. So a manifest carrying two `pin` keys
 * on the addressed mount could have its first span rewritten while the pin every
 * parser reads stays exactly as it was — a reported change that changed nothing.
 * The scanner refuses that document instead of picking a winner, and this error
 * carries its own message out rather than collapsing into "cannot locate".
 */
class PinAmbiguityError extends Error {}

/**
 * The one member named `key`, or null when there is none. Two or more is refused:
 * every key this scanner reads sits on the path to the pin, so an ambiguous one
 * makes the whole edit ambiguous.
 */
function uniqueMember(
   members: { key: string; valueAt: number }[],
   key: string,
   where: string,
): { key: string; valueAt: number } | null {
   const matches = members.filter((m) => m.key === key);
   if (matches.length > 1) throw new PinAmbiguityError(`duplicate key ${JSON.stringify(key)} ${where}`);
   return matches[0] ?? null;
}

/** Index of the first character at or after `i` that is not JSON whitespace. */
function skipJsonWs(text: string, i: number): number {
   while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
   return i;
}

/** One JSON string starting at the opening quote: its decoded value (escapes
 * resolved, for comparison only) and the span of its RAW contents between the
 * quotes, which is the only thing an edit ever replaces. */
function scanJsonString(text: string, i: number): { value: string; contentStart: number; end: number } {
   if (text[i] !== '"') throw new PinScanError('expected a string');
   const contentStart = i + 1;
   let out = '';
   let j = contentStart;
   while (j < text.length) {
      const c = text[j];
      if (c === '"') return { value: out, contentStart, end: j + 1 };
      if (c !== '\\') {
         out += c;
         j++;
         continue;
      }
      const esc = text[j + 1];
      j += 2;
      switch (esc) {
         case '"':
         case '\\':
         case '/':
            out += esc;
            break;
         case 'b':
            out += '\b';
            break;
         case 'f':
            out += '\f';
            break;
         case 'n':
            out += '\n';
            break;
         case 'r':
            out += '\r';
            break;
         case 't':
            out += '\t';
            break;
         case 'u': {
            const hex = text.slice(j, j + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PinScanError('malformed \\u escape');
            // Code units are appended as they come: a surrogate PAIR spelled as two
            // escapes reassembles into its astral character by the same rule the
            // parser uses, so an escaped name compares equal to a raw one.
            out += String.fromCharCode(parseInt(hex, 16));
            j += 4;
            break;
         }
         default:
            throw new PinScanError('unknown escape');
      }
   }
   throw new PinScanError('unterminated string');
}

/** Index just past the value beginning at `i`, whatever it is. Objects and arrays
 * are skipped STRUCTURALLY (nesting counted through their own members), so a `pin`
 * key inside some unrelated nested object is never mistaken for a mount's. */
function skipJsonValue(text: string, i: number): number {
   i = skipJsonWs(text, i);
   const c = text[i];
   if (c === '"') return scanJsonString(text, i).end;
   if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      let j = i + 1;
      for (;;) {
         j = skipJsonWs(text, j);
         if (j >= text.length) throw new PinScanError('unterminated container');
         if (text[j] === close) return j + 1;
         if (text[j] === ',' || text[j] === ':') {
            j++;
            continue;
         }
         j = skipJsonValue(text, j);
      }
   }
   // A literal or a number: everything up to the next structural character.
   let j = i;
   while (j < text.length && !' \t\n\r,}]'.includes(text[j])) j++;
   if (j === i) throw new PinScanError('expected a value');
   return j;
}

/** Each member of the object beginning at `i`, as (decoded key, index of its
 * value); plus the index just past the object. */
function jsonMembers(text: string, i: number): { members: { key: string; valueAt: number }[]; end: number } {
   i = skipJsonWs(text, i);
   if (text[i] !== '{') throw new PinScanError('expected an object');
   const members: { key: string; valueAt: number }[] = [];
   let j = i + 1;
   for (;;) {
      j = skipJsonWs(text, j);
      if (j >= text.length) throw new PinScanError('unterminated object');
      if (text[j] === '}') return { members, end: j + 1 };
      if (text[j] === ',') {
         j++;
         continue;
      }
      const key = scanJsonString(text, j);
      j = skipJsonWs(text, key.end);
      if (text[j] !== ':') throw new PinScanError('expected ":"');
      const valueAt = skipJsonWs(text, j + 1);
      members.push({ key: key.value, valueAt });
      j = skipJsonValue(text, valueAt);
   }
}

/** The raw span of `federation.mounts[i].pin` for the mount named `name`, with the
 * value the span currently holds. Null when no such mount, or no `pin` on it. */
function findMountPinSpan(
   text: string,
   name: string,
): { value: string; contentStart: number; contentEnd: number } | null {
   const root = jsonMembers(text, 0);
   const federation = uniqueMember(root.members, 'federation', 'in the manifest root');
   if (!federation) return null;
   const mountsKey = uniqueMember(jsonMembers(text, federation.valueAt).members, 'mounts', 'in "federation"');
   if (!mountsKey) return null;
   let i = skipJsonWs(text, mountsKey.valueAt);
   if (text[i] !== '[') throw new PinScanError('expected an array');
   i++;
   for (;;) {
      i = skipJsonWs(text, i);
      if (i >= text.length) throw new PinScanError('unterminated array');
      if (text[i] === ']') return null;
      if (text[i] === ',') {
         i++;
         continue;
      }
      if (text[i] !== '{') {
         i = skipJsonValue(text, i);
         continue;
      }
      const entry = jsonMembers(text, i);
      // A mount whose own name is ambiguous cannot be told apart from the addressed
      // one, so the document is refused before any element is matched.
      const nameMember = uniqueMember(entry.members, 'name', 'in a federation mount');
      if (nameMember && text[nameMember.valueAt] === '"' && scanJsonString(text, nameMember.valueAt).value === name) {
         const pinMember = uniqueMember(entry.members, 'pin', `in mount ${JSON.stringify(name)}`);
         if (!pinMember) return null;
         if (text[pinMember.valueAt] !== '"') throw new PinScanError('pin is not a string');
         const pin = scanJsonString(text, pinMember.valueAt);
         return { value: pin.value, contentStart: pin.contentStart, contentEnd: pin.end - 1 };
      }
      i = entry.end;
   }
}

/**
 * Move one declared mount's pin, in place. `from` is what the span must currently
 * hold — the value the comparison was computed against — so a manifest that moved
 * underneath the run is refused rather than overwritten. Everything outside the pin
 * value's own bytes is returned exactly as it came in.
 *
 * Throws when the pin cannot be located, or holds something other than `from`.
 * Both are internal refusals after the manifest has already parsed and validated.
 */
export function replaceMountPinInManifestText(
   text: string,
   name: string,
   from: string,
   to: string,
): { text: string; changed: boolean } {
   let span: ReturnType<typeof findMountPinSpan>;
   try {
      span = findMountPinSpan(text, name);
   } catch (e) {
      // An ambiguous document is refused on its own terms; a merely malformed one
      // is the same answer as a mount that is not there.
      if (e instanceof PinAmbiguityError) throw new Error(`${MANIFEST_FILENAME}: ${e.message}`);
      if (!(e instanceof PinScanError)) throw e;
      span = null;
   }
   if (span === null) {
      throw new Error(`${MANIFEST_FILENAME}: cannot locate the pin of mount ${JSON.stringify(name)}`);
   }
   if (span.value !== from) {
      throw new Error(`${MANIFEST_FILENAME}: pin of mount ${JSON.stringify(name)} is not ${JSON.stringify(from)}`);
   }
   if (from === to) return { text, changed: false };
   return { text: text.slice(0, span.contentStart) + to + text.slice(span.contentEnd), changed: true };
}
