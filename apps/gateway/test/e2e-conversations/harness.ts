/* eslint-disable @typescript-eslint/no-non-null-assertion -- test code: a missing value fails the scenario anyway */
/**
 * Conversation harness (M14): the REAL gateway app (webhook, router, flows, BullMQ workers) on the
 * docker test stack (Postgres, Redis, MinIO), talking to the REAL AI service (uvicorn, `LLM_MODE=fake`)
 * over HTTP. Only the outside world is faked: the WhatsApp Graph API (nock) and the models (the AI
 * service's own fake provider). Time travel: reminder slots are fired by calling the dispatch service
 * with explicit times, exactly like the delayed jobs of real life (see reminders-flow.int-spec.ts).
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import nock from 'nock';
import request from 'supertest';
import type { App } from 'supertest/types';

import { CryptoService } from '../../src/common/crypto/crypto.service';
import { hashPhone } from '../../src/common/crypto/crypto.util';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { StorageService } from '../../src/common/storage/storage.service';
import { ReminderDispatchService } from '../../src/reminders/reminder-dispatch.service';
import { INTEGRATION_ENV, prepareTestDatabase } from '../support/integration-env';
import { createApp, signedHeaders } from '../support/webhook-test-utils';
import type { DbExpectation, Reply, ReplyExpectation, Scenario, SendSpec, Step } from './scenario';

export const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const GRAPH = 'https://graph.facebook.com';
const SEND_PATH = '/v21.0/100000000000001/messages';
const WEBHOOK = '/webhook/whatsapp';
const PEPPER = INTEGRATION_ENV['PHONE_HASH_PEPPER'] ?? '';
const IST_OFFSET_MIN = 330;

interface GraphBody {
  to?: string;
  status?: string;
  type?: string;
  text?: { body: string };
  interactive?: {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
  template?: {
    name: string;
    components?: { parameters?: { text?: string; payload?: string }[] }[];
  };
}

export interface StepOutcome {
  index: number;
  label: string;
  ok: boolean;
  problems: string[];
}

export interface ScenarioOutcome {
  name: string;
  file: string;
  ok: boolean;
  steps: StepOutcome[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const randomPhone = (): string => `919${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

function aiPython(): string {
  const configured = process.env['E2E_AI_PYTHON'];
  if (configured) return configured;
  const venv = join(REPO_ROOT, 'apps', 'ai-service', '.venv');
  for (const candidate of [join(venv, 'Scripts', 'python.exe'), join(venv, 'bin', 'python')]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'python';
}

function readTexts(language: 'en' | 'hi'): Record<string, string> {
  const file = join(__dirname, '..', '..', 'src', 'messaging', 'i18n', `${language}.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>;
}

/** The start of an i18n text (up to the first `{{placeholder}}`), enough to recognise it in a reply. */
function i18nStart(language: 'en' | 'hi', key: string): string {
  const text = readTexts(language)[key];
  if (!text) throw new Error(`unknown i18n key ${key}`);
  return text.split('{{')[0]!.trim().slice(0, 60);
}

/**
 * The conversations run in their OWN database (`dawai_e2e_test`): the reference data they need (catalog,
 * interactions, lab ranges) must not leak into the integration tests, which insert their own rows.
 */
export function e2eDatabaseUrl(): string {
  const base = new URL(INTEGRATION_ENV['DATABASE_URL'] ?? '');
  base.pathname = `/${base.pathname.slice(1).replace(/_test$/, '')}_e2e_test`;
  return base.toString();
}

async function ensureE2eDatabase(): Promise<void> {
  const target = new URL(e2eDatabaseUrl());
  const name = target.pathname.slice(1);
  const admin = new PrismaClient({
    datasources: { db: { url: INTEGRATION_ENV['DATABASE_URL'] ?? '' } },
  });
  try {
    const found = await admin.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM pg_database WHERE datname = ${name}`;
    if ((found[0]?.n ?? 0n) === 0n) await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    // the read-only role of the AI service may connect to it (the migrations grant it SELECT on the catalog tables)
    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${name}" TO dawai_ai_ro`);
  } finally {
    await admin.$disconnect();
  }
}

