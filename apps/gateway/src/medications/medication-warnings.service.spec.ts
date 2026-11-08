import type { InteractionFinding, InteractionReport } from '../ai-client/types';
import type { PrismaService } from '../common/prisma/prisma.service';
import { MedicationWarningsService, refToMedicationId } from './medication-warnings.service';

const USER = 'user-1';
const M1 = '11111111-1111-1111-1111-111111111111';
const M2 = '22222222-2222-2222-2222-222222222222';
const M3 = '33333333-3333-3333-3333-333333333333';
const IX = '99999999-9999-9999-9999-999999999999';

function finding(overrides: Partial<InteractionFinding> = {}): InteractionFinding {
  return {
    type: 'interaction',
    severity: 'major',
    salt_a: 'ibuprofen',
    salt_b: 'warfarin',
    medication_refs: ['rx:0', M2],
    labels: ['Brufen', 'Warf'],
    interaction_id: IX,
    effect_code: 'bleeding',
    management_key: 'major',
    involves_new: true,
    hi_reviewed: false,
    ...overrides,
  };
}

function report(findings: InteractionFinding[], databaseOk = true): InteractionReport {
  return {
    findings,
    unchecked: [],
    resolved: [],
    checked_count: 2,
    database_ok: databaseOk,
  };
}

function setup(existing: unknown[] = []) {
  const model = {
    findMany: jest.fn().mockResolvedValue(existing),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest
      .fn()
      .mockImplementation(({ data }: { data: unknown[] }) =>
        Promise.resolve({ count: data.length }),
      ),
  };
  const medication = { findMany: jest.fn().mockResolvedValue([]) };
  const tx = { medicationWarning: model, medication };
  const prisma = {
    ...tx,
    $transaction: jest.fn().mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  return {
    service: new MedicationWarningsService(prisma as unknown as PrismaService),
    model,
    medication,
    tx,
  };
}

describe('refToMedicationId', () => {
  it('maps rx:<i> to the saved medication id at that index', () => {
    expect(refToMedicationId('rx:1', [M1, M2])).toBe(M2);
  });
  it('drops an index that was not saved', () => {
    expect(refToMedicationId('rx:5', [M1])).toBeNull();
  });
  it('accepts a stored medication id and rejects anything else', () => {
    expect(refToMedicationId(M3, [])).toBe(M3);
    expect(refToMedicationId('ctx:2', [])).toBeNull();
    expect(refToMedicationId("'; drop table", [])).toBeNull();
  });
});

describe('MedicationWarningsService.recordFindings', () => {
  it('stores a new finding with the saved ids, severity and interaction id', async () => {
    const s = setup();
    const stats = await s.service.recordFindings(s.tx as never, USER, report([finding()]), [M1]);
    expect(stats).toEqual({ created: 1, updated: 0, resolved: 0 });
    expect(s.model.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: USER,
          type: 'interaction',
          medicationIds: [M1, M2],
          saltA: 'ibuprofen',
          saltB: 'warfarin',
          severity: 'major',
          interactionId: IX,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('a duplicate ingredient has no severity', async () => {
    const s = setup();
    await s.service.recordFindings(
      s.tx as never,
      USER,
      report([
        finding({
          type: 'duplicate_ingredient',
          severity: null,
          salt_a: 'paracetamol',
          salt_b: 'paracetamol',
          interaction_id: null,
          medication_refs: ['rx:0', M2],
          management_key: 'duplicate_overdose',
        }),
      ]),
      [M1],
    );
    const call = s.model.createMany.mock.calls[0]?.[0] as { data: unknown[] } | undefined;
    const data = call?.data[0];
    expect(data).toMatchObject({
      type: 'duplicate_ingredient',
      severity: null,
      interactionId: null,
    });
  });

  it('does not repeat an active warning; it only adds the new medicine to it', async () => {
    const s = setup([
      {
        id: 'w1',
        type: 'interaction',
        saltA: 'ibuprofen',
        saltB: 'warfarin',
        medicationIds: [M2, M3],
      },
    ]);
    const stats = await s.service.recordFindings(s.tx as never, USER, report([finding()]), [M1]);
    expect(s.model.createMany).not.toHaveBeenCalled();
    expect(s.model.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { medicationIds: [M2, M3, M1] },
    });
    expect(stats).toEqual({ created: 0, updated: 1, resolved: 0 });
  });

  it('an unchanged active warning is left alone', async () => {
    const s = setup([
      {
        id: 'w1',
        type: 'interaction',
        saltA: 'ibuprofen',
        saltB: 'warfarin',
        medicationIds: [M1, M2],
      },
    ]);
    const stats = await s.service.recordFindings(s.tx as never, USER, report([finding()]), [M1]);
    expect(stats).toEqual({ created: 0, updated: 0, resolved: 0 });
    expect(s.model.update).not.toHaveBeenCalled();
  });

  it('stores nothing from a report whose database failed or that has no findings', async () => {
    const s = setup();
    expect(
      await s.service.recordFindings(s.tx as never, USER, report([finding()], false), [M1]),
    ).toEqual({
      created: 0,
      updated: 0,
      resolved: 0,
    });
    await s.service.recordFindings(s.tx as never, USER, report([]), [M1]);
    await s.service.recordFindings(s.tx as never, USER, null, [M1]);
    expect(s.model.createMany).not.toHaveBeenCalled();
  });

  it('skips refs it cannot map and a duplicate that does not have two products', async () => {
    const s = setup();
    await s.service.recordFindings(
      s.tx as never,
      USER,
      report([
        finding({ medication_refs: ['rx:9', 'ctx:1'] }),
        finding({
          type: 'duplicate_ingredient',
          severity: null,
          salt_a: 'paracetamol',
          salt_b: 'paracetamol',
          medication_refs: ['rx:0'],
          management_key: 'duplicate',
        }),
      ]),
      [M1],
    );
    expect(s.model.createMany).not.toHaveBeenCalled();
  });

  it('ignores an interaction id that is not a uuid (never reaches the foreign key)', async () => {
    const s = setup();
    await s.service.recordFindings(
      s.tx as never,
      USER,
      report([finding({ interaction_id: 'ix-3' })]),
      [M1],
    );
    const call = s.model.createMany.mock.calls[0]?.[0] as
      { data: { interactionId: string | null }[] } | undefined;
    expect(call?.data[0]?.interactionId).toBeNull();
  });
});

describe('MedicationWarningsService.syncAll (CHECK)', () => {
  it('adds new findings and resolves the ones that no longer apply', async () => {
    const s = setup();
    s.model.findMany
      .mockResolvedValueOnce([]) // upsert: nothing active yet
      .mockResolvedValueOnce([
        { id: 'old', type: 'interaction', saltA: 'a', saltB: 'b' },
        { id: 'same', type: 'interaction', saltA: 'ibuprofen', saltB: 'warfarin' },
      ]);
    const stats = await s.service.syncAll(USER, report([finding({ medication_refs: [M1, M2] })]));
    expect(stats.created).toBe(1);
    expect(stats.resolved).toBe(1);
    expect(s.model.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['old'] } },
      data: { status: 'resolved' },
    });
  });

  it('a failed database check changes nothing', async () => {
    const s = setup();
    const stats = await s.service.syncAll(USER, report([], false));
    expect(stats).toEqual({ created: 0, updated: 0, resolved: 0 });
    expect(s.model.updateMany).not.toHaveBeenCalled();
  });
});

