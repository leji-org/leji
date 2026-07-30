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
         env: {
            ...process.env,
            // `git status` refreshes and can rewrite `.git/index`, and a promisor
            // clone can reach the network from a command documented as offline and
            // non-mutating. The mounts resolver already sets both; these are the same
            // guarantees for every other read-only git call.
            GIT_OPTIONAL_LOCKS: '0',
            GIT_NO_LAZY_FETCH: '1',
         },
      });
   } catch {
      return null;
   }
}

/** The origin remote URL, or null when not in git or no origin is configured. */
export function gitOriginUrl(root: string): string | null {
   const out = git(root, ['remote', 'get-url', 'origin']);
   return out ? out.trim() : null;
}

/** Absolute path of the git worktree containing root, or null when not in git. */
export function gitToplevel(root: string): string | null {
   const out = git(root, ['rev-parse', '--show-toplevel']);
   return out ? out.trim() : null;
}

/**
 * Last commit date (YYYY-MM-DD) of a file, or null when untracked, modified in
 * the working tree, or outside git. Callers fall back to the current date.
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
   // realpath both sides: on macOS /tmp is a symlink and git reports the resolved
   // toplevel, which would break the relative-path computation.
   let resolvedTop: string;
   let resolvedFile: string;
   try {
      resolvedTop = fs.realpathSync(top);
      resolvedFile = fs.realpathSync(path.join(root, relPath));
   } catch {
      return null; // declared file deleted (or top vanished): no HEAD baseline
   }
   const fromTop = toPosix(path.relative(resolvedTop, resolvedFile));
   return git(root, ['show', `HEAD:${fromTop}`]);
}

/**
 * Tracked files under a repository-relative path, or null when `root` is not in
 * git. Backs the onboarding-workspace preflight: `.leji/` must hold no tracked
 * files before private artifacts may land there.
 */
export function trackedUnder(root: string, rel: string): string[] | null {
   const top = gitToplevel(root);
   if (!top) return null;
   const out = git(root, ['ls-files', '--', rel]);
   if (out === null) return null;
   return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
}

/**
 * Working-tree state for the init/adopt dirty-guard. null when `root` is not in
 * git (no commit-backed undo, so the guard does not apply); true when clean;
 * false on any uncommitted change (staged, unstaged, or untracked). The guard
 * refuses to mutate a dirty tree so writes stay reversible via git restore/clean.
 */
export function workingTreeClean(root: string): boolean | null {
   const top = gitToplevel(root);
   if (!top) return null;
   const status = git(top, ['status', '--porcelain', '--untracked-files=all']);
   if (status === null) return null;
   return status.trim() === '';
}
