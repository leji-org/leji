import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Manifest } from '../lib/manifest.js';
import { type DetectedHost, hostSpec, mcpCommand, mcpJsonConfig } from '../lib/detect.js';
import { type EcosystemReport, managerInstallArgv, runnerArgv } from '../lib/ecosystem.js';
import { resolvedWithinRoot } from '../lib/fsx.js';
import { type HandoffIo, type HookStatus, type PromptHost, ensureLocalHook, hookStatus, startHosts } from './init.js';

/**
 * `leji start`'s preflight: what a person who just cloned an adopted repository has
 * to fix before the layer's tooling actually works here, computed READ-ONLY and
 * reported as a fixed list of rows.
 *
 * The distinction the whole report turns on is who owns each gap. A gap in state that
 * lives in this clone or in this user's own configuration is PERSONAL: it is offered,
 * on a real terminal, and otherwise printed as an exact command. A gap in state the
 * repository commits is SHARED: it is reported with the maintainer's command and
 * never repaired here, because that write would land in files the whole team owns.
 * Nothing here blocks entry either way: the agent still boots, and `--json`'s `ready`
 * is the scriptable signal.
 */

/** The checks, in the fixed order every report and every SDK prints them. */
export type CheckId = 'cli' | 'mcp' | 'mcp-shared' | 'hook';

/**
 * What one check found. `ok` needs nothing; `missing` is personal (offered here, or
 * printed); `shared-gap` is the repository's own state, for a maintainer; `skipped`
 * means the check does not apply to this machine; `n/a` means it does not apply to
 * this host; `unresolved` means the run could not tell which host to answer for.
 */
export type CheckStatus = 'ok' | 'missing' | 'shared-gap' | 'skipped' | 'n/a' | 'unresolved';

/** How a fix prints: a `command` line takes the `$ ` prompt, a `snippet` is pasted as it
 * stands (a config block, a hook body). Render-only, so it never reaches `--json`. */
export type FixKind = 'command' | 'snippet';

export interface Check {
   id: CheckId;
   status: CheckStatus;
   detail: string;
   /** The exact commands that close this gap, or null when there is nothing to run. */
   fix: string[] | null;
   /** Set by every check built here; absent input renders as a command. */
   fixKind?: FixKind;
}

export interface PreflightResult {
   /** Every check whose id is cli, mcp or hook is ok, skipped, or not applicable.
    * The shared MCP row is project hygiene and never counts against it. */
   ready: boolean;
   checks: Check[];
   /** The resolved hook target, so the consent step acts on what the report saw. */
   hook: HookStatus;
}

// --- the text table -------------------------------------------------------
// Every string the Setup block prints lives here once, so the three SDKs transcribe
// one table rather than re-deriving prose.

// The block's fixed geometry: `<margin><status><gutter><subject><gutter><detail>`, so
// every detail starts at the same column and the status word is the first thing read. A
// fix line is indented under the SUBJECT column, a half indent that reads as "belongs to
// the row above" and keeps long commands inside 80 columns.
const MARGIN = '  ';
const GUTTER = '  ';
const STATUS_WIDTH = 4;
const SUBJECT_WIDTH = 10;
const FIX_INDENT = '        ';

/** The lowest SDK version that shipped support for a spec line. A layer declares
 * exactly one version expectation, its spec line; this is what that expectation means
 * for the CLI resolved here. The comparison is on the major, which is where a line's
 * support is added or dropped. */
export const MIN_SDK_FOR_SPEC_LINE: Record<string, string> = { '1.0': '1.0.0' };

