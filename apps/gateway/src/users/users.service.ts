import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { CryptoService } from '../common/crypto/crypto.service';
import { PrismaService } from '../common/prisma/prisma.service';

export interface UserRef {
  id: string;
  language: 'hi' | 'en';
  consentAt: Date | null;
}

const USER_SELECT = { id: true, language: true, consentAt: true } as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Find the user for a phone number or create one (language `hi`, no consent yet).
   *
   * The number is never stored in the clear: lookup uses the peppered hash, and the number is kept
   * encrypted (`wa_phone_enc`) only so we can message the user later. `upsert` on the unique hash is
   * a single atomic INSERT ... ON CONFLICT, so two concurrent first messages create ONE user.
   */
  async findOrCreateByPhone(phone: string): Promise<UserRef> {
    const waPhoneHash = this.crypto.hashPhone(phone);
    const create = (): Promise<UserRef> =>
      this.prisma.user.upsert({
        where: { waPhoneHash },
        create: {
          waPhoneHash,
          waPhoneEnc: this.crypto.encrypt(this.crypto.normalisePhone(phone)),
        },
        update: {},
        select: USER_SELECT,
      });

    try {
      return await create();
    } catch (error) {
      // Defensive: if the driver still reports a unique violation under a race, the row exists now.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.user.findUniqueOrThrow({ where: { waPhoneHash }, select: USER_SELECT });
      }
      throw error;
    }
  }

  /**
   * Record when the user last wrote to us (drives the 24-hour WhatsApp window in M3/M10).
   * Only ever moves forward, so a retried or out-of-order old message cannot extend the window.
   */
  async touchLastInbound(userId: string, at: Date): Promise<void> {
    await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: at } }] },
      data: { lastInboundAt: at },
    });
  }
}
