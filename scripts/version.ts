#!/usr/bin/env node
// Keeps every reference package version (9 locations) and the internal
// @leji-org/leji dependency ranges on one release number.
//
//   node scripts/version.ts <newversion>   # set every location
//   node scripts/version.ts --check        # assert all agree; print the version
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A clean release version: x.y.z, optionally a prerelease suffix (-rc.1, -beta).
// Deliberately strict: no build metadata, no leading "v".
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type Kind = 'json' | 'pyproject' | 'go';

interface Target {
   rel: string;
   kind: Kind;
}

// The 9 version locations. JSON manifests carry a top-level "version" field;
// pyproject.toml carries it under [project]; schemas.go carries the SDKVersion
// constant.
const TARGETS: Target[] = [
   { rel: 'package.json', kind: 'json' },
   { rel: 'packages/sdk/package.json', kind: 'json' },
   { rel: 'packages/create-leji/package.json', kind: 'json' },
   { rel: 'packages/sdk-py/package.json', kind: 'json' },
   { rel: 'packages/sdk-py/pyproject.toml', kind: 'pyproject' },
   { rel: 'packages/sdk-go/package.json', kind: 'json' },
   { rel: 'packages/sdk-go/internal/schemas/schemas.go', kind: 'go' },
   { rel: 'packages/sdk/jsr.json', kind: 'json' },
   { rel: 'packages/mcp/package.json', kind: 'json' },
];

// Workspace packages that publish with a caret dependency on the matching SDK,
// pinned to the release version (the TARGETS rewriter skips dependency ranges).
interface DepTarget {
   rel: string;
   dep: string;
}
const INTERNAL_DEPS: DepTarget[] = [
   { rel: 'packages/mcp/package.json', dep: '@leji-org/leji' },
   { rel: 'packages/create-leji/package.json', dep: '@leji-org/leji' },
];

// Matcher + rewriter for each file kind. The matcher captures the current
// version from the one canonical spot; the rewriter sets a new one in place.
const PATTERNS: Record<Kind, RegExp> = {
   // Top-level "version": "...". Anchored to the start of a line so a nested
   // "version" inside, say, a dependency object is not matched (manifests here
   // keep the field at top level, two/three-space indented).
   json: /^(\s*"version"\s*:\s*")([^"]+)(")/m,
   // version = "..." inside the [project] table. We additionally require it to
   // appear after the [project] header (checked in read()).
   pyproject: /^(version\s*=\s*")([^"]+)(")/m,
   // SDKVersion = "..." Go constant/var.
   go: /^(\s*(?:var|const)?\s*SDKVersion\s*=\s*")([^"]+)(")/m,
};

function abs(rel: string): string {
   return path.join(repoRoot, rel);
}

