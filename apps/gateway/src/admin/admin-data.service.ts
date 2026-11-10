import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG } from '../config/config.constants';
import type { Env } from '../config/env.schema';

export const DEFAULT_ADMIN_DATA_DIR = join(__dirname, '..', '..', 'admin-data');

export interface EvalRunSummary {
  suite: string;
  mode: string;
  cases: number;
  passed: boolean;
  hardGates: { metric: string; rule: string; value: number; passed: boolean }[];
  softRegressions: number;
  costUsd: number;
  latencyP95Ms: number;
  /** Model ids per role (vision/cheap/text) of a real run; empty for offline runs. */
  models: Record<string, string>;
  /** Soft quality metrics (F1, accuracy, cost per document ...) as reported by the harness. */
  softMetrics: { metric: string; value: number; status: string }[];
}
export interface EvalReportSummary {
  file: string;
  date: string;
  sha: string;
  scope: string;
  passed: boolean;
  runs: EvalRunSummary[];
}
export interface PromptInfo {
  id: string;
  family: string;
  version: number;
  file: string;
  current: boolean;
}

interface RawRun {
  suite?: string;
  mode?: string;
  cases?: number;
  passed?: boolean;
  hard_gates?: { metric: string; rule: string; value: number; passed: boolean }[];
  soft?: { metric?: string; value?: number; status?: string }[];
  models?: Record<string, unknown>;
  cost_usd?: number;
  latency_p95_ms?: number;
}

/**
 * Eval reports and the prompt list for the admin pages. Both are produced at build/deploy time by
 * `sync:admin-data` (the gateway image cannot see `evals/` or the AI service's prompt files), so this
 * only reads a folder. Missing folder = empty lists, never an error.
 */
@Injectable()
export class AdminDataService {
  private readonly dir: string;

  constructor(@Inject(APP_CONFIG) env: Pick<Env, 'ADMIN_DATA_DIR'>) {
    this.dir = env.ADMIN_DATA_DIR ?? DEFAULT_ADMIN_DATA_DIR;
  }

  async evals(): Promise<EvalReportSummary[]> {
    const dir = join(this.dir, 'eval-reports');
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const reports: EvalReportSummary[] = [];
    for (const file of names) {
      try {
        const data = JSON.parse(await readFile(join(dir, file), 'utf-8')) as {
          date?: string;
          git_sha?: string;
          scope?: string;
          passed?: boolean;
          runs?: RawRun[];
        };
        if (!Array.isArray(data.runs)) continue;
        reports.push({
          file,
          date: data.date ?? '',
          sha: data.git_sha ?? '',
          scope: data.scope ?? '',
          passed: data.passed === true,
          runs: data.runs.map((run) => ({
            suite: run.suite ?? '',
            mode: run.mode ?? '',
            cases: run.cases ?? 0,
            passed: run.passed === true,
            hardGates: (run.hard_gates ?? []).map((g) => ({
              metric: g.metric,
              rule: g.rule,
              value: g.value,
              passed: g.passed,
            })),
            softRegressions: (run.soft ?? []).filter((s) => s.status && s.status !== 'ok').length,
            costUsd: run.cost_usd ?? 0,
            latencyP95Ms: run.latency_p95_ms ?? 0,
            models: Object.fromEntries(
              Object.entries(run.models ?? {}).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
            softMetrics: (run.soft ?? []).flatMap((s) =>
              typeof s.metric === 'string' && typeof s.value === 'number'
                ? [{ metric: s.metric, value: s.value, status: s.status ?? '' }]
                : [],
            ),
          })),
        });
      } catch {
        // a broken report file must not take the page down
      }
    }
    // Newest first: by date, then by the name written by the harness.
    return reports.sort((a, b) => b.date.localeCompare(a.date) || b.file.localeCompare(a.file));
  }

  async prompts(): Promise<PromptInfo[]> {
    try {
      const list = JSON.parse(
        await readFile(join(this.dir, 'prompts.json'), 'utf-8'),
      ) as PromptInfo[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
}
