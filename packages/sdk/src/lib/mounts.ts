import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, guardRoot, isDir, isFile, mkdirpGuarded, readTextWithin } from './fsx.js';
import { MOUNTS_REL } from './layout.js';
import { type LejiIgnoreContext, ensureLejiIgnoreFile, newLejiIgnoreContext } from './leji-ignore.js';
import { type Manifest, allStringsScalar } from './manifest.js';
import { schemaErrors } from './schemas.js';
import { byteCompare } from './text.js';

/**
 * The federation resolver: materializes a mount's pinned layer projection into
 * the gitignored cache under `.leji/mounts/` (distribution.md pattern 3).
 *
 * Contracts (per the resolver-only mounts design):
 * - The pin is resolved from a git object store, never a working tree.
 * - the projection extracts the sibling's leji.json, its rootPath tree, and its
 *   agent-profiles path if outside rootPath; nothing else. Gitlinks are recorded
 *   in metadata, never materialized; LFS pointers extract as the pointers they are.
 * - Caches are keyed by sha256(source identity \n pin \n cache format version) and
 *   published by rename-if-absent under a `complete` marker; no global lock.
 * - The sidecar is evidence, never proof: verification reads the object store.
 * - No network unless the caller passes fetch: true (git fetch into the
 *   resolver-managed store); everything else is offline.
 * - The witness namespace is the resolver's own: `hydrate --fetch` writes
 *   refs/leji-witness/v1/ in the managed store and nothing else does, so pin
 *   ancestry has a ref to compare against without `status` ever fetching.
 */

/** The single cache-invalidation epoch: bump it and every key changes.
 * "2": the projection closure (boot profile, machine artifacts, category indexes,
 * bound agent profiles, indexed governed paths) replaced the root-tree-only
 * extraction; entries under "1" hold incomplete projections for the same pin. */
export const CACHE_FORMAT_VERSION = '2';

/** The resolver-owned witness namespace in the managed store. */
export const WITNESS_REF_NAMESPACE = 'refs/leji-witness';

/** The resolver-owned pin namespace: what keeps the version of record from being pruned. */
export const PIN_REF_NAMESPACE = 'refs/leji-pin';

/** Normative projection limits, identical across SDKs. */
export const MAX_PROJECTION_FILES = 65536;
export const MAX_PROJECTION_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_PROJECTION_PATH = 4096;

/**
 * What one whole-tree listing may occupy in transport.
 *
 * This bounds tree *metadata* — one mode/type/oid/path record per entry in the
 * pinned commit — not projected content, which is what MAX_PROJECTION_BYTES caps.
 * The two are deliberately different numbers: the listing enumerates the entire
 * repository so that selection can happen in-process, so capping it at the
 * content limit would fail a large repository that holds a perfectly small valid
 * projection. At the normative 65,536-file limit this leaves about 4 KiB per
 * entry, against a path limit of MAX_PROJECTION_PATH and roughly 60 bytes of
 * fixed record overhead.
 */
export const MAX_TREE_LISTING_BYTES = 256 * 1024 * 1024;

export interface MountDecl {
   name: string;
   source: string;
   pin: string;
   trackingRef?: string;
}

/**
 * Why a projection failed, tagged where the failure is created and carried
 * outward unchanged. `unavailable` is degraded knowledge of the pinned layer (the
 * declaration is sound; the pin's content is missing or malformed), `safety` is a
 * guard the projection refuses to cross. Nothing downstream re-derives the class
 * from the detail text: a stable sentence is output, never a classifier.
 */
export type ProjectionFailureKind = 'unavailable' | 'safety';

/** Purely derived state: every field is recomputable from the manifest and the
 * cache, so last-writer-wins is correct by construction. */
export interface HydrateOutcome {
   name: string;
   status: 'hydrated' | 'cached' | 'unavailable' | 'error';
   detail?: string;
   cacheKey?: string;
   objectSource?: string;
   /** Present when `--fetch` was requested: did the managed store get established? */
   storeFetched?: boolean;
   /** Present only when this run attempted the witness refresh and it did not
    * publish. The run reporting on itself, never a remembered observation: nothing
    * about it is recorded, and a later `status` neither reads nor reports it. */
   witnessRefreshFailed?: boolean;
   /** Present when the projection itself decided this outcome, which separates an
    * `unavailable` mount whose pinned layer would not project from one no reachable
    * object store holds. */
   projectionFailed?: boolean;
}

export interface LocateResult {
   name: string;
   sourceIdentity: string | null;
   pin: string | null;
   present: boolean;
   verified: boolean;
   path: string | null;
   detail?: string;
}

export interface StatusResult {
   name: string;
   sourceIdentity: string | null;
   pin: string;
   trackingRef: string | null;
   present: boolean;
   verified: boolean | null;
   pinReport: {
      state: 'behind' | 'ahead' | 'diverged' | 'unrelated' | 'up-to-date' | 'unknown';
      /** Omitted, never null, when a count was not computed. */
      behind?: number;
      ahead?: number;
      comparedRef: string | null;
      /** Which repository the pin and the witness were both read from. */
      comparisonRepository: 'managed-store' | 'hint' | 'submodule' | null;
      /** `managed`: the resolver's own witness ref; `unmanaged`: a ref the tool does not own. */
      witnessProvenance: 'managed' | 'unmanaged' | null;
      /** Commit-ancestry completeness only: unshallow history and both counts
       * computed. Never a claim that the remote was observed. */
      ancestryComplete: boolean;
      /** Stable code, present only when the report is degraded. */
      reason?: string;
      observedAt: string;
   };
}

/**
 * Normalize a repository locator to its canonical identity: https://, ssh://, or
 * SCP-style (git@host:path, rewritten to ssh://git@host/path). Lowercases scheme
 * and host, strips userinfo except the ssh user, strips one trailing "/" and one
 * trailing ".git". Returns null for anything else (local paths belong in hints).
 */
export function normalizeSource(raw: string): string | null {
   let s = raw.trim();
   if (s === '') return null;
   // SCP-style: user@host:path (no scheme, single colon before the path).
   const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(s);
   if (scp) s = `ssh://${scp[1]}@${scp[2]}/${scp[3]}`;
   const m = /^(https|ssh):\/\/(?:([^@/]+)@)?([A-Za-z0-9.-]+)(?::(\d+))?\/(.*)$/.exec(s);
   if (!m) return null;
   const scheme = m[1].toLowerCase();
   const user = m[2];
   const host = m[3].toLowerCase();
   const port = m[4] ? `:${m[4]}` : '';
   let p = m[5];
   if (p.endsWith('/')) p = p.slice(0, -1);
   if (p.endsWith('.git')) p = p.slice(0, -4);
   if (p === '' || p.includes('\\')) return null;
   // Userinfo is stripped except the ssh user; credentials never enter identities.
   const userPart = scheme === 'ssh' && user ? `${user.split(':')[0]}@` : '';
   return `${scheme}://${userPart}${host}${port}/${p}`;
}

export function sha256Hex(input: string | Buffer): string {
   return crypto.createHash('sha256').update(input).digest('hex');
}

export function cacheKeyFor(sourceIdentity: string, pin: string): string {
   return sha256Hex(`${sourceIdentity}\n${pin}\n${CACHE_FORMAT_VERSION}`);
}

export function mountsDir(root: string): string {
   return path.join(root, MOUNTS_REL);
}

/**
 * Establish one mounts DESTINATION — a managed store, a cache entry, a staging
 * directory — through the write chokepoint, and hand back the RESOLVED directory it
 * was created at. Null when the rule refuses it: a planted `.leji/mounts` symlink
 * into another role or out of the repository is caught here, once, instead of being
 * followed by every per-entry write underneath.
 *
 * The per-entry protocol below (hashed identities, contained relative paths, the
 * symlink-escape rules, publish-by-rename) is the declared exception to the
 * chokepoint, and it holds only because every one of its acts happens under a root
 * this function checked and returned — never under a path re-joined from `root`.
 */
function establishMountsDir(root: string, dirAbs: string, ignoreContext?: LejiIgnoreContext): string | null {
   const established = mkdirpGuarded(guardRoot(root), dirAbs, MOUNTS_REL);
   if (!established.ok) return null;
   // A role under `.leji/` now exists, so the tool's own ignore file is ensured here
   // as it is at every other establisher. A refusal is this destination refusing:
   // the caller reports it as it reports any destination it could not establish.
   if (ensureLejiIgnoreFile(root, ignoreContext) === 'refused') return null;
   return established.real;
}

/** Machine-local resolution hints (never committed): .leji/mounts.local.json. */
export function readHints(root: string): Record<string, string> {
   const raw = readTextWithin(path.resolve(root), path.join(root, '.leji', 'mounts.local.json'));
   if (raw === null) return {};
   try {
      const parsed = JSON.parse(raw) as { mounts?: Record<string, { repo?: unknown }> };
      const out: Record<string, string> = {};
      for (const [name, entry] of Object.entries(parsed.mounts ?? {})) {
         if (entry && typeof entry.repo === 'string' && entry.repo !== '') out[name] = entry.repo;
      }
      return out;
   } catch {
      return {};
   }
}

