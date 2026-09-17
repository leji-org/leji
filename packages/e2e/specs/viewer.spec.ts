// The live viewer: `leji viewer serve` over the fixture layer, judged in a browser.

import { test } from '@playwright/test';
import {
   ACCENT_VIEWER_URL,
   CUSTOM_ACCENT,
   DARK_TONES,
   DARK_VIEWER_URL,
   DEFAULT_ACCENT,
   LIGHT_TONES,
   LIGHT_VIEWER_URL,
   VIEWER_CONSOLE_ALLOWANCES,
   VIEWER_URL,
   assertDecisionsPage,
   assertDiagramFollowsScheme,
   assertImageAtDepth,
   assertLayerHome,
   assertManifestPage,
   assertRelativeLinkInApp,
   assertSchemeSurfaces,
   assertStampedScheme,
   assertTones,
   assertUnknownRouteInApp,
   collectConsoleErrors,
   expectNoConsoleErrors,
   resourceNotFoundAllowance,
} from '../assertions.js';

test.describe('viewer (served)', () => {
   test('the home route renders the layer', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertLayerHome(page, VIEWER_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('a relative link on a nested page routes in-app', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertRelativeLinkInApp(page, VIEWER_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('an image beside a nested document renders', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertImageAtDepth(page, VIEWER_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('an unknown route renders the in-app not-found page', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertUnknownRouteInApp(page, VIEWER_URL);
      expectNoConsoleErrors(errors, [
         ...VIEWER_CONSOLE_ALLOWANCES,
         resourceNotFoundAllowance(`${VIEWER_URL}/content/does-not-exist.md`, VIEWER_URL),
      ]);
   });

   test('the manifest page renders', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertManifestPage(page, VIEWER_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('the decisions page renders and lists the layer record', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertDecisionsPage(page, VIEWER_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('the text tones are the brand set and the chrome is the default accent', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertTones(page, VIEWER_URL, { accent: DEFAULT_ACCENT });
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('a custom accent moves the chrome and leaves the text tones alone', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertTones(page, ACCENT_VIEWER_URL, { accent: CUSTOM_ACCENT });
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   // The console is not read here: the fixture carries a fence whose body is not
   // valid mermaid, deliberately, and the renderer reports that on this page. The
   // pages every other test visits are the ones that have to stay quiet.
   test('a diagram re-themes when the operating system switches scheme', async ({ page }) => {
      await assertDiagramFollowsScheme(page, VIEWER_URL);
   });
});

// The scheme is the operating system's, so each run emulates one and reads what the
// browser paints. Two runs rather than one: the dark values prove the palette
// arrives, and the light values prove the block that carries it cannot leak.

test.describe('viewer (served, dark scheme)', () => {
   test.use({ colorScheme: 'dark' });

   test('every surface takes the dark palette', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertSchemeSurfaces(page, VIEWER_URL, DARK_TONES, LIGHT_TONES);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });
});

test.describe('viewer (served, light scheme)', () => {
   test.use({ colorScheme: 'light' });

   test('every surface keeps the palette 1.5.0 shipped', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertSchemeSurfaces(page, VIEWER_URL, LIGHT_TONES, DARK_TONES);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });
});

// A layer that names its scheme through `viewer.theme.appearance` gets it on every
// system, so each of these runs under the system that says the opposite. The
// console is not read in either: both visit the diagram page, whose fixture carries
// a fence that is deliberately not valid mermaid.

test.describe('viewer (served, a layer that names light)', () => {
   test.use({ colorScheme: 'dark' });

   test('the light palette holds on a dark system, and a system switch moves nothing', async ({ page }) => {
      await assertStampedScheme(page, LIGHT_VIEWER_URL, 'light');
   });
});

test.describe('viewer (served, a layer that names dark)', () => {
   test.use({ colorScheme: 'light' });

   test('the dark palette holds on a light system, and a system switch moves nothing', async ({ page }) => {
      await assertStampedScheme(page, DARK_VIEWER_URL, 'dark');
   });
});
