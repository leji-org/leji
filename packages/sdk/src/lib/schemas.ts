import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

/** Spec lines this SDK supports (versioning.md: validate against the declared line). */
export const SUPPORTED_LINES = ['1.0'];

export type SchemaName =
   | 'context-manifest'
   | 'context-index'
   | 'context-changelog'
   | 'agent-profile'
   | 'decision-record';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSdkVersion(): string {
   try {
      const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
   } catch {
      return '0.0.0';
   }
}

/** This SDK's version, read from its own package metadata. */
export const SDK_VERSION: string = readSdkVersion();

/** Directory holding the vendored schema files for a spec line. */
export function schemasDir(): string {
   return path.join(packageRoot, 'schemas');
}

/** Directory holding the vendored templates. */
export function templatesDir(): string {
   return path.join(packageRoot, 'templates');
}

export interface CliOption {
   flags: string;
   summary: string;
}
export interface CliCommand {
   name: string;
   summary: string;
   usage: string;
   description: string;
   /** Sub-points rendered as bullets on the docs site only; terminal help uses `summary`. */
   details?: string[];
   options: CliOption[];
   examples: string[];
}
export interface CliSpec {
   name: string;
   summary: string;
   usage: string;
   globalOptions: CliOption[];
   exitCodes: { code: number; meaning: string }[];
   commands: CliCommand[];
}

