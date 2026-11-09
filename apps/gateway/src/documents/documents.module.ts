import { Module } from '@nestjs/common';

import { MedicationsModule } from '../medications/medications.module';
import { LabReportService } from './lab-report.service';
import { PrescriptionService } from './prescription.service';

/** Prescription documents and the medicines read from them (M7), lab reports and their results (M12). */
@Module({
  imports: [MedicationsModule],
  providers: [PrescriptionService, LabReportService],
  exports: [PrescriptionService, LabReportService],
})
export class DocumentsModule {}