describe('MedicationWarningsService.resolveForMedications', () => {
  it('resolves a warning that is left with fewer than two medicines', async () => {
    const s = setup([{ id: 'w1', medicationIds: [M1, M2] }]);
    expect(await s.service.resolveForMedications(s.tx as never, USER, [M1])).toBe(1);
    expect(s.model.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { status: 'resolved', medicationIds: [M2] },
    });
  });

  it('keeps a warning that still involves two or more medicines', async () => {
    const s = setup([{ id: 'w1', medicationIds: [M1, M2, M3] }]);
    expect(await s.service.resolveForMedications(s.tx as never, USER, [M1])).toBe(0);
    expect(s.model.update).toHaveBeenCalledWith({
      where: { id: 'w1' },
      data: { medicationIds: [M2, M3] },
    });
  });

  it('does nothing without ids', async () => {
    const s = setup();
    expect(await s.service.resolveForMedications(s.tx as never, USER, [])).toBe(0);
    expect(s.model.findMany).not.toHaveBeenCalled();
  });
});

describe('MedicationWarningsService reads', () => {
  it('lists active warnings with the medicine names', async () => {
    const s = setup([
      {
        id: 'w1',
        type: 'interaction',
        saltA: 'ibuprofen',
        saltB: 'warfarin',
        severity: 'major',
        medicationIds: [M1, M2],
      },
    ]);
    s.medication.findMany.mockResolvedValue([
      { id: M1, rawName: 'Brufen 400' },
      { id: M2, rawName: 'Warf' },
    ]);
    const [warning] = await s.service.listActive(USER);
    expect(warning).toMatchObject({ labels: ['Brufen 400', 'Warf'], severity: 'major' });
  });

  it('collects the ids of flagged medicines', async () => {
    const s = setup([{ medicationIds: [M1, M2] }, { medicationIds: [M2, M3] }]);
    expect(await s.service.medicationIdsWithWarnings(USER)).toEqual(new Set([M1, M2, M3]));
  });
});
