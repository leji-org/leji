import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync, spawnSync } from 'node:child_process';
import {
   type CategoryId,
   type Manifest,
   bindAgentInManifestText,
   declareVendorAdapterInManifestText,
   effectiveAgentProfilesPath,
   effectiveChangelogPath,
   effectiveIndexPath,
} from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import { isDir, isFile, readText, resolvedWithinRoot } from '../lib/fsx.js';
import { type PlanEntry, type PlannedWrite, buildWritePlan } from '../lib/writeplan.js';
import { type DetectedHost, HOST_SPECS, adapterContent, detectHosts, resolveHostId } from '../lib/detect.js';
import { workingTreeClean } from '../lib/git.js';
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
   /** Wire a vendor adapter: a host id/alias, `auto` (top detected), or `none`. */
   agent?: string;
}

export interface InitAnswers {
   name: string;
   description: string;
   rootPath: string;
   ownerName: string;
   ownerContact: string;
   categories: CategoryId[];
   level: 'core' | 'indexed';
}

/** Result of `initLayer`: the files written and the manifest created. */
export interface InitResult {
   written: string[];
   manifest: Manifest;
   /** The classified write plan (always populated; the only output under dryRun). */
   plan: PlanEntry[];
   dryRun: boolean;
   /** Coding-agent hosts detected for this repo, ranked; informs the handoff offer. */
   detected: DetectedHost[];
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
      // The line above collapses each run of non-alphanumerics to a single '-',
      // so dashes are never consecutive; trimming one per end is sufficient and
      // avoids the polynomial-backtracking `-+$` (js/polynomial-redos).
      .replace(/^-|-$/g, '');
   return {
      name: options.name ?? `${base}-context`,
      description: 'Shared context layer for this repository.',
      rootPath: 'docs/',
      ownerName: gitConfig('user.name') ?? '<named owner>',
      ownerContact: gitConfig('user.email') ?? '',
      categories: ['domain', 'system', 'decisions'],
      level: options.level ?? 'core',
   };
}

/**
 * Queued line reader: unlike readline/promises' question(), lines arriving
 * while no question is pending (piped stdin delivers everything at once) are
 * buffered instead of dropped.
 */
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
      let rootPath = await ask('Context root', defaults.rootPath);
      if (!rootPath.endsWith('/')) rootPath += '/';
      const ownerName = await ask('Primary owner (name)', defaults.ownerName);
      const ownerContact = await ask('Primary owner (contact)', defaults.ownerContact);

      const categories: CategoryId[] = [];
      if (await askYesNo('Map domain (business language, product semantics)?', true)) categories.push('domain');
      if (await askYesNo('Map system (architecture, invariants)?', true)) categories.push('system');
      if (await askYesNo('Map practice (conventions, proven patterns)?', false)) categories.push('practice');
      if (await askYesNo('Map governance (agent guardrails, operating rules)?', false)) categories.push('governance');
      categories.push('decisions');
      if (!categories.includes('domain') && !categories.includes('system')) {
         // The spec minimum: at least domain or system, plus decisions.
         categories.unshift('domain');
         console.log('At least domain or system is required; mapping domain.');
      }

      const indexed = await askYesNo('Generate the machine index and changelog now (indexed level)?', false);
      return {
         name,
         description,
         rootPath,
         ownerName,
         ownerContact,
         categories,
         level: indexed ? 'indexed' : 'core',
      };
   } finally {
      reader.close();
   }
}

function readTemplate(name: string): string {
   return fs.readFileSync(path.join(templatesDir(), name), 'utf8');
}

/**
 * The manifest schema's relative-path rule: rejects absolute paths, `./`
 * prefixes, any `..` segment, and backslashes. Mirrored here so init refuses
 * traversal before it writes anything.
 */
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

/**
 * Ensure the repository-root .gitignore ignores `.leji/` (the generated viewer and
 * the transient onboarding brief, neither of which belongs in version control).
 * Idempotent: creates the file if absent, appends the line (adding a leading
 * newline when the file lacks a trailing one) only when the exact line is not
 * already present. Matches the line exactly, so it never treats a comment or
 * `docs/.leji/` as equivalent.
 */
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

/**
 * Create leji.json with O_EXCL (`wx`) so the entry point's existence check and the
 * write are atomic: a concurrent run, or a symlink planted between check and write,
 * cannot be overwritten or followed. EEXIST is surfaced as the same "already exists"
 * error each entry point uses for its initial guard.
 */
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