const START_TEXT = {
   heading: 'Setup for this clone',
   /** The word that names WHO owns the row. The `CheckStatus` enum stays the contract;
    * these labels are what a person reads, and several statuses share one. */
   status: {
      ok: 'ok',
      missing: 'you',
      'shared-gap': 'team',
      skipped: 'n/a',
      'n/a': 'n/a',
      unresolved: 'you',
   } as Record<CheckStatus, string>,
   subject: {
      cli: 'Leji CLI',
      mcp: 'MCP server',
      'mcp-shared': 'Team MCP',
      hook: 'Git hook',
   } as Record<CheckId, string>,
   // Every detail is one short clause. Where a template carries a path, the path is its
   // LAST token: a row that overflows overflows into the path, never through the prose,
   // and nothing here is ever clipped (a truncated path misleads).
   cli: {
      ok: (version: string, runner: string): string => `${version} (${runner})`,
      notInstalled: (bin: string): string => `not installed yet (${bin})`,
      verify: (runner: string): string => `${runner} --version`,
      belowMinimum: (version: string, runner: string, minimum: string, line: string): string =>
         `${version} (${runner}) is below ${minimum} for spec ${line}`,
      unresolvable: (runner: string): string => `${runner} reported no version here`,
      undeclared: 'not declared in this repository',
      undeclaredAmbient: (version: string): string => `not declared here (PATH has your own ${version})`,
      unresolvableNoInstall: (runner: string): string => `${runner} reported no version; run this repo's install`,
   },
   mcp: {
      registered: (host: string): string => `registered for ${host}`,
      missing: (host: string): string => `not registered for ${host}`,
      manual: (host: string): string => `not registered for ${host}; add it yourself:`,
      /** The first line of that snippet: where the block goes, and at which scope. */
      manualPath: (config: string, scope: string): string => `${config} (${scope} scope)`,
      unresolved: (hosts: string[]): string => `pick one: ${hosts.join(', ')}`,
      none: 'no coding agent detected',
   },
   mcpShared: {
      present: (file: string): string => `${file} committed`,
      absent: (file: string): string => `no ${file} committed`,
      other: 'none for this host',
      noHost: 'no host selected',
   },
   hook: {
      current: (target: string): string => `runs leji checks before each commit: ${target}`,
      absentPersonal: 'none yet (per clone)',
      absentShared: (target: string): string => `no leji block in ${target}`,
      foreign: (target: string): string => `not leji-managed; add the block to ${target}`,
      outsideRoot: (target: string): string => `hooks dir is outside this worktree: ${target}`,
      external: (target: string): string => `add it yourself; hooks run from ${target}`,
      noGit: 'not a git repository',
   },
   /** The closing line: who owes how many fixes, and that neither answer blocks entry. */
   summary: {
      complete: 'Setup complete.',
      fixes: (n: number): string => `${n} ${n === 1 ? 'fix' : 'fixes'}`,
      you: (fixes: string): string => `${fixes} for you. The agent starts either way.`,
      team: (fixes: string): string => `${fixes} for a maintainer. The agent starts either way.`,
      both: (fixes: string, team: number): string =>
         `${fixes} for you, ${team} for a maintainer. The agent starts either way.`,
   },
   offer: {
      mcp: (host: string): string => `Register the Leji MCP server for ${host} for your user?`,
      mcpDone: (host: string): string => `Registered the Leji MCP server for ${host}.`,
      mcpFailed: (bin: string): string => `${bin} did not register cleanly; run it yourself:`,
      hook: 'Install the pre-commit hook for this clone (validate + index --check)?',
      hookDone: (target: string): string => `Wrote ${target}; it runs before every commit in this clone.`,
      hookFailed: 'The hook could not be written here; add it yourself:',
      prompt: 'Y/n',
   },
};

/** The whole message table, exported for the ports to transcribe. Not re-exported
 * from the package index: these are the CLI's words, not a library API. */
export const START_TEXT_TABLE = START_TEXT;

// --- the version probe ----------------------------------------------------

/** How long a probe may take, and how much of its output is read. A probe that
 * exceeds either bound fails closed, exactly like one that never started. */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 4096;

/**
 * The one path a probe may execute directly: the bin shim a Node package manager
 * installs for the declared dependency. It is a file this repository's own install
 * put there, not a script the repository authors, which is the whole reason it is
 * safe to run when `npm`/`pnpm`/`yarn`/`bun` are not.
 */
const NODE_BIN_REL = 'node_modules/.bin/leji';

/** The Node managers whose declared CLI arrives as that shim. */
const NODE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * What the probe runs for a manager whose CLI is a console-script entry of the
 * declared dependency rather than a file in the repository. Each carries the flag
 * that keeps the manager from installing, syncing, or fetching anything, and none of
 * them runs a script the repository declares.
 */
