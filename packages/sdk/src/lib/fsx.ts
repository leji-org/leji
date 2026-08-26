import * as fs from 'node:fs';
import * as path from 'node:path';
import { type TargetVerdict, LEJI_DIR, LEJI_IGNORE_REL, lejiRole, writableTarget } from './layout.js';

export function toPosix(p: string): string {
   return p.split(path.sep).join('/');
}

export function exists(abs: string): boolean {
   return fs.existsSync(abs);
}

export function isDir(abs: string): boolean {
   try {
      return fs.statSync(abs).isDirectory();
   } catch {
      return false;
   }
}

export function isFile(abs: string): boolean {
   try {
      return fs.statSync(abs).isFile();
   } catch {
      return false;
   }
}

export function readText(abs: string): string {
   return fs.readFileSync(abs, 'utf8');
}

/**
 * Read a declared file's text, only if it is a regular file whose real path stays
 * within `rootAbs`. Returns null when missing, not a regular file, symlinked out of
 * root, or unresolvable. Use for every manifest-declared path so a hostile layer
 * cannot use a symlink to redirect a reader (CLI, or MCP exposing reads to an agent)
 * out.
 */
export function readTextWithin(rootAbs: string, abs: string): string | null {
   if (!isFile(abs) || !resolvedWithinRoot(rootAbs, abs)) return null;
   return readText(abs);
}

/**
 * `abs` with every symlink in it resolved, and with the filesystem's own spelling
 * of each existing component — so a case-variant path on a case-insensitive
 * filesystem comes back canonical. A path that does not exist yet resolves through
 * its nearest existing ancestor, with the remainder re-appended, so a caller can
 * judge a write target before anything is created under it. Null when even the
 * ancestor cannot be resolved.
 *
 * Judge with this whenever a decision and the write it guards must be about the
 * same path: a lexical comparison answers for the spelling, not for the file.
 *
 * `realpathSync.native`, deliberately: the JavaScript implementation hands back the
 * spelling it was given, so on a case-insensitive filesystem `.LEJI/x` stays
 * `.LEJI/x` and compares unequal to the very directory it opens. Only the platform
 * call reports the name the filesystem actually holds.
 */
export function resolvedPath(abs: string): string | null {
   try {
      return fs.realpathSync.native(abs); // path exists (e.g. overwrite target / vendor file)
   } catch (e) {
      // Only genuine nonexistence is rebuilt lexically from the nearest existing
      // ancestor. A permission or I/O error (EACCES, EIO, ELOOP, ENOTDIR, …) means
      // the path exists but cannot be resolved: it FAILS the check (null) rather
      // than being reconstructed as if it were an absent write target — a resolved
      // decision and the write it guards must be about the same real path.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      // A dangling symlink at the final component: realpath cannot follow it to a
      // missing target, but a write WOULD follow it there, so resolve the link's
      // target rather than treating the link's own name as the location — otherwise a
      // symlink into a private role reads as its own path and slips the boundary.
      // (realpath already proved the chain has no loop; a loop throws ELOOP, refused
      // above as unresolvable.) A missing final component that is not a symlink falls
      // through to the ancestor walk, the normal not-yet-created write target.
      let st: fs.Stats | undefined;
      try {
         st = fs.lstatSync(abs);
      } catch {
         st = undefined;
      }
      if (st?.isSymbolicLink()) {
         return resolvedPath(path.resolve(path.dirname(abs), fs.readlinkSync(abs)));
      }
      // Walk to the nearest existing ancestor. A dangling symlink in an INTERMEDIATE
      // component is not "absent": a write would follow it, so follow it here too —
      // resolve the link and re-root the remainder onto its target, rather than
      // climbing past it and rebuilding the link's own name lexically. Otherwise a
      // nested `redirect/export` whose `redirect` dangles into a private role reads
      // as `.../redirect/export` (outside `.leji/`) and a target created after the
      // check lands the write inside the role — the check/use race this closes.
      let p = path.dirname(abs);
      while (!fs.existsSync(p) && path.dirname(p) !== p) {
         let linkStat: fs.Stats | undefined;
         try {
            linkStat = fs.lstatSync(p, { throwIfNoEntry: false });
         } catch {
            return null; // p is present but cannot be lstat'd (permission/I/O): unresolvable
         }
         if (linkStat?.isSymbolicLink()) {
            return resolvedPath(path.join(path.resolve(path.dirname(p), fs.readlinkSync(p)), path.relative(p, abs)));
         }
         p = path.dirname(p);
      }
      try {
         return path.join(fs.realpathSync.native(p), path.relative(p, abs));
      } catch {
         return null;
      }
   }
}

