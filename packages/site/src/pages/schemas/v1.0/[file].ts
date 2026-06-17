// Serves the JSON Schemas at their canonical $id paths
// (https://leji.org/schemas/v1.0/<name>.schema.json), single-sourced from ../schemas.
import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';

const SCHEMA_DIR = path.resolve(process.cwd(), '../../schemas');

export function getStaticPaths() {
   return fs
      .readdirSync(SCHEMA_DIR)
      .filter((f) => f.endsWith('.schema.json'))
      .map((file) => ({ params: { file } }));
}

export const GET: APIRoute = ({ params }) => {
   const body = fs.readFileSync(path.join(SCHEMA_DIR, params.file!), 'utf-8');
   return new Response(body, {
      headers: { 'Content-Type': 'application/schema+json; charset=utf-8' },
   });
};
