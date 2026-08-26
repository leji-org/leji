import { byteCompare } from './text.js';

/** Severity of a finding: `error` fails validation; `warning` does not. */
export type Severity = 'error' | 'warning';

/** A single validation result: one rule's outcome, optionally pointing at a path. */
export interface Finding {
   /** Stable rule identifier, shared verbatim with the Go and Python SDKs. */
   rule: string;
   severity: Severity;
   /** Repository-root-relative POSIX path the finding points at, when it has one. */
   path?: string;
   /** 1-based line within `path`, when the rule locates one (the rendering lint). */
   line?: number;
   /** The closed-token construct a rule names, when it carries one: what the three
    * SDKs compare on for `render-unsupported`, message text being outside the
    * contract. */
   construct?: string;
   message: string;
   /** Which act a rule with more than one failed at, and the resolver's own reason
    * for it: `"<act>: <reason>"`. Serialized immediately after `message`, so the
    * three SDKs emit the same bytes; absent for every rule that names no act. */
   detail?: string;
}

export interface FindingSummary {
   errors: number;
   warnings: number;
}

export function finding(rule: string, severity: Severity, message: string, path?: string, detail?: string): Finding {
   const base = path === undefined ? { rule, severity, message } : { rule, severity, path, message };
   return detail === undefined ? base : { ...base, detail };
}

/** Findings in canonical order: (path, line, rule, construct), message last as the
 * final tie-break. The line and construct keys carry the rendering lint's ordering
 * — two constructs reported on one line stay in the same order in all three SDKs —
 * and change nothing for a rule that locates neither. */
export function sortFindings(findings: Finding[]): Finding[] {
   return [...findings].sort((a, b) => {
      const p = byteCompare(a.path ?? '', b.path ?? '');
      if (p !== 0) return p;
      const l = (a.line ?? 0) - (b.line ?? 0);
      if (l !== 0) return l;
      const r = byteCompare(a.rule, b.rule);
      if (r !== 0) return r;
      const c = byteCompare(a.construct ?? '', b.construct ?? '');
      return c !== 0 ? c : byteCompare(a.message, b.message);
   });
}

export function summarize(findings: Finding[]): FindingSummary {
   let errors = 0;
   let warnings = 0;
   for (const f of findings) {
      if (f.severity === 'error') errors++;
      else warnings++;
   }
   return { errors, warnings };
}

export function hasErrors(findings: Finding[]): boolean {
   return findings.some((f) => f.severity === 'error');
}
