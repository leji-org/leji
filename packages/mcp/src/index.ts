import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

export { createServer } from './server.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

/** Server version, read from package.json so it cannot drift from the package. */
export const VERSION: string = version;

/**
 * Start the Leji MCP server over stdio. JSON-RPC is the only thing written to
 * stdout (the transport owns it); everything else goes to stderr, so the server
 * stays a clean stdio peer for any MCP client.
 */
export async function main(): Promise<void> {
   const server = createServer(version);
   const transport = new StdioServerTransport();
   await server.connect(transport);
   process.stderr.write(`leji-mcp ${version} ready on stdio\n`);
}
