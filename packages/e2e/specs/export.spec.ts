// The static export: the same layer, `leji export`ed and served by a plain static
// host that generates nothing. Same assertions as the served viewer, from the same
// module, so "live and static agree" is a fact about one predicate set rather than
// a claim about two files that once looked alike.

import { test } from '@playwright/test';
import {
   ACCENT_STATIC_URL,
   CUSTOM_ACCENT,
   DEFAULT_ACCENT,
   STATIC_URL,
   VIEWER_CONSOLE_ALLOWANCES,
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

test.describe('viewer (static export)', () => {
   test('the home route renders the layer', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertLayerHome(page, STATIC_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('a relative link on a nested page routes in-app', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertRelativeLinkInApp(page, STATIC_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('an image beside a nested document renders', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertImageAtDepth(page, STATIC_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('an unknown route renders the in-app not-found page', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertUnknownRouteInApp(page, STATIC_URL);
      expectNoConsoleErrors(errors, [
         ...VIEWER_CONSOLE_ALLOWANCES,
         resourceNotFoundAllowance(`${STATIC_URL}/content/does-not-exist.md`, STATIC_URL),
      ]);
   });

   test('the manifest page renders', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertManifestPage(page, STATIC_URL);
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('the text tones are the brand set and the chrome is the default accent', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertTones(page, STATIC_URL, { accent: DEFAULT_ACCENT });
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });

   test('a custom accent moves the chrome and leaves the text tones alone', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await assertTones(page, ACCENT_STATIC_URL, { accent: CUSTOM_ACCENT });
      expectNoConsoleErrors(errors, VIEWER_CONSOLE_ALLOWANCES);
   });
});