/**
 * The repository root as every guard judges it: absolute and realpath-resolved,
 * falling back to the absolute spelling when it cannot be resolved at all. Both
 * sides of the containment rule must come through the same resolver, or a root
 * reached through a symlinked ancestor (`/tmp` -> `/private/tmp`) compares unequal
 * to its own children and every write under it reads as an escape.
 */
export function guardRoot(root: string): string {
   const abs = path.resolve(root);
   return resolvedPath(abs) ?? abs;
}

/**
 * True when `abs` resolves (following symlinks) within `rootAbs`, even when `abs`
 * does not yet exist: a non-existent target is checked
 * via its nearest existing ancestor, so a symlinked ancestor that escapes root is
 * caught before a write creates the file under it.
 */
export function resolvedWithinRoot(rootAbs: string, abs: string): boolean {
   const real = resolvedPath(abs);
   if (real === null) return false;
   let realRoot: string;
   try {
      // Both sides through the same resolver: a root resolved one way and a child
      // the other would differ in spelling alone and read as an escape.
      realRoot = fs.realpathSync.native(rootAbs);
   } catch {
      return false;
   }
   return real === realRoot || real.startsWith(realRoot + path.sep);
}

/**
 * The ONE declared exception to the role rule, and the only place a `metadataFile`
 * verdict is constructed: `<root>/.leji/.gitignore`, the ignore file the tool keeps
 * for its own tree. It belongs to no role, so {@link writableTarget} refuses it and
 * cannot be the judge here: the rule it needs is about the REQUESTED entry, which
 * `writableTarget` never sees.
 *
 * Null means "not this path": every other target falls through to the rule
 * unchanged. Otherwise the verdict is allowed on all three conditions, checked on
 * the ORIGINAL directory entries so a link is caught rather than followed:
 *
 * 1. the requested path is exactly `<root>/.leji/.gitignore`, and it resolves to
 *    itself (a `.LEJI/` spelling on a case-insensitive filesystem resolves to the
 *    name the filesystem holds and is not this path);
 * 2. `<root>/.leji` is a real directory, never a symlink;
 * 3. the entry is absent or a regular file, never a symlink or anything else.
 *
 * When a condition fails the exception REFUSES rather than falling back to an
 * allowance: today's verdict stands when it already refuses (a `.leji` symlinked
 * out of the repository is `outsideRoot`, exactly as it is now), and a redirect
 * that happens to land on ordinary content is refused as the requested path's own
 * role, never written through. The exception can only narrow, never widen.
 */
function metadataFileVerdict(
   rootAbs: string,
   targetAbs: string,
   resolved: string,
   ownRoleRel: string | null,
): TargetVerdict | null {
   const expected = path.join(rootAbs, LEJI_IGNORE_REL);
   if (path.resolve(targetAbs) !== expected) return null;
   const dir = fs.lstatSync(path.join(rootAbs, LEJI_DIR), { throwIfNoEntry: false });
   const entry = fs.lstatSync(expected, { throwIfNoEntry: false });
   if (resolved === expected && dir?.isDirectory() === true && (entry === undefined || entry.isFile())) {
      return { ok: true, metadataFile: true };
   }
   const verdict = writableTarget(rootAbs, resolved, ownRoleRel);
   return verdict.ok ? { ok: false, role: lejiRole(rootAbs, expected) } : verdict;
}

/** One judged target: the resolved path plus the verdict the rule returned for it,
 * which is {@link writableTarget}'s except at the one declared exception above.
 * `resolved` is null only when the path could not be resolved. */
function judgeTarget(
   rootAbs: string,
   targetAbs: string,
   ownRoleRel: string | null,
): { verdict: TargetVerdict; resolved: string | null } {
   const resolved = resolvedPath(targetAbs);
   if (resolved === null) return { verdict: { ok: false, unresolvable: true }, resolved: null };
   const exception = metadataFileVerdict(rootAbs, targetAbs, resolved, ownRoleRel);
   return { verdict: exception ?? writableTarget(rootAbs, resolved, ownRoleRel), resolved };
}

