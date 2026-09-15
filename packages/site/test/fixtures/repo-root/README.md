# The repository-root build fixture

A one-page Astro project that imports the site's real `repo-root` helper and its real
schema reader through the `@site` alias, so an actual build proves where the pages find
the repository. It ships nothing: `test/repo-root-build.test.ts` builds it into a
temporary directory, from the repository root as the working directory, and never
deploys it.

The working directory is the point. A page that resolved its paths from
`process.cwd()` built from `packages/site` and failed from the repository root, and a
page resolving them a fixed number of directories above its own module would fail in
the opposite direction, because a build runs the page from a chunk emitted under the
output directory. This fixture is built the way the second failure would show.
