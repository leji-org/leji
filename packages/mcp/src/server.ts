import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
   CallToolRequestSchema,
   ListResourceTemplatesRequestSchema,
   ListResourcesRequestSchema,
   ListToolsRequestSchema,
   ReadResourceRequestSchema,
   type CallToolResult,
   type ReadResourceResult,
   type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
   conformanceReport,
   renderExplain,
   renderUsage,
   validateLayer,
   validateManifestObject,
   type Finding,
} from '@leji-org/leji';
import { readSchema, readSpec, readSpecFull, schemaNames, specIds, specSections } from './assets.js';
import { resolveRoot } from './safety.js';

const SERVER_NAME = 'leji';

// Cap search results so a broad query cannot return the whole spec as one blob.
const MAX_SEARCH_MATCHES = 50;

const INSTRUCTIONS =
   'Leji: the shared context layer for AI-native teams. Use the resources to read the spec and JSON Schemas, and the tools to search the spec and to validate / score a context layer on disk. All tools are read-only.';

// --- reusable JSON Schema fragments ---
// `type: 'object'` stays a literal (Tool's input/output schema require it); the
// arrays stay mutable string[] (Tool's `required` is mutable), so no `as const`.
const rootInput = {
   type: 'object' as const,
   properties: {
      root: { type: 'string', description: 'Path to the repository root of the context layer (contains leji.json).' },
   },
   required: ['root'],
   additionalProperties: false,
};

const findingSchema = {
   type: 'object',
   properties: {
      rule: { type: 'string' },
      severity: { type: 'string', enum: ['error', 'warning'] },
      path: { type: 'string' },
      message: { type: 'string' },
   },
   required: ['rule', 'severity', 'message'],
};

const summarySchema = {
   type: 'object',
   properties: { errors: { type: 'integer' }, warnings: { type: 'integer' } },
   required: ['errors', 'warnings'],
};

const validationOutput = {
   type: 'object' as const,
   properties: {
      ok: { type: 'boolean' },
      findings: { type: 'array', items: findingSchema },
      summary: summarySchema,
   },
   required: ['ok', 'findings', 'summary'],
};

const TOOLS: Tool[] = [
   {
      name: 'search_spec',
      description: 'Find Leji specification sections whose heading or body match a query (case-insensitive).',
      inputSchema: {
         type: 'object',
         properties: { query: { type: 'string', description: 'Text to search for across the spec.' } },
         required: ['query'],
         additionalProperties: false,
      },
      outputSchema: {
         type: 'object',
         properties: {
            matches: {
               type: 'array',
               items: {
                  type: 'object',
                  properties: { specId: { type: 'string' }, heading: { type: 'string' }, excerpt: { type: 'string' } },
                  required: ['specId', 'heading', 'excerpt'],
               },
            },
            truncated: { type: 'boolean' },
         },
         required: ['matches', 'truncated'],
      },
   },
   {
      name: 'fetch_spec_doc',
      description: 'Return the full markdown of one Leji spec document by id (use "full" for the whole spec).',
      inputSchema: {
         type: 'object',
         properties: { id: { type: 'string', description: 'Spec document id, e.g. "conformance", or "full".' } },
         required: ['id'],
         additionalProperties: false,
      },
      outputSchema: {
         type: 'object',
         properties: { id: { type: 'string' }, content: { type: 'string' } },
         required: ['id', 'content'],
      },
   },
   {
      name: 'fetch_schema',
      description: 'Return one Leji JSON Schema by name as JSON text.',
      inputSchema: {
         type: 'object',
         properties: { name: { type: 'string', description: 'Schema name, e.g. "context-manifest".' } },
         required: ['name'],
         additionalProperties: false,
      },
      outputSchema: {
         type: 'object',
         properties: { name: { type: 'string' }, schema: { type: 'string' } },
         required: ['name', 'schema'],
      },
   },
   {
      name: 'validate_manifest',
      description:
         'Validate a leji.json manifest supplied inline as JSON text (spec line + manifest schema). Read-only.',
      inputSchema: {
         type: 'object',
         properties: { manifestJson: { type: 'string', description: 'The leji.json manifest as a JSON string.' } },
         required: ['manifestJson'],
         additionalProperties: false,
      },
      outputSchema: validationOutput,
   },
   {
      name: 'validate_layer',
      description:
         'Validate the Leji context layer rooted at `root`: manifest, boot profile, categories, declared artifacts, and conformance prerequisites. Read-only.',
      inputSchema: rootInput,
      outputSchema: validationOutput,
   },
   {
      name: 'score_conformance',
      description:
         'Score the context layer rooted at `root` against the Leji conformance checklists, reporting claimed vs verified level. Read-only.',
      inputSchema: rootInput,
      outputSchema: {
         type: 'object',
         properties: {
            claimedLevel: { type: ['string', 'null'] },
            verifiedLevel: { type: ['string', 'null'] },
            items: {
               type: 'array',
               items: {
                  type: 'object',
                  properties: {
                     id: { type: 'string' },
                     level: { type: 'string' },
                     description: { type: 'string' },
                     status: { type: 'string', enum: ['pass', 'fail', 'manual'] },
                     detail: { type: 'string' },
                  },
                  required: ['id', 'level', 'description', 'status'],
               },
            },
            findings: { type: 'array', items: findingSchema },
         },
         required: ['claimedLevel', 'verifiedLevel', 'items', 'findings'],
      },
   },
   {
      name: 'explain_conformance',
      description:
         'Explain the conformance result for the context layer rooted at `root`: what is verified and what the next level needs. Read-only.',
      inputSchema: rootInput,
      outputSchema: {
         type: 'object',
         properties: {
            claimedLevel: { type: ['string', 'null'] },
            verifiedLevel: { type: ['string', 'null'] },
            explanation: { type: 'string' },
         },
         required: ['claimedLevel', 'verifiedLevel', 'explanation'],
      },
   },
];

