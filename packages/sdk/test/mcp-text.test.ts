import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HOST_SPECS, MCP_JSON_CONFIG, mcpCommand, mcpJsonConfig } from '../dist/index.js';

// One instruction, three surfaces. The SDK owns the strings that register the local
// Leji MCP server: `leji start`'s preflight prints them, the MCP package README
// documents them, and the website publishes them. Anyone who follows one of the three
// must end up with the same registration, so the two documents QUOTE the SDK's bytes
// and this test is what keeps them from drifting apart word by word.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..', '..');
const readme = path.join(repoRoot, 'packages', 'mcp', 'README.md');
const sitePage = path.join(repoRoot, 'packages', 'site', 'src', 'pages', 'mcp.astro');

const claude = HOST_SPECS.find((s) => s.id === 'claude-code');
const codex = HOST_SPECS.find((s) => s.id === 'codex');

/** The commands and configuration a person is told to run, derived from the host
 * table rather than retyped: the shared project registration, the personal user-scope
 * one, Codex's user-level one, and the standard JSON every other client takes. */
function instructions(): { label: string; text: string }[] {
   assert.ok(claude?.mcpAdd && claude.mcpAddUser, 'Claude Code declares both scopes');
   assert.ok(codex?.mcpAdd, 'Codex declares its user-level add');
   return [
      { label: 'project-scope add', text: mcpCommand(claude, claude.mcpAdd) },
      { label: 'user-scope add', text: mcpCommand(claude, claude.mcpAddUser) },
      { label: 'codex add', text: mcpCommand(codex, codex.mcpAdd) },
      { label: 'JSON config', text: MCP_JSON_CONFIG },
   ];
}

for (const file of [readme, sitePage]) {
   const rel = path.relative(repoRoot, file);
   test(`${rel} quotes the SDK's MCP instructions byte for byte`, () => {
      const text = fs.readFileSync(file, 'utf8');
      for (const { label, text: want } of instructions()) {
         assert.ok(text.includes(want), `${rel} does not carry the ${label}:\n${want}`);
      }
   });
}

test('the JSON config is the one the standard clients take, and it parses', () => {
   const parsed = JSON.parse(MCP_JSON_CONFIG) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
   };
   assert.deepEqual(Object.keys(parsed.mcpServers), ['leji']);
   assert.equal(parsed.mcpServers.leji.command, 'npx');
   assert.deepEqual(parsed.mcpServers.leji.args, ['-y', '@leji-org/mcp']);
});

test('VS Code, which is how Copilot reads MCP servers, takes the `servers` shape', () => {
   const copilot = HOST_SPECS.find((s) => s.id === 'copilot');
   assert.equal(copilot?.mcpConfig?.path, '.vscode/mcp.json');
   assert.equal(copilot?.mcpConfig?.shape, 'servers');
});

test('every host Leji cannot register for names where its configuration lives', () => {
   for (const spec of HOST_SPECS) {
      if (spec.mcpAdd !== undefined) continue;
      assert.ok(spec.mcpConfig, `${spec.id} has neither a registration command nor a config path`);
      assert.ok(spec.mcpConfig.path.length > 0, `${spec.id} config path`);
      assert.ok(['project', 'user'].includes(spec.mcpConfig.scope), `${spec.id} config scope`);
      // The shape is not cosmetic: a block pasted under the wrong top-level key is a
      // file the client silently ignores.
      assert.ok(['mcpServers', 'servers'].includes(spec.mcpConfig.shape), `${spec.id} config shape`);
      const block = mcpJsonConfig(spec.mcpConfig.shape);
      assert.ok(block.includes(`"${spec.mcpConfig.shape}"`), `${spec.id} block key`);
      assert.deepEqual(Object.keys(JSON.parse(block)), [spec.mcpConfig.shape], `${spec.id} block`);
   }
});