function buildManifest(answers: InitAnswers): Manifest {
   const template = JSON.parse(readTemplate('leji.json')) as Manifest;
   const r = answers.rootPath;
   const manifest: Manifest = {
      $schema: template.$schema,
      leji: '1.0',
      name: answers.name,
      description: answers.description,
      rootPath: r,
      bootProfilePath: `${r}boot-profile.md`,
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
   // No `machine` block: every machine-surface path resolves to its spec
   // default under rootPath/, so init writes a minimal leji.json and the
   // resolvers (effective*Path) find the files at their default locations.
   for (const category of answers.categories) {
      manifest.categories[category] = { paths: [`${r}${category}/`] };
   }
   return manifest;
}

function buildBootProfile(answers: InitAnswers): string {
   let text = readTemplate('boot-profile.md');
   // The template speaks in docs/ defaults; rewrite for the chosen root.
   if (answers.rootPath !== 'docs/') {
      text = text.replaceAll('docs/', answers.rootPath);
   }
   text = text.replace(
      '<One paragraph: what this repository/product is, who it serves, what stage it is at.>',
      answers.description,
   );
   const r = answers.rootPath;

   const loadLines = answers.categories
      .map((c) => {
         const purpose: Record<string, string> = {
            domain: 'what our core terms mean',
            system: 'architecture and the invariants every change lives with',
            practice: 'conventions and patterns applied automatically',
            governance: 'agent guardrails and operating rules',
            decisions: 'why things are the way they are (check before proposing a reversal)',
         };
         return `- \`${r}${c}/\`: ${purpose[c]}`;
      })
      .join('\n');
   text = text.replace(/- `[^`]+domain\/`[^\n]*\n- `[^`]+system\/`[^\n]*\n- `[^`]+decisions\/`[^\n]*/, loadLines);

   if (answers.level === 'core') {
      text = text.replace(/\nThe generated map of this layer is `[^`]+`\.\n/, '\n');
      text = text.replace(/- Append an entry to `[^`]+context-changelog\.json`[^\n]*\n/, '');
      text = text.replace(/- Regenerate `[^`]+context-index\.json`[^\n]*\n/, '');
   }
   return text;
}

function buildCoreProfile(answers: InitAnswers): string {
   let text = readTemplate(path.join('agents', 'core.md'));
   if (answers.rootPath !== 'docs/') {
      text = text.replaceAll('docs/', answers.rootPath);
   }
   if (!answers.categories.includes('governance')) {
      text = text.replace(/^ {2}- .*governance\/\n/m, `  - ${answers.rootPath}decisions/\n`);
   }
   return text;
}

function buildFirstDecision(answers: InitAnswers): string {
   const today = new Date().toISOString().slice(0, 10);
   const indexedLine =
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

/** The transient onboarding brief, rewritten for the chosen root. */
function buildBrief(answers: InitAnswers): string {
   return readTemplate('onboarding-brief.md').replaceAll('<root>/', answers.rootPath);
}

/** Path of the transient onboarding brief, under a dot-directory so it is
 * excluded from the index, the viewer, and the changelog. */
export function briefPath(rootPath: string): string {
   return `${rootPath}.leji/onboarding-brief.md`;
}

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

export type CiProvider = 'github' | 'gitlab' | 'circleci' | 'azure';
export type CiAction = 'created' | 'updated' | 'unchanged' | 'manual';
export interface CiResult {
   provider: CiProvider;
   path: string;
   action: CiAction;
   snippet?: string;
   note?: string;
}

/**
 * Add a CI workflow that runs `leji validate` on every change (the `leji ci`
 * command), so CI can be added to a layer created without it. GitHub gets its own
 * workflow file; GitLab is create-or-merge into the shared `.gitlab-ci.yml` via a
 * marker-delimited managed block; CircleCI is created if absent, else left untouched
 * (a snippet to add by hand is returned); Azure DevOps gets its own
 * `.azure-pipelines/leji.yml` plus an activation note, since ADO does not auto-discover
 * the file. All operations are deterministic text, so the three reference SDKs stay
 * byte-identical. Refuses a symlink that escapes root.
 */
export function ensureCiWorkflow(root: string, provider: CiProvider): CiResult {
   const rootAbs = path.resolve(root);
   switch (provider) {
      case 'github': {
         const abs = path.join(rootAbs, CI_WORKFLOW_PATH);
         guardWithinRoot(rootAbs, abs, CI_WORKFLOW_PATH);
         if (fs.existsSync(abs)) return { provider, path: CI_WORKFLOW_PATH, action: 'unchanged' };
         writeFileAtomic(rootAbs, abs, CI_WORKFLOW_PATH, buildGithubWorkflow());
         return { provider, path: CI_WORKFLOW_PATH, action: 'created' };
      }
      case 'gitlab': {
         const abs = path.join(rootAbs, GITLAB_CI_PATH);
         guardWithinRoot(rootAbs, abs, GITLAB_CI_PATH);
         const block = buildGitlabBlock();
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
            return { provider, path: CIRCLECI_CONFIG_PATH, action: 'manual', snippet: buildCircleCiSnippet() };
         }
         writeFileAtomic(rootAbs, abs, CIRCLECI_CONFIG_PATH, buildCircleCiConfig());
         return { provider, path: CIRCLECI_CONFIG_PATH, action: 'created' };
      }
      case 'azure': {
         const abs = path.join(rootAbs, AZURE_PIPELINE_PATH);
         guardWithinRoot(rootAbs, abs, AZURE_PIPELINE_PATH);
         // The activation note is intentionally created-only: a re-run on an existing
         // pipeline file stays quiet (no note) rather than repeating the setup guidance.
         if (fs.existsSync(abs)) return { provider, path: AZURE_PIPELINE_PATH, action: 'unchanged' };
         writeFileAtomic(rootAbs, abs, AZURE_PIPELINE_PATH, buildAzurePipeline());
         return { provider, path: AZURE_PIPELINE_PATH, action: 'created', note: AZURE_ACTIVATION_NOTE };
      }
      default:
         // Unreachable from the CLI (it validates first); guards direct helper callers
         // so an unknown provider errors consistently across the three SDKs.
         throw new Error(`unknown provider "${provider}"`);
   }
}

