import { type Finding, finding, hasErrors, sortFindings, summarize } from './lib/findings.js';
import { stripSlash } from './lib/fsx.js';
import { effectiveChangelogPath, effectiveIndexPath, loadManifest } from './lib/manifest.js';
import { type CliOption, SDK_VERSION, SUPPORTED_LINES, loadCliSpec } from './lib/schemas.js';
import { checkIndex, generateIndex, writeIndex } from './commands/indexgen.js';
import { checkChangelogAppendOnly, validateLayer } from './commands/validate.js';
import { compactChangelog, seedChangelogIfMissing } from './commands/changelog.js';
import { conformanceReport, renderExplain } from './commands/conformance.js';
import {
   PROTECT_WARNING,
   buildViewer,
   generateViewer,
   openBrowser,
   resolveViewerPort,
   serveViewer,
} from './commands/viewer.js';
import { freshnessReport } from './commands/freshness.js';
import { statusReport } from './commands/status.js';
import {
   addAgent,
   adoptLayer,
   ensureCiWorkflow,
   type CiProvider,
   enterLayer,
   enteringAdopted,
   enteringTheLayer,
   enteringViaBoot,
   handoffOffer,
   ciProviderFromRemote,
   pickDocsRoot,
   ensureApprovalGuard,
   ensureLocalHook,
   offerApprovalGuard,
   offerMcpInstall,
   initLayer,
} from './commands/init.js';
import { detectLayer, renderDetect } from './commands/detect.js';
import { detectHosts } from './lib/detect.js';
import { gitOriginUrl } from './lib/git.js';
import { renderWritePlan } from './lib/writeplan.js';
import { CATEGORY_IDS, type CategoryId } from './lib/manifest.js';
import { route } from './lib/route.js';
import { federationEnforcement, hydrateMounts, locateMount, mountStatus } from './lib/mounts.js';

export { validateLayer } from './commands/validate.js';
export { checkIndex, generateIndex, writeIndex } from './commands/indexgen.js';
export { checkChangelogAppendOnly } from './commands/validate.js';
export { compactChangelog, seedChangelogIfMissing, serializeChangelog } from './commands/changelog.js';
export { conformanceReport, renderExplain } from './commands/conformance.js';
export {
   buildSidebar,
   buildViewer,
   buildLayerMap,
   buildManifestPage,
   generateViewer,
   resolveViewerPort,
   resolvedProfilePage,
   serveViewer,
   urlPathToRel,
} from './commands/viewer.js';
export { profileInheritanceFindings, resolveAgentProfile, scanProfileSet } from './lib/layer.js';
export type { ResolvedProfile, ScannedProfile } from './lib/layer.js';
export { freshnessReport } from './commands/freshness.js';
export { statusReport } from './commands/status.js';
export {
   initLayer,
   adoptLayer,
   addAgent,
   handoffOffer,
   ciProviderFromRemote,
   pickDocsRoot,
   ensureApprovalGuard,
   ensureLocalHook,
   offerApprovalGuard,
   offerMcpInstall,
   enterLayer,
   enteringAdopted,
   enteringViaBoot,
   ensureCiWorkflow,
   type CiProvider,
} from './commands/init.js';
export { detectLayer, renderDetect } from './commands/detect.js';
export { buildWritePlan, renderWritePlan } from './lib/writeplan.js';
export { route, LIVE_STATUSES } from './lib/route.js';
export type {
   RouteInput,
   RouteResult,
   RoutedDecision,
   RoutedDocument,
   RoutedMount,
   DecisionMatch,
} from './lib/route.js';
export { detectHosts, resolveHostId, adapterContent, HOST_SPECS } from './lib/detect.js';
export { loadManifest, validateManifestObject } from './lib/manifest.js';
export { SDK_VERSION, SUPPORTED_LINES, loadCliSpec } from './lib/schemas.js';
export type { Finding, Severity } from './lib/findings.js';
export type { Manifest, ManifestLoad, ConformanceLevel, CategoryId } from './lib/manifest.js';
export type { CliSpec, CliOption } from './lib/schemas.js';
export type { ContextIndex, IndexEntry } from './commands/indexgen.js';
export type { CompactOptions, CompactResult } from './commands/changelog.js';
export type { ConformanceResult, ChecklistItem } from './commands/conformance.js';
export type { FreshnessReport } from './commands/freshness.js';
export type { StatusReport, DanglingEntry } from './commands/status.js';
export type {
   InitOptions,
   InitResult,
   AdoptOptions,
   AdoptResult,
   AgentResult,
   HandoffIo,
   McpOfferOptions,
   McpOfferOutcome,
   PromptHost,
   StartOptions,
   StartOutcome,
} from './commands/init.js';

/** Top-level help, generated from cli.json so it can't drift. Lists commands and
 * global options only; per-command options live in `leji <command> --help`. */
export function renderUsage(): string {
   const spec = loadCliSpec();
   const out: string[] = [
      `leji ${SDK_VERSION}: reference CLI for the Leji specification (spec line ${SUPPORTED_LINES.join(', ')})`,
      '',
      `Usage: ${spec.usage}`,
      '',
      'Commands:',
   ];
   const cmdWidth = Math.max(...spec.commands.map((c) => c.name.length)) + 3;
   for (const c of spec.commands) out.push(`   ${c.name.padEnd(cmdWidth)}${c.summary}`);

   const optWidth = Math.max(...spec.globalOptions.map((o) => o.flags.length)) + 3;
   out.push('', 'Options:');
   for (const o of spec.globalOptions) out.push(`   ${o.flags.padEnd(optWidth)}${o.summary}`);

   out.push('', 'Run `leji <command> --help` for a command and its options.', 'Full reference: https://leji.org/cli/');
   return out.join('\n');
}

/** Per-command help, generated from cli.json. Returns null for an unknown command
 * so the caller falls back to top-level usage. */
