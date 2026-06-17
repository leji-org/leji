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

/** The canonical CLI description, single-sourced from cli.json. The terminal
 * help and the docs site both render from this. */
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

/** Validate data against a vendored schema; returns human-readable error strings. */
export function schemaErrors(name: SchemaName, data: unknown): string[] {
   const v = getValidator(name);
   if (v(data)) return [];
   return (
      (v.errors ?? [])
         // Ajv reports conditional (if/then) failures twice: the inner error plus
         // a "must match then schema" wrapper. Drop the wrapper for finding-count
         // parity with the Python SDK's jsonschema.
         .filter((e) => e.keyword !== 'if')
         .map((e) => {
            const where = e.instancePath === '' ? '(root)' : e.instancePath;
            return `${where} ${e.message ?? 'invalid'}`;
         })
   );
}
