# Conformance fixtures

Shared test fixtures consumed by all three SDK test suites (`packages/sdk` via
`node --test`, `packages/sdk-py` via pytest, `packages/sdk-go` via `go test`).
They are the contract that keeps the three implementations behaviorally
identical: every fixture is a miniature
repository plus an `expected.json` stating what `leji validate` must report.

## Matching rules

- Findings match on the triple **(rule, severity, path)**, sorted by
  (path, rule). Message text is implementation-specific and never compared.
  This rule governs `validate` findings; the `export` block's findings carry
  their own matching and ordering contract, stated in its section below.
- Paths are POSIX, repository-root-relative, exactly as the CLI reports them.
- `expected.json` carries the expected process exit code (`0` clean or
  warnings only, `1` at least one error) and the full findings list; the match
  is exact, no extra or missing findings allowed.
- Git-dependent rules (`changelog-append-only`, `changelog-unverifiable`) are
  exercised in unit tests with injected baselines, not in fixtures: fixture
  behavior would depend on the host repository's git state.
- Beyond `validate`, a fixture may pin other commands with optional blocks:
  `"conformance": {exit, claimedLevel, verifiedLevel}`, `"indexCheck": {exit,
  stale}`, `"export"`, `"trustCanary"`, `"lejiIgnore"`, `"badge"` and `"updatePin"`
  (below), plus `"seeds"` (below). Harnesses assert them only when present, and
  ignore keys they do not know.
- Schema-violation fixtures keep one violation per artifact entry so finding
  multiplicity stays identical across validator engines (Ajv vs jsonschema).

## Planted `.leji/` trees: `.leji-seed/`

`.leji/` is gitignored repository-wide, so a fixture cannot commit files under
that name. A fixture that needs a pre-existing `.leji/` tree commits it as a
sibling `.leji-seed/` directory and declares the materialization:

```json
"seeds": [{ "from": ".leji-seed", "to": ".leji" }]
```

- `from` and `to` are repository-root-relative POSIX paths inside the fixture,
  normalized, with no `..` segment and no absolute form; a violation is a harness
  error. A seed sits in the same parent as the `.leji/` it stands for, so a
  fixture may declare more than one (`.leji-seed` and `docs/.leji-seed`).
- The harness materializes each seed in its own working copy before running any
  command: the **contents** of `from` become the contents of `to`, and the
  harness creates `to`. A pre-existing `to` is a harness error — fixtures are
  pristine by construction, so an occupied target means the working copy is not
  what the harness thinks it is.
- Seeds apply in array order and must not overlap targets: no `to` may equal
  another seed's `to` or sit inside it. Overlap is a fixture-authoring error a
  harness rejects rather than resolves.
- A seed carries regular files and directories only. A symlink anywhere inside
  one is a harness error.
- File permissions are outside the contract: a harness copies seed content with
  its platform's default modes. Nothing asserts or depends on a mode, and no
  seed file is ever executed.
- `from` stays in place — it is committed data, and the copy happens inside the
  harness's temp working copy. It is also dot-prefixed, so every content walk and
  every served route skips it. Cleanup is the standing convention: the whole
  working copy is disposed, nothing selective.
- No path component inside a seed may be named `.leji` or `dist` — both are
  gitignored at any depth. Spell those components under their seed name instead.

## Dot-prefixed goldens: `.expected-export/`

A `rootPath: "."` fixture exports its own root, so a plainly named golden would
be walked into the next bake of itself. Such a fixture commits its golden
dot-prefixed instead — `.expected-export/` and `.expected-export.manifest.json`
— which the content walk skips, exactly as it skips `.leji-seed/`. The
`goldenTree` fields below always name the plain form: a harness reads the
dot-prefixed artifact beside it wherever the plain name is absent, so the
declaration stays the same for every fixture.

## The `export` block

`"export"` pins one `leji export` run over the fixture layer. Asserted only when
present. In every path list in this block — `layout.roles`, `layout.present`,
`layout.absent`, `layout.preserved` — paths are repository-root-relative POSIX
and a trailing `/` means a directory.

| Field | Meaning |
| --- | --- |
| `args` | argv after `leji`, default `["export"]`. A variant run (`--strict`, or the co-equal `viewer build` name) states it. |
| `exit` | expected process exit code: `0` written, `1` error findings or any finding under `--strict`, `2` usage error or refusal. |
| `findings` | expected findings, matched on **(rule, severity, path, line, construct)**, ordered by (path, line, rule, construct). Message text is never compared. |
| `out` | expected output directory, repository-root-relative POSIX, matching the `out` field of `--json`. |
| `layout.roles` | role name → directory the run establishes. |
| `layout.present` | paths that must exist after the run. A **spot-check of role placement**, never an exhaustive listing — the golden tree is the exhaustive artifact. |
| `layout.absent` | paths that must not exist after the run (pre-1.4 locations a run must never create). |
| `layout.preserved` | paths present before the run that must still be present and byte-identical after it. Implies `present`. |
| `rerun` | `{byteIdentical}`. `byteIdentical: true`: after a second run over the same layer, **the complete fixture working tree** is byte-identical to the tree after the first run — the design's byte-level no-op, which subsumes every per-path question. |
| `goldenTree` | the byte contract for the written tree, below. |

`preserved` pins one half of a planted stale tree's contract — that its bytes stay
untouched — and a `trustCanary` block on the same fixture pins the other half, that
those bytes are never consumed into served or exported output.

### The pending-golden convention

Golden bytes are baked from a reviewed run, never hand-written, so a fixture
lands before its goldens exist:

```json
"goldenTree": { "status": "pending" }
```

`"status": "pending"` means **no assertion about tree bytes** — every other field
in the block still asserts. Baking flips it to:

```json
"goldenTree": {
  "status": "baked",
  "contentDir": "expected-export/content",
  "manifest": "expected-export.manifest.json"
}
```

`contentDir` holds the exported `content/` as real committed bytes (small,
human-reviewable, what an independent renderer reads); `manifest` pins every
remaining path (chrome, vendored assets, fonts) by digest and size. Its exact
form:

```json
{
  "version": 1,
  "files": {
    "index.html": { "sha256": "<64 lowercase hex>", "size": 1234 }
  }
}
```

- Keys are **export-root-relative POSIX paths** (forward slashes), files only —
  no directory entries — sorted lexicographically by key in byte order.
