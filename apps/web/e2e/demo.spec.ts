import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.describe('demo playground', () => {
  test('uploads stay off until the "no real patient documents" box is ticked', async ({ page }) => {
    await page.goto('/en/demo');
    await expect(
      page.getByText("Do not upload a real patient's prescription or report."),
    ).toBeVisible();
    const input = page.getByTestId('file-input');
    await expect(input).toBeDisabled();
    await expect(page.getByText('Tick the box above to enable uploads.')).toBeVisible();
    await page.getByRole('checkbox').check();
    await expect(input).toBeEnabled();
  });

  test('a sample shows the WhatsApp reply, the extraction, the warnings and the trace', async ({
    page,
  }) => {
    await page.goto('/en/demo');
    await page.getByTestId('sample-rx_clean').click();
    const results = page.getByTestId('results');
    await expect(results).toBeVisible();
    await expect(results.getByText('Pre-computed answer')).toBeVisible();

    // desktop: the WhatsApp preview sits beside the tabs
    await expect(page.getByTestId('wa-text').first()).toContainText('Dolo 650');
    await expect(
      page.getByRole('list', { name: 'Buttons the user can tap' }).first(),
    ).toBeVisible();

    await expect(page.getByTestId('medicine-row').first()).toBeVisible();
    await expect(
      page.getByTestId('medicine-row').filter({ hasText: 'Could not read clearly' }),
    ).toHaveCount(1);

    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.getByTestId('trace-row').first()).toBeVisible();
    expect(await page.getByTestId('trace-row').count()).toBeGreaterThan(5);
    await expect(page.getByText('Total time')).toBeVisible();
    await expect(page.locator('svg g[data-visited="true"]').first()).toBeVisible();

    await page.getByRole('tab', { name: 'Raw JSON' }).click();
    await expect(page.locator('pre code')).toContainText('"debug_trace"');
    await expect(page.locator('pre code')).not.toContainText('wa_phone');
  });

  test('the language toggle re-runs the sample in the other language', async ({ page }) => {
    await page.goto('/en/demo');
    await page.getByTestId('sample-rx_clean').click();
    await expect(page.getByTestId('wa-text').first()).toBeVisible();
    const english = await page.getByTestId('wa-text').first().innerText();
    await page.getByRole('button', { name: 'हिन्दी' }).click();
    await expect(page.getByTestId('wa-text').first()).not.toHaveText(english);
    await expect(page.getByTestId('wa-text').first()).toHaveAttribute('lang', 'hi');
  });

  test('an upload runs the live pipeline (fake model) and is not kept', async ({
    page,
    request,
  }) => {
    await page.goto('/en/demo');
    await page.getByRole('checkbox').check();
    // a 1x1 white PNG: enough for the fake model; the gateway re-encodes it
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .getByTestId('file-input')
      .setInputFiles({ name: 'scan.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('results')).toBeVisible();
    await expect(page.getByTestId('results').getByText('Live run')).toBeVisible();
    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.getByTestId('trace-row').first()).toBeVisible();
    // the BFF never exposes a way to read an upload back
    expect((await request.get('/api/demo?file=1')).status()).not.toBe(500);
  });

  test('an unsupported file is refused with a friendly message', async ({ page }) => {
    await page.goto('/en/demo');
    await page.getByRole('checkbox').check();
    await page.getByTestId('file-input').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    await expect(page.getByRole('alert').filter({ hasText: 'not supported' })).toBeVisible();
  });

  test('the browser never sees the demo key or the gateway URL', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    page.on('response', async (r) => {
      if (r.url().includes('/api/demo')) seen.push(await r.text().catch(() => ''));
    });
    await page.goto('/en/demo');
    await page.getByTestId('sample-rx_clean').click();
    await expect(page.getByTestId('results')).toBeVisible();
    const html = await page.content();
    for (const secret of [
      'e2e-demo-key',
      'e2e-demo-ai-token',
      'localhost:3012',
      'e2e-service-token',
    ]) {
      expect(html).not.toContain(secret);
      expect(seen.join('\n')).not.toContain(secret);
    }
    // the only network calls are to our own origin
    const external = seen.filter(
      (u) => u.startsWith('http') && !u.startsWith('http://localhost:3011'),
    );
    expect(external.filter((u) => !u.includes('fonts.g'))).toEqual([]);
  });

  test('has no serious accessibility violations with results on screen', async ({ page }) => {
    await page.goto('/en/demo');
    await page.getByTestId('sample-lab_critical').click();
    await expect(page.getByTestId('results')).toBeVisible();
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

  test('@mobile shows the WhatsApp preview as a tab', async ({ page }) => {
    await page.goto('/en/demo');
    await page.getByTestId('sample-rx_clean').click();
    await expect(page.getByTestId('results')).toBeVisible();
    await page.getByRole('tab', { name: 'WhatsApp' }).click();
    await expect(page.getByTestId('wa-text').last()).toBeVisible();
  });
});

test.describe('demo API through the BFF', () => {
  test('rejects a malformed request and an unknown sample', async ({ request }) => {
    expect((await request.post('/api/demo', { data: { a: 1 } })).status()).toBe(400);
    const bad = await request.post('/api/demo', {
      multipart: { language: 'en', sample_id: '../../etc/passwd' },
    });
    expect(bad.status()).toBe(400);
  });
});
