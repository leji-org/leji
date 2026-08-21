import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Finding, sortFindings } from '../lib/findings.js';
import {
   mkdirpGuarded,
   openVerifiedSource,
   openWriteGuarded,
   resolvedPath,
   resolvedWithinRoot,
   rmGuarded,
   stripSlash,
   verifiedTargetRead,
   writeFileGuarded,
} from '../lib/fsx.js';
import {
   type TargetVerdict,
   DIST_REL,
   LEJI_DIR,
   VIEWER_REL,
   lejiRole,
   servablePath,
   writableTarget,
} from '../lib/layout.js';
import { type Manifest } from '../lib/manifest.js';
import { renderLintFindings } from '../lib/renderlint.js';
import { ACTIVE_EXTENSIONS, buildIndexHtml, generateViewer, resolvedProfilePages } from './viewer.js';

/**
 * `leji export` (and `leji viewer build`, its co-equal name for the same
 * operation): the static export pipeline, in its own module so its transitive
 * import set can be checked. Nothing here — and nothing it imports — pulls in
 * `node:http`/`https`/`net`/`dgram` or calls `fetch`; the local preview server
 * keeps all of that in `serve.ts`. The only subprocess the pipeline reaches is
 * `git`, through the mount status the manifest page renders, with lazy fetch
 * disabled. A module-graph test and a subprocess spy pin both claims.
 */

/** Protect-your-context warning shown by `leji export` and embedded in the exported index.html. */
export const PROTECT_WARNING =
   'This is your context layer (identity, invariants, decisions, sometimes sensitive internal knowledge). Host the exported folder behind internal authentication, not a public or shared bucket where it could be indexed or leaked. Active file types (.htm, .html, .js, .mjs, .xhtml) are left out of the exported content: a static host would serve them as same-origin documents that execute with no policy.';

/** The first bytes an export writes into its index.html, under either of the
 * command's names. A target directory carrying this marker is a previous export
 * and may be cleared; any other non-empty directory is somebody's content and is
 * never removed. The marker is a byte contract shared with the Go and Python
 * SDKs, so it reads as it has always read: an export written by any of the three,
 * under either name, is clearable by any of the three. */
const EXPORT_MARKER = '<!--\n  Leji viewer (leji viewer build).\n';

/** True when the export may clear `dir`: it is absent, an empty directory, or a
 * previous export. Anything else (a file, a populated directory the exporter did
 * not write) is content the tool has no business deleting.
 *
 * The marker decides a recursive delete, so it is read through the verified read: the
 * bytes that authorize clearing the tree come from the descriptor the rule cleared,
 * never from a pathname that a planted `index.html` link could point elsewhere. A
 * marker file that cannot be verified is simply not a previous export. */
function clearableExport(rootAbs: string, dir: string): boolean {
   let stat: fs.Stats;
   try {
      stat = fs.statSync(dir);
   } catch {
      return true; // absent
   }
   if (!stat.isDirectory()) return false;
   if (fs.readdirSync(dir).length === 0) return true;
   const marker = verifiedTargetRead(rootAbs, path.join(dir, 'index.html'), DIST_REL);
   return marker.status === 'regular' && marker.bytes.toString('utf8').startsWith(EXPORT_MARKER);
}

export interface BuildResult {
   out: string;
   findings: Finding[];
   /** True when the export tree was written. False when a pre-write check stopped
    * the run (an error finding, or a lint finding under `--strict`), in which case a
    * pre-existing target is byte-untouched. A refusal never returns: it throws. */
   wrote: boolean;
}

/** How one export run is driven. `strict` is the gate: a lint finding fails the run
 * before the target is cleared, mirroring `status --strict`. */
export interface BuildOptions {
   strict?: boolean;
}

/**
 * The lint-class rules `--strict` promotes to a failed run. The gate is rule-scoped
 * rather than "any finding": ordinary viewer warnings (an unresolved
 * `viewer.homepage`, say) stay warnings under `--strict`, and error findings fail
 * the run with or without it. The rendering lint's `render-unsupported` is the class
 * the flag exists for; a later lint rule joins it here.
 */
export const STRICT_LINT_RULES: ReadonlySet<string> = new Set(['render-unsupported']);

/**
 * Export a self-contained static viewer into `outRel` with the same URL contract
 * the local server serves (chrome at the web root, layer markdown under /content/),
 * so any static host serves it as-is. The pipeline is fixed: regenerate the chrome
 * (server flavor, always), run the pre-write checks, and only on a clean result
 * clear and write the target — so a failing check leaves a pre-existing export
 * byte-untouched. The exported index.html carries the protect-your-context warning
 * as a comment.
 */
