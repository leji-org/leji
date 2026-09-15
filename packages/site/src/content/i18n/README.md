# Translated specification documents

One file per document per locale, at `<locale>/spec/<doc>.md`, where `<doc>` is the
name of the English document under `spec/` at the repository root. These are
informative translations owned by the site: the English `spec/*.md` stays the single
normative source, and nothing here is copied into it.

Each file's frontmatter carries the revision it follows:

```md
---
source: <the 40-character git blob sha of the English document>
---
```

The sha is required and checked at build time. It is what the drift check compares
against the current blob, so a translation that falls behind its English document is
caught before the site is deployed. Quote the value (`source: "«sha»"`): a sha that
happens to be all digits would otherwise parse as a YAML number and fail the check
with a confusing type error.

A locale gets a route for every document it has translated. The one-page view at
`/<locale>/spec/full/` appears only once the locale has all of them, so a partial
translation never advertises a one-page view with documents missing from it.