export function renderCommandHelp(name: string): string | null {
   const spec = loadCliSpec();
   const cmd = spec.commands.find((c) => c.name === name);
   if (!cmd) return null;
   const out: string[] = [`leji ${cmd.name}: ${cmd.summary}`, '', `Usage: ${cmd.usage}`, '', cmd.description];
   if (cmd.details && cmd.details.length > 0) {
      out.push('', 'Details:');
      for (const d of cmd.details) out.push(`   - ${d}`);
   }
   const opts: CliOption[] = [...spec.globalOptions, ...cmd.options];
   const optWidth = Math.max(...opts.map((o) => o.flags.length)) + 3;
   out.push('', 'Options:');
   for (const o of opts) out.push(`   ${o.flags.padEnd(optWidth)}${o.summary}`);
   if (cmd.examples && cmd.examples.length > 0) {
      out.push('', 'Examples:');
      for (const e of cmd.examples) out.push(`   ${e}`);
   }
   out.push('', 'Full reference: https://leji.org/cli/');
   return out.join('\n');
}

const USAGE = renderUsage();

interface Flags {
   root: string;
   json: boolean;
   check: boolean;
   strict: boolean;
   yes: boolean;
   open: boolean;
   content: boolean;
   dryRun: boolean;
   wireAdapters: boolean;
   noAgents: boolean;
   hooks: boolean;
   explain: boolean;
   fetch: boolean;
   checkIntegrity: boolean;
   help: boolean;
   version: boolean;
   port?: number;
   dir: string;
   level?: 'core' | 'indexed';
   mode?: 'solo' | 'team';
   name?: string;
   agent?: string;
   hostArgs?: string[];
   host?: string;
   role?: string;
   out?: string;
   keep?: number;
   before?: string;
   provider?: string;
   paths?: string;
   categories?: string;
   /** Repeatable: one whole topic per occurrence, accumulated in order. */
   topics?: string[];
   asOf?: string;
   federation?: string;
}

/** A following token that is itself a flag (not a bare "-") cannot be a flag's
 * value: `--root --json` is a missing value, not root="--json". */
function isFlagToken(v: string | undefined): boolean {
   return v !== undefined && v !== '-' && v.startsWith('-');
}

/** The largest `--keep`, chosen so all three SDKs carry the value identically:
 * above it Go's `strconv.Atoi` overflows while `Number()` and Python's `int()`
 * keep going, and no changelog has 2^31 entries. */
const KEEP_MAX = 2147483647;

/** A numeric flag's value: a plain decimal integer (optionally `+`-signed) inside
 * `[min, max]`, or undefined. Deliberately not `Number()`, which also accepts
 * `0x10`, `1e3`, and ` 8 ` — spellings Go's `strconv.Atoi` and a digit-checked
 * Python parse both reject, so `--port 1e3` served port 1000 here and was a usage
 * error there. `\d` is ASCII-only in JS, matching the other two. */
function parseIntFlag(raw: string, min: number, max: number): number | undefined {
   if (!/^\+?\d+$/.test(raw)) return undefined;
   const v = Number(raw);
   return v >= min && v <= max ? v : undefined;
}

/** Expand `--flag=value` into `--flag value` for declared value flags, so both
 * spellings work (`--federation=available` and `--federation available`). Tokens
 * after a literal `--` are host pass-through and stay untouched. */
function expandEqualsFlags(argv: string[]): string[] {
   const out: string[] = [];
   let passthrough = false;
   for (const a of argv) {
      if (a === '--') passthrough = true;
      const eq = !passthrough && a.startsWith('--') ? a.indexOf('=') : -1;
      if (eq > 2 && VALUE_FLAGS.has(a.slice(0, eq))) {
         out.push(a.slice(0, eq), a.slice(eq + 1));
      } else {
         out.push(a);
      }
   }
   return out;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[]; error?: string } {
   argv = expandEqualsFlags(argv);
   const flags: Flags = {
      root: '.',
      json: false,
      check: false,
      strict: false,
      yes: false,
      open: false,
      content: false,
      dryRun: false,
      wireAdapters: false,
      noAgents: false,
      hooks: false,
      explain: false,
      fetch: false,
      checkIntegrity: false,
      help: false,
      version: false,
      dir: '.',
   };
   const rest: string[] = [];
   for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      switch (arg) {
         case '--hooks':
            flags.hooks = true;
            break;
         case '--': {
            // Everything after a literal -- passes verbatim to the launched host.
            // Only `start` declares `--` in cli.json, and the per-command flag check
            // rejects it anywhere else: a swallowed `leji validate -- --bogus` exited
            // 0, so a typo'd flag reported success on a validation command.
            flags.hostArgs = argv.slice(i + 1);
            i = argv.length;
            break;
         }
         case '--root': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--root requires a value' };
            flags.root = v;
            break;
         }
         case '--dir': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--dir requires a value' };
            flags.dir = v;
            break;
         }
         case '--level': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--level requires a value' };
            if (v !== 'core' && v !== 'indexed') return { flags, rest, error: '--level must be core or indexed' };
            flags.level = v;
            break;
         }
         case '--mode': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--mode requires a value' };
            if (v !== 'solo' && v !== 'team') return { flags, rest, error: '--mode must be solo or team' };
            flags.mode = v;
            break;
         }
         case '--name': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--name requires a value' };
            flags.name = v;
            break;
         }
         case '--agent': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--agent requires a value' };
            flags.agent = v;
            break;
         }
         case '--host': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--host requires a value' };
            flags.host = v;
            break;
         }
         case '--role': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--role requires a value' };
            flags.role = v;
            break;
         }
         case '--out': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--out requires a value' };
            flags.out = v;
            break;
         }
         case '--keep': {
            const raw = argv[++i];
            if (!raw || isFlagToken(raw)) return { flags, rest, error: '--keep requires a value' };
            const v = parseIntFlag(raw, 1, KEEP_MAX);
            if (v === undefined) return { flags, rest, error: '--keep must be a positive integer' };
            flags.keep = v;
            break;
         }
         case '--before': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--before requires a value' };
            flags.before = v;
            break;
         }
         case '--provider': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--provider requires a value' };
            flags.provider = v;
            break;
         }
         case '--paths': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--paths requires a value' };
            flags.paths = v;
            break;
         }
         case '--categories': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--categories requires a value' };
            flags.categories = v;
            break;
         }
         // Repeatable and never comma-split: a topic is free text, so a comma
         // inside one would be unrepresentable under the --paths/--categories
         // list form. An empty occurrence is kept here and rejected by the
         // command, so the caller gets the topic-shaped message rather than a
         // bare usage dump.
         case '--topics': {
            const v = argv[++i];
            if (v === undefined || isFlagToken(v)) return { flags, rest, error: '--topics requires a value' };
            (flags.topics ??= []).push(v);
            break;
         }
         case '--as-of': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--as-of requires a value' };
            flags.asOf = v;
            break;
         }
         case '--open':
            flags.open = true;
            break;
         case '--fetch':
            flags.fetch = true;
            break;
         case '--federation': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--federation requires a value' };
            flags.federation = v;
            break;
         }
         case '--check-integrity':
            flags.checkIntegrity = true;
            break;
         case '--port': {
            const raw = argv[++i];
            if (!raw || isFlagToken(raw)) return { flags, rest, error: '--port requires a value' };
            const v = parseIntFlag(raw, 0, 65535);
            if (v === undefined) return { flags, rest, error: '--port must be 0-65535' };
            flags.port = v;
            break;
         }
         case '--json':
            flags.json = true;
            break;
         case '--check':
            flags.check = true;
            break;
         case '--content':
            flags.content = true;
            break;
         case '--dry-run':
            flags.dryRun = true;
            break;
         case '--wire-adapters':
            flags.wireAdapters = true;
            break;
         case '--no-agents':
            flags.noAgents = true;
            break;
         case '--explain':
            flags.explain = true;
            break;
         case '--strict':
            flags.strict = true;
            break;
         case '--yes':
         case '-y':
            flags.yes = true;
            break;
         case '-h':
         case '--help':
            flags.help = true;
            break;
         // -v/--version; no -V since there's no --verbose to collide with.
         case '-v':
         case '--version':
            flags.version = true;
            break;
         default:
            if (arg.startsWith('-')) {
               return { flags, rest, error: `unknown option ${arg}` };
            }
            rest.push(arg);
      }
   }
   return { flags, rest };
}

