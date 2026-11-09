/**
 * Types and the loader for the conversation scenarios (`evals/datasets/e2e/scenarios/*.yaml`, M14).
 *
 * A scenario is a scripted multi-turn chat. Every step is ONE of: `send` (a message from the user or the
 * caregiver, optionally with `expect` on what came back), `advance_time` (time travel for reminders),
 * `expect` / `expect_db` on their own. Placeholders: `{last_document}` in a button id.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

export interface Reply {
  /** `to` phone of the Graph call; used to tell the user from the caregiver. */
  to: string;
  kind: 'text' | 'interactive' | 'template' | 'audio' | 'other';
  text: string;
  buttons: string[];
  template: string | null;
}

export type SendSpec =
  | { type: 'text'; text: string; from?: 'user' | 'caregiver' }
  | { type: 'button'; id: string; from?: 'user' | 'caregiver' }
  | { type: 'image'; fixture: string; from?: 'user' }
  | { type: 'audio'; says: string; confidence?: number; from?: 'user' };

export interface ReplyExpectation {
  /** Button ids that must be among the replies of this step. */
  buttons_include?: string[];
  buttons_exclude?: string[];
  /** Each substring must appear in at least one reply of this step (case-insensitive). */
  text_includes?: string[];
  text_excludes?: string[];
  /** i18n keys (en or hi): the start of the key's text must appear in a reply. */
  i18n?: string[];
  /** A WhatsApp template message of this name was sent to the recipient. */
  template?: string;
  /** Replies from the bot in this step: exactly / at least. */
  replies?: number;
  replies_min?: number;
  no_reply?: boolean;
  /** The caregiver (not the user) must get a reply with these properties. */
  to_caregiver?: { template?: string; text_includes?: string[]; text_excludes?: string[] };
}

export interface DbExpectation {
  user_exists?: boolean;
  s3_prefix_empty?: boolean;
  reminder_status?: string;
  reminder_count_min?: number;
  document_count?: number;
  document_kinds?: string[];
  medication_count_min?: number;
  warning_types?: string[];
  lab_results_min?: number;
  onboarding_step?: string;
  consent_version?: string | null;
  reminders_enabled?: boolean;
  caregiver_status?: string;
  audit_actions_include?: string[];
  audit_actions_exclude?: string[];
  rows_for_user?: number;
  consecutive_misses?: number;
}

export interface Step {
  send?: SendSpec;
  advance_time?: string;
  /** Change the user row directly (e.g. make the 24 h window closed). */
  update_user?: { last_inbound_hours_ago?: number };
  expect?: ReplyExpectation;
  expect_db?: DbExpectation;
  note?: string;
}

export interface Scenario {
  name: string;
  description?: string;
  setup?: { onboarded?: boolean; language?: 'hi' | 'en'; consent_version?: string };
  steps: Step[];
  file: string;
}

export function loadScenarios(directory: string, only?: string): Scenario[] {
  const scenarios: Scenario[] = [];
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.yaml'))
    .sort()) {
    const parsed: unknown = parse(readFileSync(join(directory, file), 'utf-8'));
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a list of scenarios`);
    for (const raw of parsed as Omit<Scenario, 'file'>[]) {
      if (!raw.name || !Array.isArray(raw.steps))
        throw new Error(`${file}: a scenario needs name + steps`);
      scenarios.push({ ...raw, file });
    }
  }
  const names = new Set<string>();
  for (const scenario of scenarios) {
    if (names.has(scenario.name)) throw new Error(`duplicate scenario name ${scenario.name}`);
    names.add(scenario.name);
  }
  return only ? scenarios.filter((scenario) => scenario.name === only) : scenarios;
}