/** Run git with a fixed, non-interactive environment; argv-array only, never a shell. */
export function runGit(
   args: string[],
   opts: { cwd?: string; maxBuffer?: number } = {},
): {
   ok: boolean;
   stdout: Buffer;
   /** git's exit status: callers that read an answer out of it (merge-base) must
    * separate the answer's exit codes from operational failure. */
   code: number | null;
   error?: string;
   /** The output did not fit `maxBuffer`. Tagged here, where the errno is still
    * available, so no caller has to recognize a transport failure by its message. */
   overflowed?: boolean;
} {
   try {
      const stdout = execFileSync('git', ['--no-replace-objects', ...args], {
         cwd: opts.cwd,
         env: {
            ...process.env,
            LC_ALL: 'C',
            GIT_PAGER: 'cat',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            // A promisor clone used as a hint or submodule would otherwise reach the
            // network from commands documented as offline.
            GIT_NO_LAZY_FETCH: '1',
         },
         maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
         stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), code: 0 };
   } catch (e) {
      const err = e as { stderr?: Buffer; message?: string; status?: number | null; code?: string };
      const stderr = err.stderr ? err.stderr.toString('utf8').trim() : '';
      return {
         ok: false,
         stdout: Buffer.alloc(0),
         code: typeof err.status === 'number' ? err.status : null,
         error: stderr || err.message || 'git failed',
         // Node reports an exceeded maxBuffer as ENOBUFS with no exit status.
         ...(err.code === 'ENOBUFS' ? { overflowed: true } : {}),
      };
   }
}

function isGitRepo(dir: string): boolean {
   if (!isDir(dir)) return false;
   return runGit(['-C', dir, 'rev-parse', '--git-dir'], {}).ok;
}

function hasCommit(repo: string, pin: string): boolean {
   return runGit(['-C', repo, 'cat-file', '-e', `${pin}^{commit}`]).ok;
}

/** Resolve a revision to a commit id in `repo`; null when it does not resolve. */
export function revOid(repo: string, rev: string): string | null {
   const r = runGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
   return r.ok ? r.stdout.toString('utf8').trim() : null;
}

/** The resolver-managed bare store for a source identity. */
function storeDir(root: string, sourceIdentity: string): string {
   return path.join(mountsDir(root), 'store', sha256Hex(sourceIdentity));
}

/**
 * A declared witness ref is a fully qualified branch or tag that `git
 * check-ref-format` would accept: no control characters, whitespace, glob or
 * revision metacharacters, no `..`, `@{`, empty or dot-leading component,
 * `.lock` suffix, or trailing `/` or `.`.
 */
