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
   // `--agent` names the host Leji launches, and only claude-code and codex accept
   // an inline prompt; suggesting `--agent <name>` for every detected host offered
   // a command the flag rejects.
   lines.push(
      '',
      '--agent takes a launchable host, claude-code or codex: leji init --agent claude-code, leji start --agent codex.',
      'Any other host above enters the layer through its vendor-file redirect.',
   );
   return lines.join('\n');
}
