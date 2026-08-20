import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import { guardRoot, verifiedTargetRead, writeFileAtomicGuarded } from '../lib/fsx.js';
import { MANIFEST_FILENAME, type Manifest, replaceMountPinInManifestText } from '../lib/manifest.js';
import {
   type MountDecl,
   type StatusResult,
   comparePins,
   normalizeSource,
   refreshWitness,
   resolveDefaultRef,
   retainPinInStore,
   runGit,
   selectComparison,
   validTrackingRef,
} from '../lib/mounts.js';

/**
 * `leji mounts update-pin`: move ONE declared mount's pin forward to a commit the
 * resolver has already witnessed, showing the comparison before anything is
 * rewritten.
 *
 * Offline by default: the target is the last successfully observed witness, never a
 * claim of freshness. `--fetch` observes the declared source — and nothing else —
 * in three acts: retain the current pin, refresh the witness once, and (after the
 * gate passes) retain the target. Any of them failing REFUSES the move; a pin move
 * is not best-effort, which is `hydrate`'s model rather than this one.
 *
 * The manifest is rewritten by replacing the addressed pin's own byte span
 * (`replaceMountPinInManifestText`), never by reserializing, so the three SDKs
 * produce byte-identical output over any accepted layout.
 */

/** What the run did. `refused` is a stated outcome, never a crash. */
export type UpdatePinAction = 'updated' | 'unchanged' | 'dry-run' | 'refused';

export interface UpdatePinResult {
   mount: {
      name: string;
      sourceIdentity: string | null;
      /** The DECLARED tracking ref, never the default resolved under `--fetch` —
       * that one is reported as `pinReport.comparedRef`. */
      trackingRef: string | null;
      from: string | null;
      to: string | null;
   };
   pinReport: StatusResult['pinReport'] | null;
   action: UpdatePinAction;
   override: boolean;
   /** Stable code, present only when the run refused. */
   reason?: string;
   findings: Finding[];
   /** An internal refusal with no document to report: the manifest parsed and
    * validated, but the pin's own span could not be located or did not hold what
    * the comparison was computed against. Exit 2. */
   writeError?: string;
}

export interface UpdatePinOptions {
   name: string;
   to?: string;
   allowNonFastForward?: boolean;
   fetch?: boolean;
   dryRun?: boolean;
   /** Injectable observation clock, so tests and fixtures are stable. */
   now?: () => Date;
}

/** A pin at the length every human-facing line uses. */
export function shortOid(oid: string): string {
   return oid.slice(0, 12);
}

function declaredMount(manifest: Manifest, name: string): MountDecl | undefined {
   for (const m of manifest.federation?.mounts ?? []) {
      if (m.name === name) {
         return {
            name: m.name,
            source: m.source,
            pin: m.pin,
            ...(m.trackingRef === undefined ? {} : { trackingRef: m.trackingRef }),
         };
      }
   }
   return undefined;
}

/**
 * Move one mount's pin. Every refusal is a stated `reason` code plus an error
 * finding, so the exit status, the human line and the JSON document always agree.
 */
