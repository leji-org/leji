import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const validLayer = path.join(repoRoot, 'fixtures', 'valid-minimal-core');

// Connect an in-memory client to the server over a linked transport pair.
async function connect(): Promise<Client> {
   const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
   const server = createServer('test');
   await server.connect(serverTransport);
   const client = new Client({ name: 'leji-mcp-test', version: '0' });
   await client.connect(clientTransport);
   return client;
}

type Structured = Record<string, unknown>;
function structured(result: { structuredContent?: unknown }): Structured {
   assert.ok(result.structuredContent, 'expected structuredContent');
   return result.structuredContent as Structured;
}

test('lists the seven read-only tools', async () => {
   const client = await connect();
   const { tools } = await client.listTools();
   const names = tools.map((t) => t.name).sort();
   assert.deepEqual(names, [
      'explain_conformance',
      'fetch_schema',
      'fetch_spec_doc',
      'score_conformance',
      'search_spec',
      'validate_layer',
      'validate_manifest',
   ]);
   for (const t of tools) assert.ok(t.outputSchema, `${t.name} declares an output schema`);
   await client.close();
});

test('lists spec, schema, and cli resources plus templates', async () => {
   const client = await connect();
   const { resources } = await client.listResources();
   const uris = resources.map((r) => r.uri);
   assert.ok(uris.includes('leji://spec/full'));
   assert.ok(uris.includes('leji://cli/help'));
   assert.ok(uris.includes('leji://spec/conformance'));
   assert.ok(uris.includes('leji://schema/context-manifest'));
   const { resourceTemplates } = await client.listResourceTemplates();
   const templates = resourceTemplates.map((t) => t.uriTemplate);
   assert.ok(templates.includes('leji://spec/{id}'));
   assert.ok(templates.includes('leji://schema/{name}'));
   await client.close();
});

test('reads a spec document, a schema, and the cli help resource', async () => {
   const client = await connect();
   const spec = await client.readResource({ uri: 'leji://spec/conformance' });
   assert.match(String(spec.contents[0].text), /# Conformance/);
   assert.equal(spec.contents[0].mimeType, 'text/markdown');

   const schema = await client.readResource({ uri: 'leji://schema/context-manifest' });
   const parsed = JSON.parse(String(schema.contents[0].text));
   assert.equal(typeof parsed, 'object');
   assert.equal(schema.contents[0].mimeType, 'application/json');

   const help = await client.readResource({ uri: 'leji://cli/help' });
   assert.match(String(help.contents[0].text), /Usage:/);

   await assert.rejects(() => client.readResource({ uri: 'leji://spec/does-not-exist' }));
   await client.close();
});

test('search_spec finds matching sections', async () => {
   const client = await connect();
   const res = await client.callTool({ name: 'search_spec', arguments: { query: 'conformance' } });
   const out = structured(res);
   assert.ok(Array.isArray(out.matches));
   assert.ok((out.matches as unknown[]).length > 0);
   assert.equal(out.truncated, false);
   await client.close();
});

test('fetch_spec_doc returns content and errors on unknown id', async () => {
   const client = await connect();
   const okRes = await client.callTool({ name: 'fetch_spec_doc', arguments: { id: 'conformance' } });
   assert.match(String(structured(okRes).content), /# Conformance/);

   const full = await client.callTool({ name: 'fetch_spec_doc', arguments: { id: 'full' } });
   assert.match(String(structured(full).content), /Conformance/);

   const bad = await client.callTool({ name: 'fetch_spec_doc', arguments: { id: 'nope' } });
   assert.equal(bad.isError, true);
   await client.close();
});

test('fetch_schema returns JSON and errors on unknown name', async () => {
   const client = await connect();
   const okRes = await client.callTool({ name: 'fetch_schema', arguments: { name: 'context-manifest' } });
   assert.equal(typeof JSON.parse(String(structured(okRes).schema)), 'object');

   const bad = await client.callTool({ name: 'fetch_schema', arguments: { name: 'nope' } });
   assert.equal(bad.isError, true);
   await client.close();
});

test('validate_manifest validates inline JSON and reports findings', async () => {
   const client = await connect();
   const good = JSON.stringify({
      leji: '1.0',
      name: 'inline',
      rootPath: 'docs/',
      bootProfilePath: 'docs/boot-profile.md',
      categories: { domain: { paths: ['docs/domain/'] }, decisions: { paths: ['docs/decisions/'] } },
      owners: { primary: { name: 'Inline Owner' } },
   });
   const okRes = structured(await client.callTool({ name: 'validate_manifest', arguments: { manifestJson: good } }));
   assert.equal(okRes.ok, true);
   assert.deepEqual(okRes.findings, []);

   const badSchema = structured(
      await client.callTool({ name: 'validate_manifest', arguments: { manifestJson: '{"leji":"1.0","name":"x"}' } }),
   );
   assert.equal(badSchema.ok, false);

   const badJson = await client.callTool({ name: 'validate_manifest', arguments: { manifestJson: '{not json' } });
   assert.equal(badJson.isError, true);
   await client.close();
});

test('validate_layer validates a fixture layer and errors on a bad root', async () => {
   const client = await connect();
   const res = structured(await client.callTool({ name: 'validate_layer', arguments: { root: validLayer } }));
   assert.equal(res.ok, true);
   assert.deepEqual(res.findings, []);

   const bad = await client.callTool({
      name: 'validate_layer',
      arguments: { root: path.join(repoRoot, 'no-such-dir') },
   });
   assert.equal(bad.isError, true);
   await client.close();
});

test('score_conformance and explain_conformance report the verified level', async () => {
   const client = await connect();
   const score = structured(await client.callTool({ name: 'score_conformance', arguments: { root: validLayer } }));
   assert.equal(score.claimedLevel, 'core');
   assert.equal(score.verifiedLevel, 'core');
   assert.ok(Array.isArray(score.items));

   const explain = structured(await client.callTool({ name: 'explain_conformance', arguments: { root: validLayer } }));
   assert.equal(explain.verifiedLevel, 'core');
   assert.match(String(explain.explanation), /core/);
   await client.close();
});

test('missing required arguments produce a tool error, not a crash', async () => {
   const client = await connect();
   const res = await client.callTool({ name: 'validate_layer', arguments: {} });
   assert.equal(res.isError, true);
   await client.close();
});
