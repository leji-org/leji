// Reference implementation of the Task routing algorithm
// (spec/machine-readable-surface.md, "Task routing"): given a task's scope (the
// repo-relative POSIX paths it reads/changes, plus any categories and topics it
// names), compute the slice of governed context that scope selects. Composes the
// category and decision-record scans, stamping each routed document with its
// review horizon for the stale-required stop/ask rule (governance.md, Freshness).
import { byteCompare } from './text.js';
import { underPath } from './fsx.js';
import { scanCategories, scanDecisionRecords } from './layer.js';
import { type CategoryId, type Manifest, CATEGORY_IDS } from './manifest.js';

/** Decision-record statuses that bind as routable current guidance: `accepted` is
 * current, `deprecated` binds with a stale posture. `superseded`, `proposed`, and
 * `rejected` never bind (Task routing, status filter). */
export const LIVE_STATUSES: readonly string[] = ['accepted', 'deprecated'];

export interface RouteInput {
   /** Task scope: repository-root-relative POSIX paths the task reads or changes.
    * Normalized on the way in (`normalizeTaskPath`); one with no root-relative
    * form is an input error, never a silent non-match. */
   paths?: string[];
   /** Categories the task explicitly names. */
   categories?: CategoryId[];
   /** Topics the task explicitly names. Caller-supplied routing signals, never
    * derived here from paths, categories, prose, or content. Matched against a
    * mount's declared `topics` by exact string equality; duplicates collapse to
    * one signal, and an invalid entry throws rather than being dropped. */
   topics?: string[];
   /** Reference date (`YYYY-MM-DD`) for the `expired` flag. Omit to leave horizons
    * unevaluated (`expired` stays false). */
   asOf?: string;
}

/** Why a decision was routed: it declares no scope (org-wide), or the task matched
 * its `affectedPaths`, or the task matched its `affectedCategories`. */
export type DecisionMatch = 'unscoped' | 'path' | 'category';

export interface RoutedDecision {
   id: string;
   path: string;
   status: string;
   matchedBy: DecisionMatch;
   /** Decision records carry no review horizon (their schema forbids `freshness`),
    * so these are always null/false; present for a uniform routed shape. */
   reviewAfter: string | null;
   expired: boolean;
}

export interface RoutedDocument {
   path: string;
   category: CategoryId;
   /** The document's `freshness.reviewAfter`, or null if it declares none. */
   reviewAfter: string | null;
   /** True when `reviewAfter` is set, has passed `asOf`, and `asOf` was provided. */
   expired: boolean;
}

/** A governed record routed as a dated candidate, never as current intent. A
 * record is `required` only when the task's path scope selects it directly;
 * being a category match (or the newest by date) never makes it required. */
export interface RoutedRecord {
   path: string;
   category: CategoryId;
   /** The record's frontmatter date, or null when it declares none. */
   date: string | null;
   required: boolean;
}

/** A federated sibling mount matched by the supplied category or topic signals.
 * Both are machine-decidable: categories by the signalled set, `topics` by exact
 * string equality against the topics the task names. `requiredWhen` stays
 * free-text the agent judges, so absence here does not prove a mount irrelevant
 * or not required. distribution.md, "Reading a federated context layer". */
export interface RoutedMount {
   name: string;
   pin: string;
}

export interface RouteResult {
   /** True when the task supplied a non-empty path scope. When false, path-scoped
    * routing was not evaluated and a caller MUST say so (algorithm, empty scope). */
   pathScoped: boolean;
   /** EXPANDED categories: those the task explicitly names. Only these load a
    * category's intent documents and record candidates. Canonical category order. */
   categories: CategoryId[];
   /** SIGNALLED categories: the expanded set plus the category of any task path
    * that is itself a governed document. A matching signal for decisions and
    * mounts that loads nothing on its own. Canonical category order. */
   categorySignals: CategoryId[];
   /** Governed INTENT documents in an expanded category (the required context),
    * sorted by path. Records never appear here. */
   documents: RoutedDocument[];
   /** Record candidates: dated entries the agent
    * loads by judgment, sorted by path. Decision records route via `decisions`,
    * never here. */
   records: RoutedRecord[];
   /** Live decision records routed for this task, sorted by path. */
   decisions: RoutedDecision[];
   /** Sibling mounts matched by the supplied category/topic signals, sorted by
    * name. Absence does not prove irrelevance: an agent still applies the mount's
    * free-text `requiredWhen` itself. */
   mounts: RoutedMount[];
}

/** Bidirectional path containment: a and b match when equal or one is an ancestor
 * of the other (so trailing slashes on either side normalize). */
function pathsOverlap(a: string, b: string): boolean {
   return underPath(a, b) || underPath(b, a);
}

