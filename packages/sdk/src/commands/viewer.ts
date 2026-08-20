import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Finding, finding } from '../lib/findings.js';
import {
   isFile,
   openVerifiedSource,
   readText,
   readTextWithin,
   resolvedPath,
   resolvedWithinRoot,
   stripSlash,
   underPath,
   verifiedTargetRead,
   walkTree,
   writeFileGuarded,
} from '../lib/fsx.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { LEJI_DIR, VIEWER_REL, servablePath, writableTarget } from '../lib/layout.js';
import {
   type ScannedProfile,
   resolveAgentProfile,
   resolveCategoryAssignments,
   scanAgentProfiles,
   scanProfileSetWith,
} from '../lib/layer.js';
import { mountStatus, type StatusResult } from '../lib/mounts.js';
import { type Manifest, CATEGORY_IDS, effectiveAgentProfilesPath, effectiveIndexPath } from '../lib/manifest.js';
import { templatesDir } from '../lib/schemas.js';
import { byteCompare } from '../lib/text.js';
import { generateIndex } from './indexgen.js';

/**
 * The viewer's chrome: the sidebar, the manifest page, the resolved-profile pages,
 * and the SPA shell in its two flavors, generated into the `.leji/viewer/` role.
 * Everything here is offline and filesystem-only. The two consumers live beside it
 * and never merge back into it: `serve.ts` (the local preview, the one module that
 * speaks HTTP) and `export.ts` (the static export, whose no-network guarantee is
 * checkable precisely because this module and its own imports reach no socket).
 */

/** Preview-port precedence: explicit --port, then manifest viewer.port, then 5354 (LEJI on a phone keypad). */
export function resolveViewerPort(manifest: Manifest, flagPort?: number): number {
   return flagPort ?? manifest.viewer?.port ?? 5354;
}

export interface ViewerResult {
   written: string[];
   findings: Finding[];
   entries: number;
}

const CATEGORY_LABELS: Record<string, string> = {
   domain: 'Domain',
   system: 'System',
   practice: 'Practice',
   governance: 'Governance',
   decisions: 'Decisions',
};

// Boot profile's emoji, matching the emoji'd category groups below it.
const BOOT_EMOJI = '🤖';

// Default per-category sidebar emoji, overridable via viewer.categoryEmojis. Baked
// identically into every SDK so the generated sidebar stays byte-identical.
const CATEGORY_EMOJI: Record<string, string> = {
   domain: '📖',
   system: '⚙️',
   practice: '🛠️',
   governance: '🛡️',
   decisions: '🧭',
};

/** Vendored assets loaded only when mermaid is enabled; skipped otherwise. */
const MERMAID_ASSETS = new Set(['mermaid.min.js', 'docsify-mermaid.js']);

/** The Leji brand green, the viewer's default accent when no viewer.theme.primary is set. */
const DEFAULT_THEME_COLOR = '#009F71';

/**
 * The base every URL the generated chrome emits is written against: `'/'` for the
 * local server (the app root, the served flavor's unchanged contract) and `''` for
 * an export, whose references then resolve against the page itself so the tree
 * hosts correctly under a subpath. It is a generation parameter, never a post-hoc
 * rewrite of emitted HTML: one code path, two invocations. `index.html` is the only
 * artifact that exists in two flavors — everything else under the chrome is
 * flavor-neutral.
 */
export type ChromeBase = '/' | '';

/** The vendored Leji mark, as the given base addresses it. */
function defaultLogo(base: ChromeBase): string {
   return `${base}assets/leji-logo.svg`;
}

/** The one accent format the viewer accepts: a hex color at a length CSS actually
 * defines (#RGB, #RGBA, #RRGGBB, #RRGGBBAA). The accent reaches a stylesheet as a
 * custom-property value, so anything with punctuation in it is a CSS-injection
 * sink rather than a color; hex-only also keeps one canonical form across the
 * three SDKs and the schema. */
const SAFE_CSS_COLOR = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The viewer accent: viewer.theme.primary when it is a hex color, else the
 * Leji default with a warning. Never the authored value unchecked. */
function resolveThemeColor(manifest: Manifest, findings: Finding[]): string {
   const configured = manifest.viewer?.theme?.primary;
   if (configured === undefined || configured === '') return DEFAULT_THEME_COLOR;
   if (SAFE_CSS_COLOR.test(configured)) return configured;
   findings.push(
      finding(
         'viewer-theme-invalid',
         'warning',
         `viewer.theme.primary "${configured}" is not a hex color (#RGB, #RGBA, #RRGGBB, or #RRGGBBAA); using ${DEFAULT_THEME_COLOR}`,
      ),
   );
   return DEFAULT_THEME_COLOR;
}

/** The accent as opaque sRGB channels, or null for a value that names no color the
 * generator can resolve — a keyword, `currentColor`, a malformed hex. Accepts
 * 3/4/6/8-digit hex, the only form the accent can take; an accent carrying alpha is
 * composited over white, the viewer's content background, which is the only backdrop
 * knowable at generation time (the accent itself keeps its authored alpha everywhere
 * it is used — this composite decides text color, nothing that renders). */
function parseAccentColor(value: string): { r: number; g: number; b: number } | null {
   const raw = value.trim().toLowerCase();
   if (!raw.startsWith('#')) return null;
   const hex = raw.slice(1);
   if (!/^[0-9a-f]+$/.test(hex)) return null;
   const full =
      hex.length === 3 || hex.length === 4
         ? [...hex].map((c) => c + c).join('')
         : hex.length === 6 || hex.length === 8
           ? hex
           : null;
   if (full === null) return null;
   const channel = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16);
   const alpha = full.length === 8 ? channel(3) / 255 : 1;
   const over = (c: number): number => Math.round(c * alpha + 255 * (1 - alpha));
   return { r: over(channel(0)), g: over(channel(1)), b: over(channel(2)) };
}

/** WCAG relative luminance: linearized sRGB channels, weighted. */
function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
   const linear = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
   };
   return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
   return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The mermaid node-text color for an accent, computed here rather than in the
 * browser: the viewer's boot script sees only what the config block carries, while
 * this side can resolve every color form viewer.theme.primary accepts. Whichever of
 * #1a1a1a and #ffffff contrasts more with the accent, or #000000 when neither
 * clears WCAG AA (4.5:1) — a mid-gray accent, where the extra half-stop of black is
 * the best text color available. An accent this cannot resolve keeps the dark
 * default, which is also the boot script's fallback.
 */
export function mermaidTextColor(themeColor: string): string {
   const rgb = parseAccentColor(themeColor);
   if (rgb === null) return '#1a1a1a';
   const accent = relativeLuminance(rgb);
   const onDark = contrastRatio(relativeLuminance({ r: 0x1a, g: 0x1a, b: 0x1a }), accent);
   const onLight = contrastRatio(1, accent);
   if (onDark < 4.5 && onLight < 4.5) return '#000000';
   return onDark >= onLight ? '#1a1a1a' : '#ffffff';
}

/** Resolve a viewer-configured file path to a rootPath-relative rel. The
 * canonical form is rootPath-relative, but a repository-root-relative path
 * under the context root is accepted too (`docs/README.md` for `README.md`):
 * the manifest's pins are repo-relative, so authors mix the forms. Returns
 * null when neither form names an existing file. */