- The manifest covers every exported file **outside** the subtree `contentDir`
  mirrors (the export's `content/`); files inside it compare as committed bytes.
- The two sets are disjoint and together exhaustive: every file the export writes
  is pinned by exactly one of them.

A run that deliberately writes no export tree has nothing to bake, now or ever:

```json
"goldenTree": { "status": "none" }
```

`"status": "none"` means **the run writes no export tree; no byte contract exists
or is owed** — the form for a `--strict` fixture whose findings fail the run. Every
other field in the block still asserts, `rerun.byteIdentical` included: a run that
writes no tree must still leave the fixture working tree stable.

A fixture never leaves `goldenTree` out: `pending` is a claim that baking is owed,
`none` a claim that nothing is.

## The `trustCanary` block

`"trustCanary"` pins the trust-domain boundary: nothing under `.leji/` except
`viewer/` is servable, and no export carries a byte of it. Asserted only when
present.

| Field | Meaning |
| --- | --- |
| `topology` | `nested` (the fixture's `rootPath` is a subdirectory) or `dot-root` (`rootPath: "."`). A layout descriptor only; which boundary is live for a given request belongs in that request's `note`. |
| `plantedPaths` | the materialized paths carrying the canary token. |
| `serve.requests` | the **exact request corpus**: `{path, status, note?}`, issued in order against the local server. All three SDKs issue identical requests against identical bytes. |
| `serve.routeScan` | `{assertNoTokenIn200Bodies}`: every corpus request that answers `200` must answer without the token. The corpus enumerates the routes the sidebar, index and manifest page name, so this is the "no route leaks" assertion. |
| `exportScan` | `{root, occurrences}`: a recursive scan of the written export finds exactly `occurrences` matches, always `0`. |

The token is the fixed byte string `LEJI-TRUST-CANARY`. It is spelled here and in
each harness, and **deliberately in no `expected.json`**: under `rootPath: "."` a
fixture's own `expected.json` sits inside the content root and is exported like
any other file, so a token literal there would count as a leak, and the scans
would need an exclusion. `occurrences: 0` is worth more with nothing excluded.

## The `lejiIgnore` block

`"lejiIgnore"` pins the self-managed `.leji/.gitignore`: the tool ignores its own
tree from inside, so a repository whose root `.gitignore` never received the
`.leji/` line is still clean after the first command that creates a role under
`.leji/`. Asserted only when present. It carries an ARRAY of scenarios, because the
behavior turns on what already stands at the target and on which command runs, and
one layer serves several of those.

The block is the frozen contract for all three SDKs: the same scenario letters, the
same trees, the same six questions. Paths are repository-root-relative POSIX inside
the fixture working copy.

| Field | Meaning |
| --- | --- |
| `id` | the scenario letter, unique within the block |
| `note` | what this scenario exists to catch |
| `args` | argv after `leji`. The harness appends `--root <copy>` |
| `plant` | optional: one symlink the harness plants **before** the run (below). A fixture cannot commit a symlink, and two of the scenarios are about one |
| `exit` | expected process exit code: `0` the run succeeded, `1` an error finding refused it |
| `ignoreFile` | what stands at `.leji/.gitignore` after the run, judged on the ORIGINAL entry: `regular`, `symlink` (the planted link, never followed), or `absent` |
| `bytes` | the exact content the file must hold when `ignoreFile` is `regular`; `null` otherwise. The created form is always `*` plus one newline |
| `notices` | how many times the frozen stderr line `leji: .leji/.gitignore exists and was left as is (expected content: *)` appears. One invocation says it at most once, whatever it establishes |
| `untrackedUnderLeji` | optional: `git status --porcelain` entries under the root `.leji/` after the run, sorted. Always `[]`. Asserted over a COMMITTED working copy (`git init`, `git add -A`, commit, then run), because the question is meaningless over an uncommitted tree |
| `preserved` | optional: paths present before the run that must still be byte-identical after it |
| `jsonParses` | optional: `true` means `args` carries `--json` and stdout must parse as one JSON document that does not carry the notice (it is stderr only, under every output mode) |

### The `plant` field

| Field | Meaning |
| --- | --- |
| `symlinkAt` | where the harness creates the symlink |
| `symlinkTo` | what it points at: a fixture-root-relative POSIX path, or the literal `outside`, which the harness resolves to a directory it creates BESIDE the working copy (the one shape no contained path can express) |
| `targetKind` | `dir` or `file`: what the harness creates at the target before linking to it |
| `targetBytes` | for `file`, the bytes it is created with |

### The six scenarios

Lettered, and the letters are part of the contract:

- **(A)** a fresh layer with no root `.leji/` line, `leji viewer build` → the file is
  exactly `*` plus a newline and nothing under `.leji/` is untracked;
- **(B)** the same layer, `leji export` → ONE invocation establishing two roles
  (chrome and export output) writes one file and emits no notice;
- **(C)** a layer adopted before the unified layout, carrying an old `docs/.leji/`
  tree and no root line → nothing under the ROOT `.leji/` is untracked (the
  `docs/.leji/` leftovers are the documented migration case, not this one's);
- **(D)** a pre-existing `.leji/.gitignore` with somebody else's content → byte-identical
  after the run, exactly one stderr notice, and `--json` stdout still parses;
- **(E)** `.leji` is a symlink out of the repository → refused as it is today, and no
  file is written through it;
- **(F)** `.leji/.gitignore` is itself a symlink → refused, and the file it points at is
  untouched.

The swap case (an entry planted between the verified read and the exclusive create)
is unit-level in each SDK rather than here, for the same reason the `updatePin`
refusals are: producing it means driving the library with an interception, not
preparing a state.

## The `badge` block

`"badge"` pins one `leji badge` run over the fixture layer. Asserted only when
present. The command writes one SVG and prints the markdown that embeds it; the
badge states the level `leji conformance` verified in that offline run — never
more than the claim, possibly less. Paths in this block are POSIX, and each field
below says what they are relative to.

| Field | Meaning |
| --- | --- |
| `args` | argv after `leji`, default `["badge"]`. A variant run (`--out <path>`, `--json`) states it. |
| `exit` | expected process exit code: `0` the badge is written or already current, `1` a conformance error finding or `badge-unverified` (nothing was machine-verified in this run), `2` usage error or refusal. |
| `out` | the written path, matching the `out` field of `--json`; `null` when nothing is written. |
| `level` | the level the badge states — the verified level, never the claim. `null` when nothing is written. |
| `claimedLevel` | the level `leji.json` claims. Always reported, success and failure alike. |
| `verifiedLevel` | the level this offline run verified, or `null` when it verified none. Always reported. |
| `golden` | the canonical badge the written file must byte-equal, as a path relative to `fixtures/` (`badge/governed.svg`). `null` when nothing is written. |
| `action` | `wrote` (the target was absent), `unchanged` (it already held these exact bytes; nothing written), `overwrote` (it held another canonical badge of this contract), or `null` when nothing is written. |
| `written` | whether the run wrote the target at all. Stated on the exit-1 and exit-2 cases: `false` means the target does not exist after the run — and, when `preseed` planted it, that its planted bytes are still there byte for byte. A refusal never edits and never truncates. |
| `preseed` | optional: one file the harness writes into the working copy **before** the run, either `{ "path": "leji-badge.svg", "from": "badge/indexed.svg" }` (a copy of that canonical badge) or `{ "path": "leji-badge.svg", "bytes": "not a badge\n" }` (the literal bytes). `path` is repository-root-relative POSIX inside the fixture; `from` resolves relative to `fixtures/`. |
| `rerun` | `{action, byteIdentical}`. `byteIdentical: true`: after a second run over the same tree, **the complete fixture working tree** is byte-identical to the tree after the first run, and the second run reports `action`. The steady state is always `{"action": "unchanged", "byteIdentical": true}`. |

Fixture-local `leji-badge.svg` files are never committed: a fixture that needs one
declares it under `preseed`. The only committed badge bytes in this repository are
the canonical ones under `fixtures/badge/`.

A `badge` block is asserted over a **committed** git working copy of the fixture:
copy the fixture out, `git init`, `git add -A`, commit, then run. The level a badge
states is the level this run verified, and the `indexed` changelog item is `unknown`
— never `pass` — until the changelog is present in `HEAD`; `unknown` awards no level.
So a fixture run from an uncommitted copy verifies `core` whatever it claims, and
every block above `core` would fail against a plain temp directory. `gitFixture()` in
`scripts/parity-test.ts` already does this, and every SDK's badge-block runner must.

### The `--out` acceptance rule

Checked at argument parsing, before conformance runs: a rejection here is exit 2 in
the usage-error form, with no level reported at all.

`--out` takes a repository-relative POSIX path over `[A-Za-z0-9._/-]`, with no
leading `/`, no backslash, no `..` segment, no empty segment, and ending `.svg`;
anything else is exit 2 with the rule quoted. The resolved path must lie inside
the repository and never under `.leji/` at any depth — `.leji/` is tool domain,
and the badge is user content — and must not be a directory. The canonical POSIX
form is what stdout, `--json`, and the emitted markdown carry.

### The existing-file rule

Applied after conformance has succeeded, so a refusal here still reports
`claimedLevel` and `verifiedLevel` — as the foreign-file block on `valid-records`
pins. The target file decides the action, by its bytes and nothing else — no marker,
no sidecar, no state:

- absent ⇒ write it (`wrote`);
- byte-equal to the badge this run would write ⇒ `unchanged`, exit 0, nothing
  written;
- byte-equal to any other canonical badge of this contract (the four files under
  `fixtures/badge/`) ⇒ overwrite it (`overwrote`), which is how a level change
  regenerates;
- anything else ⇒ refuse, exit 2, leaving the file untouched.

### The canonical badge bytes

`fixtures/badge/` is the **sole** byte oracle for the command's output: `core.svg`,
`indexed.svg`, `governed.svg`, `federated.svg`, and the matching `core.md …
federated.md` carrying the one markdown line the command prints for the default
out path. Every implementation renders each level and byte-compares against these;
nothing else in the tree holds badge bytes.

The four files are re-derivable from this rule, so no port ever re-measures
anything:

- **Template.** One shields-flat shape, height 20, rounded via a `clipPath` with
  `rx="3"`. The identity segment is `#183D3B` and carries the mark followed by the
  wordmark `Leji 1.0`; the status segment is `#009F71` and carries `<level>` alone.
  Both `<text>` elements are white,
  `font-family="Verdana,Geneva,DejaVu Sans,sans-serif"`, `font-size="11"`,
  baseline `y="14"`, and carry `textLength` plus `lengthAdjust="spacing"` — layout
  stabilization, which pins the advance width; glyph rendering stays the
  renderer's. The self-attestation claim is structural rather than visible:
  the SVG carries `role="img"`, and its two name-bearing fields, `<title>` and
  `aria-label`, both read `Leji 1.0 · <level> · self-attested` (the separator is
  U+00B7), as does the markdown alt text; the page the markdown links carries the
  story. No XML
  declaration, no BOM, no comment, no timestamp, no version string; UTF-8, LF, one
  trailing newline. Attribute order and whitespace are identical across the four
  files: only the level word, its `textLength`, and the widths derived from it
  differ.
- **Mark.** The single `<path>` of `packages/site/src/assets/leji-icon.svg`
  (viewBox `0 0 370 391`) verbatim, its fill changed to `#FFFFFF`, placed with
  `transform="translate(5 3) scale(0.0358)"`: ~14px tall, vertically centred in the
  20px band, at the identity segment's left.
- **Widths.** Horizontal padding is 5 either side of each segment, and the mark
  occupies a 14-wide slot followed by a 3-wide gap. So the identity segment is
  `5 + 14 + 3 + 41 + 5 = 68` wide with its text at `x="22"`; the status segment is
  `<textLength> + 10` wide with its text at `x="73"`; the badge is their sum.

  | Text | `textLength` | Status segment | Badge width |
  | --- | --- | --- | --- |
  | `Leji 1.0` (wordmark) | 41 | — | — |
  | `core` | 24 | 34 | 102 |
  | `indexed` | 43 | 53 | 121 |
  | `governed` | 52 | 62 | 130 |
  | `federated` | 53 | 63 | 131 |

  Non-normative, recorded so nobody measures twice: those five numbers are the
  sum of the glyph advance widths in `Verdana.ttf` (`hmtx`, 2048 units/em) at
  11px, rounded to the nearest integer — kerning ignored, which `textLength`
  makes moot. The table is the contract; the font is only how it was arrived at.

## The manifest pin-span fixtures

`manifest-pin-span/` is not a layer and carries no `expected.json` of its own. It is
the byte oracle for the one manifest edit `leji mounts update-pin` makes: replacing
the `pin` value of ONE declared mount and nothing else. Each subdirectory is one
case:

| File | Meaning |
| --- | --- |
| `input.json` | the manifest text the edit is applied to, byte for byte |
| `case.json` | `{note, mount, from, to, outcome, error?}` — which mount is addressed, the pin the span must currently hold, the pin to write, and what must happen |
| `expected.json` | the byte-exact result. Present only when `outcome` is `replaced` |

`outcome` is `replaced` (the span moved) or `error`. An `error` case names which
refusal: `not-located` (no mount of that name carries a pin), `not-from` (the span
holds something other than `from`), or `duplicate-key` (below). All are internal
refusals raised after the manifest has already parsed and validated, so a CLI
reaching one exits 2.

**Duplicate keys are refused, never resolved.** JSON does not forbid a repeated
member, and the two readers of this document disagree about which one wins: a
lexical scan reaches the FIRST, `JSON.parse` keeps the LAST. A mount carrying two
`pin` members would therefore have its first span rewritten while every parser of
the result still read the second — a reported change that changed nothing. So every
key on the path to the pin must appear exactly once, and a repeat is the
`duplicate-key` error: `federation` at the root (`error-duplicate-federation`),
`mounts` inside it (`error-duplicate-mounts`), and `name` or `pin` on a mount
(`error-duplicate-name`, `error-duplicate-pin`). Keys elsewhere in the document are
not the scanner's business and are never inspected.

The contract these fixtures pin, and the reason a line-anchored splice will not do:
**the manifest's layout is input, never a contract.** The schema fixes no key order
and no whitespace, so an implementation locates the span by scanning JSON tokens —
walking to `federation.mounts`, selecting the array element whose `name` DECODES to
the addressed name, and taking the byte span of that element's own `pin` string
value. It decodes escapes only to compare a key or a name, skips nested objects and
arrays structurally, and rewrites nothing else. The cases exist because each one
breaks a shortcut: `reversed-key-order` (`pin` before `name`), `escaped-name` (a
`\uXXXX` escape and an astral surrogate-pair escape in the name),
`escaped-property-key` (the `pin` KEY itself spelled with escapes, which decode for
comparison while the key's own bytes survive),
`owner-name-collision`, `shared-prefix`, `crlf`, `nested-unrelated-pin` (a `"pin"`
key above the array and inside the mount's own `owner`), `non-canonical-spacing`,
`unmodeled-keys`, and `mount-not-first`.

Every `replaced` case is also a claim about confinement: the output differs from the
input in exactly `to.length - from.length` characters, and it still parses.

## The `updatePin` block

`"updatePin"` pins `leji mounts update-pin` over the fixture layer. Asserted only
when present. Unlike the blocks above it carries an ARRAY of cases, because the
command's behavior turns on the pin the manifest starts from and on what a local
object store holds — both of which a harness prepares, so one layer serves every
case and no near-identical fixture layers are committed to vary a single field.

| Field | Meaning |
| --- | --- |
| `sibling` | the scaffold recipe to build, always `acme-sibling` (below) |
| `mount` | the declared mount every case addresses |
| `cases` | the array, each entry below |

### One case

| Field | Meaning |
| --- | --- |
| `id` | the case name, unique within the block |
| `note` | what this case exists to catch |
| `pin` | the pin the harness splices into the fixture's `leji.json` before the run |
| `trackingRef` | optional. `null` removes the declared `trackingRef` entirely; absent leaves the fixture's own |
| `store` | `null` for no managed store, else `{pin, witnessRef, witnessOid, depth}` (below) |
| `hint` | write `.leji/mounts.local.json` pointing at the sibling checkout |
| `source` | `none` (no `--fetch`), `local` (the declared source is routed to the recipe repository), or `unreachable` (routed to a path that does not exist) |
| `args` | argv after `leji`. The harness appends `--root <copy> --json` |
| `exit` | expected process exit code: `0` updated, unchanged or a dry run; `1` the move was refused; `2` a usage error |
| `action` | `updated`, `unchanged`, `dry-run`, `refused`, or `null` when the run emits no document at all |
| `from` / `to` | the `mount.from` and `mount.to` the document reports, or `null` |
| `reason` | the stable refusal code, or `null` |
| `override` | whether the non-fast-forward override was exercised |
| `comparisonRepository` | optional: the `pinReport.comparisonRepository` this case pins |
| `comparedRef` | optional: the `pinReport.comparedRef` this case pins, which is how the resolved default branch is asserted |
| `manifestGolden` | the byte contract for the rewritten `leji.json`, as a path relative to `fixtures/`, or `null` |
| `written` | `false` means `leji.json` is byte-identical to the manifest the run started from |

The document's key set is exactly `command, ok, findings, summary, mount, pinReport,
action, override`, plus `reason` on a refusal. `ok` is `true` exactly when `reason`
is `null`; the findings are one error finding whose rule IS the reason code, plus one
warning finding `mount-pin-non-fast-forward-override` when `override` is true, and
the summary counts exactly those. A case whose `action` is `null` writes nothing to
stdout at all: a usage error reports no outcome.

`store` builds the managed store exactly as a successful `--fetch` leaves it, under
`.leji/mounts/store/<sha256(source identity)>`:

- `pin` — retained under `refs/leji-pin/v1/<sha256(identity)>/<oid>`, or `null` for a
  store that holds no pin;
- `witnessRef` + `witnessOid` — published under
  `refs/leji-witness/v1/<sha256(identity)>/<sha256(witnessRef)>`, or `null` for a
  store with no witness at all;
- `depth` — when set, both fetches are `--depth <n>`, which is how a store that holds
  both commits and still cannot answer their ancestry is built.

`FETCH_HEAD` is removed afterwards: it records a per-harness path and is not part of
any contract.

### The `acme-sibling` recipe

The scaffold every `updatePin` case is prepared against. It is spelled here rather
than committed as bytes, because it must be a real git repository and `.git` cannot
be committed inside a fixture. Every input a commit hashes is fixed, so the recipe's
commit ids are CONSTANTS an `expected.json` carries, not observations a harness
reads back.

For every commit: author and committer `Leji Fixtures <fixtures@leji.org>`, both
dates `2026-01-01T00:00:00 +0000`, `commit.gpgsign=false`, `core.autocrlf=false`,
initial branch `main`. Each step writes ONE file whose content is `# <stem>` plus a
newline, stages everything, and commits with the stem as the whole message:

| Step | Branch | File | Commit id |
| --- | --- | --- | --- |
| 1 | `main` | `a.md` | `6b06fe51a323212156bb267842bf10187ed4c20e` |
| 2 | `main` | `b.md` | `3ff2a04361ca9d601180037bdfbc8b6c0a0a8723` |
| 3 | `side`, branched from step 1 | `s.md` | `50305153f1a107c6871ab3b3047cb4c225603b0c` |
| 4 | `other`, an orphan with the tree cleared first | `o.md` | `0cb1fb59e73d78ff04cf41de7f177ea0fb940002` |

The repository is left on `main` and sets `uploadpack.allowAnySHA1InWant=true`, since
retaining a pin means fetching a commit by id the way a real host serves one. So
`main` is one commit ahead of step 1, `side` diverges from it, and `other` shares no
commit with anything.

### What no fixture constructs

Two refusals are unit-level in each SDK, and deliberately not here, because
constructing them means injecting a fault rather than preparing a state:

- **`mount-declaration-changed`** — `leji.json` is edited between the comparison and
  the verified read the rewrite makes. A harness can only produce it by driving the
  library directly.
- **A target-retention failure under `--fetch`** — by the time the target is
  retained, the comparison repository is the managed store and already holds that
  commit, so only a forced `update-ref` failure reaches the branch.

Neither is compared by `scripts/parity-test.ts` either: that harness prepares states
and runs argv, and it injects no faults, so there is no scenario for either branch.
Each SDK owns its own unit test for them, against the same stable reason code
(`mount-declaration-changed`, `mount-store-fetch-failed`) and the same "nothing was
written" outcome. The TypeScript reference reaches the second through a test-only
environment variable, `LEJI_TEST_FAIL_PIN_REF=<oid>`, which fails the retention ref
for exactly that commit; a port may use whatever narrow hook its own store code
allows, because what the fixtures and this document pin is the refusal, not the hook.

## Generated CI and hooks: `fixtures/ci-goldens/`

The byte contract for everything `leji ci` writes. Each file is one cell of the
generator's manager x provider table, baked from a reviewed run and asserted by
each SDK's unit suite; nothing else in this repository holds generated CI bytes.

| Name | What it pins |
| --- | --- |
| `<provider>-<manager>-local.yml` | the job for a repository that DECLARES the Leji CLI and carries that manager's lock evidence: its own locked install, then the local runner |
| `<provider>-<node\|python\|go>-fallback.yml` | the job every other state takes, per ecosystem: `npx @leji-org/leji@1`, `pip install 'leji>=1,<2'`, or `go install .../cmd/leji@latest` |
| `hook-<manager>.sh` / `hook-fallback.sh` | the standalone managed pre-commit hook for that runner |
| `husky-<manager>.sh` / `husky-fallback.sh` | the same two gates as a marker-delimited husky block |
| `legacy-1.3-<provider>-<local\|fallback>.yml` | what the 1.3.x generator wrote, kept so the ownership rules can be tested against real bytes rather than a reconstruction |

- **Providers are `github`, `gitlab`, `circleci`, `azure`; managers are the nine the
  detection table names** (`npm`, `pnpm`, `yarn`, `bun`, `uv`, `poetry`, `pdm`,
  `pipenv`, `go`). `pip` and pre-1.24 Go never appear: they cannot be declared, so
  they take their ecosystem's fallback.
- **The marker is the ownership claim.** Every whole file opens with
  `# generated by leji ci (managed) v2`; the GitLab block keeps its own
  `# >>> leji ci (managed) >>>` delimiters and adds nothing. A re-run replaces a
  whole file only when its bytes are ones leji generated (this release, or a digest
  in the SDK's `KNOWN_GENERATED` registry of earlier ones). The `legacy-1.3-*`
  files are exactly that case, which is why they are committed here.
- **The fallback job is the pre-1.4 job.** `<provider>-node-fallback.yml` is the
  1.3.x fallback line for line, plus the marker: a repository that was getting the
  `npx` job keeps precisely that job.
- **Hook bodies are shell contracts.** Every argv element is single-quoted
  (`'pnpm' 'exec' 'leji' validate`), so a manager name is never split, expanded or
  globbed; `sh -n` parses every file here, and the stale-index message keeps its
  own literal backticks.

## Help goldens: `fixtures/help-goldens/`

The byte contract for terminal help. `usage.txt` is `leji --help`; one
`<command>.txt` holds each `leji <command> --help`, the command's spaces written
as dashes (`mounts-update-pin.txt`, `changelog-check.txt`); `wrap-non-bmp.txt`
pins the wrapper itself (below). Each file is what the CLI prints, the final
newline included, and every SDK's suite compares its own bytes against them: help
is generated from `cli.json` by three renderers, so the goldens are what keeps
them one surface.

- **The version is substituted, not baked.** `usage.txt` carries the token
  `{{version}}` where the header line names the running SDK version; a harness
  replaces that token with its own version before comparing. Nothing else in the
  goldens varies by build. (The process-parity harness needs no such rule: it
  compares the three CLIs against each other at one version.)
- **Width is 80 Unicode code points**, never terminal-derived and never UTF-16
  units. Whitespace runs collapse to one space; a token that cannot fit the
  remaining width takes a line of its own, unbroken.
- **`wrap-non-bmp.txt` is the wrapper's own vector**, the one case that separates
  code points from UTF-16 units. The input is `😀😀😀😀  alphabet six666 tail`
  (four U+1F600, then TWO spaces, then the three ASCII words), wrapped at width
  20 with the first line indented 0 and every continuation indented 3. An
  implementation measuring the emoji run as 8 units instead of 4 code points
  breaks the line one word early and fails the file.
- **`wrap-long-usage.txt` pins the `Usage:` line's own wrapping**, which no
  current command is long enough to exercise. The input is `Usage: leji mounts
  update-pin <name> [--to <oid>] [--allow-non-fast-forward] [--fetch]
  [--dry-run] [--root <dir>] [--json]` on one line, wrapped at width 80 with the
  first line indented 0 and continuations indented 7 (under the usage text, past
  `Usage: `). A renderer that emits any help field without the wrapper fails it.
- **Every dynamic label class resolves a BOUNDED column, in code points.** The
  bounds are the class's contract and are identical in all three SDKs: option
  rows (top-level globals and per-command alike) are the longest flag plus 3,
  bounded to [20, 30]; command and alias rows are the longest name plus 3,
  bounded to [12, 30]; exit-code rows are the longest code plus 2, bounded to
  [3, 8]. A label at or past its column's width takes the line alone and its
  summary starts on the next line at the column.
- **`bounds-spec.json` is a synthetic CLI spec** that pushes every one of those
  classes past its bound in one document: a 75-code-point global flag, a
  56-code-point command name, a three-digit exit code, an alias, and a
  per-command flag carrying astral characters. `bounds-usage.txt` is the
  top-level help each SDK renders from it (with the same `{{version}}` token),
  and `bounds-command.txt` is the long command's own help. Rendering them is the
  renderer-level test: the bounds are checked where they are applied, not only
  in the column helper.
- **`row-non-bmp.txt` pins padding by code points at the row level.** The label
  is `--emoji-😀😀 <value>` (two U+1F600) at column 23, with the summary `A flag
  carrying astral characters, so a column padded in UTF-16 units misaligns this
  row by two.` An implementation padding by UTF-16 units leaves the row two
  columns short. Column widths are code points throughout; no rule here claims
  terminal cell width, which no SDK can know.
- **`row-overlong-label.txt` pins the two-column row when the label outgrows its
  column**, which the option column's [20, 30] clamp makes reachable. The row is
  the label `--allow-non-fast-forward-with-a-very-long-spelling <oid>` at column
  23 with the summary `Permit a target that is not a descendant of the current
  pin, in the one spelling long enough to outgrow its column.` The label takes
  the line alone and the summary starts on the next line at the column, so it is
  never concatenated onto the label.

## Snapshot contract: `fixtures/snapshot-contract/`

The byte contract for the tree-snapshot helper each SDK's badge and canary suites
share. It is not a layer and carries no `expected.json`, so every layer harness
skips it; `leji-test.json` carries its declaration instead. One serialization,
asserted by one golden test per SDK, is what keeps the three helpers a single
contract rather than three that drift.

A snapshot is one line per entry, paths POSIX and relative to the walked directory,
the lines sorted **bytewise over UTF-8**:

| Entry | Line |
| --- | --- |
| regular file | `path<TAB>sha256:<hex>` |
| directory | `path/<TAB>dir`, so a created empty directory is visible |
| symlink or any other non-regular entry | `path<TAB>non-regular`, never followed |

Exactly one entry is excluded: `<repoRoot>/.git`, when it lies inside the walked
directory. `repoRoot` defaults to the walked directory, which is the
whole-repository call; a subtree call passes the repository root explicitly, so a
nested `.git` stays content.

- **The walked tree is `payload/`, and nothing else is inside it.** The seed
  sources and the goldens are siblings of `payload/`, never children: the payload
  is walked whole, so a golden placed inside it would have to contain its own
  digest, and a seed source inside it would be recorded as content. That is also
  why these seed sources are not dot-prefixed the way `.leji-seed/` is. A
  dot-prefix exists to hide a seed from a content walk that would otherwise export
  it; this walk records every entry it is given, dot-prefixed or not, so isolation
  is positional here rather than by name.
- **The two `.git` seeds follow the seed convention** (`from`/`to`, materialized by
  the harness into its own working copy): `_git-seed` to `payload/.git` and
  `pkg-git-seed` to `payload/pkg/.git`. Git refuses to track a directory named
  `.git`, and the two together are what the exclusion contract is about: the first
  is the repository's own and is excluded, the second is ordinary content.
- **Two entries are created by the golden test, not committed:** `payload/empty/`,
  because git tracks no empty directory, and the symlink `payload/link`, because a
  seed carries no symlink. `leji-test.json` declares both.
- **The goldens are frozen bytes.** `golden-repo.txt` is `payload` walked with
  `repoRoot` `payload`; `golden-subtree.txt` is `payload/pkg` walked with
  `repoRoot` `payload`. The third case, `payload/pkg` walked as its own repository
  root, is the subtree golden minus its `.git` lines, derived by the test.
- **`payload/ｚ.txt` and `payload/😀.txt` pin the sort.** Their UTF-8 order
  (`EF BD 9A` before `F0 9F 98 80`) is the reverse of their UTF-16 code-unit order,
  so an implementation sorting UTF-16 units, or sorting decoded paths in a runtime
  that orders them that way, fails the golden instead of passing on ASCII.

## Ecosystem detection: `fixtures/ecosystem/`

`fixtures/ecosystem/` is not a layer family (111 cases: the detection decision
table, plus the 69-case `scan-*` matrix below): each subdirectory is a miniature
repository ROOT — a manifest, its lockfiles, and nothing else — and its
`expected.json` carries one block:

```json
{ "ecosystem": { "selected": null, "all": [], "reason": "none" } }
```

`ecosystem` is the complete `detectEcosystem(root)` report: which dependency
ecosystems the root gates, which package manager owns each, the argv that
declares the Leji CLI as a dev dependency there, the argv a hook or CI job runs it
with, and whether the repository already declares it. All three SDK unit suites
consume these cases; nothing else pins the detection contract.

**Matching is exact, twice.** The report must deep-equal the block, and its
serialization must byte-equal the committed file: `JSON.stringify({ecosystem},
null, 2)` plus one trailing newline. The second comparison is what pins KEY
ORDER, which a deep-equal comparison cannot see and which the `--json` surface of
`leji detect` (and of `init`, `adopt` and `ci`) makes a public contract.

- **Lockfiles are presence-only.** Every committed lockfile is empty; no
  implementation may parse one.
- **`evidence` order is fixed and documented, never locale-dependent.** Node lists
  the lockfiles present in family order (npm, pnpm, yarn, bun, with `bun.lock`
  before `bun.lockb`); Python lists its lock families in order (uv, poetry, pdm,
  `Pipfile.lock`, `Pipfile`) and then every root file matching
  `^requirements[A-Za-z0-9._-]*\.txt$` sorted BYTEWISE; Go lists none. The
  `python-requirements-multi` case exists for the sort: its bytewise order
  (`requirements-Test.txt`, `requirements-dev.txt`, `requirements.txt`) is neither
  its creation order nor what a locale collation produces.
- **Refusal cases carry committed symlinks.** `node-refused-evidence` links
  `package.json` to `../../README.md` — outside the fixture root, inside the
  repository, so a checkout of this repository is complete and nothing escapes it
  — and `node-refused-dangling` links it to a name that does not exist. A gated
  file counts only when `lstat` says regular file and its real path stays inside
  the root, so both are `refused-evidence` and neither is ever opened.
- **One decision per case.** A case exists to pin exactly one row of the decision
  table: the manager chosen, the ambiguity refused, the field scanned, or the
  refusal. Add a case rather than widening one.

### The `scan-*` cases: the declaration scanner's field-state matrix

Whether a repository already declares the Leji CLI decides whether it is offered
at all, which runner its hook and CI job take, and whether CI installs locally.
The scan is field-specific and stateful rather than a TOML parse, so **every state
it tracks is committed here**, each field with a positive, a negative, and a
comment case. 69 cases, which the TypeScript suite asserts partition exactly: a
new case must be classified, a deleted one fails, and a scanner assertion written
inline in a test instead of as a fixture is refused outright.

| Inspected field | Declares | Does not declare |
| --- | --- | --- |
| `project.dependencies` | `scan-project-deps-{inline,multiline,specifier,spaced-header,single-quoted}` | `scan-project-deps-{absent,prefix-only,comment}` |
| `project.optional-dependencies` | `scan-optional-deps-declared` | `scan-optional-deps-{absent,comment}` |
| `dependency-groups` | `scan-dependency-groups-declared` | `scan-dependency-groups-{absent,comment,triple-quoted}` |
| `tool.uv` `dev-dependencies` | `scan-tool-uv-dev-{declared,marker}` | `scan-tool-uv-{dev-absent,dev-comment,other-field}` |
| `tool.poetry.dependencies` | `scan-poetry-deps-{key,quoted-key}` | `scan-poetry-deps-{absent,comment}` |
| `tool.poetry.dev-dependencies` | `scan-poetry-dev-deps-{key,quoted-key}` | `scan-poetry-dev-deps-{absent,comment}` |
| `tool.poetry.group.<x>.dependencies` | `scan-poetry-group-{key,inline-table}` | `scan-poetry-group-{absent,comment}` |
| `tool.pdm.dev-dependencies` | `scan-pdm-dev-{array,key}` | `scan-pdm-dev-{absent,comment}` |
| Pipfile `packages` | `scan-pipfile-packages`, `scan-pipfile-packages-quoted-key` | `scan-pipfile-packages-{absent,comment}` |
| Pipfile `dev-packages` | `scan-pipfile-dev-packages`, `scan-pipfile-dev-packages-bare-key` | `scan-pipfile-dev-packages-{absent,comment}` |
| `requirements*.txt` | `scan-requirements-{declared,bare,extras}` | `scan-requirements-{indented,comment,prefix-only,include-line}` |
| quoted vs triple-quoted elements | `scan-plain-quoted-element` | `scan-triple-quoted-element`, `scan-triple-quoted-element-literal` |
| multi-line strings (never declare) | — | `scan-multiline-{basic-string,literal-string,string-hides-table}` |
| uninspected fields and tables | — | `scan-project-{description,keywords,classifiers,nested-array}`, `scan-unrelated-table-key`, `scan-poetry-scripts-key`, `scan-pipfile-scripts` |
| `go.mod` tool directive | `scan-go-2.0` | `scan-go-{closed-block,comment,1.9,1.25}` |

Four rules these cases exist to hold, because each is easy to get subtly wrong in
a port:

- **A triple-quoted string is skipped entirely**, on one line as across several.
  `dependencies = ["""leji"""]` does NOT declare; `dependencies = ["leji"]` does.
  There is no parser to tell a multi-line requirement from prose that merely
  begins with the name, and a false positive suppresses the only offer the user
  gets, so the conservative answer is the only safe one.
- **Only the listed fields are inspected.** A `tool.poetry.scripts` entry named
  `leji`, a `project` `classifiers` or `keywords` array holding it, an array
  nested inside one, a commented line in any affected table, and a name that
  merely starts with `leji` all read as absent.
- **Both key spellings count**, bare and quoted, in every dependency map; and an
  inline-table value (`leji = { version = "^1.3" }`) is a declaration like any
  other.
- **The Go tool directive is line-exact.** A path inside a CLOSED `tool ( … )`
  block, or one behind a `//` comment, is not a declaration; the directive needs a
  `go` directive of 1.24 or newer, which `scan-go-1.9` and `scan-go-1.25` pin on
  either side.

## Start preflight: `fixtures/start-preflight/`

Seeded joiner states for `leji start`'s Setup block. Each subdirectory is a
miniature ADOPTED repository — a `leji.json`, a boot profile, one category
document, and the ecosystem files that decide the report — not a layer family, so
none carries an `expected.json`. `scripts/parity-test.ts` copies one in, commits
it, and runs a single argv over it; the three CLIs must print the same bytes.

- **A state is the tree plus its environment.** What a fixture cannot carry is
  supplied by the scenario, and every piece of it is written statically: the
  installed Node bin shim at `node_modules/.bin/leji` (`node_modules` is not
  committable), the git-side configuration (`core.hooksPath`), an installed clone
  hook, and a PATH of stubs. Each case runs with its OWN stub directory as its
  whole `PATH` (the agent host binaries, the ambient `leji`, plus a link to the
  real `git`), so detection and the version probe answer to the case, never to the
  machine running the suite. `node-declared` therefore serves the not-installed,
  unresolvable, resolvable and below-minimum cases from one tree, varying only the
  shim and the stubs.
- **The `cli` probe never runs a package manager.** For a Node repository it
  executes the installed shim directly, so a case that expects a version installs
  one and a case that expects `missing` does not; there is no `npx` or `pnpm exec`
  stub, because nothing would ever call one. Python and Go cases stub the manager
  binary itself (`uv`, `go`), which is what those probes do run.
- **The states.** `node-declared` (npm, CLI declared), `node-undeclared` (the
  shared declaration gap), `node-mcp-json` (a committed `.mcp.json`, also the
  after-the-fixes state once the hook is installed), `husky` and `githooks` (a
  hooks path inside the working tree, so a shared gap), `python-uv` and `go-tool`
  (the same rows keyed to `uv run leji` and `go tool leji`).
- **Nothing is produced by one CLI for the others.** The after-the-fixes state is
  seeded like every other one: the installed hook's bytes are a plain copy of the
  committed golden `ci-goldens/hook-npm.sh` (the same bytes `leji ci --hooks`
  writes for an npm repository, checked by its own test), never a printed fix
  replayed from a previous run and never a CLI invocation.
- **No committed golden.** As with the arg-rejection scenarios below, the
  assertion is byte equality across the three CLIs; the definitions run behind
  `START_PREFLIGHT_SCENARIOS_ENABLED`, enabled with the Go and Python ports.

## Hand-off to a repository's own CLI: `fixtures/handoff/`

Seeded repositories for the decision the INSTALLED EXECUTABLE makes before it
parses anything: inside a repository that declares the Leji CLI and has it
installed, `leji` runs that pinned copy instead of itself. Each subdirectory is a
miniature repository root: a `leji.json` (the spec line whose minimum the copy
must meet) and the ecosystem files that decide the record. No boot profile and no
category document, because no command runs far enough to read them, and no
`expected.json`: these are not layer fixtures.

- **The installed copy is written by the harness, never committed.**
  `node_modules` is not committable, so each test writes the state its case
  declares: `node_modules/@leji-org/leji/package.json` (the identity and version
  the decision reads), the package entry at `dist/cli.js`, and the manager's bin
  shim `node_modules/.bin/leji` as a symlink to that entry, which is the form npm
  and bun install. Nothing is produced by running a CLI.
- **The entry is a MARKER, so a hand-off is provable.** It prints
  `handoff:node:` followed by its own argv, JSON-encoded, and exits 3. The JSON is
  what makes argument boundaries provable (the tests pass empty, space-bearing and
  unicode tokens), and 3 is a status no leji command returns, so exit forwarding is
  observable rather than assumed. A case that expects no hand-off asserts the
  global's own output instead, typically its `--version`.
- **The cases.** `node-eligible` (hands off) and, beside it, one case per way the
  decision refuses: `node-undeclared`, `node-declared-missing`, `node-below-minimum`,
  `node-escaped` (the package directory links out of the repository), `node-refused`
  (the manifest itself resolves outside it), `node-wrong-identity`,
  `node-malformed-metadata`, `node-malformed-version`, `node-metadata-not-regular`,
  `node-entry-not-regular` (the declared entry is a directory, refused on every
  platform: the entry is what identifies the copy, whether or not it is what gets
  run), `node-unknown-spec-line`, and `node-self` (the installed copy is the
  running executable). `node-ambiguous-manager` and
  `node-unsupported-manager` DO hand off: which package manager a repository uses
  decides nothing here, because the target is the installed package and never a
  manager's runner. `polyglot` declares both Node and Python and hands off on the
  Node record alone. `go-tool` is the not-applicable branch: a Go repository builds
  `go tool leji` on demand and has no installed executable to hand off to.
- **Every shim shape a manager installs.** `node-shim-symlink` (npm, and bun),
  `node-shim-script` (pnpm) and `node-shim-yarn` (Yarn's node-modules linker) carry
  the lockfile of the manager they name, and the harness writes the shim in that
  manager's shape: a symlink to the package entry, or a small script that runs it.
  Both shapes must hand off, and both must stop after ONE hand-off, which is why the
  copy's identity is the entry the package declares and not the shim that gets
  executed: a script shim's own resolved path is itself, so a guard comparing it
  would never recognize the copy behind it and the local CLI would hand off again
  forever. The proc suite also runs the REAL built CLI behind a script shim, which
  answers once and stops.
- **What parity can assert, and what it cannot.** A successful hand-off is
  per-runtime by construction (a Node repository's copy is a Node CLI), so
  `scripts/parity-test.ts` runs only the shared NON-delegating outcomes over this
  family: `node-undeclared`, `node-below-minimum`, and `go-tool` as `--version`
  scenarios, where all three CLIs must print the same bytes. The hand-off itself is
  proved in each SDK's own suite over these same committed roots.
- **The Python half is the same family, with its own locator and reader.** A
  `python-*` root carries a `leji.json` and the manifest and lockfile that decide
  its manager; the harness writes the project environment, because a `.venv` is no
  more committable than a `node_modules`: the console script at `.venv/bin/leji`
  (mode 0755, printing `handoff:python:` and the same JSON-encoded argv, exit 3)
  and the installed distribution's
  `.venv/lib/python3.X/site-packages/leji-<v>.dist-info/METADATA`. `python-eligible`
  hands off; `python-undeclared`, `python-no-env`, `python-below-minimum`,
  `python-malformed-version`, `python-wrong-name` (a `leji-<v>.dist-info` whose
  `Name` field declares another distribution, so the field decides and not the
  directory),
  `python-two-distinfo` (the environment cannot say which copy would run),
  `python-bounds` (metadata past the read bound), `python-escaped-env`,
  `python-escaped-script`, `python-script-not-regular`, `python-refused-manifest`,
  `python-unknown-spec-line`, and `python-ambiguous-manager` do not. The last one is
  the difference from Node: this runtime's target is the environment the MANAGER
  owns, so a root whose manager the evidence could not choose names no environment.
  `python-uv-env-var`, `python-virtual-env-equal`,
  `python-virtual-env-elsewhere-inside-root` and `python-virtual-env-outside` pin the
  environment rule: uv's `UV_PROJECT_ENVIRONMENT` resolves against the root and must
  stay inside it, every other manager means `<root>/.venv`, and `VIRTUAL_ENV` never
  selects an environment (a nested or unrelated active one is not this root's).

## Arg-rejection scenarios

Command-surface rejections are exercised in `scripts/parity-test.ts`, which
compares the three CLIs' own output rather than a committed expectation, so there
is no fixture-side form for them. The scenarios `leji export` owes, recorded here
until that harness carries them:

- `leji export --endpoint x` → exit 2, usage error. No endpoint, URL, host, token
  or destination parameter exists on this command, by construction.
- `leji export --out .leji/mounts` → exit 2, refusal. `--out` never resolves
  inside `.leji/` except exactly `.leji/dist/`; the same holds for
  `.leji/viewer`, `.leji/work`, and any other role.
- `leji export --help` → exit 0, and the help bytes carry no network vocabulary.

The scenarios `leji badge` owes. These are already written in that harness, held
behind `BADGE_SCENARIOS_ENABLED` until the ports land:

- `leji badge --endpoint x` → exit 2, usage error. No endpoint, URL, host, token
  or destination parameter exists on this command, by construction.
- `leji badge --out .leji/x.svg` → exit 2, refusal. `--out` never resolves inside
  `.leji/` at any depth.
- `leji badge --out ../x.svg`, `--out /abs.svg`, `--out a\b.svg`, `--out x.png` →
  exit 2 each, quoting the `--out` acceptance rule above.
- `leji badge --help` → exit 0, and the help bytes carry no network vocabulary.

The scenarios `leji mounts update-pin` owes. These are already written in that
harness, held behind `UPDATE_PIN_SCENARIOS_ENABLED` until the ports land:

- `leji mounts update-pin --endpoint x` → exit 2, usage error. No endpoint, URL,
  host, token or destination parameter exists on this command, by construction.
- `leji mounts update-pin` with no name, and with a surplus positional → exit 2 each.
- `leji mounts update-pin <name> --allow-non-fast-forward` with no `--to` → exit 2:
  the override is meaningless without a named target.
- `--to` takes a full 40- or 64-character LOWERCASE hex commit id, in either the
  separated or the attached (`--to=<oid>`) spelling. An abbreviation, uppercase hex,
  41 or 63 characters, a missing value, and any non-hex spelling are exit 2 each.
- `--to` and `--allow-non-fast-forward` on any other `mounts` subcommand → exit 2.
- The `mounts` sub-guard: `hydrate`, `status`, `locate` and `update-pin` are the
  whole accepted set, and `updatepin`, `update-pins`, `Update-Pin`, `update` and a
  bare `mounts` are each rejected.
- `leji mounts update-pin --help` → exit 0, and the help bytes carry no network
  vocabulary beyond what `mounts hydrate` already documents.

## Adding a fixture

1. Create the smallest layer that triggers exactly the finding under test
   (start from `valid-minimal-core`).
2. Run `leji validate --root fixtures/<name>` with all three SDKs; confirm they
   agree before baking `expected.json`.
3. One failure mode per fixture. A fixture that fires three rules is three
   fixtures.
