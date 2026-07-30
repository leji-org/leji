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
 * Extract the leading YAML frontmatter block (`---` fences) from markdown.
 * YAML 1.2 core semantics: unquoted dates stay strings, only true/false coerce.
 */
export function parseFrontmatter(text: string): Frontmatter {
   if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
      return { data: null, body: text };
   }
   const fence = /(\r?\n)---[ \t]*\r?\n/.exec(text.slice(3));
   if (!fence) {
      return { data: null, body: text, error: 'unterminated frontmatter block' };
   }
   // Capture group 1 is the line terminator that ends the block's last line, so
   // the slice keeps it whole: taking a fixed single character leaves a CRLF
   // file's bare `\r` behind, which YAML folds into the last scalar's value.
   const raw = text.slice(3, 3 + fence.index + fence[1].length);
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
