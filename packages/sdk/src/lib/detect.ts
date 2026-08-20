import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A coding-agent host Leji knows how to wire. `adapter` is the vendor entrypoint
 * file Leji creates (a one-line redirect to the boot profile); `null` marks a
 * directory-style host (Cursor, Windsurf) whose adapter wiring is deferred.
 */
export interface HostSpec {
   id: string;
   name: string;
   bins: string[];
   repoFiles: string[];
   userDirs: string[];
   adapter: string | null;
   /** Argv (after the host bin) that registers the local Leji MCP server, or absent
    * for a host with no known `mcp add` command. Run from the layer root so a
    * project-scoped write (Claude's `.mcp.json`) lands in the right repository. */
   mcpAdd?: string[];
   /** Argv that reports whether the Leji MCP server is already registered (exit 0 =
    * present); used to skip the install offer when it's already there. */
   mcpCheck?: string[];
   /** Argv that registers the server for THIS USER, across every project. Absent
    * when `mcpAdd` is already the user-level form (Codex has no other scope). */
   mcpAddUser?: string[];
   /** The committed file a shared (project-scope) registration writes, repository
    * root relative. Only a host whose `mcpAdd` writes into the repository has one. */
   mcpSharedFile?: string;
   /** Where a host with no registration command reads its MCP configuration, for a
    * host Leji can only tell the user about, and which shape that file takes. */
   mcpConfig?: { path: string; scope: 'project' | 'user'; shape: McpConfigShape };
}

/**
 * The top-level key an MCP client's configuration file uses for its server map.
 * `mcpServers` is the common one; VS Code (and GitHub Copilot through it) spells the
 * same map `servers` in `.vscode/mcp.json`, so a client told to paste the common
 * block there ends up with a file the editor ignores.
 */
export type McpConfigShape = 'mcpServers' | 'servers';

/** The registered server name and the npm package behind the local Leji MCP server. */
export const MCP_SERVER_NAME = 'leji';
export const MCP_PACKAGE = '@leji-org/mcp';

/**
 * The MCP client configuration for the local Leji server, in the shape one client's
 * configuration file takes. The SDK owns these bytes: the MCP package README and the
 * website quote the `mcpServers` form, and a repo test asserts the three of them
 * agree, so the instruction a user reads is one text.
 */
export function mcpJsonConfig(shape: McpConfigShape): string {
   return `{
  "${shape}": {
    "${MCP_SERVER_NAME}": { "command": "npx", "args": ["-y", "${MCP_PACKAGE}"] }
  }
}`;
}

/** The common form, the one the README and the website publish. */
export const MCP_JSON_CONFIG: string = mcpJsonConfig('mcpServers');

/** One host command line as a user would type it: the host binary, then the argv. */
export function mcpCommand(spec: HostSpec, argv: string[]): string {
   return `${spec.bins[0]} ${argv.join(' ')}`;
}

/** The host spec with this id, or undefined. */
export function hostSpec(id: string): HostSpec | undefined {
   return HOST_SPECS.find((s) => s.id === id);
}

/**
 * The portable discovery adapter. `AGENTS.md` is a cross-host entrypoint
 * convention (stewarded by the Linux Foundation's Agentic AI Foundation, read
 * natively by Codex, Copilot, Cursor, Gemini CLI, and others), not any one
 * vendor's file, so `init`/`adopt` generate it as the default pointer-only
 * redirect to the boot profile. Hosts with their own entrypoint (`CLAUDE.md`)
 * are wired individually via `--wire-adapters` / `--agent`.
 */
export const PORTABLE_ADAPTER = 'AGENTS.md';