const MANAGER_PROBE_ARGV: Record<string, string[]> = {
   uv: ['uv', 'run', '--no-sync', 'leji'],
   poetry: ['poetry', 'run', 'leji'],
   pdm: ['pdm', 'run', 'leji'],
   pipenv: ['pipenv', 'run', 'leji'],
   go: ['go', 'tool', 'leji'],
};

/** The environment the Go probe forces: a read-only module graph, no toolchain
 * download, no module proxy, and no workspace file redirecting the build. */
const GO_PROBE_ENV: Record<string, string> = {
   GOFLAGS: '-mod=readonly',
   GOTOOLCHAIN: 'local',
   GOPROXY: 'off',
   GOWORK: 'off',
};

/**
 * The variables the probe passes through whatever it runs. Everything else in the
 * caller's environment is dropped: a probe is not the user's shell, and an inherited
 * `NODE_OPTIONS`, `npm_config_*`, or `LD_PRELOAD` is exactly the kind of thing that
 * turns "ask for a version" into "run something else".
 */
const PROBE_PLATFORM_ENV = ['SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR'];

/** Per-manager configuration the probe keeps, because without it the manager cannot
 * find the environment it is being asked about. Nothing beyond this is inherited. */
const PROBE_MANAGER_ENV: Record<string, string[]> = {
   uv: ['UV_CACHE_DIR', 'UV_PROJECT_ENVIRONMENT', 'VIRTUAL_ENV'],
   poetry: ['POETRY_HOME', 'POETRY_VIRTUALENVS_PATH', 'POETRY_CACHE_DIR', 'VIRTUAL_ENV'],
   pdm: ['PDM_HOME', 'PDM_CACHE_DIR', 'VIRTUAL_ENV'],
   pipenv: ['PIPENV_VENV_IN_PROJECT', 'WORKON_HOME', 'VIRTUAL_ENV'],
   go: ['GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOBIN'],
};

function passThrough(names: string[], into: Record<string, string>): void {
   for (const name of names) {
      const value = process.env[name];
      if (value !== undefined) into[name] = value;
   }
}

/**
 * The environment for a probe that has to find a program on the caller's PATH (a
 * package manager, or the ambient `leji`): PATH and HOME survive because the manager
 * cannot answer without them, plus the manager's own named configuration. Nothing
 * else does.
 */
function spawnedProbeEnv(manager: string | null): Record<string, string> {
   const env: Record<string, string> = {};
   passThrough(['PATH', 'Path', 'HOME'], env);
   passThrough(PROBE_PLATFORM_ENV, env);
   if (manager !== null) passThrough(PROBE_MANAGER_ENV[manager] ?? [], env);
   if (manager === 'go') Object.assign(env, GO_PROBE_ENV);
   return env;
}

/**
 * The environment for the direct execution of the repository's own bin shim: nothing
 * of the caller's is inherited at all. PATH holds only the directory of the running
 * Node binary, because the shim's interpreter line resolves `node` there, and HOME
 * points at a temporary directory so no user configuration is read.
 */
function directProbeEnv(): Record<string, string> {
   const env: Record<string, string> = { PATH: path.dirname(process.execPath), HOME: os.tmpdir() };
   passThrough(PROBE_PLATFORM_ENV, env);
   return env;
}

/** A bare `<major>.<minor>.<patch>` with an optional prerelease or build tail, which
 * is what every `leji --version` prints. Anything else is not a version this probe
 * will believe. */
export const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

function parseVersion(stdout: string): { text: string; major: number } | null {
   const line = stdout.split('\n').find((l) => l.trim() !== '');
   if (line === undefined) return null;
   const m = VERSION_RE.exec(line.trim());
   return m === null ? null : { text: line.trim(), major: Number(m[1]) };
}

/**
 * How this repository's declared CLI would be asked for its version. `direct` is the
 * installed Node shim, executed as a file; `spawned` is a manager or the ambient
 * binary, found on the caller's PATH; `absent` is a Node repository whose install has
 * not produced the shim (not installed, or a Yarn PnP tree that has no bin directory)
 * — reported, never worked around by asking a package manager to run a script.
 */
