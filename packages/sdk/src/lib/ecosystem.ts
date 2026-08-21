import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvedWithinRoot } from './fsx.js';

/**
 * Which dependency ecosystem owns a repository root, which package manager runs
 * it, how the Leji CLI is declared as a dev dependency there, and how a hook or CI
 * job should invoke it.
 *
 * Pure and offline: it reads a bounded set of files directly under the root and
 * writes nothing, launches nothing, and never walks up out of the root (an add in
 * a parent directory would write outside the root the user targeted). Every answer
 * is a total decision table over repository evidence, so the three SDKs return the
 * same report for the same tree.
 */

/** The npm package name. Its presence in `package.json`'s dependency maps is what
 * `directDeclared` reports for a Node repository, and what selects the local-first
 * CI and hook variants over the `npx @leji-org/leji@1` fallback. */
export const DEP_NAME = '@leji-org/leji';
/** The distribution name on PyPI and the name a Python manifest declares. */
const PY_DIST = 'leji';
/** The Go module path a `tool` directive names for the CLI. */
const GO_TOOL_PATH = 'github.com/leji-org/leji/packages/sdk-go/cmd/leji';

export type EcosystemId = 'node' | 'python' | 'go';

/** Why an ecosystem's manager could not be selected, or `ok` when it was. */
export type EcoStatus = 'ok' | 'ambiguous-manager' | 'unsupported-manager' | 'unreadable-manifest' | 'refused-evidence';

/** What evidenced the manager: the `packageManager` field, a lockfile, a
 * `[tool.*]` table, the manifest itself (`Pipfile`), or the ecosystem's default. */
export type EcoSource = 'packageManager' | 'lockfile' | 'tool-table' | 'manifest' | 'default';

/** The report's overall verdict: `null` when one ecosystem answered cleanly. */
export type EcoReason = Exclude<EcoStatus, 'ok'> | 'multiple-ecosystems' | 'none';

/** One package manager the evidence could not choose between, with the command
 * that would declare Leji under it (`null` for a print-only manager). */
export interface EcoCandidate {
   manager: string;
   add: string[] | null;
}

/**
 * One gated ecosystem's answer. TOTAL: every field is set on every outcome, so a
 * consumer never has to know which branch produced the result.
 */
export interface EcoResult {
   ecosystem: EcosystemId;
   status: EcoStatus;
   /** The manifest that gated the ecosystem, repository-root-relative. */
   manifest: string | null;
   manager: string | null;
   source: EcoSource | null;
   /** The files that evidenced the manager decision — lockfiles present, plus
    * every root `requirements*.txt` for Python — or, on `refused-evidence`, the
    * names that were refused. Sorted as documented per ecosystem. */
   evidence: string[];
   /** Argv that declares Leji as a dev dependency; `null` for a print-only
    * manager (pip, pre-1.24 Go) and whenever no manager was selected. */
   add: string[] | null;
   /** Argv that runs the declared CLI through this manager. */
   runner: string[] | null;
   directDeclared: boolean;
   lockEvidenced: boolean;
   candidates: EcoCandidate[];
}

/** The whole answer for one root. `selected` is non-null only when exactly one
 * ecosystem is gated AND it chose a manager. */
export interface EcosystemReport {
   selected: EcoResult | null;
   all: EcoResult[];
   reason: EcoReason | null;
}

/** Per-manager commands. `add` is `null` for a manager that cannot declare a dev
 * dependency from the command line; its guidance is printed instead. `install` is
 * the manager's own plain install — what a joiner runs on a fresh clone so the
 * declared CLI resolves — and is `null` for a manager whose install depends on which
 * requirements file the repository uses. Argv arrays, never shell strings. No version
 * pin: the lockfile pins the exact version, and Go needs a selector, so it takes
 * `@latest`. */
const MANAGER_COMMANDS: Record<string, { add: string[] | null; runner: string[]; install: string[] | null }> = {
   npm: { add: ['npm', 'i', '-D', DEP_NAME], runner: ['npx', '--no-install', DEP_NAME], install: ['npm', 'install'] },
   pnpm: { add: ['pnpm', 'add', '-D', DEP_NAME], runner: ['pnpm', 'exec', 'leji'], install: ['pnpm', 'install'] },
   yarn: { add: ['yarn', 'add', '-D', DEP_NAME], runner: ['yarn', 'leji'], install: ['yarn', 'install'] },
   bun: { add: ['bun', 'add', '-d', DEP_NAME], runner: ['bun', 'run', 'leji'], install: ['bun', 'install'] },
   uv: { add: ['uv', 'add', '--dev', PY_DIST], runner: ['uv', 'run', 'leji'], install: ['uv', 'sync'] },
   poetry: {
      add: ['poetry', 'add', '--group', 'dev', PY_DIST],
      runner: ['poetry', 'run', 'leji'],
      install: ['poetry', 'install'],
   },
   pdm: { add: ['pdm', 'add', '-dG', 'dev', PY_DIST], runner: ['pdm', 'run', 'leji'], install: ['pdm', 'install'] },
   pipenv: {
      add: ['pipenv', 'install', '--dev', PY_DIST],
      runner: ['pipenv', 'run', 'leji'],
      install: ['pipenv', 'install', '--dev'],
   },
   pip: { add: null, runner: ['leji'], install: null },
   go: {
      add: ['go', 'get', '-tool', `${GO_TOOL_PATH}@latest`],
      runner: ['go', 'tool', 'leji'],
      // The same command F10's CI table installs a Go repository's tools with.
      install: ['go', 'mod', 'download'],
   },
   'go-legacy': { add: null, runner: ['leji'], install: null },
};