/**
 * The single guarded-write chokepoint (check-before-act). Realpath-resolve
 * `targetAbs`, run {@link writableTarget} on the resolved path, and perform the
 * write or clear — through `op`, on that resolved path — ONLY when the target is
 * allowed to land there, which means all of: it resolves at all; it resolves INSIDE
 * the repository root, with no exceptions; and it lands outside root `.leji/` or
 * inside the one role `ownRoleRel` names. On refusal nothing is touched: the verdict
 * is returned (unresolvable, outside the repository, or the private `.leji/` role the
 * target crossed into) so the caller renders the mandated hard refusal in its own
 * channel — a generation `finding`, or a thrown build error — before any byte is
 * written.
 *
 * `rootAbs` must already be realpath-resolved ({@link guardRoot}). `ownRoleRel` names
 * the one `.leji/` role this write may legitimately land in, or `null` when the target
 * has no `.leji/` role at all (user content such as overview.md). One home for every
 * write whose target derives from user-influenceable input, so a new write site is
 * guarded by construction rather than by remembering to guard it — and the guarded
 * conveniences below are how command modules reach it, so no command spells a raw
 * write primitive of its own.
 */
export function guardedWrite(
   rootAbs: string,
   targetAbs: string,
   ownRoleRel: string | null,
   op: (resolved: string) => void,
): TargetVerdict {
   const { verdict, resolved } = judgeTarget(rootAbs, targetAbs, ownRoleRel);
   if (verdict.ok && resolved !== null) op(resolved);
   return verdict;
}

/**
 * Write `bytes` to a guarded target, creating its parent directories only when the
 * write itself happens (a refused run establishes nothing). `opts.mode` sets the
 * mode at creation; `opts.exclusive` creates with O_EXCL, so a target that already
 * exists comes back as the `exists` verdict rather than being overwritten or
 * followed through a planted symlink.
 *
 * An exclusive create is decided on the ORIGINAL directory entry before anything is
 * resolved: ANY standing entry — a regular file, a directory, a symlink whether it
 * dangles or not — is `exists`. Resolving first would defeat the point, because a
 * dangling symlink resolves to its missing destination, and `O_EXCL` on that
 * destination would happily create the file the link points at. Nothing stands there
 * ⇒ the resolved path is judged (its parents included) and `O_EXCL` still closes the
 * race between that judgement and the create.
 */
export function writeFileGuarded(
   rootAbs: string,
   targetAbs: string,
   ownRoleRel: string | null,
   bytes: string | Buffer,
   opts: { mode?: number; exclusive?: boolean } = {},
): TargetVerdict {
   if (opts.exclusive === true && fs.lstatSync(targetAbs, { throwIfNoEntry: false }) !== undefined) {
      return { ok: false, exists: true };
   }
   let exists = false;
   const verdict = guardedWrite(rootAbs, targetAbs, ownRoleRel, (resolved) => {
      const options: { mode?: number; flag?: string } = {};
      if (opts.mode !== undefined) options.mode = opts.mode;
      if (opts.exclusive === true) options.flag = 'wx';
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      try {
         fs.writeFileSync(resolved, bytes, options);
      } catch (e) {
         if (opts.exclusive === true && (e as NodeJS.ErrnoException).code === 'EEXIST') {
            exists = true;
            return;
         }
         throw e;
      }
   });
   return exists ? { ok: false, exists: true } : verdict;
}

/** A guarded directory: the RESOLVED directory the rule judged, so every act that
 * follows works from the path that was checked rather than re-joining its own. */
export type GuardedDir = { ok: true; real: string } | ({ ok: false } & TargetVerdict);

/** Create a guarded directory and every missing parent, and hand back the resolved
 * path it was created at. */
export function mkdirpGuarded(rootAbs: string, targetAbs: string, ownRoleRel: string | null): GuardedDir {
   const { verdict, resolved } = judgeTarget(rootAbs, targetAbs, ownRoleRel);
   if (!verdict.ok || resolved === null) return { ...verdict, ok: false };
   fs.mkdirSync(resolved, { recursive: true });
   return { ok: true, real: resolved };
}