/**
 * Normalize one task-scope path (spec: Requirement 6 and Task routing items 1-2):
 * POSIX-style, root-relative, no leading `./`, any trailing `/` removed, and `.`
 * and `..` segments resolved lexically. Never consults the filesystem. The
 * repository root normalizes to `.`, which the containment relation treats as
 * matching everything.
 *
 * Returns null for a path with no root-relative form: an absolute path, or one
 * whose `..` segments climb above the root. Callers reject those rather than pass
 * them through — an unnormalized task path silently fails to match the declared
 * side, which is how `--federation=required` used to pass open on `./docs/x.md`
 * and on `docs/x.md/` while failing correctly on `docs/x.md`.
 */
export function normalizeTaskPath(p: string): string | null {
   if (p.startsWith('/')) return null;
   const out: string[] = [];
   for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
         if (out.length === 0) return null;
         out.pop();
         continue;
      }
      out.push(seg);
   }
   return out.length === 0 ? '.' : out.join('/');
}

function asStringArray(v: unknown): string[] {
   return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Why a value is not a valid topic, or null when it is one. A topic is a
 * non-empty string of Unicode scalar values, so an unpaired surrogate (which has
 * no UTF-8 encoding) is as invalid as an empty string. Under the `u` flag a
 * matched pair is one astral scalar value, so only a lone surrogate matches. */
function topicDefect(t: unknown): string | null {
   if (typeof t !== 'string') return 'not a string';
   if (t.length === 0) return 'empty string';
   return /\p{Surrogate}/u.test(t) ? 'lone surrogate' : null;
}

/** The effective task topic set, after validating BOTH sides of the comparison
 * (spec: Task routing, Topic match). An invalid topic is an input error on either
 * side, never a silent filter: dropping one would return a plausible empty match
 * the caller cannot tell from a real one, and dropping the same lone surrogate
 * from both sides would let two invalid values appear to match. A Set dedupes by
 * exact equality, which for valid topics is equality of their UTF-8 encodings. */
function taskTopicSet(input: RouteInput, manifest: Manifest): Set<string> {
   for (const t of input.topics ?? []) {
      const defect = topicDefect(t);
      if (defect !== null) throw new Error(`invalid task topic: ${defect}`);
   }
   for (const m of manifest.federation?.mounts ?? []) {
      for (const t of m.topics ?? []) {
         const defect = topicDefect(t);
         if (defect !== null) throw new Error(`invalid mount topic on "${m.name}": ${defect}`);
      }
   }
   return new Set(input.topics ?? []);
}

/** A document's review horizon and whether it has expired as of `asOf`. */
function freshnessOf(
   fm: Record<string, unknown> | null,
   asOf?: string,
): { reviewAfter: string | null; expired: boolean } {
   const fr =
      fm && typeof fm.freshness === 'object' && fm.freshness !== null
         ? (fm.freshness as Record<string, unknown>)
         : null;
   const reviewAfter = fr && typeof fr.reviewAfter === 'string' ? fr.reviewAfter : null;
   // ISO dates sort lexically, so a string compare is a date compare.
   const expired = asOf !== undefined && reviewAfter !== null && reviewAfter < asOf;
   return { reviewAfter, expired };
}

/** Compute the routed slice for a task's scope. Throws on an unnormalizable task
 * path, and on an invalid topic on either side of the comparison: a caller topic
 * or a declared mount topic that is not a non-empty string of Unicode scalar
 * values is an input error. Everything
 * else is tolerant as before (malformed records simply do not bind). Topics are
 * matched as exact strings: no case conversion, no Unicode normalization, no
 * locale, no trimming. */
export function route(root: string, manifest: Manifest, input: RouteInput): RouteResult {
   // Both sides of the comparison normalize, or the matching is not the spec's.
   // An unnormalizable path is an input error, never a silent non-match: the
   // caller cannot tell a scope that routes nothing from one it spelled wrongly,
   // and a federation gate reading the second as the first fails open.
   const taskPaths: string[] = [];
   for (const raw of input.paths ?? []) {
      if (raw.length === 0) continue;
      const normalized = normalizeTaskPath(raw);
      if (normalized === null) {
         throw new Error(
            `invalid task path ${JSON.stringify(raw)}: must be repository-root-relative POSIX (no leading "/", no ".." above the root)`,
         );
      }
      taskPaths.push(normalized);
   }
   const pathScoped = taskPaths.length > 0;
   const taskTopics = taskTopicSet(input, manifest);
   const asOf = typeof input.asOf === 'string' ? input.asOf : undefined;

   const scan = scanCategories(root, manifest);
   const assignments = new Map<string, CategoryId>();
   const kindByPath = new Map<string, 'intent' | 'record'>();
   const fmByPath = new Map<string, Record<string, unknown> | null>();
   for (const d of scan.docs) {
      assignments.set(d.relPath, d.category);
      kindByPath.set(d.relPath, d.kind);
      fmByPath.set(d.relPath, d.frontmatter);
   }

   // Two category sets (spec: Task routing, item 3). A category the task NAMES is
   // `expanded`: it loads its intent documents and record candidates. A task path
   // that is itself a governed document contributes its category to `signalled`
   // only — a matching signal for decisions and mounts that loads nothing. The
   // governed-document test is exact equality, never containment: an ancestor
   // directory of a governed document is not itself governed, and inferring from
   // one would reopen the corpus fan-out this split exists to close.
   const expanded = new Set<CategoryId>();
   for (const c of input.categories ?? []) {
      if ((CATEGORY_IDS as readonly string[]).includes(c)) expanded.add(c);
   }
   const signalled = new Set<CategoryId>(expanded);
   for (const p of taskPaths) {
      const cat = assignments.get(p);
      if (cat) signalled.add(cat);
   }

   // Routing separation: intent documents are the required context; records are
   // returned separately as dated candidates. A record is required only when the
   // task's paths select it directly.
   const documents: RoutedDocument[] = [];
   const byPath = new Map<string, RoutedRecord>();
   const dateOf = (path: string): string | null => {
      // Spec Requirement 6: a non-changelog artifact's date follows ISO 8601 and
      // MAY be date-only, so a full UTC timestamp is equally valid.
      const d = fmByPath.get(path)?.date;
      if (typeof d !== 'string') return null;
      return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z)?$/.test(d) ? d : null;
   };
   for (const [path, category] of assignments) {
      // Decision records route via `decisions`, never as generic records.
      if (kindByPath.get(path) === 'record' && category === 'decisions') continue;
      const isRecord = kindByPath.get(path) === 'record';
      // A record is DIRECTLY selected when a task path contains it under the
      // lexical rule — collected independently of category, because a path scope
      // selects no category at all and the entry would otherwise be dropped here.
      const direct = taskPaths.some((tp) => pathsOverlap(tp, path));
      if (!expanded.has(category) && !direct) continue;
      if (isRecord) {
         const prior = byPath.get(path);
         byPath.set(path, {
            path,
            category,
            date: dateOf(path),
            required: direct || prior?.required === true,
         });
         continue;
      }
      const { reviewAfter, expired } = freshnessOf(fmByPath.get(path) ?? null, asOf);
      documents.push({ path, category, reviewAfter, expired });
   }
   const records: RoutedRecord[] = [...byPath.values()];
   documents.sort((a, b) => byteCompare(a.path, b.path));
   records.sort((a, b) => byteCompare(a.path, b.path));

   const decisions: RoutedDecision[] = [];
   for (const rec of scanDecisionRecords(root, manifest)) {
      const fm = rec.frontmatter;
      if (!fm) continue;
      const status = typeof fm.status === 'string' ? fm.status : '';
      if (!LIVE_STATUSES.includes(status)) continue;
      const affectedPaths = asStringArray(fm.affectedPaths);
      const affectedCategories = asStringArray(fm.affectedCategories);
      const id = typeof fm.id === 'string' ? fm.id : '';

      let matchedBy: DecisionMatch | null = null;
      if (affectedPaths.length === 0 && affectedCategories.length === 0) {
         matchedBy = 'unscoped';
      } else if (taskPaths.some((tp) => affectedPaths.some((ap) => pathsOverlap(tp, ap)))) {
         matchedBy = 'path';
      } else if (affectedCategories.some((c) => signalled.has(c as CategoryId))) {
         matchedBy = 'category';
      }
      if (matchedBy) decisions.push({ id, path: rec.relPath, status, matchedBy, reviewAfter: null, expired: false });
   }

   // Mounts matched by the supplied signals: a sibling whose `categories` overlap
   // the SIGNALLED set, or whose declared `topics` contain one the task named.
   // Signals match without expanding, so a path-scoped task still sees its mounts,
   // and a topic match selects the mount and nothing else: it never enters the
   // category sets, loads no document or record, and routes no decision. The agent
   // still applies the mount's free-text requiredWhen.
   const mounts: RoutedMount[] = (manifest.federation?.mounts ?? [])
      .filter(
         (m) =>
            (m.categories ?? []).some((c) => signalled.has(c as CategoryId)) ||
            (m.topics ?? []).some((t) => taskTopics.has(t)),
      )
      .map((m) => ({ name: m.name, pin: m.pin }))
      .sort((a, b) => byteCompare(a.name, b.name));

   const categories = CATEGORY_IDS.filter((c) => expanded.has(c));
   const categorySignals = CATEGORY_IDS.filter((c) => signalled.has(c));
   decisions.sort((a, b) => byteCompare(a.path, b.path));
   return { pathScoped, categories, categorySignals, documents, records, decisions, mounts };
}