/** The fallback runner: the CLI on PATH, for every repository that has not
 * declared it. */
const PLAIN_RUNNER = ['leji'];

const NODE_MANIFEST = 'package.json';
const GO_MANIFEST = 'go.mod';
const PYPROJECT = 'pyproject.toml';
const PIPFILE = 'Pipfile';

/** Node lockfile families, in the fixed order every list of them uses. Two names
 * mark bun (text and binary); either one is presence-only evidence. */
const NODE_LOCKS: { file: string; manager: string }[] = [
   { file: 'package-lock.json', manager: 'npm' },
   { file: 'pnpm-lock.yaml', manager: 'pnpm' },
   { file: 'yarn.lock', manager: 'yarn' },
   { file: 'bun.lock', manager: 'bun' },
   { file: 'bun.lockb', manager: 'bun' },
];
const NODE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

/** Python lock families, in the fixed order every list of them uses. `Pipfile`
 * is a family member without being a lock: it selects pipenv, but only
 * `Pipfile.lock` evidences a lock. */
const PY_LOCKS: { file: string; manager: string; lock: boolean }[] = [
   { file: 'uv.lock', manager: 'uv', lock: true },
   { file: 'poetry.lock', manager: 'poetry', lock: true },
   { file: 'pdm.lock', manager: 'pdm', lock: true },
   { file: 'Pipfile.lock', manager: 'pipenv', lock: true },
   { file: PIPFILE, manager: 'pipenv', lock: false },
];
/** `[tool.<x>]` tables that name a manager when no lock family is present. */
const PY_TOOL_TABLES: { table: string; manager: string }[] = [
   { table: 'tool.uv', manager: 'uv' },
   { table: 'tool.poetry', manager: 'poetry' },
   { table: 'tool.pdm', manager: 'pdm' },
];
/** Root files that gate the Python ecosystem alongside the two manifests. */
const REQUIREMENTS_RE = /^requirements[A-Za-z0-9._-]*\.txt$/;

// --- the human block ------------------------------------------------------
// Every string the offer prints lives here once, so the three SDKs transcribe one
// table rather than re-deriving prose. The block is always printed; the prompt
// that may follow it is not this module's business.

const OFFER_LEAD = 'To declare the Leji CLI as a dev dependency so a clean install brings leji, run:';
const DECLARE_WITH_TOOL = 'Declare the Leji CLI as a dev dependency with the tool this repo uses.';
const INDENT = '   ';