/** Clear a guarded target: recursive, and absent is success (the clean-rebuild
 * form every generator uses). */
export function rmGuarded(rootAbs: string, targetAbs: string, ownRoleRel: string | null): TargetVerdict {
   return guardedWrite(rootAbs, targetAbs, ownRoleRel, (resolved) => {
      fs.rmSync(resolved, { recursive: true, force: true });
   });
}

/** Rename with BOTH ends judged before either is touched, so neither the source
 * nor the destination can be redirected out of the rule by a planted symlink. */
export function renameGuarded(
   rootAbs: string,
   fromAbs: string,
   toAbs: string,
   ownRoleRel: string | null,
): TargetVerdict {
   const from = judgeTarget(rootAbs, fromAbs, ownRoleRel);
   if (!from.verdict.ok || from.resolved === null) return from.verdict;
   const to = judgeTarget(rootAbs, toAbs, ownRoleRel);
   if (!to.verdict.ok || to.resolved === null) return to.verdict;
   fs.renameSync(from.resolved, to.resolved);
   return { ok: true };
}

/** Set the mode of a guarded target. */
export function chmodGuarded(
   rootAbs: string,
   targetAbs: string,
   ownRoleRel: string | null,
   mode: number,
): TargetVerdict {
   return guardedWrite(rootAbs, targetAbs, ownRoleRel, (resolved) => {
      fs.chmodSync(resolved, mode);
   });
}

/** A guarded destination opened for writing: the descriptor and the resolved path
 * it is bound to, or the refusal verdict. The caller writes into `fd` and closes
 * it; the bytes then land in the file the rule judged, never in a path re-opened
 * afterwards. */
export type GuardedOpen = { ok: true; fd: number; real: string } | ({ ok: false } & TargetVerdict);

/** Open a guarded destination for writing (truncating), creating its parent
 * directories only when the open actually happens. */
export function openWriteGuarded(
   rootAbs: string,
   targetAbs: string,
   ownRoleRel: string | null,
   opts: { mode?: number } = {},
): GuardedOpen {
   const { verdict, resolved } = judgeTarget(rootAbs, targetAbs, ownRoleRel);
   if (!verdict.ok || resolved === null) return { ...verdict, ok: false };
   fs.mkdirSync(path.dirname(resolved), { recursive: true });
   const fd = opts.mode === undefined ? fs.openSync(resolved, 'w') : fs.openSync(resolved, 'w', opts.mode);
   return { ok: true, fd, real: resolved };
}

/**
 * Write a guarded target atomically: a temp sibling in the same directory, then a
 * rename onto the destination, so an interrupted write never leaves a partial file.
 * Both paths are judged before either is touched — a planted `<target>.leji-tmp`
 * symlink would otherwise be written through before the rename — and the temp is
 * removed when anything fails, so the whole compound operation lives here rather
 * than being re-composed at each call site.
 */
export function writeFileAtomicGuarded(
   rootAbs: string,
   targetAbs: string,
   ownRoleRel: string | null,
   bytes: string | Buffer,
): TargetVerdict {
   const tmp = judgeTarget(rootAbs, `${targetAbs}.leji-tmp`, ownRoleRel);
   if (!tmp.verdict.ok || tmp.resolved === null) return tmp.verdict;
   const dest = judgeTarget(rootAbs, targetAbs, ownRoleRel);
   if (!dest.verdict.ok || dest.resolved === null) return dest.verdict;
   try {
      fs.mkdirSync(path.dirname(dest.resolved), { recursive: true });
      fs.writeFileSync(tmp.resolved, bytes);
      maybeInjectWriteFailure();
      fs.renameSync(tmp.resolved, dest.resolved);
   } catch (e) {
      try {
         fs.rmSync(tmp.resolved, { force: true });
      } catch {
         /* best-effort cleanup; the caller reports the original failure */
      }
      throw e;
   }
   return { ok: true };
}

/** Test-only fault injection for {@link writeFileAtomicGuarded}: with
 * LEJI_TEST_FAIL_RENAME set, fail after the temp file exists but before the rename,
 * to exercise the cleanup and the caller's normalized-error path. */
function maybeInjectWriteFailure(): void {
   if (process.env.LEJI_TEST_FAIL_RENAME) throw new Error('injected write failure');
}

