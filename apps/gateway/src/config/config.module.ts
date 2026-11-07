import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from './config.constants';
import { validateEnv } from './env.schema';

/**
 * Global, validated configuration. Validation happens when the module is
 * instantiated, so a bad env aborts bootstrap (fail fast).
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => validateEnv(process.env),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