export class AiServiceProcess {
  private child: ChildProcess | null = null;
  readonly port = Number(process.env['E2E_AI_PORT'] ?? 8765);

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  async start(): Promise<void> {
    const databaseUrl =
      process.env['E2E_AI_DATABASE_URL'] ??
      e2eDatabaseUrl().replace('dawai:dawai@', 'dawai_ai_ro:dawai_ai_ro@');
    const s3 = new URL(INTEGRATION_ENV['S3_ENDPOINT'] ?? 'http://localhost:9100');
    this.child = spawn(
      aiPython(),
      ['-m', 'uvicorn', 'app.main:create_app', '--factory', '--port', String(this.port)],
      {
        cwd: join(REPO_ROOT, 'apps', 'ai-service'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          LOG_LEVEL: 'warn',
          SERVICE_TOKEN: INTEGRATION_ENV['SERVICE_TOKEN'] ?? '',
          LLM_MODE: 'fake',
          DATABASE_URL: databaseUrl,
          ALLOWED_MEDIA_HOSTS: s3.host,
        },
        stdio: 'ignore',
      },
    );
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const response = await fetch(`${this.url}/health/ready`);
        if (response.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error('the AI service did not become ready in 120 s');
      await sleep(500);
    }
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}

/** Load the catalog, interaction and lab reference data once (the AI service reads it from Postgres). */
async function seedReferenceData(): Promise<void> {
  const db = new PrismaClient({ datasources: { db: { url: e2eDatabaseUrl() } } });
  try {
    const [row] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM drugs`;
    const [labs] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM lab_tests`;
    if ((row?.n ?? 0n) > 0n && (labs?.n ?? 0n) > 0n) return;
  } finally {
    await db.$disconnect();
  }
  // the seed scripts write review / report files: keep them out of the repository
  const scratch = join(tmpdir(), 'dawai-e2e-seed');
  const env = {
    ...process.env,
    DATABASE_URL: e2eDatabaseUrl(),
    SEED_REPORT_DIR: scratch,
    SEED_REVIEW_DIR: scratch,
  };
  for (const args of [
    ['seed_catalog.py', '--load', '--fixture'],
    ['seed_interactions.py'],
    ['seed_lab_tests.py'],
  ]) {
    const [script, ...rest] = args;
    execFileSync(aiPython(), [join(REPO_ROOT, 'data', 'scripts', script!), ...rest], {
      env,
      stdio: 'pipe',
    });
  }
}

export class ConversationHarness {
  readonly ai = new AiServiceProcess();
  app!: INestApplication<App>;
  prisma!: PrismaService;
  private readonly sends: GraphBody[] = [];
  private storage!: StorageService;

  async start(): Promise<void> {
    await ensureE2eDatabase();
    prepareTestDatabase(e2eDatabaseUrl());
    await seedReferenceData();
    await this.ai.start();
    Object.assign(process.env, {
      ...INTEGRATION_ENV,
      DATABASE_URL: e2eDatabaseUrl(),
      AI_SERVICE_URL: this.ai.url,
      LOG_LEVEL: 'warn',
      WORKERS_ENABLED: 'true',
      DEV_ECHO_BOT: 'false',
    });
    nock.disableNetConnect();
    nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);
    nock(GRAPH)
      .persist()
      .post(SEND_PATH)
      .reply((_uri, body) => {
        const payload = body as GraphBody;
        if (payload.status === 'read') return [200, { success: true }];
        this.sends.push(payload);
        return [200, { messages: [{ id: `wamid.OUT${this.sends.length}` }] }];
      });
    this.app = (await createApp()) as INestApplication<App>;
    this.prisma = this.app.get(PrismaService);
    this.storage = this.app.get(StorageService);
  }

  async stop(): Promise<void> {
    nock.cleanAll();
    nock.enableNetConnect();
    await this.app.close();
    this.ai.stop();
  }

  // ---------------------------------------------------------------- one scenario

  async run(scenario: Scenario): Promise<ScenarioOutcome> {
    const ctx = new ScenarioRun(this, scenario);
    const steps: StepOutcome[] = [];
    try {
      await ctx.setup();
      for (const [index, step] of scenario.steps.entries()) {
        const problems = await ctx.step(step);
        if (problems.length > 0) problems.push(`state: ${await ctx.describeState()}`);
        steps.push({
          index,
          label: ctx.label(step),
          ok: problems.length === 0,
          problems,
        });
        if (problems.length > 0) break; // later steps depend on this one
      }
    } catch (error) {
      steps.push({
        index: steps.length,
        label: 'harness',
        ok: false,
        problems: [`harness error: ${error instanceof Error ? error.message : String(error)}`],
      });
    } finally {
      await ctx.cleanup();
    }
    return { name: scenario.name, file: scenario.file, ok: steps.every((s) => s.ok), steps };
  }

