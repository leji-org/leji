import { defineConfig } from '@playwright/test';

// No `webServer` here. The three servers the specs address are started by
// `run.mjs` before Playwright is spawned, and taken down by it afterwards: they
// have to exist after the fixture is built (which Playwright starts its servers
// too early to allow) and they have to be reachable for cleanup afterwards
// (which a `webServer`, detached into a session of its own, is not). Each spec
// addresses its server by the fixed base URL exported from `assertions.ts`.

export default defineConfig({
   testDir: './specs',
   outputDir: 'test-results',
   fullyParallel: false,
   workers: 1,
   // One retry in CI absorbs a genuinely flaky animation frame; locally a flake
   // stays visible, because that is where it gets fixed.
   retries: process.env.CI ? 1 : 0,
   timeout: 30_000,
   expect: { timeout: 5_000 },
   reporter: [['list'], ['html', { outputFolder: 'report', open: 'never' }]],
   use: {
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
   },
   projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
