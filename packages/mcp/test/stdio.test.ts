import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const binPath = path.join(repoRoot, 'packages', 'mcp', 'dist', 'bin.js');
const validLayer = path.join(repoRoot, 'fixtures', 'valid-minimal-core');

test('stdio: real process serves tools and conformance over a spawned transport', async () => {
   const stderrChunks: string[] = [];
   const transport = new StdioClientTransport({ command: process.execPath, args: [binPath], stderr: 'pipe' });
   transport.stderr?.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

   const client = new Client({ name: 'leji-mcp-stdio-test', version: '0' });
   // A successful connect() means the initialize handshake parsed cleanly, which
   // is only possible if stdout carried nothing but framed JSON-RPC.
   await client.connect(transport);

   const { tools } = await client.listTools();
   assert.equal(tools.length, 7);

   const { resources } = await client.listResources();
   assert.ok(resources.some((r) => r.uri === 'leji://spec/full'));

   const validate = await client.callTool({ name: 'validate_layer', arguments: { root: validLayer } });
   assert.equal((validate.structuredContent as { ok: boolean }).ok, true);

   const score = await client.callTool({ name: 'score_conformance', arguments: { root: validLayer } });
   assert.equal((score.structuredContent as { verifiedLevel: string }).verifiedLevel, 'core');

   await client.close();

   // The startup banner is diagnostics: it must go to stderr, never stdout.
   assert.match(stderrChunks.join(''), /leji-mcp .* ready on stdio/);
});

// Direct, low-level check that stdout is pure JSON-RPC: drive the raw process and
// assert every non-empty stdout line parses as a jsonrpc 2.0 message.
test('stdio: every stdout line is a JSON-RPC 2.0 message', async () => {
   const child = spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'pipe'] });
   let stdout = '';
   child.stdout.setEncoding('utf8');
   child.stdout.on('data', (d) => (stdout += d));

   const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
   };
   child.stdin.write(JSON.stringify(initialize) + '\n');

   const deadline = Date.now() + 5000;
   while (!stdout.includes('"id":1') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
   }
   child.kill();

   const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
   assert.ok(lines.length > 0, 'server produced a stdout response');
   const messages = lines.map((l) => JSON.parse(l));
   for (const m of messages) assert.equal(m.jsonrpc, '2.0');
   const initResult = messages.find((m) => m.id === 1);
   assert.ok(initResult?.result?.serverInfo, 'initialize returned serverInfo');
   assert.equal(initResult.result.serverInfo.name, 'leji');
});