/** An opened source: the descriptor when the source passed every check (the caller
 * closes it), else null — with the resolved path, when it could be resolved at all,
 * so a refusal can name where the source actually landed. */
export interface VerifiedSource {
   fd: number | null;
   real: string | null;
}

/**
 * The guarded-READ counterpart of {@link guardedWrite} (check-before-act), for
 * every source whose bytes are about to be served, linted, or exported. Resolve
 * `abs` natively, judge the RESOLVED path with `allow`, then open that path and
 * prove the DESCRIPTOR is a regular file with `fstat` — so the file the check
 * judged is the file the read gets. A path-based check leaves two windows open: an
 * ancestor directory swapped to a symlink after enumeration (an `lstat` of the final
 * component follows it and reports an ordinary file), and the gap between any check
 * and a later read or copy by path. Reading from the descriptor closes both: the
 * inode is pinned by the open.
 *
 * The open itself is by path, so one window survives that: a swap landing between the
 * resolve above and the open makes the open follow the new link, and `fstat` sees only
 * an ordinary regular file. So the source is resolved ONCE MORE after the open and the
 * descriptor is required to be that same location and that same (dev, ino) — the bytes
 * about to be read are then provably the ones `allow` judged. What remains is the
 * recorded check-before-act limit (`docs/practice/trust-boundary.md`): an attacker must
 * swap AND revert within the open→recheck span to pass both resolutions, since portable
 * Node offers no `openat` to walk the path once.
 *
 * The caller closes `fd` when it is non-null, and owns the refusal semantics — a
 * silent drop, a boundary warning, or an error — since only it knows which the
 * source deserves. A source that vanished between the check and the open is one such
 * refusal; any other I/O error on an allowed path is the filesystem failing rather
 * than the boundary refusing, so it throws as a read by path always has.
 */
export function openVerifiedSource(abs: string, allow: (resolved: string) => boolean): VerifiedSource {
   const real = resolvedPath(abs);
   if (real === null || !allow(real)) return { fd: null, real };
   let fd: number;
   try {
      fd = fs.openSync(real, 'r');
   } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return { fd: null, real }; // gone between the check and the open
   }
   try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) {
         fs.closeSync(fd);
         return { fd: null, real };
      }
      // The recheck. A refusal names where the source resolves NOW, not where it
      // resolved before the swap, so the caller's boundary message points at the role
      // the bytes would actually have come from.
      const recheck = resolvedPath(abs);
      const landed = recheck === null ? null : fs.statSync(recheck);
      if (recheck !== real || landed === null || landed.dev !== opened.dev || landed.ino !== opened.ino) {
         fs.closeSync(fd);
         return { fd: null, real: recheck ?? real };
      }
   } catch {
      fs.closeSync(fd);
      return { fd: null, real };
   }
   return { fd, real };
}

/** What stood at a read-then-act target, judged by the same rule the write will be:
 * nothing (`absent`), a regular file whose verified bytes are carried along
 * (`regular`), or a standing entry this run refuses to act through (`refused`, with
 * the reason and where it resolved, when it resolved at all). */
export type VerifiedTargetRead =
   | { status: 'absent'; real: string }
   | { status: 'regular'; real: string; bytes: Buffer }
   | {
        status: 'refused';
        real: string | null;
        reason: 'outside-root' | 'other-role' | 'not-regular' | 'unverifiable';
     };

/**
 * Read a target that is about to be written, under the write rule itself: the
 * shape every "look at what is there, then act on it" command needs, so none of
 * them re-composes it.
 *
 * The ORIGINAL directory entry decides the kind first — a socket, a FIFO, a device
 * node or a directory standing at the target is refused rather than opened, and a
 * symlink is settled on what it resolves TO, because the open would follow it.
 * Then {@link openVerifiedSource} judges the RESOLVED path against
 * {@link writableTarget} for this role and proves the descriptor is that same
 * regular file, so the bytes come back from the inode the rule cleared.
 *
 * `absent` is decided on the original entry, never on where it resolves: a dangling
 * symlink resolves to a missing destination while the link itself is still standing,
 * and a standing entry this run could not verify is `refused/unverifiable`, never a
 * write through it. Operational I/O failures on an allowed path PROPAGATE, as a read
 * by path always has; only containment, entry kind, and verification become refusals.
 */
