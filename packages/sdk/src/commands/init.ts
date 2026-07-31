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
import { exists, isDir, isFile, joinUnderRoot, readText, resolvedWithinRoot, stripSlash, toPosix } from '../lib/fsx.js';
import { type PlanEntry, type PlannedWrite, buildWritePlan } from '../lib/writeplan.js';
import {
   type DetectedHost,
   HOST_SPECS,
   PORTABLE_ADAPTER,
   adapterContent,
   detectHosts,
   resolveHostId,
} from '../lib/detect.js';
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

/** Pick the first candidate name (under rootPath) that does not already exist on
 * disk, so `adopt` never writes its scaffold over a repo's existing content. */
function resolveScaffoldPath(root: string, rootPath: string, name: string, alternates: string[], dir: boolean): string {
   const suffix = dir ? '/' : '';
   for (const candidate of [name, ...alternates]) {
      const rel = joinUnderRoot(rootPath, candidate + suffix);
      if (!exists(path.join(root, stripSlash(rel)))) return rel;
   }
   for (let n = 2; ; n++) {
      const rel = joinUnderRoot(rootPath, `${name}-${n}${suffix}`);
      if (!exists(path.join(root, stripSlash(rel)))) return rel;
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

function writeFileOnce(rootAbs: string, rel: string, content: string, written: string[]): void {
   const abs = safeResolve(rootAbs, rel);
   if (!resolvedWithinRoot(rootAbs, abs)) {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
   if (fs.existsSync(abs)) return;
   fs.mkdirSync(path.dirname(abs), { recursive: true });
   fs.writeFileSync(abs, content);
   written.push(rel);
}

/** Ensure the root .gitignore ignores `.leji/` (generated viewer + transient
 * brief). Idempotent and matches the exact line, so a comment or `docs/.leji/`
 * is not treated as equivalent. */
function ensureLejiGitignored(rootAbs: string): void {
   const abs = path.join(rootAbs, '.gitignore');
   const entry = '.leji/';
   const text = isFile(abs) ? readText(abs) : '';
   if (text.split('\n').includes(entry)) return;
   if (text === '') {
      fs.writeFileSync(abs, entry + '\n');
   } else {
      fs.writeFileSync(abs, text + (text.endsWith('\n') ? '' : '\n') + entry + '\n');
   }
}

/** Refuse to write the transient onboarding workspace while any file under
 * `<rootPath>/.leji/` is tracked by git: tracked means the ignore boundary is
 * not intact, and private artifacts could land in history. The fix is the
 * owner's call (git rm --cached), never run silently. */
function assertLejiWorkspacePrivate(root: string, rootPath: string): void {
   const lejiDir = joinUnderRoot(rootPath, '.leji/');
   const tracked = trackedUnder(root, stripSlash(lejiDir));
   if (tracked && tracked.length > 0) {
      throw new Error(
         `${tracked.length} file(s) under ${lejiDir} are tracked by git; untrack them (git rm --cached) so onboarding artifacts stay private`,
      );
   }
}

/** Create leji.json with O_EXCL (`wx`) so check-then-write is atomic: a concurrent
 * run or a planted symlink can't be overwritten or followed. EEXIST surfaces as the
 * same "already exists" error as the entry point's initial guard. */
function writeManifestExclusive(abs: string, content: string, mode: 'init' | 'adopt'): void {
   try {
      fs.writeFileSync(abs, content, { flag: 'wx' });
   } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
         throw new Error(
            mode === 'adopt'
               ? 'leji.json already exists here; this repository already has a Leji layer'
               : 'leji.json already exists here; init refuses to overwrite an existing layer',
         );
      }
      throw e;
   }
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

Engineering knowledge lived in heads, chat threads, and per-tool config files. People and agents had no single place to read how this team thinks.

## Decision

Adopt Leji at the \`${answers.level}\` level: ${indexedLine}.

## Consequences

Vendor config files become one-line redirects. Context fixes ride the same review gate as the work that surfaces them. ${answers.ownerName} owns the layer.
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
 * is '', so a "." root yields `.leji/...`, not `..leji/`) and stamped with the
 * working mode so the agent runs the right interview without re-asking. */
function buildBrief(answers: InitAnswers): string {
   return readTemplate('onboarding-brief.md')
      .replaceAll('<root>/', joinUnderRoot(answers.rootPath, ''))
      .replaceAll('<mode>', answers.mode);
}

/** Path of the transient onboarding brief, under a dot-directory so it is
 * excluded from the index, the viewer, and the changelog. */
export function briefPath(rootPath: string): string {
   return joinUnderRoot(rootPath, '.leji/onboarding-brief.md');
}

/** The CI workflow path, relative to the repository root. */
export const CI_WORKFLOW_PATH = '.github/workflows/leji.yml';
export const GITLAB_CI_PATH = '.gitlab-ci.yml';
export const CIRCLECI_CONFIG_PATH = '.circleci/config.yml';
export const AZURE_PIPELINE_PATH = '.azure-pipelines/leji.yml';

const GITLAB_MARKER_START = '# >>> leji ci (managed) >>>';
const GITLAB_MARKER_END = '# <<< leji ci (managed) <<<';

// The npm package name; its presence in the repo's package.json selects the
// local-first CI and hook variants over the `npx @leji-org/leji@1` fallback.
const DEP_NAME = '@leji-org/leji';

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
// The failure message is single-quoted for the SHELL, not just for this template
// literal: the backticks around `leji index` are literal text, and inside a
// double-quoted echo sh would run them as a command substitution (regenerating the
// index the hook just refused a commit over). Never emit an unquoted backtick,
// `$(`, or `$VAR` into generated shell unless expansion is the intent.
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
# Validate the context layer and refuse a commit that would leave the stored
# index stale. Local mirror of the CI gate, preferring a repo-local install;
# delete this file to opt out.
LEJI="leji"
[ -x "node_modules/.bin/leji" ] && LEJI="node_modules/.bin/leji"
"$LEJI" validate || exit 1
"$LEJI" index --check || {
   echo 'leji: stored index is stale; run \`leji index\` and stage the result.' >&2
   exit 1
}
`;

const HUSKY_MARKER_START = '# >>> leji hooks (managed) >>>';
const HUSKY_MARKER_END = '# <<< leji hooks (managed) <<<';
// The same two gates HOOK_BODY runs (preferring a repo-local install), wrapped in
// markers so the block can be merged into a husky repo's hand-authored
// `.husky/pre-commit` without touching its rest.
const HUSKY_BLOCK = `${HUSKY_MARKER_START}
LEJI="leji"
[ -x "node_modules/.bin/leji" ] && LEJI="node_modules/.bin/leji"
"$LEJI" validate || exit 1
"$LEJI" index --check || {
   echo 'leji: stored index is stale; run \`leji index\` and stage the result.' >&2
   exit 1
}
${HUSKY_MARKER_END}
`;

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

/** Write a managed pre-commit hook running the same checks CI runs, so drift is
 * caught before a commit instead of at the pipeline. The write location is git's
 * effective hooks dir (`rev-parse --git-path hooks`); core.hooksPath decides whether
 * a husky repo gets a managed block in the user-editable `.husky/pre-commit` (v8/v9)
 * or a standalone managed hook is written. A hooks dir resolving outside the repo (a
 * global `core.hooksPath`) is never written — the snippet comes back for a manual
 * hand-add, as does an existing unmanaged hook. */
export function ensureLocalHook(root: string): HookResult {
   const rootAbs = path.resolve(root);
   const hooksDir = gitHooksDir(rootAbs);
   if (hooksDir === null) throw new Error('not a git repository (no .git directory); hooks need one');
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
         snippet: shape ? HUSKY_BLOCK : HOOK_BODY,
         managed: shape ? 'block' : 'file',
         reason: 'outside-root',
      };
   }
   const rel = toPosix(path.relative(rootAbs, target));
   return shape ? ensureHuskyBlock(target, rel, shape === 'direct') : ensureHookFile(target, rel);
}

/** Write/refresh the standalone managed pre-commit hook at `hookAbs`. Ours (marker
 * present) is created/updated; an existing unmanaged hook is never touched and its
 * replacement snippet comes back for a manual merge. */
function ensureHookFile(hookAbs: string, rel: string): HookResult {
   const existing = isFile(hookAbs) ? readText(hookAbs) : null;
   if (existing !== null && !existing.includes(HOOK_MARKER)) {
      return { path: rel, action: 'manual', snippet: HOOK_BODY, managed: 'file', reason: 'foreign-hook' };
   }
   if (existing === HOOK_BODY) {
      // Byte-current. A standalone hook is run by git itself, so a non-executable
      // file is a mode-only correction reported updated, not unchanged.
      if (!isExecutable(hookAbs)) {
         fs.chmodSync(hookAbs, 0o755);
         return { path: rel, action: 'updated', managed: 'file' };
      }
      return { path: rel, action: 'unchanged', managed: 'file' };
   }
   fs.mkdirSync(path.dirname(hookAbs), { recursive: true });
   fs.writeFileSync(hookAbs, HOOK_BODY, { mode: 0o755 });
   return { path: rel, action: existing === null ? 'created' : 'updated', managed: 'file' };
}

/** Merge the managed block into a husky hook file at `hookAbs`, following the
 * GitLab managed-block rules: replace an existing block in place (unchanged if
 * byte-identical), append it after one blank line to a file without it, or create
 * the file as `#!/bin/sh` + block (mode 0755) when absent. The rest of a
 * user-authored husky hook is left untouched. `requireExec` (a direct `.husky` hook
 * git runs itself) forces mode 0755: a byte-current but non-executable file is a
 * mode-only correction reported `updated`. */
function ensureHuskyBlock(hookAbs: string, rel: string, requireExec: boolean): HookResult {
   const existing = isFile(hookAbs) ? readText(hookAbs) : null;
   if (existing === null) {
      fs.mkdirSync(path.dirname(hookAbs), { recursive: true });
      fs.writeFileSync(hookAbs, `#!/bin/sh\n${HUSKY_BLOCK}`, { mode: 0o755 });
      return { path: rel, action: 'created', managed: 'block' };
   }
   const merged = mergeManagedBlock(existing, HUSKY_BLOCK, HUSKY_MARKER_START, HUSKY_MARKER_END);
   if (merged !== existing) {
      fs.writeFileSync(hookAbs, merged);
      if (requireExec) fs.chmodSync(hookAbs, 0o755);
      return { path: rel, action: 'updated', managed: 'block' };
   }
   if (requireExec && !isExecutable(hookAbs)) {
      fs.chmodSync(hookAbs, 0o755);
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
 * Add a CI workflow running `leji validate` (the `leji ci` command). GitHub: own
 * workflow file. GitLab: create-or-merge a marker-delimited managed block in the
 * shared `.gitlab-ci.yml`. CircleCI: created if absent, else left untouched with a
 * hand-add snippet returned. Azure: own file plus an activation note (ADO doesn't
 * auto-discover). All deterministic text so the three SDKs stay byte-identical.
 * Refuses a symlink that escapes root.
 */
export function ensureCiWorkflow(root: string, provider: CiProvider): CiResult {
   const rootAbs = path.resolve(root);
   // Local-first: a repo that declares @leji-org/leji runs its lockfile-pinned
   // install; a repo without one falls back to `npx @leji-org/leji@1`.
   const local = declaresLejiDep(rootAbs) && hasNpmLockfile(rootAbs);
   switch (provider) {
      case 'github': {
         const abs = path.join(rootAbs, CI_WORKFLOW_PATH);
         guardWithinRoot(rootAbs, abs, CI_WORKFLOW_PATH);
         if (fs.existsSync(abs)) return { provider, path: CI_WORKFLOW_PATH, action: 'unchanged' };
         writeFileAtomic(rootAbs, abs, CI_WORKFLOW_PATH, buildGithubWorkflow(local));
         return { provider, path: CI_WORKFLOW_PATH, action: 'created' };
      }
      case 'gitlab': {
         const abs = path.join(rootAbs, GITLAB_CI_PATH);
         guardWithinRoot(rootAbs, abs, GITLAB_CI_PATH);
         const block = buildGitlabBlock(local);
         if (!fs.existsSync(abs)) {
            writeFileAtomic(rootAbs, abs, GITLAB_CI_PATH, block);
            return { provider, path: GITLAB_CI_PATH, action: 'created' };
         }
         const text = fs.readFileSync(abs, 'utf8');
         const merged = mergeGitlabBlock(text, block);
         if (merged === text) return { provider, path: GITLAB_CI_PATH, action: 'unchanged' };
         writeFileAtomic(rootAbs, abs, GITLAB_CI_PATH, merged);
         return { provider, path: GITLAB_CI_PATH, action: 'updated' };
      }
      case 'circleci': {
         const abs = path.join(rootAbs, CIRCLECI_CONFIG_PATH);
         guardWithinRoot(rootAbs, abs, CIRCLECI_CONFIG_PATH);
         if (fs.existsSync(abs)) {
            return { provider, path: CIRCLECI_CONFIG_PATH, action: 'manual', snippet: buildCircleCiSnippet(local) };
         }
         writeFileAtomic(rootAbs, abs, CIRCLECI_CONFIG_PATH, buildCircleCiConfig(local));
         return { provider, path: CIRCLECI_CONFIG_PATH, action: 'created' };
      }
      case 'azure': {
         const abs = path.join(rootAbs, AZURE_PIPELINE_PATH);
         guardWithinRoot(rootAbs, abs, AZURE_PIPELINE_PATH);
         // Activation note is created-only: a re-run on an existing file stays quiet.
         if (fs.existsSync(abs)) return { provider, path: AZURE_PIPELINE_PATH, action: 'unchanged' };
         writeFileAtomic(rootAbs, abs, AZURE_PIPELINE_PATH, buildAzurePipeline(local));
         return { provider, path: AZURE_PIPELINE_PATH, action: 'created', note: AZURE_ACTIVATION_NOTE };
      }
      default:
         // Unreachable from the CLI (validates first); guards direct helper callers.
         throw new Error(`unknown provider "${provider}"`);
   }
}

/** True when the repo's root package.json declares `@leji-org/leji` under
 * `dependencies` or `devDependencies`. Deterministic and identical across SDKs: read
 * bytes, strip a single leading UTF-8 BOM, strict JSON parse (any error → not
 * declared), and count `dependencies`/`devDependencies` only when they are JSON
 * objects holding the exact key (any other type → absent, never an error). */
/**
 * The generated local-install job runs `npm ci`, which requires an npm lockfile.
 * A pnpm, Yarn or Bun repository can declare the dependency and still have no
 * `package-lock.json`, and the job would fail before Leji ran. Declaring the
 * dependency is therefore not sufficient: the lockfile has to be there too, or the
 * generator falls back to the version-pinned `npx` form that needs no install.
 */
function hasNpmLockfile(rootAbs: string): boolean {
   return fs.existsSync(path.join(rootAbs, 'package-lock.json'));
}

function declaresLejiDep(rootAbs: string): boolean {
   let raw: string;
   try {
      raw = readText(path.join(rootAbs, 'package.json'));
   } catch {
      return false;
   }
   // Strip a single leading UTF-8 BOM (utf8 decoding surfaces it as U+FEFF).
   if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
   let pkg: unknown;
   try {
      pkg = JSON.parse(raw);
   } catch {
      return false;
   }
   if (!isJsonObject(pkg)) return false;
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

function guardWithinRoot(rootAbs: string, abs: string, rel: string): void {
   if (!resolvedWithinRoot(rootAbs, abs)) {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
}

/** Write `abs` atomically (sibling temp + rename) so an interrupted write never
 * leaves a partial file. On failure the temp is removed and a deterministic,
 * OS-text-free error is raised so the three SDKs report I/O failures identically. */
function writeFileAtomic(rootAbs: string, abs: string, rel: string, contents: string): void {
   const tmp = `${abs}.leji-tmp`;
   // The temp path must not escape root either (a planted `<target>.leji-tmp`
   // symlink would otherwise be written through before the rename).
   guardWithinRoot(rootAbs, tmp, rel);
   try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(tmp, contents);
      maybeInjectWriteFailure();
      fs.renameSync(tmp, abs);
   } catch (e) {
      try {
         fs.rmSync(tmp, { force: true });
      } catch {
         /* best-effort cleanup; surface the normalized write error below */
      }
      throw new Error(writeFailureMessage(rel, e));
   }
}

/** Test-only fault injection: with LEJI_TEST_FAIL_RENAME set, fail after the temp
 * file exists but before rename, to exercise the cleanup/normalized-error path. */
function maybeInjectWriteFailure(): void {
   if (process.env.LEJI_TEST_FAIL_RENAME) throw new Error('injected write failure');
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

// Local-first CI: a repo that declares @leji-org/leji installs its lockfile-pinned
// deps and runs the local bin (`npx --no-install` fails loudly rather than fetch a
// floating version); a repo without one falls back to `npx @leji-org/leji@1`, which
// pins the SDK to its current major (@1): additive-only within a major so a valid
// layer stays valid, and a breaking major never reaches adopter CI without a bump.

/** GitHub Actions workflow: a standalone file under .github/workflows/. */
function buildGithubWorkflow(local: boolean): string {
   const run = local
      ? `      - run: npm ci
      - run: npx --no-install @leji-org/leji validate
      - run: npx --no-install @leji-org/leji index --check`
      : `      - run: npx -y @leji-org/leji@1 validate
      - run: npx -y @leji-org/leji@1 index --check`;
   return `name: leji
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
${run}
`;
}

/** GitLab CI: a marker-delimited job merged into the shared .gitlab-ci.yml. */
function buildGitlabBlock(local: boolean): string {
   const script = local
      ? `    - npm ci
    - npx --no-install @leji-org/leji validate
    - npx --no-install @leji-org/leji index --check`
      : `    - npx -y @leji-org/leji@1 validate
    - npx -y @leji-org/leji@1 index --check`;
   // `.pre` is always available. Without an explicit stage GitLab assigns `test`,
   // and a pipeline whose own `stages:` list omits `test` rejects the whole
   // configuration, so the generated job would break an existing pipeline it was
   // merged into.
   return `${GITLAB_MARKER_START}
leji-validate:
  stage: .pre
  image: node:22
  script:
${script}
${GITLAB_MARKER_END}
`;
}

/** CircleCI job steps, shared by the full config and the hand-add snippet. */
function circleCiSteps(local: boolean): string {
   return local
      ? `      - checkout
      - run: npm ci
      - run: npx --no-install @leji-org/leji validate
      - run: npx --no-install @leji-org/leji index --check`
      : `      - checkout
      - run: npx -y @leji-org/leji@1 validate
      - run: npx -y @leji-org/leji@1 index --check`;
}

/** CircleCI config written when .circleci/config.yml is absent. */
function buildCircleCiConfig(local: boolean): string {
   return `version: 2.1
jobs:
  leji-validate:
    docker:
      - image: node:22
    steps:
${circleCiSteps(local)}
workflows:
  leji:
    jobs:
      - leji-validate
`;
}

/** The jobs + workflows fragment to add by hand to an existing CircleCI config. */
function buildCircleCiSnippet(local: boolean): string {
   return `jobs:
  leji-validate:
    docker:
      - image: node:22
    steps:
${circleCiSteps(local)}
workflows:
  leji:
    jobs:
      - leji-validate
`;
}

/** Azure Pipelines: a dedicated .azure-pipelines/leji.yml the user wires to a pipeline. */
function buildAzurePipeline(local: boolean): string {
   const steps = local
      ? `  - script: npm ci
    displayName: install
  - script: npx --no-install @leji-org/leji validate
    displayName: leji validate
  - script: npx --no-install @leji-org/leji index --check
    displayName: leji index --check`
      : `  - script: npx -y @leji-org/leji@1 validate
    displayName: leji validate
  - script: npx -y @leji-org/leji@1 index --check
    displayName: leji index --check`;
   return `trigger:
  - main
pool:
  vmImage: ubuntu-latest
steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '22.x'
${steps}
`;
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

/** What `addAgent` did. Each artifact is independently idempotent: a false
 * `*Created`/`manifestChanged` means it was already there. `hostId` is undefined
 * for a host-agnostic resident agent (no `--host`). */
export interface AgentResult {
   name: string;
   role: string;
   hostId?: string;
   profilePath: string;
   profileCreated: boolean;
   manifestChanged: boolean;
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
   let profileCreated = false;
   if (!isFile(profileAbs)) {
      if (!resolvedWithinRoot(rootAbs, profileAbs)) {
         throw new Error(`refusing to write through a symlink that escapes the target: "${profileRel}"`);
      }
      fs.mkdirSync(path.dirname(profileAbs), { recursive: true });
      fs.writeFileSync(profileAbs, buildAgentProfile(name, role, hostId, manifest.rootPath));
      profileCreated = true;
   }

   const manifestAbs = path.join(rootAbs, 'leji.json');
   const original = readText(manifestAbs);
   const text = bindAgentInManifestText(original, name, profileRel).text;
   const manifestChanged = text !== original;
   if (manifestChanged) fs.writeFileSync(manifestAbs, text);

   return { name, role, hostId, profilePath: profileRel, profileCreated, manifestChanged };
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
   writes.push({ rel: briefPath(r), content: buildBrief(answers) });
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
   assertLejiWorkspacePrivate(root, r);
   ensureLejiGitignored(root);
   // leji.json is created exclusively ('wx'): O_EXCL closes the check-then-write
   // race and won't follow a symlink at the final component.
   if (!resolvedWithinRoot(root, path.join(root, 'leji.json'))) {
      throw new Error('refusing to write through a symlink that escapes the target: "leji.json"');
   }
   writeManifestExclusive(path.join(root, 'leji.json'), writes[0].content, 'init');
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

const DOCS_CANDIDATES = ['docs/', 'doc/', 'documentation/'];

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
   const vendorPresent = KNOWN_VENDOR_FILES.filter((rel) => isFile(path.join(root, rel)))
      // A vendor file that symlinks outside root is treated as absent.
      .filter((rel) => resolvedWithinRoot(root, path.join(root, rel)));
   // Migrate any vendor file not already exactly Leji's redirect, so its content is
   // archived before --wire-adapters overwrites it. A canonical-redirect or empty
   // file has nothing to preserve.
   const notCanonical = (rel: string) => readText(path.join(root, rel)).trim() !== canonicalRedirect;
   const toMigrate = vendorPresent.filter((rel) => {
      const t = readText(path.join(root, rel)).trim();
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
   writes.push({ rel: briefPath(r), content: buildBrief(answers) });

   const migrated: string[] = [];
   const migrationDocByVendor = new Map<string, string>();
   const plannedRels = new Set(writes.map((w) => w.rel));
   for (const rel of toMigrate) {
      const base = path
         .basename(rel)
         .replace(/\.md$/i, '')
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, '-')
         .replace(/^-|-$/g, '');
      // Disambiguate against BOTH the planned writes and what's on disk, so the
      // migrated copy is never skipped by writeFileOnce (a skipped copy plus
      // --wire-adapters overwriting the entrypoint would lose the original).
      let slug = base;
      let docRel = `${joinUnderRoot(r, 'governance/')}imported-${slug}.md`;
      for (let n = 2; plannedRels.has(docRel) || exists(path.join(root, stripSlash(docRel))); n++) {
         slug = `${base}-${n}`;
         docRel = `${joinUnderRoot(r, 'governance/')}imported-${slug}.md`;
      }
      plannedRels.add(docRel);
      writes.push({ rel: docRel, content: migrationDoc(rel, readText(path.join(root, rel))) });
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
   const draft = wontModify.some((rel) => !readText(path.join(root, rel)).includes(bootRel));

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
   assertLejiWorkspacePrivate(root, r);
   ensureLejiGitignored(root);
   if (!resolvedWithinRoot(root, path.join(root, 'leji.json'))) {
      throw new Error('refusing to write through a symlink that escapes the target: "leji.json"');
   }
   writeManifestExclusive(path.join(root, 'leji.json'), writes[0].content, 'adopt');
   written.push('leji.json');
   const convert = new Set(toConvert);
   for (const w of writes.slice(1)) {
      if (convert.has(w.rel)) {
         // Never overwrite a vendor entrypoint until its migrated copy is on disk:
         // if the migration write was skipped, leave the original untouched.
         const docRel = migrationDocByVendor.get(w.rel);
         if (docRel && !written.includes(docRel)) continue;
         const abs = safeResolve(root, w.rel);
         if (!resolvedWithinRoot(root, abs)) {
            throw new Error(`refusing to write through a symlink that escapes the target: "${w.rel}"`);
         }
         fs.writeFileSync(abs, w.content);
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
   const base = path
      .basename(vendorRel)
      .replace(/\.md$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
   for (let n = 1; ; n++) {
      const rel = `${joinUnderRoot(rootPath, 'governance/')}imported-${n === 1 ? base : `${base}-${n}`}.md`;
      const abs = path.join(root, stripSlash(rel));
      if (!exists(abs)) return rel;
      if (isFile(abs) && readText(abs) === doc) return null;
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
   const vendorPresent = KNOWN_VENDOR_FILES.filter((rel) => isFile(path.join(root, rel)))
      // A vendor file that symlinks outside root is treated as absent, as in `adopt`.
      .filter((rel) => resolvedWithinRoot(root, path.join(root, rel)));
   const toConvert = vendorPresent.filter((rel) => readText(path.join(root, rel)).trim() !== redirect.trim());

   // Archives first, so a vendor entrypoint is never overwritten before its content
   // is on disk; an empty file has nothing to preserve.
   const writes: PlannedWrite[] = [];
   const archived: string[] = [];
   for (const rel of toConvert) {
      const content = readText(path.join(root, rel));
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
   for (const w of writes) {
      const abs = safeResolve(root, w.rel);
      if (!resolvedWithinRoot(root, abs)) {
         throw new Error(`refusing to write through a symlink that escapes the target: "${w.rel}"`);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, w.content);
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
   /** Run a host subcommand (the MCP presence check / register) from `cwd`, returning
    * spawnSync's shape. `quiet` suppresses child output (the check); otherwise the
    * child inherits the terminal so the user sees the host's own output. */
   run(
      bin: string,
      args: string[],
      cwd: string | undefined,
      opts: { quiet: boolean },
   ): { error?: Error; status?: number | null; signal?: NodeJS.Signals | null };
}

/** Real handoff I/O: a one-shot stdin line reader and a stdio-inherit spawn. */
function defaultHandoffIo(): HandoffIo {
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
         return spawnSync(bin, args, { stdio: opts.quiet ? 'ignore' : 'inherit', cwd });
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
   const promptArg = `Read ./${briefPath(manifest.rootPath)} and follow it.`;
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
 * proposal is written to <rootPath>/.leji/proposal.md AND printed as message
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

/** Write the guard script under <rootPath>/.leji/hooks/ and merge its
 * PreToolUse entry into .claude/settings.json (created if absent, other
 * settings preserved). Idempotent: an existing guard entry is left untouched. */
export function ensureApprovalGuard(root: string, rootPath: string): GuardAction {
   const rootAbs = path.resolve(root);
   const lejiRel = joinUnderRoot(rootPath, '.leji');
   const scriptRel = `${lejiRel}/hooks/approval-guard.mjs`;
   const scriptAbs = path.join(rootAbs, scriptRel);
   guardWithinRoot(rootAbs, scriptAbs, scriptRel);

   const settingsRel = '.claude/settings.json';
   const settingsAbs = path.join(rootAbs, settingsRel);
   guardWithinRoot(rootAbs, settingsAbs, settingsRel);
   let settings: Record<string, unknown> = {};
   const existing = isFile(settingsAbs) ? readText(settingsAbs) : null;
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
         'Add the temporary onboarding guard for Claude Code, in this repository only? It has the agent print its proposal before asking for approval. Writes two project-local files (a hook entry in this repo\u2019s .claude/settings.json, a script in the gitignored .leji/ workspace); nothing outside this repository is touched, and the finalize step removes both',
         'Y/n',
      )
   ).toLowerCase();
   if (!(answer === '' || answer === 'y' || answer === 'yes')) return;
   const action = ensureApprovalGuard(opts.root, opts.rootPath);
   console.log(
      action === 'installed'
         ? 'Onboarding guard added (this repository only: .claude/settings.json hook + .leji/hooks/approval-guard.mjs; removed at finalize).'
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
   io?: HandoffIo;
}

/** `leji start`: boot a coding agent into an existing layer, pointed at the boot
 * profile. One detected host launches directly; several prompt; `--agent` forces one.
 * Launches from the layer root so the relative boot path resolves. Returns 'launched',
 * 'fallback' (nothing to launch / non-interactive / launch failed), or 'boot-missing'
 * (boot path unsafe or absent). Throws on an unknown/non-launchable --agent. */
export async function enterLayer(opts: StartOptions): Promise<StartOutcome> {
   const root = path.resolve(opts.root);
   const bootRel = opts.manifest.bootProfilePath;
   if (!RELATIVE_PATH_RE.test(bootRel) || !isFile(path.join(root, bootRel))) return 'boot-missing';
   const io = opts.io ?? defaultHandoffIo();
   const promptArg = bootPrompt(bootRel);

   let host: PromptHost | null = null;
   if (opts.agent) {
      host = assertAgentHost(opts.agent);
   } else {
      const hosts = promptCapableHosts(opts.detected);
      if (hosts.length === 1) host = hosts[0];
      else if (hosts.length > 1 && opts.interactive) host = await pickFromMultiple(hosts, io);
   }

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
   const brief = briefPath(manifest.rootPath);
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
