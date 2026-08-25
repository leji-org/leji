// leji.org, as `astro preview` serves the built site. Every selector here is an
// existing role, accessible label, heading, or URL: the suite reads the site as a
// reader does and never asks it to grow a hook for the sake of a test.

import { expect, test } from '@playwright/test';
import {
   SITE_CONSOLE_ALLOWANCES,
   SITE_URL,
   collectConsoleErrors,
   expectNoConsoleErrors,
   resourceNotFoundAllowance,
} from '../assertions.js';

test.describe('site', () => {
   test('the index page renders the hero session and the install tabs', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Make your');
      await expect(
         page.getByRole('group', { name: 'A real Leji session: adopt an existing repo, validate it, score it' }),
      ).toBeVisible();
      const tabs = page.getByRole('tablist', { name: 'Install Leji' });
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole('tab')).not.toHaveCount(0);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the quickstart page renders its steps', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/quickstart/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build a context layer, check it conforms.');
      await expect(page.getByRole('region', { name: 'Quickstart steps' })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the agent-ready page renders the two commands and their copy buttons', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/agent-ready/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your repo, agent-ready in two commands.');
      const commands = page.getByRole('region', { name: 'The two commands' });
      await expect(commands).toBeVisible();
      await expect(commands.getByRole('button', { name: 'Copy install command' })).toBeVisible();
      await expect(commands.getByRole('button', { name: 'Copy the start command' })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the spec index renders', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/spec/`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('the manifest schema page states what the viewer accent drives', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      const response = await page.goto(`${SITE_URL}/schemas/context-manifest/`);
      expect(response?.status()).toBe(200);
      // The field reference is generated from `schemas/context-manifest.schema.json`
      // at build, so this reads the published contract rather than a copy of it: the
      // sentence is the one adopters are given about `viewer.theme.primary`, and it
      // has to keep agreeing with what the viewer actually does with the accent.
      const viewerField = page.locator('dt#viewer + dd');
      await expect(viewerField).toBeVisible();
      await expect(viewerField).toContainText('body links and inline code use the fixed accessible tone');
      expectNoConsoleErrors(errors, SITE_CONSOLE_ALLOWANCES);
   });

   test('an unknown URL answers 404 with the branded page', async ({ page }) => {
      const errors = collectConsoleErrors(page);
      // The status matters as much as the rendering: a 404 page served with a 200
      // is a soft 404, which is what search engines index and what a link checker
      // reports as healthy.
      const response = await page.goto(`${SITE_URL}/no-such-page/`);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found.');
      await expect(page.getByRole('link', { name: 'the specification' })).toBeVisible();
      // The 404 document load is itself a failed resource load, so the browser
      // reports it: the one error this test asserts, named by the exact URL it
      // came from and the origin that served it.
      expectNoConsoleErrors(errors, [
         ...SITE_CONSOLE_ALLOWANCES,
         resourceNotFoundAllowance(`${SITE_URL}/no-such-page/`, SITE_URL),
      ]);
   });
});
