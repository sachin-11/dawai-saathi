import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';

import { DemoCacheService, isDemoLanguage, isSampleId } from './demo-cache.service';
import { DEMO_IP_HEADER } from './demo.constants';
import { DemoKeyGuard } from './demo-key.guard';
import { type DemoResult, DemoService } from './demo.service';

/** What multer gives us (memory storage): only the bytes are used. */
interface UploadedFileLike {
  buffer: Buffer;
}

const BodySchema = z.object({
  language: z.string().default('hi'),
  sample_id: z.string().optional(),
  turnstile_token: z.string().max(2048).optional(),
  // Accepted for API stability; the pipeline classifies the document itself.
  kind_hint: z.enum(['prescription', 'lab_report']).optional(),
});

/** Multer's hard limit. The configured DEMO_MAX_UPLOAD_MB is enforced again in the service. */
const HARD_LIMIT_BYTES = 10 * 1024 * 1024;

@Controller('demo')
@UseGuards(DemoKeyGuard)
export class DemoController {
  constructor(
    private readonly demo: DemoService,
    private readonly cache: DemoCacheService,
  ) {}

  /** What the playground can offer right now: samples with a cached answer, and whether uploads are open. */
  @Get('status')
  @Header('Cache-Control', 'no-store')
  async status(): Promise<{ samples: unknown; uploads_enabled: boolean }> {
    return {
      samples: await this.cache.available(),
      uploads_enabled: await this.demo.uploadsEnabled(),
    };
  }

  @Post('process')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_LIMIT_BYTES, files: 1 } }))
  async process(
    @Body() rawBody: unknown,
    @UploadedFile() file: UploadedFileLike | undefined,
    @Req() request: Request,
  ): Promise<DemoResult> {
    const parsed = BodySchema.safeParse(rawBody ?? {});
    if (!parsed.success || !isDemoLanguage(parsed.data.language)) {
      throw new BadRequestException();
    }
    const body = parsed.data;
    const language = body.language as 'hi' | 'en';
    // The Next.js server forwards the visitor's address; it is trusted only after the key check passed.
    const forwarded = request.headers[DEMO_IP_HEADER];
    const ipHash = this.demo.hashIp(typeof forwarded === 'string' ? forwarded : 'unknown');

    if (body.sample_id !== undefined) {
      if (file || !isSampleId(body.sample_id)) throw new BadRequestException();
      return this.demo.sample(body.sample_id, language, ipHash);
    }
    if (!file) throw new BadRequestException();
    return this.demo.upload({
      file: file.buffer,
      language,
      turnstileToken: body.turnstile_token,
      ipHash,
    });
  }
}
