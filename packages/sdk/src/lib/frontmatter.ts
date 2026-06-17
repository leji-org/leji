import { parse } from 'yaml';

export interface Frontmatter {
   /** Parsed YAML frontmatter object, or null when the document has none. */
   data: Record<string, unknown> | null;
   /** Document body after the frontmatter block (the whole file when none). */
   body: string;
   /** Parse error message when the frontmatter block exists but is invalid YAML. */
   error?: string;
}

/**
 * Extract the leading YAML frontmatter block (`---` fences) from a markdown
 * document. Dates and booleans follow YAML 1.2 core semantics (the `yaml`
 * package default): unquoted dates stay strings, only true/false are booleans.
 */
export function parseFrontmatter(text: string): Frontmatter {
   if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
      return { data: null, body: text };
   }
   const fence = /\r?\n---[ \t]*\r?\n/.exec(text.slice(3));
   if (!fence) {
      return { data: null, body: text, error: 'unterminated frontmatter block' };
   }
   const raw = text.slice(3, 3 + fence.index + 1);
   const body = text.slice(3 + fence.index + fence[0].length);
   try {
      const data = parse(raw);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
         return { data: null, body, error: 'frontmatter is not a YAML mapping' };
      }
      return { data: data as Record<string, unknown>, body };
   } catch (e) {
      return { data: null, body, error: `invalid YAML: ${(e as Error).message.split('\n')[0]}` };
   }
}