export const HOST_SPECS: HostSpec[] = [
   {
      id: 'claude-code',
      name: 'Claude Code',
      bins: ['claude'],
      repoFiles: ['CLAUDE.md'],
      userDirs: ['.claude', '.config/claude'],
      adapter: 'CLAUDE.md',
      // Project scope writes a committed `.mcp.json` so the whole team gets the server.
      mcpAdd: ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'project', '--', 'npx', '-y', MCP_PACKAGE],
      mcpCheck: ['mcp', 'get', MCP_SERVER_NAME],
      // User scope is the personal form: it registers for every project of this
      // user without touching a file the repository commits.
      mcpAddUser: ['mcp', 'add', MCP_SERVER_NAME, '--scope', 'user', '--', 'npx', '-y', MCP_PACKAGE],
      mcpSharedFile: '.mcp.json',
   },
   {
      id: 'codex',
      name: 'Codex',
      bins: ['codex'],
      // AGENTS.md is a detection signal for Codex but is not Codex's file: it is
      // the portable adapter (PORTABLE_ADAPTER) many hosts read.
      repoFiles: ['AGENTS.md'],
      userDirs: ['.codex'],
      adapter: 'AGENTS.md',
      // Codex registers at user level (~/.codex/config.toml); no project scope.
      mcpAdd: ['mcp', 'add', MCP_SERVER_NAME, '--', 'npx', '-y', MCP_PACKAGE],
      mcpCheck: ['mcp', 'get', MCP_SERVER_NAME],
   },
   {
      id: 'copilot',
      name: 'GitHub Copilot',
      bins: ['gh', 'code'],
      repoFiles: ['.github/copilot-instructions.md'],
      userDirs: [],
      adapter: '.github/copilot-instructions.md',
      mcpConfig: { path: '.vscode/mcp.json', scope: 'project', shape: 'servers' },
   },
   {
      id: 'gemini',
      name: 'Gemini CLI',
      bins: ['gemini'],
      repoFiles: ['GEMINI.md', '.gemini'],
      userDirs: ['.gemini'],
      adapter: 'GEMINI.md',
      mcpConfig: { path: '.gemini/settings.json', scope: 'project', shape: 'mcpServers' },
   },
   {
      id: 'cursor',
      name: 'Cursor',
      bins: ['cursor'],
      repoFiles: ['.cursor/rules', '.cursorrules'],
      userDirs: [],
      adapter: '.cursor/rules/leji.md',
      mcpConfig: { path: '.cursor/mcp.json', scope: 'project', shape: 'mcpServers' },
   },
   {
      id: 'windsurf',
      name: 'Windsurf',
      bins: ['windsurf'],
      repoFiles: ['.windsurf/rules', '.windsurfrules'],
      userDirs: [],
      adapter: '.windsurf/rules/leji.md',
      mcpConfig: { path: '~/.codeium/windsurf/mcp_config.json', scope: 'user', shape: 'mcpServers' },
   },
];

/** Common aliases users type for a host id. */
const HOST_ALIASES: Record<string, string> = {
   claude: 'claude-code',
   'claude-code': 'claude-code',
   codex: 'codex',
   copilot: 'copilot',
   'github-copilot': 'copilot',
   gemini: 'gemini',
   cursor: 'cursor',
   windsurf: 'windsurf',
};

export function resolveHostId(name: string): string | undefined {
   return HOST_ALIASES[name.toLowerCase()];
}

/** Signal strength, strongest first: a runnable binary beats a repo config file
 * beats a user-level config directory. */
export type Strength = 'confirmed' | 'project-present' | 'installed-likely';

export interface DetectedHost {
   id: string;
   name: string;
   strength: Strength;
   onPath: boolean;
   inRepo: boolean;
   userConfig: boolean;
   adapter: string | null;
}

export interface DetectOptions {
   root: string;
   env?: NodeJS.ProcessEnv;
   homedir?: string;
   platform?: NodeJS.Platform;
   /** Injectable PATH probe; defaults to a manual scan of env.PATH. */
   hasBinary?: (bin: string) => boolean;
}

/** Manual, dependency-free `which`: scan PATH entries for an executable. */
function onPathFactory(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): (bin: string) => boolean {
   const raw = env.PATH ?? env.Path ?? '';
   const dirs = raw.split(platform === 'win32' ? ';' : ':').filter(Boolean);
   const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
   return (bin) =>
      dirs.some((d) =>
         exts.some((ext) => {
            try {
               const st = fs.statSync(path.join(d, bin + ext));
               if (!st.isFile()) return false;
               // POSIX: require an executable bit. Windows: extension implies it.
               return platform === 'win32' || (st.mode & 0o111) !== 0;
            } catch {
               return false;
            }
         }),
      );
}

const STRENGTH_RANK: Record<Strength, number> = { confirmed: 0, 'project-present': 1, 'installed-likely': 2 };

/**
 * Best-effort detection of available coding-agent hosts, ranked by signal
 * strength. Never launches anything and never writes. Probes are injectable for
 * deterministic tests.
 */
export function detectHosts(opts: DetectOptions): DetectedHost[] {
   const env = opts.env ?? process.env;
   const platform = opts.platform ?? process.platform;
   const home = opts.homedir ?? os.homedir();
   const hasBinary = opts.hasBinary ?? onPathFactory(env, platform);

   const out: DetectedHost[] = [];
   for (const spec of HOST_SPECS) {
      const onPath = spec.bins.some(hasBinary);
      const inRepo = spec.repoFiles.some((f) => fs.existsSync(path.join(opts.root, f)));
      const userConfig = spec.userDirs.some((d) => fs.existsSync(path.join(home, d)));
      if (!onPath && !inRepo && !userConfig) continue;
      const strength: Strength = onPath ? 'confirmed' : inRepo ? 'project-present' : 'installed-likely';
      out.push({ id: spec.id, name: spec.name, strength, onPath, inRepo, userConfig, adapter: spec.adapter });
   }
   return out.sort((a, b) => STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] || a.id.localeCompare(b.id));
}

/** The one-line vendor redirect Leji writes for a file-style host. */
export function adapterContent(bootProfilePath: string): string {
   return `Read ./${bootProfilePath} first. It is the canonical context entrypoint for this repository.\n`;
}