// Per-command flag validation, driven by cli.json: a command accepts the globals
// plus its own declared options; any other flag is a usage error, not ignored.
const VALUE_FLAGS = new Set([
   '--root',
   '--dir',
   '--level',
   '--mode',
   '--name',
   '--port',
   '--agent',
   '--host',
   '--role',
   '--out',
   '--keep',
   '--before',
   '--provider',
   '--paths',
   '--categories',
   '--topics',
   '--as-of',
   '--federation',
]);

function flagTokens(flagsStr: string): string[] {
   // "--yes, -y" -> ["--yes","-y"]; "--port <n>" -> ["--port"].
   return flagsStr
      .split(',')
      .map((s) => s.trim().split(/\s+/)[0])
      .filter(Boolean);
}

function seenFlags(argv: string[]): string[] {
   const out: string[] = [];
   for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      // `--` is itself a declared flag (on `start` only); everything after it is
      // host pass-through and never our flags, so the scan records it and stops.
      if (a === '--') {
         out.push('--');
         break;
      }
      if (a.startsWith('-')) {
         const eq = a.startsWith('--') ? a.indexOf('=') : -1;
         const name = eq > 2 ? a.slice(0, eq) : a;
         out.push(name);
         if (VALUE_FLAGS.has(name) && eq < 0) i++; // skip the flag's value, not a flag itself
      }
   }
   return out;
}

// Commands taking a subcommand, e.g. `changelog check`, `viewer serve`. The bare
// form is valid only when cli.json documents it (e.g. `viewer`, not `changelog`).
const TWO_WORD_COMMANDS = new Set(['changelog', 'viewer', 'mounts']);

function allowedFlagsFor(command: string, sub: string | undefined): Set<string> | null {
   const spec = loadCliSpec();
   const name = TWO_WORD_COMMANDS.has(command) && sub ? `${command} ${sub}` : command;
   const cmd = spec.commands.find((c) => c.name === name);
   if (!cmd) return null; // unknown command: leave it to the dispatcher's default
   const allowed = new Set<string>();
   for (const o of [...spec.globalOptions, ...cmd.options]) {
      for (const t of flagTokens(o.flags)) allowed.add(t);
   }
   return allowed;
}

function printFindings(findings: Finding[]): void {
   for (const f of sortFindings(findings)) {
      const where = f.path ? ` ${f.path}` : '';
      console.log(`${f.severity === 'error' ? 'error  ' : 'warning'} ${f.rule}${where}: ${f.message}`);
   }
}

/** The mount findings `mounts hydrate` and `mounts status` emit: what this run
 * observed and nothing beyond it. The row-level warnings describe the run that is
 * happening, never a remembered one, and all are visibility rather than failure —
 * `hydrate` stays best-effort, so none moves the exit code. */
function mountFindings(
   rows: {
      name: string;
      status?: string;
      detail?: string;
      storeFetched?: boolean;
      witnessRefreshFailed?: boolean;
      projectionFailed?: boolean;
   }[],
): Finding[] {
   const out: Finding[] = [];
   for (const o of rows) {
      // An unavailable mount whose pinned layer would not project: the outcome alone
      // is not the diagnostic interface JSON consumers read, so the failure reaches
      // findings[] too, carrying the projection's own stable detail unaltered.
      if (o.status === 'unavailable' && o.projectionFailed) {
         out.push(
            finding(
               'mount-projection-failed',
               'warning',
               `mount "${o.name}" did not project at its pin: ${o.detail}`,
               o.name,
            ),
         );
      }
      if (o.storeFetched === false) {
         out.push(
            finding(
               'mount-store-fetch-failed',
               'warning',
               'the managed store could not be established by the requested fetch',
               o.name,
            ),
         );
      }
      if (o.witnessRefreshFailed) {
         out.push(
            finding(
               'mount-witness-refresh-failed',
               'warning',
               'the managed witness ref could not be refreshed by the requested fetch',
               o.name,
            ),
         );
      }
   }
   return sortFindings(out);
}

/** Prose for the stable `mounts status` reason codes: --json emits the code, a
 * person reads the sentence. */
const MOUNT_REASONS: Record<string, string> = {
   'mount-source-unnormalizable': 'source is not a normalizable locator',
   'mount-no-tracking-ref': "no trackingRef declared; the source's advertised default branch needs network access",
   'mount-tracking-ref-invalid': 'trackingRef is not a fully qualified branch or tag',
   'mount-pin-unavailable': 'no reachable object store holds the pin (declare a hint, or pass --fetch)',
   'mount-witness-unavailable':
      'no object store holding the pin resolves the witness ref; run `leji mounts hydrate --fetch`',
   'mount-source-ambiguous':
      'more than one submodule matches the source; declare an explicit hint in .leji/mounts.local.json',
   'mount-ancestry-incomplete': 'incomplete ancestry; the comparison repository cannot answer the range',
};

