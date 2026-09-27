// The teardown's promise, judged on the server that once broke it: the site
// preview, started and taken down through the runner's own functions. Astro moves
// its preview into a detached session when it detects an AI agent, so the test
// sets an agent's variable while the preview starts: the run's fix has to hold
// under an agent, and this way a terminal or CI run checks it too.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { portFree, serverPlan, startServer, teardown } from '../run.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The pids listening on a port, or null where `lsof` cannot say (Windows, or a
 * machine without it). */
function listeners(port) {
   if (process.platform === 'win32') return null;
   const result = spawnSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
   if (result.error) return null;
   return result.stdout.split('\n').filter(Boolean).map(Number);
}

test(
   "the site preview is the runner's own child, and its port is free once teardown returns",
   { timeout: 90_000 },
   async (t) => {
      if (!fs.existsSync(path.join(repoRoot, 'packages/site/dist/index.html'))) {
         t.skip('packages/site/dist is not built: run `npm run build -w packages/site` first');
         return;
      }
      const site = serverPlan().find((server) => server.name === 'site');
      assert.ok(site, 'the runner no longer plans a server named "site"');
      assert.ok(await portFree(site.port), `port ${site.port} is already in use; stop whatever holds it and run again`);

      const agent = process.env.CLAUDECODE;
      process.env.CLAUDECODE = '1';
      let record;
      try {
         record = await startServer(site);
         assert.equal(record.alive, true, 'the preview exited after it listened: it left the child the runner spawned');
         const holders = listeners(site.port);
         if (holders === null) t.diagnostic('lsof is unavailable here, so the listener pid is not checked');
         else
            assert.deepEqual(
               holders,
               [record.child.pid],
               `port ${site.port} is held by a process other than the child`,
            );
      } finally {
         if (agent === undefined) delete process.env.CLAUDECODE;
         else process.env.CLAUDECODE = agent;
         await teardown();
      }

      assert.equal(record.alive, false, 'the preview is still running after teardown');
      assert.equal(await portFree(site.port), true, `port ${site.port} is still in use after teardown`);
   },
);
