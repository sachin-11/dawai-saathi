import { Module } from '@nestjs/common';

import { MedicationsModule } from '../medications/medications.module';
import { PrescriptionService } from './prescription.service';

/** Prescription documents and the medicines read from them (M7). */
@Module({
  imports: [MedicationsModule],
  providers: [PrescriptionService],
  exports: [PrescriptionService],
})
export class DocumentsModule {}
