import { type DetectedHost, detectHosts } from '../lib/detect.js';
import { type EcosystemReport, detectEcosystem, renderEcosystemLine } from '../lib/ecosystem.js';

/** Result of `detect`: the agent hosts available to this user, ranked, and the
 * dependency ecosystem of the repository itself. */
export interface DetectResult {
   hosts: DetectedHost[];
   ecosystem: EcosystemReport;
}

export function detectLayer(root: string): DetectResult {
   return { hosts: detectHosts({ root }), ecosystem: detectEcosystem(root) };
}

/** Human-readable detection report. */
export function renderDetect(result: DetectResult): string {
   const { hosts, ecosystem } = result;
   const ecoLine = renderEcosystemLine(ecosystem);
   if (hosts.length === 0) {
      return `No coding-agent hosts detected. Leji works without one; the onboarding brief still guides any agent you point at it.\n\n${ecoLine}`;
   }
   const lines = ['Detected agent hosts (strongest signal first):'];
   for (const h of hosts) {
      const signals = [h.onPath && 'binary on PATH', h.inRepo && 'config in repo', h.userConfig && 'user config']
         .filter(Boolean)
         .join(', ');
      const adapter = h.adapter ? `adapter ${h.adapter}` : 'directory-style adapter (wiring deferred)';
      lines.push(`   ${h.strength.padEnd(16)} ${h.name}: ${signals}; ${adapter}`);
   }
   // One line about the repository's own ecosystem: what would declare and run the
   // CLI here. The full offer block belongs to init/adopt, which can act on it.
   lines.push('', ecoLine);
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
