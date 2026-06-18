// The full normative spec concatenated in canonical order, single-sourced from spec/*.md, for agents that want it in one fetch.
import fs from 'node:fs';
import path from 'node:path';
import type { APIRoute } from 'astro';
import { SPEC_DOCS, specDocTitle, specPath } from '../data/spec-docs';

const SPEC_DIR = path.resolve(process.cwd(), '../../spec');
const SITE = 'https://leji.org';
const fileFor = (id: string) => (id === 'readme' ? 'README.md' : `${id}.md`);

export const GET: APIRoute = () => {
   const preamble = [
      '<!-- The Leji Specification: full normative text in canonical reading order. -->',
      `<!-- Canonical home: ${SITE}/spec/ . Each section is also a page and raw markdown (.md) at the URLs noted below. -->`,
   ].join('\n');

   const sections = SPEC_DOCS.map((d) => {
      const raw = fs.readFileSync(path.join(SPEC_DIR, fileFor(d.id)), 'utf-8').trimEnd();
      const meta = `<!-- ${specDocTitle(d.id)} | page: ${SITE}${specPath(d.id)} | markdown: ${SITE}/spec/${d.id}.md -->`;
      return `${meta}\n\n${raw}`;
   });

   const body = `${preamble}\n\n${sections.join('\n\n---\n\n')}\n`;
   return new Response(body, {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
   });
};