type ProbePlan =
   | { kind: 'direct'; bin: string; args: string[]; env: Record<string, string> }
   | { kind: 'spawned'; bin: string; args: string[]; env: Record<string, string> }
   | { kind: 'absent' };

/** The names a Node bin shim can take, strongest first. Windows installs a `.cmd`
 * wrapper beside (or instead of) the extensionless shim. */
function binCandidates(): string[] {
   return process.platform === 'win32' ? ['leji.cmd', 'leji.exe', 'leji'] : ['leji'];
}

/**
 * The installed shim's absolute path, or null. Every condition is checked before the
 * path is ever executed: a regular file after symlinks are followed (npm installs the
 * shim AS a symlink, so links are expected), resolving inside the real repository
 * root, and executable where the platform records that.
 */
export function installedNodeBin(root: string): string | null {
   for (const name of binCandidates()) {
      const abs = path.join(root, 'node_modules', '.bin', name);
      if (!resolvedWithinRoot(root, abs)) continue;
      let st: fs.Stats;
      try {
         st = fs.statSync(abs);
      } catch {
         continue;
      }
      if (!st.isFile()) continue;
      if (process.platform !== 'win32' && (st.mode & 0o111) === 0) continue;
      return abs;
   }
   return null;
}

function probePlan(root: string, report: EcosystemReport): ProbePlan {
   const selected = report.selected;
   const manager = selected !== null && selected.directDeclared ? selected.manager : null;
   if (manager !== null && NODE_MANAGERS.has(manager)) {
      const bin = installedNodeBin(root);
      return bin === null ? { kind: 'absent' } : { kind: 'direct', bin, args: [], env: directProbeEnv() };
   }
   const argv = manager === null ? null : MANAGER_PROBE_ARGV[manager];
   if (argv !== undefined && argv !== null) {
      return { kind: 'spawned', bin: argv[0], args: argv.slice(1), env: spawnedProbeEnv(manager) };
   }
   // Undeclared, pip, and pre-1.24 Go all reach the CLI the same way a person does:
   // whatever `leji` the PATH resolves, run with the same sanitized environment.
   return { kind: 'spawned', bin: 'leji', args: [], env: spawnedProbeEnv(null) };
}

/**
 * Ask the CLI this repository would run for its version. Argv, never a shell; cwd
 * pinned to the root; stdin closed; output and time bounded; a sanitized environment;
 * and never a package manager's script runner. Every failure mode — a missing
 * executable, a non-zero exit, a timeout, output that is not a version — comes back
 * as null, because a probe that cannot answer is not evidence that the CLI is there.
 */
function probeVersion(root: string, plan: ProbePlan, io: HandoffIo): { text: string; major: number } | null {
   if (plan.kind === 'absent') return null;
   const res = io.run(plan.bin, [...plan.args, '--version'], root, {
      quiet: true,
      capture: true,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: PROBE_MAX_BYTES,
      env: plan.env,
   });
   if (res.error || res.signal != null || (res.status ?? 1) !== 0) return null;
   return parseVersion(res.stdout ?? '');
}

// --- the checks -----------------------------------------------------------

function check(
   id: CheckId,
   status: CheckStatus,
   detail: string,
   fix: string[] | null,
   fixKind: FixKind = 'command',
): Check {
   return { id, status, detail, fix, fixKind };
}

/** The command line a fix names, from the argv the tables already carry. */
function line(argv: string[]): string {
   return argv.join(' ');
}

