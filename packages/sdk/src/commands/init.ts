import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { type CategoryId, type Manifest, effectiveChangelogPath, effectiveIndexPath } from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import { isDir, isFile, readText, resolvedWithinRoot } from '../lib/fsx.js';
import { type PlanEntry, type PlannedWrite, buildWritePlan } from '../lib/writeplan.js';
import { HOST_SPECS, adapterContent, detectHosts, resolveHostId } from '../lib/detect.js';
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
   /** Designate a second host as the `reviewer` role (multi-agent workflow). */
   reviewer?: string;
   /** Write a GitHub Actions workflow that runs `leji validate` in CI. */
   ci?: boolean;
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
      // so dashes are never consecutive — trimming one per end is sufficient and
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
 * excluded from the index, the docs viewer, and the changelog. */
export function briefPath(rootPath: string): string {
   return `${rootPath}.leji/onboarding-brief.md`;
}

/** The governed on-ramp: a CI job that runs `leji validate` on every change. */
function buildCiWorkflow(): string {
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

/**
 * Resolve the file-style vendor adapter to create, honoring `--agent` (a host
 * id/alias, `auto` for the top detected host, or `none`/unset for nothing).
 * Never targets an existing entrypoint — those are migrated with consent during
 * adoption, never overwritten here — so it returns null when the file is present.
 */
function resolveAdapter(root: string, agent: string | undefined): string | null {
   if (!agent || agent === 'none') return null;
   let spec;
   if (agent === 'auto') {
      const top = detectHosts({ root }).find((h) => h.adapter);
      if (!top) return null;
      spec = HOST_SPECS.find((s) => s.id === top.id);
   } else {
      const id = resolveHostId(agent);
      spec = id ? HOST_SPECS.find((s) => s.id === id) : undefined;
      if (!spec) throw new Error(`unknown agent "${agent}"; known: ${HOST_SPECS.map((s) => s.id).join(', ')}`);
      if (!spec.adapter) throw new Error(`${spec.name} uses a directory-style adapter; wiring it is not yet supported`);
   }
   if (!spec?.adapter) return null;
   if (isFile(path.join(root, spec.adapter))) return null;
   return spec.adapter;
}

/** An agent profile for a named role bound to a specific host (multi-agent). */
function buildRoleProfile(role: string, hostId: string, rootPath: string): string {
   const title = role.charAt(0).toUpperCase() + role.slice(1);
   return `---
id: ${role}
name: ${title}
role: ${role}
host: ${hostId}
inherits: core
purpose: Independent review of proposed context-layer changes before a person approves.
requiredRead:
  - ${rootPath}boot-profile.md
  - ${rootPath}agents/core.md
mustAskWhen:
  - a proposal weakens an invariant or guardrail
  - a change to settled behavior lacks a decision record
---

# ${title}

A second agent (host \`${hostId}\`) that reviews context-layer proposals against the spec and this
layer's own rules before a person approves. Inherits the core posture; it never loosens it.

## Review focus

- The proposal matches how this team actually works (domain, system, governance).
- Placeholders are gone and claims are grounded in the repository.
- A change to settled behavior carries a decision record.
`;
}

/**
 * Designate a secondary host as the `reviewer` role: write its agent profile,
 * bind it in `manifest.agents`, and wire its vendor adapter when absent. Mutates
 * the manifest (agents + vendorAdapters) and returns the files to write.
 */
function wireReviewer(root: string, reviewer: string, manifest: Manifest, r: string): PlannedWrite[] {
   const id = resolveHostId(reviewer);
   const spec = id ? HOST_SPECS.find((s) => s.id === id) : undefined;
   if (!spec) throw new Error(`unknown agent "${reviewer}"; known: ${HOST_SPECS.map((s) => s.id).join(', ')}`);
   const out: PlannedWrite[] = [];
   const profileRel = `${r}agents/reviewer.md`;
   out.push({ rel: profileRel, content: buildRoleProfile('reviewer', spec.id, r) });
   manifest.agents = { ...(manifest.agents ?? {}), reviewer: profileRel };
   if (spec.adapter && !isFile(path.join(root, spec.adapter))) {
      const adapters = manifest.vendorAdapters ?? [];
      if (!adapters.includes(spec.adapter)) adapters.push(spec.adapter);
      manifest.vendorAdapters = adapters;
      out.push({ rel: spec.adapter, content: adapterContent(manifest.bootProfilePath) });
   }
   return out;
}

/**
 * Bootstrap a context layer from the vendored templates. Interactive unless
 * --yes. Refuses to run when leji.json already exists; never overwrites
 * existing files (seeds land only where nothing is in the way). With
 * `dryRun`, computes the write plan and touches nothing.
 */
export async function initLayer(options: InitOptions): Promise<InitResult> {
   const root = path.resolve(options.dir);
   if (fs.existsSync(path.join(root, 'leji.json'))) {
      throw new Error('leji.json already exists here; init refuses to overwrite an existing layer');
   }
   const answers = await prompt(options);
   // Guard rootPath (and so every derived write path) before any write: reject
   // absolute paths, .. segments, ./ prefixes, and backslashes.
   assertRelativePath(answers.rootPath);

   const manifest = buildManifest(answers);
   const adapter = resolveAdapter(root, options.agent);
   if (adapter) manifest.vendorAdapters = [adapter];
   const r = answers.rootPath;
   // Multi-agent: a reviewer role bound to a second host (mutates the manifest
   // before leji.json is serialized below).
   const reviewerWrites = options.reviewer ? wireReviewer(root, options.reviewer, manifest, r) : [];

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
   if (adapter) writes.push({ rel: adapter, content: adapterContent(manifest.bootProfilePath) });
   writes.push(...reviewerWrites);
   if (options.ci) writes.push({ rel: '.github/workflows/leji.yml', content: buildCiWorkflow() });
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
      return { written: [], manifest, plan, dryRun: true };
   }

   const written: string[] = [];
   fs.mkdirSync(root, { recursive: true });
   // leji.json is written directly (the guard above already proved it absent);
   // every other file goes through writeFileOnce so nothing is overwritten.
   if (!resolvedWithinRoot(root, path.join(root, 'leji.json'))) {
      throw new Error('refusing to write through a symlink that escapes the target: "leji.json"');
   }
   fs.writeFileSync(path.join(root, 'leji.json'), writes[0].content);
   written.push('leji.json');
   for (const w of writes.slice(1)) {
      writeFileOnce(root, w.rel, w.content, written);
   }
   if (answers.level === 'indexed') {
      writeIndex(root, manifest);
      written.push(effectiveIndexPath(manifest));
   }

   return { written: written.sort(), manifest, plan, dryRun: false };
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
   // shown verbatim, never rendered (no stored XSS in the Docsify local preview).
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
 * Bring Leji into an existing repository: reuse an existing docs root, migrate
 * the content of any vendor entrypoints into the layer (originals untouched),
 * and seed the standard scaffold. Refuses when a layer already exists. With
 * `wireAdapters`, converts the present entrypoints to redirects (a consented
 * overwrite, after their content has been migrated); otherwise the result is an
 * adoption draft that is not yet core-conformant.
 */
export async function adoptLayer(options: AdoptOptions): Promise<AdoptResult> {
   const root = path.resolve(options.dir);
   if (fs.existsSync(path.join(root, 'leji.json'))) {
      throw new Error('leji.json already exists here; this repository already has a Leji layer');
   }
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
   const newAdapter = resolveAdapter(root, options.agent);
   const r = answers.rootPath;

   // Convert only files that aren't already the canonical redirect; each has been
   // captured in toMigrate above, so the overwrite never loses content.
   const toConvert = options.wireAdapters ? vendorPresent.filter(notCanonical) : [];
   const adapters: string[] = [];
   if (newAdapter) adapters.push(newAdapter);
   for (const rel of toConvert) if (!adapters.includes(rel)) adapters.push(rel);
   if (adapters.length > 0) manifest.vendorAdapters = adapters;

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

   if (newAdapter) writes.push({ rel: newAdapter, content: adapterContent(manifest.bootProfilePath) });
   for (const rel of toConvert) writes.push({ rel, content: adapterContent(manifest.bootProfilePath) });

   const wontModify = vendorPresent.filter((rel) => !toConvert.includes(rel));
   const plan = buildWritePlan(root, writes, wontModify, toConvert);
   const draft = wontModify.some((rel) => !readText(path.join(root, rel)).includes(bootRel));

   if (options.dryRun) {
      return { written: [], manifest, plan, dryRun: true, detectedRoot, migrated, draft };
   }

   const written: string[] = [];
   fs.mkdirSync(root, { recursive: true });
   if (!resolvedWithinRoot(root, path.join(root, 'leji.json'))) {
      throw new Error('refusing to write through a symlink that escapes the target: "leji.json"');
   }
   fs.writeFileSync(path.join(root, 'leji.json'), writes[0].content);
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

   return { written: written.sort(), manifest, plan, dryRun: false, detectedRoot, migrated, draft };
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
