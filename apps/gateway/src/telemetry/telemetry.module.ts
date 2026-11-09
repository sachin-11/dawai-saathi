import { Global, Module } from '@nestjs/common';

import { DlqAdminService } from './dlq-admin.service';
import { DlqService } from './dlq.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { QueueMetricsCollector } from './queue-metrics.collector';
import { WorkerFactory } from './worker-factory.service';

/** Metrics, worker instrumentation and dead letters, available everywhere (M15). */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService, DlqService, DlqAdminService, WorkerFactory, QueueMetricsCollector],
  exports: [MetricsService, DlqService, DlqAdminService, WorkerFactory, QueueMetricsCollector],
})
export class TelemetryModule {}
