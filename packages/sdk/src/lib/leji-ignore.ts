import * as path from 'node:path';
import { guardRoot, verifiedTargetRead, writeFileGuarded } from './fsx.js';
import { LEJI_IGNORE_REL } from './layout.js';

/**
 * The tool ignores its own directory from inside. A layer whose root `.gitignore`
 * never received the `.leji/` line (adopted before the unified layout, or written
 * by hand) otherwise grows an untracked generated tree at every command; one file
 * inside `.leji/` closes that without touching the repository's own ignore rules.
 *
 * The file is written the first time a command creates a role under `.leji/`, and
 * only there: nothing read-only ever creates it. What stands at the target decides
 * the act, read through the verified read rather than a pathname check, so a file
 * swapped between the look and the write is never written through.
 */

/** The whole file: ignore everything under `.leji/`, this file included. Nothing
 * in that tree is committed by design, so the rule needs no exceptions and never
 * grows any. A byte contract shared with the Go and Python SDKs. */
export const LEJI_IGNORE_CONTENT = '*\n';

/** What a run says, once, when it left an existing file alone. Frozen text, on
 * stderr under every output mode: it is an advisory about the repository, never
 * part of a `--json` document. */
export const LEJI_IGNORE_NOTICE: string = `leji: ${LEJI_IGNORE_REL} exists and was left as is (expected content: *)`;

/**
 * One invocation's notice state. Created at the CLI command entry point and passed
 * down every call path that can create a role, so one invocation says it once
 * however many roles it establishes: `leji export` creates the viewer chrome and
 * the export output and still notices once. A directly callable SDK function takes
 * it as an optional parameter and passes it to whatever it nests; a direct caller
 * that supplies none gets a context local to that call, so the documented behavior
 * there is at most one notice per call. Deliberately not a module global: that
 * would be process-scoped, and a long-lived host or a second repository in the same
 * process would inherit a state that is not its own.
 */
export interface LejiIgnoreContext {
   noticed: boolean;
}

/** A fresh invocation context. */
export function newLejiIgnoreContext(): LejiIgnoreContext {
   return { noticed: false };
}

/**
 * What one call did:
 *
 * - `created`: nothing stood there and the file was created exclusively;
 * - `present`: a regular file already holds exactly these bytes;
 * - `left-as-is`: a regular file holds something else; it is untouched and the
 *   notice was emitted (once per context);
 * - `exists`: an entry appeared between the read and the exclusive create, so the
 *   create found it and wrote nothing;
 * - `refused`: the boundary refused the target (a symlink at `.leji` or at the
 *   file, a non-regular entry, a containment failure); nothing was written.
 */
export type LejiIgnoreOutcome = 'created' | 'present' | 'left-as-is' | 'exists' | 'refused';

/**
 * Ensure `.leji/.gitignore` exists, at the one exception the write rule declares.
 *
 * Idempotent, and safe to call from every role establisher: the decision comes from
 * {@link verifiedTargetRead} (bytes read from the descriptor the rule cleared),
 * and the create is exclusive through the guarded write path, so neither branch
 * rests on a pathname that could change underneath it. A refusal is returned rather
 * than thrown; the calling command reports it the way it reports any refused write.
 */
export function ensureLejiIgnoreFile(root: string, ctx: LejiIgnoreContext = newLejiIgnoreContext()): LejiIgnoreOutcome {
   const rootReal = guardRoot(root);
   const abs = path.join(rootReal, LEJI_IGNORE_REL);
   // Two looks at most. Another run creating this same file lands between the first
   // look and its verification, and a standing entry that could not be verified is
   // `unverifiable`, which here is an ordinary concurrent create rather than a
   // refusal, so it is looked at once more and read as what it now is. Anything this
   // run genuinely cannot verify refuses on the second look exactly as on the first,
   // and every other refusal (a symlink, a non-regular entry, a containment failure)
   // is final at the first.
   for (let look = 0; look < 2; look += 1) {
      const standing = verifiedTargetRead(rootReal, abs, null);
      if (standing.status === 'refused') {
         if (standing.reason === 'unverifiable' && look === 0) continue;
         return 'refused';
      }
      if (standing.status === 'regular') {
         if (standing.bytes.toString('utf8') === LEJI_IGNORE_CONTENT) return 'present';
         // An empty file is the other half of that concurrent create: the winner has
         // opened it exclusively and not yet written its two bytes. Looking again
         // answers what it holds; a file that is genuinely empty answers the same
         // thing twice and is left alone like any other content.
         if (standing.bytes.length === 0 && look === 0) continue;
         // Someone else's file: never merged, never rewritten. The run says so once
         // and leaves the bytes exactly as they are.
         if (!ctx.noticed) {
            ctx.noticed = true;
            process.stderr.write(`${LEJI_IGNORE_NOTICE}\n`);
         }
         return 'left-as-is';
      }
      const verdict = writeFileGuarded(rootReal, abs, null, LEJI_IGNORE_CONTENT, { exclusive: true });
      if (verdict.exists === true) return 'exists';
      return verdict.ok ? 'created' : 'refused';
   }
   return 'refused';
}
