# The translated-specification build fixture

A minimal Astro project that builds the site's real translated-specification
machinery over synthetic content, so the routing, the completeness rule, the banner
and the one-page composition are proven by an actual build before any locale adopts
them. It ships nothing: it is built into a temporary directory by
`test/spec-i18n-build.test.ts` and never deployed.

The route files, the layout and the components import the real `packages/site/src`
through the `@site` alias, so this is the site's code under test rather than a copy of
it. Only the content and the strings are synthetic.

Three locales, chosen to cover the three states a locale can be in:

| Locale  | Content                          | Expected routes                                  |
| ------- | -------------------------------- | ------------------------------------------------ |
| `ja`    | every specification document     | one per document, plus `/ja/spec/full/`          |
| `es`    | two documents                    | one per document, and no one-page view           |
| `pt-br` | none                             | none at all                                      |

The markdown under `src/content/i18n/` is placeholder English text with a `source` sha
of repeated digits, one digit per document in reading order, so a build can be checked
for showing a reader a revision it should not. None of it is a translation and none of
it is the specification.
