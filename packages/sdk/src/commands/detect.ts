import { type DetectedHost, detectHosts } from '../lib/detect.js';

/** Result of `detect`: the agent hosts available to this user, ranked. */
export interface DetectResult {
   hosts: DetectedHost[];
}

export function detectLayer(root: string): DetectResult {
   return { hosts: detectHosts({ root }) };
}

/** Human-readable detection report. */
export function renderDetect(hosts: DetectedHost[]): string {
   if (hosts.length === 0) {
      return 'No coding-agent hosts detected. Leji works without one; the onboarding brief still guides any agent you point at it.';
   }
   const lines = ['Detected agent hosts (strongest signal first):'];
   for (const h of hosts) {
      const signals = [h.onPath && 'binary on PATH', h.inRepo && 'config in repo', h.userConfig && 'user config']
         .filter(Boolean)
         .join(', ');
      const adapter = h.adapter ? `adapter ${h.adapter}` : 'directory-style adapter (wiring deferred)';
      lines.push(`   ${h.strength.padEnd(16)} ${h.name} — ${signals}; ${adapter}`);
   }
   lines.push('', 'Wire one into a fresh layer with: leji init --agent <name>');
   return lines.join('\n');
}