  // used by ScenarioRun
  get graphSends(): readonly GraphBody[] {
    return this.sends;
  }
  get storageService(): StorageService {
    return this.storage;
  }
}

class ScenarioRun {
  private readonly userPhone = randomPhone();
  private readonly caregiverPhone = randomPhone();
  private userId: string | null = null;
  private language: 'hi' | 'en' = 'en';
  private lastDocument = '';
  private readonly mediaKeys = new Set<string>();

  constructor(
    private readonly h: ConversationHarness,
    private readonly scenario: Scenario,
  ) {}

  label(step: Step): string {
    if (step.send) {
      const s = step.send;
      const what =
        s.type === 'text'
          ? s.text
          : s.type === 'button'
            ? s.id
            : s.type === 'image'
              ? s.fixture
              : s.says;
      return `send ${s.type}: ${what}`.slice(0, 80);
    }
    if (step.advance_time) return `advance_time ${step.advance_time}`;
    if (step.update_user) return 'update_user';
    return step.note ?? (step.expect_db ? 'expect_db' : 'expect');
  }

  async setup(): Promise<void> {
    const setup = this.scenario.setup;
    this.language = setup?.language ?? 'en';
    if (!setup?.onboarded) return;
    const user = await this.h.prisma.user.create({
      data: {
        waPhoneHash: hashPhone(this.userPhone, PEPPER),
        waPhoneEnc: this.h.app.get(CryptoService).encrypt(this.userPhone),
        language: this.language,
        onboardingStep: 'done',
        consentAt: new Date(),
        consentVersion: setup.consent_version ?? 'v2',
      },
    });
    this.userId = user.id;
  }

  async cleanup(): Promise<void> {
    const id = await this.resolveUserId();
    if (id) {
      await this.h.storageService.deletePrefix(`media/${id}/`);
      await this.h.prisma.user.deleteMany({ where: { id } });
    }
    await this.h.prisma.caregiver.deleteMany({
      where: { waPhoneHash: hashPhone(this.caregiverPhone, PEPPER) },
    });
  }

  /** One line for a failing step: what the database looks like (counts and statuses only). */
  async describeState(): Promise<string> {
    const id = await this.resolveUserId();
    if (!id) return 'no user row';
    const db = this.h.prisma;
    const reminders = await db.reminder.groupBy({
      by: ['status'],
      where: { userId: id },
      _count: true,
    });
    const user = await db.user.findUnique({
      where: { id },
      select: { consecutiveMisses: true, remindersEnabled: true },
    });
    const caregivers = await db.caregiver.findMany({
      where: { userId: id },
      select: { status: true, alertsToday: true },
    });
    const documents = await db.document.groupBy({
      by: ['kind', 'status'],
      where: { userId: id },
      _count: true,
    });
    return JSON.stringify({
      reminders: reminders.map((r) => `${r.status}:${r._count}`),
      misses: user?.consecutiveMisses,
      remindersEnabled: user?.remindersEnabled,
      caregivers: caregivers.map((c) => `${c.status}/alerts${c.alertsToday}`),
      documents: documents.map((d) => `${d.kind}/${d.status}:${d._count}`),
    });
  }

  private async resolveUserId(): Promise<string | null> {
    if (this.userId) return this.userId;
    const user = await this.h.prisma.user.findUnique({
      where: { waPhoneHash: hashPhone(this.userPhone, PEPPER) },
      select: { id: true },
    });
    this.userId = user?.id ?? null;
    return this.userId;
  }

  // ---------------------------------------------------------------- steps

