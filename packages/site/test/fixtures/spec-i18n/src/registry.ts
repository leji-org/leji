// This fixture's translation index, built from its own content by the same shared
// function the site's registry uses. The site's index globs the site's content, which
// is why the fixture keeps its own rather than reusing the built one.
import { specTranslationRoutes } from '@site/spec-i18n';
import { alternatesFor, englishKey, type Alternate, type Locale } from '@site/i18n';

const FILES = import.meta.glob('./content/i18n/*/spec/*.md');

const INDEX = new Map<string, Locale[]>();
for (const { locale, routeKey } of specTranslationRoutes(Object.keys(FILES))) {
   INDEX.set(routeKey, [...(INDEX.get(routeKey) ?? []), locale as Locale]);
}

export function fixtureAlternates(pathname: string): Alternate[] {
   return alternatesFor(pathname, INDEX.get(englishKey(pathname)) ?? []);
}
