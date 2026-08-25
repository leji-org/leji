import * as path from 'node:path';

/**
 * The unified `.leji/` layout: one tree at the repository root holding every role
 * the tool owns, whatever `rootPath` the layer declares. Roles are
 * repository-root-relative by construction — a generated artifact never lives
 * inside the context root, so the content walk and the served content mount carry
 * nothing of the tool's own.
 *
 * - `mounts/` + `mounts.local.json` — the private federation domain (owned by
 *   lib/mounts.ts, which spells the paths inside it; never servable, never
 *   exportable).
 * - `viewer/` — generated chrome, the ONE servable role.
 * - `dist/` — the default export output.
 * - `work/` — the transient onboarding workspace.
 */
export const LEJI_DIR = '.leji';

/** Generated viewer chrome (index.html, _sidebar.md, _manifest.md, assets/). */
export const VIEWER_REL = `${LEJI_DIR}/viewer`;

/** Default export output; the only role a caller-supplied `--out` may name. */
export const DIST_REL = `${LEJI_DIR}/dist`;

/** Transient onboarding workspace (brief, proposal, hooks). */
export const WORK_REL = `${LEJI_DIR}/work`;

/** The private federation domain: managed object stores, projection cache, staging. */
export const MOUNTS_REL = `${LEJI_DIR}/mounts`;

/**
 * The one metadata file the tool keeps directly under root `.leji/`, outside every
 * role: the ignore file that keeps the tool's own tree out of the repository even
 * when the root `.gitignore` never received the `.leji/` line. It belongs to no
 * role, so the role rule below refuses it; the single named exception that allows
 * it lives in `lib/fsx.ts`, where the REQUESTED entry is still visible.
 */
export const LEJI_IGNORE_REL: string = `${LEJI_DIR}/.gitignore`;

/** True when `abs` is `dir` or sits underneath it. */
function under(dir: string, abs: string): boolean {
   return abs === dir || abs.startsWith(dir + path.sep);
}

/**
 * The servable-roots whitelist: a path may be served or exported only when it
 * lies outside root `.leji/` entirely, or inside `.leji/viewer/`. Every other
 * role under `.leji/` — the private mounts domain, the export output, the
 * onboarding workspace, and any role added later — is denied **by name**, so a
 * new role is born unservable and no relaxation of the dot-segment refusal (kept
 * as defense in depth) can open the trust domain as a side effect.
 *
 * `rootAbs` must be a resolved (realpath'd) repository root, and `abs` is judged
 * both as requested and after symlink resolution: the name is what decides, not
 * how the caller spelled it.
 */
export function servablePath(rootAbs: string, abs: string): boolean {
   const leji = path.join(rootAbs, LEJI_DIR);
   if (!under(leji, abs)) return true;
   return under(path.join(rootAbs, VIEWER_REL), abs);
}

/**
 * The private `.leji/` role a resolved path falls into: the first path segment
 * under `.leji/` (`mounts`, `work`, `dist`, `viewer`, or any future role name),
 * or `''` when the path is `.leji/` itself. Callers establish that `abs` is under
 * `.leji/` before asking; used to name the role in a boundary message.
 */
export function lejiRole(rootAbs: string, abs: string): string {
   const rest = path.relative(path.join(rootAbs, LEJI_DIR), abs);
   return rest === '' ? '' : rest.split(path.sep)[0];
}

/** The verdict of {@link writableTarget}: whether a tool-owned target may be
 * written or cleared, and — when refused — that it landed outside the repository,
 * the private role it crossed into, that the path could not be resolved at all
 * (permission/I/O, not mere absence), or that an exclusive create found the file
 * already there.
 *
 * `metadataFile` marks the one allowed target that belongs to no role,
 * {@link LEJI_IGNORE_REL}. It is never produced here: only the named exception in
 * `lib/fsx.ts` constructs it, on the requested entry, and a source-audit test
 * pins that single constructor site. */
export interface TargetVerdict {
   ok: boolean;
   role?: string;
   unresolvable?: boolean;
   outsideRoot?: true;
   exists?: true;
   metadataFile?: true;
}

/**
 * The check-before-act rule for a WRITE or CLEAR target, judged on the RESOLVED
 * path immediately before the act, in this order:
 *
 * 1. The target must resolve INSIDE the repository root. Every write this tool makes
 *    lands in the repository it was pointed at, with no exceptions: a `.leji/` role
 *    symlinked out of the tree is refused rather than followed. A user who wants the
 *    export somewhere else copies the finished folder there.
 * 2. A target under root `.leji/` is refused — that tree is the tool's own trust
 *    domain — UNLESS `ownRoleRel` is given and the target lies under that one role.
 * 3. Anything else inside the repository is ordinary content and is allowed.
 *
 * Both `rootAbs` and `resolvedAbs` must be realpath-resolved, so a redirecting
 * symlink or a case-variant spelling is judged by where it lands, not by how it was
 * written. One home for the rule, called before every write and clear.
 *
 * `ownRoleRel` names the ONE `.leji/` role the target may land in, as a lexical path
 * under the resolved root; pass `null` when the target has no legitimate `.leji/`
 * role at all (user content such as overview.md, which lives under the content root,
 * never inside `.leji/`) — then any `.leji/` landing is refused.
 */
export function writableTarget(rootAbs: string, resolvedAbs: string, ownRoleRel: string | null): TargetVerdict {
   if (!under(rootAbs, resolvedAbs)) return { ok: false, outsideRoot: true };
   const leji = path.join(rootAbs, LEJI_DIR);
   if (!under(leji, resolvedAbs)) return { ok: true }; // inside the repository, outside .leji/
   if (ownRoleRel !== null && under(path.join(rootAbs, ownRoleRel), resolvedAbs)) return { ok: true }; // its own role
   return { ok: false, role: lejiRole(rootAbs, resolvedAbs) };
}