function resolveViewerRel(root: string, rootPath: string, value: string): string | null {
   const clean = stripSlash(value).replace(/^\.\//, '');
   const base = stripSlash(rootPath);
   if (isFile(base && base !== '.' ? path.join(root, base, clean) : path.join(root, clean))) return clean;
   const stripped = relativeToRoot(clean, rootPath);
   if (stripped !== null && isFile(path.join(root, clean))) return stripped;
   return null;
}

/** The homepage rel served by the viewer: viewer.homepage in either path form,
 * defaulting to the seeded overview. An unresolvable configured value is kept
 * as authored (Docsify will 404 it) and reported as a warning. */
function effectiveHomepage(root: string, manifest: Manifest, findings: Finding[]): string {
   const configured = manifest.viewer?.homepage;
   if (!configured) return 'overview.md';
   const rel = resolveViewerRel(root, manifest.rootPath, configured);
   if (rel !== null) return rel;
   findings.push(
      finding(
         'viewer-path-missing',
         'warning',
         `viewer.homepage "${configured}" does not resolve to a file under the context root`,
         configured,
      ),
   );
   return stripSlash(configured);
}

/** Resolve the viewer logo URL: a configured path is served from the content mount
 * (or used as-is when absolute); unset falls back to the vendored Leji mark. */
function resolveLogo(root: string, rootPath: string, logo: string | undefined, base: ChromeBase): string {
   if (!logo) return defaultLogo(base);
   if (logo.startsWith('/') || /^https?:\/\//.test(logo)) return logo;
   const rel = resolveViewerRel(root, rootPath, logo);
   return `${base}content/${rel ?? stripSlash(logo)}`;
}

/** Escape text for safe interpolation into HTML element/attribute content. */
function htmlEscape(s: string): string {
   return s
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
}

/**
 * JSON safe to embed in a `<script type="application/json">` block: neutralize a
 * closing tag and the JS line terminators U+2028/U+2029.
 */
function jsonForScript(value: unknown): string {
   return JSON.stringify(value)
      .replaceAll('<', '\\u003c')
      .replaceAll('>', '\\u003e')
      .replaceAll('&', '\\u0026')
      .replaceAll(' ', '\\u2028')
      .replaceAll(' ', '\\u2029');
}

export function relativeToRoot(relPath: string, rootPath: string): string | null {
   const base = stripSlash(rootPath);
   if (base === '' || base === '.') return relPath;
   if (relPath.startsWith(base + '/')) return relPath.slice(base.length + 1);
   return null; // outside the context root: not servable from the viewer
}

/** Escape a string for Markdown link text (`[...]`): backslash, brackets, and the
 * angle brackets that would otherwise land as live HTML (a manifest label or a
 * frontmatter title reaches the generated sidebar verbatim). */
function mdLinkText(s: string): string {
   return s.replace(/[\\[\]<>]/g, '\\$&');
}

/** Escape a string for a Markdown link destination (`(...)`): backslash, parens.
 * Destinations are emitted app-root absolute (leading slash): with the viewer's
 * relativePath routing, a bare rootPath-relative destination would re-resolve
 * against whatever nested route is current and double-prefix; leading-slash links
 * are exempt from relative resolution by Docsify's contract. Idempotent: leading
 * slashes are stripped first, so an already-absolute destination (the sidebar
 * builders are public API) never becomes `//…`, which Docsify routes as an
 * external protocol-relative URL. Empty input stays empty, never a bare `/`. */
function mdLinkDest(s: string): string {
   const escaped = s.replace(/^\/+/, '').replace(/[\\()]/g, '\\$&');
   return escaped === '' ? '' : '/' + escaped;
}

/** A reference doc shown in the browse zone: rootPath-relative path + display title. */
export interface TreeNode {
   rel: string;
   title: string;
}

/** Prettify a directory segment for a non-link label: separators to spaces,
 * title-cased so derived labels read like curated ones. */
function prettifyDirName(name: string): string {
   return name
      .replace(/[-_]+/g, ' ')
      .trim()
      .replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
}

interface DirTree {
   dirs: Map<string, DirTree>;
   files: TreeNode[];
}

/**
 * Render reference docs as a nested list mirroring the directory tree: folders are
 * bold non-link labels, files are links; sorted by name within each directory.
 */
function buildTreeSection(nodes: TreeNode[]): string[] {
   const root: DirTree = { dirs: new Map(), files: [] };
   for (const node of [...nodes].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
      const parts = node.rel.split('/');
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
         const seg = parts[i];
         let child = cur.dirs.get(seg);
         if (!child) {
            child = { dirs: new Map(), files: [] };
            cur.dirs.set(seg, child);
         }
         cur = child;
      }
      cur.files.push(node);
   }
   const lines: string[] = [];
   const render = (node: DirTree, depth: number): void => {
      const indent = '  '.repeat(depth);
      const merged: { name: string; dir?: DirTree; file?: TreeNode }[] = [
         ...[...node.dirs.entries()].map(([name, dir]) => ({ name, dir })),
         ...node.files.map((file) => ({ name: file.rel.split('/').pop()!, file })),
      ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of merged) {
         if (e.dir) {
            // Path-compress single-child chains: a folder holding nothing but one
            // subfolder merges its label ("Wood Badge / Ticket"), so a lone
            // reference file never sits under a stack of single-child bold labels.
            const names = [e.name];
            let dir = e.dir;
            while (dir.files.length === 0 && dir.dirs.size === 1) {
               const [childName, child] = [...dir.dirs.entries()][0];
               names.push(childName);
               dir = child;
            }
            lines.push(`${indent}- **${names.map(prettifyDirName).join(' / ')}**`);
            render(dir, depth + 1);
         } else if (e.file) {
            lines.push(`${indent}- [${mdLinkText(e.file.title)}](${mdLinkDest(e.file.rel)})`);
         }
      }
   };
   render(root, 0);
   return lines;
}

/** A sidebar entry: rootPath-relative link target and display title. A
 * document's kind and record date are page-level metadata (the classification
 * chip), not sidebar decoration. */
export interface SidebarEntry {
   rel: string;
   title: string;
}

/** A spine group: one curated index file's winners, labeled by its H1. */
export interface SidebarGroup {
   label: string;
   entries: SidebarEntry[];
}

/** Render one sidebar link line. */
function entryLine(indent: string, e: SidebarEntry): string {
   return `${indent}- [${mdLinkText(e.title)}](${mdLinkDest(e.rel)})`;
}

/**
 * Project a deterministic Docsify sidebar, two zones: the governed spine on top
 * (boot profile, then any pinned pages, then one group per curated index file,
 * labeled by the index file's own H1 in manifest order), and below a divider the
 * reference-docs directory tree (browse zone). Membership follows selector
 * resolution: a document appears in the group of the index file whose selector
 * won it. Paths relative to rootPath.
 */
export function buildSidebar(
   manifest: Manifest,
   groups: SidebarGroup[],
   tree: TreeNode[] = [],
   pins: SidebarEntry[] = [],
   opts: { bootPinned?: boolean } = {},
): string {
   // Boot profile and pins above a divider, then index-file groups, then the tree.
   const topLines: string[] = [];
   const boot = relativeToRoot(manifest.bootProfilePath, manifest.rootPath);
   // Emoji inside the link text so the label stays on one line (links render as
   // block elements; an emoji outside would wrap above). A pinned boot profile
   // replaces this default line with the team's own label and position.
   if (boot && !opts.bootPinned) topLines.push(`- [${BOOT_EMOJI} Boot profile](${mdLinkDest(boot)})`);
   for (const pin of pins) topLines.push(entryLine('', pin));
   const groupLines: string[] = [];
   for (const group of groups) {
      if (group.entries.length === 0) continue;
      // Bold labels: the sidebar-collapse plugin treats a strong label with a
      // nested list as a collapsible folder, matching hand-built sidebars.
      groupLines.push(`- **${mdLinkText(group.label)}**`);
      groupLines.push(...buildGroupTree(group.entries, group.label));
   }
   // The browse zone renders as one collapsed "Reference" folder, not a bare
   // spill of links: a curated layer reads as pins + governed groups, with the
   // ungoverned tier behind a single, deliberately-named drawer.
   const rawTree = buildTreeSection(tree);
   const treeLines = rawTree.length > 0 ? ['- **Reference**', ...rawTree.map((l) => `  ${l}`)] : [];
   const sections = [topLines, groupLines, treeLines].filter((s) => s.length > 0).map((s) => s.join('\n'));
   return sections.join('\n\n---\n\n') + '\n';
}

/** An index file's group label: its first H1 (frontmatter title wins), else a
 * prettified filename. The author's H1 carries any emoji or phrasing. */
function groupLabel(root: string, indexRel: string): string {
   return docTitle(root, indexRel);
}

/**
 * Render a group's members as a nested tree mirroring their real directory
 * structure: the members' longest common directory prefix is stripped (so a
 * group whose content lives under one directory doesn't repeat it), deeper
 * directories become bold sub-labels, and files render as links with their
 * record badges. Real repositories are not flat; the sidebar shouldn't be.
 */
function buildGroupTree(entries: SidebarEntry[], label = ''): string[] {
   // Longest common directory prefix across all members.
   const dirOf = (rel: string): string[] => rel.split('/').slice(0, -1);
   let prefix = dirOf(entries[0].rel);
   for (const e of entries.slice(1)) {
      const d = dirOf(e.rel);
      let i = 0;
      while (i < prefix.length && i < d.length && prefix[i] === d[i]) i++;
      prefix = prefix.slice(0, i);
   }
   const strip = prefix.length;

   interface GroupDir {
      dirs: Map<string, GroupDir>;
      files: SidebarEntry[];
   }
   const rootNode: GroupDir = { dirs: new Map(), files: [] };
   for (const e of [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
      const parts = e.rel.split('/').slice(strip);
      let cur = rootNode;
      for (let i = 0; i < parts.length - 1; i++) {
         const seg = parts[i];
         let child = cur.dirs.get(seg);
         if (!child) {
            child = { dirs: new Map(), files: [] };
            cur.dirs.set(seg, child);
         }
         cur = child;
      }
      cur.files.push(e);
   }
   // Hoist a top-level directory whose name matches the group's own label (the
   // emoji-stripped comparison), so "💼 Business" never wraps a redundant
   // "Business" level while outlier members stay as siblings.
   const labelKey = label
      .replace(/[^\p{L}\p{N} ]/gu, '')
      .trim()
      .toLowerCase();
   const mergeInto = (target: GroupDir, src: GroupDir): void => {
      target.files.push(...src.files);
      for (const [name, dir] of src.dirs) {
         const existing = target.dirs.get(name);
         if (existing) mergeInto(existing, dir);
         else target.dirs.set(name, dir);
      }
   };
   for (const [name, dir] of [...rootNode.dirs.entries()]) {
      if (labelKey !== '' && prettifyDirName(name).toLowerCase() === labelKey) {
         rootNode.dirs.delete(name);
         mergeInto(rootNode, dir);
      }
   }

   const lines: string[] = [];
   const render = (node: GroupDir, depth: number): void => {
      const indent = '  '.repeat(depth + 1);
      const merged: { name: string; dir?: GroupDir; file?: SidebarEntry }[] = [
         ...[...node.dirs.entries()].map(([name, dir]) => ({ name, dir })),
         ...node.files.map((file) => ({ name: file.rel.split('/').pop()!, file })),
      ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of merged) {
         if (e.dir) {
            lines.push(`${indent}- **${mdLinkText(prettifyDirName(e.name))}**`);
            render(e.dir, depth + 1);
         } else if (e.file) {
            lines.push(entryLine(indent, e.file));
         }
      }
   };
   render(rootNode, 0);
   return lines;
}

/**
 * Compute the spine groups: one per curated index file, in manifest order
 * (categories in canonical order, index files in their declared array order),
 * containing the governed documents whose winning selector that file declared.
 * Index files that share the same H1 label MERGE into one group: a topical
 * group (a product area, a program) spans categories by splitting into
 * per-category index files under one shared label. Documents outside rootPath
 * are not servable and are skipped.
 */
export function buildSidebarGroups(
   root: string,
   manifest: Manifest,
   entries: { path: string; title: string; kind?: string; date?: string }[],
): SidebarGroup[] {
   const { assignments } = resolveCategoryAssignments(root, manifest);
   const byPath = new Map(entries.map((e) => [e.path, e]));
   const groups: SidebarGroup[] = [];
   const seen = new Set<string>();
   for (const category of CATEGORY_IDS) {
      for (const indexRel of manifest.categories[category]?.indexes ?? []) {
         if (seen.has(indexRel)) continue;
         seen.add(indexRel);
         const members: SidebarEntry[] = [];
         for (const [relPath, a] of [...assignments.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
            if (a.indexRel !== indexRel) continue;
            const entry = byPath.get(relPath);
            if (!entry) continue;
            const rel = relativeToRoot(relPath, manifest.rootPath);
            if (rel === null) continue;
            members.push({ rel, title: sidebarLabel(root, relPath, rel) });
         }
         if (members.length === 0) continue;
         groups.push({ label: groupLabel(root, indexRel), entries: members });
      }
   }
   // Agent profiles are artifacts outside category content, so the sidebar
   // surfaces them from the profile scan as their own group (label curated via
   // viewer.agentsLabel; first in derived order, reorderable by groupOrder).
   const agentMembers: SidebarEntry[] = [];
   for (const p of scanAgentProfiles(root, manifest)) {
      const rel = relativeToRoot(p.relPath, manifest.rootPath);
      if (rel === null) continue;
      // A declared profiles directory can name a private role; its files are not
      // servable, so neither is the label lifted out of one. The route would 404
      // anyway — this keeps the bytes out of the sidebar that links it.
      if (!servableSource(root, p.relPath)) continue;
      const name = p.frontmatter?.name;
      const title = typeof name === 'string' && name.trim() !== '' ? name.trim() : sidebarLabel(root, p.relPath, rel);
      agentMembers.push({ rel, title });
   }
   if (agentMembers.length > 0) {
      groups.unshift({ label: manifest.viewer?.agentsLabel ?? '🤖 Agents', entries: agentMembers });
   }
   // Merge same-labeled groups, keeping first-occurrence order.
   const merged: SidebarGroup[] = [];
   const byLabel = new Map<string, SidebarGroup>();
   for (const g of groups) {
      const existing = byLabel.get(g.label);
      if (existing) {
         existing.entries.push(...g.entries);
      } else {
         byLabel.set(g.label, g);
         merged.push(g);
      }
   }
   for (const g of merged) g.entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
   // viewer.groupOrder curates group sequence by exact label: listed groups come
   // first in the given order; unlisted groups follow in derived order.
   const order = manifest.viewer?.groupOrder ?? [];
   if (order.length > 0) {
      const rank = (g: SidebarGroup): number => {
         const i = order.indexOf(g.label);
         return i === -1 ? order.length + merged.indexOf(g) : i;
      };
      merged.sort((a, b) => rank(a) - rank(b));
   }
   return merged;
}

/** Display title for a reference doc: frontmatter title, else first body heading,
 * else a prettified filename. */
function docTitle(root: string, relPath: string): string {
   const text = readText(path.join(root, relPath));
   const fm = parseFrontmatter(text);
   const title = fm.data?.title;
   if (typeof title === 'string' && title.trim() !== '') return title.trim();
   const m = /^#\s+(.+)$/m.exec(fm.body);
   if (m) return m[1].trim();
   return path.posix.basename(relPath).replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim();
}

/** A filename-derived sidebar label: all-caps stems stay as-is (TODO, ICP),
 * a root README reads "Home", a nested README reads "Overview", everything else
 * prettifies to title case. */
function filenameLabel(rootRel: string): string {
   const stem = path.posix.basename(rootRel).replace(/\.md$/i, '');
   if (stem.toLowerCase() === 'readme') return rootRel.includes('/') ? 'Overview' : 'Home';
   if (/^[A-Z0-9]+([-_][A-Z0-9]+)*$/.test(stem) && /[A-Z]/.test(stem)) return stem.replace(/[-_]+/g, ' ');
   return prettifyDirName(stem);
}

/**
 * Sidebar label for a document: the declared frontmatter `title` wins; otherwise
 * the filename, cleaned up. Deliberately NOT the H1: hand-built sidebars use
 * short curated labels, and filenames are the curated short name a repository
 * already has. The H1 stays the document's title everywhere else (page, index).
 */
function sidebarLabel(root: string, relPath: string, rootRel: string): string {
   const text = readText(path.join(root, relPath));
   const fm = parseFrontmatter(text);
   const title = fm.data?.title;
   if (typeof title === 'string' && title.trim() !== '') return title.trim();
   return filenameLabel(rootRel);
}

/**
 * The browse zone: every markdown file under rootPath that is NOT governed (in the
 * index) and NOT viewer/layer chrome (boot profile, agent profiles, category index
 * files, overview.md, generated _sidebar.md). Generated artifacts live in the root
 * `.leji/`, which the walk skips as a dot-dir even when rootPath is `.`. Returns
 * rootPath-relative nodes for the sidebar tree.
 */
function referenceTree(root: string, manifest: Manifest, governedPaths: Set<string>): TreeNode[] {
   const rootDirRel = stripSlash(manifest.rootPath) || '.';
   const profilesDir = effectiveAgentProfilesPath(manifest);
   const indexFiles = new Set<string>();
   for (const cat of CATEGORY_IDS) for (const f of manifest.categories[cat]?.indexes ?? []) indexFiles.add(f);
   const overviewRel = rootDirRel === '.' ? 'overview.md' : `${rootDirRel}/overview.md`;
   const sidebarRel = rootDirRel === '.' ? '_sidebar.md' : `${rootDirRel}/_sidebar.md`;
   const manifestPageRel = rootDirRel === '.' ? '_manifest.md' : `${rootDirRel}/_manifest.md`;
   const nodes: TreeNode[] = [];
   for (const rel of walkTree(root, rootDirRel)) {
      if (governedPaths.has(rel)) continue;
      if (rel === manifest.bootProfilePath) continue;
      if (underPath(rel, profilesDir)) continue;
      if (indexFiles.has(rel)) continue;
      if (rel === overviewRel || rel === sidebarRel || rel === manifestPageRel) continue;
      const r = relativeToRoot(rel, manifest.rootPath);
      if (r === null) continue;
      nodes.push({ rel: r, title: sidebarLabel(root, rel, r) });
   }
   return nodes;
}

// The overview homepage is seeded once, then user-owned. `leji viewer` regenerates
// only the layer map between these markers, leaving surrounding prose untouched.
const MAP_START = '<!-- leji:generated-map:start -->';
const MAP_END = '<!-- leji:generated-map:end -->';

/** A deterministic mermaid map of the layer: boot profile -> populated categories
 * with document counts. Deliberately category-altitude: per-document nodes turn
 * unreadable past a handful of docs, so the map never lists documents (the
 * sidebar already does that legibly). */
export function buildLayerMap(
   manifest: Manifest,
   entries: { id: string; path: string; title: string; category: string }[],
): string {
   const lines = ['flowchart LR', `  boot["${BOOT_EMOJI} Boot profile"]`];
   for (const category of CATEGORY_IDS) {
      const count = entries.filter((e) => e.category === category).length;
      if (count === 0) continue;
      const emoji = manifest.viewer?.categoryEmojis?.[category] ?? CATEGORY_EMOJI[category];
      const catId = 'cat_' + category;
      const docs = count === 1 ? '1 doc' : `${count} docs`;
      lines.push(`  ${catId}["${emoji} ${CATEGORY_LABELS[category]} · ${docs}"]`);
      lines.push(`  boot --> ${catId}`);
   }
   return lines.join('\n');
}

function mapBlock(manifest: Manifest, entries: IndexEntryLite[]): string {
   return `${MAP_START}\n\`\`\`mermaid\n${buildLayerMap(manifest, entries)}\n\`\`\`\n${MAP_END}`;
}

type IndexEntryLite = { id: string; path: string; title: string; category: string };

/** Normalize any value to one safe markdown-inline token: strip C0/C1/DEL control
 * characters, collapse ASCII whitespace runs to a single space, then neutralize the
 * characters that could break markdown structure or inject HTML (backslash,
 * backtick, pipe, angle brackets). Explicit character sets (never `\s`), so the
 * three SDKs emit identical bytes. Safe in headings, list text, and table cells. */
function esc(s: string): string {
   return s
      .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
      .replace(/[ \t\n\r\f\v]+/g, ' ')
      .trim()
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\|/g, '\\|')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
}

/** Render a value as a code span when safe (no backtick after control
 * normalization), escaping the pipe so it survives a table cell; otherwise fall
 * back to plain escaped text so a stray backtick can never corrupt the row. */
function codeSpan(s: string): string {
   const norm = s
      .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
      .replace(/[ \t\n\r\f\v]+/g, ' ')
      .trim();
   return norm.includes('`') ? esc(s) : `\`${norm.replace(/\|/g, '\\|')}\``;
}

/** A hex commit pin shown short; any other locator shown verbatim. */
function shortPin(pin: string): string {
   return /^[0-9a-f]{7,}$/i.test(pin) ? pin.slice(0, 12) : pin;
}

/** Human-readable pin drift. Only git-derived counts, never a wall-clock value, so
 * the page stays byte-deterministic across the three SDKs. */
function pinDriftLabel(r: StatusResult['pinReport']): string {
   switch (r.state) {
      case 'up-to-date':
         return 'up-to-date';
      case 'ahead':
         return `ahead ${r.ahead ?? '?'}`;
      case 'behind':
         return `behind ${r.behind ?? '?'}`;
      case 'diverged':
         return `diverged (ahead ${r.ahead ?? '?'}, behind ${r.behind ?? '?'})`;
      case 'unrelated':
         return 'unrelated';
      default:
         return 'unknown';
   }
}

/** Escape a string for a quoted mermaid node label `["..."]`: collapse
 * control/whitespace, map `"` to the mermaid entity, and replace the structural
 * characters that break mermaid parsing. Deterministic and identical across SDKs. */
function mermaidLabel(s: string): string {
   const t = s
      .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
      .replace(/[ \t\n\r\f\v]+/g, ' ')
      .trim()
      .replace(/"/g, '#quot;')
      .replace(/[[\]{}()<>|`]/g, ' ')
      .replace(/ +/g, ' ')
      .trim();
   return t === '' ? '?' : t;
}

/** The generated "Manifest" page: a human-friendly view of `leji.json` plus the
 * local federation diagnostics (hydration + pin drift) a reader can't get from the
 * raw JSON. Generated chrome like the sidebar — written to the gitignored
 * `.leji/viewer/`, regenerated every run, served via a dedicated route, never
 * committed. Declaration-driven (the manifest is truth; mount status is joined by
 * name). Deterministic by construction: declared values plus git-derived (never
 * wall-clock, never networked) state, under one escaping/ordering contract, so the
 * three SDKs emit identical bytes. */
export function buildManifestPage(manifest: Manifest, statuses: StatusResult[]): string {
   const title = manifest.viewer?.title ?? manifest.name;
   const lines: string[] = [
      `# ${esc(title)}: Manifest`,
      '',
      "A human-readable view of this layer's `leji.json`.",
      '',
      '> **Declared** values come straight from the manifest. **Observed** values (mount availability and drift) are read from local projections and Git objects; no network fetch is performed.',
      '',
      '## Identity',
      '',
      '| Field | Declared |',
      '| --- | --- |',
      `| Name | ${codeSpan(manifest.name)} |`,
   ];
   if (manifest.description) lines.push(`| Description | ${esc(manifest.description)} |`);
   lines.push(`| Spec line | ${codeSpan(manifest.leji)} |`);
   const owner = manifest.owners?.primary;
   if (owner) lines.push(`| Owner | ${esc(owner.name)}${owner.contact ? ` (${codeSpan(owner.contact)})` : ''} |`);
   const claimed = manifest.conformance?.claimedLevel;
   lines.push(
      `| Conformance | ${claimed ? `claims \`${esc(claimed)}\` (run \`leji conformance\` to verify)` : 'no level claimed'} |`,
   );

   lines.push('', '## Entrypoints', '', '| Purpose | Path |', '| --- | --- |');
   lines.push(`| Boot profile | ${codeSpan(manifest.bootProfilePath)} |`);
   lines.push(`| Context root | ${codeSpan(manifest.rootPath)} |`);
   const m = manifest.machine;
   if (m?.indexPath) lines.push(`| Context index | ${codeSpan(m.indexPath)} |`);
   if (m?.changelogPath) lines.push(`| Changelog | ${codeSpan(m.changelogPath)} |`);
   if (m?.agentProfilesPath) lines.push(`| Agent profiles | ${codeSpan(m.agentProfilesPath)} |`);
   if (m?.decisionRecordsPath) lines.push(`| Decision records | ${codeSpan(m.decisionRecordsPath)} |`);

   // Categories: a count summary of the declared index files. The documents
   // themselves are enumerated by the sidebar (grouped by category), so listing their
   // paths here would only duplicate that; the manifest fact worth surfacing is shape.
   const populated = CATEGORY_IDS.filter((c) => (manifest.categories[c]?.indexes?.length ?? 0) > 0);
   if (populated.length > 0) {
      const summary = populated
         .map((c) => `${CATEGORY_LABELS[c]} ${manifest.categories[c]?.indexes?.length ?? 0}`)
         .join(' · ');
      lines.push(
         '',
         '## Categories',
         '',
         `**Declared index files:** ${summary}. The documents themselves are in the sidebar, grouped by category.`,
      );
   }

   const agents = manifest.agents ?? {};
   const roles = Object.keys(agents).sort(byteCompare);
   if (roles.length > 0) {
      lines.push('', '## Agents', '', '| Role | Profile |', '| --- | --- |');
      for (const role of roles) lines.push(`| ${codeSpan(role)} | ${codeSpan(agents[role])} |`);
   }

   // Actors, when declared: this page renders the manifest, so a declared top-level
   // key that it silently omitted would make the page wrong for the layers using it.
   // One row per (actor, role), because the command is keyed by the pair.
   const actors = manifest.actors ?? {};
   const actorIds = Object.keys(actors).sort(byteCompare);
   if (actorIds.length > 0) {
      lines.push('', '## Actors', '', '| Actor | Role | Command |', '| --- | --- | --- |');
      for (const id of actorIds) {
         const actor = actors[id];
         for (const role of [...(actor.roles ?? [])].sort(byteCompare)) {
            const command = actor.commands?.[role];
            lines.push(`| ${codeSpan(id)} | ${codeSpan(role)} | ${command ? codeSpan(command) : '—'} |`);
         }
      }
   }

   // Federation gets the visual weight: it is the operational view unique to this
   // page. Graph first (composition at a glance), then an observed-state summary, then
   // the evidence table. Declaration-driven and byte-sorted by name; a mount with no
   // matching status is `unknown`, an absent optional field is an em dash.
   const mounts = [...(manifest.federation?.mounts ?? [])].sort((a, b) => byteCompare(a.name, b.name));
   lines.push('', '## Federation', '');
   if (mounts.length === 0) {
      lines.push('No federated mounts are declared for this layer.');
   } else {
      const statusByName = new Map(statuses.map((s) => [s.name, s]));
      if (manifest.viewer?.mermaid !== false) {
         const graph = ['```mermaid', 'flowchart LR', `   host["${mermaidLabel(title)}"]`];
         mounts.forEach((d, i) => {
            graph.push(`   m${i}["${mermaidLabel(d.name)}"]`);
            graph.push(`   host --> m${i}`);
         });
         graph.push('```', '');
         lines.push(...graph);
      }
      const hydrated = mounts.filter((d) => statusByName.get(d.name)?.present).length;
      // Drift = any known non-current relationship to the pin (ahead/behind/diverged/
      // unrelated); only `unknown` (uncomputable locally) is left out of the count.
      const drifting = mounts.filter((d) => {
         const st = statusByName.get(d.name)?.pinReport.state;
         return st === 'ahead' || st === 'behind' || st === 'diverged' || st === 'unrelated';
      }).length;
      lines.push(
         `**Observed:** ${hydrated}/${mounts.length} mounts hydrated locally · ${drifting} drifting from pin.`,
         '',
      );
      // The table stays operational (status + provenance); the descriptive Role is a
      // sentence per mount, so it reads as a list below rather than widening a cell.
      lines.push('| Mount | Availability | Drift | Owner | Pin | Source |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const d of mounts) {
         const s = statusByName.get(d.name);
         const availability = s ? (s.present ? 'hydrated' : 'not hydrated') : 'unknown';
         const drift = s ? pinDriftLabel(s.pinReport) : 'unknown';
         const ownerCell = d.owner?.name ? esc(d.owner.name) : '—';
         const sourceCell = d.source ? codeSpan(d.source) : '—';
         const pinCell = d.pin
            ? `${codeSpan(shortPin(d.pin))}${d.trackingRef ? ` @ ${codeSpan(d.trackingRef)}` : ''}`
            : '—';
         lines.push(`| ${esc(d.name)} | ${availability} | ${drift} | ${ownerCell} | ${pinCell} | ${sourceCell} |`);
      }
      lines.push(
         '',
         '> `not hydrated` / `unknown` are normal degraded reads; ordinary validation never fails just because a mount is unavailable (opt-in federation enforcement is separate). Run `leji mounts hydrate`, then regenerate the viewer to refresh.',
      );
      const roled = mounts.filter((d) => d.role);
      if (roled.length > 0) {
         lines.push('', '**Roles**', '');
         for (const d of roled) lines.push(`- **${esc(d.name)}**: ${esc(d.role ?? '')}`);
      }
   }
   lines.push('');
   return lines.join('\n');
}

/** One frontmatter scalar as a markdown-safe inline value. */
function profileValue(value: unknown): string {
   if (typeof value === 'string') return codeSpan(value);
   if (value === null || value === undefined) return '—';
   return typeof value === 'object' ? codeSpan(JSON.stringify(value)) : codeSpan(String(value));
}

/**
 * The page for an agent profile that declares `inherits`: the effective profile
 * after resolution, never the authored file, which is only its own half. Sources
 * are named, each posture entry is labelled with the profile that supplied it, and
 * the composite body keeps the resolver's source markers. A profile that does not
 * resolve renders its findings instead: there is no effective profile to show, and
 * presenting the derived file as if there were would be the error the finding names.
 */
export function unresolvedProfilePage(relPath: string, findings: Finding[]): string {
   const lines = [
      `# ${esc(relPath)}: unresolved profile`,
      '',
      `> **This profile does not resolve.** ${codeSpan(relPath)} declares \`inherits\`, and the inheritance cannot be resolved, so the layer has no effective profile for this role. The file on disk is only its own half and is not shown here: a consumer that cannot resolve an inherited profile must not apply the derived file alone.`,
      '',
      '| Rule | Where | Problem |',
      '| --- | --- | --- |',
   ];
   for (const f of findings) {
      lines.push(`| ${codeSpan(f.rule)} | ${f.path === undefined ? '—' : codeSpan(f.path)} | ${esc(f.message)} |`);
   }
   if (findings.length === 0) lines.push(`| — | ${codeSpan(relPath)} | the profile could not be resolved |`);
   lines.push('');
   return lines.join('\n');
}

function renderResolvedProfile(profiles: ScannedProfile[], derived: ScannedProfile): string {
   const fm = derived.frontmatter ?? {};
   const derivedId = typeof fm.id === 'string' ? fm.id : derived.relPath;
   const resolved = resolveAgentProfile(derived, profiles);
   if (resolved.frontmatter === null || resolved.body === null) {
      return unresolvedProfilePage(derived.relPath, resolved.findings);
   }

   const [baseId] = resolved.sourceIds;
   const base = profiles.find((p) => p.frontmatter?.id === baseId);
   const baseRel = base?.relPath ?? baseId;
   const baseFm = base?.frontmatter ?? {};
   const effective = resolved.frontmatter;
   const title = typeof effective.name === 'string' ? effective.name : derivedId;
   const lines: string[] = [
      `# ${esc(title)}: resolved profile`,
      '',
      `> **Resolved profile.** ${codeSpan(derived.relPath)} declares \`inherits: ${esc(baseId)}\`, so this page is the effective profile: posture from ${codeSpan(baseRel)} first, then this profile's own, with exact duplicates dropped. Every other field is this profile's own; both bodies are operative, base first. The file on disk carries only its own half.`,
      '',
      `**Sources**, base first: ${codeSpan(baseRel)} (\`${esc(baseId)}\`), then ${codeSpan(derived.relPath)} (\`${esc(derivedId)}\`).`,
      '',
      '## Effective frontmatter',
      '',
   ];
   for (const [key, value] of Object.entries(effective)) {
      if (!Array.isArray(value)) {
         lines.push(`- **${esc(key)}**: ${profileValue(value)}`);
         continue;
      }
      // Composed posture: label every entry with the profile that supplied it.
      const fromBase = new Set(
         (Array.isArray(baseFm[key]) ? (baseFm[key] as unknown[]) : []).map((v) => JSON.stringify(v) ?? ''),
      );
      lines.push(`- **${esc(key)}**`);
      if (value.length === 0) lines.push('   - (empty)');
      for (const entry of value) {
         const source = fromBase.has(JSON.stringify(entry) ?? '') ? baseId : derivedId;
         lines.push(`   - ${profileValue(entry)} (from \`${esc(source)}\`)`);
      }
   }
   lines.push('', '## Effective body', '');
   // The resolver's markers stay in the page (they are what a consumer reads);
   // each gets a visible line beside it so the rendered view names its source too.
   const labelled = resolved.body
      .replace(
         `<!-- inherited from: ${baseId} -->`,
         () => `<!-- inherited from: ${baseId} -->\n\n*Inherited from ${codeSpan(baseRel)}.*`,
      )
      .replace(`<!-- ${derivedId} -->`, () => `<!-- ${derivedId} -->\n\n*From ${codeSpan(derived.relPath)}.*`);
   lines.push(labelled);
   return lines.join('\n');
}

/** True when the file at `repoRel` declares `inherits`, so it is one half of a
 * profile and must never reach a reader as the effective one. Manifest-free and
 * total, so the serve path can still classify when nothing else is readable. */
export function declaresInherits(root: string, repoRel: string): boolean {
   try {
      const text = readTextWithin(path.resolve(root), path.join(root, repoRel));
      return text !== null && typeof parseFrontmatter(text).data?.inherits === 'string';
   } catch {
      return false;
   }
}

/**
 * True when the layer file at `repoRel` may be read into something served or
 * exported: judged by the servable-roots whitelist as requested AND after symlink
 * resolution, the same pair of checks `serveFrom` makes on a response. A path that
 * resolves into a private `.leji/` role fails, however it was spelled.
 */
function servableSource(root: string, repoRel: string): boolean {
   const rootAbs = resolvedPath(path.resolve(root));
   if (rootAbs === null) return false;
   const abs = path.join(rootAbs, repoRel);
   if (!servablePath(rootAbs, abs)) return false;
   const real = resolvedPath(abs);
   return real !== null && servablePath(rootAbs, real);
}

/**
 * A profile source read the way check-before-act requires: the requested path is judged, its
 * RESOLVED path is judged, and the bytes come from the descriptor opened on that
 * resolved path and proved a regular file — so nothing swapped between the check and
 * the read (a file, or any directory above it, becoming a symlink) changes what is
 * composed into a served or exported page. Null for anything refused.
 */
function servableProfileText(rootAbs: string, repoRel: string): string | null {
   const abs = path.join(rootAbs, repoRel);
   if (!servablePath(rootAbs, abs)) return null;
   const { fd } = openVerifiedSource(
      abs,
      (real) => servablePath(rootAbs, real) && (real === rootAbs || real.startsWith(rootAbs + path.sep)),
   );
   if (fd === null) return null;
   try {
      return fs.readFileSync(fd, 'utf8');
   } finally {
      fs.closeSync(fd);
   }
}

/**
 * The profile set as the viewer may render it: every source read through
 * `servableProfileText`, so no profile living in — or symlinked into — a private
 * `.leji/` role is composed into a served page or an exported one, and the bytes
 * composed are the bytes that passed the check. Dropped silently, exactly as the
 * content walk drops unservable content; the scan itself stays total, so validation
 * still reports on those files.
 */
function servableProfileSet(root: string, manifest: Manifest): ScannedProfile[] {
   const rootAbs = resolvedPath(path.resolve(root));
   if (rootAbs === null) return [];
   return scanProfileSetWith(root, manifest, (relPath) => servableProfileText(rootAbs, relPath));
}

/**
 * The page for `repoRel` when it is an agent profile that declares `inherits`,
 * else null (every other document is served from disk as authored).
 *
 * Fails closed. Once the file is known to be an inheriting profile, this function
 * owns the response: any failure below that point returns a findings page, never
 * null, because returning null hands the caller back to the raw derived file, and
 * serving half a profile as if it were the whole one is the exact outcome the
 * spec forbids.
 */
export function resolvedProfilePage(root: string, manifest: Manifest, repoRel: string): string | null {
   let committed = false;
   try {
      // Cheap rejects before the profile scan: the viewer calls this per markdown
      // fetch. Path first (an ordinary document is never a profile), then the
      // file's own frontmatter (a profile that inherits nothing is served as-is).
      const bound = Object.values(manifest.agents ?? {}).includes(repoRel);
      if (!bound && !underPath(repoRel, effectiveAgentProfilesPath(manifest))) return null;
      // The whitelist, judged before this file is read into a page: a profile that
      // resolves into a private `.leji/` role is not the viewer's to render. Null
      // hands the request back to the content walk, which refuses it the same way
      // it refuses any unservable file — this branch never becomes the way in.
      if (!servableSource(root, repoRel)) return null;
      if (!declaresInherits(root, repoRel)) return null;
      committed = true;
      const profiles = servableProfileSet(root, manifest);
      const derived = profiles.find((p) => p.relPath === repoRel);
      if (!derived) {
         return unresolvedProfilePage(repoRel, [
            finding('artifact-parse', 'error', 'the profile scan did not reach this file', repoRel),
         ]);
      }
      return renderResolvedProfile(profiles, derived);
   } catch (e) {
      if (!committed) return null; // not established as a profile: not this page's file
      return unresolvedProfilePage(repoRel, [
         finding('artifact-parse', 'error', `resolving this profile failed: ${(e as Error).message}`, repoRel),
      ]);
   }
}

/** Every inheriting profile as its rootPath-relative viewer path and resolved
 * page, so a static export carries what the local server renders. */
export function resolvedProfilePages(root: string, manifest: Manifest): { rel: string; page: string }[] {
   const profiles = servableProfileSet(root, manifest);
   const out: { rel: string; page: string }[] = [];
   for (const p of profiles) {
      if (typeof p.frontmatter?.inherits !== 'string') continue;
      const rel = relativeToRoot(p.relPath, manifest.rootPath);
      if (rel === null) continue; // outside the context root: not servable
      out.push({ rel, page: renderResolvedProfile(profiles, p) });
   }
   return out;
}

/** The starter overview/home page: a short explainer the owner can edit freely,
 * plus the auto-generated layer map inside the regen markers. */
function buildOverviewSeed(manifest: Manifest, entries: IndexEntryLite[]): string {
   return `# ${manifest.name}

This is the **Leji context layer** for \`${manifest.name}\`: the shared, validated context
people and coding agents read before working in this repository. Start with the boot
profile, then browse the categories in the sidebar.

This page is yours to edit. The map below is regenerated by \`leji viewer\` between the
markers; the prose around it is left untouched.

${mapBlock(manifest, entries)}

- Write a \`\`\`mermaid code block in any document and it renders as a diagram here.
- Run \`leji conformance\` to see the level this layer claims and verifies.
`;
}

/**
 * Generate the static viewer into the context root: a Docsify `index.html` and a
 * `_sidebar.md` projected from the index. Presentation is non-normative; this is
 * the reference projection of context-index.json into a browsable surface.
 */
/** Assemble the current sidebar for a layer entirely in memory: pins (with
 * boot-pin replacement), pin-filtered groups, and the homepage-excluded
 * reference tree. Used by generation and by the serve path, which rebuilds it
 * per fetch so a long-running viewer never shows a deleted or moved document. */
export function assembleSidebar(
   root: string,
   manifest: Manifest,
   entries: { id: string; path: string; title: string; category: string; kind?: string; date?: string }[],
   findings: Finding[],
): string {
   const governedPaths = new Set(entries.map((e) => e.path));

   // Pinned pages: resolved to servable rels. A pin is a path string (label
   // derived) or `{ path, label }` (a curated label, emoji welcome). Missing or
   // out-of-root pins are surfaced, never silently dropped. Pinning the boot
   // profile replaces its default line, so its label is the team's to curate.
   const pins: SidebarEntry[] = [];
   const pinnedRootRel = new Set<string>();
   let bootPinned = false;
   for (const pin of manifest.viewer?.pins ?? []) {
      const pinPath = typeof pin === 'string' ? pin : pin.path;
      const pinLabel = typeof pin === 'string' ? undefined : pin.label;
      // Pins are repo-relative canonically; a rootPath-relative pin under the
      // context root is accepted too (same tolerance as homepage/logo/favicon).
      // repoRel tracks where the file actually lives for reads and comparisons.
      let rel = relativeToRoot(pinPath, manifest.rootPath);
      let repoRel = pinPath;
      if (rel === null || !isFile(path.join(root, pinPath))) {
         const base = stripSlash(manifest.rootPath);
         const alt = stripSlash(pinPath).replace(/^\.\//, '');
         const altRepo = base && base !== '.' ? `${base}/${alt}` : alt;
         if (isFile(path.join(root, altRepo))) {
            rel = alt;
            repoRel = altRepo;
         } else {
            rel = null;
         }
      }
      if (rel === null) {
         findings.push(
            finding(
               'viewer-pin-missing',
               'warning',
               `viewer.pins entry "${pinPath}" does not resolve to a markdown file under rootPath`,
               pinPath,
            ),
         );
         continue;
      }
      if (repoRel === manifest.bootProfilePath) bootPinned = true;
      pinnedRootRel.add(rel);
      pins.push({ rel, title: pinLabel ?? sidebarLabel(root, repoRel, rel) });
   }

   // The generated Manifest page is always pinned as system chrome, ahead of the
   // user's own pins. Served via a dedicated route from the viewer dir under a
   // reserved underscore name (see serveViewer / the static build), so its rel is the
   // literal "_manifest.md" and it needs no on-disk existence check under the root.
   if (!pinnedRootRel.has('_manifest.md')) {
      pins.unshift({ rel: '_manifest.md', title: '📄 Manifest' });
      pinnedRootRel.add('_manifest.md');
   }

   // A pin replaces the doc's default sidebar position: pinned docs render in
   // the top zone only, dropped from their group listing like the tree below.
   const groups = buildSidebarGroups(root, manifest, entries).map((g) => ({
      ...g,
      entries: g.entries.filter((e) => !pinnedRootRel.has(e.rel)),
   }));
   // The homepage already has a fixed entry point (the sidebar title links to it),
   // so like a pin it never re-lists in the reference tree.
   const homepageRel = effectiveHomepage(root, manifest, []);
   const tree = referenceTree(root, manifest, governedPaths).filter(
      (n) => !pinnedRootRel.has(n.rel) && n.rel !== homepageRel,
   );
   return buildSidebar(manifest, groups, tree, pins, { bootPinned });
}

/**
 * The SPA shell for one flavor of the chrome: the template with this layer's config
 * baked in, every URL it emits written against `base`. The served flavor (`'/'`) and
 * the export flavor (`''`) come from this one function, so the export never gets its
 * HTML rewritten after the fact. `findings` collects the two resolution warnings
 * (homepage, accent) in their established order; the export invocation discards
 * them, having already reported the generation run's.
 */
export function buildIndexHtml(root: string, manifest: Manifest, base: ChromeBase, findings: Finding[]): string {
   // Display title: viewer.title override, else the context layer name.
   const displayTitle = manifest.viewer?.title ?? manifest.name;
   // The sidebar header. A configured brand logo renders as a centered block (the
   // wordmark IS the title, the way hand-built dashboards do it); the default Leji
   // mark renders small and inline beside the title text. Raw <img> HTML inside
   // `name` rather than Docsify's `logo` option (which prepends basePath /content/
   // and 404s). Title is HTML-escaped; the strict CSP (script-src 'self') kills handlers.
   const logoUrl = htmlEscape(resolveLogo(root, manifest.rootPath, manifest.viewer?.logo, base));
   const nameHtml = manifest.viewer?.logo
      ? `<img src="${logoUrl}" alt="${htmlEscape(displayTitle)}" style="max-width:180px;margin:10px auto;display:block;" />`
      : `<img src="${logoUrl}" alt="" style="height:1.7rem;vertical-align:middle;margin-right:0.45rem" />` +
        htmlEscape(displayTitle);
   // Favicon: a configured path is served from the content mount; unset falls back
   // to the vendored Leji mark.
   const faviconUrl = htmlEscape(
      manifest.viewer?.favicon
         ? `${base}content/${resolveViewerRel(root, manifest.rootPath, manifest.viewer.favicon) ?? stripSlash(manifest.viewer.favicon)}`
         : defaultLogo(base),
   );
   // Mermaid on unless explicitly disabled; off omits both scripts and skips copying
   // their assets (~3MB smaller viewer).
   const mermaidEnabled = manifest.viewer?.mermaid !== false;
   const mermaidScripts = mermaidEnabled
      ? '\n      <script src="assets/mermaid.min.js"></script>' +
        '\n      <script src="assets/docsify-mermaid.js"></script>'
      : '';
   // Resolved before the config literal so the mermaid text color can be computed
   // from the accent; the two resolutions keep their original order, so do the
   // findings they raise.
   const homepage = effectiveHomepage(root, manifest, findings);
   const themeColor = resolveThemeColor(manifest, findings);
   // One pass over the template with a resolver map, never four sequential
   // replaces: a sequential pass re-scans what the previous one substituted, so a
   // manifest string like "{{DOCSIFY_CONFIG}}" in viewer.title or viewer.favicon
   // would be expanded a second time and break out of the element it landed in.
   const substitutions: Record<string, string> = {
      LEJI_NAME_HTML: htmlEscape(displayTitle),
      FAVICON_URL: faviconUrl,
      DOCSIFY_CONFIG: jsonForScript({
         name: nameHtml,
         // Where the layer's markdown is mounted. Docsify's own key, so the boot
         // script configures the router from it rather than hardcoding a root:
         // '/content/' served, 'content/' exported (resolved against the page, so
         // the tree hosts under any subpath).
         basePath: `${base}content/`,
         // Hash navigation for the logo/title link: #/ re-routes to the
         // homepage inside the SPA instead of a full page reload.
         nameLink: '#/',
         // Per-page classification badge (top-right chip): the boot script
         // resolves the current route against the served index using these.
         lejiIndexRel: relativeToRoot(effectiveIndexPath(manifest), manifest.rootPath),
         lejiBootPath: relativeToRoot(manifest.bootProfilePath, manifest.rootPath),
         lejiAgentsPrefix: relativeToRoot(effectiveAgentProfilesPath(manifest), manifest.rootPath),
         lejiAgentsLabel: manifest.viewer?.agentsLabel ?? '🤖 Agents',
         lejiCategories: Object.fromEntries(
            CATEGORY_IDS.map((c) => [
               c,
               `${manifest.viewer?.categoryEmojis?.[c] ?? CATEGORY_EMOJI[c]} ${CATEGORY_LABELS[c]}`,
            ]),
         ),

         // The homepage is rootPath-relative; teams whose layer has a real
         // landing page point at it instead of the seeded overview.
         homepage,
         themeColor,
         // Mermaid node text, readable against the accent. Computed here because
         // this side resolves every accepted color form; the boot script's own
         // hex-only fallback covers viewer trees generated before this field.
         // Leji's own key, not one Docsify reads, hence the prefix.
         lejiMermaidTextColor: mermaidTextColor(themeColor),
         // Read by the boot script's powered-by plugin; false removes the mark.
         lejiPoweredBy: manifest.viewer?.poweredBy !== false,
      }),
      MERMAID_SCRIPTS: mermaidScripts,
   };
   return fs
      .readFileSync(path.join(templatesDir(), 'viewer', 'index.html'), 'utf8')
      .replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => substitutions[key] ?? whole);
}

export function generateViewer(root: string, manifest: Manifest): ViewerResult {
   const result = generateIndex(root, manifest);
   // Don't project a viewer from a tree that can't be indexed cleanly: surface the
   // errors and write nothing, the same refusal writeIndex makes.
   if (result.findings.some((f) => f.severity === 'error')) {
      return { written: [], findings: result.findings, entries: 0 };
   }
   const entries = result.index?.entries ?? [];
   const findingsEarly: Finding[] = [];

   // The served flavor: the chrome under `.leji/viewer/` is never export-flavored.
   const html = buildIndexHtml(root, manifest, '/', findingsEarly);
   const sidebar = assembleSidebar(root, manifest, entries, findingsEarly);

   const rootDir = stripSlash(manifest.rootPath) || '.';
   const rootAbs = path.resolve(root);
   const findings: Finding[] = [...result.findings, ...findingsEarly];
   const written: string[] = [];

   // Check-before-act: the generation target — the `.leji/viewer/` role — is
   // realpath-resolved and validated BEFORE a single byte is written. A `.leji/viewer`
   // that resolves into a DIFFERENT private role (`.leji/work/`, `.leji/mounts/`, a
   // future role), or out of the repository altogether, is refused here, so a
   // symlinked viewer can never be written through into the trust domain or out of the
   // tree; only its own directory passes. Unresolvable (permission/I/O error, not mere
   // absence) fails the check rather than being rebuilt lexically.
   const resolvedRoot = resolvedPath(rootAbs) ?? rootAbs;
   const viewerTarget = resolvedPath(path.join(resolvedRoot, VIEWER_REL));
   const verdict = viewerTarget === null ? null : writableTarget(resolvedRoot, viewerTarget, VIEWER_REL);
   if (viewerTarget === null || verdict === null || !verdict.ok) {
      findings.push(
         finding(
            'viewer-target-refused',
            'error',
            viewerTarget === null
               ? `refusing to generate the viewer: ${VIEWER_REL}/ cannot be resolved (permission or I/O error); remove the symlink`
               : verdict!.outsideRoot === true
                 ? `refusing to generate the viewer: ${VIEWER_REL}/ resolves outside the repository; remove the symlink`
                 : `refusing to generate the viewer: ${VIEWER_REL}/ resolves into ${LEJI_DIR}/${verdict!.role} (private); remove the symlink`,
            VIEWER_REL,
         ),
      );
      return { written, findings, entries: 0 };
   }

   // Every `.leji/viewer/` write goes back through the chokepoint with the viewer's
   // own role, so each file is judged on its RESOLVED path immediately before it is
   // written and lands there: the role was validated as a whole above, and this keeps
   // a symlink planted inside the tree from redirecting a single file elsewhere.
   const writeViewerFile = (rel: string, content: string | Buffer): void => {
      const verdict = writeFileGuarded(resolvedRoot, path.join(root, rel), VIEWER_REL, content);
      if (!verdict.ok) {
         findings.push(finding('artifact-parse', 'error', `viewer path ${rel} resolves outside ${VIEWER_REL}/`, rel));
         return;
      }
      written.push(rel);
   };

   // The chrome's role in the unified root `.leji/` (gitignored): outside the
   // context root whatever rootPath is, so it never collides with the user's own
   // files and never rides a content walk.
   const viewerDir = VIEWER_REL;
   for (const [name, content] of [
      ['index.html', html],
      ['_sidebar.md', sidebar],
   ] as const) {
      writeViewerFile(`${viewerDir}/${name}`, content);
   }

   // Copy vendored viewer assets alongside the page so nothing loads from a remote
   // CDN. The provenance note is documentation, never shipped.
   const assetsSrc = path.join(templatesDir(), 'viewer', 'assets');
   const assetsRel = `${viewerDir}/assets`;
   // Mermaid off omits its two scripts from the page and their assets here (~3MB).
   const mermaidEnabled = manifest.viewer?.mermaid !== false;
   for (const asset of fs.readdirSync(assetsSrc).sort()) {
      if (asset === 'PROVENANCE.txt' || asset.startsWith('.')) continue;
      if (!mermaidEnabled && MERMAID_ASSETS.has(asset)) continue;
      const bytes = fs.readFileSync(path.join(assetsSrc, asset));
      writeViewerFile(`${assetsRel}/${asset}`, bytes);
   }

   // The overview page is user-owned content (not chrome): seeded once, never
   // overwritten. Regeneration refreshes only the marked map block; if the owner
   // removed the markers, the page is left entirely alone.
   //
   // Check-before-act: overview.md is content — its target must resolve WITHIN
   // the layer root AND never into a private `.leji/` role. It is judged on the
   // RESOLVED path (ownRole `null`: content has no `.leji/` role) BEFORE anything is
   // read or written, so an overview.md symlinked into `.leji/work/` or
   // `.leji/mounts/` is refused before the seed or the refresh writes through it —
   // and the write itself then lands via the guarded-write chokepoint on that path.
   const overviewRel = rootDir === '.' ? 'overview.md' : `${rootDir}/overview.md`;
   const overviewAbs = path.join(root, overviewRel);
   const overviewResolved = resolvedPath(overviewAbs);
   const overviewVerdict =
      overviewResolved !== null && resolvedWithinRoot(rootAbs, overviewAbs)
         ? writableTarget(resolvedRoot, overviewResolved, null)
         : null;
   const overviewRead = verifiedTargetRead(resolvedRoot, overviewAbs, null);
   if (overviewVerdict === null) {
      findings.push(finding('artifact-parse', 'error', `overview.md resolves outside the layer root`, overviewRel));
   } else if (!overviewVerdict.ok) {
      findings.push(
         finding(
            'viewer-target-refused',
            'error',
            `refusing to write overview.md: it resolves into ${LEJI_DIR}/${overviewVerdict.role} (private); remove the symlink`,
            overviewRel,
         ),
      );
   } else if (overviewRead.status === 'refused') {
      // A standing entry that cannot be verified as a regular file inside the layer:
      // the map is neither seeded through it nor refreshed from bytes read by path.
      findings.push(
         finding(
            'viewer-target-refused',
            'error',
            `refusing to write overview.md: it does not resolve to a regular file inside the repository; remove the symlink`,
            overviewRel,
         ),
      );
   } else if (overviewRead.status === 'absent') {
      const seeded = writeFileGuarded(resolvedRoot, overviewAbs, null, buildOverviewSeed(manifest, entries));
      if (seeded.ok) written.push(overviewRel);
   } else {
      // The refresh rewrites the page it just read, so those bytes come from the
      // verified descriptor rather than from a second read by pathname.
      const existing = overviewRead.bytes.toString('utf8');
      const start = existing.indexOf(MAP_START);
      const end = existing.indexOf(MAP_END);
      if (start >= 0 && end > start) {
         const updated = existing.slice(0, start) + mapBlock(manifest, entries) + existing.slice(end + MAP_END.length);
         if (updated !== existing) {
            writeFileGuarded(resolvedRoot, overviewAbs, null, updated);
         }
      } else {
         findings.push(
            finding(
               'overview-markers-missing',
               'warning',
               'overview.md has no generated-map markers; left as-is (map not refreshed)',
               overviewRel,
            ),
         );
      }
   }

   // The Manifest page: generated chrome, exactly like _sidebar.md. Written into the
   // gitignored viewer dir under a reserved underscore name (collision-free with the
   // user's own files) and served via a dedicated content route (never a committed
   // file at the context root, so no diff churn). Regenerated every run; pinned.
   writeViewerFile(`${viewerDir}/_manifest.md`, buildManifestPage(manifest, mountStatus(root, manifest)));

   return { written, findings, entries: entries.length };
}

/**
 * Extensions a browser would run as an active, same-origin document. Under
 * `/content/` they are served as text/plain instead of their active type, and
 * they are left out of the static export entirely: everything under the content
 * mount is layer material, and layer material is read, never executed.
 *
 * `.svg` is deliberately NOT here. It stays a first-class asset (viewer.logo and
 * viewer.favicon may point at one under the context root) because the inertness
 * comes from the policy, not the content type: every /content/ response carries
 * the sandbox CSP the serve module sets, so an SVG navigated to or framed lands
 * in an opaque origin with scripting off, and an SVG loaded as an <img> never
 * runs script whatever its type.
 *
 * Shared by the two consumers of this module: the serve path types these files
 * inert, and the export leaves them out of the tree entirely.
 */
export const ACTIVE_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.xhtml']);
