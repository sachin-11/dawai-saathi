import { Injectable } from '@nestjs/common';

import { AiClient, toRequestId } from '../ai-client/ai-client';
import { AuditService } from '../audit/audit.service';
import { LabReportService, REPORTS_LIMIT } from '../documents/lab-report.service';
import { isUuid } from '../documents/prescription.service';
import type { UserState } from '../users/users.service';
import { AI_ERROR_REPLY_INDEX } from './reply-indexes';
import type { ReplySession } from './replies.service';

export type LabAction = 'all' | 'wrong';
export interface LabButton {
  action: LabAction;
  documentId: string;
}
export type RepButton = { kind: 'show'; documentId: string } | { kind: 'page'; page: number };

const LAB_BUTTON = /^lab:(all|wrong):([^:\s]{1,64})$/;
const REP_SHOW = /^rep:show:([^:\s]{1,64})$/;
const REP_PAGE = /^rep:page:(\d{1,2})$/;

/** `lab:wrong:<document id>` -> `{action, documentId}`; anything else -> null. */
export function parseLabButton(buttonId: string): LabButton | null {
  const match = LAB_BUTTON.exec(buttonId);
  return match ? { action: match[1] as LabAction, documentId: match[2] as string } : null;
}

/** `rep:show:<id>` (one report) or `rep:page:<n>` (the next page of the REPORTS list). */
export function parseRepButton(buttonId: string): RepButton | null {
  const show = REP_SHOW.exec(buttonId);
  if (show) {
    const documentId = show[1] as string;
    return isUuid(documentId) ? { kind: 'show', documentId } : null;
  }
  const page = REP_PAGE.exec(buttonId);
  return page ? { kind: 'page', page: Number(page[1]) } : null;
}

export type LabOutcome =
  'lab_all' | 'lab_wrong' | 'lab_not_found' | 'reports_list' | 'reports_none' | 'report_shown';

const PAGE_SIZE = 2;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatReportDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * Lab report buttons and the REPORTS command (M12):
 *   [See all tests]   the stored extraction rendered by the AI service, grouped by section
 *   [Something wrong] the document needs review and leaves the trends; audited (no content)
 *   REPORTS           the last 5 reports (date, tests, outside the range); a tap re-sends the summary
 */
@Injectable()
export class LabActionsService {
  constructor(
    private readonly labs: LabReportService,
    private readonly ai: AiClient,
    private readonly audit: AuditService,
  ) {}

  async handle(user: UserState, button: LabButton, session: ReplySession): Promise<LabOutcome> {
    if (button.action === 'wrong') {
      const found = await this.labs.markWrong(user.id, button.documentId);
      if (!found) {
        await session.text('lab.not_found');
        return 'lab_not_found';
      }
      await this.audit.log({ actor: 'user', userId: user.id, action: 'lab_reported_wrong' });
      await session.text('lab.wrong_ack');
      return 'lab_wrong';
    }
    return (await this.render(user, button.documentId, 'all', session))
      ? 'lab_all'
      : 'lab_not_found';
  }

  /** REPORTS / "reports dikhao". */
  async list(user: UserState, session: ReplySession, page = 0): Promise<LabOutcome> {
    const reports = await this.labs.recent(user.id, REPORTS_LIMIT);
    if (reports.length === 0) {
      await session.text('reports.none');
      return 'reports_none';
    }
    const start = page * PAGE_SIZE;
    const shown = reports.slice(start, start + PAGE_SIZE);
    if (shown.length === 0) return this.list(user, session, 0);
    const hasMore = start + PAGE_SIZE < reports.length;
    const lines = reports.map((report, index) =>
      session.translate(report.reportDate ? 'reports.item' : 'reports.item_nodate', {
        n: index + 1,
        date: formatReportDate(report.reportDate ?? report.createdAt),
        tests: report.tests,
        outside: report.outside,
      }),
    );
    const body = `${session.translate('reports.header')}\n${lines.join('\n')}\n\n${session.translate('reports.prompt')}`;
    const buttons = shown.map((report, index) => ({
      id: `rep:show:${report.documentId}`,
      title:
        `${start + index + 1}. ${formatReportDate(report.reportDate ?? report.createdAt)}`.slice(
          0,
          20,
        ),
    }));
    if (hasMore) {
      buttons.push({
        id: `rep:page:${page + 1}`,
        title: session.translate('reports.more').slice(0, 20),
      });
    }
    await session.rawButtons(body, buttons);
    return 'reports_list';
  }

  async handleRep(user: UserState, button: RepButton, session: ReplySession): Promise<LabOutcome> {
    if (button.kind === 'page') return this.list(user, session, button.page);
    return (await this.render(user, button.documentId, 'summary', session))
      ? 'report_shown'
      : 'lab_not_found';
  }

  private async render(
    user: UserState,
    documentId: string,
    mode: 'all' | 'summary',
    session: ReplySession,
  ): Promise<boolean> {
    const extraction = await this.labs.extractionOf(user.id, documentId);
    if (!extraction) {
      await session.text('lab.not_found');
      return false;
    }
    try {
      const response = await this.ai.labRender({
        request_id: toRequestId(`${session.requestId}-lab`),
        language: user.language,
        mode,
        extraction,
      });
      await session.rawText(response.reply.text);
    } catch (error) {
      // One user-visible error per tap (fixed reply index), then let BullMQ retry the job.
      await session.textAt(AI_ERROR_REPLY_INDEX, 'common.error_try_again').catch(() => undefined);
      throw error;
    }
    return true;
  }
}