const TEXT = {
   offer: (manager: string, file: string): string => `Detected ${manager} (${file}). ${OFFER_LEAD}`,
   declared: (manifest: string): string => `The Leji CLI is already declared in ${manifest}.`,
   ambiguous: (manifest: string, files: string[]): string =>
      `Detected ${manifest} with ${joinAnd(files)}; leji will not guess the package manager. Declare it with the one this repo uses:`,
   multiple: (manifests: string[], commands: boolean): string =>
      `Detected ${joinAnd(manifests)}; leji will not guess which ecosystem owns this repository. Declare it with the one this repo uses${commands ? ':' : '.'}`,
   none: [
      'No package.json, pyproject.toml or go.mod here, so there is nothing for leji to declare itself in. Install the Leji CLI for yourself:',
      `${INDENT}npm install -g ${DEP_NAME}`,
      'Other runtimes and the full walkthrough: https://leji.org/quickstart/',
   ],
   unsupported: (manifest: string): string =>
      `Detected ${manifest}, whose packageManager field names a package manager leji does not know; leji will not guess. ${DECLARE_WITH_TOOL}`,
   unreadable: (manifest: string): string =>
      `Could not read ${manifest}, so leji will not guess the package manager. ${DECLARE_WITH_TOOL}`,
   refused: (files: string[]): string =>
      `Refusing to read ${joinAnd(files)}: not a regular file inside this repository. ${DECLARE_WITH_TOOL}`,
   pipGroups: (file: string): string[] => [
      `Detected pip (${file}). To declare the Leji CLI as a dev dependency so a clean install brings leji, add to ${PYPROJECT}:`,
      `${INDENT}[dependency-groups]`,
      `${INDENT}dev = ["${PY_DIST}"]`,
      'then run it with pip 25.1 or newer:',
      `${INDENT}pip install --group dev`,
   ],
   pipRequirements: (file: string): string[] => [
      `Detected pip (${file}). To declare the Leji CLI as a dev dependency so a clean install brings leji, add a line \`${PY_DIST}\` to requirements-dev.txt, then run:`,
      `${INDENT}pip install -r requirements-dev.txt`,
   ],
   goLegacy: (file: string): string[] => [
      `Detected Go (${file}) without a go directive of 1.24 or newer, so leji cannot be declared as a module tool. Install the Leji CLI for yourself:`,
      `${INDENT}go install ${GO_TOOL_PATH}@latest`,
   ],
   line: {
      selected: (manager: string, file: string, declared: boolean): string =>
         `Ecosystem: ${manager} (${file}); Leji CLI ${declared ? 'declared' : 'not declared'}`,
      none: 'Ecosystem: none detected',
      multiple: (manifests: string[]): string =>
         `Ecosystem: ${joinAnd(manifests)}; leji will not guess which one owns this repository`,
      ambiguous: (manifest: string, files: string[]): string =>
         `Ecosystem: ${manifest} with ${joinAnd(files)}; leji will not guess the package manager`,
      unsupported: (manifest: string): string => `Ecosystem: ${manifest}; unrecognized packageManager field`,
      unreadable: (manifest: string): string => `Ecosystem: ${manifest}; unreadable`,
      refused: (files: string[]): string => `Ecosystem: ${joinAnd(files)}; not a regular file inside this repository`,
   },
   /** The consent path (plan section 3): the prompt, and every outcome of running
    * the manager's own add command. leji writes no manifest byte itself, so these
    * are the only words it owns once the user says yes. */
   consent: {
      /** Printed immediately before the prompt, interactive runs only. The manager
       * runs here, as the user, with the user's environment: say so before asking,
       * not after. */
      disclosure: (bin: string): string =>
         `This runs ${bin} here with your environment, as when you run it yourself: it will contact its registry and may run install scripts.`,
      prompt: 'Run it now?',
      running: (command: string[]): string => `Running: ${command.join(' ')}`,
      /** Names what was actually declared, per ecosystem: the npm package, the
       * PyPI distribution, or the Go module tool. */
      declared: (ecosystem: EcosystemId): string =>
         `Declared ${DECLARED_SUBJECT[ecosystem]}; a clean install now brings leji.`,
      exited: (bin: string, code: number): string => `${bin} exited ${code}; run it yourself:`,
      signaled: (bin: string, signal: string): string => `${bin} was terminated (${signal}); run it yourself:`,
      missing: (bin: string): string => `${bin} is not on your PATH; run it yourself once it is:`,
      declined: 'Skipped; declare it later with:',
      /** One indented command line, so no caller re-derives the indentation. */
      command: (command: string[]): string => `${INDENT}${command.join(' ')}`,
   },
};

/** What each ecosystem's add command actually declares. */
const DECLARED_SUBJECT: Record<EcosystemId, string> = {
   node: DEP_NAME,
   python: PY_DIST,
   go: 'the leji module tool',
};

/**
 * The whole message table, exported for the two callers that print outside this
 * module (the declaration offer) and for the ports to transcribe. Not re-exported
 * from the package index: these are the CLI's words, not a library API.
 */
export const ECOSYSTEM_TEXT = TEXT;

