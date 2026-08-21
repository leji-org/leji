import { type Finding, finding, hasErrors, sortFindings, summarize } from './lib/findings.js';
import { DIST_REL, VIEWER_REL } from './lib/layout.js';
import { effectiveChangelogPath, effectiveIndexPath, loadManifest } from './lib/manifest.js';
import { type CliCommand, type CliSpec, SDK_VERSION, SUPPORTED_LINES, loadCliSpec } from './lib/schemas.js';
import { HELP_WIDTH, exitCodeColumn, helpRow, nameColumn, optionColumn, wrap } from './lib/text.js';
import { checkIndex, generateIndex, writeIndex } from './commands/indexgen.js';
import { checkChangelogAppendOnly, validateLayer } from './commands/validate.js';
import { compactChangelog, seedChangelogIfMissing } from './commands/changelog.js';
import { conformanceReport, renderExplain } from './commands/conformance.js';
import { type BadgeResult, DEFAULT_BADGE_OUT, badgeLabel, badgeRun } from './commands/badge.js';
import { type BuildResult, PROTECT_WARNING, buildViewer } from './commands/export.js';
import { generateViewer, resolveViewerPort } from './commands/viewer.js';
import { openBrowser, serveViewer } from './commands/serve.js';
import { freshnessReport } from './commands/freshness.js';
import { statusReport, unindexedPaths } from './commands/status.js';
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
   offerDependency,
   dependencyAddFailed,
   offerMcpInstall,
   initLayer,
   bootProfileReady,
   defaultHandoffIo,
   resolveStartHost,
} from './commands/init.js';
import {
   checkDocument,
   colorDecision,
   offerPreflightFixes,
   renderPreflight,
   runPreflight,
} from './commands/preflight.js';
import { detectLayer, renderDetect } from './commands/detect.js';
import { detectHosts } from './lib/detect.js';
import {
   type EcosystemReport,
   detectEcosystem,
   renderEcosystemBlock,
   renderEcosystemLine,
   runnerArgv,
} from './lib/ecosystem.js';
import { gitOriginUrl } from './lib/git.js';
import { renderWritePlan } from './lib/writeplan.js';
import { CATEGORY_IDS, type CategoryId } from './lib/manifest.js';
import { route } from './lib/route.js';
import { federationEnforcement, hydrateMounts, locateMount, mountStatus } from './lib/mounts.js';
import {
   type UpdatePinResult,
   MOUNT_UPDATE_PIN_REASONS,
   shortOid,
   updatePinRun,
} from './commands/mounts-update-pin.js';

export { validateLayer } from './commands/validate.js';
export { checkIndex, generateIndex, writeIndex } from './commands/indexgen.js';
export { checkChangelogAppendOnly } from './commands/validate.js';
export { compactChangelog, seedChangelogIfMissing, serializeChangelog } from './commands/changelog.js';
export { conformanceReport, renderExplain } from './commands/conformance.js';
export {
   buildSidebar,
   buildLayerMap,
   buildManifestPage,
   generateViewer,
   resolveViewerPort,
   resolvedProfilePage,
} from './commands/viewer.js';
export { badgeLabel, badgeMarkdown, badgeRun, renderBadge, DEFAULT_BADGE_OUT, OUT_RULE } from './commands/badge.js';
export { buildViewer } from './commands/export.js';
export { MOUNT_UPDATE_PIN_REASONS, updatePinRun } from './commands/mounts-update-pin.js';
export type { UpdatePinAction, UpdatePinResult, UpdatePinOptions } from './commands/mounts-update-pin.js';
export { serveViewer, urlPathToRel } from './commands/serve.js';
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
export {
   detectHosts,
   resolveHostId,
   adapterContent,
   HOST_SPECS,
   MCP_JSON_CONFIG,
   mcpCommand,
   mcpJsonConfig,
} from './lib/detect.js';
export { bootProfileReady, hookStatus, resolveStartHost, startHosts } from './commands/init.js';
export type { HookOwnership, HookState, HookStatus } from './commands/init.js';
export { offerPreflightFixes, renderPreflight, runPreflight } from './commands/preflight.js';
export type {
   Check,
   CheckId,
   CheckStatus,
   PreflightOptions,
   PreflightOfferOptions,
   PreflightResult,
} from './commands/preflight.js';
export { dependencyAddFailed, offerDependency } from './commands/init.js';
export type { DependencyOffer, DependencyOfferOptions } from './commands/init.js';
export { detectEcosystem, renderEcosystemBlock, renderEcosystemLine, runnerArgv } from './lib/ecosystem.js';
export type {
   EcoCandidate,
   EcoReason,
   EcoResult,
   EcoSource,
   EcoStatus,
   EcosystemId,
   EcosystemReport,
} from './lib/ecosystem.js';
export { loadManifest, replaceMountPinInManifestText, validateManifestObject } from './lib/manifest.js';
export { SDK_VERSION, SUPPORTED_LINES, loadCliSpec } from './lib/schemas.js';
export type { Finding, Severity } from './lib/findings.js';
export type { Manifest, ManifestLoad, ConformanceLevel, CategoryId } from './lib/manifest.js';
export type { CliSpec, CliOption } from './lib/schemas.js';
export type { ContextIndex, IndexEntry } from './commands/indexgen.js';
export type { CompactOptions, CompactResult } from './commands/changelog.js';
export type { ConformanceResult, ChecklistItem } from './commands/conformance.js';
export type { BadgeAction, BadgeResult } from './commands/badge.js';
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

