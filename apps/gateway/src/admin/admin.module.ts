import { Module } from '@nestjs/common';

import { AdminDataService } from './admin-data.service';
import { AdminJwtGuard } from './admin-jwt.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/** M16: the operator API behind the Next.js admin. Global modules supply Prisma, Audit, Storage, limits, DLQ. */
@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminDataService, AdminJwtGuard],
})
export class AdminModule {}
