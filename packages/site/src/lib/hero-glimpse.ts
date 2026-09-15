// The homepage's viewer window renders two files exactly as `leji export` writes
// them for the hero fixture: the generated sidebar and the homepage the viewer seeds
// when a layer has none. Both live in `src/data/hero-glimpse/` as copies of that
// output, and the SDK's site-hero test fails when the generator's output moves away
// from them. This module is the other half: it reads those two files into the little
// structure the component draws, so nothing about the layer (no document, no group,
// no count) is typed into markup where it could quietly go stale.
//
// The parsers are deliberately narrow. They read the shape the generator writes and
// throw, naming the offending line, on anything else: an unreadable pinned file is a
// build that stops, never a window that silently shows less.

/** A sidebar group: the bold label, and the document titles listed under it. */
export interface SidebarGroup {
   label: string;
   entries: string[];
}

/** The generated sidebar: the pinned entrypoints above the first rule, the category
 * groups between the rules, and the repository drawer below the last one. */
export interface Sidebar {
   pins: string[];
   groups: SidebarGroup[];
   drawer: SidebarGroup | null;
}

/** One box on the layer's category map. `count` is empty for the boot profile, which
 * the generator draws as the root the categories hang off rather than as a count. */
export interface MapNode {
   label: string;
   count: string;
}

/** The generated category map, as the graph it declares: one root, and the categories
 * that hang off it, in the order the generator writes them. The component draws this
 * topology; it never assumes one. */
export interface OverviewMap {
   root: MapNode;
   categories: MapNode[];
}

/** The seeded homepage: its heading, its prose, and the generated map. */
export interface Overview {
   title: string;
   paragraphs: string[];
   map: OverviewMap;
}

// Every capture below is a character class that stops at its own closing delimiter,
// never `.+`. A greedy capture reads one line carrying two constructs as one construct
// with punctuation inside it: `- [A](/a.md) [B](/b.md)` becomes a single pin labelled
// `A](/a.md) [B`, and a chained node declaration becomes one node whose count holds
// another node and an edge. Both slip past every check downstream, because by then
// there is only one of them. A line with two constructs on it has to fail to match, so
// that it reaches the throw.

/** A pinned entrypoint, a group label, an entry inside the open group, a rule. */
const PIN = /^- \[([^\]]+)\]\([^)]+\)$/;
const GROUP = /^- \*\*([^*]+)\*\*$/;
const ENTRY = /^ {2,}- \[([^\]]+)\]\([^)]+\)$/;
const RULE = /^-{3,}$/;

/** The markers the generator writes the map between. */
const MAP_START = '<!-- leji:generated-map:start -->';
const MAP_END = '<!-- leji:generated-map:end -->';
/** Every line shape the generated map is allowed to be made of. A statement outside
 * this set is one whose meaning the glimpse cannot draw, so it stops the build. */
const FENCE_OPEN = '```mermaid';
const FENCE_CLOSE = '```';
const FLOWCHART = 'flowchart LR';
const NODE = /^([A-Za-z][\w-]*)\["([^"]+)"\]$/;
const EDGE = /^([A-Za-z][\w-]*) --> ([A-Za-z][\w-]*)$/;
/** The separator the generator puts between a category's label and its count. */
const COUNT = ' · ';

/** The file's non-empty lines, split into the zones its rules divide it into. */
function zones(md: string): string[][] {
   const out: string[][] = [[]];
   for (const raw of md.split('\n')) {
      const line = raw.trimEnd();
      if (line === '') continue;
      if (RULE.test(line)) out.push([]);
      else out[out.length - 1].push(line);
   }
   return out;
}

/** One zone of groups: a bold label opens a group, indented links fill it. */
function groupsIn(lines: string[]): SidebarGroup[] {
   const groups: SidebarGroup[] = [];
   for (const line of lines) {
      const label = GROUP.exec(line);
      if (label) {
         groups.push({ label: label[1], entries: [] });
         continue;
      }
      const entry = ENTRY.exec(line);
      if (!entry) throw new Error(`sidebar line is neither a group nor an entry: ${line.trim()}`);
      const open = groups[groups.length - 1];
      if (!open) throw new Error(`sidebar entry before any group: ${line.trim()}`);
      open.entries.push(entry[1]);
   }
   return groups;
}

/** Read the generated `_sidebar.md`. */
export function parseSidebar(md: string): Sidebar {
   const divided = zones(md);
   const pins = divided[0].map((line) => {
      const pin = PIN.exec(line);
      if (!pin) throw new Error(`pinned sidebar line is not a link: ${line.trim()}`);
      return pin[1];
   });
   const last = divided.length - 1;
   const groups = divided.slice(1, last).flatMap(groupsIn);
   const tail = last > 0 ? groupsIn(divided[last]) : [];
   if (tail.length > 1) throw new Error(`the sidebar's last zone holds ${tail.length} groups, not one drawer`);
   return { pins, groups, drawer: tail[0] ?? null };
}