/**
 * Report index-generation findings from `init` / `adopt`. The scaffold is already
 * on disk, so this never unwinds it; it says what could not be indexed and returns
 * the exit status, because a scaffold whose index is missing will fail the CI that
 * `leji ci` generates and reporting success would hide that until then.
 */
/** A real calendar date in `YYYY-MM-DD`. The regex alone accepts 2026-02-30, so the
 * parsed date is round-tripped: only a date that survives is real. */
function isCalendarDate(v: string): boolean {
   if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) return false;
   const d = new Date(`${v}T00:00:00Z`);
   return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function reportScaffoldIndex(findings: Finding[]): number {
   if (!hasErrors(findings)) return 0;
   console.log('');
   printFindings(sortFindings(findings));
   console.error(
      'leji: the context index could not be generated, so it was not written.\n' +
         '      The scaffold is in place; fix the findings above and run `leji index`.',
   );
   return 1;
}

function emit(command: string, findings: Finding[], json: boolean, extra: Record<string, unknown> = {}): number {
   const sorted = sortFindings(findings);
   const summary = summarize(sorted);
   const ok = summary.errors === 0;
   if (json) {
      console.log(JSON.stringify({ command, ok, findings: sorted, summary, ...extra }, null, 2));
   } else {
      printFindings(sorted);
      const extras = Object.entries(extra)
         .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
         .map(([k, v]) => `${k}: ${v}`)
         .join(', ');
      console.log(
         `${ok ? 'ok' : 'failed'} (${summary.errors} error${summary.errors === 1 ? '' : 's'}, ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}${extras ? `; ${extras}` : ''})`,
      );
   }
   return ok ? 0 : 1;
}

