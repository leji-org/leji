// The live viewer: `leji viewer serve` over the fixture layer, judged in a browser.

import { test } from '@playwright/test';
import {
   ACCENT_VIEWER_URL,
   CUSTOM_ACCENT,
   DEFAULT_ACCENT,
   VIEWER_CONSOLE_ALLOWANCES,
   VIEWER_URL,
   assertImageAtDepth,
   assertLayerHome,
   assertManifestPage,
   assertRelativeLinkInApp,
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
});