/** Read the seeded `overview.md`. Inline code and emphasis stay in the prose as the
 * markdown the generator wrote; the component renders them. */
export function parseOverview(md: string): Overview {
   const lines = md.split('\n');
   const start = lines.findIndex((line) => line.trim() === MAP_START);
   const end = lines.findIndex((line) => line.trim() === MAP_END);
   if (start === -1 || end < start) throw new Error('the overview carries no generated-map block');

   const heading = lines.findIndex((line) => line.startsWith('# '));
   if (heading === -1 || heading > start) throw new Error('the overview carries no heading above its map');
   const title = lines[heading].slice(2).trim();

   const paragraphs: string[] = [];
   let open: string[] = [];
   for (const line of lines.slice(heading + 1, start)) {
      if (line.trim() === '') {
         if (open.length > 0) paragraphs.push(open.join(' '));
         open = [];
      } else open.push(line.trim());
   }
   if (open.length > 0) paragraphs.push(open.join(' '));

   return { title, paragraphs, map: parseMap(lines.slice(start + 1, end)) };
}

/** A node's label, split on the separator the generator puts before a count. */
function splitCount(label: string): MapNode {
   const cut = label.indexOf(COUNT);
   return cut === -1 ? { label, count: '' } : { label: label.slice(0, cut), count: label.slice(cut + COUNT.length) };
}

/**
 * Read the mermaid block between the markers as a graph, and refuse anything else.
 *
 * The glimpse draws one shape: a root with its categories beside it. Reading the map
 * as a list of boxes would let the generator reshape the graph, by moving an edge or
 * adding a node, while the picture kept rendering the old arrangement and nobody
 * saw the difference. So the relationships are parsed too, and every rule the drawing
 * relies on is checked here rather than assumed downstream: one root, every other
 * node hanging off it by exactly one edge, and no statement whose meaning is unknown.
 */
function parseMap(lines: string[]): OverviewMap {
   const body = lines.map((line) => line.trim()).filter((line) => line !== '');
   if (body.length < 3 || body[0] !== FENCE_OPEN || body[body.length - 1] !== FENCE_CLOSE) {
      throw new Error(`the generated map is not a ${FENCE_OPEN} block closed by ${FENCE_CLOSE}`);
   }
   if (body[1] !== FLOWCHART) throw new Error(`the generated map does not open on "${FLOWCHART}": ${body[1]}`);

   const declared = new Map<string, MapNode>();
   const edges: { from: string; to: string }[] = [];
   for (const line of body.slice(2, -1)) {
      const node = NODE.exec(line);
      if (node) {
         if (declared.has(node[1])) throw new Error(`the generated map declares "${node[1]}" twice`);
         declared.set(node[1], splitCount(node[2]));
         continue;
      }
      const edge = EDGE.exec(line);
      if (!edge) throw new Error(`the generated map carries a statement this parser does not read: ${line}`);
      edges.push({ from: edge[1], to: edge[2] });
   }

   for (const { from, to } of edges) {
      for (const id of [from, to]) {
         if (!declared.has(id)) throw new Error(`the generated map has an edge naming an undeclared node "${id}"`);
      }
   }

   // The root is the node the generator writes without a count: the boot profile, which
   // is an entrypoint rather than a category of documents.
   const roots = [...declared].filter(([, node]) => node.count === '');
   if (roots.length !== 1) {
      throw new Error(`the generated map declares ${roots.length} nodes without a count, and exactly one is the root`);
   }
   const [rootId, root] = roots[0];

   const incoming = new Map<string, string[]>([...declared.keys()].map((id) => [id, []]));
   for (const { from, to } of edges) incoming.get(to)?.push(from);
   if ((incoming.get(rootId) ?? []).length > 0) {
      throw new Error(`the generated map points an edge at its root "${rootId}"`);
   }

   const categories: MapNode[] = [];
   for (const [id, node] of declared) {
      if (id === rootId) continue;
      const from = incoming.get(id) ?? [];
      if (from.length === 0) throw new Error(`the generated map hangs "${id}" off nothing: it has no edge`);
      if (from.length > 1)
         throw new Error(`the generated map points ${from.length} edges at "${id}", and one is expected`);
      if (from[0] !== rootId) {
         throw new Error(`the generated map hangs "${id}" off "${from[0]}" rather than off the root "${rootId}"`);
      }
      categories.push(node);
   }
   if (categories.length === 0) throw new Error('the generated map declares no categories under its root');

   return { root, categories };
}
