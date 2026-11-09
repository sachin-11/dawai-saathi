/**
 * End-to-end conversation scenarios (M14): `evals/datasets/e2e/scenarios/*.yaml` against the real gateway
 * and the real AI service (fake models) on the docker test stack. Needs `make test-infra-up`.
 *
 *   pnpm --filter @dawai/gateway run test:e2e-conversations
 *   E2E_SCENARIO=consent_decline ...      one scenario
 *   E2E_RESULTS_FILE=out.json ...          also write a machine-readable result (used by the eval harness)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ConversationHarness, REPO_ROOT, type ScenarioOutcome } from './harness';
import { loadScenarios } from './scenario';

const SCENARIOS_DIR =
  process.env['E2E_SCENARIOS_DIR'] ?? join(REPO_ROOT, 'evals', 'datasets', 'e2e', 'scenarios');
const scenarios = loadScenarios(SCENARIOS_DIR, process.env['E2E_SCENARIO']);
const outcomes: ScenarioOutcome[] = [];
const harness = new ConversationHarness();

describe('conversation scenarios (gateway + AI service, fake models)', () => {
  beforeAll(async () => {
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    const file = process.env['E2E_RESULTS_FILE'];
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ scenarios: outcomes }, null, 2), 'utf-8');
    }
    await harness.stop();
  }, 60_000);

  it('has scenarios', () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    async (_name, scenario) => {
      const outcome = await harness.run(scenario);
      outcomes.push(outcome);
      const failed = outcome.steps.filter((step) => !step.ok);
      expect(
        failed.map((step) => `step ${step.index} (${step.label}): ${step.problems.join('; ')}`),
      ).toEqual([]);
    },
    240_000,
  );

  // M15: the structured logs of BOTH services, over every scenario that just ran, hold no phone number,
  // Aadhaar-like number, e-mail or the words a user typed or said (CLAUDE.md §2.6, §10).
  it('logs contain no phone numbers, Aadhaar-like numbers, e-mails or raw message text', () => {
    const all = [...harness.logLines, ...harness.ai.logLines];
    expect(all.length).toBeGreaterThan(50); // the logs really were captured
    const problems: string[] = [];
    for (const line of all) {
      for (const phone of harness.phones) {
        if (line.includes(phone) || line.includes(phone.slice(-10))) {
          problems.push('a scenario phone number');
        }
      }
      // not inside an identifier: the last group of a UUID can be 12 digits by chance
      if (/(?<![\w-])[2-9]\d{3}\s?\d{4}\s?\d{4}(?![\w-])/.test(line)) {
        problems.push('an Aadhaar-like number');
      }
      if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(line)) problems.push('an e-mail address');
    }
    const typed = scenarios
      .flatMap((scenario) => scenario.steps)
      .map((step) =>
        step.send?.type === 'text'
          ? step.send.text
          : step.send?.type === 'audio'
            ? step.send.says
            : '',
      )
      .map((text) => text.trim().toLowerCase())
      .filter((text) => text.length >= 12);
    const haystack = all.join(String.fromCharCode(10)).toLowerCase();
    for (const text of typed) {
      if (haystack.includes(text)) problems.push(`the user's words "${text.slice(0, 20)}..."`);
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});