  async step(step: Step): Promise<string[]> {
    const startIndex = this.h.graphSends.length;
    const problems: string[] = [];
    if (step.send) await this.send(step.send);
    if (step.update_user) await this.updateUser(step.update_user);
    if (step.advance_time) await this.advance(step.advance_time);
    if (step.send || step.advance_time) await this.settle(startIndex, step);
    await this.refresh();
    const replies = this.replies(startIndex);
    if (step.expect) problems.push(...this.checkReplies(step.expect, replies));
    if (problems.length > 0) {
      const brief = (list: Reply[]): string[] =>
        list.map((r) => r.template ?? `${r.kind}:${r.text.slice(0, 30)}`);
      problems.push(
        `seen: user=${JSON.stringify(brief(replies.user))} caregiver=${JSON.stringify(brief(replies.caregiver))}`,
      );
    }
    if (step.expect_db) problems.push(...(await this.checkDb(step.expect_db)));
    return problems;
  }

  private body(from: string, message: Record<string, unknown>): Buffer {
    const id = `wamid.IN${randomUUID().replaceAll('-', '').slice(0, 14)}`;
    return Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '200000000000001',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15550000000',
                    phone_number_id: '100000000000001',
                  },
                  messages: [
                    { from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...message },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
  }

  private mockMedia(mediaId: string, content: Buffer, mime: string): void {
    nock(GRAPH)
      .get(`/v21.0/${mediaId}`)
      .reply(200, {
        url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${mediaId}`,
        mime_type: mime,
        file_size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
        id: mediaId,
      });
    nock('https://lookaside.fbsbx.com')
      .get('/whatsapp_business/attachments/')
      .query({ mid: mediaId })
      .reply(200, content, { 'content-type': mime, 'content-length': String(content.length) });
  }

  private fixtureBytes(name: string): Buffer {
    // rx_NNN: generated prescriptions; lab_a / lab_b: e2e lab pages (marked for the fake model)
    const path = name.startsWith('lab_')
      ? join(REPO_ROOT, 'evals', 'datasets', 'e2e', 'images', `${name}.jpg`)
      : join(REPO_ROOT, 'evals', 'datasets', 'prescriptions', 'images', `${name}.jpg`);
    if (!existsSync(path)) {
      throw new Error(`fixture image ${name}.jpg is missing: run \`make eval-data\``);
    }
    return readFileSync(path);
  }

