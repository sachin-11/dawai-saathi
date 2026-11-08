import { Module } from '@nestjs/common';

import { MedicationWarningsService } from './medication-warnings.service';

/** Interaction / duplicate-ingredient warnings of a user's medicines (M11). */
@Module({
  providers: [MedicationWarningsService],
  exports: [MedicationWarningsService],
})
export class MedicationsModule {}