// --- result helpers ---
function summarize(findings: Finding[]): { errors: number; warnings: number } {
   const errors = findings.filter((f) => f.severity === 'error').length;
   return { errors, warnings: findings.length - errors };
}

function ok(structuredContent: Record<string, unknown>, text: string): CallToolResult {
   return { content: [{ type: 'text', text }], structuredContent };
}

function fail(message: string): CallToolResult {
   return { content: [{ type: 'text', text: `error: ${message}` }], isError: true };
}

function findingsText(findings: Finding[]): string {
   return findings.map((f) => `${f.severity} ${f.rule}${f.path ? ` ${f.path}` : ''}: ${f.message}`).join('\n');
}

function strArg(args: Record<string, unknown>, key: string): string | null {
   const v = args[key];
   return typeof v === 'string' && v.length > 0 ? v : null;
}

// --- tool handlers ---
function searchSpec(query: string): CallToolResult {
   const q = query.toLowerCase();
   const all = specIds().flatMap((id) => specSections(id, readSpec(id)!));
   const hits = all.filter((s) => s.heading.toLowerCase().includes(q) || s.body.toLowerCase().includes(q));
   const truncated = hits.length > MAX_SEARCH_MATCHES;
   const matches = hits.slice(0, MAX_SEARCH_MATCHES).map((s) => ({
      specId: s.specId,
      heading: s.heading,
      excerpt: s.body.length > 500 ? s.body.slice(0, 500) + '…' : s.body,
   }));
   const text = matches.length
      ? matches.map((m) => `spec/${m.specId}: ${m.heading}`).join('\n')
      : `no matches for "${query}"`;
   return ok({ matches, truncated }, text);
}

function fetchSpecDoc(id: string): CallToolResult {
   const content = id === 'full' ? readSpecFull() : readSpec(id);
   if (content === null) return fail(`unknown spec document: ${id} (known: ${['full', ...specIds()].join(', ')})`);
   return ok({ id, content }, content);
}

function fetchSchema(name: string): CallToolResult {
   const schema = readSchema(name);
   if (schema === null) return fail(`unknown schema: ${name} (known: ${schemaNames().join(', ')})`);
   return ok({ name, schema }, schema);
}

function validateManifestTool(manifestJson: string): CallToolResult {
   let data: unknown;
   try {
      data = JSON.parse(manifestJson);
   } catch (e) {
      return fail(`manifestJson is not valid JSON: ${(e as Error).message}`);
   }
   const { findings } = validateManifestObject(data);
   const summary = summarize(findings);
   const text = `validate_manifest: ${summary.errors === 0 ? 'ok' : 'failed'} (${summary.errors} errors, ${summary.warnings} warnings)${findings.length ? '\n' + findingsText(findings) : ''}`;
   return ok({ ok: summary.errors === 0, findings, summary }, text);
}

// The root-based tools wrap their whole body: resolveRoot, the SDK call, and any
// filesystem access can all throw on a hostile or racy input, and every such
// failure must surface as a tool result (isError), never an unhandled JSON-RPC
// handler exception.
function validateLayerTool(root: string): CallToolResult {
   try {
      const { findings } = validateLayer(resolveRoot(root));
      const summary = summarize(findings);
      const text = `validate: ${summary.errors === 0 ? 'ok' : 'failed'} (${summary.errors} errors, ${summary.warnings} warnings)${findings.length ? '\n' + findingsText(findings) : ''}`;
      return ok({ ok: summary.errors === 0, findings, summary }, text);
   } catch (e) {
      return fail((e as Error).message);
   }
}