function guardWithinRoot(rootAbs: string, abs: string, rel: string): void {
   if (!resolvedWithinRoot(rootAbs, abs)) {
      throw new Error(`refusing to write through a symlink that escapes the target: "${rel}"`);
   }
}

/** Write `contents` to `abs` atomically: a sibling temp file, then rename over the
 * target, so an interrupted or failed write can never leave a partial file. On any
 * failure the temp file is removed (no repo-visible artifact) and a deterministic,
 * OS-text-free error is raised so the three SDKs report I/O failures byte-identically. */
function writeFileAtomic(rootAbs: string, abs: string, rel: string, contents: string): void {
   const tmp = `${abs}.leji-tmp`;
   // The sibling temp path must not escape the root either (a planted `<target>.leji-tmp`
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

/** Test-only fault injection: when LEJI_TEST_FAIL_RENAME is set, simulate a write that
 * fails after the temp file exists but before the rename commits, so the cleanup and
 * normalized-error path can be exercised identically across the three SDKs. */
function maybeInjectWriteFailure(): void {
   if (process.env.LEJI_TEST_FAIL_RENAME) throw new Error('injected write failure');
}

/** A deterministic, OS-text-free message for a failed CI-file write. Keeps stdout/
 * stderr byte-identical across the Node, Go, and Python SDKs (parity-testable). */
function writeFailureMessage(rel: string, e: unknown): string {
   const code = (e as NodeJS.ErrnoException).code;
   if (code === 'EACCES' || code === 'EPERM') return `cannot write "${rel}": permission denied`;
   return `cannot write "${rel}"`;
}

/**
 * Insert/replace the managed block in an existing `.gitlab-ci.yml`, byte-exactly.
 * Replaces the first managed block and drops any later duplicate managed blocks,
 * so the file is left with exactly one.
 */
function mergeGitlabBlock(text: string, block: string): string {
   const span = managedBlockSpan(text);
   if (span) {
      return text.slice(0, span.start) + block + stripManagedBlocks(text.slice(span.end));
   }
   if (text === '') return block;
   return text + (text.endsWith('\n') ? '\n' : '\n\n') + block;
}

/** The `[start, end)` span of the first managed block in `text`, or null if none. */
function managedBlockSpan(text: string): { start: number; end: number } | null {
   const start = text.indexOf(GITLAB_MARKER_START);
   if (start === -1) return null;
   const endMarker = text.indexOf(GITLAB_MARKER_END, start);
   if (endMarker === -1) return null;
   const nl = text.indexOf('\n', endMarker);
   const end = nl === -1 ? text.length : nl + 1;
   return { start, end };
}

/** Remove every managed block from `text` (drops duplicates left after the first). */
function stripManagedBlocks(text: string): string {
   let out = '';
   let rest = text;
   for (;;) {
      const span = managedBlockSpan(rest);
      if (!span) return out + rest;
      out += rest.slice(0, span.start);
      rest = rest.slice(span.end);
   }
}

/** GitHub Actions workflow: a standalone file under .github/workflows/. */
function buildGithubWorkflow(): string {
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
      - run: npx -y @leji-org/leji@latest validate
`;
}

/** GitLab CI: a marker-delimited job merged into the shared .gitlab-ci.yml. */
function buildGitlabBlock(): string {
   return `${GITLAB_MARKER_START}
leji-validate:
  image: node:22
  script:
    - npx -y @leji-org/leji@latest validate
${GITLAB_MARKER_END}
`;
}

/** CircleCI config written when .circleci/config.yml is absent. */
function buildCircleCiConfig(): string {
   return `version: 2.1
jobs:
  leji-validate:
    docker:
      - image: node:22
    steps:
      - checkout
      - run: npx -y @leji-org/leji@latest validate
workflows:
  leji:
    jobs:
      - leji-validate
`;
}

/** The jobs + workflows fragment to add by hand to an existing CircleCI config. */
function buildCircleCiSnippet(): string {
   return `jobs:
  leji-validate:
    docker:
      - image: node:22
    steps:
      - checkout
      - run: npx -y @leji-org/leji@latest validate
workflows:
  leji:
    jobs:
      - leji-validate
`;
}

/** Azure Pipelines: a dedicated .azure-pipelines/leji.yml the user wires to a pipeline. */
function buildAzurePipeline(): string {
   return `trigger:
  - main
pool:
  vmImage: ubuntu-latest
steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '22.x'
  - script: npx -y @leji-org/leji@latest validate
    displayName: leji validate
`;
}

// A name (also the agent-profile `id` and the agents-map key) and a role must be
// kebab identifiers: matches the agent-profile schema's id pattern, is safe as a
// path segment, and is safe to interpolate into YAML frontmatter and JSON.
const AGENT_TOKEN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function assertAgentToken(label: string, value: string): void {
   if (!AGENT_TOKEN.test(value)) {
      throw new Error(
         `${label} must be lowercase letters, digits, and single dashes (e.g. "thought-partner"); got "${value}"`,
      );
   }
}

/**
 * A starter agent profile for a named agent bound to a host. The body is keyed
 * off the role: `reviewer` (the default) keeps the review-focused posture; any
 * other role gets a neutral template the author fills in. The frontmatter
 * satisfies the agent-profile schema (id/name/role/requiredRead/mustAskWhen).
 */
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
  - ${rootPath}boot-profile.md
  - ${rootPath}agents/core.md
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
  - ${rootPath}boot-profile.md
  - ${rootPath}agents/core.md
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

/** What `addAgent` did, for the command to report. Each artifact is independently
 * idempotent: a `*Created`/`manifestChanged` of false means it was already there.
 * `hostId` is undefined for a host-agnostic resident agent (no `--host`). */
export interface AgentResult {
   name: string;
   role: string;
   hostId?: string;
   profilePath: string;
   profileCreated: boolean;
   manifestChanged: boolean;
}

/**
 * Wire a named agent into an existing layer (the `leji agent` command): write a
 * starter profile under the agent-profiles path, wire the host's vendor adapter
 * if absent, and bind the agent (and adapter) in leji.json via an in-place text
 * edit that preserves the rest of the file. Never overwrites an existing profile
 * or adapter, and re-running with the same arguments is a no-op.
 */
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
   // --host is optional: a host pins the profile to a specific external CLI; with
   // none, this is a host-agnostic resident agent any host can run. Either way we
   // never write a vendor file; those are migrated from an existing entrypoint,
   // never created.
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

/**
 * Refuse to mutate a dirty working tree. init/adopt write (and adopt moves) many
 * files; the "git restore cleanly undoes Leji's writes" safety net only holds if
 * the tree was clean to begin with, so a dirty tree is refused outright rather
 * than entangling Leji's writes with the user's uncommitted work. A non-git
 * directory has no such net and is allowed: that is how a fresh layer is
 * bootstrapped before `git init`. Callers skip this under --dry-run.
 */
function assertCleanWorkingTree(root: string): void {
   if (workingTreeClean(root) === false) {
      throw new Error(
         'the working tree has uncommitted changes; commit or stash them first so this stays cleanly reversible (preview with --dry-run)',
      );
   }
}

/**
 * Bootstrap a context layer from the vendored templates. Interactive unless
 * --yes. Refuses to run when leji.json already exists or the working tree is
 * dirty; never overwrites existing files (seeds land only where nothing is in
 * the way). With `dryRun`, computes the write plan and touches nothing.
 */
export async function initLayer(options: InitOptions): Promise<InitResult> {
   const root = path.resolve(options.dir);
   if (fs.existsSync(path.join(root, 'leji.json'))) {
      throw new Error('leji.json already exists here; init refuses to overwrite an existing layer');
   }
   if (!options.dryRun) assertCleanWorkingTree(root);
   const detected = detectHosts({ root });
   const answers = await prompt(options);
   // Guard rootPath (and so every derived write path) before any write: reject
   // absolute paths, .. segments, ./ prefixes, and backslashes.
   assertRelativePath(answers.rootPath);

   const manifest = buildManifest(answers);
   const r = answers.rootPath;

   // Assemble the files init owns, in write order. leji.json comes first so the
   // overwrite guard is effective on a retry after an interrupted run.
   const writes: PlannedWrite[] = [{ rel: 'leji.json', content: JSON.stringify(manifest, null, 2) + '\n' }];
   writes.push({ rel: manifest.bootProfilePath, content: buildBootProfile(answers) });
   for (const category of answers.categories) {
      if (category === 'decisions') continue;
      const stub = CATEGORY_STUBS[category];
      writes.push({ rel: `${r}${category}/${stub.file}`, content: categoryStub(stub.title, stub.summary, stub.body) });
   }
   writes.push({ rel: `${r}decisions/0001-adopt-leji.md`, content: buildFirstDecision(answers) });
   writes.push({ rel: `${r}agents/core.md`, content: buildCoreProfile(answers) });
   writes.push({ rel: briefPath(r), content: buildBrief(answers) });
   if (answers.level === 'indexed') {
      // The changelog records the paths seeded; compute from the planned set
      // (everything except the changelog and the generated index).
      const seeded = writes.map((w) => w.rel).sort();
      writes.push({ rel: effectiveChangelogPath(manifest), content: buildChangelog(answers, seeded) });
   }

   // Foreign entrypoint files Leji detects but will never modify.
   const wontModify = KNOWN_VENDOR_FILES.filter((rel) => isFile(path.join(root, rel)));
   const indexRel = answers.level === 'indexed' ? effectiveIndexPath(manifest) : undefined;
   const planWrites = indexRel ? [...writes, { rel: indexRel, content: '' }] : writes;
   const plan = buildWritePlan(root, planWrites, wontModify);

   if (options.dryRun) {
      return { written: [], manifest, plan, dryRun: true, detected };
   }

   const written: string[] = [];
   fs.mkdirSync(root, { recursive: true });
   // leji.json is created exclusively ('wx'): O_EXCL closes the check-then-write
   // race and refuses to follow a symlink at the final component, so a concurrent
   // init or a planted symlink cannot be overwritten or escaped.
   if (!resolvedWithinRoot(root, path.join(root, 'leji.json'))) {
      throw new Error('refusing to write through a symlink that escapes the target: "leji.json"');
   }
   writeManifestExclusive(path.join(root, 'leji.json'), writes[0].content, 'init');
   written.push('leji.json');
   for (const w of writes.slice(1)) {
      writeFileOnce(root, w.rel, w.content, written);
   }
   if (answers.level === 'indexed') {
      writeIndex(root, manifest);
      written.push(effectiveIndexPath(manifest));
   }
   ensureLejiGitignored(root);

   return { written: written.sort(), manifest, plan, dryRun: false, detected };
}

// --- adoption (existing repositories) ---

const DOCS_CANDIDATES = ['docs/', 'doc/', 'documentation/'];

/** Options for `adoptLayer`: bringing Leji into an existing repository. */
export interface AdoptOptions {
   dir: string;
   yes: boolean;
   dryRun?: boolean;
   /** Convert present vendor entrypoints to redirects (consented overwrite). */
   wireAdapters?: boolean;
   agent?: string;
   name?: string;
}

/** Result of `adoptLayer`: the init result plus what adoption found and did. */
export interface AdoptResult extends InitResult {
   detectedRoot: string;
   /** Vendor files whose content was migrated into the layer. */
   migrated: string[];
   /** A non-redirecting vendor file remains, so the layer is not yet core-conformant. */
   draft: boolean;
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
   // Wrap the migrated content in a fenced code block so raw HTML/Markdown is
   // shown verbatim, never rendered: the fenced migration cannot inject script into
   // the Docsify preview. (That preview is a local, trusted-content viewer, not a
   // sandbox; other layer documents are still rendered as authored.)
   // The fence is one backtick longer than the longest run in the content.
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

Its content was migrated into the layer (see \`${answers.rootPath}governance/\`). The original file(s) were left unchanged; converting them to one-line redirects is a separate, consented step (\`leji adopt --wire-adapters\`).

## Consequences

The context layer is the single source of truth. Until the vendor entrypoints redirect, the layer does not claim core conformance.
`;
}

/**
 * Adopt an existing docs tree into Leji: migrate vendor entrypoints into the layer
 * (originals untouched), optionally converting them to redirects with `wireAdapters`.
 * Refuses when a layer already exists.
 */
export async function adoptLayer(options: AdoptOptions): Promise<AdoptResult> {
   const root = path.resolve(options.dir);
   if (fs.existsSync(path.join(root, 'leji.json'))) {
      throw new Error('leji.json already exists here; this repository already has a Leji layer');
   }
   if (!options.dryRun) assertCleanWorkingTree(root);
   const detected = detectHosts({ root });
   const detectedRoot = DOCS_CANDIDATES.find((d) => isDir(path.join(root, d))) ?? 'docs/';
   assertRelativePath(detectedRoot);

   const bootRel = `${detectedRoot}boot-profile.md`;
   const canonicalRedirect = adapterContent(bootRel).trim();
   const vendorPresent = KNOWN_VENDOR_FILES.filter((rel) => isFile(path.join(root, rel)))
      // A vendor file that is a symlink resolving outside root is neither read,
      // migrated, nor converted: it is treated as absent.
      .filter((rel) => resolvedWithinRoot(root, path.join(root, rel)));
   // Migrate any vendor file that is not already exactly Leji's redirect, so its
   // content (whether on its own lines or sharing a line with the boot-path
   // reference) is archived before --wire-adapters overwrites it. A file that is
   // already the canonical redirect, or empty, has nothing to preserve.
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
   const categories: CategoryId[] = ['domain', 'system'];
   if (toMigrate.length > 0) categories.push('governance');
   categories.push('decisions');
   const answers: InitAnswers = {
      name: options.name ?? `${base}-context`,
      description: 'Shared context layer for this repository.',
      rootPath: detectedRoot,
      ownerName: gitConfig('user.name') ?? '<named owner>',
      ownerContact: gitConfig('user.email') ?? '',
      categories,
      level: 'core',
   };

   const manifest = buildManifest(answers);
   const r = answers.rootPath;

   // Convert only EXISTING vendor entrypoints (never create new ones) that aren't
   // already the canonical redirect; each has been captured in toMigrate above, so
   // the overwrite never loses content.
   const toConvert = options.wireAdapters ? vendorPresent.filter(notCanonical) : [];
   if (toConvert.length > 0) manifest.vendorAdapters = toConvert;

   const writes: PlannedWrite[] = [{ rel: 'leji.json', content: JSON.stringify(manifest, null, 2) + '\n' }];
   writes.push({ rel: manifest.bootProfilePath, content: buildBootProfile(answers) });
   for (const category of answers.categories) {
      if (category === 'decisions') continue;
      const stub = CATEGORY_STUBS[category];
      writes.push({ rel: `${r}${category}/${stub.file}`, content: categoryStub(stub.title, stub.summary, stub.body) });
   }
   writes.push({ rel: `${r}decisions/0001-adopt-leji.md`, content: buildFirstDecision(answers) });
   writes.push({ rel: `${r}agents/core.md`, content: buildCoreProfile(answers) });
   writes.push({ rel: briefPath(r), content: buildBrief(answers) });

   const migrated: string[] = [];
   const usedSlugs = new Set<string>();
   for (const rel of toMigrate) {
      const base = path
         .basename(rel)
         .replace(/\.md$/i, '')
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, '-')
         .replace(/^-|-$/g, '');
      // Disambiguate when two source files would collide on the same slug.
      let slug = base;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}-${n}`;
      usedSlugs.add(slug);
      writes.push({
         rel: `${r}governance/imported-${slug}.md`,
         content: migrationDoc(rel, readText(path.join(root, rel))),
      });
      migrated.push(rel);
   }
   if (migrated.length > 0) {
      writes.push({
         rel: `${r}decisions/0002-adopt-existing-agent-context.md`,
         content: adoptExistingDecision(answers, migrated),
      });
   }

   for (const rel of toConvert) writes.push({ rel, content: adapterContent(manifest.bootProfilePath) });

   const wontModify = vendorPresent.filter((rel) => !toConvert.includes(rel));
   const plan = buildWritePlan(root, writes, wontModify, toConvert);
   const draft = wontModify.some((rel) => !readText(path.join(root, rel)).includes(bootRel));

   if (options.dryRun) {
      return { written: [], manifest, plan, dryRun: true, detected, detectedRoot, migrated, draft };
   }

   const written: string[] = [];
   fs.mkdirSync(root, { recursive: true });
   if (!resolvedWithinRoot(root, path.join(root, 'leji.json'))) {
      throw new Error('refusing to write through a symlink that escapes the target: "leji.json"');
   }
   writeManifestExclusive(path.join(root, 'leji.json'), writes[0].content, 'adopt');
   written.push('leji.json');
   const convert = new Set(toConvert);
   for (const w of writes.slice(1)) {
      if (convert.has(w.rel)) {
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
   ensureLejiGitignored(root);

   return { written: written.sort(), manifest, plan, dryRun: false, detected, detectedRoot, migrated, draft };
}

/** Post-adopt guidance, printed by the CLI. */
export function enteringAdopted(result: AdoptResult): string {
   const lines = [enteringTheLayer(result.manifest)];
   if (result.migrated.length > 0) {
      lines.push(
         '',
         `Migrated ${result.migrated.join(', ')} into ${result.manifest.rootPath}governance/ (originals untouched); refine into the right categories.`,
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

/**
 * CLI hosts that accept an inline prompt argument, so Leji can launch the handoff
 * for the user (`claude "..."`, `codex "..."`). Directory-style IDE hosts (Cursor,
 * Windsurf) and prompt syntaxes we have not verified (Gemini) are deliberately
 * left out; when only those are present, the offer is skipped and the printed
 * instructions stand. Mirrors the two commands documented in `enteringTheLayer`.
 */
const PROMPT_HOST_IDS = ['claude-code', 'codex'];

interface PromptHost {
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

/**
 * Injectable I/O for the handoff offer, so the interactive flow (prompting and
 * launching a child process) is deterministically testable. Production wiring is
 * `defaultHandoffIo`; tests pass a fake that scripts the answer and records the
 * launch instead of spawning.
 */
export interface HandoffIo {
   /** Prompt and read one trimmed line; '' means accept the default (or EOF). */
   readLine(question: string, fallback: string): Promise<string>;
   /**
    * Launch the chosen agent with the brief prompt; mirrors spawnSync's result.
    * `error` means it never started; a non-zero `status` or a `signal` means it
    * started but did not finish cleanly. Either way the caller falls back to the
    * printed instructions.
    */
   launch(
      bin: string,
      promptArg: string,
      cwd?: string,
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
            // Close before any launch so nothing else is holding stdin when the
            // child inherits the terminal.
            reader.close();
         }
      },
      launch(bin, promptArg, cwd) {
         // cwd anchors the agent at the layer root so a relative prompt path like
         // `./docs/boot-profile.md` resolves (matters for `leji start --root <dir>`).
         return spawnSync(bin, [promptArg], { stdio: 'inherit', cwd });
      },
   };
}

/** Ask which of several detected hosts to launch (numbered), or none. */
async function pickFromMultiple(hosts: PromptHost[], io: HandoffIo): Promise<PromptHost | null> {
   console.log('\nDetected coding agents on your PATH:');
   hosts.forEach((h, i) => console.log(`   ${i + 1}) ${h.name}`));
   const a = (await io.readLine('Which agent? (number, or Enter to skip)', 'skip')).toLowerCase();
   // An explicit, in-range number is required; empty / n / junk / out-of-range skip,
   // so we never launch an agent the user did not pick.
   if (a === '' || a === 'n' || a === 'no') return null;
   const idx = Number(a) - 1;
   return Number.isInteger(idx) && idx >= 0 && idx < hosts.length ? hosts[idx] : null;
}

/**
 * Launch a chosen host with `promptArg` from `cwd`. Returns true only on a clean
 * exit; a spawn failure or a non-zero/signalled exit returns false so the caller
 * can fall back to printed instructions.
 */
function launchHost(host: PromptHost, promptArg: string, io: HandoffIo, cwd?: string): boolean {
   console.log(`\nStarting ${host.name}: ${host.bin} "${promptArg}"\n`);
   const res = io.launch(host.bin, promptArg, cwd);
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

/**
 * After a scaffold is written, offer to hand it to a detected agent and launch
 * that agent directly. Interactive only: fires when `interactive` is set (a TTY
 * and not --yes) and at least one prompt-capable host is on PATH. Returns true
 * when an agent was launched (the caller prints nothing further), false to fall
 * back to the printed instructions (no agent detected, declined, or launch
 * failed). Never fires non-interactively, so scripted/CI output and cross-SDK
 * parity are unchanged.
 */
export async function handoffOffer(
   manifest: Manifest,
   detected: DetectedHost[],
   interactive: boolean,
   io: HandoffIo = defaultHandoffIo(),
   agent?: string,
): Promise<boolean> {
   if (!interactive) return false;
   const hosts = promptCapableHosts(detected);
   const promptArg = `Read ./${briefPath(manifest.rootPath)} and follow it.`;
   // --agent forces a specific launchable host (skipping the prompt); otherwise the
   // detected hosts drive the offer. The interactive gate above keeps this off the
   // scripted/CI path, so cross-SDK parity is unchanged.
   let chosen: PromptHost | null;
   if (agent) {
      const id = resolveHostId(agent);
      const spec = id && PROMPT_HOST_IDS.includes(id) ? HOST_SPECS.find((s) => s.id === id) : undefined;
      if (!spec) throw new Error(`--agent must be a launchable host (${PROMPT_HOST_IDS.join(', ')}); got "${agent}"`);
      chosen = { id: spec.id, bin: spec.bins[0], name: spec.name };
   } else {
      if (hosts.length === 0) return false;
      chosen = await chooseHost(hosts, promptArg, io);
   }
   if (!chosen) return false;
   return launchHost(chosen, promptArg, io);
}

/** The boot prompt `leji start` hands the agent: point it at the boot profile. */
function bootPrompt(bootRel: string): string {
   return `Read ./${bootRel}, follow it, and tell me when you're ready.`;
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
   io?: HandoffIo;
}

