import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import {
   type CategoryId,
   type Manifest,
   bindAgentInManifestText,
   effectiveAgentProfilesPath,
   effectiveChangelogPath,
   effectiveIndexPath,
   loadManifest,
} from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import {
   chmodGuarded,
   guardRoot,
   isDir,
   isFile,
   joinUnderRoot,
   resolvedWithinRoot,
   stripSlash,
   toPosix,
   verifiedTargetRead,
   writeFileAtomicGuarded,
   writeFileGuarded,
} from '../lib/fsx.js';
import { type TargetVerdict, LEJI_DIR, WORK_REL } from '../lib/layout.js';
import { type PlanEntry, type PlannedWrite, buildWritePlan } from '../lib/writeplan.js';
import {
   type DetectedHost,
   HOST_SPECS,
   PORTABLE_ADAPTER,
   adapterContent,
   detectHosts,
   resolveHostId,
} from '../lib/detect.js';
import {
   type EcosystemReport,
   DEP_NAME,
   ECOSYSTEM_TEXT,
   detectEcosystem,
   managerRunnerArgv,
   renderEcosystemBlock,
   runnerArgv,
} from '../lib/ecosystem.js';
import { trackedUnder, workingTreeClean } from '../lib/git.js';
import { type Finding, hasErrors } from '../lib/findings.js';
import { KNOWN_VENDOR_FILES } from './validate.js';
import { writeIndex } from './indexgen.js';

/** Options for scaffolding a new context layer with `initLayer`. */
export interface InitOptions {
   dir: string;
   yes: boolean;
   name?: string;
   level?: 'core' | 'indexed';
   /** Compute and return the write plan without touching the filesystem. */
   dryRun?: boolean;
   /** The launchable host (id or alias) to hand the scaffold to; rejected when it
    * names none. */
   agent?: string;
   /** Working mode: `solo` scaffolds the identity and writing-style starters and
    * runs the owner-voice interview; omitted means `team` (today's behavior). */
   mode?: WorkingMode;
   /** Skip generating the portable `AGENTS.md` pointer (written by default when
    * absent; an existing file is never touched). */
   noAgents?: boolean;
}

/** The layer's working mode: a team of one (`solo`) or a team (`team`). */
export type WorkingMode = 'solo' | 'team';

const WORKING_MODES: readonly WorkingMode[] = ['solo', 'team'];

/** Validate a mode value from a direct SDK caller before any filesystem work. */
function assertMode(mode: string): WorkingMode {
   if (!(WORKING_MODES as readonly string[]).includes(mode)) {
      throw new Error(`--mode must be solo or team; got "${mode}"`);
   }
   return mode as WorkingMode;
}

export interface InitAnswers {
   name: string;
   description: string;
   rootPath: string;
   ownerName: string;
   ownerContact: string;
   categories: CategoryId[];
   level: 'core' | 'indexed';
   mode: WorkingMode;
   /** Resolved scaffold paths. Absent means the spec defaults under rootPath;
    * `adopt` fills this with collision-resolved alternates. */
   layout?: ScaffoldLayout;
}

/** The repository-relative paths the scaffolder writes. Defaults derive from
 * rootPath; `adopt` resolves each against the existing tree to avoid clobbering. */
export interface ScaffoldLayout {
   bootProfilePath: string;
   /** Directory holding the category index files, trailing slash. */
   contextDir: string;
   /** Agent-profiles directory, trailing slash. */
   agentsDir: string;
   indexPath: string;
   changelogPath: string;
}

/** The spec-default layout under a context root (no collision resolution). */
export function defaultLayout(rootPath: string): ScaffoldLayout {
   return {
      bootProfilePath: joinUnderRoot(rootPath, 'boot-profile.md'),
      contextDir: joinUnderRoot(rootPath, 'context/'),
      agentsDir: joinUnderRoot(rootPath, 'agents/'),
      indexPath: joinUnderRoot(rootPath, 'context-index.json'),
      changelogPath: joinUnderRoot(rootPath, 'context-changelog.json'),
   };
}

/**
 * True when NOTHING stands at `abs`, which is what makes a candidate name free.
 *
 * The ORIGINAL directory entry decides it, exactly as an exclusive create does:
 * `existsSync` follows symlinks, so a dangling link reads as a free name and the
 * write that follows lands at the link's missing destination. Any standing entry, a
 * dangling link included, is occupied.
 *
 * A name nothing stands at is free even when it resolves out of this tool's reach,
 * because the search is for an unused NAME, not a permission to write: every other
 * name under a context root symlinked out of the repository resolves out of reach
 * too, so refusing them one by one would never terminate. The write itself is judged
 * where it always is, at the chokepoint, which refuses that target as it has.
 */
function nothingStandsAt(abs: string): boolean {
   return fs.lstatSync(abs, { throwIfNoEntry: false }) === undefined;
}

/** Pick the first candidate name (under rootPath) that is free, so `adopt` never
 * writes its scaffold over a repo's existing content. Occupancy is decided on the
 * standing entry rather than by `exists`, so a dangling candidate link is occupied
 * and the next name is tried, exactly as an existing file has always been. */
function resolveScaffoldPath(root: string, rootPath: string, name: string, alternates: string[], dir: boolean): string {
   const free = (rel: string): boolean => nothingStandsAt(path.join(root, stripSlash(rel)));
   const suffix = dir ? '/' : '';
   for (const candidate of [name, ...alternates]) {
      const rel = joinUnderRoot(rootPath, candidate + suffix);
      if (free(rel)) return rel;
   }
   for (let n = 2; ; n++) {
      const rel = joinUnderRoot(rootPath, `${name}-${n}${suffix}`);
      if (free(rel)) return rel;
   }
}

/** Resolve a full scaffold layout against an existing repository: each default
 * path that collides with existing content falls back to a safe alternate. */
function resolveLayout(root: string, rootPath: string): ScaffoldLayout {
   return {
      bootProfilePath: resolveScaffoldPath(root, rootPath, 'boot-profile.md', ['leji-boot-profile.md'], false),
      contextDir: resolveScaffoldPath(root, rootPath, 'context', ['leji-context', 'context-layer'], true),
      agentsDir: resolveScaffoldPath(root, rootPath, 'agents', ['agent-profiles', 'leji-agents'], true),
      indexPath: resolveScaffoldPath(root, rootPath, 'context-index.json', ['leji-context-index.json'], false),
      changelogPath: resolveScaffoldPath(
         root,
         rootPath,
         'context-changelog.json',
         ['leji-context-changelog.json'],
         false,
      ),
   };
}

/** Result of `initLayer`: the files written and the manifest created. */
/**
 * Leji owns the generated index and regenerates it, so an existing one is
 * replaced rather than skipped. `buildWritePlan` classifies any existing path as
 * `skip-exists`, which would promise a file is left alone that `writeIndex` then
 * rewrites; this restates that one entry truthfully.
 */
function planWithIndexTruth(plan: PlanEntry[], indexRel: string): PlanEntry[] {
   return plan.map((e) =>
      e.rel === indexRel && e.status === 'skip-exists'
         ? { rel: e.rel, status: 'overwrite' as const, note: 'regenerated from the category index files' }
         : e,
   );
}

export interface InitResult {
   written: string[];
   manifest: Manifest;
   /** Index-generation findings. Errors mean no index was written, and the caller
    * reports them and fails, the same way `leji index` does. */
   findings: Finding[];
   /** The working mode the layer was scaffolded with. */
   mode: WorkingMode;
   /** The classified write plan (always populated; the only output under dryRun). */
   plan: PlanEntry[];
   dryRun: boolean;
   /** Coding-agent hosts detected for this repo, ranked; informs the handoff offer. */
   detected: DetectedHost[];
   /** Absolute layer root (resolved `options.dir`); the cwd for the handoff launch
    * and the MCP-install offer. */
   root: string;
}