function scoreConformanceTool(root: string): CallToolResult {
   try {
      const result = conformanceReport(resolveRoot(root));
      const text = `conformance: verified ${result.verifiedLevel ?? 'none'} (claimed ${result.claimedLevel ?? 'none'})`;
      return ok(
         {
            claimedLevel: result.claimedLevel,
            verifiedLevel: result.verifiedLevel,
            items: result.items,
            findings: result.findings,
         },
         text,
      );
   } catch (e) {
      return fail((e as Error).message);
   }
}

function explainConformanceTool(root: string): CallToolResult {
   try {
      const result = conformanceReport(resolveRoot(root));
      const explanation = renderExplain(result);
      return ok({ claimedLevel: result.claimedLevel, verifiedLevel: result.verifiedLevel, explanation }, explanation);
   } catch (e) {
      return fail((e as Error).message);
   }
}

// --- resource helpers ---
function readResource(uri: string): ReadResourceResult {
   if (uri === 'leji://cli/help') {
      return { contents: [{ uri, mimeType: 'text/plain', text: renderUsage() }] };
   }
   const specMatch = /^leji:\/\/spec\/(.+)$/.exec(uri);
   if (specMatch) {
      const id = decodeURIComponent(specMatch[1]);
      const text = id === 'full' ? readSpecFull() : readSpec(id);
      if (text === null) throw new Error(`unknown spec document: ${id}`);
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
   }
   const schemaMatch = /^leji:\/\/schema\/(.+)$/.exec(uri);
   if (schemaMatch) {
      const name = decodeURIComponent(schemaMatch[1]);
      const text = readSchema(name);
      if (text === null) throw new Error(`unknown schema: ${name}`);
      return { contents: [{ uri, mimeType: 'application/json', text }] };
   }
   throw new Error(`unknown resource: ${uri}`);
}

/** Build the Leji MCP server: read-only resources (spec, schemas, CLI help) and
 * read-only tools (search, fetch, validate, conformance) wired to the SDK. */
export function createServer(version: string): Server {
   const server = new Server(
      { name: SERVER_NAME, version },
      { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
   );

   server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

   server.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
      const { name } = req.params;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      switch (name) {
         case 'search_spec': {
            const query = strArg(args, 'query');
            return query === null ? fail('query is required') : searchSpec(query);
         }
         case 'fetch_spec_doc': {
            const id = strArg(args, 'id');
            return id === null ? fail('id is required') : fetchSpecDoc(id);
         }
         case 'fetch_schema': {
            const schemaName = strArg(args, 'name');
            return schemaName === null ? fail('name is required') : fetchSchema(schemaName);
         }
         case 'validate_manifest': {
            const manifestJson = strArg(args, 'manifestJson');
            return manifestJson === null ? fail('manifestJson is required') : validateManifestTool(manifestJson);
         }
         case 'validate_layer': {
            const root = strArg(args, 'root');
            return root === null ? fail('root is required') : validateLayerTool(root);
         }
         case 'score_conformance': {
            const root = strArg(args, 'root');
            return root === null ? fail('root is required') : scoreConformanceTool(root);
         }
         case 'explain_conformance': {
            const root = strArg(args, 'root');
            return root === null ? fail('root is required') : explainConformanceTool(root);
         }
         default:
            return fail(`unknown tool: ${name}`);
      }
   });

   server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: [
         { uri: 'leji://spec/full', name: 'spec-full', title: 'Leji specification (full)', mimeType: 'text/markdown' },
         { uri: 'leji://cli/help', name: 'cli-help', title: 'Leji CLI help', mimeType: 'text/plain' },
         ...specIds().map((id) => ({ uri: `leji://spec/${id}`, name: `spec-${id}`, mimeType: 'text/markdown' })),
         ...schemaNames().map((n) => ({
            uri: `leji://schema/${n}`,
            name: `schema-${n}`,
            mimeType: 'application/json',
         })),
      ],
   }));

   server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: [
         { uriTemplate: 'leji://spec/{id}', name: 'spec-doc', mimeType: 'text/markdown' },
         { uriTemplate: 'leji://schema/{name}', name: 'schema', mimeType: 'application/json' },
      ],
   }));

   server.setRequestHandler(ReadResourceRequestSchema, (req): ReadResourceResult => readResource(req.params.uri));

   return server;
}
