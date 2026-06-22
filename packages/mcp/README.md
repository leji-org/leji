# @leji-org/mcp

Local [MCP](https://modelcontextprotocol.io) server for [Leji](https://leji.org), the open specification for the shared context layer of AI-native teams.

It wraps the [`@leji-org/leji`](https://www.npmjs.com/package/@leji-org/leji) SDK so an AI agent can natively retrieve the spec and JSON Schemas, and run validation and conformance against a context layer on disk, instead of reading the website and shelling out to the CLI.

Runs locally over stdio, needs no network or auth, and exposes only read-only tools.

## Use it

Add it to your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, …):

```json
{ "mcpServers": { "leji": { "command": "npx", "args": ["-y", "@leji-org/mcp"] } } }
```

The client launches `leji-mcp` on demand. The server reads the layer at the `root` path each tool is given; point it at a repository that contains a `leji.json`.

## Resources

- `leji://spec/full`: the complete specification.
- `leji://spec/{id}`: one spec document (e.g. `leji://spec/conformance`).
- `leji://schema/{name}`: one JSON Schema (e.g. `leji://schema/context-manifest`).
- `leji://cli/help`: the `leji` CLI reference.

## Tools (all read-only)

- `search_spec({ query })`: spec sections matching a query.
- `fetch_spec_doc({ id })`: one spec document (or `full`).
- `fetch_schema({ name })`: one JSON Schema.
- `validate_manifest({ manifestJson })`: validate a `leji.json` supplied inline.
- `validate_layer({ root })`: validate the context layer at `root`.
- `score_conformance({ root })`: claimed vs verified conformance level.
- `explain_conformance({ root })`: what is verified and what the next level needs.

## Security model

The server is a **local** process that runs with your filesystem authority and exposes
**read-only** tools; it never writes, and makes no network calls. The validation tools
(`validate_layer`, `score_conformance`, `explain_conformance`) read the context layer at
the `root` you give each call; that root is resolved and canonicalized, and reads stay
under it (a symlink escaping the layer root is refused, mirroring the CLI). The server
imposes no allowlist on which directory you may point it at: it can read any layer your
own account can already read, and no more. It is intended for local, single-user use
behind your MCP client, not as a shared or networked service. Reads are not size-capped,
so pointing it at a pathologically large layer is a local-resource concern only.

## License

Apache-2.0.