/** `a`, `a and b`, `a, b and c` — the one list join every message uses. */
function joinAnd(items: string[]): string {
   if (items.length === 0) return '';
   if (items.length === 1) return items[0];
   return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// --- evidence eligibility -------------------------------------------------

/** What stands at one probed name directly under the root. A gated file counts
 * only when `lstat` says regular file AND its real path lies inside the real
 * root: a symlink, a dangling link, a directory, a socket or a FIFO is refused
 * rather than read, so no manifest or lockfile can redirect the answer out of the
 * repository the user pointed at. */
type EntryKind = 'absent' | 'eligible' | 'refused';

function classify(rootAbs: string, name: string): EntryKind {
   const abs = path.join(rootAbs, name);
   let st: fs.Stats;
   try {
      st = fs.lstatSync(abs);
   } catch {
      return 'absent';
   }
   if (!st.isFile()) return 'refused';
   return resolvedWithinRoot(rootAbs, abs) ? 'eligible' : 'refused';
}

/** The probed names of one root, classified once. */
class RootScan {
   private readonly kinds = new Map<string, EntryKind>();
   private entries: string[] | null = null;
   constructor(readonly rootAbs: string) {}
   kind(name: string): EntryKind {
      let k = this.kinds.get(name);
      if (k === undefined) {
         k = classify(this.rootAbs, name);
         this.kinds.set(name, k);
      }
      return k;
   }
   present(name: string): boolean {
      return this.kind(name) !== 'absent';
   }
   eligible(name: string): boolean {
      return this.kind(name) === 'eligible';
   }
   /** The refused names among `names`, in the order given. */
   refused(names: string[]): string[] {
      return names.filter((n) => this.kind(n) === 'refused');
   }
   /** The bytes of one probed name, or null. Structurally gated: a name that is
    * not an eligible regular file inside the real root is never opened, so no
    * read can bypass the eligibility rule by being spelled at a new call site. */
   read(name: string): string | null {
      if (this.kind(name) !== 'eligible') return null;
      try {
         return fs.readFileSync(path.join(this.rootAbs, name), 'utf8');
      } catch {
         return null;
      }
   }
   /** Every root entry matching `re`, sorted bytewise (never by locale: the three
    * SDKs must agree, and a locale collation orders `requirements-Test.txt`
    * against `requirements-dev.txt` differently from byte order). */
   matching(re: RegExp): string[] {
      if (this.entries === null) {
         try {
            this.entries = fs.readdirSync(this.rootAbs);
         } catch {
            this.entries = [];
         }
      }
      return this.entries.filter((n) => re.test(n)).sort(byteCompare);
   }
}

function byteCompare(a: string, b: string): number {
   return a < b ? -1 : a > b ? 1 : 0;
}

// --- result construction --------------------------------------------------

/** What a branch decided; everything it leaves out is the neutral value. */
interface Decision {
   ecosystem: EcosystemId;
   status?: EcoStatus;
   manifest: string | null;
   manager?: string | null;
   source?: EcoSource | null;
   evidence?: string[];
   directDeclared?: boolean;
   lockEvidenced?: boolean;
   candidates?: EcoCandidate[];
}

/**
 * The one EcoResult constructor. Every field of the result is set here, in the
 * fixed key order the JSON contract pins, so no branch can build a partial
 * outcome and `add`/`runner` always follow the manager rather than the branch.
 */
function result(d: Decision): EcoResult {
   const commands = d.manager == null ? undefined : MANAGER_COMMANDS[d.manager];
   return {
      ecosystem: d.ecosystem,
      status: d.status ?? 'ok',
      manifest: d.manifest,
      manager: d.manager ?? null,
      source: d.source ?? null,
      evidence: d.evidence ?? [],
      add: commands ? commands.add : null,
      runner: commands ? commands.runner : null,
      directDeclared: d.directDeclared ?? false,
      lockEvidenced: d.lockEvidenced ?? false,
      candidates: d.candidates ?? [],
   };
}

function candidatesFor(managers: string[]): EcoCandidate[] {
   return managers.map((manager) => ({ manager, add: MANAGER_COMMANDS[manager]?.add ?? null }));
}

/** Unique, order-preserving. */
function uniq(items: string[]): string[] {
   return items.filter((x, i) => items.indexOf(x) === i);
}

// --- Node -----------------------------------------------------------------

/** `<name>[@<version>[+<hash>]]`, corepack's grammar. A value that is present but
 * does not parse is malformed — never a fall-through to a lockfile or the default,
 * because explicit repository evidence is never overridden by a guess. */
const PACKAGE_MANAGER_RE =
   /^([a-z][a-z0-9-]*)(?:@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?:\+([A-Za-z0-9._-]+))?)?$/;

function nodeResult(scan: RootScan): EcoResult {
   const refused = scan.refused([NODE_MANIFEST, ...NODE_LOCKS.map((l) => l.file)]);
   if (refused.length > 0) {
      return result({
         ecosystem: 'node',
         status: 'refused-evidence',
         manifest: NODE_MANIFEST,
         evidence: refused.sort(byteCompare),
      });
   }
   const raw = scan.read(NODE_MANIFEST);
   const pkg = raw === null ? null : parsePackageJson(raw);
   if (pkg === null) {
      return result({ ecosystem: 'node', status: 'unreadable-manifest', manifest: NODE_MANIFEST });
   }
   const locks = NODE_LOCKS.filter((l) => scan.eligible(l.file));
   const evidence = locks.map((l) => l.file);
   const directDeclared = declaresDepIn(pkg);
   const selected = (manager: string, source: EcoSource): EcoResult =>
      result({
         ecosystem: 'node',
         manifest: NODE_MANIFEST,
         manager,
         source,
         evidence,
         directDeclared,
         lockEvidenced: locks.some((l) => l.manager === manager),
      });

   const pm = pkg.packageManager;
   if (pm !== undefined) {
      const parsed = typeof pm === 'string' ? PACKAGE_MANAGER_RE.exec(pm) : null;
      const name = parsed ? parsed[1] : null;
      if (name === null || !NODE_MANAGERS.includes(name)) {
         return result({
            ecosystem: 'node',
            status: 'unsupported-manager',
            manifest: NODE_MANIFEST,
            source: 'packageManager',
            evidence,
            directDeclared,
         });
      }
      return selected(name, 'packageManager');
   }

   const families = uniq(locks.map((l) => l.manager));
   if (families.length > 1) {
      return result({
         ecosystem: 'node',
         status: 'ambiguous-manager',
         manifest: NODE_MANIFEST,
         evidence,
         directDeclared,
         candidates: candidatesFor(families),
      });
   }
   return families.length === 1 ? selected(families[0], 'lockfile') : selected('npm', 'default');
}