/**
 * `leji start`: boot a coding agent into an existing layer, pointed at the boot
 * profile. One detected host launches directly; several prompt; `--agent` forces a
 * specific launchable host. Launches from the layer root so the relative boot path
 * resolves. Returns 'launched' on a clean run, 'fallback' when there is nothing to
 * launch (no host, non-interactive, or the launch failed), or 'boot-missing' when
 * the boot profile path is unsafe or absent. Throws on an unknown/non-launchable
 * --agent (a usage error).
 */
export async function enterLayer(opts: StartOptions): Promise<StartOutcome> {
   const root = path.resolve(opts.root);
   const bootRel = opts.manifest.bootProfilePath;
   if (!RELATIVE_PATH_RE.test(bootRel) || !isFile(path.join(root, bootRel))) return 'boot-missing';
   const io = opts.io ?? defaultHandoffIo();
   const promptArg = bootPrompt(bootRel);

   let host: PromptHost | null = null;
   if (opts.agent) {
      const id = resolveHostId(opts.agent);
      const spec = id && PROMPT_HOST_IDS.includes(id) ? HOST_SPECS.find((s) => s.id === id) : undefined;
      if (!spec) {
         throw new Error(`--agent must be a launchable host (${PROMPT_HOST_IDS.join(', ')}); got "${opts.agent}"`);
      }
      host = { id: spec.id, bin: spec.bins[0], name: spec.name };
   } else {
      const hosts = promptCapableHosts(opts.detected);
      if (hosts.length === 1) host = hosts[0];
      else if (hosts.length > 1 && opts.interactive) host = await pickFromMultiple(hosts, io);
   }

   if (!host || !opts.interactive) return 'fallback';
   return launchHost(host, promptArg, io, root) ? 'launched' : 'fallback';
}