export function validTrackingRef(ref: string): boolean {
   if (!/^refs\/(heads|tags)\//.test(ref)) return false;
   // Control characters, space, and the glob and revision metacharacters git forbids.
   if (/[\u0000-\u0020\u007F~^:?*[\\]/.test(ref)) return false;
   if (ref.includes('..') || ref.includes('@{')) return false;
   if (ref.endsWith('/') || ref.endsWith('.')) return false;
   const components = ref.split('/');
   if (components.length < 3) return false;
   return components.every((c) => c !== '' && !c.startsWith('.') && !c.endsWith('.lock'));
}

/**
 * The managed witness ref for a source and its tracking ref:
 * refs/leji-witness/v1/<sha256(identity)>/<sha256(trackingRef)>. Both components
 * are fixed-length lowercase hex, so no declaration can outgrow a filesystem's
 * per-component limit and no case-insensitive filesystem folds two onto one.
 */
export function witnessRefFor(sourceIdentity: string, trackingRef: string): string {
   return `${WITNESS_REF_NAMESPACE}/v1/${sha256Hex(sourceIdentity)}/${sha256Hex(trackingRef)}`;
}

/**
 * The ref that retains a pin in the managed store: refs/leji-pin/v1/<source-key>/<oid>.
 * A fetch leaves the pin reachable only through FETCH_HEAD, which the witness fetch
 * then overwrites — without this ref, git maintenance may prune the version of record.
 */
export function pinRefFor(sourceIdentity: string, pinOid: string): string {
   return `${PIN_REF_NAMESPACE}/v1/${sha256Hex(sourceIdentity)}/${pinOid}`;
}

/** Discover host submodules whose .gitmodules URL normalizes to the identity. */
function submoduleCandidates(root: string, sourceIdentity: string): string[] {
   const raw = readTextWithin(path.resolve(root), path.join(root, '.gitmodules'));
   if (raw === null) return [];
   const out: string[] = [];
   let currentPath: string | null = null;
   for (const line of raw.split('\n')) {
      const sec = /^\s*\[submodule\s+"(.+)"\]\s*$/.exec(line);
      if (sec) currentPath = null;
      const pm = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
      if (pm) currentPath = pm[1];
      const um = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (um && currentPath) {
         const ident = normalizeSource(um[1]);
         if (ident !== null && ident === sourceIdentity) out.push(path.join(root, currentPath));
      }
   }
   return out.filter((p) => isGitRepo(p));
}

export type ObjectSourceKind = 'hint' | 'store' | 'submodule';

/**
 * Every object source holding the pin, in the deterministic offline precedence:
 * explicit hint, then the resolver-managed store, then a unique matching
 * submodule. Ambiguous submodule matches are reported, never ordered around: the
 * flag is about the submodules alone, because a caller that walks past the other
 * candidates ends up with repositories it never consulted either way.
 * Callers needing a second operand (a witness ref) walk the list; callers needing
 * only the pin take the first.
 */
export function objectSourceCandidates(
   root: string,
   mount: MountDecl,
   sourceIdentity: string,
): { candidates: { repo: string; kind: ObjectSourceKind }[]; ambiguous: boolean } {
   const candidates: { repo: string; kind: ObjectSourceKind }[] = [];
   const hint = readHints(root)[mount.name];
   if (hint) {
      const abs = path.isAbsolute(hint) ? hint : path.join(root, hint);
      if (isGitRepo(abs) && hasCommit(abs, mount.pin)) candidates.push({ repo: abs, kind: 'hint' });
   }
   const store = storeDir(root, sourceIdentity);
   if (isGitRepo(store) && hasCommit(store, mount.pin)) candidates.push({ repo: store, kind: 'store' });
   const subs = submoduleCandidates(root, sourceIdentity);
   if (subs.length === 1 && hasCommit(subs[0], mount.pin)) candidates.push({ repo: subs[0], kind: 'submodule' });
   return { candidates, ambiguous: subs.length > 1 };
}

/** The first object source holding the pin: what hydration projects from. */
export function findObjectSource(
   root: string,
   mount: MountDecl,
   sourceIdentity: string,
): { repo: string | null; kind: ObjectSourceKind | null; ambiguous?: boolean } {
   const { candidates, ambiguous } = objectSourceCandidates(root, mount, sourceIdentity);
   if (candidates.length > 0) return { repo: candidates[0].repo, kind: candidates[0].kind };
   return { repo: null, kind: null, ...(ambiguous ? { ambiguous: true } : {}) };
}

/**
 * Establish the managed store and retain ONE commit in it: fetch the object by id
 * from the declared source when the store does not already hold it, then keep it
 * reachable under `refs/leji-pin/v1/`. Nothing here refreshes a witness, so a
 * caller that needs more than one commit retained pays exactly one round trip per
 * commit and no extra observation of a moving ref.
 *
 * The declared pin and an explicitly named target are both retained through this,
 * so the version of record and the version being moved to are equally safe from
 * git maintenance.
 */
/**
 * Test-only fault injection for {@link retainPinInStore}: with
 * LEJI_TEST_FAIL_PIN_REF set to a commit id, retaining exactly that commit fails at
 * the ref. It exists because the TARGET-retention refusal has no other reachable
 * path — by the time the target is retained, the comparison repository IS the
 * managed store and already holds the commit, so the fetch never runs and only the
 * ref update can fail.
 */
function retentionInjectedFailure(oid: string): boolean {
   return process.env.LEJI_TEST_FAIL_PIN_REF === oid;
}

export function retainPinInStore(
   root: string,
   mount: MountDecl,
   sourceIdentity: string,
   oid: string,
   ignoreContext?: LejiIgnoreContext,
): { repo: string | null; error?: string } {
   // Details are stable, Leji-authored text: git stderr never reaches output.
   const failed = (error: string) => ({ repo: null, error });
   // The locator becomes argv here: anything option-shaped is refused, never passed.
   if (mount.source.startsWith('-')) return failed('the source locator may not begin with "-"');
   const store = establishMountsDir(root, storeDir(root, sourceIdentity), ignoreContext);
   if (store === null) return failed('the managed store could not be initialized');
   if (!isGitRepo(store)) {
      if (!runGit(['init', '--bare', '-q', store]).ok) return failed('the managed store could not be initialized');
   }
   // A commit id is immutable: a store that already holds it needs no round trip.
   // The id is resolved directly, never read back out of FETCH_HEAD, so the fetch
   // has no reason to write one and races with a concurrent fetch.
   if (!hasCommit(store, oid)) {
      const spec = [
         '-C',
         store,
         '-c',
         'fetch.recurseSubmodules=no',
         'fetch',
         '-q',
         '--no-write-fetch-head',
         mount.source,
         oid,
      ];
      if (!runGit(spec).ok) return failed('the pin could not be fetched from the source');
   }
   // Retain it by a ref of our own: without it, git maintenance may prune the
   // version of record.
   const pinOid = revOid(store, oid);
   if (pinOid === null) return failed('fetched, but the pin is not reachable');
   if (
      retentionInjectedFailure(pinOid) ||
      !runGit(['-C', store, 'update-ref', pinRefFor(sourceIdentity, pinOid), pinOid]).ok
   ) {
      return failed('the pin could not be retained by a ref in the managed store');
   }
   return { repo: store };
}

/**
 * Fetch the pin and refresh the managed witness ref in the store. This is the
 * only writer of the witness namespace: `status` never fetches, so a mount whose
 * pin a hint already resolves still needs its store populated here.
 */
export function fetchIntoStore(
   root: string,
   mount: MountDecl,
   sourceIdentity: string,
   ignoreContext?: LejiIgnoreContext,
): { repo: string | null; witnessRefreshFailed?: boolean; error?: string; witnessError?: string } {
   const retained = retainPinInStore(root, mount, sourceIdentity, mount.pin, ignoreContext);
   if (retained.repo === null) return retained;
   const store = retained.repo;
   // The witness refresh is the second half of what `--fetch` was asked to do, so a
   // run that attempts it and does not publish says so on its own terms. Reported
   // only when it was actually attempted: a run that never got this far has already
   // reported the fetch failure that stopped it.
   if (mount.trackingRef !== undefined && validTrackingRef(mount.trackingRef)) {
      // The witness reason travels beside the flag, never in `error`: that one is
      // the store's own failure, and a mount whose store WAS established must not
      // start reporting the witness reason as the reason nothing holds its pin.
      const refreshed = refreshWitness(store, mount, sourceIdentity);
      if (!refreshed.ok) return { repo: store, witnessRefreshFailed: true, witnessError: refreshed.error };
   }
   return { repo: store };
}

/** The raw object a ref points at, unpeeled; null when the ref does not exist. */
export function refOid(repo: string, ref: string): string | null {
   const r = runGit(['-C', repo, 'rev-parse', '--verify', '--quiet', ref]);
   return r.ok ? r.stdout.toString('utf8').trim() : null;
}

/**
 * Refresh the managed witness ref: fetch the tracking ref to a unique temporary
 * ref, publish it onto the canonical witness with git's own compare-and-swap,
 * then drop the temporary. Forced (`+`), so the witness follows a non-fast-forward
 * upstream move. No lock: git's ref update is atomic, a lost swap means another
 * writer published first (a valid outcome), and a failure leaves the previous
 * witness in place.
 *
 * A refusal names which half did not happen, in stable Leji-authored text: the
 * caller reports the witness act, and the act alone says nothing about why.
 */
export function refreshWitness(
   store: string,
   mount: MountDecl,
   sourceIdentity: string,
): { ok: boolean; error?: string } {
   const witnessRef = witnessRefFor(sourceIdentity, mount.trackingRef!);
   const tempRef = `${WITNESS_REF_NAMESPACE}/tmp/${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
   const spec = `+${mount.trackingRef}:${tempRef}`;
   // `--no-write-fetch-head` for the same reason retention passes it: the ref this
   // fetch cares about is the temporary one in the refspec, and a FETCH_HEAD left
   // behind is a per-run path recorded inside the managed store.
   const fetch = runGit([
      '-C',
      store,
      '-c',
      'fetch.recurseSubmodules=no',
      'fetch',
      '-q',
      '--no-write-fetch-head',
      mount.source,
      spec,
   ]);
   const tip = fetch.ok ? refOid(store, tempRef) : null;
   // An empty <oldvalue> is git's "must not exist yet".
   const expected = refOid(store, witnessRef) ?? '';
   let published = false;
   if (tip !== null) {
      const cas = runGit(['-C', store, 'update-ref', witnessRef, tip, expected]);
      if (cas.ok) {
         published = true;
      } else {
         // A lost compare-and-swap is only a confirmed mismatch on <oldvalue>: another
         // writer published while we fetched, which is a valid outcome. Permission,
         // malformed-ref, lock and disk failures are not lost races, so the ref itself
         // decides — a valid witness present means someone published, anything else is
         // an operational failure that must not read as success.
         published = refOid(store, witnessRef) !== null && refOid(store, witnessRef) !== expected;
      }
   }
   // Cleanup is not part of the outcome: the canonical ref has already moved, and a
   // surviving temporary is inert (nothing reads the tmp namespace as a witness).
   runGit(['-C', store, 'update-ref', '-d', tempRef]);
   if (published) return { ok: true };
   // Two failure classes, and no third: the tracking ref never arrived, or it
   // arrived and the canonical ref would not take it.
   return {
      ok: false,
      error:
         tip === null
            ? 'the tracking ref could not be fetched from the source'
            : 'the witness ref could not be published',
   };
}

interface TreeEntry {
   mode: string;
   type: string;
   oid: string;
   relPath: string;
}

/**
 * Every entry in the pinned tree, enumerated once and selected from in-process.
 *
 * Deliberately no pathspec: a declared path is a *name*, and git would read it as
 * a glob, so a governed file called `a[b].md` selects `ab.md` and reports itself
 * missing. One argv per indexed path also reaches ARG_MAX long before the
 * file-count limit does. Both hazards are structural, and both disappear when the
 * only thing git is asked for is the tree.
 *
 * Because the enumeration is the whole repository, nothing here may fail on an
 * entry the projection does not select. A path with no UTF-8 form is therefore
 * routed by `selectsRawPath` before it is judged: inside the projection it is the
 * safety failure it has always been, outside it is another repository's business.
 */
function listTree(
   repo: string,
   pin: string,
   selectsRawPath: (raw: Buffer) => boolean,
): { entries: TreeEntry[]; error?: string; kind?: ProjectionFailureKind } {
   const args = ['-C', repo, 'ls-tree', '-r', '-z', '--full-tree', pin];
   const r = runGit(args, { maxBuffer: MAX_TREE_LISTING_BYTES });
   if (!r.ok) {
      // Transport, not content: the listing did not fit, so nothing can be said
      // about the projection either way.
      if (r.overflowed) {
         return { entries: [], error: 'the pinned tree listing exceeds the transport limit', kind: 'safety' };
      }
      return { entries: [], error: 'the pinned tree could not be listed', kind: 'safety' };
   }
   const entries: TreeEntry[] = [];
   for (const chunk of r.stdout.toString('binary').split('\0')) {
      if (chunk === '') continue;
      const tab = chunk.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, oid] = chunk.slice(0, tab).split(' ');
      const rawPath = Buffer.from(chunk.slice(tab + 1), 'binary');
      const utf8 = rawPath.toString('utf8');
      if (Buffer.from(utf8, 'utf8').compare(rawPath) !== 0) {
         // The routing decision needs no decode: the selections compare as bytes.
         if (!selectsRawPath(rawPath)) continue;
         return { entries: [], error: `non-UTF-8 path in the pinned tree: ${utf8}`, kind: 'safety' };
      }
      entries.push({ mode, type, oid, relPath: utf8 });
   }
   return { entries };
}

function catBlob(repo: string, oid: string): Buffer | null {
   const r = runGit(['-C', repo, 'cat-file', 'blob', oid], { maxBuffer: MAX_PROJECTION_BYTES });
   return r.ok ? r.stdout : null;
}

function containedRelPath(p: string): boolean {
   // UTF-8 bytes, which is the unit the limit is declared in and the only one the
   // three SDKs can agree on: `p.length` is UTF-16 code units here, code points in
   // Python and bytes in Go, so one constant was three different thresholds and a
   // path of astral characters crossed them at three different lengths.
   if (p === '' || Buffer.byteLength(p, 'utf8') > MAX_PROJECTION_PATH) return false;
   if (p.startsWith('/') || p.includes('\\')) return false;
   const segs = p.split('/');
   return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * A parsed JSON value that may be dereferenced as a mapping. Pinned content is
 * untrusted and only has to be valid JSON to get this far, so every property
 * access on it clears this first: `null` is `typeof "object"` in JavaScript and an
 * array is not a mapping, and either one reaching a dereference throws where the
 * closure owes its caller a tagged failure instead.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
   return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalize a manifest-declared directory path ("docs/", "./docs") to a prefix. */
function declaredDir(p: string): string | null {
   let s = p.trim();
   if (s.startsWith('./')) s = s.slice(2);
   while (s.endsWith('/')) s = s.slice(0, -1);
   if (s === '' || s === '.') return '';
   return containedRelPath(s) ? s : null;
}

export interface ProjectionResult {
   ok: boolean;
   error?: string;
   /** Set with `error`, never without it. */
   kind?: ProjectionFailureKind;
   commit?: string;
   tree?: string;
   files?: number;
   bytes?: number;
   gitlinks?: { path: string; oid: string }[];
   siblingName?: string;
}

/** Normalize a manifest-declared file path ("./docs/x.md") for use as a selection. */
function declaredFile(p: string): string | null {
   let s = p.trim();
   if (s.startsWith('./')) s = s.slice(2);
   return containedRelPath(s) ? s : null;
}

interface ClosureResult {
   ok: boolean;
   error?: string;
   /** Set with `error`, never without it. */
   kind?: ProjectionFailureKind;
   commit?: string;
   tree?: string;
   siblingName?: string;
   /** Directory prefixes ('.' = whole tree) — the symlink-containment set. */
   prefixes?: Set<string>;
   /** Blob entries to materialize, deduplicated, path-validated. */
   writes?: { relPath: string; oid: string; mode: number }[];
   symlinks?: { relPath: string; target: string }[];
   gitlinks?: { path: string; oid: string }[];
}

/**
 * Compute the layer-projection closure at a pinned commit: the deduplicated union of
 * the root manifest, the rootPath tree, the boot profile, the machine artifacts when
 * present, the profiles/decisions trees when present, every bound agent profile,
 * every category index, and every governed path in the pinned generated index. The
 * sibling's own manifest at the pin defines the projection; the host never curates it.
 *
 * The failure boundary: a referenced or schema-required file absent from the pinned
 * tree fails the closure with a code naming the declaring artifact and the missing
 * path; an absent directory or an absent defaulted machine artifact contributes
 * nothing (git cannot represent an empty directory; a core layer has no index).
 * Everything runs against the object store only — no working tree, no network.
 *
 * Every failure is tagged with its class where it is created, so the caller decides
 * unavailability from provenance rather than from the sentence it is about to print.
 */
function computeClosure(repo: string, pin: string): ClosureResult {
   const unavailable = (error: string): ClosureResult => ({ ok: false, error, kind: 'unavailable' });
   const unsafe = (error: string): ClosureResult => ({ ok: false, error, kind: 'safety' });

   const commitR = runGit(['-C', repo, 'rev-parse', `${pin}^{commit}`]);
   if (!commitR.ok) return unavailable('pin does not resolve to a commit');
   const commit = commitR.stdout.toString('utf8').trim();
   const treeR = runGit(['-C', repo, 'rev-parse', `${pin}^{tree}`]);
   const tree = treeR.ok ? treeR.stdout.toString('utf8').trim() : '';

   const manifestRaw = runGit(['-C', repo, 'cat-file', 'blob', `${commit}:leji.json`]);
   if (!manifestRaw.ok) return unavailable('the pinned tree has no leji.json at its root');
   let parsedManifest: unknown;
   try {
      parsedManifest = JSON.parse(manifestRaw.stdout.toString('utf8'));
   } catch {
      return unavailable('the pinned leji.json is not valid JSON');
   }
   // A sibling manifest is untrusted input like any other: its strings reach hashing,
   // sorting and path construction, so they clear the same scalar gate as the host's.
   // The gate runs before the shape guard, so a malformed string is reported as the
   // safety failure it is whatever shape carried it.
   if (!allStringsScalar(parsedManifest)) {
      return unsafe('the pinned leji.json contains a malformed string');
   }
   if (!isRecord(parsedManifest)) {
      return unavailable('the pinned leji.json is not an object');
   }
   // A mapping, which is all the guard proves: every field below is still checked
   // for its own type before it is used.
   const sibling = parsedManifest as unknown as Manifest;
   if (typeof sibling.rootPath !== 'string') {
      return unavailable('the pinned leji.json declares no rootPath');
   }
   const rootPrefix = declaredDir(sibling.rootPath);
   if (rootPrefix === null) return unsafe(`uncontained rootPath: ${sibling.rootPath}`);

   // Every mapping the closure is about to walk, checked once here rather than at
   // each property access. Absent is normal and contributes nothing; present but
   // not a mapping is an ordinary sibling-shape defect, so it is unavailability.
   if (sibling.machine !== undefined && !isRecord(sibling.machine)) {
      return unavailable('the pinned leji.json has no machine object');
   }
   // One level down, because the declared type is a claim about the host's own
   // manifest and says nothing about pinned bytes. A present non-string here either
   // throws in the path helpers or reads as absent and silently defaults, and a
   // default is not what the sibling declared. Undefined is absent, which is normal.
   for (const field of ['indexPath', 'changelogPath', 'agentProfilesPath', 'decisionRecordsPath'] as const) {
      const declared: unknown = sibling.machine?.[field];
      if (declared !== undefined && typeof declared !== 'string') {
         return unavailable(`the pinned leji.json machine.${field} is not a string`);
      }
   }
   if (sibling.categories !== undefined && !isRecord(sibling.categories)) {
      return unavailable('the pinned leji.json has no categories object');
   }
   if (sibling.agents !== undefined && !isRecord(sibling.agents)) {
      return unavailable('the pinned leji.json has no agents object');
   }

   // Directory selections. Absence contributes nothing: a selection matching no
   // entry is an empty contribution, never a failure.
   const prefixes = new Set<string>();
   prefixes.add(rootPrefix === '' ? '.' : rootPrefix);
   const dirSelections = (raw: string | undefined, what: string): string | ClosureResult => {
      if (typeof raw !== 'string') return '';
      const d = declaredDir(raw);
      if (d === null) return unsafe(`uncontained ${what}: ${raw}`);
      return d;
   };
   for (const [raw, what] of [
      [sibling.machine?.agentProfilesPath, 'agentProfilesPath'],
      [sibling.machine?.decisionRecordsPath, 'decisionRecordsPath'],
   ] as [string | undefined, string][]) {
      const d = dirSelections(raw, what);
      if (typeof d !== 'string') return d;
      if (d !== '' && rootPrefix !== '' && !(d === rootPrefix || d.startsWith(rootPrefix + '/'))) {
         prefixes.add(d);
      }
   }

   // File selections. `critical` maps each required path to its declaring artifact;
   // `optional` files are included when present at the pin and owe nothing absent.
   const critical = new Map<string, string>();
   const optional = new Set<string>();
   const addCritical = (raw: unknown, declaring: string): ClosureResult | null => {
      if (typeof raw !== 'string') return unavailable(`the pinned leji.json declares no ${declaring}`);
      const f = declaredFile(raw);
      if (f === null) return unsafe(`uncontained ${declaring}: ${raw}`);
      if (!critical.has(f)) critical.set(f, declaring);
      return null;
   };
   {
      const err = addCritical(sibling.bootProfilePath, 'bootProfilePath');
      if (err !== null) return err;
   }
   for (const [id, cat] of Object.entries(sibling.categories ?? {})) {
      if (!isRecord(cat)) return unavailable(`the pinned leji.json categories.${id} is not an object`);
      const indexes = cat.indexes;
      if (indexes === undefined) continue;
      if (!Array.isArray(indexes)) return unavailable(`the pinned leji.json categories.${id} has no indexes array`);
      for (const idx of indexes) {
         const err = addCritical(idx, `categories.${id} index`);
         if (err !== null) return err;
      }
   }
   for (const [role, rel] of Object.entries(sibling.agents ?? {})) {
      const err = addCritical(rel, `agents.${role} profile`);
      if (err !== null) return err;
   }
   // Machine artifacts: included when present, whether their effective path was
   // declared or defaulted — presence is the criterion, declaration is not.
   const machineFiles: string[] = [];
   for (const raw of [
      sibling.machine?.indexPath ?? joinPosix(rootPrefix, 'context-index.json'),
      sibling.machine?.changelogPath ?? joinPosix(rootPrefix, 'context-changelog.json'),
   ]) {
      const f = declaredFile(raw);
      if (f === null) return unsafe(`uncontained machine path: ${raw}`);
      optional.add(f);
      machineFiles.push(f);
   }

   // The canonical schema, not a hand-rolled restatement of it. Each pinned artifact
   // clears its own pointed guards first, because those name the exact field and read
   // better than "does not validate"; the schema is the backstop for what a guard
   // cannot see, a field the schema requires and the closure never dereferences
   // (`leji`, `name`, `owners`, and a `categories` map that is absent rather than
   // misshapen). A pinned artifact missing one is malformed pinned content, which
   // distribution.md classes as availability. Every detail here is stable Leji text,
   // never the validator's error list: three validators phrase and order their
   // messages differently, and the class is what the caller acts on. All of it runs
   // before the tree is enumerated, so nothing schema-invalid is traversed, let alone
   // published. The same pattern repeats for the index and the changelog below.
   if (schemaErrors('context-manifest', parsedManifest).length > 0) {
      return unavailable('the pinned leji.json does not validate against the manifest schema');
   }

   // Content closure: the pinned generated index names the governed paths, which are
   // required wherever they live. Read as JSON from the object store; no new parser.
   const indexPath = machineFiles[0];
   const indexRaw = runGit(['-C', repo, 'cat-file', 'blob', `${commit}:${indexPath}`]);
   if (indexRaw.ok) {
      let stored: unknown;
      try {
         stored = JSON.parse(indexRaw.stdout.toString('utf8'));
      } catch {
         return unavailable('the pinned context index is not valid JSON');
      }
      if (!allStringsScalar(stored)) {
         return unsafe('the pinned context index contains a malformed string');
      }
      if (!isRecord(stored)) return unavailable('the pinned context index is not an object');
      const entries = stored.entries;
      if (entries !== undefined && !Array.isArray(entries)) {
         return unavailable('the pinned context index has no entries array');
      }
      for (const entry of entries ?? []) {
         if (!isRecord(entry)) return unavailable('the pinned context index entry is not an object');
         const err = addCritical(entry.path, 'context index entry');
         if (err !== null) return err;
      }
      if (schemaErrors('context-index', stored).length > 0) {
         return unavailable('the pinned context index does not validate against the index schema');
      }
   }

   // The changelog contributes no path to the closure, so it is read for one reason:
   // it is a pinned machine artifact, and a projection that publishes one which does
   // not validate hands the host malformed content under the schema's name. Absent is
   // normal (a core layer has no changelog) and contributes nothing.
   const changelogRaw = runGit(['-C', repo, 'cat-file', 'blob', `${commit}:${machineFiles[1]}`]);
   if (changelogRaw.ok) {
      let storedChangelog: unknown;
      try {
         storedChangelog = JSON.parse(changelogRaw.stdout.toString('utf8'));
      } catch {
         return unavailable('the pinned context changelog is not valid JSON');
      }
      if (!allStringsScalar(storedChangelog)) {
         return unsafe('the pinned context changelog contains a malformed string');
      }
      if (schemaErrors('context-changelog', storedChangelog).length > 0) {
         return unavailable('the pinned context changelog does not validate against the changelog schema');
      }
   }

   // Selection is a literal comparison against the enumerated tree: a name is
   // matched as a name, and a directory by its prefix. Nothing is handed to git as
   // a pattern, so a path carrying `*`, `?` or `[` selects itself and only itself.
   const selected = (p: string): boolean =>
      p === 'leji.json' || isUnderAny(p, prefixes) || critical.has(p) || optional.has(p);

   // The same selection expressed as bytes, for the one entry kind that cannot be
   // decoded into `selected`'s argument. Every selection came from a JSON string
   // that cleared the scalar gate, so each has a well-defined UTF-8 form; the two
   // predicates must agree, and this one mirrors `selected` term for term.
   const selectsEverything = [...prefixes].some((p) => p === '.' || p === '');
   const fileBytes = ['leji.json', ...critical.keys(), ...optional].map((f) => Buffer.from(f, 'utf8'));
   const dirBytes = [...prefixes].filter((p) => p !== '.' && p !== '').map((p) => Buffer.from(p, 'utf8'));
   const selectsRawPath = (raw: Buffer): boolean => {
      if (selectsEverything) return true;
      if (fileBytes.some((f) => raw.equals(f))) return true;
      return dirBytes.some(
         (d) =>
            raw.equals(d) ||
            // 0x2f is "/": the entry sits under the prefix rather than merely
            // sharing its opening bytes.
            (raw.length > d.length && raw[d.length] === 0x2f && raw.subarray(0, d.length).equals(d)),
      );
   };

   const listed = listTree(repo, commit, selectsRawPath);
   if (listed.error) return { ok: false, error: listed.error, kind: listed.kind };

   let files = 0;
   const seen = new Set<string>();
   const lowered = new Set<string>();
   const gitlinks: { path: string; oid: string }[] = [];
   const symlinks: { relPath: string; target: string }[] = [];
   const writes: { relPath: string; oid: string; mode: number }[] = [];

   for (const e of listed.entries) {
      // Filtered before any per-entry rule runs: the enumeration is the whole tree,
      // and a case collision or an unsupported mode outside the projection is not
      // this projection's business.
      if (!selected(e.relPath)) continue;
      // Overlapping selections legitimately reach the same entry; the projection is
      // their deduplicated union.
      if (seen.has(e.relPath)) continue;
      seen.add(e.relPath);
      if (!containedRelPath(e.relPath)) return unsafe(`unsafe path in the pinned tree: ${e.relPath}`);
      const lower = asciiFold(e.relPath);
      if (lowered.has(lower)) return unsafe(`case collision in the pinned tree: ${e.relPath}`);
      lowered.add(lower);
      if (e.mode === '160000') {
         gitlinks.push({ path: e.relPath, oid: e.oid });
         continue;
      }
      if (e.mode === '120000') {
         const target = catBlob(repo, e.oid);
         if (target === null) return unsafe(`unreadable symlink ${e.relPath}`);
         // A target that is not valid UTF-8 is refused rather than decoded. The three
         // runtimes disagree about what decoding even means here (Node substitutes
         // U+FFFD, Python has to be told to, Go carries the raw bytes through), so a
         // decoded target is a different string in each and the containment check
         // below would then be checking three different things. There is no portable
         // form to fall back to, so there is nothing to do but refuse it.
         const decoded = target.toString('utf8');
         if (Buffer.from(decoded, 'utf8').compare(target) !== 0) {
            return unsafe(`symlink target is not valid UTF-8 in ${e.relPath}`);
         }
         // An empty target is malformed pinned content, not a link to anything: the
         // system call that would materialize it fails, and resolving it produced a
         // different answer in each SDK (Python read it as the containing directory,
         // Node and Go as the entry itself). Refused, so all three agree on nothing.
         if (decoded === '') return unsafe(`symlink target is empty in ${e.relPath}`);
         symlinks.push({ relPath: e.relPath, target: decoded });
         continue;
      }
      if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) {
         return unsafe(`unsupported entry ${e.mode} ${e.relPath} in the pinned tree`);
      }
      writes.push({ relPath: e.relPath, oid: e.oid, mode: e.mode === '100755' ? 0o755 : 0o644 });
      files++;
      if (files > MAX_PROJECTION_FILES) return unsafe('projection exceeds the file-count limit');
   }

   // The failure boundary: every closure-critical file resolves at the pin, or the
   // projection fails naming the declaring artifact and the missing path. Symlinked
   // criticals count as present (their targets are containment-checked below).
   //
   // Byte order, not map order: with several criticals missing, the one the failure
   // names has to be the same in every SDK, and a Go map iterates at random.
   const present = new Set<string>([...writes.map((w) => w.relPath), ...symlinks.map((s) => s.relPath)]);
   for (const f of [...critical.keys()].sort(byteCompare)) {
      if (!present.has(f)) {
         return unavailable(`closure-critical path missing at the pin: ${critical.get(f)} ${f}`);
      }
   }

   // Symlink targets must stay inside the projection after resolution.
   const projected = new Set(writes.map((w) => w.relPath));
   for (const s of symlinks) {
      if (s.target.startsWith('/') || s.target.includes('\\')) {
         return unsafe(`unsafe symlink target in ${s.relPath}`);
      }
      // Trailing slashes come off the resolved path before it is compared. An
      // ordinary directory symlink (`ln -s sub/ link`) resolves to `dir/sub/`, which
      // is not a key of any projected path and not a prefix any selection carries, so
      // a conforming sibling was refused for pointing inside itself. Go's path.Join
      // already Cleaned the slash away and hydrated it; the explicit strip is what
      // makes all three answer the same. Containment itself is unchanged: an escaping
      // trailing-slash target is still refused, because `..` resolves before this.
      const resolved = stripTrailingSlashes(
         path.posix.normalize(path.posix.join(path.posix.dirname(s.relPath), s.target)),
      );
      if (!containedRelPath(resolved) || (!projected.has(resolved) && !isUnderAny(resolved, prefixes))) {
         return unsafe(`symlink ${s.relPath} escapes the projection`);
      }
   }

   return {
      ok: true,
      commit,
      tree,
      siblingName: typeof sibling.name === 'string' ? sibling.name : undefined,
      prefixes,
      writes,
      symlinks,
      gitlinks,
   };
}

/** Every trailing `/` removed. A resolved symlink target names an entry, and an
 * entry's name never ends in a separator; the three runtimes' path normalizers
 * disagree about whether one survives. */
function stripTrailingSlashes(p: string): string {
   let out = p;
   while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
   return out;
}

/** POSIX join for a possibly-empty prefix ('' means repository root). */
function joinPosix(prefix: string, name: string): string {
   return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * Extract the layer projection of the pinned sibling into `destDir`: the closure,
 * materialized. Byte limits bind here, where content is actually read.
 */
export function extractProjection(repo: string, pin: string, destDir: string): ProjectionResult {
   const closure = computeClosure(repo, pin);
   if (!closure.ok) return { ok: false, error: closure.error, kind: closure.kind };

   let bytes = 0;
   for (const w of closure.writes!) {
      const blob = catBlob(repo, w.oid);
      if (blob === null) return { ok: false, error: `unreadable blob for ${w.relPath}`, kind: 'safety' };
      bytes += blob.length;
      if (bytes > MAX_PROJECTION_BYTES) {
         return { ok: false, error: 'projection exceeds the byte limit', kind: 'safety' };
      }
      const abs = path.join(destDir, ...w.relPath.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blob, { mode: w.mode });
   }
   for (const s of closure.symlinks!) {
      const abs = path.join(destDir, ...s.relPath.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(s.target, abs);
   }

   return {
      ok: true,
      commit: closure.commit,
      tree: closure.tree,
      files: closure.writes!.length,
      bytes,
      gitlinks: closure.gitlinks,
      siblingName: closure.siblingName,
   };
}

/** The `leji status` projection section: would this layer, at HEAD, project
 * completely if a host mounted it? Enumeration-level (closure completeness and
 * per-entry rules against the object store); read-only, offline, deterministic. */
export type SelfProjection =
   | { state: 'ok'; commit: string; files: number }
   | { state: 'fail'; commit: string; detail: string }
   | { state: 'no-commit' };

export function selfProjection(root: string): SelfProjection {
   const head = runGit(['-C', root, 'rev-parse', 'HEAD^{commit}']);
   if (!head.ok) return { state: 'no-commit' };
   const commit = head.stdout.toString('utf8').trim();
   const closure = computeClosure(root, commit);
   if (!closure.ok) return { state: 'fail', commit, detail: closure.error! };
   return { state: 'ok', commit, files: closure.writes!.length + closure.symlinks!.length };
}

/**
 * ASCII-only case folding: the portable rule the case-collision check uses, and the
 * porting contract for it. `A`-`Z` fold to `a`-`z`; every other code point is left
 * exactly as it is.
 *
 * Deliberately not the runtime's own lowercase mapping. JavaScript's
 * `toLowerCase`, Go's `strings.ToLower` and Python's `str.lower` implement
 * different Unicode versions with different special cases, so the same pinned tree
 * can collide in one SDK and not in another; a shared versioned Unicode table was
 * considered and rejected, because pinning a table version is the same problem one
 * layer down. The cost is stated rather than hidden: a case-insensitive filesystem
 * that folds non-ASCII will still collide on a pair this check passes, so the guard
 * is a portable floor, not a claim about any particular filesystem.
 *
 * Byte-safe in every SDK: no byte of a multi-byte UTF-8 sequence falls in 0x41-0x5A.
 */
function asciiFold(s: string): string {
   let out = '';
   for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : s[i];
   }
   return out;
}

function isUnderAny(relPath: string, prefixes: Set<string>): boolean {
   for (const p of prefixes) {
      if (p === '.' || p === '') return true;
      if (relPath === p || relPath.startsWith(p + '/')) return true;
   }
   return false;
}

// --- Cache publication -------------------------------------------------------
//
// There is no lock over the cache. Git owns object-store and ref concurrency,
// refs publish by compare-and-swap, and the cache is content-addressed, so every
// producer for a key stages byte-identical content. What remains is publishing an
// entry exactly once, which `rename` already decides.

/** The publication marker, written *inside* the staged tree before it is moved.
 * Publishing the content and its completion evidence in one atomic move closes the
 * window where an entry exists without its marker: without that, a producer racing a
 * live publisher reads "destination without marker" and wrongly calls it poison. */
function completeMarker(projection: string): string {
   return path.join(projection, 'complete');
}

/** The published projection for a cache key, marker and all. */
function projectionDir(root: string, key: string): string {
   return path.join(mountsDir(root), 'cache', key, 'projection');
}

/** True when this cache key holds a published entry. The directory existing proves
 * nothing; only the marker inside it does. */
function cacheEntryPublished(root: string, key: string): boolean {
   return isFile(completeMarker(projectionDir(root, key)));
}

/**
 * `rename` onto an existing non-empty directory: POSIX reports ENOTEMPTY or EEXIST,
 * Windows fails whenever the destination exists (EPERM or EACCES). The whole set is
 * matched rather than one code assumed, so no other failure is read as "destination
 * exists" by inference.
 */
const DESTINATION_EXISTS = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES']);

function destinationExists(e: unknown): boolean {
   return DESTINATION_EXISTS.has((e as NodeJS.ErrnoException).code ?? '');
}

/** Unique staging names, so two producers never stage into the same directory. */
function stagingToken(): string {
   return `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

type PublishResult = { status: 'hydrated' | 'cached' } | { status: 'error'; detail: string };

/**
 * Publish the staged tree as this key's projection.
 *
 * The sidecar and the marker are written into staging first, so the single rename
 * publishes a complete entry or nothing at all. A published projection therefore
 * always holds at least the marker and is never empty, which is what makes the
 * rename exclusive in practice: POSIX replaces only an *empty* destination
 * directory.
 *
 * Poison, meaning a projection with no marker, is never repaired. Repairing it would
 * mean deciding from the outside that no other process is mid-publish, and that
 * decision cannot be made without reintroducing the race this protocol removes.
 */
function publishCacheEntry(cacheDir: string, staging: string, metadataJson: string): PublishResult {
   fs.writeFileSync(path.join(staging, 'metadata.json'), metadataJson);
   fs.writeFileSync(completeMarker(staging), '');
   const target = path.join(cacheDir, 'projection');
   try {
      fs.renameSync(staging, target);
      return { status: 'hydrated' };
   } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      if (!destinationExists(e)) {
         return { status: 'error', detail: 'the projection could not be published into the cache' };
      }
   }
   if (isFile(completeMarker(target))) return { status: 'cached' };
   return { status: 'error', detail: 'the cache entry is incomplete and is not repaired automatically' };
}

/** Reject outright when any file under .leji/mounts/ is git-tracked in the host. */
export function trackedCacheFiles(root: string): string[] {
   const r = runGit(['-C', root, 'ls-files', '--', '.leji/mounts']);
   if (!r.ok) return [];
   return r.stdout.toString('utf8').split('\n').filter(Boolean);
}

function declaredMounts(manifest: Manifest): MountDecl[] {
   return (manifest.federation?.mounts ?? []).map((m) => ({
      name: m.name,
      source: m.source,
      pin: m.pin,
      trackingRef: m.trackingRef,
   }));
}

/**
 * Hydrate the declared mounts. `reasons` carries the resolver's own reason for the
 * one `--fetch` act that failed per mount, keyed by mount name, for the caller's
 * findings; it is a transport, never a document member, and the writers of
 * `mounts hydrate --json` pick their fields explicitly so it is never serialized.
 */
export function hydrateMounts(
   root: string,
   manifest: Manifest,
   opts: { fetch?: boolean; names?: string[]; ignoreContext?: LejiIgnoreContext } = {},
): { outcomes: HydrateOutcome[]; fatal?: string; reasons: Map<string, string> } {
   // One context for the whole run: hydration establishes a store and a staging
   // directory per declared mount, and they are all one invocation.
   const ignoreContext = opts.ignoreContext ?? newLejiIgnoreContext();
   const reasons = new Map<string, string>();
   const tracked = trackedCacheFiles(root);
   if (tracked.length > 0) {
      return {
         outcomes: [],
         fatal: `git-tracked files under .leji/mounts/ (${tracked[0]}); the cache is never committed`,
         reasons,
      };
   }
   const mounts = declaredMounts(manifest).filter((m) => !opts.names || opts.names.includes(m.name));
   const outcomes: HydrateOutcome[] = [];
   for (const mount of mounts) {
      const identity = normalizeSource(mount.source);
      // Details never echo a declaration back: a source may be a local path, and
      // canonical output carries no filesystem paths. The mount name locates it.
      if (identity === null) {
         outcomes.push({
            name: mount.name,
            status: 'error',
            detail: 'source is not a normalizable locator',
         });
         continue;
      }
      if (mount.trackingRef !== undefined && !validTrackingRef(mount.trackingRef)) {
         outcomes.push({
            name: mount.name,
            status: 'error',
            detail: 'trackingRef is not a fully qualified branch or tag',
         });
         continue;
      }
      // --fetch populates the store for every declared mount, cached or already
      // resolvable: the store is the only witness namespace the resolver owns,
      // and `status` never fetches.
      const fetched = opts.fetch ? fetchIntoStore(root, mount, identity, ignoreContext) : null;
      // At most one act can fail: a store that was not established is never asked to
      // refresh a witness, so one reason per mount is the whole vocabulary here.
      const failedAct = fetched?.repo === null ? fetched.error : fetched?.witnessError;
      if (failedAct !== undefined) reasons.set(mount.name, failedAct);
      // A requested fetch that did not establish the store is reported on its own
      // terms, whatever the projection then manages from a hint or the cache.
      const outcome = (o: HydrateOutcome): HydrateOutcome => ({
         ...o,
         ...(fetched === null ? {} : { storeFetched: fetched.repo !== null }),
         ...(fetched?.witnessRefreshFailed ? { witnessRefreshFailed: true } : {}),
      });
      const key = cacheKeyFor(identity, mount.pin);
      const cacheDir = path.join(mountsDir(root), 'cache', key);
      if (cacheEntryPublished(root, key)) {
         outcomes.push(outcome({ name: mount.name, status: 'cached', cacheKey: key }));
         continue;
      }
      const src = findObjectSource(root, mount, identity);
      if (src.ambiguous) {
         outcomes.push(
            outcome({
               name: mount.name,
               status: 'error',
               detail:
                  'more than one submodule matches the source; declare an explicit hint in .leji/mounts.local.json',
            }),
         );
         continue;
      }
      if (src.repo === null) {
         outcomes.push(
            outcome({
               name: mount.name,
               status: 'unavailable',
               detail: fetched?.error ?? 'no reachable object store holds the pin (declare a hint, or pass --fetch)',
            }),
         );
         continue;
      }
      // Staged inside the entry's own directory, so publication is a rename on one
      // filesystem, and under a per-process name, so no two producers collide. The
      // staging directory is established through the chokepoint and every act below
      // works from the RESOLVED path it returned, the cache entry included.
      const staging = establishMountsDir(root, path.join(cacheDir, `.staging-${stagingToken()}`), ignoreContext);
      if (staging === null) {
         outcomes.push(
            outcome({
               name: mount.name,
               status: 'error',
               detail: 'the cache entry destination could not be established',
            }),
         );
         continue;
      }
      const cacheEntryDir = path.dirname(staging);
      const projected = extractProjection(src.repo, mount.pin, staging);
      if (!projected.ok) {
         fs.rmSync(staging, { recursive: true, force: true });
         // The class the failure was tagged with at its own site decides this, never
         // the detail text: a pinned layer that is absent or malformed leaves the
         // mount unavailable (hydrate is best-effort), while a safety guard the
         // projection refused to cross is an error the run fails on.
         outcomes.push(
            outcome({
               name: mount.name,
               status: projected.kind === 'unavailable' ? 'unavailable' : 'error',
               detail: projected.error,
               projectionFailed: true,
            }),
         );
         continue;
      }
      const hostManifestRaw = readTextWithin(path.resolve(root), path.join(root, 'leji.json')) ?? '';
      const metadata = {
         name: mount.name,
         sourceIdentity: identity,
         pin: mount.pin,
         commit: projected.commit,
         tree: projected.tree,
         cacheFormatVersion: CACHE_FORMAT_VERSION,
         resolverVersion: 'leji-sdk',
         manifestDigest: sha256Hex(hostManifestRaw),
         files: projected.files,
         bytes: projected.bytes,
         gitlinks: projected.gitlinks,
         siblingName: projected.siblingName ?? null,
         completionState: 'complete',
         hydratedAt: new Date().toISOString(),
      };
      // The whole tree is extracted and validated before it is publishable.
      const published = publishCacheEntry(cacheEntryDir, staging, JSON.stringify(metadata, null, 2) + '\n');
      if (published.status === 'error') {
         outcomes.push(outcome({ name: mount.name, status: 'error', detail: published.detail }));
         continue;
      }
      outcomes.push(
         outcome({
            name: mount.name,
            status: published.status,
            cacheKey: key,
            ...(published.status === 'hydrated' ? { objectSource: src.kind ?? undefined } : {}),
         }),
      );
   }
   // Nothing is recorded: a mount's cache key is derivable from its declaration, and
   // whether it is hydrated is the marker on disk. A state file would only be a second
   // copy of both, and one that two concurrent partial runs can each drop entries from.
   return { outcomes, reasons };
}

/**
 * Verify a cached projection against a reachable object store: every projected
 * file's bytes and mode against the pinned tree. Returns null when a prerequisite
 * for verifying is unavailable — no reachable object store, an unresolvable pin,
 * no writable temp dir — leaving the projection unverified rather than judged;
 * true/false otherwise.
 */
export function verifyProjection(root: string, mount: MountDecl): boolean | null {
   const identity = normalizeSource(mount.source);
   if (identity === null) return false;
   const key = cacheKeyFor(identity, mount.pin);
   if (!cacheEntryPublished(root, key)) return false;
   const projDir = path.join(mountsDir(root), 'cache', key, 'projection');
   const src = findObjectSource(root, mount, identity);
   if (src.repo === null) return null;
   const commitR = runGit(['-C', src.repo, 'rev-parse', `${mount.pin}^{commit}`]);
   if (!commitR.ok) return null;
   const commit = commitR.stdout.toString('utf8').trim();
   // Staging happens outside the host: verifying is a read-only question, so asking
   // it must not write into the tree being asked about (a read-only or shared
   // checkout could not answer otherwise). The name is allocated, never constructed
   // and pre-deleted: a guessed path is a path a concurrent verification is already
   // using, and deleting it is how one run made another fail. Cleanup is installed
   // the moment allocation succeeds. A failed allocation is one more unavailable
   // prerequisite — unverifiable, never an error and never an in-tree fallback.
   let staging: string;
   try {
      staging = fs.mkdtempSync(path.join(os.tmpdir(), 'leji-verify-'));
   } catch {
      return null;
   }
   try {
      const projected = extractProjection(src.repo, commit, staging);
      if (!projected.ok) return false;
      // The published entry carries two resolver files the pinned tree does not: the
      // completion marker and the sidecar. Staging them too keeps the comparison a
      // comparison of sibling content, rather than one that always finds two extras.
      fs.writeFileSync(completeMarker(staging), '');
      fs.writeFileSync(path.join(staging, 'metadata.json'), fs.readFileSync(path.join(projDir, 'metadata.json')));
      return treesEqual(staging, projDir);
   } finally {
      fs.rmSync(staging, { recursive: true, force: true });
   }
}

function treesEqual(a: string, b: string): boolean {
   const listA = walkAll(a).sort();
   const listB = walkAll(b).sort();
   if (listA.length !== listB.length || listA.some((p, i) => p !== listB[i])) return false;
   for (const rel of listA) {
      const fa = path.join(a, rel);
      const fb = path.join(b, rel);
      const sa = fs.lstatSync(fa);
      const sb = fs.lstatSync(fb);
      if (sa.isSymbolicLink() !== sb.isSymbolicLink()) return false;
      if (sa.isSymbolicLink()) {
         // Bytes, not decoded strings. Two targets that differ in bytes can decode to
         // the same string (a replacement character stands in for any invalid
         // sequence), and integrity is a claim about what is on disk: the string
         // compare reported a tampered link as verified.
         const ta = fs.readlinkSync(fa, { encoding: 'buffer' });
         const tb = fs.readlinkSync(fb, { encoding: 'buffer' });
         if (ta.compare(tb) !== 0) return false;
         continue;
      }
      if ((sa.mode & 0o777) !== (sb.mode & 0o777)) return false;
      if (fs.readFileSync(fa).compare(fs.readFileSync(fb)) !== 0) return false;
   }
   return true;
}

function walkAll(dir: string, prefix = ''): string[] {
   const out: string[] = [];
   for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (fs.lstatSync(abs).isDirectory()) out.push(...walkAll(abs, rel));
      else out.push(rel);
   }
   return out;
}

export function locateMount(root: string, manifest: Manifest, name: string): LocateResult {
   const mount = declaredMounts(manifest).find((m) => m.name === name);
   if (!mount) {
      return {
         name,
         sourceIdentity: null,
         pin: null,
         present: false,
         verified: false,
         path: null,
         detail: 'no mount with this name is declared',
      };
   }
   const identity = normalizeSource(mount.source);
   if (identity === null) {
      return {
         name,
         sourceIdentity: null,
         pin: mount.pin,
         present: false,
         verified: false,
         path: null,
         detail: 'source is not a normalizable locator',
      };
   }
   const key = cacheKeyFor(identity, mount.pin);
   const projDir = path.join(mountsDir(root), 'cache', key, 'projection');
   const present = cacheEntryPublished(root, key);
   const verified = present ? verifyProjection(root, mount) === true : false;
   return {
      name,
      sourceIdentity: identity,
      pin: mount.pin,
      present,
      verified,
      path: present ? projDir : null,
      ...(present && !verified
         ? {
              detail:
                 'projection present but not verified: it does not match its pin, or verification prerequisites are unavailable',
           }
         : {}),
   };
}

/** Which repository answers a pin comparison, and the ONE witness snapshot it
 * answered with. `reason` is the degraded alternative: a stable status code and
 * nothing selected. */
export type ComparisonSelection =
   | {
        repo: string;
        comparisonRepository: NonNullable<StatusResult['pinReport']['comparisonRepository']>;
        witnessProvenance: NonNullable<StatusResult['pinReport']['witnessProvenance']>;
        comparedRef: string;
        tipOid: string;
     }
   | { reason: string };

/**
 * The store-first availability matrix, resolved once: the resolver's own witness
 * in the managed store first, then the first object source that holds BOTH the pin
 * and the compared ref. The pin and the witness always come from the same
 * repository, and nothing here fetches.
 *
 * `tipOid` is the single witness snapshot for the whole operation. `status` reports
 * from it and `update-pin` targets, counts and gates from it, so no caller can end
 * up describing two different commits by re-reading a ref that moved in between.
 */
export function selectComparison(root: string, mount: MountDecl, effectiveRef: string): ComparisonSelection {
   const identity = normalizeSource(mount.source);
   if (identity === null) return { reason: 'mount-source-unnormalizable' };
   if (!validTrackingRef(effectiveRef)) return { reason: 'mount-tracking-ref-invalid' };
   // Row 1: the managed store holds the pin and the resolver's own witness.
   const store = storeDir(root, identity);
   const managedTip =
      isGitRepo(store) && hasCommit(store, mount.pin) ? revOid(store, witnessRefFor(identity, effectiveRef)) : null;
   // Row 2: the first pin-holding source that also resolves the ref itself. A
   // candidate holding only the pin is passed over, never allowed to mask a
   // later one holding both.
   const offline =
      managedTip === null ? objectSourceCandidates(root, mount, identity) : { candidates: [], ambiguous: false };
   let selected: { repo: string; kind: ObjectSourceKind; tip: string } | null =
      managedTip === null ? null : { repo: store, kind: 'store', tip: managedTip };
   for (const candidate of offline.candidates) {
      const tip = revOid(candidate.repo, effectiveRef);
      if (tip !== null) {
         selected = { ...candidate, tip };
         break;
      }
   }
   if (selected === null) {
      // Ambiguity is its own answer: those repositories were never consulted,
      // so reporting the pin or the witness unavailable would claim more than
      // was checked.
      if (offline.ambiguous) return { reason: 'mount-source-ambiguous' };
      return { reason: offline.candidates.length === 0 ? 'mount-pin-unavailable' : 'mount-witness-unavailable' };
   }
   return {
      repo: selected.repo,
      comparisonRepository: selected.kind === 'store' ? 'managed-store' : selected.kind,
      witnessProvenance: managedTip !== null ? 'managed' : 'unmanaged',
      comparedRef: effectiveRef,
      tipOid: selected.tip,
   };
}

/**
 * Report every declared mount's pin against its witness, offline. Comparison is
 * the availability matrix: the resolver's own witness in the managed store first,
 * then any object source that holds both the pin and the tracking ref. The pin and
 * the witness always come from the same repository, and nothing here fetches.
 */
export function mountStatus(
   root: string,
   manifest: Manifest,
   opts: { checkIntegrity?: boolean; now?: () => Date } = {},
): StatusResult[] {
   // One observation time for the whole execution, injectable so tests are stable.
   const observedAt = (opts.now ? opts.now() : new Date()).toISOString();
   return [...declaredMounts(manifest)]
      .sort((a, b) => byteCompare(a.name, b.name))
      .map((mount) => {
         const identity = normalizeSource(mount.source);
         const present = identity !== null && cacheEntryPublished(root, cacheKeyFor(identity, mount.pin));
         const base = {
            name: mount.name,
            sourceIdentity: identity,
            pin: mount.pin,
            trackingRef: mount.trackingRef ?? null,
            present,
            verified: opts.checkIntegrity && present ? verifyProjection(root, mount) : null,
         };
         const unknown = (
            reason: string,
            comparisonRepository: StatusResult['pinReport']['comparisonRepository'] = null,
            witnessProvenance: StatusResult['pinReport']['witnessProvenance'] = null,
         ): StatusResult => ({
            ...base,
            pinReport: {
               state: 'unknown',
               comparedRef: mount.trackingRef ?? null,
               comparisonRepository,
               witnessProvenance,
               ancestryComplete: false,
               reason,
               observedAt,
            },
         });
         if (identity === null) return unknown('mount-source-unnormalizable');
         if (mount.trackingRef === undefined) return unknown('mount-no-tracking-ref');
         if (!validTrackingRef(mount.trackingRef)) return unknown('mount-tracking-ref-invalid');

         const selection = selectComparison(root, mount, mount.trackingRef);
         if ('reason' in selection) return unknown(selection.reason);
         const { repo, tipOid, comparisonRepository, witnessProvenance } = selection;

         const comparison = comparePins(repo, mount.pin, tipOid);
         if ('reason' in comparison) {
            return unknown(comparison.reason, comparisonRepository, witnessProvenance);
         }
         return {
            ...base,
            pinReport: {
               state: comparison.state,
               behind: comparison.behind,
               ahead: comparison.ahead,
               comparedRef: mount.trackingRef,
               comparisonRepository,
               witnessProvenance,
               ancestryComplete: comparison.ancestryComplete,
               observedAt,
            },
         };
      });
}

/** A settled pin comparison: never `unknown`, because a repository that cannot
 * answer the range returns the reason instead. */
export interface PinComparison {
   state: Exclude<StatusResult['pinReport']['state'], 'unknown'>;
   behind: number;
   ahead: number;
   ancestryComplete: boolean;
}

/**
 * Where the pin stands against ONE witness snapshot, in ONE repository. Shared by
 * `status`, which reports it, and `update-pin`, which additionally gates on it — so
 * the two can never describe the same pair of commits differently.
 */
export function comparePins(
   repo: string,
   pin: string,
   tipOid: string,
): PinComparison | { reason: 'mount-ancestry-incomplete' } {
   const incomplete = { reason: 'mount-ancestry-incomplete' } as const;
   const behind = countRange(repo, pin, tipOid);
   const ahead = countRange(repo, tipOid, pin);
   if (behind === null || ahead === null) return incomplete;
   const shallow = runGit(['-C', repo, 'rev-parse', '--is-shallow-repository']);
   const ancestryComplete = shallow.ok && shallow.stdout.toString('utf8').trim() === 'false';
   // Both counts positive is either divergence or two unrelated histories, and
   // only a merge base tells them apart. Exit 1 is the answer "no merge base";
   // any other failure is the repository unable to answer, never an answer.
   // Truncated history can also lose a merge base that exists, so `unrelated`
   // is a claim only complete ancestry makes.
   let disjoint = false;
   if (behind > 0 && ahead > 0) {
      const mergeBase = runGit(['-C', repo, 'merge-base', pin, tipOid]);
      if (!mergeBase.ok && mergeBase.code !== 1) return incomplete;
      disjoint = !mergeBase.ok;
      if (disjoint && !ancestryComplete) return incomplete;
   }
   const state: PinComparison['state'] =
      behind === 0 && ahead === 0
         ? 'up-to-date'
         : behind > 0 && ahead > 0
           ? disjoint
              ? 'unrelated'
              : 'diverged'
           : behind > 0
             ? 'behind'
             : 'ahead';
   return { state, behind, ahead, ancestryComplete };
}

/** Commits in `from..to`, or null when the range cannot be counted (missing objects). */
function countRange(repo: string, from: string, to: string): number | null {
   const r = runGit(['-C', repo, 'rev-list', '--count', `${from}..${to}`]);
   if (!r.ok) return null;
   const n = parseInt(r.stdout.toString('utf8').trim(), 10);
   return Number.isFinite(n) ? n : null;
}

/**
 * The ref a source advertises as its default branch: `HEAD`'s symref target, read
 * with `ls-remote --symref`. The one lookup in this module that reaches the network
 * without the caller having named a ref, so both failures stay distinguishable —
 * the source could not be reached at all, or it advertises no symref to follow.
 */
export function resolveDefaultRef(source: string): { ref: string } | { error: 'unreachable' | 'no-symref' } {
   // The locator becomes argv here: anything option-shaped is refused, never passed.
   if (source.startsWith('-')) return { error: 'unreachable' };
   const head = runGit(['ls-remote', '--symref', source, 'HEAD']);
   if (!head.ok) return { error: 'unreachable' };
   const m = /^ref:\s+(\S+)\s+HEAD/m.exec(head.stdout.toString('utf8'));
   return m ? { ref: m[1] } : { error: 'no-symref' };
}

export interface ReachabilityResult {
   state: 'reachable' | 'unreachable' | 'unknown';
   witnessRef: string | null;
   detail?: string;
}

/**
 * The networked conformance probe: is the pin reachable from an advertised ref of
 * `source`? Advertisement comes from `git ls-remote` against the declared source
 * (never a hint: hint-only resolution is availability, not conformance). The
 * witness is `trackingRef`, or the source's advertised HEAD symref when absent.
 * Ancestry is then established by fetching the witness ref into the resolver
 * store. Any failure to reach the source reports `unknown`, never a guess, and
 * every detail is stable text: git stderr never reaches conformance output.
 */
export function checkPinReachability(
   root: string,
   mount: MountDecl,
   ignoreContext?: LejiIgnoreContext,
): ReachabilityResult {
   const identity = normalizeSource(mount.source);
   if (identity === null) {
      return { state: 'unknown', witnessRef: null, detail: 'source is not a normalizable locator' };
   }
   // Resolve the witness ref: declared, or the source's advertised default branch.
   let witnessRef = mount.trackingRef ?? null;
   if (witnessRef === null) {
      const resolved = resolveDefaultRef(mount.source);
      if ('error' in resolved) {
         return {
            state: 'unknown',
            witnessRef: null,
            detail:
               resolved.error === 'unreachable'
                  ? 'the source could not be reached'
                  : 'source advertises no HEAD symref',
         };
      }
      witnessRef = resolved.ref;
   }
   const adv = runGit(['ls-remote', mount.source, witnessRef]);
   if (!adv.ok) return { state: 'unknown', witnessRef, detail: 'the source could not be reached' };
   const line = adv.stdout.toString('utf8').trim();
   if (line === '') return { state: 'unreachable', witnessRef, detail: `source does not advertise ${witnessRef}` };
   const tip = line.split('\t')[0];
   // Establish ancestry in the resolver store: fetch the witness ref (full history,
   // no promisor state), then ask whether the pin is an ancestor of its tip.
   const store = establishMountsDir(root, path.join(mountsDir(root), 'store', sha256Hex(identity)), ignoreContext);
   if (store === null) {
      return { state: 'unknown', witnessRef, detail: 'the managed store could not be initialized' };
   }
   if (!isGitRepo(store)) {
      const init = runGit(['init', '--bare', '-q', store]);
      if (!init.ok) return { state: 'unknown', witnessRef, detail: 'the managed store could not be initialized' };
   }
   const fetch = runGit(['-C', store, '-c', 'fetch.recurseSubmodules=no', 'fetch', '-q', mount.source, witnessRef]);
   if (!fetch.ok) {
      return { state: 'unknown', witnessRef, detail: 'the witness ref could not be fetched from the source' };
   }
   const anc = runGit(['-C', store, 'merge-base', '--is-ancestor', mount.pin, tip]);
   if (anc.ok) return { state: 'reachable', witnessRef };
   // is-ancestor distinguishes "no" (exit 1) from "cannot answer" (missing objects).
   const pinKnown = hasCommit(store, mount.pin);
   if (!pinKnown) {
      return { state: 'unreachable', witnessRef, detail: 'the pin is not in the history advertised by the source' };
   }
   return { state: 'unreachable', witnessRef, detail: `the pin is not an ancestor of ${witnessRef}` };
}

export interface EnforcementFinding {
   rule: string;
   severity: 'error';
   message: string;
   path: string;
}

/**
 * Opt-in federation enforcement for `leji validate --federation=<mode>`.
 * `available`: every cleanly declared mount must be hydrated AND verified against
 * a reachable object store (a restored or unverifiable cache is not evidence).
 * `required`: only mounts the given task paths route to (category overlap, the
 * routing algorithm's machine-decidable signal) must be available; `requiredWhen`
 * stays the agent's judgment. Never mutates; run `mounts hydrate` first.
 */
export function federationEnforcement(
   root: string,
   manifest: Manifest,
   mode: 'available' | 'required',
   taskMountNames: Set<string> | null,
): EnforcementFinding[] {
   const out: EnforcementFinding[] = [];
   for (const mount of declaredMounts(manifest)) {
      if (mode === 'required' && (taskMountNames === null || !taskMountNames.has(mount.name))) continue;
      const identity = normalizeSource(mount.source);
      if (identity === null) continue; // declaration errors are ordinary validation's
      if (!cacheEntryPublished(root, cacheKeyFor(identity, mount.pin))) {
         out.push({
            rule: 'mount-enforcement',
            severity: 'error',
            message: `mount "${mount.name}" is required ${mode === 'required' ? 'by this task' : 'by --federation=available'} but is not hydrated; run \`leji mounts hydrate\``,
            path: mount.name,
         });
         continue;
      }
      const verified = verifyProjection(root, mount);
      if (verified !== true) {
         out.push({
            rule: 'mount-enforcement',
            severity: 'error',
            message:
               verified === false
                  ? `mount "${mount.name}" projection does not match its pin; re-run \`leji mounts hydrate\``
                  : `mount "${mount.name}" projection cannot be verified (verification prerequisites unavailable: no reachable object store, unresolvable pin, or no writable temp dir); an unverified cache is not evidence`,
            path: mount.name,
         });
      }
   }
   return out;
}
