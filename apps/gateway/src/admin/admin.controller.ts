import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';

import { AdminDataService, type EvalReportSummary, type PromptInfo } from './admin-data.service';
import { type AdminRequest, AdminJwtGuard } from './admin-jwt.guard';
import { AdminError } from './admin.errors';
import {
  AdminService,
  type DlqOverview,
  REVIEW_LABELS,
  type ReviewLabelName,
  type ReviewQueuePage,
  type RevealResult,
  type StatsResult,
} from './admin.service';

const StatsQuery = z.object({ range: z.enum(['7d', '30d', '90d']).default('7d') });
const QueueQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
  include_reviewed: z.enum(['true', 'false']).default('false'),
});
const RevealBody = z.object({ reason: z.string().trim().min(1).max(500) });
const ResolveBody = z.object({ label: z.enum(REVIEW_LABELS) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new AdminError('invalid_request', HttpStatus.BAD_REQUEST);
  return result.data;
}

/** The operator API (M16). Read-mostly, paginated, JWT-guarded; never returns a phone number. */
@Controller('admin')
@UseGuards(AdminJwtGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly data: AdminDataService,
  ) {}

  @Get('stats')
  stats(@Query() query: unknown): Promise<StatsResult> {
    return this.admin.stats(parse(StatsQuery, query).range);
  }

  @Get('review-queue')
  reviewQueue(@Query() query: unknown): Promise<ReviewQueuePage> {
    const q = parse(QueueQuery, query);
    return this.admin.reviewQueue({
      limit: q.limit,
      ...(q.cursor ? { cursor: q.cursor } : {}),
      includeReviewed: q.include_reviewed === 'true',
    });
  }

  @Post('review-queue/:id/reveal')
  @HttpCode(HttpStatus.OK)
  reveal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ): Promise<RevealResult> {
    const { reason } = parse(RevealBody, body);
    return this.admin.reveal(id, request.admin?.email ?? '', reason);
  }

  @Post('review-queue/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() request: AdminRequest,
  ): Promise<{ id: string; label: ReviewLabelName }> {
    const { label } = parse(ResolveBody, body);
    return this.admin.resolve(id, request.admin?.email ?? '', label);
  }

  @Get('evals')
  async evals(): Promise<{ reports: EvalReportSummary[] }> {
    return { reports: await this.data.evals() };
  }

  @Get('prompts')
  async prompts(): Promise<{ prompts: PromptInfo[] }> {
    return { prompts: await this.data.prompts() };
  }

  @Get('dlq')
  dlq(): Promise<DlqOverview> {
    return this.admin.dlqOverview();
  }

  @Post('dlq/:queue/:jobId/retry')
  @HttpCode(HttpStatus.OK)
  dlqRetry(
    @Param('queue') queue: string,
    @Param('jobId') jobId: string,
    @Req() request: AdminRequest,
  ): Promise<{ retried: number; missing: number }> {
    return this.admin.dlqRetry(queue, jobId, request.admin?.email ?? '');
  }
}