/** Run the CLI; returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
   const { flags, rest, error } = parseFlags(argv);
   if (error) {
      console.error(`leji: ${error}\n`);
      console.error(USAGE);
      return 2;
   }
   // Meta-flags short-circuit before dispatch wherever they appear in argv, so a
   // help/version request never runs the command (must have no side effects).
   if (flags.help) {
      const [hcmd, hsub] = rest;
      const hname = hcmd && TWO_WORD_COMMANDS.has(hcmd) && hsub ? `${hcmd} ${hsub}` : hcmd;
      console.log((hname && renderCommandHelp(hname)) || USAGE);
      return 0;
   }
   if (flags.version) {
      console.log(SDK_VERSION);
      return 0;
   }
   const [command, sub] = rest;
   if (!command || command === 'help') {
      console.log(USAGE);
      return command ? 0 : 2;
   }
   if (command === 'version') {
      console.log(SDK_VERSION);
      return 0;
   }

   // Reject any flag not declared for this command in cli.json (globals always ok).
   // Runs after the help/version short-circuit; unknown commands fall through.
   const allowed = allowedFlagsFor(command, sub);
   if (allowed) {
      const bad = seenFlags(argv).find((t) => !allowed.has(t));
      if (bad) {
         const where = TWO_WORD_COMMANDS.has(command) && sub ? `${command} ${sub}` : command;
         console.error(`leji: ${bad} is not valid for "${where}"\n`);
         console.error(USAGE);
         return 2;
      }
   }

   // Reject surplus positional arguments. Python's parser rejected them while this
   // one and Go silently ignored them, so a typo or an accidentally appended filename
   // was accepted by two implementations out of three.
   {
      const expected =
         (TWO_WORD_COMMANDS.has(command) && sub ? 2 : 1) + (command === 'mounts' && sub === 'locate' ? 1 : 0);
      // `view` has its own usage message for a stray subcommand, and it is the more
      // useful one; let that case fall through to it.
      if (command !== 'view' && rest.length > expected) {
         const where = TWO_WORD_COMMANDS.has(command) && sub ? `${command} ${sub}` : command;
         console.error(`leji: unexpected argument "${rest[expected]}" for "${where}"\n`);
         console.error(USAGE);
         return 2;
      }
   }

   try {
      switch (command) {
         case 'validate': {
            const result = validateLayer(flags.root, { content: flags.content });
            if (!flags.federation) return emit('validate', result.findings, flags.json);
            if (flags.federation !== 'available' && flags.federation !== 'required') {
               console.error('leji: --federation must be available or required\n');
               console.error(USAGE);
               return 2;
            }
            const { manifest } = loadManifest(flags.root);
            if (!manifest) return emit('validate', result.findings, flags.json);
            let taskMounts: Set<string> | null = null;
            if (flags.federation === 'required') {
               if (!flags.paths) {
                  console.error('leji: --federation=required needs --paths <a,b,...> (the task scope)\n');
                  console.error(USAGE);
                  return 2;
               }
               const routed = route(flags.root, manifest, {
                  paths: flags.paths
                     .split(',')
                     .map((p) => p.trim())
                     .filter(Boolean),
               });
               taskMounts = new Set(routed.mounts.map((m) => m.name));
            }
            const enforcement = federationEnforcement(flags.root, manifest, flags.federation, taskMounts).map((f) =>
               finding(f.rule, f.severity, f.message, f.path),
            );
            return emit(`validate --federation=${flags.federation}`, [...result.findings, ...enforcement], flags.json);
         }
         case 'index': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('index', findings, flags.json);
            if (flags.check) {
               const result = checkIndex(flags.root, manifest);
               return emit('index --check', [...findings, ...result.findings], flags.json, {
                  stale: result.stale ?? true,
               });
            }
            const result = writeIndex(flags.root, manifest);
            // writeIndex refuses to write when generation hit a hard error; in that
            // case report nothing written and don't seed a changelog off a bad tree.
            const wrote = !result.findings.some((f) => f.severity === 'error');
            // Complete the indexed surface: if the layer claims indexed (or higher)
            // and has no changelog yet, seed it (the changelog is otherwise only
            // written by `init --level indexed`). No-op at core or when present.
            const seededChangelog = wrote ? seedChangelogIfMissing(flags.root, manifest) : undefined;
            return emit('index', [...findings, ...result.findings], flags.json, {
               ...(wrote ? { written: effectiveIndexPath(manifest) } : {}),
               entries: wrote ? (result.index?.entries.length ?? 0) : 0,
               ...(seededChangelog ? { changelog: seededChangelog } : {}),
            });
         }
         case 'changelog': {
            if (sub === 'check') {
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('changelog check', findings, flags.json);
               const rel = effectiveChangelogPath(manifest);
               const result = checkChangelogAppendOnly(flags.root, rel, flags.strict);
               return emit('changelog check', [...findings, ...result.findings], flags.json, {
                  verified: result.verified,
               });
            }
            if (sub === 'compact') {
               if (flags.keep === undefined && flags.before === undefined) {
                  console.error('leji: changelog compact requires --keep or --before\n');
                  console.error(USAGE);
                  return 2;
               }
               // Compaction removes entries. A date that is merely digit-shaped, like
               // 2026-99-99, would select a run for a destructive rewrite on a day that
               // does not exist, so it is rejected before anything is written.
               if (flags.before !== undefined && !isCalendarDate(flags.before)) {
                  console.error(`leji: --before must be a calendar date (YYYY-MM-DD), got "${flags.before}"`);
                  return 2;
               }
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('changelog compact', findings, flags.json);
               const result = compactChangelog(flags.root, manifest, { keep: flags.keep, before: flags.before });
               return emit('changelog compact', [...findings, ...result.findings], flags.json, {
                  changelog: result.path,
                  folded: result.folded,
                  kept: result.kept,
                  note: result.folded === 0 && result.findings.length === 0 ? 'nothing to compact' : undefined,
               });
            }
            console.error('leji: usage: leji changelog <check|compact>\n');
            return 2;
         }
         case 'freshness': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('freshness', findings, flags.json);
            const report = freshnessReport(flags.root, manifest, flags.strict);
            if (!flags.json) {
               for (const item of report.upcoming) {
                  console.log(`upcoming ${item.path}: review after ${item.reviewAfter}`);
               }
            }
            return emit('freshness', [...findings, ...report.findings], flags.json, {
               declared: report.declared,
               expired: flags.json ? report.expired : report.expired.length,
               upcoming: flags.json ? report.upcoming : report.upcoming.length,
            });
         }
         case 'status': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('status', findings, flags.json);
            const report = statusReport(flags.root, manifest);
            const flagged =
               report.unindexed.length + report.dangling.length + report.stale.length + report.pending.length;
            const exit = flags.strict && flagged > 0 ? 1 : 0;
            if (flags.json) {
               console.log(
                  JSON.stringify({ command: 'status', ok: exit === 0, strict: flags.strict, ...report }, null, 2),
               );
               return exit;
            }
            console.log(`Unindexed (present, in no category index; reference): ${report.unindexed.length}`);
            for (const p of report.unindexed) console.log(`  ${p}`);
            console.log(`Dangling index entries (listed but unresolved): ${report.dangling.length}`);
            for (const d of report.dangling) console.log(`  ${d.indexFile}: ${d.detail}`);
            console.log(`Stale index entries (in stored index, no longer resolved): ${report.stale.length}`);
            for (const p of report.stale) console.log(`  ${p}`);
            console.log(
               `Pending index entries (governed, not yet in the stored index; run \`leji index\`): ${report.pending.length}`,
            );
            for (const p of report.pending) console.log(`  ${p}`);
            // Informational only: shadowed selectors never count toward strict.
            console.log(`Shadowed selectors (fully displaced by more-specific ones): ${report.shadowed.length}`);
            for (const s of report.shadowed) console.log(`  ${s.indexFile}: ${s.path}`);
            // Informational only: directory expansion skips READMEs by rule; this
            // surfaces each skip so governing one is a decision, not an accident.
            console.log(
               `READMEs skipped by directory expansion (govern with an explicit entry, or leave as reference): ${report.skippedReadmes.length}`,
            );
            for (const s of report.skippedReadmes) console.log(`  ${s.indexFile}: ${s.path}`);
            // Report-only: judged against HEAD's object store, so it sees what a
            // host's hydrate would see, including untracked-but-bound files.
            const proj = report.projection;
            if (proj.state === 'no-commit') {
               console.log('Projection (as a mounted sibling, at HEAD): no commit to judge');
            } else if (proj.state === 'ok') {
               console.log(
                  `Projection (as a mounted sibling, at ${proj.commit.slice(0, 12)}): closure enumerates completely (${proj.files} file${proj.files === 1 ? '' : 's'})`,
               );
            } else {
               console.log(`Projection (as a mounted sibling, at ${proj.commit.slice(0, 12)}): FAILS: ${proj.detail}`);
            }
            console.log(
               `${exit === 0 ? 'ok' : 'flagged'} (${flagged} item${flagged === 1 ? '' : 's'}${flags.strict ? ', strict' : ''})`,
            );
            return exit;
         }
         case 'route': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('route', findings, flags.json);
            const asOf = flags.asOf ?? new Date().toISOString().slice(0, 10);
            // Validate before routing. An unknown category or a non-date silently
            // produced a plausible, empty result: the caller cannot tell "nothing
            // routes here" from "you typed it wrong", and the spec's own routing rules
            // forbid presenting an unrouted load as a scoped one.
            if (!isCalendarDate(asOf)) {
               console.error(`leji: --as-of must be a calendar date (YYYY-MM-DD), got "${asOf}"`);
               return 2;
            }
            const splitList = (s?: string): string[] =>
               s
                  ? s
                       .split(',')
                       .map((x) => x.trim())
                       .filter(Boolean)
                  : [];
            const requestedCategories = splitList(flags.categories);
            const unknownCategory = requestedCategories.find((c) => !CATEGORY_IDS.includes(c as CategoryId));
            if (unknownCategory !== undefined) {
               console.error(`leji: unknown category "${unknownCategory}"; expected one of ${CATEGORY_IDS.join(', ')}`);
               return 2;
            }
            // Each --topics occurrence is one whole topic: never split, never
            // trimmed. A topic is a non-empty string of Unicode scalar values, so
            // an unpaired surrogate (which has no UTF-8 encoding) is rejected here
            // rather than routed as a value no manifest can match.
            const requestedTopics = flags.topics ?? [];
            if (requestedTopics.some((t) => t.length === 0)) {
               console.error('leji: --topics takes a non-empty topic; each occurrence is one whole topic');
               return 2;
            }
            const invalidTopic = requestedTopics.find((t) => /\p{Surrogate}/u.test(t));
            if (invalidTopic !== undefined) {
               console.error(
                  `leji: invalid topic ${JSON.stringify(invalidTopic)}; a topic is Unicode scalar values (no unpaired surrogates)`,
               );
               return 2;
            }
            const result = route(flags.root, manifest, {
               paths: splitList(flags.paths),
               categories: requestedCategories as CategoryId[],
               topics: requestedTopics,
               asOf,
            });
            if (flags.json) {
               console.log(JSON.stringify({ command: 'route', ok: true, asOf, ...result }, null, 2));
               return 0;
            }
            console.log(`Task routing as of ${asOf}`);
            console.log(`Categories: ${result.categories.length > 0 ? result.categories.join(', ') : '(none)'}`);
            console.log(`Documents (${result.documents.length}):`);
            for (const d of result.documents) {
               const fr = d.reviewAfter ? ` (review after ${d.reviewAfter}${d.expired ? ', EXPIRED' : ''})` : '';
               console.log(`   ${d.path} [${d.category}]${fr}`);
            }
            console.log(`Records (${result.records.length}; dated candidates, never current intent):`);
            for (const r of result.records) {
               const dated = r.date ? `dated ${r.date}` : 'undated';
               console.log(`   ${r.path} [${r.category}] (${dated}${r.required ? ', required by task path' : ''})`);
            }
            console.log(`Decisions (${result.decisions.length}):`);
            for (const dec of result.decisions) console.log(`   ${dec.id} [${dec.status}] (${dec.matchedBy})`);
            console.log(`Mounts (${result.mounts.length}):`);
            for (const m of result.mounts) console.log(`   ${m.name} @ ${m.pin}`);
            if (!result.pathScoped) console.log('Note: no task paths given; path-scoped routing was not evaluated.');
            return 0;
         }
         case 'conformance': {
            if (flags.federation && flags.federation !== 'verify') {
               console.error('leji: --federation on conformance takes only verify\n');
               console.error(USAGE);
               return 2;
            }
            const result = conformanceReport(flags.root, { federation: flags.federation === 'verify' });
            if (!flags.json) {
               for (const item of result.items) {
                  const mark =
                     item.status === 'pass'
                        ? 'pass   '
                        : item.status === 'fail'
                          ? 'FAIL   '
                          : item.status === 'unknown'
                            ? 'unknown'
                            : item.status === 'not-applicable'
                              ? 'n/a    '
                              : 'manual ';
                  console.log(`${mark} [${item.level}] ${item.description}${item.detail ? ` — ${item.detail}` : ''}`);
               }
               console.log('');
               if (flags.explain) console.log(renderExplain(result) + '\n');
            }
            return emit('conformance', result.findings, flags.json, {
               claimedLevel: result.claimedLevel ?? 'none',
               verifiedLevel: result.verifiedLevel ?? 'none',
               processAttested: result.processAttested,
               ...(flags.json ? { items: result.items } : {}),
               // `--explain` renders presentation, so it stays out of the machine
               // payload: `items[]` already carries every input the explanation is
               // computed from (id, level, description, status, detail per check,
               // beside claimedLevel and verifiedLevel), and the explanation is one
               // rendering of them, wrapped for a terminal. Emitting it here put
               // prose under three-way byte parity forever for a string no machine
               // parses, and only Node ever did. A machine that wants the rendered
               // form calls `renderExplain` on the result, which is exactly what the
               // MCP server's `explain_conformance` tool does.
            });
         }
         case 'mounts': {
            if (sub !== 'hydrate' && sub !== 'status' && sub !== 'locate') {
               console.error('leji: usage: leji mounts <hydrate|status|locate>\n');
               console.error(USAGE);
               return 2;
            }
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit(`mounts ${sub}`, findings, flags.json);
            if (sub === 'hydrate') {
               const r = hydrateMounts(flags.root, manifest, { fetch: flags.fetch });
               if (r.fatal) {
                  console.error(`leji: ${r.fatal}`);
                  return 1;
               }
               const issues = mountFindings(r.outcomes);
               const hadError = r.outcomes.some((o) => o.status === 'error');
               if (flags.json) {
                  console.log(
                     JSON.stringify(
                        { command: 'mounts hydrate', ok: !hadError, outcomes: r.outcomes, findings: issues },
                        null,
                        2,
                     ),
                  );
               } else {
                  for (const o of r.outcomes) {
                     console.log(`${o.status.padEnd(11)} ${o.name}${o.detail ? `: ${o.detail}` : ''}`);
                  }
                  printFindings(issues);
                  const n = r.outcomes.filter((o) => o.status === 'hydrated' || o.status === 'cached').length;
                  console.log(
                     `${hadError ? 'failed' : 'ok'} (${n}/${r.outcomes.length} mount${r.outcomes.length === 1 ? '' : 's'} available)`,
                  );
               }
               // Best-effort: unavailability is availability, never failure, whether
               // no object store held the pin or the pinned layer would not project.
               // Errors (declaration, and the projection's safety guards) are.
               return hadError ? 1 : 0;
            }
            if (sub === 'locate') {
               const name = rest[2];
               if (!name) {
                  console.error('leji: usage: leji mounts locate <name>\n');
                  return 2;
               }
               const r = locateMount(flags.root, manifest, name);
               if (flags.json) {
                  console.log(JSON.stringify({ command: 'mounts locate', ...r }, null, 2));
               } else {
                  console.log(`name: ${r.name}`);
                  console.log(`pin: ${r.pin ?? '(undeclared)'}`);
                  console.log(`present: ${r.present} · verified: ${r.verified}`);
                  console.log(`path: ${r.path ?? '(not hydrated)'}`);
                  if (r.detail) console.log(`note: ${r.detail}`);
               }
               return r.present ? 0 : 1;
            }
            const rows = mountStatus(flags.root, manifest, { checkIntegrity: flags.checkIntegrity });
            // No per-row findings here: `status` never fetches, so it has nothing of
            // its own to report.
            const issues = mountFindings([]);
            if (flags.json) {
               console.log(JSON.stringify({ command: 'mounts status', mounts: rows, findings: issues }, null, 2));
            } else {
               for (const row of rows) {
                  const rep = row.pinReport;
                  const pinLine =
                     rep.state === 'behind'
                        ? `behind ${rep.behind} (vs ${rep.comparedRef})`
                        : rep.state === 'diverged'
                          ? `diverged +${rep.ahead}/-${rep.behind} (vs ${rep.comparedRef})`
                          : rep.state === 'ahead'
                            ? `ahead ${rep.ahead} (vs ${rep.comparedRef})`
                            : rep.state;
                  const ver = row.verified === null ? '' : ` · verified: ${row.verified}`;
                  console.log(
                     `${row.name} @ ${row.pin.slice(0, 12)} · present: ${row.present}${ver} · pin: ${pinLine}`,
                  );
                  if (rep.reason) console.log(`   ${MOUNT_REASONS[rep.reason] ?? rep.reason}`);
               }
               if (rows.length === 0) console.log('no federation.mounts declared');
               printFindings(issues);
            }
            return 0;
         }
         case 'view':
         case 'viewer': {
            // `leji view` is an alias for `leji viewer serve` that also opens the
            // browser. `leji viewer` generates only; `leji viewer serve` serves.
            const isAlias = command === 'view';
            if (command === 'viewer' && sub !== undefined && sub !== 'serve' && sub !== 'build') {
               console.error('leji: usage: leji viewer [serve|build]\n');
               console.error(USAGE);
               return 2;
            }
            if (isAlias && sub !== undefined) {
               console.error('leji: usage: leji view\n');
               console.error(USAGE);
               return 2;
            }
            if (command === 'viewer' && sub === 'build') {
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('viewer build', findings, flags.json);
               const r = buildViewer(flags.root, manifest, flags.out);
               if (r.findings.some((f) => f.severity === 'error')) {
                  return emit('viewer build', r.findings, flags.json);
               }
               if (flags.json) {
                  console.log(
                     JSON.stringify(
                        { command: 'viewer build', ok: true, out: r.out, warning: PROTECT_WARNING },
                        null,
                        2,
                     ),
                  );
               } else {
                  console.log(`Exported the static viewer to ${r.out}/`);
                  console.log(`\n${PROTECT_WARNING}`);
               }
               return 0;
            }
            const wantServe = isAlias || sub === 'serve';
            const wantOpen = flags.open || isAlias;
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('viewer', findings, flags.json);
            const result = generateViewer(flags.root, manifest);
            // Terse by design: findings when something needs attention, one status
            // line otherwise. The full write list lives in --json.
            const allFindings = [...findings, ...result.findings];
            const code = flags.json
               ? emit('viewer', allFindings, true, {
                    written: result.written.join(', '),
                    entries: result.entries,
                 })
               : allFindings.length > 0
                 ? emit('viewer', allFindings, false)
                 : 0;
            if (!wantServe || code !== 0) {
               if (!flags.json && code === 0) {
                  const dir = `${stripSlash(manifest.rootPath) || '.'}/.leji/viewer/`;
                  console.log(`viewer ready (${result.entries} entries) → ${dir}   serve: leji view`);
               }
               return code;
            }
            const server = await serveViewer(flags.root, resolveViewerPort(manifest, flags.port), manifest.rootPath, {
               log: flags.json ? undefined : (line) => console.log(line),
            });
            const address = server.address();
            const port =
               typeof address === 'object' && address ? address.port : resolveViewerPort(manifest, flags.port);
            // Display localhost (nicer, still a secure context); server stays bound
            // to 127.0.0.1. Viewer is served at the web root, so the URL is just `/`.
            const url = `http://localhost:${port}/`;
            const title = manifest.viewer?.title ?? manifest.name;
            console.log(`${title} viewer → ${url}   (Ctrl+C to stop)`);
            if (wantOpen) openBrowser(url);
            // Keep the process alive until the server closes (Ctrl+C).
            await new Promise<void>((resolve) => server.on('close', resolve));
            return 0;
         }
         case 'ci': {
            if (flags.hooks) {
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('ci', findings, flags.json);
               const h = ensureLocalHook(flags.root);
               if (flags.json) {
                  const out: Record<string, unknown> = { command: 'ci', ok: true, hook: h.path, action: h.action };
                  if (h.action === 'manual') {
                     out.reason = h.reason;
                     out.snippet = h.snippet;
                  }
                  console.log(JSON.stringify(out, null, 2));
               } else if (h.action === 'manual') {
                  const lead =
                     h.reason === 'outside-root'
                        ? `${h.path} resolves outside the repository (core.hooksPath); add this yourself where your hooks run:`
                        : `${h.path} was not modified (not leji-managed); add this yourself:`;
                  console.log(`${lead}\n\n${h.snippet}`);
               } else if (h.managed === 'block') {
                  const lead =
                     h.action === 'unchanged'
                        ? `Hook block already current in ${h.path}`
                        : h.action === 'created'
                          ? `Wrote leji hook block to ${h.path}`
                          : `Merged leji hook block into ${h.path}`;
                  console.log(
                     `${lead} (validate + index --check before every commit; remove the leji block to opt out).`,
                  );
               } else {
                  console.log(
                     `${h.action === 'unchanged' ? 'Hook already current' : 'Wrote'} ${h.path} (validate + index --check before every commit; per-clone, delete to opt out).`,
                  );
               }
               return 0;
            }
            // No --provider: infer from the origin remote (a GitLab repo must
            // never silently receive a GitHub workflow); say which and why.
            let provider = flags.provider;
            if (!provider) {
               const origin = gitOriginUrl(flags.root);
               const inferred = ciProviderFromRemote(origin);
               provider = inferred ?? 'github';
               if (!flags.json) {
                  console.log(
                     inferred
                        ? `No --provider given; origin remote (${origin}) → ${inferred}.`
                        : 'No --provider given and no recognizable origin remote; defaulting to github.',
                  );
               }
            }
            if (provider !== 'github' && provider !== 'gitlab' && provider !== 'circleci' && provider !== 'azure') {
               console.error(`leji: unknown provider "${provider}"; expected github, gitlab, circleci, or azure\n`);
               return 2;
            }
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('ci', findings, flags.json);
            const r = ensureCiWorkflow(flags.root, provider as CiProvider);
            if (flags.json) {
               const out: Record<string, unknown> = {
                  command: 'ci',
                  ok: true,
                  provider: r.provider,
                  workflow: r.path,
                  action: r.action,
                  created: r.action === 'created',
               };
               if (r.action === 'manual') out.snippet = r.snippet;
               if (r.note) out.note = r.note;
               console.log(JSON.stringify(out, null, 2));
            } else {
               switch (r.action) {
                  case 'created':
                     console.log(`Wrote ${r.path}`);
                     break;
                  case 'updated':
                     console.log(`Updated ${r.path}`);
                     break;
                  case 'unchanged':
                     console.log(`${r.path} already present; nothing to do.`);
                     break;
                  case 'manual':
                     console.log(
                        `${r.path} already exists; not modifying it. Add this to your CircleCI config:\n\n${r.snippet}`,
                     );
                     break;
               }
               if (r.note) console.log(r.note);
            }
            return 0;
         }
         case 'agent': {
            if (!flags.name) {
               console.error('leji: agent requires --name\n');
               console.error(USAGE);
               return 2;
            }
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('agent', findings, flags.json);
            const r = addAgent(flags.root, manifest, { host: flags.host, name: flags.name, role: flags.role });
            if (flags.json) {
               console.log(
                  JSON.stringify(
                     {
                        command: 'agent',
                        ok: true,
                        name: r.name,
                        role: r.role,
                        host: r.hostId ?? null,
                        profile: r.profilePath,
                        created: { profile: r.profileCreated, manifest: r.manifestChanged },
                     },
                     null,
                     2,
                  ),
               );
            } else {
               const lines: string[] = [];
               lines.push(r.profileCreated ? `Wrote ${r.profilePath}` : `${r.profilePath} already present`);
               const roleHost = r.hostId ? `role ${r.role}, host ${r.hostId}` : `role ${r.role}`;
               lines.push(
                  r.manifestChanged
                     ? `Bound agent "${r.name}" (${roleHost}) in leji.json`
                     : `agent "${r.name}" already bound in leji.json; nothing to do.`,
               );
               console.log(lines.join('\n'));
            }
            return 0;
         }
         case 'start': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('start', findings, flags.json);
            const detected = detectHosts({ root: flags.root });
            const interactive = !flags.yes && Boolean(process.stdin.isTTY);
            const outcome = await enterLayer({
               root: flags.root,
               manifest,
               detected,
               agent: flags.agent,
               interactive,
               hostArgs: flags.hostArgs,
            });
            if (outcome === 'boot-missing') {
               console.error(`leji: boot profile ${manifest.bootProfilePath} is missing or invalid; run leji validate`);
               return 1;
            }
            if (outcome === 'fallback') console.log(enteringViaBoot(manifest, flags.hostArgs));
            return 0;
         }
         case 'detect': {
            const result = detectLayer(flags.root);
            if (flags.json) {
               console.log(JSON.stringify({ command: 'detect', ok: true, hosts: result.hosts }, null, 2));
            } else {
               console.log(renderDetect(result.hosts));
            }
            return 0;
         }
         case 'adopt': {
            const result = await adoptLayer({
               dir: flags.dir === '.' && flags.root !== '.' ? flags.root : flags.dir,
               yes: flags.yes,
               name: flags.name,
               dryRun: flags.dryRun,
               wireAdapters: flags.wireAdapters,
               noAgents: flags.noAgents,
               agent: flags.agent,
               mode: flags.mode,
            });
            if (result.dryRun) {
               // A wire-only run scaffolds nothing, so "Adopting the existing
               // repository" misnames it: the layer is already there and the plan
               // beneath is entrypoint conversions.
               console.log(
                  result.wiredOnly
                     ? `\nWiring vendor entrypoints into the existing layer (context root: ${result.detectedRoot}).`
                     : `\nAdopting the existing repository (context root: ${result.detectedRoot}).`,
               );
               console.log('\n' + renderWritePlan(result.plan));
               console.log('\nNo files written (--dry-run). Re-run without --dry-run to apply.');
               return 0;
            }
            console.log(`\nWrote ${result.written.length} files (context root: ${result.detectedRoot}):`);
            for (const rel of result.written) console.log(`   ${rel}`);
            const indexFailed = reportScaffoldIndex(result.findings);
            const interactive = !flags.yes && Boolean(process.stdin.isTTY);
            const mcp = await offerMcpInstall({
               root: result.root,
               detected: result.detected,
               interactive,
               agent: flags.agent,
            });
            await offerApprovalGuard({
               root: result.root,
               rootPath: result.manifest.rootPath,
               detected: result.detected,
               interactive,
               agent: flags.agent,
            });
            if (
               !(await handoffOffer(
                  result.manifest,
                  result.detected,
                  interactive,
                  undefined,
                  flags.agent,
                  result.root,
                  mcp,
               ))
            ) {
               console.log(enteringAdopted(result));
            }
            return indexFailed;
         }
         case 'init': {
            const result = await initLayer({
               dir: flags.dir === '.' && flags.root !== '.' ? flags.root : flags.dir,
               yes: flags.yes,
               name: flags.name,
               level: flags.level,
               dryRun: flags.dryRun,
               noAgents: flags.noAgents,
               agent: flags.agent,
               mode: flags.mode,
            });
            if (result.dryRun) {
               console.log('\n' + renderWritePlan(result.plan));
               console.log('\nNo files written (--dry-run). Re-run without --dry-run to create them.');
               return 0;
            }
            console.log(`\nWrote ${result.written.length} files:`);
            for (const rel of result.written) console.log(`   ${rel}`);
            // The index could not be generated: the scaffold is on disk but its
            // generated CI would fail, so say why and exit nonzero rather than
            // report a success the layer does not have.
            const indexFailed = reportScaffoldIndex(result.findings);
            const interactive = !flags.yes && Boolean(process.stdin.isTTY);
            const mcp = await offerMcpInstall({
               root: result.root,
               detected: result.detected,
               interactive,
               agent: flags.agent,
            });
            await offerApprovalGuard({
               root: result.root,
               rootPath: result.manifest.rootPath,
               detected: result.detected,
               interactive,
               agent: flags.agent,
            });
            if (
               !(await handoffOffer(
                  result.manifest,
                  result.detected,
                  interactive,
                  undefined,
                  flags.agent,
                  result.root,
                  mcp,
               ))
            ) {
               console.log(enteringTheLayer(result.manifest, result.mode));
            }
            return indexFailed;
         }
         default:
            console.error(`leji: unknown command "${command}"\n`);
            console.error(USAGE);
            return 2;
      }
   } catch (e) {
      console.error(`leji: ${(e as Error).message}`);
      return 2;
   }
}
