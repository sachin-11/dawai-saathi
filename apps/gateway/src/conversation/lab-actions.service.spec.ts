import type { AiClient } from '../ai-client/ai-client';
import type { AuditService } from '../audit/audit.service';
import type { LabReportService } from '../documents/lab-report.service';
import type { UserState } from '../users/users.service';
import { LabActionsService, parseLabButton, parseRepButton } from './lab-actions.service';
import type { ReplySession } from './replies.service';

const user: UserState = {
  id: 'user-1',
  language: 'en',
  onboardingStep: 'done',
  consentAt: new Date(),
  remindersEnabled: true,
  deletedAt: null,
};
const DOC = '3f2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';
const DOC2 = '4a2b8c1e-5d0a-4b7e-9c61-0a1b2c3d4e5f';

describe('button parsing', () => {
  it('parses lab buttons and rejects anything else', () => {
    expect(parseLabButton(`lab:all:${DOC}`)).toEqual({ action: 'all', documentId: DOC });
    expect(parseLabButton(`lab:wrong:${DOC}`)).toEqual({ action: 'wrong', documentId: DOC });
    expect(parseLabButton('lab:delete:x')).toBeNull();
    expect(parseLabButton('lab:all:')).toBeNull();
    expect(parseLabButton(`rx:wrong:${DOC}`)).toBeNull();
  });

  it('parses report buttons; a malformed document id is rejected', () => {
    expect(parseRepButton(`rep:show:${DOC}`)).toEqual({ kind: 'show', documentId: DOC });
    expect(parseRepButton('rep:show:not-a-uuid')).toBeNull();
    expect(parseRepButton('rep:page:2')).toEqual({ kind: 'page', page: 2 });
    expect(parseRepButton('rep:page:x')).toBeNull();
  });
});

function report(id: string, outside: number, reportDate: Date | null = new Date('2026-11-12')) {
  return { documentId: id, reportDate, createdAt: new Date('2026-11-13'), tests: 18, outside };
}

function setup(options: { reports?: unknown[]; extraction?: unknown; marked?: boolean } = {}) {
  const labs = {
    markWrong: jest.fn().mockResolvedValue(options.marked ?? true),
    extractionOf: jest.fn().mockResolvedValue(options.extraction ?? { kind: 'lab_report' }),
    recent: jest.fn().mockResolvedValue(options.reports ?? []),
  };
  const ai = {
    labRender: jest.fn().mockResolvedValue({ request_id: 'r', reply: { text: 'RENDERED' } }),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const session = {
    text: jest.fn().mockResolvedValue(undefined),
    textAt: jest.fn().mockResolvedValue(undefined),
    rawText: jest.fn().mockResolvedValue(undefined),
    rawButtons: jest.fn().mockResolvedValue(undefined),
    translate: jest.fn((key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    ),
    requestId: 'req-1',
  };
  const service = new LabActionsService(
    labs as unknown as LabReportService,
    ai as unknown as AiClient,
    audit as unknown as AuditService,
  );
  return { service, labs, ai, audit, session, asSession: session as unknown as ReplySession };
}

describe('LabActionsService', () => {
  it('"Something wrong" marks the document, audits without content and acknowledges', async () => {
    const s = setup();
    await expect(
      s.service.handle(user, { action: 'wrong', documentId: DOC }, s.asSession),
    ).resolves.toBe('lab_wrong');
    expect(s.labs.markWrong).toHaveBeenCalledWith('user-1', DOC);
    expect(s.audit.log).toHaveBeenCalledWith({
      actor: 'user',
      userId: 'user-1',
      action: 'lab_reported_wrong',
    });
    expect(s.session.text).toHaveBeenCalledWith('lab.wrong_ack');
  });

  it('a foreign or unknown document gets the same neutral answer and nothing is audited', async () => {
    const s = setup({ marked: false });
    await expect(
      s.service.handle(user, { action: 'wrong', documentId: DOC }, s.asSession),
    ).resolves.toBe('lab_not_found');
    expect(s.audit.log).not.toHaveBeenCalled();
    expect(s.session.text).toHaveBeenCalledWith('lab.not_found');
  });

  it('"See all tests" sends the stored extraction to the AI service and relays the text', async () => {
    const s = setup();
    await expect(
      s.service.handle(user, { action: 'all', documentId: DOC }, s.asSession),
    ).resolves.toBe('lab_all');
    expect(s.labs.extractionOf).toHaveBeenCalledWith('user-1', DOC);
    expect(s.ai.labRender).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en', mode: 'all', extraction: { kind: 'lab_report' } }),
    );
    expect(s.session.rawText).toHaveBeenCalledWith('RENDERED');
  });

  it('"See all tests" for a document that is not theirs does not call the AI service', async () => {
    const s = setup();
    s.labs.extractionOf.mockResolvedValue(null);
    await expect(
      s.service.handle(user, { action: 'all', documentId: DOC }, s.asSession),
    ).resolves.toBe('lab_not_found');
    expect(s.ai.labRender).not.toHaveBeenCalled();
  });

  it('an AI failure sends one error message and rethrows so the job is retried', async () => {
    const s = setup();
    s.ai.labRender.mockRejectedValue(new Error('down'));
    await expect(
      s.service.handle(user, { action: 'all', documentId: DOC }, s.asSession),
    ).rejects.toThrow('down');
    expect(s.session.textAt).toHaveBeenCalledWith(expect.any(Number), 'common.error_try_again');
  });

  it('REPORTS with nothing saved says so', async () => {
    const s = setup();
    await expect(s.service.list(user, s.asSession)).resolves.toBe('reports_none');
    expect(s.session.text).toHaveBeenCalledWith('reports.none');
  });

  it('REPORTS lists the reports with two buttons and "More" when there are more', async () => {
    const s = setup({
      reports: [report(DOC, 2), report(DOC2, 0), report('x3', 1), report('x4', 1), report('x5', 0)],
    });
    await expect(s.service.list(user, s.asSession)).resolves.toBe('reports_list');
    const [body, buttons] = s.session.rawButtons.mock.calls[0] as [
      string,
      { id: string; title: string }[],
    ];
    expect(body).toContain('reports.item');
    expect(buttons.map((b) => b.id)).toEqual([`rep:show:${DOC}`, `rep:show:${DOC2}`, 'rep:page:1']);
    expect(buttons.every((b) => b.title.length <= 20)).toBe(true);
  });

  it('the last page has no "More" and a page past the end starts over', async () => {
    const reports = [report(DOC, 2), report(DOC2, 0), report('x3', 1)];
    const s = setup({ reports });
    await s.service.list(user, s.asSession, 1);
    const [, buttons] = s.session.rawButtons.mock.calls[0] as [string, { id: string }[]];
    expect(buttons.map((b) => b.id)).toEqual(['rep:show:x3']);
    await s.service.list(user, s.asSession, 9);
    const [, again] = s.session.rawButtons.mock.calls[1] as [string, { id: string }[]];
    expect(again[0]?.id).toBe(`rep:show:${DOC}`);
  });

  it('selecting a report re-sends its summary', async () => {
    const s = setup();
    await expect(
      s.service.handleRep(user, { kind: 'show', documentId: DOC }, s.asSession),
    ).resolves.toBe('report_shown');
    expect(s.ai.labRender).toHaveBeenCalledWith(expect.objectContaining({ mode: 'summary' }));
  });
});
