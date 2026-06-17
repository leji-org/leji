import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { type CategoryId, type Manifest } from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import { writeIndex } from './indexgen.js';

/** Options for scaffolding a new context layer with `initLayer`. */
export interface InitOptions {
   dir: string;
   yes: boolean;
   name?: string;
   level?: 'core' | 'indexed';
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
      body: '- **<Term>**: <what it means here, including what it does not mean>.\n',
   },
   system: {
      file: 'invariants.md',
      title: 'System Invariants',
      summary: 'The constraints every change lives with.',
      body: '- <An invariant every change must respect, e.g. "money values are integer minor units">.\n',
   },
   practice: {
      file: 'conventions.md',
      title: 'Conventions',
      summary: 'Conventions and patterns applied automatically.',
      body: '- <A convention that has proven out at least twice (the proven-twice gate)>.\n',
   },
   governance: {
      file: 'operating-rules.md',
      title: 'Operating Rules',
      summary: 'What agents may do unprompted and what needs a human gate.',
      body: '- Proceed without asking when: <defaults>.\n- Stop and ask when: <escalation triggers>.\n',
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
      machine: {
         agentProfilesPath: `${r}agents/`,
         decisionRecordsPath: `${r}decisions/`,
      },
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
   if (answers.level === 'indexed') {
      manifest.machine = {
         indexPath: `${r}context-index.json`,
         changelogPath: `${r}context-changelog.json`,
         ...manifest.machine,
      };
   }
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

/**
 * Bootstrap a context layer from the vendored templates. Interactive unless
 * --yes. Refuses to run when leji.json already exists; never overwrites
 * existing files (seeds land only where nothing is in the way).
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
   const written: string[] = [];
   const r = answers.rootPath;

   // Write leji.json FIRST so the overwrite guard is effective on a retry after
   // an interrupted run (no orphan half-scaffold the guard can't catch).
   fs.mkdirSync(root, { recursive: true });
   fs.writeFileSync(path.join(root, 'leji.json'), JSON.stringify(manifest, null, 2) + '\n');
   written.push('leji.json');

   writeFileOnce(root, manifest.bootProfilePath, buildBootProfile(answers), written);
   for (const category of answers.categories) {
      if (category === 'decisions') continue;
      const stub = CATEGORY_STUBS[category];
      writeFileOnce(root, `${r}${category}/${stub.file}`, categoryStub(stub.title, stub.summary, stub.body), written);
   }
   writeFileOnce(root, `${r}decisions/0001-adopt-leji.md`, buildFirstDecision(answers), written);
   writeFileOnce(root, `${r}agents/core.md`, buildCoreProfile(answers), written);

   if (answers.level === 'indexed') {
      writeFileOnce(root, manifest.machine!.changelogPath!, buildChangelog(answers, [...written]), written);
   }

   if (answers.level === 'indexed') {
      writeIndex(root, manifest);
      written.push(manifest.machine!.indexPath!);
   }

   return { written: written.sort(), manifest };
}

/** Post-init guidance, printed by the CLI. */
export function enteringTheLayer(manifest: Manifest): string {
   const boot = manifest.bootProfilePath;
   return [
      '',
      "Enter the layer by direct invocation, so the boot profile is the agent's first context:",
      '',
      `   claude "Read ./${boot}, follow all instructions, and tell me when you are ready to begin."`,
      `   codex "Read ./${boot} and follow it before doing anything else."`,
      '',
      'Package the invocation for the whole team (package.json):',
      '',
      `   "start": "claude 'Read ./${boot}, follow all instructions, and tell me when you are ready to begin.'"`,
      '',
      'Next: fill in the seeded documents, then run `leji validate` and `leji conformance`.',
   ].join('\n');
}