/** Top-level help, generated from cli.json so it can't drift: the commands by group,
 * the global options, and the exit codes. Per-command options live in
 * `leji <command> --help`. */
export function renderUsage(spec: CliSpec = loadCliSpec()): string {
   const out: string[] = [
      // Every emitted field goes through the wrapper, including the ones no current
      // value is long enough to overflow: a longer version string or group title must
      // not be what discovers that a line was never wrapped.
      ...wrap(
         `leji ${SDK_VERSION}: reference CLI for the Leji specification (spec line ${SUPPORTED_LINES.join(', ')})`,
         HELP_WIDTH,
         0,
         3,
      ),
      '',
      ...wrap(`Usage: ${spec.usage}`, HELP_WIDTH, 0, 7),
   ];

   // One name column across every group, so the summaries line up down the whole
   // list rather than jumping per section.
   const cmdCol = nameColumn(spec.commands.map((c) => c.name));
   const primaries = spec.commands.filter((c) => !c.aliasOf);
   const aliasesOf = (name: string) => spec.commands.filter((c) => c.aliasOf === name);
   for (const g of spec.groups) {
      out.push('', ...wrap(`${g.title}:`, HELP_WIDTH, 0, 0));
      for (const c of primaries.filter((c) => c.group === g.id)) {
         out.push(...helpRow(c.name, cmdCol, c.summary));
         // An alias earns a line under its primary, not a row of its own: it is the
         // same command, and repeating the summary reads as a second one. It keeps the
         // name column, so the right-hand column stays straight down the whole list.
         for (const a of aliasesOf(c.name)) out.push(...helpRow(a.name, cmdCol, `(alias of ${c.name})`));
      }
   }

   const optCol = optionColumn(spec.globalOptions.map((o) => o.flags));
   out.push('', 'Options:');
   for (const o of spec.globalOptions) out.push(...helpRow(o.flags, optCol, o.summary));

   // The meaning hangs under itself, like every other two-column block here, so a
   // continuation line is never mistaken for another code.
   const codeCol = exitCodeColumn(spec.exitCodes.map((e) => String(e.code)));
   out.push('', 'Exit codes:');
   for (const e of spec.exitCodes) out.push(...helpRow(String(e.code), codeCol, e.meaning));

   out.push('', 'Run `leji <command> --help` for a command and its options.', 'Full reference: https://leji.org/cli/');
   return out.join('\n');
}

/** Per-command help, generated from cli.json: this command's own options only, with
 * the globals one pointer away. Returns null for an unknown command so the caller
 * falls back to top-level usage. */