export function verifiedTargetRead(rootAbs: string, targetAbs: string, ownRoleRel: string | null): VerifiedTargetRead {
   const entry = fs.lstatSync(targetAbs, { throwIfNoEntry: false });
   if (entry !== undefined && !entry.isFile() && !entry.isSymbolicLink()) {
      return { status: 'refused', real: resolvedPath(targetAbs), reason: 'not-regular' };
   }
   if (entry?.isSymbolicLink()) {
      const followed = fs.statSync(targetAbs, { throwIfNoEntry: false });
      if (followed !== undefined && !followed.isFile()) {
         return { status: 'refused', real: resolvedPath(targetAbs), reason: 'not-regular' };
      }
   }
   let refusal: 'outside-root' | 'other-role' | null = null;
   const { fd, real } = openVerifiedSource(targetAbs, (resolved) => {
      // The same rule the write will be judged by, the declared exception included:
      // the read-then-act pair must agree, or the one target that belongs to no role
      // could be read here and refused at the write (or the reverse).
      const verdict =
         metadataFileVerdict(rootAbs, targetAbs, resolved, ownRoleRel) ?? writableTarget(rootAbs, resolved, ownRoleRel);
      if (verdict.ok) return true;
      refusal = verdict.outsideRoot === true ? 'outside-root' : 'other-role';
      return false;
   });
   if (fd !== null && real !== null) {
      try {
         return { status: 'regular', real, bytes: fs.readFileSync(fd) };
      } finally {
         fs.closeSync(fd);
      }
   }
   if (refusal !== null) return { status: 'refused', real, reason: refusal };
   if (real === null) return { status: 'refused', real: null, reason: 'unverifiable' };
   // Nothing verified was opened, and only ONE thing may follow from that: the
   // target is absent. Anything still standing there is a refusal.
   return fs.lstatSync(targetAbs, { throwIfNoEntry: false }) === undefined
      ? { status: 'absent', real }
      : { status: 'refused', real, reason: 'unverifiable' };
}

/**
 * Recursively collect markdown files under a declared path (file or directory) as
 * repo-root-relative POSIX paths, sorted. Symlink-escaping entries are excluded.
 */
export function walkMd(root: string, relPath: string): string[] {
   const rootAbs = path.resolve(root);
   const abs = path.join(root, relPath);
   if (isFile(abs)) {
      return relPath.endsWith('.md') && resolvedWithinRoot(rootAbs, abs) ? [toPosix(relPath)] : [];
   }
   if (!isDir(abs)) return [];
   const out: string[] = [];
   const stack: string[] = [abs];
   while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
         if (entry.name.startsWith('.')) continue;
         const full = path.join(dir, entry.name);
         if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            if (!resolvedWithinRoot(rootAbs, full)) continue;
            stack.push(full);
         } else if (entry.isFile() && entry.name.endsWith('.md')) {
            if (!resolvedWithinRoot(rootAbs, full)) continue;
            out.push(toPosix(path.relative(root, full)));
         }
      }
   }
   return out.sort();
}

/**
 * All markdown files under a context path, repo-relative POSIX, sorted. Used by
 * the viewer sidebar; shares walkMd's dotfile/node_modules skip and symlink
 * containment, so the `.leji` viewer dir is never traversed.
 */
export function walkTree(root: string, relPath: string): string[] {
   return walkMd(root, relPath);
}

/** Normalize a declared directory path for prefix comparison: no trailing slash. */
export function stripSlash(p: string): string {
   return p.endsWith('/') ? p.slice(0, -1) : p;
}

/**
 * Join a sub-path under a context root with POSIX semantics, treating `.` or
 * empty root as the repo root: `joinUnderRoot('.', 'context/')` is `context/`,
 * never the hidden `.context/` a bare concatenation would produce.
 */
export function joinUnderRoot(rootPath: string, sub: string): string {
   const base = stripSlash(rootPath);
   return base === '' || base === '.' ? sub : `${base}/${sub}`;
}

/** True when relPath is the declared path itself or falls under it (POSIX). */
export function underPath(relPath: string, declared: string): boolean {
   const base = stripSlash(declared);
   if (base === '' || base === '.') return true; // root: everything is under it
   return relPath === base || relPath.startsWith(base + '/');
}
