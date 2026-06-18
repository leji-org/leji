import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A coding-agent host Leji knows how to wire. `adapter` is the vendor entrypoint
 * file Leji would create (a one-line redirect to the boot profile); `null` marks
 * a directory-style host (Cursor, Windsurf) whose adapter wiring is deferred
 * until validation grows directory semantics.
 */
export interface HostSpec {
   id: string;
   name: string;
   bins: string[];
   repoFiles: string[];
   userDirs: string[];
   adapter: string | null;
}

export const HOST_SPECS: HostSpec[] = [
   {
      id: 'claude-code',
      name: 'Claude Code',
      bins: ['claude'],
      repoFiles: ['CLAUDE.md'],
      userDirs: ['.claude', '.config/claude'],
      adapter: 'CLAUDE.md',
   },
   {
      id: 'codex',
      name: 'Codex',
      bins: ['codex'],
      repoFiles: ['AGENTS.md'],
      userDirs: ['.codex'],
      adapter: 'AGENTS.md',
   },
   {
      id: 'copilot',
      name: 'GitHub Copilot',
      bins: ['gh', 'code'],
      repoFiles: ['.github/copilot-instructions.md'],
      userDirs: [],
      adapter: '.github/copilot-instructions.md',
   },
   {
      id: 'gemini',
      name: 'Gemini CLI',
      bins: ['gemini'],
      repoFiles: ['GEMINI.md', '.gemini'],
      userDirs: ['.gemini'],
      adapter: 'GEMINI.md',
   },
   {
      id: 'cursor',
      name: 'Cursor',
      bins: ['cursor'],
      repoFiles: ['.cursor/rules', '.cursorrules'],
      userDirs: [],
      adapter: '.cursor/rules/leji.md',
   },
   {
      id: 'windsurf',
      name: 'Windsurf',
      bins: ['windsurf'],
      repoFiles: ['.windsurf/rules', '.windsurfrules'],
      userDirs: [],
      adapter: '.windsurf/rules/leji.md',
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
               // On POSIX a "confirmed" host means a runnable binary: require an
               // executable bit. On Windows the extension implies executability.
               return platform === 'win32' || (st.mode & 0o111) !== 0;
            } catch {
               return false;
            }
         }),
      );
}

const STRENGTH_RANK: Record<Strength, number> = { confirmed: 0, 'project-present': 1, 'installed-likely': 2 };

/**
 * Best-effort detection of the coding-agent hosts available to this user, ranked
 * by signal strength. Never launches anything and never writes; purely informs
 * the handoff and (on explicit request) adapter wiring. Probes are injectable so
 * the result is deterministic under test.
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