function cliCheck(root: string, manifest: Manifest, report: EcosystemReport, io: HandoffIo): Check {
   const selected = report.selected;
   const runner = runnerArgv(report);
   const specLine = manifest.leji;
   const minimum = MIN_SDK_FOR_SPEC_LINE[specLine];
   const plan = probePlan(root, report);

   if (selected === null || !selected.directDeclared) {
      // The gap is the repository's declaration, which is a committed file: report it
      // with the maintainer's command whatever this machine happens to have. The plain
      // `leji` is still probed, so an ambient install is named as what it is.
      const found = probeVersion(root, plan, io);
      const add = selected?.add ?? null;
      return check(
         'cli',
         'shared-gap',
         found === null ? START_TEXT.cli.undeclared : START_TEXT.cli.undeclaredAmbient(found.text),
         add === null ? null : [line(add)],
      );
   }
   const found = probeVersion(root, plan, io);
   // The row names what actually answered: the installed shim for a Node repository,
   // and the manager's own runner everywhere else.
   const shown = plan.kind === 'direct' || plan.kind === 'absent' ? NODE_BIN_REL : line(runner);
   const install = selected.manager === null ? null : managerInstallArgv(selected.manager);
   // A Node repository whose shim is absent gets the install command AND the way to
   // confirm it worked, because leji will not run a package manager to find out.
   const fix =
      install === null
         ? null
         : plan.kind === 'direct' || plan.kind === 'absent'
           ? [line(install), START_TEXT.cli.verify(line(runner))]
           : [line(install)];
   if (plan.kind === 'absent') {
      return check('cli', 'missing', START_TEXT.cli.notInstalled(NODE_BIN_REL), fix);
   }
   if (found === null) {
      // A manager with no single install command (pip, pre-1.24 Go) has no argv to
      // print, so the row itself has to carry the instruction.
      const detail =
         install === null ? START_TEXT.cli.unresolvableNoInstall(shown) : START_TEXT.cli.unresolvable(shown);
      return check('cli', 'missing', detail, fix);
   }
   if (minimum !== undefined && found.major < Number(minimum.split('.')[0])) {
      return check('cli', 'missing', START_TEXT.cli.belowMinimum(found.text, shown, minimum, specLine), fix);
   }
   return check('cli', 'ok', START_TEXT.cli.ok(found.text, shown), null);
}

/** The argv that registers the server for THIS USER on a host, or null when the host
 * has no registration command at all. */
function personalMcpAdd(hostId: string): { bin: string; argv: string[] } | null {
   const spec = hostSpec(hostId);
   const argv = spec?.mcpAddUser ?? spec?.mcpAdd;
   return spec === undefined || argv === undefined ? null : { bin: spec.bins[0], argv };
}

function mcpCheck(root: string, host: PromptHost | null, detected: DetectedHost[], io: HandoffIo): Check {
   if (host === null) {
      const launchable = startHosts(detected);
      if (launchable.length > 1) {
         return check('mcp', 'unresolved', START_TEXT.mcp.unresolved(launchable.map((h) => h.name)), [
            'leji start --agent <name>',
         ]);
      }
      // A host Leji cannot register for is still worth a row: the person can add the
      // standard configuration by hand, which is the only fix that exists for it.
      for (const h of detected) {
         const spec = hostSpec(h.id);
         if (spec?.mcpConfig === undefined) continue;
         return check(
            'mcp',
            'missing',
            START_TEXT.mcp.manual(h.name),
            [
               START_TEXT.mcp.manualPath(spec.mcpConfig.path, spec.mcpConfig.scope),
               ...mcpJsonConfig(spec.mcpConfig.shape).split('\n'),
            ],
            'snippet',
         );
      }
      return check('mcp', 'skipped', START_TEXT.mcp.none, null);
   }
   const spec = hostSpec(host.id);
   if (spec?.mcpCheck !== undefined) {
      const res = io.run(host.bin, spec.mcpCheck, root, { quiet: true });
      if (!res.error && res.signal == null && res.status === 0) {
         return check('mcp', 'ok', START_TEXT.mcp.registered(host.name), null);
      }
   }
   const personal = personalMcpAdd(host.id);
   return check(
      'mcp',
      'missing',
      START_TEXT.mcp.missing(host.name),
      personal === null ? null : [`${personal.bin} ${line(personal.argv)}`],
   );
}

/** True when a regular file stands at `rel` directly inside the repository root. */
function committedFile(root: string, rel: string): boolean {
   const abs = path.join(root, rel);
   try {
      if (!fs.statSync(abs).isFile()) return false;
   } catch {
      return false;
   }
   return resolvedWithinRoot(root, abs);
}