export function renderCommandHelp(name: string, spec: CliSpec = loadCliSpec()): string | null {
   const cmd: CliCommand | undefined = spec.commands.find((c) => c.name === name);
   if (!cmd) return null;
   const out: string[] = [
      ...wrap(`leji ${cmd.name}: ${cmd.summary}`, HELP_WIDTH, 0, 3),
      '',
      ...wrap(`Usage: ${cmd.usage}`, HELP_WIDTH, 0, 7),
   ];
   for (const para of cmd.description.split(/\n[ \t]*\n/)) out.push('', ...wrap(para, HELP_WIDTH, 0, 0));
   if (cmd.details && cmd.details.length > 0) {
      out.push('', 'Details:');
      for (const d of cmd.details) out.push(...wrap(`- ${d}`, HELP_WIDTH, 3, 5));
   }
   if (cmd.options.length > 0) {
      const optCol = optionColumn(cmd.options.map((o) => o.flags));
      out.push('', 'Options:');
      for (const o of cmd.options) out.push(...helpRow(o.flags, optCol, o.summary));
   }
   out.push('', 'Global options: see leji --help.');
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
   allowNonFastForward: boolean;
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
   to?: string;
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

/**
 * The repository root this argv lands on, decided ONCE and used by everything that
 * has to agree about it: the parse below, and the installed executable's hand-off to
 * a repository's own pinned CLI, which must select the same repository the command
 * would then operate on. Same scan as the parse (`--flag=value` expanded, every
 * declared value flag consuming its own value, the literal `--` ending our flags),
 * so `--root` is read from the same token stream rather than from a second reading
 * of it. Last `--root` wins; the default is the current directory.
 *
 * Null when the scan cannot tell: a value flag with no value, or one whose value is
 * itself a flag, is the usage error `parseFlags` reports, and a root guessed out of
 * a malformed command line is exactly the wrong thing to hand an invocation to.
 */
export function effectiveRoot(argv: string[]): string | null {
   const expanded = expandEqualsFlags(argv);
   let root = '.';
   for (let i = 0; i < expanded.length; i++) {
      const arg = expanded[i];
      if (arg === '--') break; // host pass-through: never our flags
      if (!VALUE_FLAGS.has(arg)) continue;
      const value = expanded[++i];
      if (value === undefined || isFlagToken(value)) return null;
      if (arg !== '--root') continue;
      if (value === '') return null; // `--root ""` is the usage error, not a root
      root = value;
   }
   return root;
}

function parseFlags(argv: string[]): { flags: Flags; rest: string[]; error?: string } {
   // The root comes from the shared scan, never from a second derivation here: the
   // wrapper that may hand this invocation to another CLI reads the same one.
   const root = effectiveRoot(argv) ?? '.';
   argv = expandEqualsFlags(argv);
   const flags: Flags = {
      root,
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
      allowNonFastForward: false,
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
            // The value is validated here; the root itself was decided by
            // `effectiveRoot` above, so the two can never disagree.
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--root requires a value' };
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
         case '--allow-non-fast-forward':
            flags.allowNonFastForward = true;
            break;
         case '--to': {
            const v = argv[++i];
            if (!v || isFlagToken(v)) return { flags, rest, error: '--to requires a value' };
            // The schema's own pin shape: a full commit id, never an abbreviation
            // and never a revision expression, so all three SDKs accept one spelling.
            if (!/^[0-9a-f]{40}$/.test(v) && !/^[0-9a-f]{64}$/.test(v)) {
               return { flags, rest, error: '--to must be a full 40- or 64-character lowercase hex commit id' };
            }
            flags.to = v;
            break;
         }
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
   '--to',
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
      // A rule that locates a line says so, so a reader can go to it.
      const where = f.path ? ` ${f.path}${f.line === undefined ? '' : `:${f.line}`}` : '';
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

/**
 * The one `--json` document `init` and `adopt` emit: a single object, like every
 * other command's, carrying what the run wrote and the repository's dependency
 * ecosystem. `--json` is non-interactive by construction, so nothing here can have
 * prompted or run a package manager; the report is what a consumer acts on.
 */
function emitScaffold(
   command: 'init' | 'adopt',
   findings: Finding[],
   written: string[],
   ecosystem: EcosystemReport,
   dryRun = false,
): number {
   const sorted = sortFindings(findings);
   const summary = summarize(sorted);
   const ok = summary.errors === 0;
   console.log(
      JSON.stringify(
         { command, ok, findings: sorted, summary, ...(dryRun ? { dryRun } : {}), written, ecosystem },
         null,
         2,
      ),
   );
   return ok ? 0 : 1;
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

/**
 * The `index` generate run's closing nudge. Byte-identical in all three SDKs and
 * quiet at zero: a layer with nothing unindexed says nothing.
 */
function printUnindexedNudge(count: number): void {
   if (count <= 0) return;
   console.log(`${count} file(s) unindexed: add to a category index or leave as reference deliberately`);
}

/**
 * The one export run, reached by both of its names: `leji export` (the front door)
 * and `leji viewer build` (the viewer subsystem's name for the same operation,
 * beside `viewer serve`). One code path, so the two are byte-identical by
 * construction — same default output, same JSON document, same exits.
 *
 * Exits: `0` written (warnings allowed), `1` an error finding — or, under
 * `--strict`, a lint finding — with the target left byte-untouched, `2` a usage
 * error or a refusal (thrown, and rendered by the caller's catch).
 */
function runExport(flags: Flags): number {
   const { manifest, findings } = loadManifest(flags.root);
   // A failure before the pipeline can run (an unreadable manifest) reports in the
   // command's OWN document, never the generic one: a `--json` consumer parses one
   // shape under every outcome and either name.
   if (!manifest) return reportExport(flags, { out: flags.out ?? DIST_REL, findings, wrote: false });
   return reportExport(flags, buildViewer(flags.root, manifest, flags.out, { strict: flags.strict }));
}

/** The one export report, for every outcome the pipeline can reach. */
function reportExport(flags: Flags, r: BuildResult): number {
   const sorted = sortFindings(r.findings);
   if (flags.json) {
      // The canonical JSON document for this command, under either name.
      console.log(
         JSON.stringify(
            { command: 'export', ok: r.wrote, out: r.out, findings: sorted, warning: PROTECT_WARNING },
            null,
            2,
         ),
      );
      return r.wrote ? 0 : 1;
   }
   if (!r.wrote) {
      const s = summarize(sorted);
      printFindings(sorted);
      console.log(
         `failed (${s.errors} error${s.errors === 1 ? '' : 's'}, ${s.warnings} warning${s.warnings === 1 ? '' : 's'}${flags.strict ? '; strict, nothing written' : ''})`,
      );
      return 1;
   }
   // Human mode says where the export went and repeats the protect-your-context
   // warning, which is the part a person must act on before hosting it.
   console.log(`Exported the static viewer to ${r.out}/`);
   console.log(`\n${PROTECT_WARNING}`);
   return 0;
}

/**
 * The one `leji badge` report, for every outcome the command can reach. The JSON
 * document is the shared `emit()` shape plus the badge's own fields, emitted under
 * success and refusal alike so a consumer parses one document; the human channel
 * says what was written and hands over the markdown line to paste.
 *
 * Exits: `0` the badge is written or already current, `1` a conformance error
 * finding or nothing machine-verified in this run, `2` a `--out` usage error
 * (rendered by the caller, with no level reported) or a refusal to overwrite a file
 * that is not a badge of this contract.
 */
function reportBadge(flags: Flags, r: BadgeResult): number {
   const findings = sortFindings(r.findings);
   const summary = summarize(findings);
   const ok = summary.errors === 0;
   const code = r.refusal !== undefined ? 2 : ok ? 0 : 1;
   if (flags.json) {
      console.log(
         JSON.stringify(
            {
               command: 'badge',
               ok,
               findings,
               summary,
               out: r.out,
               level: r.level,
               claimedLevel: r.claimedLevel,
               verifiedLevel: r.verifiedLevel,
               markdown: r.markdown,
               action: r.action,
            },
            null,
            2,
         ),
      );
      if (r.refusal !== undefined) console.error(`leji: ${r.refusal}`);
      return code;
   }
   if (r.refusal !== undefined) {
      console.error(`leji: ${r.refusal}`);
      return 2;
   }
   if (!ok) {
      printFindings(findings);
      console.log('Run leji conformance --explain.');
      return 1;
   }
   const verb = r.action === 'wrote' ? 'Wrote' : r.action === 'overwrote' ? 'Overwrote' : 'Unchanged';
   console.log(`${verb} ${r.out}: ${badgeLabel(r.level!)}`);
   // The badge states what this run verified, so a claim it did not reach is said
   // out loud rather than quietly dropped.
   if (r.claimedLevel !== null && r.claimedLevel !== r.verifiedLevel) {
      console.log(
         `Claimed ${r.claimedLevel}; this offline run verified ${r.verifiedLevel} (leji conformance --federation=verify checks the claim).`,
      );
   }
   console.log('\nAdd it to your README (paths are relative to the repository root):\n');
   console.log(r.markdown!.trimEnd());
   return 0;
}

/**
 * Render one `mounts update-pin` run. The comparison is shown first, then what the
 * run did with it, then the follow-up act this command deliberately does not
 * perform. Every string is Leji-authored: git's stderr never reaches output.
 */
function reportUpdatePin(flags: Flags, r: UpdatePinResult): number {
   // An internal refusal after validation carries no document at all: there is no
   // outcome to report, only the act this run would not perform.
   if (r.writeError !== undefined) {
      console.error(`leji: ${r.writeError}`);
      return 2;
   }
   const findings = sortFindings(r.findings);
   const summary = summarize(findings);
   const ok = summary.errors === 0;
   if (flags.json) {
      console.log(
         JSON.stringify(
            {
               command: 'mounts update-pin',
               ok,
               findings,
               summary,
               mount: r.mount,
               pinReport: r.pinReport,
               action: r.action,
               override: r.override,
               ...(r.reason === undefined ? {} : { reason: r.reason }),
            },
            null,
            2,
         ),
      );
      return ok ? 0 : 1;
   }
   const rep = r.pinReport;
   if (rep !== null && rep.state !== 'unknown' && r.mount.to !== null && r.mount.from !== null) {
      // Offline, the witness is the last one successfully observed — never a claim
      // that the source was looked at during this run.
      const observed = flags.fetch ? '' : ' (last observed witness; run with --fetch to observe the source)';
      console.log(
         `${r.mount.name} @ ${shortOid(r.mount.from)} → ${shortOid(r.mount.to)} · pin: ${rep.state} ` +
            `(behind ${rep.behind}, ahead ${rep.ahead}) · via ${rep.comparisonRepository}${observed}`,
      );
   }
   const overridden = r.override ? ' (non-fast-forward, overridden)' : '';
   const from12 = r.mount.from === null ? '' : shortOid(r.mount.from);
   const to12 = r.mount.to === null ? '' : shortOid(r.mount.to);
   switch (r.action) {
      case 'updated':
         console.log(`Updated leji.json: ${r.mount.name} pin ${from12} → ${to12}${overridden}`);
         // Moving the pin is one act; materializing the new projection is another.
         console.log(`Run leji mounts hydrate${flags.fetch ? '' : ' --fetch'} to hydrate the new pin.`);
         break;
      case 'unchanged':
         console.log(`Unchanged: ${r.mount.name} pin ${from12} is already the target`);
         break;
      case 'dry-run':
         console.log(`Would update leji.json: ${r.mount.name} pin ${from12} → ${to12} (dry run)${overridden}`);
         break;
      case 'refused':
         console.log(`Refused: ${MOUNT_UPDATE_PIN_REASONS[r.reason ?? ''] ?? r.reason}`);
         break;
   }
   return ok ? 0 : 1;
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
         (TWO_WORD_COMMANDS.has(command) && sub ? 2 : 1) +
         (command === 'mounts' && (sub === 'locate' || sub === 'update-pin') ? 1 : 0);
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
            const code = emit('index', [...findings, ...result.findings], flags.json, {
               ...(wrote ? { written: effectiveIndexPath(manifest) } : {}),
               entries: wrote ? (result.index?.entries.length ?? 0) : 0,
               ...(seededChangelog ? { changelog: seededChangelog } : {}),
            });
            // A generate run ends by naming what the layer governs but does not
            // index. A nudge, never a gate: the exit code is emit's alone, and
            // nothing is printed when the count is zero. Text output only; --json
            // carries one document and nothing after it.
            if (!flags.json) printUnindexedNudge(unindexedPaths(flags.root, manifest).length);
            return code;
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
                  console.log(`${mark} [${item.level}] ${item.description}${item.detail ? `: ${item.detail}` : ''}`);
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
            if (sub !== 'hydrate' && sub !== 'status' && sub !== 'locate' && sub !== 'update-pin') {
               console.error('leji: usage: leji mounts <hydrate|status|locate|update-pin>\n');
               console.error(USAGE);
               return 2;
            }
            // Argument shape is settled before anything on disk is read: a usage
            // error is never contingent on a manifest loading.
            if (sub === 'update-pin') {
               if (!rest[2]) {
                  console.error('leji: usage: leji mounts update-pin <name> [--to <oid>]\n');
                  console.error(USAGE);
                  return 2;
               }
               if (flags.allowNonFastForward && flags.to === undefined) {
                  console.error('leji: --allow-non-fast-forward is valid only with an explicit --to <oid>\n');
                  console.error(USAGE);
                  return 2;
               }
            }
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit(`mounts ${sub}`, findings, flags.json);
            if (sub === 'update-pin') {
               return reportUpdatePin(
                  flags,
                  updatePinRun(flags.root, manifest, {
                     name: rest[2],
                     to: flags.to,
                     allowNonFastForward: flags.allowNonFastForward,
                     fetch: flags.fetch,
                     dryRun: flags.dryRun,
                  }),
               );
            }
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
         case 'badge': {
            const result = badgeRun(flags.root, flags.out ?? DEFAULT_BADGE_OUT);
            // A rejected `--out` is a usage error, in the CLI's usage-error form and
            // ahead of every level the command could have reported.
            if (result.usageError !== undefined) {
               console.error(`leji: ${result.usageError}\n`);
               console.error(USAGE);
               return 2;
            }
            return reportBadge(flags, result);
         }
         case 'export':
            return runExport(flags);
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
            if (command === 'viewer' && sub === 'build') return runExport(flags);
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
                  const dir = `${VIEWER_REL}/`;
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
            // One detection for the whole command: the hook and the CI job both run
            // what a clean install of this repository provides.
            const ecosystem = detectEcosystem(flags.root);
            if (flags.hooks) {
               const { manifest, findings } = loadManifest(flags.root);
               if (!manifest) return emit('ci', findings, flags.json);
               const h = ensureLocalHook(flags.root, runnerArgv(ecosystem));
               if (flags.json) {
                  const out: Record<string, unknown> = { command: 'ci', ok: true, hook: h.path, action: h.action };
                  if (h.action === 'manual') {
                     out.reason = h.reason;
                     out.snippet = h.snippet;
                  }
                  out.ecosystem = ecosystem;
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
               if (!flags.json) console.log(renderEcosystemLine(ecosystem));
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
            const r = ensureCiWorkflow(flags.root, provider as CiProvider, ecosystem);
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
               out.ecosystem = ecosystem;
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
                     // Not leji's file: it was written by hand, or a generated one was
                     // edited. Either way the edit is the opt-out, and it is honored.
                     console.log(
                        `${r.path} already exists and was not generated by leji; not modifying it. Add this yourself:\n\n${r.snippet}`,
                     );
                     break;
               }
               if (r.note) console.log(r.note);
               console.log(renderEcosystemLine(ecosystem));
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
               const out: Record<string, unknown> = {
                  command: 'agent',
                  ok: true,
                  name: r.name,
                  role: r.role,
                  host: r.hostId ?? null,
                  profile: r.profilePath,
                  created: { profile: r.profileCreated, manifest: r.manifestChanged },
               };
               if (r.note) out.note = r.note;
               console.log(JSON.stringify(out, null, 2));
            } else {
               const lines: string[] = [];
               lines.push(r.profileCreated ? `Wrote ${r.profilePath}` : `${r.profilePath} already present`);
               const roleHost = r.hostId ? `role ${r.role}, host ${r.hostId}` : `role ${r.role}`;
               lines.push(
                  r.manifestChanged
                     ? `Bound agent "${r.name}" (${roleHost}) in leji.json`
                     : `agent "${r.name}" already bound in leji.json; nothing to do.`,
               );
               if (r.note) lines.push(r.note);
               console.log(lines.join('\n'));
            }
            return 0;
         }
         case 'start': {
            const { manifest, findings } = loadManifest(flags.root);
            if (!manifest) return emit('start', findings, flags.json);
            const detected = detectHosts({ root: flags.root });
            // The repository's own ecosystem, read once: the preflight probes the
            // runner it names, and the JSON document reports it.
            const ecosystem = detectEcosystem(flags.root);
            // --json is a single-document mode, so it is never interactive: nothing
            // prompts, nothing launches, and no repair can run under it.
            const interactive = !flags.yes && !flags.json && Boolean(process.stdin.isTTY);
            // The boot profile is checked first, before any report or prompt: a layer
            // whose entrypoint is missing has nothing to enter.
            if (!bootProfileReady(flags.root, manifest)) {
               if (flags.json) {
                  console.log(
                     JSON.stringify(
                        { command: 'start', ok: false, ready: false, error: 'boot-missing', checks: [], ecosystem },
                        null,
                        2,
                     ),
                  );
               } else {
                  console.error(
                     `leji: boot profile ${manifest.bootProfilePath} is missing or invalid; run leji validate`,
                  );
               }
               return 1;
            }
            // The host is resolved BEFORE the report, so the MCP rows answer for the
            // host this run actually targets. An --agent naming no launchable host
            // throws here, exactly as it did inside enterLayer: a usage error.
            const io = defaultHandoffIo();
            const host = await resolveStartHost({ detected, agent: flags.agent, interactive, io });
            const preflight = runPreflight({
               root: flags.root,
               manifest,
               host,
               detected,
               report: ecosystem,
               io,
            });
            if (flags.json) {
               // Report only: the launch-selection arguments are accepted and have no
               // effect, and a gap is reported rather than blocking (`ready` is the
               // scriptable signal).
               console.log(
                  JSON.stringify(
                     {
                        command: 'start',
                        ok: true,
                        ready: preflight.ready,
                        // Projected, never the raw checks: the document publishes four keys,
                        // and a field the renderer needs is not one of them.
                        checks: preflight.checks.map(checkDocument),
                        ecosystem,
                     },
                     null,
                     2,
                  ),
               );
               return 0;
            }
            // The one place color is decided: a terminal question, asked at the boundary and
            // injected, so the block itself never consults the process.
            const color = colorDecision(Boolean(process.stdout.isTTY), process.env);
            console.log('\n' + renderPreflight(preflight.checks, { color }));
            await offerPreflightFixes({
               root: flags.root,
               host,
               result: preflight,
               runner: runnerArgv(ecosystem),
               interactive,
               io,
            });
            const outcome = await enterLayer({
               root: flags.root,
               manifest,
               detected,
               agent: flags.agent,
               host,
               interactive,
               hostArgs: flags.hostArgs,
               io,
            });
            if (outcome === 'fallback') console.log(enteringViaBoot(manifest, flags.hostArgs));
            return 0;
         }
         case 'detect': {
            const result = detectLayer(flags.root);
            if (flags.json) {
               console.log(
                  JSON.stringify(
                     { command: 'detect', ok: true, hosts: result.hosts, ecosystem: result.ecosystem },
                     null,
                     2,
                  ),
               );
            } else {
               console.log(renderDetect(result));
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
            // The repository's own dependency ecosystem, read once and reported by
            // every output mode: the human block, the JSON document, and the offer.
            const ecosystem = detectEcosystem(result.root);
            if (result.dryRun) {
               if (flags.json) return emitScaffold('adopt', result.findings, [], ecosystem, true);
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
               console.log('\n' + renderEcosystemBlock(ecosystem));
               return 0;
            }
            if (flags.json) return emitScaffold('adopt', result.findings, result.written, ecosystem);
            console.log(`\nWrote ${result.written.length} files (context root: ${result.detectedRoot}):`);
            for (const rel of result.written) console.log(`   ${rel}`);
            const indexFailed = reportScaffoldIndex(result.findings);
            // --json is a single-document mode, so it is never interactive: nothing
            // prompts, and no package manager can run under it.
            const interactive = !flags.yes && !flags.json && Boolean(process.stdin.isTTY);
            // A wire-only run scaffolds no layer, so it makes no declaration offer.
            const dependency = result.wiredOnly
               ? null
               : await offerDependency({ root: result.root, report: ecosystem, interactive });
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
            // The layer is written either way; a consented add that failed means the
            // durable setup this run promised was not reached, and the exit says so.
            return indexFailed || (dependency !== null && dependencyAddFailed(dependency)) ? 1 : 0;
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
            const ecosystem = detectEcosystem(result.root);
            if (result.dryRun) {
               if (flags.json) return emitScaffold('init', result.findings, [], ecosystem, true);
               console.log('\n' + renderWritePlan(result.plan));
               console.log('\nNo files written (--dry-run). Re-run without --dry-run to create them.');
               console.log('\n' + renderEcosystemBlock(ecosystem));
               return 0;
            }
            if (flags.json) return emitScaffold('init', result.findings, result.written, ecosystem);
            console.log(`\nWrote ${result.written.length} files:`);
            for (const rel of result.written) console.log(`   ${rel}`);
            // The index could not be generated: the scaffold is on disk but its
            // generated CI would fail, so say why and exit nonzero rather than
            // report a success the layer does not have.
            const indexFailed = reportScaffoldIndex(result.findings);
            const interactive = !flags.yes && !flags.json && Boolean(process.stdin.isTTY);
            const dependency = await offerDependency({ root: result.root, report: ecosystem, interactive });
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
            return indexFailed || dependencyAddFailed(dependency) ? 1 : 0;
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