function gitConfig(key: string): string | null {
   try {
      const out = execFileSync('git', ['config', '--get', key], {
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
   } catch {
      return null;
   }
}

function defaultAnswers(dir: string, options: InitOptions): InitAnswers {
   const base = path
      .basename(path.resolve(dir))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      // Runs are already collapsed above, so trim one dash per end; avoids the
      // polynomial-backtracking `-+$` (js/polynomial-redos).
      .replace(/^-|-$/g, '');
   return {
      name: options.name ?? `${base}-context`,
      description: 'Shared context layer for this repository.',
      rootPath: 'docs/',
      ownerName: gitConfig('user.name') ?? '<named owner>',
      ownerContact: gitConfig('user.email') ?? '',
      categories: ['domain', 'system', 'decisions'],
      level: options.level ?? 'core',
      mode: options.mode ? assertMode(options.mode) : 'team',
   };
}

/** Canonical category order for manifests and scaffolds. */
const CATEGORY_ORDER: readonly CategoryId[] = ['domain', 'system', 'practice', 'governance', 'decisions'];

/** Normalize a category set: `decisions` always; solo forces `domain` + `practice`;
 * the spec minimum (domain or system) holds; canonical order regardless of input. */
function normalizeCategories(categories: CategoryId[], mode: WorkingMode): CategoryId[] {
   const set = new Set<CategoryId>(categories);
   set.add('decisions');
   if (mode === 'solo') {
      set.add('domain');
      set.add('practice');
   }
   if (!set.has('domain') && !set.has('system')) set.add('domain');
   return CATEGORY_ORDER.filter((c) => set.has(c));
}

/** Queued line reader: buffers lines arriving with no question pending (piped
 * stdin delivers all at once), unlike readline/promises' question() which drops them. */
const EOF = Symbol('eof');

class LineReader {
   private lines: string[] = [];
   private waiters: ((line: string | typeof EOF) => void)[] = [];
   private closed = false;
   private rl: readline.Interface;

   constructor() {
      this.rl = readline.createInterface({ input: process.stdin });
      this.rl.on('line', (line) => {
         const waiter = this.waiters.shift();
         if (waiter) waiter(line);
         else this.lines.push(line);
      });
      this.rl.on('close', () => {
         this.closed = true;
         for (const waiter of this.waiters.splice(0)) waiter(EOF);
      });
   }

   /** Next input line, or EOF when stdin closed (Ctrl-D) with nothing buffered. */
   next(): Promise<string | typeof EOF> {
      if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
      if (this.closed) return Promise.resolve(EOF);
      return new Promise((resolve) => this.waiters.push(resolve));
   }

   close(): void {
      this.rl.close();
   }
}

async function prompt(options: InitOptions): Promise<InitAnswers> {
   const defaults = defaultAnswers(options.dir, options);
   if (options.yes) return defaults;

   const reader = new LineReader();
   const readLine = async (): Promise<string> => {
      const a = await reader.next();
      if (a === EOF) {
         throw new Error('init aborted: end of input before all questions were answered');
      }
      return a;
   };
   const ask = async (q: string, fallback: string): Promise<string> => {
      process.stdout.write(fallback ? `${q} (${fallback}): ` : `${q}: `);
      const a = (await readLine()).trim();
      return a || fallback;
   };
   const askYesNo = async (q: string, fallback: boolean): Promise<boolean> => {
      process.stdout.write(`${q} [${fallback ? 'Y/n' : 'y/N'}]: `);
      const a = (await readLine()).trim().toLowerCase();
      if (a === '') return fallback;
      return a === 'y' || a === 'yes';
   };

   try {
      const name = await ask('Layer name', defaults.name);
      const description = await ask('One-line description', defaults.description);
      let rootPath = (await ask('Context root', defaults.rootPath)).trim();
      // Repo-root layer is canonical "." (not "./", which the guard rejects, nor ""
      // which would become a hidden ".context/"); a subdir root gets a trailing slash.
      if (rootPath === '' || rootPath === '.' || rootPath === './') rootPath = '.';
      else if (!rootPath.endsWith('/')) rootPath += '/';
      const ownerName = await ask('Primary owner (name)', defaults.ownerName);
      const ownerContact = await ask('Primary owner (contact)', defaults.ownerContact);

      // The mode question is TTY-only so the piped-stdin protocol keeps its exact
      // line count; piped runs stay `team` and select solo via --mode solo.
      let mode = defaults.mode;
      if (!options.mode && process.stdin.isTTY) {
         const a = (await ask('Working mode (team/solo)', 'team')).toLowerCase();
         mode = a === 'solo' ? 'solo' : 'team';
      }

      const categories: CategoryId[] = [];
      if (mode === 'solo') {
         // Solo forces domain + practice (identity and writing-style live there);
         // system and governance stay the repository's call.
         categories.push('domain');
         if (await askYesNo('Map system (architecture, invariants)?', true)) categories.push('system');
         categories.push('practice');
         if (await askYesNo('Map governance (agent guardrails, operating rules)?', false))
            categories.push('governance');
      } else {
         if (await askYesNo('Map domain (business language, product semantics)?', true)) categories.push('domain');
         if (await askYesNo('Map system (architecture, invariants)?', true)) categories.push('system');
         if (await askYesNo('Map practice (conventions, proven patterns)?', false)) categories.push('practice');
         if (await askYesNo('Map governance (agent guardrails, operating rules)?', false))
            categories.push('governance');
      }
      categories.push('decisions');
      if (!categories.includes('domain') && !categories.includes('system')) {
         // The spec minimum: at least domain or system, plus decisions.
         categories.unshift('domain');
         console.log('At least domain or system is required; mapping domain.');
      }

      const indexed = await askYesNo('Claim the indexed level (adds the machine changelog)?', false);
      return {
         name,
         description,
         rootPath,
         ownerName,
         ownerContact,
         categories,
         level: indexed ? 'indexed' : 'core',
         mode,
      };
   } finally {
      reader.close();
   }
}

function readTemplate(name: string): string {
   return fs.readFileSync(path.join(templatesDir(), name), 'utf8');
}

/** Mirror of the manifest schema's relative-path rule (rejects absolute, `./`,
 * `..`, backslashes) so init refuses traversal before writing anything. */
const RELATIVE_PATH_RE = /^(?!\/)(?!\.\/)(?!.*(^|\/)\.\.(\/|$))(?!.*\\).*$/;

function assertRelativePath(rel: string): void {
   if (!RELATIVE_PATH_RE.test(rel)) {
      throw new Error(`refusing unsafe path "${rel}": must be repository-root-relative (no absolute, .., ./, or \\)`);
   }
}

/** Resolve `rel` under `root` and assert it stays within the resolved root. */
function safeResolve(rootAbs: string, rel: string): string {
   assertRelativePath(rel);
   const abs = path.resolve(rootAbs, rel);
   if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
      throw new Error(`refusing to write outside the target directory: "${rel}"`);
   }
   return abs;
}

/** Write a file this command owns, once: never over an existing one, and never
 * through a standing entry it cannot verify. The skip is decided by the verified
 * read rather than a pathname check, because `existsSync` follows symlinks — a
 * dangling link at the target reads as absent and the guarded write then lands at
 * the link's destination, a name this command never planned. Only `absent` is free;
 * a regular file is the never-overwrite skip; anything else standing there is the
 * escape refusal, with nothing written. */
function writeFileOnce(rootAbs: string, rel: string, content: string, written: string[]): void {
   const abs = safeResolve(rootAbs, rel);
   const rootReal = guardRoot(rootAbs);
   const standing = verifiedTargetRead(rootReal, abs, initRole(rel));
   if (standing.status === 'regular') return;
   if (standing.status === 'refused') {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
   guardedOrRefuse(rel, writeFileGuarded(rootReal, abs, initRole(rel), content));
   written.push(rel);
}

/** The `.leji/` role an init or adopt write legitimately lands in: the transient
 * onboarding workspace is the tool's own `work` role, and everything else these
 * commands write is user content with no `.leji/` role at all. */
function initRole(rel: string): string | null {
   return rel === WORK_REL || rel.startsWith(`${WORK_REL}/`) ? WORK_REL : null;
}

/** Every init/adopt write goes through the chokepoint, and a refused verdict is the
 * one error this command has always raised for an escaping target: the layer is
 * scaffolded inside the repository it was pointed at, or not at all. */
function guardedOrRefuse(rel: string, verdict: TargetVerdict): void {
   if (!verdict.ok) {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
}

/**
 * The present vendor entrypoints and their VERIFIED bytes, read once. The same bytes
 * decide whether an entrypoint is converted, are archived under `governance/`, and
 * are compared for the draft report, so no act rests on a second read by pathname of
 * a file this command then rewrites. An entry that cannot be verified as a regular
 * file inside the repository is treated as absent, exactly as an escaping symlink
 * already was.
 */
function verifiedVendorFiles(root: string): Map<string, string> {
   const rootReal = guardRoot(root);
   const present = new Map<string, string>();
   for (const rel of KNOWN_VENDOR_FILES) {
      const read = verifiedTargetRead(rootReal, path.join(root, rel), null);
      if (read.status === 'regular') present.set(rel, read.bytes.toString('utf8'));
   }
   return present;
}

/**
 * Read a file this command is about to merge and rewrite, through the verified read
 * rather than by pathname: the bytes that decide the merge come from the descriptor
 * the rule cleared, so the file that was judged is the file that is read and then
 * written. Null when nothing stands there (the create path); a standing entry that
 * cannot be verified as a regular file inside the repository is the same refusal a
 * write to it would be.
 */
function readMergeSource(rootReal: string, abs: string, rel: string): string | null {
   const read = verifiedTargetRead(rootReal, abs, initRole(rel));
   if (read.status === 'refused') {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
   return read.status === 'regular' ? read.bytes.toString('utf8') : null;
}

/** Ensure the root .gitignore ignores `.leji/` — the one line that covers every
 * role of the unified tree (chrome, export output, onboarding workspace, mounts)
 * and any role added later. Idempotent and matches the exact line, so a comment or
 * `docs/.leji/` is not treated as equivalent. */
function ensureLejiGitignored(rootAbs: string): void {
   const abs = path.join(rootAbs, '.gitignore');
   const entry = `${LEJI_DIR}/`;
   const rootReal = guardRoot(rootAbs);
   const text = readMergeSource(rootReal, abs, '.gitignore') ?? '';
   if (text.split('\n').includes(entry)) return;
   const next = text === '' ? entry + '\n' : text + (text.endsWith('\n') ? '' : '\n') + entry + '\n';
   guardedOrRefuse('.gitignore', writeFileGuarded(rootReal, abs, null, next));
}

/** Refuse to write the transient onboarding workspace while any file under the
 * root `.leji/` is tracked by git: tracked means the ignore boundary is not
 * intact, and private artifacts could land in history. The fix is the owner's
 * call (git rm --cached), never run silently. */
function assertLejiWorkspacePrivate(root: string): void {
   const tracked = trackedUnder(root, LEJI_DIR);
   if (tracked && tracked.length > 0) {
      throw new Error(
         `${tracked.length} file(s) under ${LEJI_DIR}/ are tracked by git; untrack them (git rm --cached) so onboarding artifacts stay private`,
      );
   }
}

/** Create leji.json with O_EXCL (`wx`) so check-then-write is atomic: a concurrent
 * run or a planted symlink can't be overwritten or followed. EEXIST surfaces as the
 * same "already exists" error as the entry point's initial guard. */
function writeManifestExclusive(rootAbs: string, abs: string, content: string, mode: 'init' | 'adopt'): void {
   const verdict = writeFileGuarded(guardRoot(rootAbs), abs, null, content, { exclusive: true });
   if (verdict.exists === true) {
      throw new Error(
         mode === 'adopt'
            ? 'leji.json already exists here; this repository already has a Leji layer'
            : 'leji.json already exists here; init refuses to overwrite an existing layer',
      );
   }
   guardedOrRefuse('leji.json', verdict);
}

const CATEGORY_STUBS: Record<string, { file: string; title: string; summary: string; body: string }> = {
   domain: {
      file: 'glossary.md',
      title: 'Glossary',
      summary: 'What the core terms of this product mean, in our own words.',
      body: '- TODO: define a core term in your own words, including what it does not mean.\n',
   },
   system: {
      file: 'invariants.md',
      title: 'System Invariants',
      summary: 'The constraints every change lives with.',
      body: '- TODO: state an invariant every change must respect (e.g. money values are integer minor units).\n',
   },
   practice: {
      file: 'conventions.md',
      title: 'Conventions',
      summary: 'Conventions and patterns applied automatically.',
      body: '- TODO: record a convention that has proven out at least twice (the proven-twice gate).\n',
   },
   governance: {
      file: 'operating-rules.md',
      title: 'Operating Rules',
      summary: 'What agents may do unprompted and what needs a human gate.',
      body: '- TODO: list what an agent may do without asking.\n- TODO: list what requires a human gate.\n',
   },
};

function categoryStub(title: string, summary: string, body: string): string {
   return `---\nsummary: ${summary}\n---\n\n# ${title}\n\n${body}`;
}

/** Solo-mode starters: owner identity (domain) and writing style (practice),
 * scaffolded from canonical templates so the interview has real homes to fill. */
const SOLO_STARTERS: readonly { category: CategoryId; file: string; template: string }[] = [
   { category: 'domain', file: 'identity.md', template: 'identity.md' },
   { category: 'practice', file: 'writing-style.md', template: 'writing-style.md' },
];

// Titles double as the viewer's group labels (the sidebar groups by index-file
// H1), so they carry the category emoji the sidebar used to add itself.
const CATEGORY_INDEX_TITLES: Record<string, string> = {
   domain: '📖 Domain',
   system: '⚙️ System',
   practice: '🛠️ Practice',
   governance: '🛡️ Governance',
   decisions: '🧭 Decisions',
};

/** A stub category index file: a `leji-index` block declaring the category's
 * source directory as governed content. */
function categoryIndexFile(rootPath: string, category: string): string {
   const title = CATEGORY_INDEX_TITLES[category] ?? category;
   return (
      `# ${title}\n\n` +
      `This index lists the ${category} content of the layer. Content lives where it sits; ` +
      `this file declares what counts as ${category} context.\n\n` +
      '```leji-index\n' +
      `- path: ${joinUnderRoot(rootPath, category + '/')}\n` +
      '```\n'
   );
}

function buildManifest(answers: InitAnswers): Manifest {
   const r = answers.rootPath;
   const layout = answers.layout ?? defaultLayout(r);
   const manifest: Manifest = {
      $schema: 'https://leji.org/schemas/v1.0/context-manifest.schema.json',
      leji: '1.0',
      name: answers.name,
      description: answers.description,
      rootPath: r,
      bootProfilePath: layout.bootProfilePath,
      categories: {},
      owners: {
         primary: answers.ownerContact
            ? { name: answers.ownerName, contact: answers.ownerContact }
            : { name: answers.ownerName },
      },
      conformance: {
         claimedLevel: answers.level,
         claimedAt: new Date().toISOString().slice(0, 10),
      },
   };
   // Emit a machine block only for paths differing from their spec default (a
   // collision-resolved alternate from `adopt`); otherwise the manifest stays
   // minimal and resolvers find files at the defaults.
   const def = defaultLayout(r);
   const machine: NonNullable<Manifest['machine']> = {};
   if (layout.indexPath !== def.indexPath) machine.indexPath = layout.indexPath;
   if (layout.changelogPath !== def.changelogPath) machine.changelogPath = layout.changelogPath;
   if (layout.agentsDir !== def.agentsDir) machine.agentProfilesPath = layout.agentsDir;
   if (Object.keys(machine).length > 0) manifest.machine = machine;
   for (const category of answers.categories) {
      manifest.categories[category] = { indexes: [`${layout.contextDir}${category}.md`] };
   }
   return manifest;
}

function buildBootProfile(answers: InitAnswers): string {
   let text = readTemplate('boot-profile.md');
   text = text.replace(
      '<One paragraph: what this repository/product is, who it serves, what stage it is at.>',
      answers.description,
   );
   const r = answers.rootPath;

   // Rewrite the template's docs/ prefixes for the chosen root (joinUnderRoot('.', '')
   // is '', so a "." root yields context-index.json, not .context-index.json).
   text = text.replaceAll('docs/', joinUnderRoot(r, ''));

   if (answers.level === 'core') {
      // The index ships at every level, so its routing sentence and its regenerate
      // duty both stay: a core scaffold that denied the index would leave the
      // adopter no instruction for the `leji index --check` gate `leji ci` writes.
      // Only the changelog line goes, since the changelog is an `indexed` artifact.
      text = text.replace(/- Append an entry to `[^`]*context-changelog\.json`[^\n]*\n/, '');
   }
   if (answers.mode === 'solo') {
      // Route identity and writing work to the solo starters. Inserted after the
      // root rewrite (the routes carry final paths); one placeholder line stays
      // for the task types the onboarding discovers.
      const identityRoute = `- identity, positioning, or public claims → \`${joinUnderRoot(r, 'domain/')}identity.md\``;
      const styleRoute = `- writing or outward-facing communication → \`${joinUnderRoot(r, 'practice/')}writing-style.md\``;
      text = text.replace(
         '- <task type> → <paths or category>\n- <task type> → <paths or category>\n',
         `${identityRoute}\n${styleRoute}\n- <task type> → <paths or category>\n`,
      );
   }
   return text;
}

function buildCoreProfile(answers: InitAnswers): string {
   let text = readTemplate(path.join('agents', 'core.md'));
   text = text.replaceAll('docs/', joinUnderRoot(answers.rootPath, ''));
   // The escalation line names a person, so the scaffold fills it: a profile that
   // shipped `<ownerName>` would be the placeholder the lint exists to catch.
   text = text.replaceAll('<ownerName>', answers.ownerName);
   if (!answers.categories.includes('governance')) {
      text = text.replace(/^ {2}- .*governance\/\n/m, `  - ${joinUnderRoot(answers.rootPath, 'decisions/')}\n`);
   }
   return text;
}

function buildFirstDecision(answers: InitAnswers): string {
   const today = new Date().toISOString().slice(0, 10);
   const indexedLine =
      // Deliberately does NOT list the generated index. The scaffold writes one at
      // every level so its output is ready for generated CI, but the index is a
      // requirement of `indexed`, not of `core`; naming it here would present it as
      // part of the level the record says was chosen.
      answers.level === 'indexed'
         ? 'manifest, boot profile, category content, decision records, generated index, machine changelog'
         : 'manifest, boot profile, category content, decision records';
   return `---
id: adopt-leji
title: Adopt the Leji context layer
status: accepted
date: ${today}
deciders:
  - ${answers.ownerName}
---

# Adopt the Leji context layer

## Context

This repository takes a shared, versioned context layer: one record of how it works, kept in the repository and read by people and agents alike.

## Decision

Adopt Leji at the \`${answers.level}\` level: ${indexedLine}.

## Consequences

Context changes ride the same review gate as the work that surfaces them, and ${answers.ownerName} owns the layer. Agent entrypoints point at the context layer rather than carrying their own copy: the portable \`AGENTS.md\` pointer where the scaffold writes one, and vendor entrypoints only where \`leji adopt --wire-adapters\` converts them with your consent.
`;
}

function buildChangelog(answers: InitAnswers, written: string[]): string {
   const today = new Date().toISOString().slice(0, 10);
   const changelog = {
      $schema: 'https://leji.org/schemas/v1.0/context-changelog.schema.json',
      schemaVersion: '1.0',
      entries: [
         {
            id: 'seed-layer',
            date: today,
            type: 'added',
            summary: 'Seeded the context layer with leji init.',
            paths: written,
            proposedBy: 'leji init',
            approvedBy: answers.ownerName,
         },
      ],
   };
   return JSON.stringify(changelog, null, 2) + '\n';
}

/** The transient onboarding brief, rewritten for the chosen root (joinUnderRoot('.', '')
 * is '', so a "." root yields `context/...`, not `.context/`) and stamped with the
 * working mode so the agent runs the right interview without re-asking. The
 * workspace paths it names are root-relative already and need no rewriting. */
function buildBrief(answers: InitAnswers): string {
   return readTemplate('onboarding-brief.md')
      .replaceAll('<root>/', joinUnderRoot(answers.rootPath, ''))
      .replaceAll('<mode>', answers.mode);
}

/** Path of the transient onboarding brief: the workspace role of the unified root
 * `.leji/`, under a dot-directory so it is excluded from the index, the viewer, and
 * the changelog. Root-relative whatever rootPath is. */
export const BRIEF_PATH = `${WORK_REL}/onboarding-brief.md`;

/** The CI workflow path, relative to the repository root. */
export const CI_WORKFLOW_PATH = '.github/workflows/leji.yml';
export const GITLAB_CI_PATH = '.gitlab-ci.yml';
export const CIRCLECI_CONFIG_PATH = '.circleci/config.yml';
export const AZURE_PIPELINE_PATH = '.azure-pipelines/leji.yml';

const GITLAB_MARKER_START = '# >>> leji ci (managed) >>>';
const GITLAB_MARKER_END = '# <<< leji ci (managed) <<<';

// Azure Pipelines does not auto-discover a YAML file (unlike the other three), so
// the file is written but the pipeline still has to be created in Azure DevOps.
const AZURE_ACTIVATION_NOTE =
   'Azure Pipelines does not auto-run this file. Create a pipeline that points at it (e.g. `az pipelines create --yml-path .azure-pipelines/leji.yml`), and on Azure Repos add a build-validation branch policy on main for pull-request checks.';

/** Result of `ensureLocalHook`: created/updated our managed hook, left an
 * unmanaged hook untouched (manual, with the snippet to add), or unchanged.
 * `managed` says whether the writer owns a standalone hook file (`.git/hooks` or
 * a custom core.hooksPath dir) or a marker-delimited block inside a husky hook. */
export interface HookResult {
   path: string;
   action: CiAction;
   snippet?: string;
   managed: 'file' | 'block';
   /** Why a `manual` result was returned: an existing unmanaged hook (`foreign-hook`)
    * or a hooks dir resolving outside the repository (`outside-root`). Unset otherwise. */
   reason?: 'foreign-hook' | 'outside-root';
}

const HOOK_MARKER = '# leji pre-commit (managed)';

/**
 * One argv element, quoted for `sh`. Single quotes take everything literally, and
 * an embedded quote is closed, escaped, and reopened (`'\''`) — the one escape a
 * POSIX shell accepts inside them. The runner comes from the repository's own
 * package manager, so it is never interpolated raw into generated shell.
 */
export function shQuote(word: string): string {
   return `'${word.split("'").join(`'\\''`)}'`;
}

/** The runner argv as one quoted command prefix: `'pnpm' 'exec' 'leji'`. */
function shCommand(runner: string[]): string {
   return runner.map(shQuote).join(' ');
}

// The failure message is single-quoted for the SHELL, not just for this template
// literal: the backticks around `leji index` are literal text, and inside a
// double-quoted echo sh would run them as a command substitution (regenerating the
// index the hook just refused a commit over). Never emit an unquoted backtick,
// `$(`, or `$VAR` into generated shell unless expansion is the intent.
const HOOK_GATES = (runner: string[]): string => {
   const leji = shCommand(runner);
   return `${leji} validate || exit 1
${leji} index --check || {
   echo 'leji: stored index is stale; run \`leji index\` and stage the result.' >&2
   exit 1
}
`;
};

/** The standalone managed pre-commit hook, running the repository's own runner. */
export function HOOK_BODY(runner: string[]): string {
   return `#!/bin/sh
${HOOK_MARKER}
# Validate the context layer and refuse a commit that would leave the stored
# index stale. Local mirror of the CI gate; delete this file to opt out.
${HOOK_GATES(runner)}`;
}

const HUSKY_MARKER_START = '# >>> leji hooks (managed) >>>';
const HUSKY_MARKER_END = '# <<< leji hooks (managed) <<<';

/** The same two gates HOOK_BODY runs, wrapped in markers so the block can be
 * merged into a husky repo's hand-authored `.husky/pre-commit` without touching
 * its rest. */
export function HUSKY_BLOCK(runner: string[]): string {
   return `${HUSKY_MARKER_START}
${HOOK_GATES(runner)}${HUSKY_MARKER_END}
`;
}

/** The configured `core.hooksPath` for the repo at `root`, or null when unset. Run
 * from the repo root (git -C) so local, global, and system scopes resolve; an argv
 * array, never a shell string. Used ONLY to decide husky-shape; the write location
 * comes from `gitHooksDir`. */
function hooksPathConfig(root: string): string | null {
   try {
      const out = execFileSync('git', ['-C', root, 'config', 'core.hooksPath'], {
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
   } catch {
      return null;
   }
}

/** The effective hooks directory git would run, resolved absolute against `rootAbs`.
 * `git rev-parse --git-path hooks` is authoritative: it honors core.hooksPath scoping
 * and tilde expansion (`~/hooks` → `$HOME/hooks`), and works in linked worktrees where
 * `.git` is a file. A failure or empty output means this is not a git repository. */
function gitHooksDir(rootAbs: string): string | null {
   try {
      const out = execFileSync('git', ['-C', rootAbs, 'rev-parse', '--git-path', 'hooks'], {
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out === '' ? null : path.resolve(rootAbs, out);
   } catch {
      return null;
   }
}

/** Git's own directories for the repo at `rootAbs`, resolved absolute: this working
 * tree's git dir and the common dir it shares with every linked worktree. Both are
 * read-only queries, and together they are what decides whether a hook target is
 * clone-local (personal) rather than committed (shared). Null when this is not a git
 * repository. */
function gitDirs(rootAbs: string): { gitDir: string; commonDir: string } | null {
   try {
      const out = execFileSync('git', ['-C', rootAbs, 'rev-parse', '--git-dir', '--git-common-dir'], {
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lines = out
         .split('\n')
         .map((l) => l.trim())
         .filter((l) => l !== '');
      if (lines.length < 2) return null;
      return { gitDir: path.resolve(rootAbs, lines[0]), commonDir: path.resolve(rootAbs, lines[1]) };
   } catch {
      return null;
   }
}

/** Husky shape of the configured hooks path: `underscore` for husky v9 (`.husky/_`),
 * `direct` for husky v8 (`.husky`), or null when not husky-shaped or unset. Decides
 * block-vs-file routing and (with the resolved hooks dir) the `.husky/pre-commit`
 * user-file target. */
function huskyShape(rootAbs: string, hooksPath: string | null): 'underscore' | 'direct' | null {
   if (hooksPath === null) return null;
   const resolved = stripSlash(path.resolve(rootAbs, hooksPath));
   const base = path.basename(resolved);
   if (base === '_' && path.basename(path.dirname(resolved)) === '.husky') return 'underscore';
   if (base === '.husky') return 'direct';
   return null;
}

/**
 * Who owns the pre-commit hook this repository would get, decided by where the write
 * would actually land rather than by the mechanism that would perform it:
 * `personal` under git's own directories AND inside this working tree (`.git/hooks`,
 * a `core.hooksPath` resolving inside them) — per clone, never committed, and safe to
 * write; `shared` inside the working tree but not under git's directories (husky, a
 * `githooks/` hooks path) — committed, so a maintainer's call; `outside-root` under
 * git's directories but OUTSIDE this working tree (a linked worktree, whose hooks
 * live in the common git directory) — per clone, but the writer refuses to write
 * outside the repository root, so it is reported; `external` anywhere else (a global
 * or `$HOME` hooks path, a symlink escaping the repository) — reported, never
 * written; `no-git` when there is no repository to hang a hook on.
 */
export type HookOwnership = 'personal' | 'shared' | 'outside-root' | 'external' | 'no-git';

/** What stands at that target: leji's own managed hook or block, nothing at all, or
 * a hook this tool did not write. */
export type HookState = 'current' | 'absent' | 'foreign';

/** The read-only answer `leji start` reports and `ensureLocalHook` would act on. */
export interface HookStatus {
   ownership: HookOwnership;
   state: HookState;
   /** The target, repository-relative when it lies inside the repository, else the
    * absolute path git resolved; empty when there is no repository. */
   path: string;
   managed: 'file' | 'block';
   /** What a person adds by hand where leji must not write. */
   snippet: string;
}

/** The hook file's text, or null when nothing readable stands there. Read-only: this
 * answers a question, and every write still goes through `ensureLocalHook`. */
function hookText(abs: string): string | null {
   try {
      if (!fs.statSync(abs).isFile()) return null;
      return fs.readFileSync(abs, 'utf8');
   } catch {
      return null;
   }
}

/**
 * `ensureLocalHook`'s resolve step, without the write: where the managed pre-commit
 * hook would go for this repository, who owns that location, and what stands there
 * now. The whole point is that a report can be produced without touching anything —
 * `leji start` prints it, and only a consented repair goes on to `ensureLocalHook`.
 */
export function hookStatus(root: string, runner?: string[]): HookStatus {
   const rootAbs = path.resolve(root);
   const argv = runner ?? runnerArgv(detectEcosystem(rootAbs));
   const hooksDir = gitHooksDir(rootAbs);
   const dirs = gitDirs(rootAbs);
   if (hooksDir === null || dirs === null) {
      return { ownership: 'no-git', state: 'absent', path: '', managed: 'file', snippet: HOOK_BODY(argv) };
   }
   const shape = huskyShape(rootAbs, hooksPathConfig(rootAbs));
   const target =
      shape === 'underscore' ? path.join(path.dirname(hooksDir), 'pre-commit') : path.join(hooksDir, 'pre-commit');
   const managed: 'file' | 'block' = shape ? 'block' : 'file';
   // Git's directories are tested FIRST: an ordinary `.git/hooks` also lies inside the
   // working tree, and it is per-clone state, not something a commit can carry. A
   // clone-local target that nonetheless falls outside this working tree (a linked
   // worktree's shared hooks directory) is reported rather than offered: the writer
   // refuses everything outside the repository root, so offering it would promise a
   // write that cannot happen.
   const inRepo = resolvedWithinRoot(rootAbs, target);
   const cloneLocal = resolvedWithinRoot(dirs.gitDir, target) || resolvedWithinRoot(dirs.commonDir, target);
   const ownership: HookOwnership = cloneLocal
      ? inRepo
         ? 'personal'
         : 'outside-root'
      : inRepo
        ? 'shared'
        : 'external';
   const existing = hookText(target);
   const marker = managed === 'block' ? HUSKY_MARKER_START : HOOK_MARKER;
   const state: HookState = existing === null ? 'absent' : existing.includes(marker) ? 'current' : 'foreign';
   return {
      ownership,
      state,
      path: inRepo ? toPosix(path.relative(rootAbs, target)) : toPosix(target),
      managed,
      snippet: managed === 'block' ? HUSKY_BLOCK(argv) : HOOK_BODY(argv),
   };
}

/** Write a managed pre-commit hook running the same checks CI runs, so drift is
 * caught before a commit instead of at the pipeline. The write location is git's
 * effective hooks dir (`rev-parse --git-path hooks`); core.hooksPath decides whether
 * a husky repo gets a managed block in the user-editable `.husky/pre-commit` (v8/v9)
 * or a standalone managed hook is written. A hooks dir resolving outside the repo (a
 * global `core.hooksPath`) is never written — the snippet comes back for a manual
 * hand-add, as does an existing unmanaged hook. */
export function ensureLocalHook(root: string, runner?: string[]): HookResult {
   const rootAbs = path.resolve(root);
   const hooksDir = gitHooksDir(rootAbs);
   if (hooksDir === null) throw new Error('not a git repository (no .git directory); hooks need one');
   // The hook runs what a clean install of THIS repository provides: the detected
   // manager's runner when the CLI is actually declared, else the plain binary on
   // PATH. Injectable so a test pins a runner without planting a manifest.
   const argv = runner ?? runnerArgv(detectEcosystem(rootAbs));
   const shape = huskyShape(rootAbs, hooksPathConfig(rootAbs));
   // Husky's user-editable hook is `.husky/pre-commit`: the hooks dir itself for v8
   // (`.husky`), its parent for v9 (`.husky/_`). Only a direct v8 hook is run by git
   // itself, so only it must stay executable.
   const target =
      shape === 'underscore' ? path.join(path.dirname(hooksDir), 'pre-commit') : path.join(hooksDir, 'pre-commit');
   if (!resolvedWithinRoot(rootAbs, target)) {
      // Never write outside the repository; report the computed target for a hand-add.
      return {
         path: toPosix(target),
         action: 'manual',
         snippet: shape ? HUSKY_BLOCK(argv) : HOOK_BODY(argv),
         managed: shape ? 'block' : 'file',
         reason: 'outside-root',
      };
   }
   const rel = toPosix(path.relative(rootAbs, target));
   // The hook is written through the chokepoint, judged on the resolved path at the
   // act; a target that stopped resolving inside the repository between the check
   // above and the write comes back as the same hand-add result that check returns.
   const manual = (managed: 'file' | 'block'): HookResult => ({
      path: toPosix(target),
      action: 'manual',
      snippet: managed === 'block' ? HUSKY_BLOCK(argv) : HOOK_BODY(argv),
      managed,
      reason: 'outside-root',
   });
   const guardRootAbs = guardRoot(rootAbs);
   return shape
      ? ensureHuskyBlock(guardRootAbs, target, rel, shape === 'direct', manual, argv)
      : ensureHookFile(guardRootAbs, target, rel, manual, argv);
}

/** Write/refresh the standalone managed pre-commit hook at `hookAbs`. Ours (marker
 * present) is created/updated; an existing unmanaged hook is never touched and its
 * replacement snippet comes back for a manual merge. */
function ensureHookFile(
   rootAbs: string,
   hookAbs: string,
   rel: string,
   manual: (managed: 'file' | 'block') => HookResult,
   runner: string[],
): HookResult {
   const body = HOOK_BODY(runner);
   // The hook's own bytes decide whether it is ours to rewrite, so they come from the
   // verified read: an entry standing at the hook path that cannot be verified as a
   // regular file inside the repository is reported for a hand-add, never merged.
   const hookRead = verifiedTargetRead(rootAbs, hookAbs, null);
   if (hookRead.status === 'refused') return manual('file');
   const existing = hookRead.status === 'regular' ? hookRead.bytes.toString('utf8') : null;
   if (existing !== null && !existing.includes(HOOK_MARKER)) {
      return { path: rel, action: 'manual', snippet: body, managed: 'file', reason: 'foreign-hook' };
   }
   if (existing === body) {
      // Byte-current. A standalone hook is run by git itself, so a non-executable
      // file is a mode-only correction reported updated, not unchanged.
      if (!isExecutable(hookAbs)) {
         if (!chmodGuarded(rootAbs, hookAbs, null, 0o755).ok) return manual('file');
         return { path: rel, action: 'updated', managed: 'file' };
      }
      return { path: rel, action: 'unchanged', managed: 'file' };
   }
   if (!writeFileGuarded(rootAbs, hookAbs, null, body, { mode: 0o755 }).ok) return manual('file');
   return { path: rel, action: existing === null ? 'created' : 'updated', managed: 'file' };
}

/** Merge the managed block into a husky hook file at `hookAbs`, following the
 * GitLab managed-block rules: replace an existing block in place (unchanged if
 * byte-identical), append it after one blank line to a file without it, or create
 * the file as `#!/bin/sh` + block (mode 0755) when absent. The rest of a
 * user-authored husky hook is left untouched. `requireExec` (a direct `.husky` hook
 * git runs itself) forces mode 0755: a byte-current but non-executable file is a
 * mode-only correction reported `updated`. */
function ensureHuskyBlock(
   rootAbs: string,
   hookAbs: string,
   rel: string,
   requireExec: boolean,
   manual: (managed: 'file' | 'block') => HookResult,
   runner: string[],
): HookResult {
   const block = HUSKY_BLOCK(runner);
   // The user's own hook is merged, so its bytes come from the verified read: what the
   // merge judged is what the rewrite is based on.
   const hookRead = verifiedTargetRead(rootAbs, hookAbs, null);
   if (hookRead.status === 'refused') return manual('block');
   const existing = hookRead.status === 'regular' ? hookRead.bytes.toString('utf8') : null;
   if (existing === null) {
      if (!writeFileGuarded(rootAbs, hookAbs, null, `#!/bin/sh\n${block}`, { mode: 0o755 }).ok) {
         return manual('block');
      }
      return { path: rel, action: 'created', managed: 'block' };
   }
   const merged = mergeManagedBlock(existing, block, HUSKY_MARKER_START, HUSKY_MARKER_END);
   if (merged !== existing) {
      if (!writeFileGuarded(rootAbs, hookAbs, null, merged).ok) return manual('block');
      if (requireExec && !chmodGuarded(rootAbs, hookAbs, null, 0o755).ok) return manual('block');
      return { path: rel, action: 'updated', managed: 'block' };
   }
   if (requireExec && !isExecutable(hookAbs)) {
      if (!chmodGuarded(rootAbs, hookAbs, null, 0o755).ok) return manual('block');
      return { path: rel, action: 'updated', managed: 'block' };
   }
   return { path: rel, action: 'unchanged', managed: 'block' };
}

/** True when `abs` has any executable bit set. */
function isExecutable(abs: string): boolean {
   try {
      return (fs.statSync(abs).mode & 0o111) !== 0;
   } catch {
      return false;
   }
}

export type CiProvider = 'github' | 'gitlab' | 'circleci' | 'azure';

/** Infer the CI provider from a git remote URL: github.com hosts GitHub Actions,
 * any gitlab host (gitlab.com or self-managed) GitLab CI, Azure DevOps hosts
 * Azure Pipelines. Returns null when the remote names none of them (CircleCI is
 * not remote-inferable). */
export function ciProviderFromRemote(url: string | null): CiProvider | null {
   if (!url) return null;
   const u = url.toLowerCase();
   if (u.includes('github.com')) return 'github';
   if (u.includes('gitlab')) return 'gitlab';
   if (u.includes('dev.azure.com') || u.includes('visualstudio.com')) return 'azure';
   return null;
}
export type CiAction = 'created' | 'updated' | 'unchanged' | 'manual';
export interface CiResult {
   provider: CiProvider;
   path: string;
   action: CiAction;
   snippet?: string;
   note?: string;
}

/**
 * Digests of every whole file this generator has ever written, so a file leji
 * created in an EARLIER release is still recognized as its own and upgraded rather
 * than abandoned. Appended at each release; the marker line carries the generator
 * version that wrote a file, and these digests carry the ones that predate it.
 *
 * Keyed by provider, and consulted only for the provider whose path is being
 * written: the same bytes are leji's workflow at `.github/workflows/leji.yml` and
 * somebody else's file at `.azure-pipelines/leji.yml`.
 *
 * Seeded with the pre-1.4 (1.3.x) variants, which carry no marker at all: two per
 * whole-file provider, the local-install job and the `npx @leji-org/leji@1`
 * fallback. Each release since appends its own twelve at pre-flight, enumerated by
 * `ciVariants()` and printed by a test (`LEJI_PRINT_CI_DIGESTS=1`), so the next
 * release still recognizes them; while a release is current its variants are also
 * compared by bytes, which is strictly stronger.
 */
const KNOWN_GENERATED: Record<CiProvider, readonly string[]> = {
   // 1.3.x GitHub Actions: local install, then the npx fallback.
   github: [
      'ef38ea0bc0daa13b9856ca9abeb5f2229ae2465aeed2f61bd94f557a1806f13d',
      '1c2afeb4d3043f94823ac0c1a254a8735c0fe87844cd454cf8ae07fbfa6588d4',
      // 1.4.0: the twelve job variants, in ciVariants() order.
      '616638c5c1594e8faeb38cd476b9c5e0a4d12889a01b54076a0f8ffceba8a1a8', // npm-local
      '1b9afce2109d75c86ba3e3b33abd2466d55509d7e46b5ef79a9407d3df566154', // pnpm-local
      'e16f877d33a5be6e2c720112692167e9442fb5c63a2335f95401b7a891d46e18', // yarn-local
      'e0819c85b4b3e540472fa5d2a3820ae0c4837a41b66cc97de84581c1b19ede96', // bun-local
      '7b3d400ea23799ebf26541bffe059db4e9f60021fdf0f783c1f1cfa7a532816d', // uv-local
      '87089be204a85a61dfcfbcb9f4a9f2ad2f5afc8b00f384d52dfbd81c63e0296f', // poetry-local
      '48b3c7a1751b65bbea29421e7e952ac8c2720169ff332ea0e277573a2fb582c0', // pdm-local
      '809d7ee991b8c1182442d93e326d4dc3ad9e0993f91f4da83aac8187c98e90bb', // pipenv-local
      'e952a6109a05d97adc2791f641f807245c75ba401ced279964b06fcc2987b92e', // go-local
      'ae3385d9deac83936000100621078011b1918a66237d4ae1ef72770dc677914a', // node-fallback
      'b0be130068ad150eb7f59a2166a4fc22601e10ec961d2144d4c158602fde1f9c', // python-fallback
      '91b37a1c14fcc6f237d9600b8f49bb936eb2091f418fe8932fc94cdbfe91454f', // go-fallback
   ],
   // GitLab owns a marked block inside a shared file, never a whole file, so it
   // recognizes its own output by the markers and registers no digests.
   gitlab: [],
   circleci: [
      '99a942be4f0ac62672af68a9d33e17328441e64f3b28b52ff8dafede0a5ce9f0',
      'cf813aa8c65a5efa64500628bc51c73d3ae3a5f56ec47386f5525de0828818d3',
      // 1.4.0: the twelve job variants, in ciVariants() order.
      'e72c78146170d54a4b79326b3a8933ba0ca54bf76be665b45f47009729a864b1', // npm-local
      '039559039ccda2dca14da3366cb1ca56895f4eaf48a395a7dd75f4a3614dabc1', // pnpm-local
      'ba5303502b7fc3e70174b163666fe27af855663b2b66900a0e1affcd3ee3290b', // yarn-local
      'e46e865183f764c1d6bf594e9d074744911221232db2805ea3de3896fa920ce4', // bun-local
      '4b974432dc0d1939a89e8ca9c130ec16c70e1aeb1252fd5895785018e9e84f98', // uv-local
      '3cc62af0609c563e0268e632285d28d7365c4ce81652e1c0d9f3f62496f01665', // poetry-local
      'b519fa8e216b62a8da7ce0f98b53de81dde62f4c3bed924b7fbc59b7b5f8af1f', // pdm-local
      '6786b3df303d00239170bf0365e7ff66662fcfc0912ea6cd992547e1422eed9a', // pipenv-local
      '43ca7c5fce284555d5b72a6cd69c153e295ae01f921dd5e2b755e11d4e3e9e8f', // go-local
      'b82f65f616ec46445e43b8c1680618428cce89ee17e69f0a1e2b94b4ace2fc9b', // node-fallback
      '0d2135d41e50be5fa6811bdc9aa85fc0ce4110ec918e17c139cd969087834e4b', // python-fallback
      '704a4b3c3f8880c505e181eed154234e4640cdad5d13a3c9dfe5b4cdcdfbd3d9', // go-fallback
   ],
   azure: [
      '71fb19e18660e84ec4a2b9364ea6a9dea0ca7aff8bb52ede8d5c3f4d77c68669',
      '7a086e5cd0f2e8a2e67b925ec54b8e8febb1bca016e1893c95fd00815d86c63a',
      // 1.4.0: the twelve job variants, in ciVariants() order.
      '9c8127bfb670731eb08089b02a1adecc135bc32524699793e83e23eb4143e4f1', // npm-local
      '099befce80e7420297583ee3a88bed97f01c073dbb756bbf64ad37b321eb506a', // pnpm-local
      '5d1f2642c97954b6fca52fa8239534c5633cc3bc512c7946f2515473bde58bb7', // yarn-local
      '9e60a214631033172e3021d773581f15db14c3e1e05d1673f05d7752ff054b03', // bun-local
      'c4d041736cedbd2092667480bbaf91711f3696997256456fa276a59660c66555', // uv-local
      '2913197fc21a1fbf3587695af2b2d2215b6f9966507b542ecc08e44727b5bf2b', // poetry-local
      'f756c8ea1ff653d4bed01ac60aa9ba26b426936cf19a5be54508a166e66ca6f6', // pdm-local
      '7a452ce135e706fdada5f953a18bdaafb0fd453650d061b0e07f62e5309d6d58', // pipenv-local
      'ce1b7546d140ba09838e9af8dab92ecebf75f20c7e7714c2eeb210ab1f1422d3', // go-local
      '1a4167a0b4b3a5b7528d7a6d0bcefeabd37f617b02f82772fd6c74c148d9e17e', // node-fallback
      'c9cd3d115cb4f4d9db1b3f523cfbbf1397923df6142c58e5e6c8562ff57fa908', // python-fallback
      '23679c491cbd53e39ffc5d940de7b97865f1b944bf55ad1bd7e73b8c57520606', // go-fallback
   ],
};

/**
 * Is this file leji's to replace? Yes when its bytes are one this generator can
 * write right now, or when its digest is one an earlier release wrote. A file the
 * user edited matches neither, and is left alone with a snippet — editing a
 * generated file, or deleting its marker, is the opt-out, and it is honored.
 */
function isLejiGenerated(provider: CiProvider, text: string): boolean {
   if (ciVariants().some((v) => v.provider === provider && v.bytes === text)) return true;
   const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
   // Scoped to THIS provider: a file that is leji's at one provider's path is a
   // foreign file at another's, and a foreign file is never replaced.
   return KNOWN_GENERATED[provider].includes(digest);
}

/**
 * Add a CI workflow running `leji validate` (the `leji ci` command), with the job
 * the repository's own package manager needs. GitHub, CircleCI and Azure own whole
 * files: created when absent, REPLACED when the file standing there is one leji
 * generated (this release or an earlier one), and left untouched with a hand-add
 * snippet when it is foreign or was edited. GitLab owns a marker-delimited block
 * inside the shared `.gitlab-ci.yml` and merges it. All deterministic text so the
 * three SDKs stay byte-identical. Refuses a symlink that escapes root.
 */
export function ensureCiWorkflow(root: string, provider: CiProvider, report?: EcosystemReport): CiResult {
   const rootAbs = path.resolve(root);
   // Local-first: a repository that DECLARES the CLI and carries its manager's lock
   // evidence installs its own locked dependencies and runs the local binary; every
   // other state takes the fallback that needs no manifest.
   const job = resolveCiJob(report ?? detectEcosystem(rootAbs), provider);
   // Every arm decides what stands at its target through the verified read, never
   // through a pathname check: `existsSync` follows symlinks, so a dangling link at
   // the workflow path reads as absent and the create lands at the link's
   // destination. `null` is the create path; a verified regular file is judged by its
   // bytes; a standing entry that cannot be verified is the same refusal a write to
   // it would be.
   const rootReal = guardRoot(rootAbs);

   /** The shared whole-file arm: create, replace what we own, or hand back a snippet. */
   const wholeFile = (rel: string, snippet: string, note?: string): CiResult => {
      const abs = path.join(rootAbs, rel);
      guardWithinRoot(rootAbs, abs, rel);
      const content = buildCiFile(provider, job);
      const existing = readMergeSource(rootReal, abs, rel);
      if (existing === null) {
         writeFileAtomic(rootAbs, abs, rel, content);
         return note ? { provider, path: rel, action: 'created', note } : { provider, path: rel, action: 'created' };
      }
      if (existing === content) return { provider, path: rel, action: 'unchanged' };
      if (!isLejiGenerated(provider, existing)) {
         return { provider, path: rel, action: 'manual', snippet };
      }
      writeFileAtomic(rootAbs, abs, rel, content);
      return { provider, path: rel, action: 'updated' };
   };

   switch (provider) {
      case 'github':
         return wholeFile(CI_WORKFLOW_PATH, buildGithubWorkflow(job));
      case 'gitlab': {
         const abs = path.join(rootAbs, GITLAB_CI_PATH);
         guardWithinRoot(rootAbs, abs, GITLAB_CI_PATH);
         const block = buildGitlabBlock(job);
         // The merge is a read-then-write of one target, so the bytes come from the
         // verified read: the file the rule judged is the file that is read and then
         // rewritten.
         const text = readMergeSource(rootReal, abs, GITLAB_CI_PATH);
         if (text === null) {
            writeFileAtomic(rootAbs, abs, GITLAB_CI_PATH, block);
            return { provider, path: GITLAB_CI_PATH, action: 'created' };
         }
         const merged = mergeGitlabBlock(text, block);
         if (merged === text) return { provider, path: GITLAB_CI_PATH, action: 'unchanged' };
         writeFileAtomic(rootAbs, abs, GITLAB_CI_PATH, merged);
         return { provider, path: GITLAB_CI_PATH, action: 'updated' };
      }
      case 'circleci':
         return wholeFile(CIRCLECI_CONFIG_PATH, buildCircleCiSnippet(job));
      case 'azure':
         // Activation note is created-only: a re-run on an existing file stays quiet.
         return wholeFile(AZURE_PIPELINE_PATH, buildAzurePipeline(job), AZURE_ACTIVATION_NOTE);
      default:
         // Unreachable from the CLI (validates first); guards direct helper callers.
         throw new Error(`unknown provider "${provider}"`);
   }
}

function guardWithinRoot(rootAbs: string, abs: string, rel: string): void {
   if (!resolvedWithinRoot(rootAbs, abs)) {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
}

/** Write `abs` atomically (sibling temp + rename, both ends judged by the write
 * chokepoint) so an interrupted write never leaves a partial file. On failure the
 * temp is removed and a deterministic, OS-text-free error is raised so the three
 * SDKs report I/O failures identically. */
function writeFileAtomic(rootAbs: string, abs: string, rel: string, contents: string): void {
   let verdict;
   try {
      verdict = writeFileAtomicGuarded(guardRoot(rootAbs), abs, initRole(rel), contents);
   } catch (e) {
      throw new Error(writeFailureMessage(rel, e));
   }
   guardedOrRefuse(rel, verdict);
}

/** A deterministic, OS-text-free message for a failed CI-file write, so stderr stays
 * byte-identical across the Node, Go, and Python SDKs. */
function writeFailureMessage(rel: string, e: unknown): string {
   const code = (e as NodeJS.ErrnoException).code;
   if (code === 'EACCES' || code === 'EPERM') return `cannot write "${rel}": permission denied`;
   return `cannot write "${rel}"`;
}

/** Insert/replace the managed block in an existing `.gitlab-ci.yml`, byte-exactly.
 * Replaces the first block and drops later duplicates, leaving exactly one. */
function mergeGitlabBlock(text: string, block: string): string {
   return mergeManagedBlock(text, block, GITLAB_MARKER_START, GITLAB_MARKER_END);
}

/** Insert/replace a marker-delimited managed block, byte-exactly. Replaces the
 * first block and drops later duplicates, leaving exactly one; a block-less file
 * gets the block appended after one blank line; an empty file becomes the block. */
function mergeManagedBlock(text: string, block: string, startMarker: string, endMarker: string): string {
   const span = managedBlockSpan(text, startMarker, endMarker);
   if (span) {
      return text.slice(0, span.start) + block + stripManagedBlocks(text.slice(span.end), startMarker, endMarker);
   }
   if (text === '') return block;
   return text + (text.endsWith('\n') ? '\n' : '\n\n') + block;
}

/** The `[start, end)` span of the first managed block in `text`, or null if none. */
function managedBlockSpan(text: string, startMarker: string, endMarker: string): { start: number; end: number } | null {
   const start = text.indexOf(startMarker);
   if (start === -1) return null;
   const endMarkerIdx = text.indexOf(endMarker, start);
   if (endMarkerIdx === -1) return null;
   const nl = text.indexOf('\n', endMarkerIdx);
   const end = nl === -1 ? text.length : nl + 1;
   return { start, end };
}

/** Remove every managed block from `text` (drops duplicates left after the first). */
function stripManagedBlocks(text: string, startMarker: string, endMarker: string): string {
   let out = '';
   let rest = text;
   for (;;) {
      const span = managedBlockSpan(rest, startMarker, endMarker);
      if (!span) return out + rest;
      out += rest.slice(0, span.start);
      rest = rest.slice(span.end);
   }
}

// --- the generated CI job -------------------------------------------------
// One table, one job resolution, four renderers. Every cell an adopter's pipeline
// runs is stated here rather than assembled at the call site, so the three SDKs
// transcribe data instead of re-deriving prose, and a reviewer reads the matrix.

/** Every provider `leji ci` generates for, in a fixed order. */
export const CI_PROVIDERS: CiProvider[] = ['github', 'gitlab', 'circleci', 'azure'];

/** The runtime a generated job needs on its runner: which setup step or image. */
type CiRuntime = 'node' | 'bun' | 'python' | 'go';

/** One package manager's CI facts. `pipBootstrap` names a tool that has to be
 * installed with pip wherever the provider offers no dedicated setup action. */
interface CiManagerCell {
   runtime: CiRuntime;
   install: string;
   pipBootstrap?: string;
   /** A bootstrap tool the job installs unpinned, disclosed in one comment line. */
   unpinned?: string;
}

/** Manager -> install command and runtime. The runner argv is NOT duplicated here:
 * it comes from the detection report, which owns the one runner table. */
const CI_MANAGERS: Record<string, CiManagerCell> = {
   npm: { runtime: 'node', install: 'npm ci' },
   pnpm: { runtime: 'node', install: 'corepack enable && pnpm install --frozen-lockfile' },
   yarn: { runtime: 'node', install: 'corepack enable && yarn install --frozen-lockfile' },
   bun: { runtime: 'bun', install: 'bun install --frozen-lockfile' },
   uv: { runtime: 'python', install: 'uv sync --locked', pipBootstrap: 'uv' },
   poetry: { runtime: 'python', install: 'pip install poetry && poetry install', unpinned: 'poetry' },
   pdm: { runtime: 'python', install: 'pip install pdm && pdm install', unpinned: 'pdm' },
   pipenv: { runtime: 'python', install: 'pip install pipenv && pipenv install --dev', unpinned: 'pipenv' },
   go: { runtime: 'go', install: 'go mod download' },
};

/** The one job a provider renders: what to set up, what to install, what to run. */
interface CiJob {
   runtime: CiRuntime;
   install: string[];
   runner: string[];
   /** A tool installed unpinned by `install`, disclosed above it. */
   unpinned: string | null;
   /** uv through its own GitHub action rather than pip. */
   uvAction: boolean;
   /** Whether the job installs the repository's own locked dependencies. */
   local: boolean;
}

/** The CLI as CI reaches it when the repository does not declare it: version-pinned
 * to the current major, which is additive-only, so a valid layer stays valid and a
 * breaking major never reaches adopter CI without a bump. */
const CI_FALLBACK_NODE = ['npx', '-y', `${DEP_NAME}@1`];
const CI_FALLBACK_PY_INSTALL = "pip install 'leji>=1,<2'";
const CI_FALLBACK_GO_INSTALL = 'go install github.com/leji-org/leji/packages/sdk-go/cmd/leji@latest';

/**
 * Which job this repository gets. Local-first: a repository that DECLARES the CLI
 * and has the manager's lock evidence installs its own locked dependencies and runs
 * the local binary. Everything else — undeclared, unlocked, ambiguous, unsupported,
 * unreadable, refused evidence, several ecosystems, none — takes the fallback for
 * its ecosystem, which needs no manifest and no lockfile.
 */
function resolveCiJob(report: EcosystemReport, provider: CiProvider): CiJob {
   const selected = report.selected;
   const cell = selected?.manager != null ? CI_MANAGERS[selected.manager] : undefined;
   if (selected && cell && selected.directDeclared && selected.lockEvidenced && selected.runner) {
      // uv is the one manager with a first-party setup action; everywhere else it is
      // pip-installed like poetry/pdm/pipenv, and disclosed the same way.
      const uvAction = provider === 'github' && cell.pipBootstrap === 'uv';
      const bootstrap = cell.pipBootstrap && !uvAction ? cell.pipBootstrap : null;
      return {
         runtime: cell.runtime,
         install: [bootstrap ? `pip install ${bootstrap} && ${cell.install}` : cell.install],
         runner: selected.runner,
         unpinned: cell.unpinned ?? bootstrap,
         uvAction,
         local: true,
      };
   }
   const ecosystem = report.all.length === 1 ? report.all[0].ecosystem : null;
   if (ecosystem === 'python') {
      return {
         runtime: 'python',
         install: [CI_FALLBACK_PY_INSTALL],
         runner: ['leji'],
         unpinned: null,
         uvAction: false,
         local: false,
      };
   }
   if (ecosystem === 'go') {
      return {
         runtime: 'go',
         install: [CI_FALLBACK_GO_INSTALL],
         runner: ['leji'],
         unpinned: null,
         uvAction: false,
         local: false,
      };
   }
   // Node, several ecosystems, and none alike: the job that needs no package manager.
   return { runtime: 'node', install: [], runner: CI_FALLBACK_NODE, unpinned: null, uvAction: false, local: false };
}

/** The generator schema version. Bumped when the generated shape changes, so the
 * marker says which generation wrote a file; pre-1.4 output is implicitly v1. */
const CI_GENERATOR_VERSION = 2;
const CI_MARKER = `# generated by leji ci (managed) v${CI_GENERATOR_VERSION}`;

/** The one disclosure line for a job that installs a bootstrap tool unpinned. */
function unpinnedNote(job: CiJob): string | null {
   return job.unpinned === null
      ? null
      : `# ${job.unpinned} is installed unpinned here; pin it if your project pins it.`;
}

/** GitHub Actions setup steps for a runtime, already at the steps' indentation. */
function githubSetup(job: CiJob): string[] {
   switch (job.runtime) {
      case 'node':
         return ['      - uses: actions/setup-node@v4', '        with:', "          node-version: '22'"];
      case 'bun':
         return ['      - uses: oven-sh/setup-bun@v2'];
      case 'python':
         return [
            '      - uses: actions/setup-python@v5',
            '        with:',
            "          python-version: '3.12'",
            ...(job.uvAction ? ['      - uses: astral-sh/setup-uv@v5'] : []),
         ];
      case 'go':
         return ['      - uses: actions/setup-go@v5', '        with:', "          go-version: '1.24'"];
   }
}

/** GitHub Actions workflow: a standalone file under .github/workflows/. */
function buildGithubWorkflow(job: CiJob): string {
   const note = unpinnedNote(job);
   const lines = [
      CI_MARKER,
      'name: leji',
      'on: [push, pull_request]',
      'jobs:',
      '  validate:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      ...githubSetup(job),
      ...(note ? [`      ${note}`] : []),
      ...job.install.map((cmd) => `      - run: ${cmd}`),
      `      - run: ${job.runner.join(' ')} validate`,
      `      - run: ${job.runner.join(' ')} index --check`,
   ];
   return lines.join('\n') + '\n';
}

/** The container image a job runs in on the image-based providers. */
function ciImage(runtime: CiRuntime): string {
   switch (runtime) {
      case 'node':
         return 'node:22';
      case 'bun':
         return 'oven/bun:1';
      case 'python':
         return 'python:3.12';
      case 'go':
         return 'golang:1.24';
   }
}

/** GitLab CI: a marker-delimited job merged into the shared .gitlab-ci.yml. */
function buildGitlabBlock(job: CiJob): string {
   const note = unpinnedNote(job);
   // `.pre` is always available. Without an explicit stage GitLab assigns `test`,
   // and a pipeline whose own `stages:` list omits `test` rejects the whole
   // configuration, so the generated job would break an existing pipeline it was
   // merged into.
   const lines = [
      GITLAB_MARKER_START,
      'leji-validate:',
      '  stage: .pre',
      `  image: ${ciImage(job.runtime)}`,
      '  script:',
      ...(note ? [`    ${note}`] : []),
      ...job.install.map((cmd) => `    - ${cmd}`),
      `    - ${job.runner.join(' ')} validate`,
      `    - ${job.runner.join(' ')} index --check`,
      GITLAB_MARKER_END,
   ];
   return lines.join('\n') + '\n';
}

/** CircleCI job steps, shared by the full config and the hand-add snippet. */
function circleCiJob(job: CiJob): string[] {
   const note = unpinnedNote(job);
   return [
      'jobs:',
      '  leji-validate:',
      '    docker:',
      `      - image: ${ciImage(job.runtime)}`,
      '    steps:',
      '      - checkout',
      ...(note ? [`      ${note}`] : []),
      ...job.install.map((cmd) => `      - run: ${cmd}`),
      `      - run: ${job.runner.join(' ')} validate`,
      `      - run: ${job.runner.join(' ')} index --check`,
      'workflows:',
      '  leji:',
      '    jobs:',
      '      - leji-validate',
   ];
}

/** CircleCI config written when .circleci/config.yml is absent. */
function buildCircleCiConfig(job: CiJob): string {
   return [CI_MARKER, 'version: 2.1', ...circleCiJob(job)].join('\n') + '\n';
}

/** The jobs + workflows fragment to add by hand to an existing CircleCI config.
 * No marker: it is pasted into a file leji does not own. */
function buildCircleCiSnippet(job: CiJob): string {
   return circleCiJob(job).join('\n') + '\n';
}

/** Azure Pipelines setup tasks for a runtime, at the steps' indentation. */
function azureSetup(job: CiJob): string[] {
   switch (job.runtime) {
      case 'node':
         return ['  - task: NodeTool@0', '    inputs:', "      versionSpec: '22.x'"];
      case 'bun':
         return [
            '  - task: NodeTool@0',
            '    inputs:',
            "      versionSpec: '22.x'",
            '  - script: npm install -g bun',
            '    displayName: install bun',
         ];
      case 'python':
         return ['  - task: UsePythonVersion@0', '    inputs:', "      versionSpec: '3.12'"];
      case 'go':
         return ['  - task: GoTool@0', '    inputs:', "      version: '1.24'"];
   }
}

/** Azure Pipelines: a dedicated .azure-pipelines/leji.yml the user wires to a pipeline. */
function buildAzurePipeline(job: CiJob): string {
   const note = unpinnedNote(job);
   const lines = [
      CI_MARKER,
      'trigger:',
      '  - main',
      'pool:',
      '  vmImage: ubuntu-latest',
      'steps:',
      ...azureSetup(job),
      ...(note ? [`  ${note}`] : []),
      ...job.install.flatMap((cmd) => [`  - script: ${cmd}`, '    displayName: install']),
      `  - script: ${job.runner.join(' ')} validate`,
      '    displayName: leji validate',
      `  - script: ${job.runner.join(' ')} index --check`,
      '    displayName: leji index --check',
   ];
   return lines.join('\n') + '\n';
}

/** The whole file a provider writes for a job, or null where the provider owns a
 * block inside a shared file (GitLab) rather than a file of its own. */
function buildCiFile(provider: CiProvider, job: CiJob): string {
   switch (provider) {
      case 'github':
         return buildGithubWorkflow(job);
      case 'gitlab':
         return buildGitlabBlock(job);
      case 'circleci':
         return buildCircleCiConfig(job);
      case 'azure':
         return buildAzurePipeline(job);
   }
}

/** Every job this generator can produce, in a fixed order: the nine local manager
 * cells, then the three ecosystem fallbacks. The enumeration is what proves the
 * digest registry complete and what bakes the golden fixtures. */
function ciJobVariants(provider: CiProvider): { key: string; job: CiJob }[] {
   const out: { key: string; job: CiJob }[] = [];
   for (const [manager, cell] of Object.entries(CI_MANAGERS)) {
      const uvAction = provider === 'github' && cell.pipBootstrap === 'uv';
      const bootstrap = cell.pipBootstrap && !uvAction ? cell.pipBootstrap : null;
      out.push({
         key: `${manager}-local`,
         job: {
            runtime: cell.runtime,
            install: [bootstrap ? `pip install ${bootstrap} && ${cell.install}` : cell.install],
            runner: managerRunnerArgv(manager) ?? ['leji'],
            unpinned: cell.unpinned ?? bootstrap,
            uvAction,
            local: true,
         },
      });
   }
   for (const [key, job] of [
      ['node-fallback', { runtime: 'node' as CiRuntime, install: [], runner: CI_FALLBACK_NODE }],
      ['python-fallback', { runtime: 'python' as CiRuntime, install: [CI_FALLBACK_PY_INSTALL], runner: ['leji'] }],
      ['go-fallback', { runtime: 'go' as CiRuntime, install: [CI_FALLBACK_GO_INSTALL], runner: ['leji'] }],
   ] as const) {
      out.push({
         key,
         job: {
            ...job,
            install: [...job.install],
            runner: [...job.runner],
            unpinned: null,
            uvAction: false,
            local: false,
         },
      });
   }
   return out;
}

/** Every generated artifact of the CURRENT generator: provider, variant key, and
 * bytes. Exported for the tests that bake `fixtures/ci-goldens/` and prove the
 * digest registry lists every variant this release can write. */
export function ciVariants(): { provider: CiProvider; key: string; bytes: string }[] {
   const out: { provider: CiProvider; key: string; bytes: string }[] = [];
   for (const provider of CI_PROVIDERS) {
      for (const { key, job } of ciJobVariants(provider)) {
         out.push({ provider, key, bytes: buildCiFile(provider, job) });
      }
   }
   return out;
}

// Name (also the agent-profile `id`/agents-map key) and role must be kebab
// identifiers: matches the schema's id pattern and is safe as a path segment and
// when interpolated into YAML frontmatter and JSON.
const AGENT_TOKEN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function assertAgentToken(label: string, value: string): void {
   if (!AGENT_TOKEN.test(value)) {
      throw new Error(
         `${label} must be lowercase letters, digits, and single dashes (e.g. "thought-partner"); got "${value}"`,
      );
   }
}

/** A starter agent profile, keyed off the role: `reviewer` (default) gets the
 * review-focused posture, any other role a neutral template. Frontmatter satisfies
 * the agent-profile schema (id/name/role/requiredRead/mustAskWhen). */
function buildAgentProfile(name: string, role: string, hostId: string | undefined, rootPath: string): string {
   const hostLine = hostId ? `host: ${hostId}\n` : '';
   const hostNote = hostId ? ` (host \`${hostId}\`)` : '';
   const head = `---
id: ${name}
name: ${name}
role: ${role}
${hostLine}inherits: core
`;
   if (role === 'reviewer') {
      return `${head}purpose: Independent review of proposed context-layer changes before a person approves.
requiredRead:
  - ${joinUnderRoot(rootPath, 'boot-profile.md')}
  - ${joinUnderRoot(rootPath, 'agents/core.md')}
mustAskWhen:
  - a proposal weakens an invariant or guardrail
  - a change to settled behavior lacks a decision record
---

# ${name}

A second agent${hostNote} that reviews context-layer proposals against the spec and this
layer's own rules before a person approves. Inherits the core posture; it never loosens it.

## Review focus

- The proposal matches how this team actually works (domain, system, governance).
- Placeholders are gone and claims are grounded in the repository.
- A change to settled behavior carries a decision record.
`;
   }
   return `${head}requiredRead:
  - ${joinUnderRoot(rootPath, 'boot-profile.md')}
  - ${joinUnderRoot(rootPath, 'agents/core.md')}
mustAskWhen:
  - a change would weaken an invariant or guardrail
  - a change to settled behavior lacks a decision record
---

# ${name}

The \`${role}\` agent${hostNote} bound to this context layer. Inherits the core posture
from the boot profile and core profile; it never loosens it.

## Responsibilities

- TODO: describe what this agent is responsible for.
- TODO: list what it may do unprompted and what needs a human gate.
`;
}

/** Guidance for the `default` binding: selecting a role profile there is not the
 * same as loading it, a distinction the key's name invites readers to miss.
 * Written-only, like the CI activation note: a re-run that binds nothing stays
 * terse. */
const AGENTS_DEFAULT_NOTE =
   'agents.default selects a role profile; it does not load it. If its instructions must apply before every task, fold them into the boot profile; otherwise keep the profile role-scoped and engage it through the relevant protocol.';

/** What `addAgent` did. Each artifact is independently idempotent: a false
 * `*Created`/`manifestChanged` means it was already there. `hostId` is undefined
 * for a host-agnostic resident agent (no `--host`). `note` is advisory text the
 * caller surfaces verbatim (present when the `default` binding is written). */
export interface AgentResult {
   name: string;
   role: string;
   hostId?: string;
   profilePath: string;
   profileCreated: boolean;
   manifestChanged: boolean;
   note?: string;
}

/** Wire a named agent into an existing layer (the `leji agent` command): write a
 * starter profile and bind the agent in leji.json via an in-place text edit that
 * preserves the rest of the file. Never overwrites; re-running is a no-op. */
export function addAgent(
   root: string,
   manifest: Manifest,
   opts: { host?: string; name: string; role?: string },
): AgentResult {
   const rootAbs = path.resolve(root);
   const name = opts.name;
   const role = opts.role ?? 'reviewer';
   assertAgentToken('agent name', name);
   assertAgentToken('agent role', role);
   // --host is optional: it pins the profile to a specific external CLI; with none,
   // any host can run this resident agent. Either way we never write a vendor file
   // (those are migrated from an existing entrypoint, never created).
   let hostId: string | undefined;
   if (opts.host) {
      const id = resolveHostId(opts.host);
      const spec = id ? HOST_SPECS.find((s) => s.id === id) : undefined;
      if (!spec) throw new Error(`unknown host "${opts.host}"; known: ${HOST_SPECS.map((s) => s.id).join(', ')}`);
      hostId = spec.id;
   }

   const base = effectiveAgentProfilesPath(manifest);
   const profileRel = (base.endsWith('/') ? base : `${base}/`) + `${name}.md`;
   const profileAbs = path.join(rootAbs, profileRel);
   const rootReal = guardRoot(rootAbs);

   // Both halves of this command are judged BEFORE either is written: binding an agent
   // means a profile file and a manifest edit, and a run that can only do one of them
   // must do neither. The manifest is read through the verified read (its bytes are
   // spliced and written straight back), so a target that cannot be verified as a
   // regular file inside the repository refuses the whole command with nothing
   // written. `absent` refuses too: this command edits a manifest, it never creates one.
   const manifestAbs = path.join(rootAbs, 'leji.json');
   const manifestRead = verifiedTargetRead(rootReal, manifestAbs, null);
   if (manifestRead.status !== 'regular') {
      throw new Error(`refusing to write through a symlink that escapes the target: "leji.json"`);
   }
   const original = manifestRead.bytes.toString('utf8');
   const text = bindAgentInManifestText(original, name, profileRel).text;
   const manifestChanged = text !== original;

   // The profile half is judged next, still before either write: a pathname check
   // follows symlinks, so a dangling link at the profile name reads as absent and the
   // write lands at the link's destination. Only `absent` is written; a verified
   // regular file is the never-overwrite skip this command has always made; anything
   // else standing there refuses the whole command with nothing written.
   const profileRead = verifiedTargetRead(rootReal, profileAbs, null);
   if (profileRead.status === 'refused') {
      throw new Error(`refusing to write through a symlink that escapes the target: "${profileRel}"`);
   }
   const profileCreated = profileRead.status === 'absent';

   if (profileCreated) {
      const profile = buildAgentProfile(name, role, hostId, manifest.rootPath);
      guardedOrRefuse(profileRel, writeFileGuarded(rootReal, profileAbs, null, profile));
   }
   if (manifestChanged) guardedOrRefuse('leji.json', writeFileGuarded(rootReal, manifestAbs, null, text));

   const result: AgentResult = { name, role, hostId, profilePath: profileRel, profileCreated, manifestChanged };
   if (name === 'default' && manifestChanged) result.note = AGENTS_DEFAULT_NOTE;
   return result;
}

/** Refuse to mutate a dirty working tree: the "git restore cleanly undoes Leji's
 * writes" safety net only holds if the tree started clean. A non-git directory has
 * no such net and is allowed (how a fresh layer bootstraps before `git init`).
 * Callers skip this under --dry-run. */
function assertCleanWorkingTree(root: string): void {
   if (workingTreeClean(root) === false) {
      throw new Error(
         'the working tree has uncommitted changes; commit or stash them first so this stays cleanly reversible (preview with --dry-run)',
      );
   }
}

/** Bootstrap a context layer from the vendored templates. Interactive unless --yes.
 * Refuses when leji.json exists or the tree is dirty; never overwrites existing
 * files. With `dryRun`, computes the write plan and touches nothing. */
export async function initLayer(options: InitOptions): Promise<InitResult> {
   // Flag values are checked before anything on disk is read, the way the CLI
   // parser rejects --mode/--level.
   if (options.agent) assertAgentHost(options.agent);
   const root = path.resolve(options.dir);
   if (fs.existsSync(path.join(root, 'leji.json'))) {
      throw new Error('leji.json already exists here; init refuses to overwrite an existing layer');
   }
   if (!options.dryRun) assertCleanWorkingTree(root);
   const detected = detectHosts({ root });
   const answers = await prompt(options);
   answers.categories = normalizeCategories(answers.categories, answers.mode);
   // Guard rootPath (and every derived write path) before any write.
   assertRelativePath(answers.rootPath);

   const manifest = buildManifest(answers);
   const r = answers.rootPath;
   const layout = answers.layout ?? defaultLayout(r);

   // Files init owns, in write order. leji.json first so the overwrite guard is
   // effective on a retry after an interrupted run.
   const writes: PlannedWrite[] = [{ rel: 'leji.json', content: JSON.stringify(manifest, null, 2) + '\n' }];
   writes.push({ rel: manifest.bootProfilePath, content: buildBootProfile(answers) });
   // The portable discovery adapter: a pointer-only AGENTS.md so any host that
   // auto-loads it cold-starts into the boot profile. Default-on; --no-agents
   // skips it, and an existing file is never touched (it stays in wontModify).
   if (!options.noAgents && !isFile(path.join(root, PORTABLE_ADAPTER))) {
      writes.push({ rel: PORTABLE_ADAPTER, content: adapterContent(manifest.bootProfilePath) });
   }
   for (const category of answers.categories) {
      if (category === 'decisions') continue;
      const stub = CATEGORY_STUBS[category];
      writes.push({
         rel: `${joinUnderRoot(r, category + '/')}${stub.file}`,
         content: categoryStub(stub.title, stub.summary, stub.body),
      });
   }
   if (answers.mode === 'solo') {
      // Solo starters live in their category directories, so the existing
      // category index files govern them with no extra wiring.
      for (const s of SOLO_STARTERS) {
         writes.push({ rel: `${joinUnderRoot(r, s.category + '/')}${s.file}`, content: readTemplate(s.template) });
      }
   }
   writes.push({ rel: `${joinUnderRoot(r, 'decisions/')}0001-adopt-leji.md`, content: buildFirstDecision(answers) });
   // Stub index file per category so the manifest's `indexes` resolve to real
   // content. (Phase B reworks adopt to author these from a tree scan.)
   for (const category of answers.categories) {
      writes.push({ rel: `${layout.contextDir}${category}.md`, content: categoryIndexFile(r, category) });
   }
   writes.push({ rel: `${layout.agentsDir}core.md`, content: buildCoreProfile(answers) });
   writes.push({ rel: BRIEF_PATH, content: buildBrief(answers) });
   if (answers.level === 'indexed') {
      // Changelog records the seeded paths (the planned set, minus changelog/index).
      // Dot-paths (the transient `.leji/` brief) are excluded from the governed
      // machine surface, so they never seed the changelog.
      const seeded = writes
         .map((w) => w.rel)
         .filter((rel) => !rel.split('/').some((seg) => seg.startsWith('.')))
         .sort();
      writes.push({ rel: effectiveChangelogPath(manifest), content: buildChangelog(answers, seeded) });
   }

   // Foreign entrypoint files Leji detects but will never modify.
   const wontModify = KNOWN_VENDOR_FILES.filter((rel) => isFile(path.join(root, rel)));
   // The index is generated at every level, not only at `indexed`. `leji index
   // --check` is a CI gate for any layer, so a scaffold that omits the index hands
   // the adopter a red first run on the documented happy path. The changelog stays
   // gated: it is an `indexed` requirement, and seeding one at `core` over-scaffolds.
   const indexRel = effectiveIndexPath(manifest);
   const planWrites = [...writes, { rel: indexRel, content: '' }];
   const plan = planWithIndexTruth(buildWritePlan(root, planWrites, wontModify), indexRel);

   if (options.dryRun) {
      return { written: [], manifest, mode: answers.mode, plan, dryRun: true, detected, root, findings: [] };
   }

   const written: string[] = [];
   fs.mkdirSync(root, { recursive: true });
   // The tracked-file preflight and the `.leji/` ignore run BEFORE any write at
   // all, so the private onboarding workspace can never land in git and a failed
   // preflight leaves the tree untouched.
   assertLejiWorkspacePrivate(root);
   ensureLejiGitignored(root);
   // leji.json is created exclusively ('wx'): O_EXCL closes the check-then-write
   // race and won't follow a symlink at the final component.
   writeManifestExclusive(root, path.join(root, 'leji.json'), writes[0].content, 'init');
   written.push('leji.json');
   // The changelog is held back until the index generates cleanly. Seeding it off a
   // tree that cannot be indexed would leave a layer claiming `indexed` with a
   // changelog, no index, and a `leji.json` that blocks re-running `init`.
   const changelogRel = answers.level === 'indexed' ? effectiveChangelogPath(manifest) : undefined;
   for (const w of writes.slice(1)) {
      if (w.rel === changelogRel) continue;
      writeFileOnce(root, w.rel, w.content, written);
   }
   // The whole of the `leji index` rule, not half of it: writeIndex declines to
   // write on a hard generation finding, so the file is not claimed, the dependent
   // changelog is not seeded, and the findings travel out for the caller to report.
   const index = writeIndex(root, manifest);
   const wrote = !hasErrors(index.findings);
   if (wrote) {
      written.push(indexRel);
      const changelog = writes.slice(1).find((w) => w.rel === changelogRel);
      if (changelog) writeFileOnce(root, changelog.rel, changelog.content, written);
   }

   return {
      written: written.sort(),
      manifest,
      mode: answers.mode,
      plan,
      dryRun: false,
      detected,
      root,
      findings: index.findings,
   };
}

// --- adoption (existing repositories) ---

export const DOCS_CANDIDATES = ['docs/', 'doc/', 'documentation/'];

/**
 * The existing docs directory, named as it is on disk, or null if there is none.
 *
 * Matching is case-insensitive and the answer is the real directory entry, which
 * are two halves of the same defect. Testing `isDir(root/'docs')` succeeds on a
 * case-insensitive filesystem when the directory is actually `Docs`, and returning
 * the candidate rather than the entry then recorded a `rootPath` that does not
 * match disk: reads still resolve locally, so the mismatch stays invisible until
 * something compares paths case-sensitively. On a case-sensitive filesystem the
 * same test simply missed, and adoption scaffolded a second directory beside the
 * one already there.
 */
/**
 * Choose the docs root from a set of directory names, as a pure function of it.
 *
 * Exact spelling first, then the lowest remaining name. Both halves are needed: a
 * case-sensitive filesystem may hold several variants at once, and directory-entry
 * order is not guaranteed, so taking the first match found would make the recorded
 * rootPath depend on the order a readdir happened to return. Kept separate from the
 * filesystem so the ordering rule is testable against an injected set.
 */
export function pickDocsRoot(dirNames: readonly string[]): string | null {
   for (const candidate of DOCS_CANDIDATES) {
      const want = stripSlash(candidate);
      const matches = dirNames.filter((n) => n.toLowerCase() === want.toLowerCase()).sort();
      const hit = matches.find((n) => n === want) ?? matches[0];
      if (hit !== undefined) return `${hit}/`;
   }
   return null;
}

function detectDocsRoot(root: string): string | null {
   let names: string[];
   try {
      names = fs.readdirSync(root);
   } catch {
      return null;
   }
   // Directoryness is tested through `isDir`, which follows symlinks, because a
   // documentation root is allowed to be a directory symlink and reading the entry
   // type directly would silently stop detecting one.
   return pickDocsRoot(names.filter((n) => isDir(path.join(root, n))));
}

/** Options for `adoptLayer`: bringing Leji into an existing repository. */
export interface AdoptOptions {
   dir: string;
   yes: boolean;
   dryRun?: boolean;
   /** Convert present vendor entrypoints to redirects (consented overwrite). Also
    * accepted on a repository that already has a layer, where it wires only. */
   wireAdapters?: boolean;
   agent?: string;
   name?: string;
   /** Working mode: `solo` scaffolds the identity and writing-style starters.
    * Flag-only for adopt (adopt never reads stdin); omitted means `team`. */
   mode?: WorkingMode;
   /** Skip generating the portable `AGENTS.md` pointer (written by default when
    * absent; an existing file keeps the migrate/--wire-adapters flow). */
   noAgents?: boolean;
}

/** Result of `adoptLayer`: the init result plus what adoption found and did. */
export interface AdoptResult extends InitResult {
   detectedRoot: string;
   /** Vendor files whose content was migrated into the layer. */
   migrated: string[];
   /** A non-redirecting vendor file remains, so the layer is not yet core-conformant. */
   draft: boolean;
   /** The run wired adapters into a layer that already existed (`--wire-adapters`
    * on a repository with a leji.json) instead of adopting a new one. */
   wiredOnly: boolean;
   /** Vendor entrypoints converted to redirects by this run. */
   wired: string[];
}

/** Longest run of consecutive backticks anywhere in `content` (0 if none). */
function longestBacktickRun(content: string): number {
   let longest = 0;
   const runs = content.match(/`+/g);
   if (runs) for (const r of runs) longest = Math.max(longest, r.length);
   return longest;
}

function migrationDoc(sourceRel: string, content: string): string {
   const summary = `Agent instructions migrated verbatim from ${sourceRel}; refine into the right categories.`;
   // Fence the migrated content so raw HTML/Markdown is shown verbatim, never
   // rendered: it can't inject script into the Docsify preview. The fence is one
   // backtick longer than the longest run in the content.
   const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
   return (
      `---\nsummary: ${summary}\n---\n\n# Imported agent instructions (${sourceRel})\n\n` +
      `<!-- Migrated by \`leji adopt\` from ${sourceRel}. Split this into domain/system/practice/governance ` +
      `as appropriate; the original file is unchanged. -->\n\n${fence}\n${content.trim()}\n${fence}\n`
   );
}

function adoptExistingDecision(answers: InitAnswers, migrated: string[]): string {
   const today = new Date().toISOString().slice(0, 10);
   return `---
id: adopt-existing-agent-context
title: Adopt existing agent instructions into the context layer
status: accepted
date: ${today}
deciders:
  - ${answers.ownerName}
---

# Adopt existing agent instructions into the context layer

## Context

This repository already carried agent configuration (${migrated.join(', ')}). That content is team knowledge that belonged in the context layer, not in a per-tool file.

## Decision

Its content was migrated into the layer (see \`${joinUnderRoot(answers.rootPath, 'governance/')}\`). The original file(s) were left unchanged; converting them to one-line redirects is a separate, consented step (\`leji adopt --wire-adapters\`).

## Consequences

The context layer is the single source of truth. Until the vendor entrypoints redirect, the layer does not claim core conformance.
`;
}

/** Adopt an existing docs tree into Leji: migrate vendor entrypoints into the layer
 * (originals untouched), optionally converting them to redirects with `wireAdapters`.
 * Refuses when a layer already exists. */
export async function adoptLayer(options: AdoptOptions): Promise<AdoptResult> {
   if (options.agent) assertAgentHost(options.agent);
   const root = path.resolve(options.dir);
   if (fs.existsSync(path.join(root, 'leji.json'))) {
      // `adopt --yes` prints `leji adopt --wire-adapters` as the step that finishes
      // an adoption draft, and by then the layer exists. Refusing the flag here left
      // that repository non-conformant with no command that could fix it, so the
      // flag wires adapters into the layer already on disk and scaffolds nothing.
      if (options.wireAdapters) return wireAdaptersIntoLayer(root, options);
      throw new Error('leji.json already exists here; this repository already has a Leji layer');
   }
   if (!options.dryRun) assertCleanWorkingTree(root);
   const detected = detectHosts({ root });
   const detectedRoot = detectDocsRoot(root) ?? 'docs/';
   assertRelativePath(detectedRoot);

   const bootRel = `${detectedRoot}boot-profile.md`;
   const canonicalRedirect = adapterContent(bootRel).trim();
   const vendor = verifiedVendorFiles(root);
   const vendorPresent = [...vendor.keys()];
   // Migrate any vendor file not already exactly Leji's redirect, so its content is
   // archived before --wire-adapters overwrites it. A canonical-redirect or empty
   // file has nothing to preserve.
   const notCanonical = (rel: string) => vendor.get(rel)!.trim() !== canonicalRedirect;
   const toMigrate = vendorPresent.filter((rel) => {
      const t = vendor.get(rel)!.trim();
      return t.length > 0 && t !== canonicalRedirect;
   });

   const base = path
      .basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
   const mode: WorkingMode = options.mode ? assertMode(options.mode) : 'team';
   const categories: CategoryId[] = ['domain', 'system'];
   if (toMigrate.length > 0) categories.push('governance');
   categories.push('decisions');
   const answers: InitAnswers = {
      name: options.name ?? `${base}-context`,
      description: 'Shared context layer for this repository.',
      rootPath: detectedRoot,
      ownerName: gitConfig('user.name') ?? '<named owner>',
      ownerContact: gitConfig('user.email') ?? '',
      categories: normalizeCategories(categories, mode),
      level: 'core',
      mode,
      // Resolve every scaffold path against the existing tree so the layer never
      // clobbers existing content. (.leji/ is generated by `leji viewer`, not here.)
      layout: resolveLayout(root, detectedRoot),
   };

   const manifest = buildManifest(answers);
   const r = answers.rootPath;
   const layout = answers.layout ?? defaultLayout(r);

   // Convert only EXISTING vendor entrypoints (never create new ones) not already
   // the canonical redirect; each was captured in toMigrate, so nothing is lost.
   const toConvert = options.wireAdapters ? vendorPresent.filter(notCanonical) : [];
   if (toConvert.length > 0) manifest.vendorAdapters = toConvert;

   const writes: PlannedWrite[] = [{ rel: 'leji.json', content: JSON.stringify(manifest, null, 2) + '\n' }];
   writes.push({ rel: manifest.bootProfilePath, content: buildBootProfile(answers) });
   // The portable discovery adapter, only when no AGENTS.md exists: a present one
   // keeps the migrate/--wire-adapters flow (its content is archived first).
   if (!options.noAgents && !isFile(path.join(root, PORTABLE_ADAPTER))) {
      writes.push({ rel: PORTABLE_ADAPTER, content: adapterContent(manifest.bootProfilePath) });
   }
   for (const category of answers.categories) {
      if (category === 'decisions') continue;
      const stub = CATEGORY_STUBS[category];
      writes.push({
         rel: `${joinUnderRoot(r, category + '/')}${stub.file}`,
         content: categoryStub(stub.title, stub.summary, stub.body),
      });
   }
   if (answers.mode === 'solo') {
      // Solo starters are collision-safe: an existing identity.md or
      // writing-style.md is skipped (skip-exists), never overwritten.
      for (const s of SOLO_STARTERS) {
         writes.push({ rel: `${joinUnderRoot(r, s.category + '/')}${s.file}`, content: readTemplate(s.template) });
      }
   }
   writes.push({ rel: `${joinUnderRoot(r, 'decisions/')}0001-adopt-leji.md`, content: buildFirstDecision(answers) });
   // Stub index file per category so the manifest's `indexes` resolve to real
   // content. (Tree-scan population is the adopt rework that follows.)
   for (const category of answers.categories) {
      writes.push({ rel: `${layout.contextDir}${category}.md`, content: categoryIndexFile(r, category) });
   }
   writes.push({ rel: `${layout.agentsDir}core.md`, content: buildCoreProfile(answers) });
   writes.push({ rel: BRIEF_PATH, content: buildBrief(answers) });

   const migrated: string[] = [];
   const migrationDocByVendor = new Map<string, string>();
   const plannedRels = new Set(writes.map((w) => w.rel));
   const rootReal = guardRoot(root);
   for (const rel of toMigrate) {
      const base = path
         .basename(rel)
         .replace(/\.md$/i, '')
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, '-')
         .replace(/^-|-$/g, '');
      // Disambiguate against BOTH the planned writes and what's on disk, so the
      // migrated copy is never skipped by writeFileOnce (a skipped copy plus
      // --wire-adapters overwriting the entrypoint would lose the original). The
      // on-disk half is decided on the standing entry, never by `existsSync`, which
      // follows symlinks: a dangling candidate would read as a free name and the
      // archive would be written at the link's missing destination. Any standing
      // entry is occupied and the next name is tried (the rule `archivePath` mirrors).
      let slug = base;
      let docRel = `${joinUnderRoot(r, 'governance/')}imported-${slug}.md`;
      for (let n = 2; plannedRels.has(docRel) || !nothingStandsAt(path.join(root, stripSlash(docRel))); n++) {
         slug = `${base}-${n}`;
         docRel = `${joinUnderRoot(r, 'governance/')}imported-${slug}.md`;
      }
      plannedRels.add(docRel);
      writes.push({ rel: docRel, content: migrationDoc(rel, vendor.get(rel)!) });
      migrationDocByVendor.set(rel, docRel);
      migrated.push(rel);
   }
   if (migrated.length > 0) {
      writes.push({
         rel: `${joinUnderRoot(r, 'decisions/')}0002-adopt-existing-agent-context.md`,
         content: adoptExistingDecision(answers, migrated),
      });
   }

   for (const rel of toConvert) writes.push({ rel, content: adapterContent(manifest.bootProfilePath) });

   const wontModify = vendorPresent.filter((rel) => !toConvert.includes(rel));
   // Same reasoning as `init`: the generated index ships with every adoption so the
   // `leji ci` gate passes on the first run.
   const indexRel = effectiveIndexPath(manifest);
   const plan = planWithIndexTruth(
      buildWritePlan(root, [...writes, { rel: indexRel, content: '' }], wontModify, toConvert),
      indexRel,
   );
   const draft = wontModify.some((rel) => !vendor.get(rel)!.includes(bootRel));

   if (options.dryRun) {
      return {
         findings: [],
         written: [],
         manifest,
         mode: answers.mode,
         plan,
         dryRun: true,
         detected,
         detectedRoot,
         migrated,
         draft,
         wiredOnly: false,
         wired: toConvert,
         root,
      };
   }

   const written: string[] = [];
   fs.mkdirSync(root, { recursive: true });
   // The tracked-file preflight and the `.leji/` ignore run BEFORE any write at
   // all, so the private onboarding workspace can never land in git and a failed
   // preflight leaves the tree untouched.
   assertLejiWorkspacePrivate(root);
   ensureLejiGitignored(root);
   writeManifestExclusive(root, path.join(root, 'leji.json'), writes[0].content, 'adopt');
   written.push('leji.json');
   const convert = new Set(toConvert);
   for (const w of writes.slice(1)) {
      if (convert.has(w.rel)) {
         // Never overwrite a vendor entrypoint until its migrated copy is on disk:
         // if the migration write was skipped, leave the original untouched.
         const docRel = migrationDocByVendor.get(w.rel);
         if (docRel && !written.includes(docRel)) continue;
         const abs = safeResolve(root, w.rel);
         guardedOrRefuse(w.rel, writeFileGuarded(guardRoot(root), abs, initRole(w.rel), w.content));
         written.push(w.rel);
      } else {
         writeFileOnce(root, w.rel, w.content, written);
      }
   }
   // Same rule as `leji index`: the file is claimed only when it was written, and
   // the findings travel out so the caller reports them and fails.
   const index = writeIndex(root, manifest);
   if (!hasErrors(index.findings)) written.push(indexRel);
   return {
      findings: index.findings,
      written: written.sort(),
      manifest,
      mode: answers.mode,
      plan,
      dryRun: false,
      detected,
      detectedRoot,
      migrated,
      draft,
      wiredOnly: false,
      wired: toConvert,
      root,
   };
}

/** Where a vendor entrypoint's content is archived under `governance/`: the first
 * free `imported-<slug>.md`, or null when this exact migration doc is already on
 * disk — the normal case, `adopt` having archived it on the first pass. Mirrors the
 * slug and disambiguation rules `adoptLayer` uses. */
function archivePath(root: string, rootPath: string, vendorRel: string, doc: string): string | null {
   const rootReal = guardRoot(root);
   const base = path
      .basename(vendorRel)
      .replace(/\.md$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
   for (let n = 1; ; n++) {
      const rel = `${joinUnderRoot(rootPath, 'governance/')}imported-${n === 1 ? base : `${base}-${n}`}.md`;
      const abs = path.join(root, stripSlash(rel));
      // The candidate is judged on the standing entry and, when one stands, on its
      // verified bytes: a pathname existence check follows symlinks, so a dangling
      // candidate link would read as free and the write would follow it to its missing
      // destination. Nothing standing is free; the identical archive is already on
      // disk; anything else — different bytes, or a standing entry this run cannot
      // verify — is occupied, and the next name is tried.
      if (nothingStandsAt(abs)) return rel;
      const standing = verifiedTargetRead(rootReal, abs, null);
      if (standing.status === 'regular' && standing.bytes.toString('utf8') === doc) return null;
   }
}

/**
 * `leji adopt --wire-adapters` against a repository that already has a layer: the
 * second half of the two-step adoption whose first half prints this command.
 * Converts every present vendor entrypoint that does not already redirect to the
 * boot profile, archiving its content under `governance/` first (the same
 * never-lose-content guarantee `adopt` gives) and skipping the archive when the
 * identical migration doc is already there. Scaffolds nothing, rewrites no manifest,
 * and touches no other file.
 *
 * The clean-tree check `adopt` runs is deliberately skipped: the `adopt` run this
 * finishes is what left the tree dirty, so requiring a clean tree would reinstate
 * the dead end. Content safety comes from the archive, not from git.
 */
async function wireAdaptersIntoLayer(root: string, options: AdoptOptions): Promise<AdoptResult> {
   const load = loadManifest(root);
   const manifest = load.manifest;
   if (!manifest) throw new Error(`leji.json is not a readable layer manifest; run \`leji validate\` for detail`);
   const r = manifest.rootPath;
   const bootRel = manifest.bootProfilePath;
   const redirect = adapterContent(bootRel);
   const vendor = verifiedVendorFiles(root);
   const vendorPresent = [...vendor.keys()];
   const toConvert = vendorPresent.filter((rel) => vendor.get(rel)!.trim() !== redirect.trim());

   // Archives first, so a vendor entrypoint is never overwritten before its content
   // is on disk; an empty file has nothing to preserve.
   const writes: PlannedWrite[] = [];
   const archived: string[] = [];
   for (const rel of toConvert) {
      const content = vendor.get(rel)!;
      if (content.trim() === '') continue;
      const doc = migrationDoc(rel, content);
      const docRel = archivePath(root, r, rel, doc);
      if (docRel === null) continue;
      writes.push({ rel: docRel, content: doc });
      archived.push(rel);
   }
   for (const rel of toConvert) writes.push({ rel, content: redirect });

   const wontModify = vendorPresent.filter((rel) => !toConvert.includes(rel));
   const plan = buildWritePlan(root, writes, wontModify, toConvert);
   // `detected` is empty by construction: wiring finishes an adoption rather than
   // starting one, so this run makes no MCP-install or agent-launch offer.
   const base = {
      manifest,
      mode: 'team' as WorkingMode,
      plan,
      detected: [],
      detectedRoot: r,
      migrated: archived,
      draft: false,
      wiredOnly: true,
      wired: toConvert,
      root,
   };
   if (options.dryRun) return { ...base, findings: [], written: [], dryRun: true };

   const written: string[] = [];
   const rootReal = guardRoot(root);
   for (const w of writes) {
      const abs = safeResolve(root, w.rel);
      guardedOrRefuse(w.rel, writeFileGuarded(rootReal, abs, initRole(w.rel), w.content));
      written.push(w.rel);
   }
   // Only an archive lands inside the layer, so only an archive can stale the stored
   // index; a plain wiring run leaves the generated index (and its timestamp) alone.
   const findings: Finding[] = [];
   if (archived.length > 0) {
      const index = writeIndex(root, manifest);
      findings.push(...index.findings);
      if (!hasErrors(index.findings)) written.push(effectiveIndexPath(manifest));
   }
   return { ...base, findings, written: written.sort(), dryRun: false };
}

/** Post-adopt guidance, printed by the CLI. */
export function enteringAdopted(result: AdoptResult): string {
   if (result.wiredOnly) return enteringWired(result);
   const lines = [enteringTheLayer(result.manifest, result.mode)];
   if (result.migrated.length > 0) {
      lines.push(
         '',
         `Migrated ${result.migrated.join(', ')} into ${joinUnderRoot(result.manifest.rootPath, 'governance/')} (originals untouched); refine into the right categories.`,
      );
   }
   if (result.draft) {
      lines.push(
         '',
         'This is an adoption draft: NOT yet core-conformant, because an existing vendor entrypoint',
         'does not redirect to the boot profile (the spec requires it). Finish with:',
         '',
         '   leji adopt --wire-adapters   # convert them to redirects (their content is already migrated)',
      );
   }
   return lines.join('\n');
}

/** What `adopt --wire-adapters` reports when it wired an existing layer. */
function enteringWired(result: AdoptResult): string {
   if (result.wired.length === 0) {
      return 'Every vendor entrypoint already redirects to the boot profile; nothing to wire.';
   }
   const lines = [`Wired ${result.wired.join(', ')} to redirect to ${result.manifest.bootProfilePath}.`];
   if (result.migrated.length > 0) {
      lines.push(
         '',
         `Archived their previous content in ${joinUnderRoot(result.manifest.rootPath, 'governance/')}; refine into the right categories.`,
      );
   }
   lines.push('', 'The layer should now be core-conformant. Confirm with:', '', '   leji validate');
   return lines.join('\n');
}

/** CLI hosts that accept an inline prompt arg, so Leji can launch the handoff
 * (`claude "..."`, `codex "..."`). Directory-style IDE hosts (Cursor, Windsurf) and
 * unverified prompt syntaxes (Gemini) are left out; when only those are present the
 * offer is skipped. Mirrors the two commands in `enteringTheLayer`. */
const PROMPT_HOST_IDS = ['claude-code', 'codex'];

export interface PromptHost {
   id: string;
   bin: string;
   name: string;
}

/** Detected hosts (on PATH) that can be launched with an inline prompt, ranked. */
function promptCapableHosts(detected: DetectedHost[]): PromptHost[] {
   const out: PromptHost[] = [];
   for (const h of detected) {
      if (!h.onPath || !PROMPT_HOST_IDS.includes(h.id)) continue;
      const spec = HOST_SPECS.find((s) => s.id === h.id);
      if (spec) out.push({ id: h.id, bin: spec.bins[0], name: spec.name });
   }
   return out;
}

/** The launchable host an `--agent` value names (id or alias), or null when it
 * names none. Detection state is irrelevant: the value is either a host Leji can
 * launch or it is not. */
function resolvePromptHost(agent: string): PromptHost | null {
   const id = resolveHostId(agent);
   const spec = id !== undefined && PROMPT_HOST_IDS.includes(id) ? HOST_SPECS.find((s) => s.id === id) : undefined;
   return spec ? { id: spec.id, bin: spec.bins[0], name: spec.name } : null;
}

/** Reject an `--agent` value naming no launchable host, the way `--mode` and
 * `--level` reject unknown values: the accepted set is named and the command
 * fails. Silently accepting it made `--agent nosuchhost` behave as if the flag
 * were never passed. */
function assertAgentHost(agent: string): PromptHost {
   const host = resolvePromptHost(agent);
   if (!host) throw new Error(`--agent must be a launchable host (${PROMPT_HOST_IDS.join(', ')}); got "${agent}"`);
   return host;
}

/** Injectable I/O for the handoff offer, so the interactive flow is deterministically
 * testable. Production is `defaultHandoffIo`; tests pass a fake. */
export interface HandoffIo {
   /** Prompt and read one trimmed line; '' means accept the default (or EOF). */
   readLine(question: string, fallback: string): Promise<string>;
   /** Launch the chosen agent with the brief prompt; mirrors spawnSync's result.
    * `error` = never started; non-zero `status`/`signal` = started but unclean.
    * Either way the caller falls back to printed instructions. */
   launch(
      bin: string,
      promptArg: string,
      cwd?: string,
      hostArgs?: string[],
   ): { error?: Error; status?: number | null; signal?: NodeJS.Signals | null };
   /** Run a host subcommand (the MCP presence check / register) or a bounded probe
    * from `cwd`, returning spawnSync's shape. `quiet` suppresses child output (the
    * check); otherwise the child inherits the terminal so the user sees the host's
    * own output. `capture` reads stdout back instead — bounded by `timeoutMs` and
    * `maxBytes`, with stdin closed and stderr discarded — which is what the preflight
    * version probe needs; `env`, when given, REPLACES the environment entirely
    * (nothing of this process's is inherited), which is how the probe stays
    * sanitized. */
   run(
      bin: string,
      args: string[],
      cwd: string | undefined,
      opts: {
         quiet: boolean;
         capture?: boolean;
         timeoutMs?: number;
         maxBytes?: number;
         env?: Record<string, string>;
      },
   ): { error?: Error; status?: number | null; signal?: NodeJS.Signals | null; stdout?: string };
}

/** Real handoff I/O: a one-shot stdin line reader and a stdio-inherit spawn. Exported
 * so one command can build it once and hand the same IO to every step of its flow. */
export function defaultHandoffIo(): HandoffIo {
   return {
      async readLine(question, fallback) {
         const reader = new LineReader();
         try {
            process.stdout.write(`${question} [${fallback}]: `);
            const a = await reader.next();
            return a === EOF ? '' : a.trim();
         } finally {
            // Close before any launch so nothing holds stdin when the child inherits
            // the terminal.
            reader.close();
         }
      },
      launch(bin, promptArg, cwd, hostArgs) {
         // cwd anchors the agent at the layer root so a relative prompt path
         // resolves (matters for `leji start --root <dir>`). Host flags (from
         // `leji start -- <flags>`) go before the prompt argument.
         return spawnSync(bin, [...(hostArgs ?? []), promptArg], { stdio: 'inherit', cwd });
      },
      run(bin, args, cwd, opts) {
         if (!opts.capture) {
            const plain = spawnSync(bin, args, { stdio: opts.quiet ? 'ignore' : 'inherit', cwd });
            return { error: plain.error, status: plain.status, signal: plain.signal };
         }
         // A captured run is a probe: stdin closed so nothing can prompt, stderr
         // discarded, output and wall time bounded. Exceeding either bound comes back
         // as `error`, which every caller treats as a failed probe.
         const res = spawnSync(bin, args, {
            stdio: ['ignore', 'pipe', 'ignore'],
            cwd,
            encoding: 'utf8',
            timeout: opts.timeoutMs,
            maxBuffer: opts.maxBytes,
            // The probe supplies its whole environment; nothing of ours is inherited.
            env: opts.env ?? process.env,
         });
         return { error: res.error, status: res.status, signal: res.signal, stdout: res.stdout ?? '' };
      },
   };
}

/** Ask which of several detected hosts to launch (numbered), or none. */
async function pickFromMultiple(hosts: PromptHost[], io: HandoffIo): Promise<PromptHost | null> {
   console.log('\nDetected coding agents on your PATH:');
   hosts.forEach((h, i) => console.log(`   ${i + 1}) ${h.name}`));
   const a = (await io.readLine('Which agent? (number, or Enter to skip)', 'skip')).toLowerCase();
   // Require an explicit in-range number; empty/n/junk/out-of-range skip, so we
   // never launch an agent the user did not pick.
   if (a === '' || a === 'n' || a === 'no') return null;
   const idx = Number(a) - 1;
   return Number.isInteger(idx) && idx >= 0 && idx < hosts.length ? hosts[idx] : null;
}

/** Launch a chosen host with `promptArg` from `cwd`. Returns true only on a clean
 * exit; a spawn failure or non-zero/signalled exit returns false so the caller
 * falls back to printed instructions. */
function launchHost(host: PromptHost, promptArg: string, io: HandoffIo, cwd?: string, hostArgs?: string[]): boolean {
   const argsShown = hostArgs && hostArgs.length > 0 ? `${hostArgs.join(' ')} ` : '';
   console.log(`\nStarting ${host.name}: ${host.bin} ${argsShown}"${promptArg}"\n`);
   const res = io.launch(host.bin, promptArg, cwd, hostArgs);
   if (res.error) {
      console.error(`\nleji: could not start ${host.bin} (${res.error.message}).`);
      return false;
   }
   return res.signal == null && (res.status == null || res.status === 0);
}

/** Ask which detected host to hand off to (or none): a single host confirms [Y/n]. */
async function chooseHost(hosts: PromptHost[], promptArg: string, io: HandoffIo): Promise<PromptHost | null> {
   if (hosts.length === 1) {
      const h = hosts[0];
      const a = (
         await io.readLine(`Hand the scaffold to ${h.name} now (${h.bin} "${promptArg}")?`, 'Y/n')
      ).toLowerCase();
      return a === '' || a === 'y' || a === 'yes' ? h : null;
   }
   return pickFromMultiple(hosts, io);
}

/** After a scaffold is written, offer to hand it to a detected agent and launch it.
 * Interactive only (TTY, not --yes, at least one prompt-capable host on PATH).
 * Returns true when an agent was launched (caller prints nothing further), false to
 * fall back to printed instructions. Never fires non-interactively, so scripted/CI
 * output and cross-SDK parity are unchanged. */
export async function handoffOffer(
   manifest: Manifest,
   detected: DetectedHost[],
   interactive: boolean,
   io: HandoffIo = defaultHandoffIo(),
   agent?: string,
   cwd?: string,
   mcpOutcome: McpOfferOutcome = { next: 'default' },
): Promise<boolean> {
   if (!interactive) return false;
   const hosts = promptCapableHosts(detected);
   const promptArg = `Read ./${BRIEF_PATH} and follow it.`;
   // --agent forces a specific launchable host (skipping the prompt); otherwise the
   // detected hosts drive the offer.
   let chosen: PromptHost | null;
   if (agent) {
      chosen = assertAgentHost(agent);
   } else if (mcpOutcome.next === 'skip') {
      // The user declined the host pick during the MCP offer; don't re-ask.
      return false;
   } else if (mcpOutcome.next === 'launch') {
      // The pick already happened during the MCP offer; launch the same host, so
      // the registered MCP server and the launched agent never diverge.
      chosen = mcpOutcome.host;
   } else {
      if (hosts.length === 0) return false;
      chosen = await chooseHost(hosts, promptArg, io);
   }
   if (!chosen) return false;
   // Anchor the launch at the layer root so the brief's relative path resolves
   // under `leji init/adopt --dir <x>` run from elsewhere.
   return launchHost(chosen, promptArg, io, cwd);
}

/** Options for `offerDependency`, the post-scaffold declaration offer. */
export interface DependencyOfferOptions {
   /** Absolute layer root: the cwd the manager runs in, so its manifest and lock
    * edits land in this repository and nowhere else. */
   root: string;
   report: EcosystemReport;
   /** A real TTY, not --yes, and not --json; the manager never runs otherwise. */
   interactive: boolean;
   io?: HandoffIo;
}

/**
 * What the declaration step did. `ran` means the add was consented to and
 * attempted: with `exitCode: null` and `signal: null` it never started at all
 * (spawn error), which counts as a failure exactly like a non-zero exit.
 */
export interface DependencyOffer {
   offered: boolean;
   ran: boolean;
   command: string[] | null;
   exitCode: number | null;
   signal: string | null;
}

/** True when a consented add did not succeed, so the command must not exit 0: the
 * layer is written but the durable setup the run promised was not reached. */
export function dependencyAddFailed(offer: DependencyOffer): boolean {
   return offer.ran && (offer.exitCode !== 0 || offer.signal !== null);
}

/**
 * After the scaffold is written, tell the user how a clean install of this
 * repository will bring `leji`, and offer to run their own package manager's add
 * command. leji writes no manifest or lockfile byte itself: the manager owns both
 * formats, so the only thing that changes the repository here is a command the
 * user explicitly accepted.
 *
 * The block is ALWAYS printed (this function is simply not called under `--json`,
 * which is a single-document mode). The prompt fires only when the run is
 * interactive, an add command exists for the detected manager, and the CLI is not
 * already declared. Never a shell: argv, cwd, inherited stdio, through the
 * injectable `io.run` the tests replace with a fake.
 */
export async function offerDependency(opts: DependencyOfferOptions): Promise<DependencyOffer> {
   const text = ECOSYSTEM_TEXT.consent;
   console.log('\n' + renderEcosystemBlock(opts.report));
   const selected = opts.report.selected;
   const command = selected?.add ?? null;
   const offered = command !== null && !selected!.directDeclared;
   const skipped: DependencyOffer = { offered, ran: false, command, exitCode: null, signal: null };
   if (!offered || !opts.interactive) return skipped;

   const io = opts.io ?? defaultHandoffIo();
   // Consent is only consent if it is informed: the manager runs here, as this user,
   // with this environment, and does whatever it normally does.
   console.log(text.disclosure(command[0]));
   const answer = (await io.readLine(text.prompt, 'Y/n')).toLowerCase();
   if (!(answer === '' || answer === 'y' || answer === 'yes')) {
      console.log(text.declined);
      console.log(text.command(command));
      return skipped;
   }
   console.log(text.running(command));
   const res = io.run(command[0], command.slice(1), opts.root, { quiet: false });
   const exitCode = res.status ?? null;
   const signal = res.signal ?? null;
   const outcome: DependencyOffer = { offered, ran: true, command, exitCode, signal };
   // A spawn that never started surfaces as `error`, never as an exit code, so it
   // is reported as a missing binary rather than as a failed add.
   if (res.error) {
      console.log(text.missing(command[0]));
      console.log(text.command(command));
      return { ...outcome, exitCode: null, signal: null };
   }
   if (signal !== null) {
      console.log(text.signaled(command[0], signal));
      console.log(text.command(command));
      return outcome;
   }
   if (exitCode !== 0) {
      console.log(text.exited(command[0], exitCode ?? 1));
      console.log(text.command(command));
      return outcome;
   }
   console.log(text.declared(selected!.ecosystem));
   return outcome;
}

/** Options for `offerMcpInstall`, the pre-handoff MCP registration offer. */
export interface McpOfferOptions {
   /** Absolute layer root: the cwd for the check/register, so a project-scoped write
    * (Claude's `.mcp.json`) lands in this repository. */
   root: string;
   detected: DetectedHost[];
   /** A real TTY and not --yes; the offer never fires otherwise. */
   interactive: boolean;
   io?: HandoffIo;
   /** --agent: force a specific launchable host (claude-code/codex). */
   agent?: string;
}

/** How the handoff should proceed after the MCP offer resolved its target host:
 * `default` follows the handoff's own flow (single host / --agent / nothing to
 * launch), `launch` starts the host the user already picked here, and `skip`
 * suppresses the handoff (the user declined the pick). */
export type McpOfferOutcome = { next: 'default' } | { next: 'launch'; host: PromptHost } | { next: 'skip' };

/** Before the init/adopt handoff launches an agent, offer to register the local Leji
 * MCP server for the launchable host, so the launched session gains native spec +
 * validation tools. Interactive-only, and skipped when the server is already
 * registered (a quiet presence check), so it never nags or fires in scripts/CI.
 * With several hosts detected the pick happens ONCE, here, and the returned outcome
 * carries it into `handoffOffer`, so the registered MCP server and the launched
 * agent never diverge. Never throws: a failed check or register falls back to a
 * printed manual command. */
export async function offerMcpInstall(opts: McpOfferOptions): Promise<McpOfferOutcome> {
   if (!opts.interactive) return { next: 'default' };
   const io = opts.io ?? defaultHandoffIo();
   // Resolve the one host this session targets: --agent forces it, a single
   // detected host is it, several ask (numbered, same as the handoff pick).
   let target: PromptHost | null = null;
   let picked = false;
   if (opts.agent) {
      target = resolvePromptHost(opts.agent);
      // An unknown --agent stays 'default': handoffOffer raises the proper error.
      if (!target) return { next: 'default' };
   } else {
      const hosts = promptCapableHosts(opts.detected);
      if (hosts.length === 0) return { next: 'default' };
      if (hosts.length === 1) {
         target = hosts[0];
      } else {
         target = await pickFromMultiple(hosts, io);
         if (!target) return { next: 'skip' };
         picked = true;
      }
   }
   const outcome: McpOfferOutcome = picked ? { next: 'launch', host: target } : { next: 'default' };
   const spec = HOST_SPECS.find((s) => s.id === target.id);
   if (!spec?.mcpAdd) return outcome;
   // Skip the offer when already registered (exit 0), so re-running init/adopt never
   // re-nags — but say so: a silent skip is indistinguishable from the offer being broken.
   // A failed check (e.g. an older host CLI) falls through to the offer.
   if (spec.mcpCheck) {
      const chk = io.run(target.bin, spec.mcpCheck, opts.root, { quiet: true });
      if (!chk.error && chk.status === 0) {
         console.log(`Leji MCP server already registered for ${target.name}; skipping the install offer.`);
         return outcome;
      }
   }
   const scopeNote =
      target.id === 'codex'
         ? ' (writes ~/.codex config, user-level)'
         : ' (writes .mcp.json here; commit it to share with your team)';
   const answer = (
      await io.readLine(
         `Register the Leji MCP server for ${target.name} so the agent can retrieve the spec and validate natively?${scopeNote}`,
         'Y/n',
      )
   ).toLowerCase();
   if (!(answer === '' || answer === 'y' || answer === 'yes')) return outcome;
   const res = io.run(target.bin, spec.mcpAdd, opts.root, { quiet: false });
   if (res.error) {
      console.error(
         `\nleji: could not run ${target.bin} (${res.error.message}); register it manually:\n   ${target.bin} ${spec.mcpAdd.join(' ')}`,
      );
      return outcome;
   }
   if (res.signal == null && (res.status == null || res.status === 0)) {
      console.log(`Registered the Leji MCP server for ${target.name}.`);
   } else {
      console.log(
         `${target.bin} did not register cleanly; it may already be present, or add it manually:\n   ${target.bin} ${spec.mcpAdd.join(' ')}`,
      );
   }
   return outcome;
}

/** The boot prompt `leji start` hands the agent: point it at the boot profile. */
function bootPrompt(bootRel: string): string {
   return `Read ./${bootRel}, follow it, and tell me when you're ready.`;
}

/** The onboarding approval guard: a transient Claude Code PreToolUse hook that
 * counters the ask-prompt pattern. AskUserQuestion stays blocked until the
 * proposal is written to .leji/work/proposal.md AND printed as message
 * text; the corrective message lands at the action boundary, where instruction
 * reliably reaches the model. Self-disabling once the onboarding brief is gone;
 * the finalize step removes it entirely. */
export const PROPOSAL_MARKER = '# Proposal for approval';

function approvalGuardScript(lejiRel: string): string {
   return `#!/usr/bin/env node
// Leji onboarding approval guard (transient; Claude Code PreToolUse hook on
// AskUserQuestion). The approval prompt stays blocked until the proposal is
// written to ${lejiRel}/proposal.md AND printed as plain message text.
// Self-disabling: once the onboarding brief is gone it always allows.
// Removed at finalize; safe to delete at any time.
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const lejiDir = path.join(root, ${JSON.stringify(lejiRel)});
if (read(path.join(lejiDir, 'onboarding-brief.md')) === null) process.exit(0);
const MARKER = ${JSON.stringify(PROPOSAL_MARKER)};
const proposal = read(path.join(lejiDir, 'proposal.md'));
let printed = false;
if (proposal !== null && proposal.includes(MARKER)) {
   let stdin = '';
   try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no hook input */ }
   let transcriptPath = null;
   try { transcriptPath = JSON.parse(stdin).transcript_path ?? null; } catch { /* not json */ }
   const transcript = transcriptPath ? read(transcriptPath) : null;
   if (transcript === null) {
      printed = true; // no transcript to inspect: the artifact stands as evidence
   } else {
      // "Printed" means the reply itself carries the proposal: the marker must
      // appear in one of the last few assistant text blocks, not in a plan,
      // a file diff, or the artifact alone.
      const texts = [];
      for (const line of transcript.trim().split('\\n')) {
         let entry;
         try { entry = JSON.parse(line); } catch { continue; }
         if (entry.type !== 'assistant') continue;
         const chunk = (entry.message?.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\\n');
         if (chunk.trim() !== '') texts.push(chunk);
      }
      printed = texts.slice(-3).some((c) => c.includes(MARKER));
   }
}
if (printed) process.exit(0);
console.error(
   'Approval blocked by the Leji onboarding guard: write the full proposal to ' +
   ${JSON.stringify(lejiRel)} + '/proposal.md (first line "' + MARKER + '"), print that same ' +
   'content as plain text in your reply, then retry this question unchanged.',
);
process.exit(2);
`;
}

export type GuardAction = 'installed' | 'unchanged';

/** Write the guard script under the onboarding workspace (`.leji/work/hooks/`) and
 * merge its PreToolUse entry into .claude/settings.json (created if absent, other
 * settings preserved). Idempotent: an existing guard entry is left untouched.
 * `rootPath` no longer selects the workspace — it is one root-relative tree — and
 * is kept only so the exported signature holds. */
export function ensureApprovalGuard(root: string, rootPath: string): GuardAction {
   void rootPath;
   const rootAbs = path.resolve(root);
   const lejiRel = WORK_REL;
   const scriptRel = `${lejiRel}/hooks/approval-guard.mjs`;
   const scriptAbs = path.join(rootAbs, scriptRel);
   guardWithinRoot(rootAbs, scriptAbs, scriptRel);

   const settingsRel = '.claude/settings.json';
   const settingsAbs = path.join(rootAbs, settingsRel);
   guardWithinRoot(rootAbs, settingsAbs, settingsRel);
   let settings: Record<string, unknown> = {};
   // The settings file is parsed, merged, and written back, so its bytes come from the
   // verified read rather than from the pathname the merge later writes to.
   const existing = readMergeSource(guardRoot(rootAbs), settingsAbs, settingsRel);
   if (existing !== null && existing.trim() !== '') {
      try {
         settings = JSON.parse(existing) as Record<string, unknown>;
      } catch {
         throw new Error(`${settingsRel} is not valid JSON; fix it before installing the onboarding guard`);
      }
   }
   const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
   const pre = (hooks.PreToolUse ??= []) as { matcher?: string; hooks?: { command?: string }[] }[];
   const present = pre.some((e) => (e.hooks ?? []).some((h) => (h.command ?? '').includes('approval-guard.mjs')));
   writeFileAtomic(rootAbs, scriptAbs, scriptRel, approvalGuardScript(lejiRel));
   if (present) return 'unchanged';
   pre.push({
      matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${scriptRel}"` } as { command?: string }],
   });
   writeFileAtomic(rootAbs, settingsAbs, settingsRel, JSON.stringify(settings, null, 2) + '\n');
   return 'installed';
}

/** Options for `offerApprovalGuard`: the consent-gated install offer, made only
 * when the resolved launch host is Claude Code (the host whose prompt pattern
 * the guard counters). */
export interface GuardOfferOptions {
   root: string;
   rootPath: string;
   detected: DetectedHost[];
   interactive: boolean;
   agent?: string;
   io?: HandoffIo;
}

/** Offer the onboarding approval guard for a Claude Code handoff. Silent when
 * non-interactive or the host is not Claude Code; says so when already
 * installed (a silent skip is indistinguishable from broken). */
export async function offerApprovalGuard(opts: GuardOfferOptions): Promise<void> {
   if (!opts.interactive) return;
   let hostId: string | null = null;
   if (opts.agent) {
      hostId = resolveHostId(opts.agent) ?? null;
   } else {
      const hosts = promptCapableHosts(opts.detected);
      if (hosts.length === 1) hostId = hosts[0].id;
      else if (hosts.length > 1 && hosts.some((h) => h.id === 'claude-code')) hostId = 'claude-code';
   }
   if (hostId !== 'claude-code') return;
   const io = opts.io ?? defaultHandoffIo();
   const answer = (
      await io.readLine(
         'Add the temporary onboarding guard for Claude Code, in this repository only? It has the agent print its proposal before asking for approval. Writes two project-local files (a hook entry in this repo\u2019s .claude/settings.json, a script in the gitignored .leji/work/ workspace); nothing outside this repository is touched, and the finalize step removes both',
         'Y/n',
      )
   ).toLowerCase();
   if (!(answer === '' || answer === 'y' || answer === 'yes')) return;
   const action = ensureApprovalGuard(opts.root, opts.rootPath);
   console.log(
      action === 'installed'
         ? 'Onboarding guard added (this repository only: .claude/settings.json hook + .leji/work/hooks/approval-guard.mjs; removed at finalize).'
         : 'Onboarding guard already present in this repository; refreshed the script.',
   );
}

/** Outcome of `enterLayer`: an agent launched cleanly, fell back to printed
 * commands (nothing to launch), or the boot profile is missing/invalid. */
export type StartOutcome = 'launched' | 'fallback' | 'boot-missing';

/** Options for `enterLayer` (the `leji start` command). */
export interface StartOptions {
   root: string;
   manifest: Manifest;
   detected: DetectedHost[];
   /** --agent: force a specific launchable host (claude-code/codex). */
   agent?: string;
   /** A real TTY and not --yes; required to launch an interactive agent. */
   interactive: boolean;
   /** Extra arguments passed verbatim to the launched host binary, before the
    * prompt (from `leji start -- <flags>`, e.g. Claude Code's --chrome). */
   hostArgs?: string[];
   /** The host the caller already resolved, so the preflight report can name it
    * before the launch takes the terminal. `undefined` resolves it here as before;
    * `null` is an explicit "no host", which falls back to the printed commands. */
   host?: PromptHost | null;
   io?: HandoffIo;
}

/** Whether the manifest's boot profile is a safe relative path that actually exists:
 * the one condition `leji start` refuses to run under, checked before anything is
 * reported or launched. */
export function bootProfileReady(root: string, manifest: Manifest): boolean {
   const bootRel = manifest.bootProfilePath;
   return RELATIVE_PATH_RE.test(bootRel) && isFile(path.join(path.resolve(root), bootRel));
}

/** Which host `leji start` targets: `--agent` forces one, a single detected
 * prompt-capable host is it, and several ask (interactive only). Split out of
 * `enterLayer` so the preflight can report on the host this run has actually
 * selected. Throws on an unknown or non-launchable `--agent`, as before. */
export async function resolveStartHost(opts: {
   detected: DetectedHost[];
   agent?: string;
   interactive: boolean;
   io?: HandoffIo;
}): Promise<PromptHost | null> {
   if (opts.agent) return assertAgentHost(opts.agent);
   const hosts = promptCapableHosts(opts.detected);
   if (hosts.length === 1) return hosts[0];
   if (hosts.length > 1 && opts.interactive) return pickFromMultiple(hosts, opts.io ?? defaultHandoffIo());
   return null;
}

/** The detected hosts `leji start` could launch, ranked — what the preflight names
 * when several are present and none was picked. */
export function startHosts(detected: DetectedHost[]): PromptHost[] {
   return promptCapableHosts(detected);
}

/** `leji start`: boot a coding agent into an existing layer, pointed at the boot
 * profile. One detected host launches directly; several prompt; `--agent` forces one.
 * Launches from the layer root so the relative boot path resolves. Returns 'launched',
 * 'fallback' (nothing to launch / non-interactive / launch failed), or 'boot-missing'
 * (boot path unsafe or absent). Throws on an unknown/non-launchable --agent. */
export async function enterLayer(opts: StartOptions): Promise<StartOutcome> {
   const root = path.resolve(opts.root);
   if (!bootProfileReady(root, opts.manifest)) return 'boot-missing';
   const io = opts.io ?? defaultHandoffIo();
   const promptArg = bootPrompt(opts.manifest.bootProfilePath);

   // A caller that already resolved the host (the preflight names it before the
   // launch) passes it in; `undefined` means resolve it here, as before.
   const host =
      opts.host !== undefined
         ? opts.host
         : await resolveStartHost({ detected: opts.detected, agent: opts.agent, interactive: opts.interactive, io });

   if (!host || !opts.interactive) return 'fallback';
   return launchHost(host, promptArg, io, root, opts.hostArgs) ? 'launched' : 'fallback';
}

/** Printed when `leji start` launches nothing (no agent, non-interactive, or a
 * failed launch): the copy-paste commands to enter the layer via the boot profile. */
export function enteringViaBoot(manifest: Manifest, hostArgs?: string[]): string {
   const promptArg = bootPrompt(manifest.bootProfilePath);
   // Host flags the user asked for (leji start -- <flags>) stay in the printed
   // commands, so the copy-paste path launches what the direct path would have.
   const flagsShown = hostArgs && hostArgs.length > 0 ? `${hostArgs.join(' ')} ` : '';
   return [
      '',
      'No coding agent was launched. To enter this context layer, run one of:',
      '',
      `   claude ${flagsShown}"${promptArg}"`,
      `   codex ${flagsShown}"${promptArg}"`,
      '',
      'Each points the agent at the boot profile, which loads the team context before any work.',
   ].join('\n');
}

/** Post-init guidance, printed by the CLI. The team copy is unchanged from
 * pre-mode releases; solo swaps one sentence to name the interview. */
export function enteringTheLayer(manifest: Manifest, mode: WorkingMode = 'team'): string {
   const brief = BRIEF_PATH;
   const how =
      mode === 'solo'
         ? [
              'The brief teaches the agent the Leji spec and points it at this repo: it reads your',
              'code, interviews you for identity and writing style (answer in text or drop files),',
              'and fills in real context. Prefer to do it yourself?',
           ]
         : [
              'The brief teaches the agent the Leji spec and points it at this repo: it reads your',
              'code, asks what it cannot infer, and fills in real context. Prefer to do it yourself?',
           ];
   return [
      '',
      'The scaffold is in place, but the content is still placeholder. Hand it to your agent',
      'to populate from your actual repository:',
      '',
      `   claude "Read ./${brief} and follow it."`,
      `   codex "Read ./${brief} and follow it."`,
      '',
      ...how,
      'Edit the seeded documents directly. Either way, check progress with:',
      '',
      '   leji validate --content   # placeholder / thin-content warnings',
      '   leji conformance          # the level reached and what is next',
   ].join('\n');
}