function mcpSharedCheck(root: string, host: PromptHost | null): Check {
   if (host === null) return check('mcp-shared', 'n/a', START_TEXT.mcpShared.noHost, null);
   const spec = hostSpec(host.id);
   const file = spec?.mcpSharedFile;
   if (spec === undefined || file === undefined || spec.mcpAdd === undefined) {
      return check('mcp-shared', 'n/a', START_TEXT.mcpShared.other, null);
   }
   if (committedFile(root, file)) {
      return check('mcp-shared', 'ok', START_TEXT.mcpShared.present(file), null);
   }
   return check('mcp-shared', 'shared-gap', START_TEXT.mcpShared.absent(file), [mcpCommand(spec, spec.mcpAdd)]);
}

const HOOK_FIX = ['leji ci --hooks'];

function hookCheck(status: HookStatus): Check {
   if (status.ownership === 'no-git') return check('hook', 'missing', START_TEXT.hook.noGit, null);
   if (status.state === 'current') return check('hook', 'ok', START_TEXT.hook.current(status.path), null);
   if (status.ownership === 'personal') {
      return status.state === 'absent'
         ? check('hook', 'missing', START_TEXT.hook.absentPersonal, HOOK_FIX)
         : check('hook', 'missing', START_TEXT.hook.foreign(status.path), status.snippet.split('\n'), 'snippet');
   }
   if (status.ownership === 'shared') {
      return check('hook', 'shared-gap', START_TEXT.hook.absentShared(status.path), HOOK_FIX);
   }
   if (status.ownership === 'outside-root') {
      // A linked worktree's hooks live in the common git directory, outside this
      // working tree. It is still per-clone state, but the writer refuses anything
      // outside the repository root, so the only honest answer is the snippet.
      return check('hook', 'missing', START_TEXT.hook.outsideRoot(status.path), status.snippet.split('\n'), 'snippet');
   }
   // Outside the repository entirely: reported with the snippet, never written.
   return check('hook', 'missing', START_TEXT.hook.external(status.path), status.snippet.split('\n'), 'snippet');
}

// --- the report -----------------------------------------------------------

export interface PreflightOptions {
   /** Absolute or relative layer root; every check reads from it and nothing else. */
   root: string;
   manifest: Manifest;
   /** The host `leji start` resolved for this run, or null when none was selected. */
   host: PromptHost | null;
   detected: DetectedHost[];
   report: EcosystemReport;
   io: HandoffIo;
}

/** Ids that decide readiness: the shared registration is project hygiene, and a
 * maintainer's gap never makes this clone unready. */
const READY_IDS: CheckId[] = ['cli', 'mcp', 'hook'];
const READY_STATUSES: CheckStatus[] = ['ok', 'skipped', 'n/a'];

/**
 * Run every check, in the fixed order, writing nothing. The only child processes are
 * the bounded version probe and the host's own registration query, both through the
 * injectable IO.
 */
export function runPreflight(opts: PreflightOptions): PreflightResult {
   const root = path.resolve(opts.root);
   const hook = hookStatus(root, runnerArgv(opts.report));
   const checks: Check[] = [
      cliCheck(root, opts.manifest, opts.report, opts.io),
      mcpCheck(root, opts.host, opts.detected, opts.io),
      mcpSharedCheck(root, opts.host),
      hookCheck(hook),
   ];
   const ready = checks.every((c) => !READY_IDS.includes(c.id) || READY_STATUSES.includes(c.status));
   return { ready, checks, hook };
}

/** What `--json` publishes for one check: exactly the four keys the document promises, so
 * a render-only field can never reach the scriptable contract. */
export interface CheckDocument {
   id: CheckId;
   status: CheckStatus;
   detail: string;
   fix: string[] | null;
}

/** The projection every document mode goes through, rather than serializing a Check. */
export function checkDocument(c: Check): CheckDocument {
   return { id: c.id, status: c.status, detail: c.detail, fix: c.fix };
}

/** The escape each label wears when color is on. The word is styled; its padding is not,
 * so the columns line up whether or not the escapes are there. */
const STATUS_COLOR: Record<string, string> = {
   ok: '\x1b[32m',
   you: '\x1b[33m',
   team: '\x1b[36m',
   'n/a': '\x1b[2m',
};
const COLOR_RESET = '\x1b[0m';