  private async send(spec: SendSpec): Promise<void> {
    const from = spec.from === 'caregiver' ? this.caregiverPhone : this.userPhone;
    let message: Record<string, unknown>;
    switch (spec.type) {
      case 'text':
        message = { type: 'text', text: { body: this.fill(spec.text) } };
        break;
      case 'button':
        message = {
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: this.fill(spec.id), title: 'x' },
          },
        };
        break;
      case 'image': {
        const mediaId = `media-${randomUUID().slice(0, 8)}`;
        this.mockMedia(mediaId, this.fixtureBytes(spec.fixture), 'image/jpeg');
        message = { type: 'image', image: { id: mediaId, mime_type: 'image/jpeg' } };
        break;
      }
      case 'audio': {
        const mediaId = `media-${randomUUID().slice(0, 8)}`;
        const payload = JSON.stringify({
          text: spec.says,
          language: null,
          confidence: spec.confidence ?? 0.95,
          duration_s: 4.0,
        });
        this.mockMedia(mediaId, Buffer.from(`FAKEAUDIO\n${payload}`, 'utf-8'), 'audio/ogg');
        message = { type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg', voice: true } };
        break;
      }
    }
    const raw = this.body(from, message);
    await request(this.h.app.getHttpServer())
      .post(WEBHOOK)
      .set(signedHeaders(raw))
      .send(raw.toString())
      .expect(200);
  }

  private fill(text: string): string {
    return text
      .replaceAll('{last_document}', this.lastDocument)
      .replaceAll('{caregiver_phone}', this.caregiverPhone);
  }

  /**
   * Wait until the reply expectations hold (the bot can answer asynchronously, e.g. a caregiver alert goes
   * through a queue), then until the bot has stopped talking. Gives up after a deadline; the caller then
   * reports what is missing.
   */
  private async settle(startIndex: number, step: Step): Promise<void> {
    if (step.expect?.no_reply === true) {
      await sleep(1500);
      return;
    }
    const slow = step.send?.type === 'image' || step.send?.type === 'audio';
    const deadline = Date.now() + (slow ? 40_000 : 15_000);
    if (step.expect) {
      while (
        Date.now() < deadline &&
        this.checkReplies(step.expect, this.replies(startIndex)).length > 0
      ) {
        await sleep(150);
      }
    } else if (step.send) {
      while (this.h.graphSends.length === startIndex && Date.now() < deadline) await sleep(100);
    }
    let last = this.h.graphSends.length;
    let stableSince = Date.now();
    while (Date.now() - stableSince < (slow ? 900 : 600) && Date.now() < deadline) {
      await sleep(100);
      if (this.h.graphSends.length !== last) {
        last = this.h.graphSends.length;
        stableSince = Date.now();
      }
    }
  }

  private async refresh(): Promise<void> {
    const id = await this.resolveUserId();
    if (!id) return;
    const latest = await this.h.prisma.document.findFirst({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latest) this.lastDocument = latest.id;
    const messages = await this.h.prisma.message.findMany({
      where: { userId: id, mediaS3Key: { not: null } },
      select: { mediaS3Key: true },
    });
    for (const m of messages) if (m.mediaS3Key) this.mediaKeys.add(m.mediaS3Key);
  }

  // ---------------------------------------------------------------- replies

  private replies(startIndex: number): { user: Reply[]; caregiver: Reply[] } {
    const toReply = (body: GraphBody): Reply => {
      const buttons = body.interactive?.action.buttons.map((b) => b.reply.id) ?? [];
      const params =
        body.template?.components?.flatMap((c) => c.parameters ?? []).map((p) => p.text ?? '') ??
        [];
      const text = body.text?.body ?? body.interactive?.body.text ?? params.join(' ');
      const kind: Reply['kind'] = body.template
        ? 'template'
        : body.interactive
          ? 'interactive'
          : body.text
            ? 'text'
            : body.type === 'audio'
              ? 'audio'
              : 'other';
      return { to: body.to ?? '', kind, text, buttons, template: body.template?.name ?? null };
    };
    const all = this.h.graphSends.slice(startIndex).map(toReply);
    return {
      user: all.filter((r) => r.to === this.userPhone),
      caregiver: all.filter((r) => r.to === this.caregiverPhone),
    };
  }

  private checkReplies(
    e: ReplyExpectation,
    replies: { user: Reply[]; caregiver: Reply[] },
  ): string[] {
    const problems: string[] = [];
    const mine = replies.user;
    const texts = mine.map((r) => r.text.toLowerCase());
    const joined = texts.join('\n');
    const buttons = mine.flatMap((r) => r.buttons);
    if (e.no_reply && mine.length > 0) problems.push(`expected no reply, got ${mine.length}`);
    if (e.replies !== undefined && mine.length !== e.replies) {
      problems.push(`expected exactly ${e.replies} replies, got ${mine.length}`);
    }
    if (e.replies_min !== undefined && mine.length < e.replies_min) {
      problems.push(`expected at least ${e.replies_min} replies, got ${mine.length}`);
    }
    for (const id of e.buttons_include ?? []) {
      const wanted = this.fill(id);
      const found = wanted.endsWith('*')
        ? buttons.some((b) => b.startsWith(wanted.slice(0, -1)))
        : buttons.includes(wanted);
      if (!found) problems.push(`button ${wanted} missing (got: ${buttons.join(', ') || 'none'})`);
    }
    for (const id of e.buttons_exclude ?? []) {
      if (buttons.includes(this.fill(id))) problems.push(`button ${id} must not be offered`);
    }
    for (const text of e.text_includes ?? []) {
      if (!joined.includes(text.toLowerCase())) problems.push(`no reply contains "${text}"`);
    }
    for (const text of e.text_excludes ?? []) {
      if (joined.includes(text.toLowerCase())) problems.push(`a reply contains "${text}"`);
    }
    for (const key of e.i18n ?? []) {
      const starts = [i18nStart('en', key), i18nStart('hi', key)].map((s) => s.toLowerCase());
      if (!starts.some((s) => joined.includes(s))) problems.push(`no reply is the text of ${key}`);
    }
    if (e.template && !mine.some((r) => r.template === e.template)) {
      problems.push(
        `template ${e.template} not sent (got: ${mine.map((r) => r.template ?? r.kind).join(', ') || 'nothing'})`,
      );
    }
    if (e.to_caregiver) {
      const cg = replies.caregiver;
      const cgText = cg.map((r) => r.text.toLowerCase()).join('\n');
      if (cg.length === 0) problems.push('the caregiver got nothing');
      if (e.to_caregiver.template && !cg.some((r) => r.template === e.to_caregiver!.template)) {
        problems.push(`caregiver template ${e.to_caregiver.template} not sent`);
      }
      for (const text of e.to_caregiver.text_includes ?? []) {
        if (!cgText.includes(text.toLowerCase()))
          problems.push(`caregiver message lacks "${text}"`);
      }
      for (const text of e.to_caregiver.text_excludes ?? []) {
        if (cgText.includes(text.toLowerCase()))
          problems.push(`caregiver message contains "${text}"`);
      }
    }
    return problems;
  }

  // ---------------------------------------------------------------- database expectations

  private async checkDb(e: DbExpectation): Promise<string[]> {
    const problems: string[] = [];
    const db = this.h.prisma;
    const id = await this.resolveUserId();
    const exists = id !== null && (await db.user.findUnique({ where: { id } })) !== null;
    if (e.user_exists !== undefined && exists !== e.user_exists) {
      problems.push(`user_exists is ${exists}, expected ${e.user_exists}`);
    }
    if (e.s3_prefix_empty && id) {
      const left = await this.h.storageService.deletePrefix(`media/${id}/`);
      if (left > 0) problems.push(`${left} object(s) still in S3 for the user`);
    }
    if (e.rows_for_user !== undefined && id) {
      const counts = await Promise.all([
        db.message.count({ where: { userId: id } }),
        db.document.count({ where: { userId: id } }),
        db.medication.count({ where: { userId: id } }),
        db.reminder.count({ where: { userId: id } }),
        db.caregiver.count({ where: { userId: id } }),
        db.labResult.count({ where: { userId: id } }),
      ]);
      const total = counts.reduce((a, b) => a + b, 0);
      if (total !== e.rows_for_user)
        problems.push(`${total} rows left for the user, expected ${e.rows_for_user}`);
    }
    if (!id || !exists) return this.checkAudit(e, problems);
    const user = await db.user.findUniqueOrThrow({ where: { id } });
    if (e.onboarding_step !== undefined && user.onboardingStep !== e.onboarding_step) {
      problems.push(`onboarding_step is ${user.onboardingStep}, expected ${e.onboarding_step}`);
    }
    if (e.consent_version !== undefined && user.consentVersion !== e.consent_version) {
      problems.push(
        `consent_version is ${String(user.consentVersion)}, expected ${String(e.consent_version)}`,
      );
    }
    if (e.reminders_enabled !== undefined && user.remindersEnabled !== e.reminders_enabled) {
      problems.push(`reminders_enabled is ${user.remindersEnabled}`);
    }
    if (e.consecutive_misses !== undefined && user.consecutiveMisses !== e.consecutive_misses) {
      problems.push(
        `consecutive_misses is ${user.consecutiveMisses}, expected ${e.consecutive_misses}`,
      );
    }
    if (e.reminder_status) {
      const n = await db.reminder.count({
        where: { userId: id, status: e.reminder_status as never },
      });
      if (n === 0) problems.push(`no reminder with status ${e.reminder_status}`);
    }
    if (e.reminder_count_min !== undefined) {
      const n = await db.reminder.count({ where: { userId: id } });
      if (n < e.reminder_count_min)
        problems.push(`${n} reminders, expected at least ${e.reminder_count_min}`);
    }
    if (e.document_count !== undefined) {
      const n = await db.document.count({ where: { userId: id } });
      if (n !== e.document_count) problems.push(`${n} documents, expected ${e.document_count}`);
    }
    if (e.document_kinds) {
      const kinds = (
        await db.document.findMany({ where: { userId: id }, select: { kind: true } })
      ).map((d) => d.kind);
      for (const kind of e.document_kinds)
        if (!kinds.includes(kind as never)) problems.push(`no ${kind} document`);
    }
    if (e.medication_count_min !== undefined) {
      const n = await db.medication.count({ where: { userId: id } });
      if (n < e.medication_count_min)
        problems.push(`${n} medications, expected at least ${e.medication_count_min}`);
    }
    if (e.warning_types) {
      const types = (
        await db.medicationWarning.findMany({
          where: { userId: id, status: 'active' },
          select: { type: true },
        })
      ).map((w) => w.type);
      for (const type of e.warning_types)
        if (!types.includes(type as never)) problems.push(`no active ${type} warning`);
    }
    if (e.lab_results_min !== undefined) {
      const n = await db.labResult.count({ where: { userId: id } });
      if (n < e.lab_results_min)
        problems.push(`${n} lab results, expected at least ${e.lab_results_min}`);
    }
    if (e.caregiver_status) {
      const caregivers = await db.caregiver.findMany({
        where: { userId: id },
        select: { status: true },
      });
      if (!caregivers.some((c) => c.status === e.caregiver_status)) {
        problems.push(`no caregiver with status ${e.caregiver_status}`);
      }
    }
    return this.checkAudit(e, problems);
  }

  private async checkAudit(e: DbExpectation, problems: string[]): Promise<string[]> {
    if (!e.audit_actions_include && !e.audit_actions_exclude) return problems;
    const id = await this.resolveUserId();
    const rows = await this.h.prisma.auditLog.findMany({
      where: { OR: [...(id ? [{ userId: id }] : []), { userId: null }] },
      select: { action: true },
    });
    const actions = rows.map((r) => r.action);
    for (const action of e.audit_actions_include ?? []) {
      if (!actions.includes(action)) problems.push(`audit action ${action} missing`);
    }
    for (const action of e.audit_actions_exclude ?? []) {
      if (actions.includes(action)) problems.push(`audit action ${action} must not exist`);
    }
    return problems;
  }

  // ---------------------------------------------------------------- time travel

  private async updateUser(change: NonNullable<Step['update_user']>): Promise<void> {
    const id = await this.resolveUserId();
    if (!id) throw new Error('update_user needs a user');
    if (change.last_inbound_hours_ago !== undefined) {
      await this.h.prisma.user.update({
        where: { id },
        data: { lastInboundAt: new Date(Date.now() - change.last_inbound_hours_ago * 3_600_000) },
      });
    }
  }

  /** "08:00 next day", "20:00 today", "+90m", "+2h", "+1d" -> fire due reminder slots / missed checks. */
  private async advance(spec: string): Promise<void> {
    const id = await this.resolveUserId();
    if (!id) throw new Error('advance_time needs a user');
    const dispatch = this.h.app.get(ReminderDispatchService);
    const target = this.parseTarget(spec);
    // 1. slots due by the target that nobody has sent yet (the delayed "slot" jobs of real life)
    const pending = await this.h.prisma.reminder.findMany({
      where: { userId: id, status: 'pending', scheduledAt: { lte: target } },
      select: { scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
    });
    const slots = [...new Set(pending.map((r) => r.scheduledAt.getTime()))];
    for (const ms of slots) await dispatch.sendSlot(id, new Date(ms), new Date());
    // 2. slots sent and still unanswered an hour before the target (the delayed "missed" jobs)
    const unanswered = await this.h.prisma.reminder.findMany({
      where: { userId: id, status: 'sent' },
      select: { scheduledAt: true, sentAt: true },
    });
    const checkAt = (slot: Date): Date => new Date(slot.getTime() + 61 * 60_000);
    const overdue = [...new Set(unanswered.map((r) => r.scheduledAt.getTime()))].sort(
      (a, b) => a - b,
    );
    for (const ms of overdue) {
      if (checkAt(new Date(ms)).getTime() <= target.getTime()) {
        await dispatch.checkMissed(id, new Date(ms), checkAt(new Date(ms)));
      }
    }
  }

  private parseTarget(spec: string): Date {
    const relative = /^\+(\d+)([mhd])$/.exec(spec.trim());
    if (relative) {
      const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd'];
      // relative to the LAST reminder that was sent (or the last slot due), not to the real clock
      return new Date(this.lastSlot.getTime() + Number(relative[1]) * unit);
    }
    const absolute = /^(\d{2}):(\d{2}) (today|next day)$/.exec(spec.trim());
    if (!absolute) throw new Error(`cannot parse advance_time "${spec}"`);
    const [, hh, mm, when] = absolute;
    const ist = new Date(Date.now() + IST_OFFSET_MIN * 60_000);
    const dayStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
    const dayMs = (when === 'next day' ? 86_400_000 : 0) + dayStart;
    const target = new Date(
      dayMs + (Number(hh) * 60 + Number(mm)) * 60_000 - IST_OFFSET_MIN * 60_000,
    );
    this.lastSlot = target;
    return target;
  }

  private lastSlot = new Date();
}
