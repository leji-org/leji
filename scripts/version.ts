#!/usr/bin/env node
// Keeps all 9 package-version locations and the internal @leji-org/leji dep
// ranges on one release number.
//
//   node scripts/version.ts <newversion>   # set every location
//   node scripts/version.ts --check        # assert all agree; print the version
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Deliberately strict: x.y.z with optional prerelease (-rc.1), no build metadata, no "v".
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

type Kind = 'json' | 'pyproject' | 'go';

interface Target {
   rel: string;
   kind: Kind;
}

// The 9 version locations: JSON manifests at top-level "version", pyproject.toml
// under [project], schemas.go in the SDKVersion constant.
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

const PATTERNS: Record<Kind, RegExp> = {
   // Anchored to line start so a nested "version" (e.g. in a dependency object) is
   // not matched; manifests here keep the field at top level.
   json: /^(\s*"version"\s*:\s*")([^"]+)(")/m,
   // [project] containment is enforced separately in read().
   pyproject: /^(version\s*=\s*")([^"]+)(")/m,
   go: /^(\s*(?:var|const)?\s*SDKVersion\s*=\s*")([^"]+)(")/m,
};

function abs(rel: string): string {
   return path.join(repoRoot, rel);
}

function readVersion(t: Target): string {
   const text = fs.readFileSync(abs(t.rel), 'utf8');
   if (t.kind === 'pyproject') {
      // Restrict to the [project] table so a version in another table is not picked up.
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

// Returns true if the file changed.
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

// Match `"<dep>": "<range>"`. The dep name is escaped so metacharacters in a
// scoped name can't leak into the pattern; group 2 captures the range. Non-global,
// so it touches the first occurrence.
function depPattern(dep: string): RegExp {
   const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   return new RegExp(`("${escaped}"\\s*:\\s*")([^"]+)(")`);
}

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

// Prose that states the current release. `version.ts <x>` rewrites the machine
// locations above; these say the version in words, so they drift silently and are
// only noticed once a stale number is already published inside an npm tarball or
// on pkg.go.dev. Checked, never rewritten: the sentence around the number decides
// whether it should move at all.
const PROSE: string[] = [
   'README.md',
   'CONTRIBUTING.md',
   'RELEASING.md',
   'docs/boot-profile.md',
   'packages/sdk-go/README.md',
   '.github/workflows/release-finalize.yml',
];

// Version-shaped strings that must NOT track this release. Two kinds:
// a past event, which bumping would rewrite rather than record, and a version
// belonging to something else entirely.
const NOT_OURS: RegExp[] = [
   // Spec 1.0 froze at one specific tooling release and always will have.
   /frozen at the v?\d+\.\d+\.\d+ reference-tooling release/g,
   /GA at the reference-tooling v?\d+\.\d+\.\d+ release/g,
   // SHA-pinned third-party actions: the trailing comment names the action's
   // own version, which moves on its schedule and not ours.
   /@[0-9a-f]{40}\s*#\s*v?\d+\.\d+\.\d+/g,
   // The Go toolchain floor the SDK declares: Go's version line, not ours.
   /\bGo \d+\.\d+\.\d+\+?/g,
];

/** Report prose files naming a version other than the released one. */
function proseDrift(current: string): { rel: string; line: number; text: string }[] {
   const out: { rel: string; line: number; text: string }[] = [];
   for (const rel of PROSE) {
      const file = abs(rel);
      if (!fs.existsSync(file)) continue;
      fs.readFileSync(file, 'utf8')
         .split('\n')
         .forEach((raw, i) => {
            // Drop the historical clauses first, so a line carrying both a frozen-at
            // reference and a current-version claim is judged on the claim alone.
            let line = raw;
            for (const skip of NOT_OURS) line = line.replace(skip, '');
            for (const m of line.matchAll(/\d+\.\d+\.\d+/g)) {
               if (m[0] !== current) out.push({ rel, line: i + 1, text: raw.trim().slice(0, 110) });
            }
         });
   }
   return out;
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
      const stale = proseDrift(v);
      if (stale.length > 0) {
         console.error(`version fields agree at ${v}, but prose names another release:`);
         for (const d of stale) console.error(` != ${d.rel}:${d.line}: ${d.text}`);
         console.error('\nUpdate the sentence, or add a NOT_OURS pattern in scripts/version.ts');
         console.error('if it names a past event, or a version belonging to another project.');
         process.exit(1);
      }
      console.log(
         `version coherent: ${v} (across ${found.length} locations + ${deps.length} internal dep ranges + ${PROSE.length} prose files)`,
      );
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