export function updatePinRun(root: string, manifest: Manifest, opts: UpdatePinOptions): UpdatePinResult {
   // One observation time for the whole run, as `status` takes one for its whole
   // execution.
   const observedAt = (opts.now ? opts.now() : new Date()).toISOString();
   const mount = declaredMount(manifest, opts.name);

   const refuse = (
      reason: string,
      partial: Partial<UpdatePinResult['mount']> = {},
      pinReport: StatusResult['pinReport'] | null = null,
   ): UpdatePinResult => ({
      mount: {
         name: opts.name,
         sourceIdentity: mount ? normalizeSource(mount.source) : null,
         trackingRef: mount?.trackingRef ?? null,
         from: mount?.pin ?? null,
         to: null,
         ...partial,
      },
      pinReport,
      action: 'refused',
      override: false,
      reason,
      findings: [finding(reason, 'error', MOUNT_UPDATE_PIN_REASONS[reason] ?? reason, opts.name)],
   });

   if (!mount) return refuse('mount-unknown');

   // (a) The declaration snapshot: the manifest's OWN values, kept for the
   // freshness check the rewrite makes against the verified bytes. `trackingRef`
   // is snapshotted as declared — absent must stay absent — while the ref the
   // comparison actually uses is tracked separately.
   const declaration = {
      name: mount.name,
      source: mount.source,
      pin: mount.pin,
      declaredTrackingRef: mount.trackingRef,
   };
   const identity = normalizeSource(mount.source);
   const degraded = (reason: string, comparedRef: string | null): StatusResult['pinReport'] => ({
      state: 'unknown',
      comparedRef,
      comparisonRepository: null,
      witnessProvenance: null,
      ancestryComplete: false,
      reason,
      observedAt,
   });
   if (identity === null) {
      return refuse(
         'mount-source-unnormalizable',
         {},
         degraded('mount-source-unnormalizable', mount.trackingRef ?? null),
      );
   }

   let effectiveRef: string;
   if (mount.trackingRef !== undefined) {
      if (!validTrackingRef(mount.trackingRef)) {
         return refuse('mount-tracking-ref-invalid', {}, degraded('mount-tracking-ref-invalid', mount.trackingRef));
      }
      effectiveRef = mount.trackingRef;
   } else if (!opts.fetch) {
      // Offline, the schema's "absent means the source's default branch" cannot be
      // honoured: resolving it needs the network this run was not given.
      return refuse('mount-no-tracking-ref', {}, degraded('mount-no-tracking-ref', null));
   } else {
      const resolved = resolveDefaultRef(mount.source);
      if ('error' in resolved || !validTrackingRef(resolved.ref)) {
         return refuse('mount-default-ref-unavailable', {}, degraded('mount-default-ref-unavailable', null));
      }
      effectiveRef = resolved.ref;
   }

   // (b i, ii) `--fetch`, declared source only, in order: retain the CURRENT pin so
   // the managed store holds both operands, then refresh the witness exactly once.
   // A failure here refuses the move — best-effort belongs to `hydrate`.
   if (opts.fetch) {
      const retained = retainPinInStore(root, mount, identity, mount.pin);
      if (retained.repo === null) {
         return refuse('mount-store-fetch-failed', {}, degraded('mount-store-fetch-failed', effectiveRef));
      }
      const witnessMount: MountDecl = { ...mount, trackingRef: effectiveRef };
      if (!refreshWitness(retained.repo, witnessMount, identity)) {
         return refuse('mount-witness-refresh-failed', {}, degraded('mount-witness-refresh-failed', effectiveRef));
      }
   }

   // (c) The comparison repository and the ONE witness snapshot this run uses for
   // the default target, the report, and the gate alike.
   const selection = selectComparison(root, mount, effectiveRef);
   if ('reason' in selection) return refuse(selection.reason, {}, degraded(selection.reason, effectiveRef));
   const { repo, comparisonRepository, witnessProvenance, tipOid } = selection;

   // (d) The target: an explicit `--to` must be held by the repository the
   // comparison ran in; otherwise the witness tip itself.
   const target = opts.to ?? tipOid;
   if (opts.to !== undefined && !runGit(['-C', repo, 'cat-file', '-e', `${opts.to}^{commit}`]).ok) {
      return refuse(
         'mount-target-unavailable',
         { to: opts.to },
         { ...degraded('mount-target-unavailable', effectiveRef), comparisonRepository, witnessProvenance },
      );
   }

   // (e) The report, computed from the same snapshot `status` would report from.
   const comparison = comparePins(repo, mount.pin, tipOid);
   const mountBlock = {
      name: mount.name,
      sourceIdentity: identity,
      trackingRef: mount.trackingRef ?? null,
      from: mount.pin,
      to: target,
   };
   if ('reason' in comparison) {
      return refuse(
         comparison.reason,
         { to: target },
         { ...degraded(comparison.reason, effectiveRef), comparisonRepository, witnessProvenance },
      );
   }
   const pinReport: StatusResult['pinReport'] = {
      state: comparison.state,
      behind: comparison.behind,
      ahead: comparison.ahead,
      comparedRef: effectiveRef,
      comparisonRepository,
      witnessProvenance,
      ancestryComplete: comparison.ancestryComplete,
      observedAt,
   };
   const settled = (action: UpdatePinAction, override: boolean, findings: Finding[]): UpdatePinResult => ({
      mount: mountBlock,
      pinReport,
      action,
      override,
      findings,
   });
   // A refusal after the comparison settled reports the comparison it refused on,
   // and carries whatever the run had already decided: an override exercised at the
   // gate is still reported by a run that then refused for another reason.
   const refuseSettled = (reason: string, override = false, warnings: Finding[] = []): UpdatePinResult => ({
      ...settled('refused', override, [
         finding(reason, 'error', MOUNT_UPDATE_PIN_REASONS[reason] ?? reason, mount.name),
         ...warnings,
      ]),
      reason,
   });

   // (f) The gate. Nothing to move is its own success, checked before ancestry:
   // asking whether a commit is an ancestor of itself is not the question.
   if (target === mount.pin) return settled('unchanged', false, []);
   let override = false;
   const ancestor = runGit(['-C', repo, 'merge-base', '--is-ancestor', mount.pin, target]);
   if (!ancestor.ok) {
      // Exit 1 is the answer "no"; anything else is the repository unable to answer.
      // A "no" from truncated history is not an answer either, so an incomplete
      // repository never yields the not-fast-forward refusal — nor does the
      // override bypass it.
      if (ancestor.code !== 1 || !comparison.ancestryComplete) return refuseSettled('mount-ancestry-incomplete');
      if (opts.to === undefined || !opts.allowNonFastForward) return refuseSettled('mount-pin-not-fast-forward');
      override = true;
   }
   const warnings: Finding[] = override
      ? [
           finding(
              'mount-pin-non-fast-forward-override',
              'warning',
              MOUNT_UPDATE_PIN_REASONS['mount-pin-non-fast-forward-override'],
              mount.name,
           ),
        ]
      : [];

   // (b iii) The target is retained only once the gate has passed, so a refused run
   // never establishes a pin ref for a commit it declined to move to.
   if (opts.fetch) {
      const retainedTarget = retainPinInStore(root, mount, identity, target);
      if (retainedTarget.repo === null) return refuseSettled('mount-store-fetch-failed', override, warnings);
   }

   // (g) `--dry-run` stops here. The store and network acts `--fetch` was asked for
   // have already happened; only the manifest rewrite is suppressed.
   if (opts.dryRun) return settled('dry-run', override, warnings);

   // (h) The rewrite, through the verified read the trust boundary requires.
   const rootReal = guardRoot(root);
   const manifestAbs = path.join(root, MANIFEST_FILENAME);
   const read = verifiedTargetRead(rootReal, manifestAbs, null);
   if (read.status !== 'regular') {
      return {
         ...settled('refused', override, warnings),
         writeError: `refusing to write through a symlink that escapes the target: "${MANIFEST_FILENAME}"`,
      };
   }
   const original = read.bytes.toString('utf8');
   // The bytes that were verified decide whether the declaration this comparison
   // was computed against is still the declaration on disk. Containment says WHICH
   // file was read; only this says it still says the same thing.
   if (!declarationUnchanged(original, declaration))
      return refuseSettled('mount-declaration-changed', override, warnings);
   let rewritten: { text: string; changed: boolean };
   try {
      rewritten = replaceMountPinInManifestText(original, mount.name, mount.pin, target);
   } catch (e) {
      return { ...settled('refused', override, warnings), writeError: (e as Error).message };
   }
   if (rewritten.changed) {
      const verdict = writeFileAtomicGuarded(rootReal, manifestAbs, null, rewritten.text);
      if (!verdict.ok) {
         return {
            ...settled('refused', override, warnings),
            writeError: `refusing to write outside the repository: "${MANIFEST_FILENAME}"`,
         };
      }
   }
   return settled('updated', override, warnings);
}

