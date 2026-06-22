import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from './fsx.js';

function git(root: string, args: string[]): string | null {
   try {
      return execFileSync('git', ['-C', root, ...args], {
         encoding: 'utf8',
         stdio: ['ignore', 'pipe', 'ignore'],
         timeout: 10_000,
      });
   } catch {
      return null;
   }
}

/** Absolute path of the git worktree containing root, or null when not in git. */
export function gitToplevel(root: string): string | null {
   const out = git(root, ['rev-parse', '--show-toplevel']);
   return out ? out.trim() : null;
}

/**
 * Last commit date (YYYY-MM-DD) of a file, or null when untracked, modified
 * in the working tree, or outside a git repository. Callers fall back to a
 * current date so that regeneration and the eventual commit stay consistent.
 */
export function gitLastModified(root: string, relPath: string): string | null {
   const status = git(root, ['status', '--porcelain', '--', relPath]);
   if (status === null || status.trim() !== '') return null;
   const out = git(root, ['log', '-1', '--format=%cs', '--', relPath]);
   const date = out?.trim();
   return date ? date : null;
}

/** Content of the file at HEAD, or null (new file, no git, or no HEAD yet). */
export function gitShowHead(root: string, relPath: string): string | null {
   const top = gitToplevel(root);
   if (!top) return null;
   // realpath both sides: on macOS /tmp is a symlink and git reports the
   // resolved toplevel, which would break the relative-path computation.
   let resolvedTop: string;
   let resolvedFile: string;
   try {
      resolvedTop = fs.realpathSync(top);
      resolvedFile = fs.realpathSync(path.join(root, relPath));
   } catch {
      // The declared file was deleted (or top vanished): no HEAD baseline.
      return null;
   }
   const fromTop = toPosix(path.relative(resolvedTop, resolvedFile));
   return git(root, ['show', `HEAD:${fromTop}`]);
}

/**
 * Working-tree state for the init/adopt dirty-guard. Returns null when `root` is
 * not inside a git repository (no commit-backed undo exists, so the guard does
 * not apply); true when the tree is clean; false when there are uncommitted
 * changes (staged, unstaged, or untracked). The guard refuses to mutate a dirty
 * tree so its writes stay cleanly reversible with `git restore`/`git clean`.
 */
export function workingTreeClean(root: string): boolean | null {
   const top = gitToplevel(root);
   if (!top) return null;
   const status = git(top, ['status', '--porcelain', '--untracked-files=all']);
   if (status === null) return null;
   return status.trim() === '';
}
