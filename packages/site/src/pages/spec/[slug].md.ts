// Raw markdown for each spec document, single-sourced from spec/*.md so agents read the normative source without scraping HTML.
import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { SPEC_DOCS } from '../../data/spec-docs';

const SPEC_DIR = path.resolve(process.cwd(), '../../spec');
const fileFor = (id: string) => (id === 'readme' ? 'README.md' : `${id}.md`);

export function getStaticPaths() {
   return SPEC_DOCS.map((d) => ({ params: { slug: d.id } }));
}

export const GET: APIRoute = ({ params }) => {
   const body = fs.readFileSync(path.join(SPEC_DIR, fileFor(params.slug!)), 'utf-8');
   return new Response(body, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
   });
};