// Read the current version from a single target, or throw with a clear reason.
function readVersion(t: Target): string {
   const text = fs.readFileSync(abs(t.rel), 'utf8');
   if (t.kind === 'pyproject') {
      // Restrict the search to the [project] table so a version in another
      // table (e.g. a tool section) can never be picked up.
      const start = text.indexOf('[project]');
      if (start === -1) throw new Error(`${t.rel}: no [project] table`);
      const rest = text.slice(start);
      const nextTable = rest.slice('[project]'.length).search(/^\[/m);
      const section = nextTable === -1 ? rest : rest.slice(0, '[project]'.length + nextTable);
      const m = PATTERNS.pyproject.exec(section);
      if (!m) throw new Error(`${t.rel}: no version = "..." under [project]`);
      return m[2];
   }
   const m = PATTERNS[t.kind].exec(text);
   if (!m) throw new Error(`${t.rel}: version pattern not found`);
   return m[2];
}

// Rewrite a single target's version in place. Returns true if the file changed.
function writeVersion(t: Target, next: string): boolean {
   const text = fs.readFileSync(abs(t.rel), 'utf8');
   let updated: string;
   if (t.kind === 'pyproject') {
      const start = text.indexOf('[project]');
      if (start === -1) throw new Error(`${t.rel}: no [project] table`);
      const rest = text.slice(start);
      const nextTable = rest.slice('[project]'.length).search(/^\[/m);
      const cut = nextTable === -1 ? rest.length : '[project]'.length + nextTable;
      const section = rest.slice(0, cut);
      if (!PATTERNS.pyproject.test(section)) {
         throw new Error(`${t.rel}: no version = "..." under [project]`);
      }
      const newSection = section.replace(PATTERNS.pyproject, `$1${next}$3`);
      updated = text.slice(0, start) + newSection + rest.slice(cut);
   } else {
      if (!PATTERNS[t.kind].test(text)) {
         throw new Error(`${t.rel}: version pattern not found`);
      }
      updated = text.replace(PATTERNS[t.kind], `$1${next}$3`);
   }
   if (updated === text) return false;
   fs.writeFileSync(abs(t.rel), updated);
   return true;
}

// Match a single dependency entry: `"<dep>": "<range>"`. The dep name is escaped
// so regex metacharacters in a scoped name can't leak into the pattern; group 2
// captures the range (e.g. ^1.2.0). Non-global, so it touches the first (only)
// occurrence in dependencies.
function depPattern(dep: string): RegExp {
   const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   return new RegExp(`("${escaped}"\\s*:\\s*")([^"]+)(")`);
}

// Read the current @leji-org/leji range from a dependency target, or throw.
function readDepRange(d: DepTarget): string {
   const text = fs.readFileSync(abs(d.rel), 'utf8');
   const m = depPattern(d.dep).exec(text);
   if (!m) throw new Error(`${d.rel}: dependency "${d.dep}" not found`);
   return m[2];
}

// Rewrite a dependency range to a caret on `next`. Returns true if it changed.
function writeDepRange(d: DepTarget, next: string): boolean {
   const text = fs.readFileSync(abs(d.rel), 'utf8');
   const pat = depPattern(d.dep);
   if (!pat.test(text)) throw new Error(`${d.rel}: dependency "${d.dep}" not found`);
   const updated = text.replace(pat, `$1^${next}$3`);
   if (updated === text) return false;
   fs.writeFileSync(abs(d.rel), updated);
   return true;
}

function checkMode(): never {
   const found = TARGETS.map((t) => ({ rel: t.rel, version: readVersion(t) }));
   const versions = new Set(found.map((f) => f.version));
   if (versions.size === 1) {
      const [v] = [...versions];
      // Versions agree; the internal dep ranges must be a caret on that version.
      const expected = `^${v}`;
      const deps = INTERNAL_DEPS.map((d) => ({ rel: d.rel, dep: d.dep, range: readDepRange(d) }));
      const drifted = deps.filter((d) => d.range !== expected);
      if (drifted.length > 0) {
         console.error(`version fields agree at ${v}, but internal dep ranges drift (expected ${expected}):`);
         for (const d of drifted) console.error(` != ${d.rel}: "${d.dep}": "${d.range}"`);
         console.error(`\nrun \`npm run version:set ${v}\` to realign`);
         process.exit(1);
      }
      console.log(`version coherent: ${v} (across ${found.length} locations + ${deps.length} internal dep ranges)`);
      process.exit(0);
   }
   // Drift: report the majority version and call out every file that disagrees.
   const counts = new Map<string, number>();
   for (const f of found) counts.set(f.version, (counts.get(f.version) ?? 0) + 1);
   const common = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
   console.error('version DRIFT across SDK locations:');
   for (const f of found) {
      const flag = f.version === common ? '   ' : ' !=';
      console.error(`${flag} ${f.rel}: ${f.version}`);
   }
   console.error(`\nexpected all to match (most common is ${common}); run \`npm run version:set <x>\``);
   process.exit(1);
}

function setMode(next: string): never {
   if (!SEMVER.test(next)) {
      console.error(`error: "${next}" is not a clean semver (x.y.z, optional -prerelease)`);
      process.exit(2);
   }
   let changed = 0;
   for (const t of TARGETS) {
      if (writeVersion(t, next)) {
         console.log(`updated ${t.rel} -> ${next}`);
         changed++;
      } else {
         console.log(`unchanged ${t.rel} (already ${next})`);
      }
   }
   for (const d of INTERNAL_DEPS) {
      if (writeDepRange(d, next)) {
         console.log(`updated ${d.rel} (${d.dep} -> ^${next})`);
         changed++;
      } else {
         console.log(`unchanged ${d.rel} (${d.dep} already ^${next})`);
      }
   }
   console.log(`\nset ${TARGETS.length} versions + ${INTERNAL_DEPS.length} dep ranges to ${next} (${changed} changed)`);
   process.exit(0);
}

const args = process.argv.slice(2);
if (args.includes('--check')) {
   checkMode();
}
const positional = args.filter((a) => !a.startsWith('-'));
if (positional.length !== 1) {
   console.error('usage: node scripts/version.ts <newversion> | --check');
   process.exit(2);
}
setMode(positional[0]);
