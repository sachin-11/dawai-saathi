import { Module } from '@nestjs/common';

import { PrescriptionService } from './prescription.service';

/** Prescription documents and the medicines read from them (M7). */
@Module({
  providers: [PrescriptionService],
  exports: [PrescriptionService],
})
export class DocumentsModule {}
