import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SPEC_DOCS } from '../src/data/spec-docs.ts';
import { parseSpecI18nId, specI18nId, specI18nPath, specI18nSlugs, specTranslationRoutes } from '../src/spec-i18n.ts';

// The rules a translated specification route is built on, checked against data
// handed straight to them. What the rules produce once Astro runs them over real
// content is the build fixture's job (spec-i18n-build.test.ts); what they do with
// input nobody should ever write is this one's, because a build cannot be asked to
// produce a malformed content path.
//
// The property under all of it: a locale advertises exactly the routes it can serve.
// Anything else either fails the build or is not emitted at all, because the
// alternates, the locale switch and the sitemap all read the same answer, and a route
// that is advertised but missing is a 404 with a link to it from every language.

const ALL_DOCS = SPEC_DOCS.map((doc) => doc.id);
const path = (locale: string, doc: string) => `./content/i18n/${locale}/spec/${doc}.md`;

test('an id names one locale and one specification document', () => {
   assert.deepEqual(parseSpecI18nId('vi/readme'), { locale: 'vi', doc: 'readme' });
   assert.deepEqual(parseSpecI18nId('pt-br/context-layer'), { locale: 'pt-br', doc: 'context-layer' });
});

test('an id that is not <locale>/<doc> fails rather than routing somewhere', () => {
   for (const id of ['readme', 'vi/spec/readme', 'vi/', '/readme', 'VI/readme', 'vi/../readme']) {
      assert.throws(() => parseSpecI18nId(id), /translated specification id/, id);
   }
});

test('an id for a document the specification does not have fails', () => {
   assert.throws(() => parseSpecI18nId('vi/quickstart'), /names no specification document/);
});

test('a content path yields the id of the entry it holds', () => {
   assert.equal(specI18nId('vi/spec/readme.md'), 'vi/readme');
   assert.equal(specI18nId('./content/i18n/zh-hans/spec/versioning.md'), 'zh-hans/versioning');
});

test('a content path in the wrong shape fails rather than being guessed at', () => {
   for (const file of ['vi/readme.md', 'vi/spec/readme.mdx', 'spec/readme.md', 'vi/spec/nested/readme.md']) {
      assert.throws(() => specI18nId(file), /translated specification content/, file);
   }
});

test('a locale emits a route for each document it has, in reading order', () => {
   assert.deepEqual(specI18nSlugs(['conformance', 'readme', 'governance']), ['readme', 'governance', 'conformance']);
});

test('a locale with no documents emits nothing at all', () => {
   assert.deepEqual(specI18nSlugs([]), []);
});

test('the one-page view is emitted only for a locale that has every document', () => {
   assert.deepEqual(specI18nSlugs(ALL_DOCS), [...ALL_DOCS, 'full']);
   assert.deepEqual(specI18nSlugs([...ALL_DOCS].reverse()), [...ALL_DOCS, 'full']);
   assert.ok(!specI18nSlugs(ALL_DOCS.slice(1)).includes('full'));
   assert.ok(!specI18nSlugs(ALL_DOCS.slice(0, -1)).includes('full'));
});

test('a document outside the specification, or translated twice, fails the build', () => {
   assert.throws(() => specI18nSlugs(['readme', 'quickstart']), /not in the specification/);
   assert.throws(() => specI18nSlugs(['readme', 'readme']), /appears twice/);
});

test('a route mirrors the English route beneath the locale prefix', () => {
   assert.equal(specI18nPath('vi', 'readme'), '/vi/spec/');
   assert.equal(specI18nPath('vi', 'versioning'), '/vi/spec/versioning/');
   assert.equal(specI18nPath('pt-br', 'full'), '/pt-br/spec/full/');
});

test('the registry learns one English route per translated document', () => {
   assert.deepEqual(specTranslationRoutes([path('vi', 'readme'), path('vi', 'decisions')]), [
      { locale: 'vi', routeKey: '/spec' },
      { locale: 'vi', routeKey: '/spec/decisions' },
   ]);
});

test('the registry counts /spec/full as translated only where the locale is complete', () => {
   const complete = specTranslationRoutes(ALL_DOCS.map((doc) => path('ja', doc)));
   assert.ok(complete.some((route) => route.routeKey === '/spec/full'));
   const partial = specTranslationRoutes(ALL_DOCS.slice(0, 3).map((doc) => path('ja', doc)));
   assert.ok(!partial.some((route) => route.routeKey === '/spec/full'));
   assert.equal(partial.length, 3);
});

test('the registry keeps each locale on its own count', () => {
   const routes = specTranslationRoutes([...ALL_DOCS.map((doc) => path('ja', doc)), path('es', 'readme')]);
   assert.ok(routes.some((route) => route.locale === 'ja' && route.routeKey === '/spec/full'));
   assert.deepEqual(
      routes.filter((route) => route.locale === 'es'),
      [{ locale: 'es', routeKey: '/spec' }],
   );
});

test('one malformed content path fails the build rather than the rest routing without it', () => {
   assert.throws(() => specTranslationRoutes([path('vi', 'readme'), './content/i18n/vi/readme.md']), /translated/);
});