/** Does the verified manifest text still declare the mount this run compared? Only
 * the four fields that decided the selected repository, the target and the splice
 * are compared; ownership and routing metadata decide none of them. */
function declarationUnchanged(
   text: string,
   declaration: { name: string; source: string; pin: string; declaredTrackingRef: string | undefined },
): boolean {
   let parsed: Manifest;
   try {
      parsed = JSON.parse(text) as Manifest;
   } catch {
      return false;
   }
   const current = (parsed.federation?.mounts ?? []).find((m) => m.name === declaration.name);
   if (!current) return false;
   return (
      current.source === declaration.source &&
      current.pin === declaration.pin &&
      // Absent must stay absent: under `--fetch` the ref actually used may be the
      // source's advertised default, which the manifest never spelled.
      current.trackingRef === declaration.declaredTrackingRef
   );
}

/** Prose for this command's stable reason codes: `--json` emits the code, a person
 * reads the sentence. The codes above `mount-unknown` are shared with
 * `mounts status`, whose prose lives beside the status reasons. */
export const MOUNT_UPDATE_PIN_REASONS: Record<string, string> = {
   'mount-unknown': 'no mount with this name is declared',
   'mount-source-unnormalizable': 'source is not a normalizable locator',
   'mount-no-tracking-ref': "no trackingRef declared; the source's advertised default branch needs --fetch",
   'mount-tracking-ref-invalid': 'trackingRef is not a fully qualified branch or tag',
   'mount-default-ref-unavailable': 'the source advertises no default branch this run could resolve',
   'mount-pin-unavailable': 'no reachable object store holds the pin (declare a hint, or pass --fetch)',
   'mount-witness-unavailable':
      'no object store holding the pin resolves the witness ref; run `leji mounts hydrate --fetch`',
   'mount-source-ambiguous':
      'more than one submodule matches the source; declare an explicit hint in .leji/mounts.local.json',
   'mount-ancestry-incomplete': 'incomplete ancestry; the comparison repository cannot answer the range',
   'mount-store-fetch-failed': 'the requested fetch could not retain the commit in the managed store',
   'mount-witness-refresh-failed': 'the requested fetch could not refresh the managed witness ref',
   'mount-target-unavailable': 'the requested target commit is not held by the comparison repository',
   'mount-pin-not-fast-forward':
      'the target is not a descendant of the current pin (pass --to <oid> --allow-non-fast-forward to move anyway)',
   'mount-declaration-changed': 'leji.json changed while the comparison ran; nothing was written',
   'mount-pin-non-fast-forward-override': 'the pin was moved to a commit that is not a descendant of it',
};
