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
});