/**
 * Whether the Setup block may color its status words: a real terminal that has not asked
 * for plain text. `NO_COLOR` disables at any value, empty included, because the convention
 * is presence. A pure function of the two things it reads, decided once at the CLI
 * boundary and injected, so nothing downstream consults the process and every piped byte
 * is escape-free by construction.
 */
export function colorDecision(isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
   return isTTY && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

export interface RenderPreflightOptions {
   /** Off unless the boundary says otherwise. */
   color?: boolean;
}

function summaryLine(you: number, team: number): string {
   const s = START_TEXT.summary;
   if (you > 0 && team > 0) return s.both(s.fixes(you), team);
   if (you > 0) return s.you(s.fixes(you));
   if (team > 0) return s.team(s.fixes(team));
   return s.complete;
}

/**
 * The Setup block: a heading, one fixed-column row per check with its fixes under it, and
 * one closing line counting what is owed. The counts come from the labels the rows already
 * printed, so the block can never say something its own rows do not.
 */
export function renderPreflight(checks: Check[], options: RenderPreflightOptions = {}): string {
   const lines = [START_TEXT.heading, ''];
   let you = 0;
   let team = 0;
   for (const c of checks) {
      const label = START_TEXT.status[c.status];
      if (label === 'you') you++;
      else if (label === 'team') team++;
      const word = options.color === true ? `${STATUS_COLOR[label] ?? ''}${label}${COLOR_RESET}` : label;
      const status = `${word}${' '.repeat(STATUS_WIDTH - label.length)}`;
      const subject = START_TEXT.subject[c.id].padEnd(SUBJECT_WIDTH);
      lines.push(`${MARGIN}${status}${GUTTER}${subject}${GUTTER}${c.detail}`);
      const prompt = (c.fixKind ?? 'command') === 'command' ? '$ ' : '';
      for (const fix of c.fix ?? []) lines.push(`${FIX_INDENT}${prompt}${fix}`);
   }
   lines.push('', `${MARGIN}${summaryLine(you, team)}`);
   return lines.join('\n');
}

// --- the consented repairs ------------------------------------------------

export interface PreflightOfferOptions {
   root: string;
   host: PromptHost | null;
   result: PreflightResult;
   /** The runner the hook would be written with, so the report and the write agree. */
   runner: string[];
   /** A real TTY and not --json; nothing is offered or written otherwise. */
   interactive: boolean;
   io: HandoffIo;
}

/**
 * Offer the personal repairs the report found, in the order it printed them. Only
 * state this user or this clone owns is ever offered: the host registration for this
 * user, and the per-clone hook. A shared gap is never offered, because accepting it
 * would write a file the repository commits.
 */
export async function offerPreflightFixes(opts: PreflightOfferOptions): Promise<void> {
   if (!opts.interactive) return;
   const byId = (id: CheckId): Check | undefined => opts.result.checks.find((c) => c.id === id);
   const yes = async (question: string): Promise<boolean> => {
      const a = (await opts.io.readLine(question, START_TEXT.offer.prompt)).toLowerCase();
      return a === '' || a === 'y' || a === 'yes';
   };

   const mcp = byId('mcp');
   const personal = opts.host === null ? null : personalMcpAdd(opts.host.id);
   if (mcp?.status === 'missing' && opts.host !== null && personal !== null) {
      if (await yes(START_TEXT.offer.mcp(opts.host.name))) {
         const res = opts.io.run(personal.bin, personal.argv, opts.root, { quiet: false });
         if (!res.error && res.signal == null && (res.status == null || res.status === 0)) {
            console.log(START_TEXT.offer.mcpDone(opts.host.name));
         } else {
            console.log(START_TEXT.offer.mcpFailed(personal.bin));
            console.log(`${FIX_INDENT}$ ${personal.bin} ${line(personal.argv)}`);
         }
      }
   }

   const hook = opts.result.hook;
   if (hook.ownership === 'personal' && hook.state === 'absent' && (await yes(START_TEXT.offer.hook))) {
      const written = ensureLocalHook(opts.root, opts.runner);
      if (written.action === 'manual') {
         console.log(START_TEXT.offer.hookFailed);
         console.log(`\n${written.snippet ?? ''}`);
      } else {
         console.log(START_TEXT.offer.hookDone(written.path));
      }
   }
}