/** Canonical CLI description, single-sourced from cli.json (terminal help + docs). */
export function loadCliSpec(): CliSpec {
   return JSON.parse(fs.readFileSync(path.join(packageRoot, 'cli.json'), 'utf8'));
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const cache = new Map<SchemaName, ValidateFunction>();

export function getValidator(name: SchemaName): ValidateFunction {
   let v = cache.get(name);
   if (!v) {
      const schema = JSON.parse(fs.readFileSync(path.join(schemasDir(), `${name}.schema.json`), 'utf8'));
      v = ajv.compile(schema);
      cache.set(name, v);
   }
   return v;
}

/**
 * One violation, reduced to what the three SDKs can all say about it: where it
 * happened, which constraint failed, and the constraint's own operands. Never the
 * offending value (see `normalizedMessage`).
 */
interface Violation {
   /** JSON-pointer instance path, `''` for the document root. */
   path: string;
   /** The JSON Schema keyword that failed. */
   kind: string;
   /** A property name, where the keyword's subject is one (required,
    * additionalProperties, propertyNames). */
   property?: string;
   /** The constraint's own operand: a pattern, a type list, an enum, a limit. */
   want?: unknown;
}

/** JSON string quoting, the same relation `jsonenc` reproduces in Go and
 * `json.dumps(ensure_ascii=False)` in Python: `"` `\` and C0 controls escape, and
 * every other rune is carried through as itself. */
function q(value: unknown): string {
   return JSON.stringify(value) ?? 'null';
}

/** Agree the count noun with the limit, so a bound of 1 does not read as "1 items".
 * The limit is a schema constant, so the branch resolves identically in all three. */
function plural(limit: unknown, one: string, many = ''): string {
   return limit === 1 ? one : many || `${one}s`;
}

/**
 * The Leji sentence for a violation kind, or null to fall back to the validator's
 * own text.
 *
 * Three validators phrase and order the same violation differently (ajv, Go's
 * santhosh-tekuri, Python's jsonschema), and the parity harness compares stdout byte
 * for byte, so any schema failure that reaches output has to be phrased here rather
 * than passed through. The kinds covered are the ones the five shipped schemas can
 * actually produce; anything else keeps the fallback, so a schema keyword added later
 * degrades to un-normalized text instead of to a wrong sentence.
 *
 * **The offending value never appears.** A schema violation is about shape, and the
 * path already tells a reader where to look; echoing authored bytes would push
 * context-layer content into CI logs, pull-request comments, and the MCP tool
 * response, which is exactly what the derived-surface rule
 * (machine-readable-surface.md, Requirement 8) exists to prevent. Property *names*
 * are the exception: an unexpected or missing key is the thing the reader has to act
 * on, and the message is useless without it. Constraint operands come from the
 * schema, not from the document, so they are always safe to name.
 */
function normalizedMessage(v: Violation): string | null {
   const want = v.want;
   switch (v.kind) {
      case 'required':
         return `is missing required property ${q(v.property)}`;
      case 'additionalProperties':
         return `has unexpected property ${q(v.property)}; this object declares a closed set`;
      // Anchored at the document root, not at the offending object: Go's validator
      // records no instance location for a property-name failure (the "instance" it
      // judged is the name, which has none), and a cross-SDK guarantee that holds in
      // two of three is not a guarantee. The property name is the actionable part and
      // is preserved; the path precision is the deliberate trade. Rare enough to be
      // worth it: the shipped schemas use propertyNames twice.
      case 'propertyNames':
         return `has an invalid property name ${q(v.property)}`;
      case 'type':
         return `must be of type ${(Array.isArray(want) ? want : [want]).map(String).join(' or ')}`;
      case 'pattern':
         return `must match pattern ${q(want)}`;
      case 'enum':
         return `must be one of: ${(Array.isArray(want) ? want : []).map(q).join(', ')}`;
      case 'minLength':
         return `must be at least ${String(want)} ${plural(want, 'character')}`;
      case 'minItems':
         return `must have at least ${String(want)} ${plural(want, 'item')}`;
      case 'minProperties':
         return `must have at least ${String(want)} ${plural(want, 'property', 'properties')}`;
      case 'minimum':
         return `must be at least ${String(want)}`;
      case 'maximum':
         return `must be at most ${String(want)}`;
      case 'uniqueItems':
         return 'must not contain duplicate items';
      default:
         return null;
   }
}

/** Render one violation as the SDKs emit it: instance path, then the sentence. */
function renderViolation(path: string, message: string): string {
   return `${path === '' ? '(root)' : path} ${message}`;
}

/**
 * Deduplicate and order violations identically in all three SDKs.
 *
 * Order is bytewise by path, then by message: the three validators emit the same
 * failures in different orders, and a stable total order is what makes the byte
 * comparison meaningful. Deduplication matters because the same violation can arrive
 * more than once per validator (Python yields one `required` error per missing
 * property, each of which recomputes the whole missing set here).
 */
function finishViolations(rendered: string[]): string[] {
   return [...new Set(rendered)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Validate data against a vendored schema; returns human-readable error strings. */
export function schemaErrors(name: SchemaName, data: unknown): string[] {
   const v = getValidator(name);
   if (v(data)) return [];
   const out: string[] = [];
   for (const e of v.errors ?? []) {
      // Ajv reports if/then failures twice (inner error + "must match then"
      // wrapper). Drop the wrapper for finding-count parity with the other two.
      // `anyOf` is a wrapper in the same sense: the branch failures beneath it say
      // what is actually wrong, and the three validators disagree about whether the
      // wrapper itself is reported at all.
      if (e.keyword === 'if' || e.keyword === 'anyOf') continue;
      // A propertyNames failure arrives twice as well: the inner keyword that judged
      // the name, and the propertyNames node that names it. Keep the node, which is
      // the only one of the two that carries the offending property.
      if (e.schemaPath.includes('/propertyNames/')) continue;
      const params = e.params as Record<string, unknown>;
      const violation: Violation = {
         path: e.instancePath,
         kind: e.keyword,
         property: (params.missingProperty ?? params.additionalProperty ?? params.propertyName) as string | undefined,
         want: params.pattern ?? params.type ?? params.allowedValues ?? params.limit,
      };
      const message = normalizedMessage(violation);
      // See `normalizedMessage`: propertyNames reports at the root in all three.
      const at = violation.kind === 'propertyNames' ? '' : violation.path;
      out.push(renderViolation(at, message ?? e.message ?? 'invalid'));
   }
   return finishViolations(out);
}