/** Printed when `leji start` launches nothing (no agent, non-interactive, or a
 * failed launch): the copy-paste commands to enter the layer via the boot profile. */
export function enteringViaBoot(manifest: Manifest): string {
   const promptArg = bootPrompt(manifest.bootProfilePath);
   return [
      '',
      'No coding agent was launched. To enter this context layer, run one of:',
      '',
      `   claude "${promptArg}"`,
      `   codex "${promptArg}"`,
      '',
      'Each points the agent at the boot profile, which loads the team context before any work.',
   ].join('\n');
}

/** Post-init guidance, printed by the CLI. */
export function enteringTheLayer(manifest: Manifest): string {
   const brief = briefPath(manifest.rootPath);
   return [
      '',
      'The scaffold is in place, but the content is still placeholder. Hand it to your agent',
      'to populate from your actual repository:',
      '',
      `   claude "Read ./${brief} and follow it."`,
      `   codex "Read ./${brief} and follow it."`,
      '',
      'The brief teaches the agent the Leji spec and points it at this repo: it reads your',
      'code, asks what it cannot infer, and fills in real context. Prefer to do it yourself?',
      'Edit the seeded documents directly. Either way, check progress with:',
      '',
      '   leji validate --content   # placeholder / thin-content warnings',
      '   leji conformance          # the level reached and what is next',
   ].join('\n');
}
