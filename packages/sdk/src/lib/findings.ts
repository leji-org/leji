export type Severity = 'error' | 'warning';

export interface Finding {
   /** Stable rule identifier, shared verbatim with the Python SDK. */
   rule: string;
   severity: Severity;
   /** Repository-root-relative POSIX path the finding points at, when it has one. */
   path?: string;
   message: string;
}

export interface FindingSummary {
   errors: number;
   warnings: number;
}

export function finding(rule: string, severity: Severity, message: string, path?: string): Finding {
   return path === undefined ? { rule, severity, message } : { rule, severity, path, message };
}

export function sortFindings(findings: Finding[]): Finding[] {
   return [...findings].sort((a, b) => {
      const pa = a.path ?? '';
      const pb = b.path ?? '';
      if (pa !== pb) return pa < pb ? -1 : 1;
      if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
      return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
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