export function buildViewer(root: string, manifest: Manifest, outRel?: string, opts: BuildOptions = {}): BuildResult {
   const gen = generateViewer(root, manifest);
   // Every path below is resolved, root included, so the path a check judges is the
   // path the write lands on: a symlinked component — or a case-variant spelling of
   // a reserved role on a case-insensitive filesystem — resolves to its real name
   // here, before the reservation and containment rules are applied to it.
   const rootAbs = resolvedPath(path.resolve(root)) ?? path.resolve(root);
   const rootDir = stripSlash(manifest.rootPath) || '.';
   const contentAbs = rootDir === '.' ? rootAbs : path.join(rootAbs, rootDir);
   const distAbs = path.join(rootAbs, DIST_REL);
   const requestedOut = outRel === undefined ? distAbs : path.resolve(rootAbs, outRel);
   // The ORIGINAL entry is judged before resolution, because a dangling symlink is a
   // standing entry and never an absence: resolved first, `.leji/dist -> missing` hands
   // every check below the link's MISSING destination, which reads as an unoccupied
   // target the export then clears and creates — a write through the link. An lstat or
   // stat that fails for any other reason (permission, I/O, a symlink loop) is not an
   // absence either; that path is refused by the resolution check just below.
   let danglingOut = false;
   try {
      danglingOut =
         fs.lstatSync(requestedOut, { throwIfNoEntry: false })?.isSymbolicLink() === true &&
         fs.statSync(requestedOut, { throwIfNoEntry: false }) === undefined;
   } catch {
      danglingOut = false;
   }
   if (danglingOut) {
      throw new Error(
         `refusing to build the viewer into "${outRel ?? DIST_REL}": it is a dangling symlink; remove the symlink or pass --out`,
      );
   }
   // Check-before-act: resolve the output target with native realpath BEFORE judging or writing it.
   // An unresolvable path (permission/I/O error, not mere absence) fails the check
   // rather than being rebuilt lexically and written to.
   const outAbs = resolvedPath(requestedOut);
   if (outAbs === null) {
      throw new Error(
         `refusing to build the viewer into "${outRel ?? DIST_REL}": the output path cannot be resolved (permission or I/O error)`,
      );
   }
   const outDisplay = path.relative(rootAbs, outAbs);

   // Never run the destructive export when generation failed: the viewer was not
   // written, and the rm -rf below could otherwise delete an escaped output path.
   if (gen.findings.some((f) => f.severity === 'error')) {
      return { out: outDisplay, findings: gen.findings, wrote: false };
   }
   // Check-before-act: the output target is validated against the write rule
   // BEFORE any clean or write, UNCONDITIONALLY — the default `.leji/dist` and a
   // caller `--out` alike, with no `outRel === undefined` fast path around it. It must
   // resolve INSIDE the repository (a `.leji/dist` symlinked out of the tree is
   // refused, not followed: the export folder is yours to copy wherever your host
   // reads it from), and either to its own role (`.leji/dist/`) or clear of `.leji/`
   // altogether; a DIFFERENT private role (`mounts`, `work`, `viewer`, a future one)
   // is refused. Resolved-vs-resolved, so neither a redirecting symlink nor a
   // `.LEJI/` spelling reaches a private role by looking like something else.
   const insideContent = (child: string, parent: string): boolean => child.startsWith(parent + path.sep);
   const outVerdict = writableTarget(rootAbs, outAbs, DIST_REL);
   if (!outVerdict.ok) {
      throw new Error(
         outVerdict.outsideRoot === true
            ? `refusing to build the viewer into "${outRel ?? DIST_REL}": it resolves outside the repository; every write stays inside the repository root, so copy the exported folder to your host instead`
            : `refusing to build the viewer into "${outRel ?? DIST_REL}": it resolves into ${LEJI_DIR}/${outVerdict.role} (private), reserved for the tool's own roles; remove the symlink or pass --out`,
      );
   }
   // The role reservation is EXACT for a caller-supplied `--out`: `.leji/dist` is the
   // one reserved name it may resolve to, never a path underneath it. (The check-before-act check
   // above allows a target anywhere inside its own role, which is what a generation
   // target needs; an export target is the single directory the role names.)
   if (outRel !== undefined && insideContent(outAbs, distAbs)) {
      throw new Error(
         `refusing to build the viewer into "${outRel}": ${DIST_REL} is the reserved export target itself, never a path inside it`,
      );
   }
   // These collision checks measure a caller-supplied `--out` only: the default
   // `.leji/dist` is answered by the role reservation above, and repository containment
   // is answered for both by the write rule. A `--out` must additionally stay clear of
   // the context root in BOTH directions, so an export never deletes governed content
   // or the layer that contains it, and it says so as a usage error before work starts.
   if (
      outRel !== undefined &&
      (outAbs === rootAbs ||
         outAbs === contentAbs ||
         !resolvedWithinRoot(rootAbs, outAbs) ||
         insideContent(outAbs, contentAbs) ||
         insideContent(contentAbs, outAbs))
   ) {
      throw new Error(
         `refusing to build the viewer into "${outRel}": --out must be a path inside the repository, and must not be the repository root, the context root, inside the context root, or a directory containing the context root`,
      );
   }
   // Never remove a directory this command did not write: the export clears a
   // previous export, and refuses anything else that is already occupied.
   if (!clearableExport(rootAbs, outAbs)) {
      throw new Error(
         `refusing to build the viewer into "${outRel ?? outDisplay}": the target exists and is neither empty nor a previous viewer export; remove it or pick another --out`,
      );
   }
   // The export reads the chrome by name; each file is realpath-checked against the
   // servable whitelist in `copyChrome` below, and the generation pass above already
   // refused a `.leji/viewer/` that does not resolve inside its own role — so the two
   // vectors that a separate identity check guarded are closed at their operations.
   const viewerAbs = path.join(rootAbs, VIEWER_REL);
   const outContent = path.join(outAbs, 'content');

   // Every destination act below goes through the write chokepoint with the export's
   // own role, one resolved check per act rather than one verdict inherited by a whole
   // tree: a descendant of the output directory swapped to a symlink after the target
   // was judged is caught at the file it would have redirected. A refusal is a hard
   // stop mid-run, since it can only mean the tree moved under the export.
   const refusedDest = (destAbs: string, verdict: TargetVerdict): Error => {
      const why =
         verdict.unresolvable === true
            ? 'cannot be resolved (permission or I/O error)'
            : verdict.outsideRoot === true
              ? 'resolves outside the repository'
              : `resolves into ${LEJI_DIR}/${verdict.role} (private)`;
      return new Error(`refusing to write "${path.relative(rootAbs, destAbs)}": it ${why}; the export is incomplete`);
   };
   const mkdirDest = (destAbs: string): void => {
      const made = mkdirpGuarded(rootAbs, destAbs, DIST_REL);
      if (!made.ok) throw refusedDest(destAbs, made);
   };
   const writeDest = (destAbs: string, bytes: string | Buffer): void => {
      const verdict = writeFileGuarded(rootAbs, destAbs, DIST_REL, bytes);
      if (!verdict.ok) throw refusedDest(destAbs, verdict);
   };

   // Check-before-act level-2 (boundary skip): a real, otherwise-servable read source withheld
   // because its RESOLVED path lands in a private role says why exactly once — on
   // stderr, never on stdout, never in the `--json` object — so the boundary answers
   // the "why isn't my doc showing?" question instead of dropping silently. A routine
   // dot-entry or ordinary symlink stays silent (a clean build has none of these);
   // this speaks only when the whitelist actually withheld something servable-looking.
   const boundarySkipped = new Set<string>();
   const boundarySkip = (childRel: string, real: string): void => {
      if (boundarySkipped.has(childRel)) return;
      boundarySkipped.add(childRel);
      process.stderr.write(
         `skipped ${childRel}: resolves into ${LEJI_DIR}/${lejiRole(rootAbs, real)} (private); not served or exported\n`,
      );
   };
   // Enumerate the content root — every file and directory /content will carry —
   // skipping ALL dotfiles/dot-dirs and symlinks: an export is a self-contained
   // snapshot, and a symlink or dot-path (.git, .secret.md) must never leak into
   // it. Explicit walk, not fs.cpSync, so the default output dir under the content
   // root isn't copied into itself. Enumerating BEFORE the clean below is what lets
   // the rendering lint read exactly the set the export will carry while the target
   // is still untouched; the copy then replays this list.
   const carried: { rel: string; dir: boolean }[] = [];
   const walkContent = (rel: string): void => {
      const srcDir = rel === '' ? contentAbs : path.join(contentAbs, rel);
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
         if (entry.name.startsWith('.')) continue;
         const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
         const childAbs = path.join(contentAbs, childRel);
         // A symlink is never exported (snapshot semantics). An ordinary one is a
         // routine, silent exclusion; one resolving into a private role is a boundary
         // skip — a servable-looking source withheld, named once on stderr.
         if (entry.isSymbolicLink()) {
            const real = resolvedPath(childAbs);
            if (real !== null && !servablePath(rootAbs, real)) boundarySkip(childRel, real);
            continue;
         }
         // Second line of defense behind the --out containment above: the export
         // never walks into itself, whatever the output path turns out to be.
         if (childAbs === outAbs) continue;
         // The servable-roots whitelist, mirrored on the export side: the only
         // `.leji/` content an export may read is `viewer/`, and it reads that by
         // name below. Independent of the dot-skip above, which also covers it; a
         // withheld servable-looking source is named once, exactly as a boundary skip.
         if (!servablePath(rootAbs, childAbs)) {
            const real = resolvedPath(childAbs);
            if (real !== null && !servablePath(rootAbs, real)) boundarySkip(childRel, real);
            continue;
         }
         if (entry.isDirectory()) {
            carried.push({ rel: childRel, dir: true });
            walkContent(childRel);
         } else if (entry.isFile()) {
            // Active types never ride along: the export is meant to be hosted, and
            // a static host would serve them as same-origin documents with no policy.
            if (ACTIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            carried.push({ rel: childRel, dir: false });
         }
      }
   };
   walkContent('');

   // A carried source is BOUND to its bytes at the moment it is used, not trusted from
   // the walk: between enumeration and use, the file — or any directory above it — can
   // become a symlink, and a read or copy by path then follows it past every check the
   // walk made. So each source is resolved natively, the RESOLVED path is judged
   // against the content root and the servable whitelist, and its bytes come from the
   // descriptor `fstat` proved a regular file: check and use hold the same inode. A
   // source that fails is dropped from the export with the same check-before-act semantics the walk
   // applies — silent for an ordinary redirect or a vanished file, named once on stderr
   // when it resolves into a private role.
   const contentReal = resolvedPath(contentAbs) ?? contentAbs;
   const carriedSource = (real: string): boolean =>
      servablePath(rootAbs, real) && (real === contentReal || real.startsWith(contentReal + path.sep));
   const openCarried = (childRel: string): number | null => {
      const { fd, real } = openVerifiedSource(path.join(contentAbs, childRel), carriedSource);
      if (fd === null && real !== null && !servablePath(rootAbs, real)) boundarySkip(childRel, real);
      return fd;
   };
   // The copy streams from that descriptor in bounded chunks rather than buffering the
   // file: only the linted markdown is held in memory, as before, and the bytes still
   // come from the checked inode instead of from the path.
   const copyFromDescriptor = (fd: number, dest: string): void => {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      // The destination is judged and opened by the chokepoint; the bytes then go
      // into that descriptor, so the copy can never reopen — or redirect to — a path.
      const opened = openWriteGuarded(rootAbs, dest, DIST_REL, { mode: fs.fstatSync(fd).mode & 0o777 });
      if (!opened.ok) throw refusedDest(dest, opened);
      const out = opened.fd;
      try {
         let read = fs.readSync(fd, buffer, 0, buffer.length, null);
         while (read > 0) {
            // A write may be short (a pipe-backed or unusual destination): the chunk is
            // written to completion, or the copy would silently truncate the file.
            let written = 0;
            while (written < read) written += fs.writeSync(out, buffer, written, read - written);
            read = fs.readSync(fd, buffer, 0, buffer.length, null);
         }
      } finally {
         fs.closeSync(out);
      }
   };

   // The rendering lint (`adoption/rendering.md`): every markdown document the
   // export will carry under content/, governed and reference alike, since anything
   // served can diverge across renderers. It reads the layer's own files — the
   // author's bytes at the author's line numbers, which is what a finding must point
   // at — never the generated chrome pages, which no one edits and every run rewrites.
   // Each document is read EXACTLY ONCE, and the bytes read are the bytes exported
   // below: the lint's verdict and the exported file are then the same document, with
   // no window in which one is judged and the other written. Only markdown is held
   // (the set the lint reads); every other file streams straight through the copy.
   const lint: Finding[] = [];
   const linted = new Map<string, Buffer>();
   for (const item of carried) {
      if (item.dir || path.extname(item.rel).toLowerCase() !== '.md') continue;
      const fd = openCarried(item.rel);
      if (fd === null) continue;
      let bytes: Buffer;
      try {
         bytes = fs.readFileSync(fd);
      } finally {
         fs.closeSync(fd);
      }
      linted.set(item.rel, bytes);
      const repoRel = rootDir === '.' ? item.rel : `${rootDir}/${item.rel}`;
      lint.push(...renderLintFindings(repoRel, bytes.toString('utf8')));
   }
   // Canonical order for the whole result: (path, line, rule, construct). The walk
   // is directory order, so the sort is what makes two runs — and three SDKs —
   // report the same sequence.
   const findings = sortFindings([...gen.findings, ...lint]);

   // The `--strict` gate, and the last thing before the first byte moves: the
   // refusals above are about the destination (exit 2, whatever the flags say),
   // while strict is about the layer — a lint finding fails the run, and because the
   // gate sits ahead of the clean below, a pre-existing export is left exactly as
   // it was. The pipeline is regenerate -> check -> clear-and-write, in that order,
   // so the promise holds for every check that lands in it later.
   if (opts.strict === true && findings.some((f) => STRICT_LINT_RULES.has(f.rule))) {
      return { out: outDisplay, findings, wrote: false };
   }

   // Clean rebuild so a removed source file never lingers in the export.
   const cleared = rmGuarded(rootAbs, outAbs, DIST_REL);
   if (!cleared.ok) throw refusedDest(outAbs, cleared);
   mkdirDest(outContent);
   for (const item of carried) {
      const dest = path.join(outContent, item.rel);
      if (item.dir) {
         mkdirDest(dest);
         continue;
      }
      // Markdown was read once already: the exported file is that snapshot, so what
      // the lint judged is what the export carries. A document the re-check dropped
      // has no snapshot and is not exported.
      if (path.extname(item.rel).toLowerCase() === '.md') {
         const bytes = linted.get(item.rel);
         if (bytes !== undefined) writeDest(dest, bytes);
         continue;
      }
      const fd = openCarried(item.rel);
      if (fd === null) continue;
      try {
         copyFromDescriptor(fd, dest);
      } finally {
         fs.closeSync(fd);
      }
   }
   // An inheriting agent profile exports resolved, exactly as the local server
   // renders it: the copied file is only its own half of the profile.
   for (const { rel, page } of resolvedProfilePages(rootAbs, manifest)) {
      const target = path.join(outContent, rel);
      if (!resolvedWithinRoot(outContent, target)) continue;
      writeDest(target, page);
   }
   // One generated chrome file into the export. A symlink is not a generated file:
   // `lstat` refuses it without following it, and the bytes come from the same guarded
   // open the content copy uses — the resolved path judged by the whitelist, the
   // descriptor proved to be that file — so nothing planted inside the chrome tree can
   // pull a private role's bytes along, and no copy reopens a checked path.
   const copyChrome = (srcAbs: string, destAbs: string): void => {
      const st = fs.lstatSync(srcAbs, { throwIfNoEntry: false });
      const { fd } =
         st !== undefined && st.isFile()
            ? openVerifiedSource(srcAbs, (real) => servablePath(rootAbs, real))
            : { fd: null };
      if (fd === null) {
         throw new Error(
            `refusing to export "${path.relative(rootAbs, srcAbs)}": the export carries only generated files from ${VIEWER_REL}/`,
         );
      }
      try {
         copyFromDescriptor(fd, destAbs);
      } finally {
         fs.closeSync(fd);
      }
   };
   // The chrome asset tree, entry by entry rather than fs.cpSync: dot-entries and
   // symlinks are skipped exactly as the content walk skips them.
   const copyChromeTree = (srcAbs: string, destAbs: string): void => {
      mkdirDest(destAbs);
      for (const entry of fs.readdirSync(srcAbs, { withFileTypes: true })) {
         if (entry.name.startsWith('.')) continue;
         if (entry.isSymbolicLink()) continue;
         const childSrc = path.join(srcAbs, entry.name);
         const childDest = path.join(destAbs, entry.name);
         if (entry.isDirectory()) copyChromeTree(childSrc, childDest);
         else if (entry.isFile()) copyChrome(childSrc, childDest);
      }
   };
   // The generated sidebar is served as if at the content root.
   copyChrome(path.join(viewerAbs, '_sidebar.md'), path.join(outContent, '_sidebar.md'));
   copyChrome(path.join(viewerAbs, '_manifest.md'), path.join(outContent, '_manifest.md'));
   // The viewer assets at the web root.
   copyChromeTree(path.join(viewerAbs, 'assets'), path.join(outAbs, 'assets'));
   // index.html at the web root, with the protect-your-context warning prepended.
   // The export flavor is GENERATED here, by the same code path that wrote the
   // served one, with the base that lets the tree host under a subpath: the
   // servable area never holds export-flavored bytes, and no emitted HTML is
   // rewritten after the fact. Its resolution warnings were reported by the
   // generation run above, so this pass discards them.
   const indexHtml = buildIndexHtml(root, manifest, '', []);
   writeDest(
      path.join(outAbs, 'index.html'),
      `<!--\n  Leji viewer (leji viewer build).\n  ${PROTECT_WARNING}\n-->\n${indexHtml}`,
   );

   return { out: outDisplay, findings, wrote: true };
}
