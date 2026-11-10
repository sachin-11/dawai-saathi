import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { E2E } from '../playwright.config';

test.describe('landing page', () => {
  test('Hindi is the default at "/" and English lives at "/en"', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('प्रिस्क्रिप्शन समझो');

    await page.getByRole('link', { name: 'अंग्रेज़ी में देखें' }).first().click();
    await expect(page).toHaveURL(`${E2E.web}/en`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Understand your prescription',
    );

    await page.getByRole('link', { name: 'Switch to Hindi' }).first().click();
    await expect(page).toHaveURL(`${E2E.web}/`);
  });

  test('"/hi" redirects to "/"', async ({ page }) => {
    await page.goto('/hi/privacy');
    await expect(page).toHaveURL(`${E2E.web}/privacy`);
  });

  test('the WhatsApp button and the QR point at wa.me with the configured number', async ({
    page,
  }) => {
    await page.goto('/en');
    const cta = page.getByTestId('cta-whatsapp');
    await expect(cta).toHaveAttribute('href', `https://wa.me/${E2E.waNumber}?text=Hi`);
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    await expect(page.getByTestId('cta-demo')).toHaveAttribute('href', '/en/demo');
  });

  test('shows real eval numbers and the safety block', async ({ page }) => {
    await page.goto('/en');
    await expect(page.getByText('hard safety gates passed')).toBeVisible();
    await expect(page.getByText('Not a doctor').first()).toBeVisible();
    await expect(page.getByText('112').first()).toBeVisible();
  });

  test('privacy and terms are in both languages and marked as drafts', async ({ page }) => {
    for (const [path, heading] of [
      ['/privacy', 'प्राइवेसी पॉलिसी'],
      ['/en/privacy', 'Privacy Policy'],
      ['/terms', 'उपयोग की शर्तें'],
      ['/en/terms', 'Terms of Use'],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.getByTestId('draft-banner')).toBeVisible();
      await expect(page.locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('sends a strict CSP with a nonce and the security headers', async ({ request }) => {
    const response = await request.get('/en');
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp.split('; ').find((d) => d.startsWith('script-src'))).not.toContain(
      "'unsafe-inline'",
    );
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
    expect(response.headers()['x-powered-by']).toBeUndefined();
  });

  test('robots.txt, sitemap.xml and the Open Graph image exist', async ({ request }) => {
    expect((await request.get('/robots.txt')).status()).toBe(200);
    const sitemap = await (await request.get('/sitemap.xml')).text();
    expect(sitemap).toContain('/en/demo');
    expect((await request.get('/opengraph-image')).headers()['content-type']).toContain(
      'image/png',
    );
  });

  for (const path of ['/', '/en', '/privacy', '/en/demo']) {
    test(`has no serious accessibility violations: ${path}`, async ({ page }) => {
      await page.goto(path);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);
    });
  }

  test('@mobile has no horizontal scroll at phone width', async ({ page }) => {
    for (const path of ['/', '/en/demo']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
});