/** Strict JSON after one BOM strip; anything else — unparseable, or parsed to
 * something that is not a JSON object — leaves the manifest unreadable, and locks
 * and defaults are not consulted from incomplete evidence. */
function parsePackageJson(raw: string): Record<string, unknown> | null {
   const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
   let parsed: unknown;
   try {
      parsed = JSON.parse(text);
   } catch {
      return null;
   }
   return isJsonObject(parsed) ? parsed : null;
}

function declaresDepIn(pkg: Record<string, unknown>): boolean {
   for (const field of ['dependencies', 'devDependencies'] as const) {
      const deps = pkg[field];
      if (isJsonObject(deps) && Object.prototype.hasOwnProperty.call(deps, DEP_NAME)) return true;
   }
   return false;
}

/** A non-null, non-array JSON object. */
function isJsonObject(x: unknown): x is Record<string, unknown> {
   return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// --- Python ---------------------------------------------------------------

function pythonResult(scan: RootScan): EcoResult {
   const requirements = scan.matching(REQUIREMENTS_RE);
   const manifest = pythonManifest(scan, requirements);
   const refused = scan.refused(uniq([PYPROJECT, ...PY_LOCKS.map((l) => l.file), ...requirements]));
   if (refused.length > 0) {
      return result({
         ecosystem: 'python',
         status: 'refused-evidence',
         manifest,
         evidence: refused.sort(byteCompare),
      });
   }
   const pyprojectText = scan.eligible(PYPROJECT) ? scan.read(PYPROJECT) : null;
   const pipfileText = scan.eligible(PIPFILE) ? scan.read(PIPFILE) : null;
   if ((scan.eligible(PYPROJECT) && pyprojectText === null) || (scan.eligible(PIPFILE) && pipfileText === null)) {
      return result({ ecosystem: 'python', status: 'unreadable-manifest', manifest });
   }

   const present = PY_LOCKS.filter((l) => scan.eligible(l.file));
   const evidence = [...present.map((l) => l.file), ...requirements];
   const directDeclared = pythonDeclared(scan, pyprojectText, pipfileText, requirements);
   const families = uniq(present.map((l) => l.manager));

   if (families.length > 1) {
      return result({
         ecosystem: 'python',
         status: 'ambiguous-manager',
         manifest,
         evidence,
         directDeclared,
         candidates: candidatesFor(families),
      });
   }
   if (families.length === 1) {
      // `Pipfile` alone selects pipenv from the manifest itself; only `Pipfile.lock`
      // is lock evidence, which is what CI reads to choose a locked install.
      const lock = present.find((l) => l.manager === families[0] && l.lock);
      return result({
         ecosystem: 'python',
         manifest,
         manager: families[0],
         source: lock ? 'lockfile' : 'manifest',
         evidence,
         directDeclared,
         lockEvidenced: lock !== undefined,
      });
   }

   const tables = pyprojectText === null ? [] : PY_TOOL_TABLES.filter((t) => tomlHasTable(pyprojectText, t.table));
   if (tables.length > 1) {
      return result({
         ecosystem: 'python',
         status: 'ambiguous-manager',
         manifest,
         evidence,
         directDeclared,
         candidates: candidatesFor(tables.map((t) => t.manager)),
      });
   }
   if (tables.length === 1) {
      return result({
         ecosystem: 'python',
         manifest,
         manager: tables[0].manager,
         source: 'tool-table',
         evidence,
         directDeclared,
      });
   }
   // Nothing named a manager: pip is the ecosystem's default, and it is print-only.
   return result({ ecosystem: 'python', manifest, manager: 'pip', source: 'default', evidence, directDeclared });
}

/** Manifest precedence: pyproject, then Pipfile, then the conventional
 * requirements files. Decided on presence, so a refused entry still names what was
 * refused. */
function pythonManifest(scan: RootScan, requirements: string[]): string | null {
   if (scan.present(PYPROJECT)) return PYPROJECT;
   if (scan.present(PIPFILE)) return PIPFILE;
   for (const name of ['requirements-dev.txt', 'requirements.txt']) {
      if (requirements.includes(name)) return name;
   }
   return requirements[0] ?? null;
}

function pythonDeclared(
   scan: RootScan,
   pyprojectText: string | null,
   pipfileText: string | null,
   requirements: string[],
): boolean {
   if (pyprojectText !== null && tomlDeclaresLeji(pyprojectText, PYPROJECT_FIELDS)) return true;
   if (pipfileText !== null && tomlDeclaresLeji(pipfileText, PIPFILE_FIELDS)) return true;
   for (const name of requirements) {
      if (!scan.eligible(name)) continue;
      const text = scan.read(name);
      if (text !== null && requirementsDeclareLeji(text)) return true;
   }
   return false;
}

// --- Go -------------------------------------------------------------------

const GO_DIRECTIVE_RE = /^go\s+(\d+)\.(\d+)/;

function goResult(scan: RootScan): EcoResult {
   const refused = scan.refused([GO_MANIFEST]);
   if (refused.length > 0) {
      return result({ ecosystem: 'go', status: 'refused-evidence', manifest: GO_MANIFEST, evidence: refused });
   }
   const text = scan.read(GO_MANIFEST);
   if (text === null) {
      return result({ ecosystem: 'go', status: 'unreadable-manifest', manifest: GO_MANIFEST });
   }
   // Tool dependencies are a Go 1.24 feature; an older or missing directive gets
   // the per-person install instead. `go.sum` is the manager's business, so a
   // declared tool is its own lock evidence.
   const directDeclared = goDeclaresTool(text);
   const modern = goDirectiveAtLeast(text, 1, 24);
   return result({
      ecosystem: 'go',
      manifest: GO_MANIFEST,
      manager: modern ? 'go' : 'go-legacy',
      source: 'manifest',
      directDeclared,
      lockEvidenced: modern && directDeclared,
   });
}

function goDirectiveAtLeast(text: string, major: number, minor: number): boolean {
   for (const line of splitLines(text)) {
      const m = GO_DIRECTIVE_RE.exec(line.trim());
      if (!m) continue;
      const found = [Number(m[1]), Number(m[2])];
      return found[0] > major || (found[0] === major && found[1] >= minor);
   }
   return false;
}

/** A `tool <path>` line, or that path inside a `tool (` block. */
function goDeclaresTool(text: string): boolean {
   let inBlock = false;
   for (const raw of splitLines(text)) {
      const cut = raw.indexOf('//');
      const line = (cut >= 0 ? raw.slice(0, cut) : raw).trim();
      if (line === '') continue;
      if (inBlock) {
         if (line === ')') inBlock = false;
         else if (line === GO_TOOL_PATH) return true;
         continue;
      }
      if (/^tool\s*\($/.test(line)) {
         inBlock = true;
         continue;
      }
      if (line === `tool ${GO_TOOL_PATH}`) return true;
   }
   return false;
}

// --- the TOML dependency scan ---------------------------------------------

/**
 * Which fields of a TOML document declare a dependency. Deliberately not a TOML
 * parser: a field-specific, stateful line scan that tracks the current table,
 * triple-quoted string state, and the bracket depth of the one array it is
 * inspecting. Only the listed fields are inspected, so a description, a comment,
 * or an unrelated table cannot produce a false positive — and a false positive is
 * the expensive error here, because it suppresses the only offer the user gets.
 */
interface TomlFields {
   /** Tables whose `leji = …` / `"leji" = …` key declares the dependency. */
   keyTable(table: string): boolean;
   /** Table + key naming an array whose elements declare dependencies. */
   arrayField(table: string, key: string): boolean;
}

const PYPROJECT_FIELDS: TomlFields = {
   keyTable: (t) =>
      t === 'tool.poetry.dependencies' ||
      t === 'tool.poetry.dev-dependencies' ||
      t === 'tool.pdm.dev-dependencies' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(t),
   arrayField: (t, k) =>
      (t === 'project' && k === 'dependencies') ||
      t === 'project.optional-dependencies' ||
      t === 'dependency-groups' ||
      (t === 'tool.uv' && k === 'dev-dependencies') ||
      t === 'tool.pdm.dev-dependencies',
};

const PIPFILE_FIELDS: TomlFields = {
   keyTable: (t) => t === 'packages' || t === 'dev-packages',
   arrayField: () => false,
};

/** A requirement whose distribution name is exactly `leji`: the name, then the
 * end of the token or one of the characters that can follow a name in PEP 508 /
 * requirements syntax. */
const LEJI_REQUIREMENT_RE = /^leji($|[[=<>~!;,\s])/;

function tomlDeclaresLeji(text: string, fields: TomlFields): boolean {
   let table = '';
   let triple: string | null = null;
   let depth = 0;
   let inspecting = false;
   for (const line of splitLines(text)) {
      let i = 0;
      if (triple !== null) {
         const close = line.indexOf(triple);
         if (close < 0) continue;
         i = close + 3;
         triple = null;
      } else if (depth === 0) {
         const header = tomlTableHeader(line);
         if (header !== null) {
            table = header;
            continue;
         }
         const key = tomlKeyAt(line);
         if (key === null) continue;
         if (key.name === PY_DIST && fields.keyTable(table)) return true;
         inspecting = fields.arrayField(table, key.name);
         i = key.valueAt;
      }
      // One character scan carries the rest: strings (whose contents are the only
      // things that can match), bracket depth (which says whether we are inside the
      // inspected array), comments, and a triple quote that runs past this line.
      while (i < line.length) {
         const c = line[i];
         if (c === '#') break;
         if (c === '"' || c === "'") {
            const fence = c.repeat(3);
            if (line.startsWith(fence, i)) {
               const close = line.indexOf(fence, i + 3);
               if (close < 0) {
                  triple = fence;
                  break;
               }
               // A triple-quoted string is skipped ENTIRELY, on one line as across
               // several: the scanner has no TOML parser to tell a multi-line
               // dependency from prose that merely starts with the name, so the
               // conservative answer is the only safe one (a false positive
               // suppresses the offer; a false negative costs one redundant offer).
               i = close + 3;
               continue;
            }
            const s = tomlReadString(line, i, c);
            if (depth > 0 && inspecting && LEJI_REQUIREMENT_RE.test(s.text)) return true;
            i = s.end;
            continue;
         }
         if (c === '[') depth++;
         else if (c === ']' && depth > 0 && --depth === 0) inspecting = false;
         i++;
      }
   }
   return false;
}

/**
 * True when the document opens the given table, or any table under it: TOML
 * defines `tool.poetry` implicitly when a document writes only
 * `[tool.poetry.dependencies]`, and a manager's table is present either way. The
 * dot is what keeps `[tool.uvicorn]` from answering for `tool.uv`. Same header
 * rules as the dependency scan, including the multi-line-string state that keeps a
 * table name inside a description from counting.
 */
function tomlHasTable(text: string, table: string): boolean {
   let triple: string | null = null;
   for (const line of splitLines(text)) {
      if (triple !== null) {
         const close = line.indexOf(triple);
         if (close < 0) continue;
         triple = null;
         continue;
      }
      const header = tomlTableHeader(line);
      if (header !== null) {
         if (header === table || header.startsWith(`${table}.`)) return true;
         continue;
      }
      const opened = tomlOpensTriple(line);
      if (opened !== null) triple = opened;
   }
   return false;
}

/** The triple quote a line leaves open, or null. */
function tomlOpensTriple(line: string): string | null {
   let i = 0;
   let open: string | null = null;
   while (i < line.length) {
      const c = line[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
         const fence = c.repeat(3);
         if (line.startsWith(fence, i)) {
            const close = line.indexOf(fence, i + 3);
            if (close < 0) {
               open = fence;
               break;
            }
            i = close + 3;
            continue;
         }
         i = tomlReadString(line, i, c).end;
         continue;
      }
      i++;
   }
   return open;
}

/** `[table]` or `[[array-of-tables]]`, with inner whitespace removed. */
function tomlTableHeader(line: string): string | null {
   const arr = /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/.exec(line);
   if (arr) return arr[1].replace(/\s+/g, '');
   const one = /^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line);
   return one ? one[1].replace(/\s+/g, '') : null;
}

/** The key a line assigns to, bare or quoted, and where its value starts. */
function tomlKeyAt(line: string): { name: string; valueAt: number } | null {
   const m = /^\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*=\s*/.exec(line);
   if (!m) return null;
   return { name: m[1] ?? m[2] ?? m[3] ?? '', valueAt: m[0].length };
}

/** One single-line basic or literal string, from its opening quote. Escapes are
 * consumed, not decoded: only a `leji` prefix is ever tested against the result. */
function tomlReadString(line: string, start: number, quote: string): { text: string; end: number } {
   let text = '';
   let i = start + 1;
   while (i < line.length) {
      const c = line[i];
      if (quote === '"' && c === '\\') {
         text += line[i + 1] ?? '';
         i += 2;
         continue;
      }
      if (c === quote) return { text, end: i + 1 };
      text += c;
      i++;
   }
   return { text, end: line.length };
}

/** A `leji` requirement line in a requirements file: the name at the start of the
 * line, then end-of-line or a character that can follow a name. */
function requirementsDeclareLeji(text: string): boolean {
   for (const line of splitLines(text)) {
      if (/^leji($|[\s[=<>~!;,#])/.test(line)) return true;
   }
   return false;
}

function splitLines(text: string): string[] {
   return text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// --- the report -----------------------------------------------------------

/**
 * Detect the dependency ecosystems gated by files directly under `rootAbs`.
 * Reads; never writes, never runs anything, never walks up.
 */
export function detectEcosystem(rootAbs: string): EcosystemReport {
   const scan = new RootScan(path.resolve(rootAbs));
   const all: EcoResult[] = [];
   // Fixed order, so `all` reads the same in every report and in every SDK.
   if (scan.present(NODE_MANIFEST)) all.push(nodeResult(scan));
   const pythonGated = scan.present(PYPROJECT) || scan.present(PIPFILE) || scan.matching(REQUIREMENTS_RE).length > 0;
   if (pythonGated) all.push(pythonResult(scan));
   if (scan.present(GO_MANIFEST)) all.push(goResult(scan));

   if (all.length === 0) return { selected: null, all, reason: 'none' };
   if (all.length > 1) return { selected: null, all, reason: 'multiple-ecosystems' };
   const only = all[0];
   // A manager-less single ecosystem carries its own reason up: the report's
   // `reason` is never a second, independently derived verdict.
   if (only.status !== 'ok') return { selected: null, all, reason: only.status };
   return { selected: only, all, reason: null };
}

/** The runner argv for one manager name, or null when leji does not know it. One
 * runner table serves detection, the hook, and CI. */
export function managerRunnerArgv(manager: string): string[] | null {
   return MANAGER_COMMANDS[manager]?.runner ?? null;
}

/** The plain install argv for one manager name: what a joiner runs on a fresh clone
 * so the CLI the repository declares actually resolves. Null when leji does not know
 * the manager, or when the manager has no single install command. */
export function managerInstallArgv(manager: string): string[] | null {
   return MANAGER_COMMANDS[manager]?.install ?? null;
}

/** The argv a hook or CI job runs `leji` with: the detected manager's runner when
 * the repository actually declares the CLI, else the plain fallback on PATH. */
export function runnerArgv(report: EcosystemReport): string[] {
   const s = report.selected;
   return s !== null && s.directDeclared && s.runner !== null ? s.runner : PLAIN_RUNNER;
}

/** The always-printed human block: what was detected, and what to run to declare
 * the Leji CLI. Never a prompt, never a command run — the caller owns both. */
export function renderEcosystemBlock(report: EcosystemReport): string {
   return blockLines(report).join('\n');
}

function blockLines(report: EcosystemReport): string[] {
   if (report.reason === 'none') return TEXT.none;
   if (report.reason === 'multiple-ecosystems') {
      // A print-only ecosystem (pip, pre-1.24 Go) contributes no command here; the
      // lead sentence closes with a period rather than dangling a colon.
      const commands = report.all.flatMap(commandLines);
      return [
         TEXT.multiple(
            report.all.map((r) => r.manifest ?? r.ecosystem),
            commands.length > 0,
         ),
         ...commands,
      ];
   }
   const only = report.all[0];
   if (only.directDeclared && only.manifest !== null) return [TEXT.declared(only.manifest)];
   switch (only.status) {
      case 'refused-evidence':
         return [TEXT.refused(only.evidence)];
      case 'unreadable-manifest':
         return [TEXT.unreadable(only.manifest ?? '')];
      case 'unsupported-manager':
         return [TEXT.unsupported(only.manifest ?? '')];
      case 'ambiguous-manager':
         return [TEXT.ambiguous(only.manifest ?? '', only.evidence), ...commandLines(only)];
      default:
         return okLines(only);
   }
}

/** The offer for one ecosystem that chose a manager. A manager with no add
 * command prints its own guidance instead. */
function okLines(r: EcoResult): string[] {
   if (r.manager === 'pip') {
      return r.manifest === PYPROJECT ? TEXT.pipGroups(deciderFile(r)) : TEXT.pipRequirements(deciderFile(r));
   }
   if (r.manager === 'go-legacy') return TEXT.goLegacy(deciderFile(r));
   return [TEXT.offer(r.manager ?? '', deciderFile(r)), ...commandLines(r)];
}

/** The indented command line(s) for one result: its own add command, or one per
 * candidate when the evidence could not choose. */
function commandLines(r: EcoResult): string[] {
   if (r.add !== null) return [`${INDENT}${r.add.join(' ')}`];
   return r.candidates.filter((c) => c.add !== null).map((c) => `${INDENT}${(c.add as string[]).join(' ')}`);
}

/** The one file a message names as the evidence for the manager: the lockfile
 * that selected it, the pyproject that carried its tool table, or the manifest. */
function deciderFile(r: EcoResult): string {
   if (r.source === 'lockfile') {
      const lock = r.evidence.find(
         (f) =>
            NODE_LOCKS.some((l) => l.file === f && l.manager === r.manager) ||
            PY_LOCKS.some((l) => l.file === f && l.manager === r.manager && l.lock),
      );
      if (lock !== undefined) return lock;
   }
   if (r.source === 'tool-table') return PYPROJECT;
   if (r.ecosystem === 'python' && r.source === 'manifest') return PIPFILE;
   return r.manifest ?? '';
}

/** The one line `leji detect` prints about the ecosystem. */
export function renderEcosystemLine(report: EcosystemReport): string {
   if (report.reason === 'none') return TEXT.line.none;
   if (report.reason === 'multiple-ecosystems') {
      return TEXT.line.multiple(report.all.map((r) => r.manifest ?? r.ecosystem));
   }
   const only = report.all[0];
   switch (only.status) {
      case 'refused-evidence':
         return TEXT.line.refused(only.evidence);
      case 'unreadable-manifest':
         return TEXT.line.unreadable(only.manifest ?? '');
      case 'unsupported-manager':
         return TEXT.line.unsupported(only.manifest ?? '');
      case 'ambiguous-manager':
         return TEXT.line.ambiguous(only.manifest ?? '', only.evidence);
      default:
         return TEXT.line.selected(only.manager ?? '', deciderFile(only), only.directDeclared);
   }
}
