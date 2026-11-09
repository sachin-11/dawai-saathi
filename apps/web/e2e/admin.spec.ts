import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { E2E } from '../playwright.config';

const container = process.env.E2E_PG_CONTAINER ?? 'dawai-test-postgres';
const dbUrl = process.env.INTEGRATION_DATABASE_URL;

/**
 * One SQL statement against the e2e database. In CI (INTEGRATION_DATABASE_URL set, a service container)
 * it goes through psql; locally through the docker test stack's container.
 */
function sql(statement: string): string {
  if (dbUrl) {
    const url = new URL(dbUrl);
    url.pathname = '/dawai_e2e_test';
    return execFileSync('psql', [url.toString(), '-At', '-c', statement], {
      encoding: 'utf-8',
    }).trim();
  }
  return execFileSync(
    'docker',
    ['exec', container, 'psql', '-U', 'dawai', '-d', 'dawai_e2e_test', '-At', '-c', statement],
    { encoding: 'utf-8' },
  ).trim();
}

async function signIn(page: Page, email = E2E.adminEmail, expectSuccess = true): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Test login (non-production only)').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (expectSuccess) await page.waitForURL(`${E2E.web}/admin`);
}

test.describe('admin', () => {
  test('is closed without a session and refuses an operator who is not on the allowlist', async ({
    page,
    request,
  }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(`${E2E.web}/admin/login`);
    expect((await request.post('/api/admin/reveal', { data: {} })).status()).toBe(403);

    await signIn(page, 'intruder@example.com', false);
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole('alert')).toContainText('Sign-in was refused');
  });

  test('overview shows the numbers and has no serious accessibility violations', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page).toHaveURL(`${E2E.web}/admin`);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('Needs review')).toBeVisible();
    await expect(page.getByText('Budget state')).toBeVisible();
    await expect(
      page.getByRole('img', { name: /Documents per day|LLM cost per day/ }).first(),
    ).toBeVisible();
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

  test('review queue hides patient data; revealing needs a reason and writes the audit log', async ({
    page,
  }) => {
    const userId = randomUUID();
    const messageId = randomUUID();
    const documentId = randomUUID();
    const wamid = `wamid.${randomUUID()}`;
    sql(
      `INSERT INTO users (id, wa_phone_hash, wa_phone_enc) VALUES ('${userId}', 'hash-${userId}', 'enc:PHONE-9876543210')`,
    );
    sql(
      `INSERT INTO messages (id, user_id, direction, wa_message_id, type) VALUES ('${messageId}', '${userId}', 'in', '${wamid}', 'image')`,
    );
    sql(
      `INSERT INTO documents (id, user_id, message_id, kind, s3_key, status, overall_confidence, prompt_version, extraction) VALUES ('${documentId}', '${userId}', '${messageId}', 'prescription', 'media/${userId}/none.jpg', 'needs_review', 0.41, 'rx_extract_v1', '{"kind":"prescription","medicines":[{"low_confidence":true,"name":{"value":"Zorbex Test","confidence":0.2}}]}')`,
    );
    try {
      await signIn(page);
      await page.goto('/admin/review');
      const row = page.getByTestId('review-row').filter({ hasText: documentId.slice(0, 8) });
      await expect(row).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Zorbex Test');
      await expect(page.locator('body')).not.toContainText('9876543210');

      await row.getByRole('button', { name: 'Open' }).click();
      const reveal = page.getByRole('button', { name: 'Reveal with reason' });
      await expect(reveal).toBeDisabled();
      await page.getByLabel('Why do you need to see this document?').fill('too short');
      await expect(reveal).toBeDisabled();
      await page
        .getByLabel('Why do you need to see this document?')
        .fill('User reported a wrong dose reading');
      await reveal.click();

      await expect(page.getByTestId('revealed')).toContainText('Zorbex Test');
      await expect(page.locator('body')).not.toContainText('9876543210');

      const audit = sql(
        `SELECT actor || '|' || (metadata->>'admin_email') || '|' || (metadata->>'reason') FROM audit_logs WHERE action = 'admin_reveal' AND metadata->>'document_id' = '${documentId}'`,
      );
      expect(audit).toBe(`admin|${E2E.adminEmail}|User reported a wrong dose reading`);

      await page.getByRole('button', { name: 'Extraction is wrong' }).click();
      await expect(
        page.getByTestId('review-row').filter({ hasText: documentId.slice(0, 8) }),
      ).toHaveCount(0);
      expect(sql(`SELECT review_label FROM documents WHERE id = '${documentId}'`)).toBe(
        'extraction_wrong',
      );
      expect(
        sql(
          `SELECT count(*) FROM audit_logs WHERE action = 'admin_review_resolved' AND metadata->>'document_id' = '${documentId}'`,
        ),
      ).toBe('1');
    } finally {
      sql(`DELETE FROM audit_logs WHERE metadata->>'document_id' = '${documentId}'`);
      sql(`DELETE FROM users WHERE id = '${userId}'`);
    }
  });

  test('evals, prompts and operations pages load', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/evals');
    await expect(page.getByRole('heading', { name: 'Evals' })).toBeVisible();
    await page.goto('/admin/prompts');
    await expect(page.getByRole('heading', { name: 'Prompts' })).toBeVisible();
    await page.goto('/admin/operations');
    await expect(page.getByRole('heading', { name: 'Dead-letter queues' })).toBeVisible();
    await expect(page.getByText('inbound').first()).toBeVisible();
  });

  test('sign out ends the session', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});
