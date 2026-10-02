// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as searchBot from '../../../../examples/medplum-provider/bots/drchrono-search.ts';

/**
 * The morning routine, unattended.
 *
 * Every test here is phrased as something a clinic would notice — "the
 * follow-up was not imported", "nobody was imported twice", "the run said it
 * found nothing" — rather than as which function called which. Nothing asserts
 * a mock's shape or a call sequence: what is checked is the events that left
 * the pass and the Task it left behind, because those two are the entire
 * contract. The events are what causes a chart to be imported, and the Task is
 * what a person reads the next morning.
 *
 * ## What is faked, and what is not
 *
 * Only two things are faked: **DrChrono's HTTP responses** and **Medplum's
 * store**. The selection logic is the real `previewAppointments` from the
 * search bot — the same function the onboarding screen runs — so a test that
 * says "the follow-up was not queued" is exercising the actual filter rather
 * than a restatement of it. The bot's own `handler` is replaced, because around
 * that filter it decrypts credentials and refreshes OAuth tokens, neither of
 * which this is about.
 *
 * ## What has not been verified
 *
 * No part of this has run against the real DrChrono API, deliberately: a
 * 33-patient day exhausted this practice's quota for twenty minutes. Nor has
 * the cron registration been accepted by the deployed Inngest plan — a
 * registration has been refused before, for a concurrency limit, and nothing
 * local can test that.
 */

// Read by `botEvent` when it builds the event for the search bot. Set before
// the imports that reach it, exactly as `import-chain.test.ts` does.
process.env.LYFE_CREDENTIAL_ENCRYPTION_KEY = 'test-encryption-key-long-enough-for-scrypt';

/** An appointment as DrChrono's verbose payload returns it. */
interface FakeAppointment {
  patient?: number;
  status?: string;
  office?: number;
  doctor?: number;
  reason?: string;
}

/** A sent Inngest event, as the pass handed it over. */
interface SentEvent {
  name: string;
  data: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  store: {
    /** Credential records, one per clinic. */
    basics: [] as Record<string, any>[],
    memberships: [] as Record<string, any>[],
    patients: [] as Record<string, any>[],
    tasks: [] as Record<string, any>[],
    /** What DrChrono's calendar holds for the scanned range. */
    appointments: [] as FakeAppointment[],
    disabledOffices: [] as string[],
    disabledDoctors: [] as string[],
    /** When set, DrChrono refuses the scan with this message. */
    previewError: undefined as string | undefined,
    sent: [] as SentEvent[],
    nextId: 1,
  },
}));

/** An Inngest function definition, as `createFunction` was handed it. */
interface CapturedFunction {
  config: Record<string, unknown>;
  trigger: Record<string, unknown>;
  handler: (ctx: any) => Promise<unknown>;
}

const registered: Record<string, CapturedFunction> = {};

vi.mock('../inngest.ts', () => ({
  // The real `createFunction` builds something only the Inngest runtime can
  // invoke. This keeps the three arguments so the handler can be driven
  // directly and the trigger can be read — which is the only way to check a
  // declaration like `cron` that is never executed in process.
  inngest: {
    createFunction: (config: any, trigger: any, handler: any) => {
      registered[config.id] = { config, trigger, handler };
      return { config, trigger, handler };
    },
    send: vi.fn(),
  },
  PER_CLINIC_CONCURRENCY: 5,
}));

vi.mock('../medplum.ts', () => {
  const { store } = h;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const medplum = {
    async searchResources(resourceType: string, query: any): Promise<any[]> {
      const q = new URLSearchParams(typeof query === 'string' ? query : query);
      if (resourceType === 'Basic') {
        const subject = q.get('subject');
        return clone(store.basics.filter((b) => !subject || b.subject?.reference === subject));
      }
      if (resourceType === 'ProjectMembership') {
        return clone(store.memberships.filter((m) => m.profile?.reference === q.get('profile')));
      }
      if (resourceType === 'Patient') {
        const wanted = new Set((q.get('identifier') ?? '').split(','));
        return clone(
          store.patients.filter((p) => (p.identifier ?? []).some((i: any) => wanted.has(`${i.system}|${i.value}`)))
        );
      }
      if (resourceType === 'Task') {
        const token = q.get('identifier') ?? '';
        return clone(
          store.tasks.filter((t) => (t.identifier ?? []).some((i: any) => `${i.system}|${i.value}` === token))
        );
      }
      return [];
    },
    async createResource(resource: any): Promise<any> {
      const saved = { ...clone(resource), id: `res-${store.nextId++}` };
      if (resource.resourceType === 'Task') {
        store.tasks.push(saved);
      }
      return clone(saved);
    },
    async readResource(resourceType: string, id: string): Promise<any> {
      const found = resourceType === 'Task' ? store.tasks.find((t) => t.id === id) : undefined;
      if (!found) {
        throw new Error(`${resourceType}/${id} not found`);
      }
      return clone(found);
    },
    async updateResource(resource: any): Promise<any> {
      const index = store.tasks.findIndex((t) => t.id === resource.id);
      if (index >= 0) {
        store.tasks[index] = clone(resource);
      }
      return clone(resource);
    },
    async patchResource(resourceType: string, id: string, ops: any[]): Promise<any> {
      const found = store.tasks.find((t) => t.id === id);
      for (const op of ops ?? []) {
        if (found && op.op === 'add') {
          found[String(op.path).slice(1)] = op.value;
        }
      }
      return clone(found);
    },
  };
  return { getMedplum: async () => medplum, requiredEnv: () => 'https://medplum.example.com/' };
});

vi.mock('../../../../examples/medplum-provider/bots/drchrono-search.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof searchBot>();
  const { store } = h;
  return {
    ...actual,
    // The bot's own selection, over a fake calendar. Replacing the handler
    // rather than the filter keeps the thing under test real: the credentials
    // and the OAuth refresh are what is being stubbed out, not the decision
    // about who gets imported.
    handler: async (_medplum: unknown, event: any) => {
      if (store.previewError) {
        return { ok: false, error: store.previewError };
      }
      const get = async (path: string): Promise<Response> => {
        const body = path.startsWith('/appointments')
          ? { results: store.appointments, next: null }
          : { id: Number(/\/patients\/(\d+)/.exec(path)?.[1] ?? 0), first_name: 'Pat', last_name: 'Example' };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
      };
      return actual.previewAppointments(
        get,
        event.input.start,
        event.input.end,
        { offices: new Set(store.disabledOffices), doctors: new Set(store.disabledDoctors) },
        event.input.reason
      );
    },
  };
});

const { INTEGRATION_SYSTEM } = await import('../../../../examples/medplum-provider/bots/shared/credentials.ts');
const { DRCHRONO_PATIENT_SYSTEM } = await import('../discovery/existing.ts');
await import('./onboarding-discovery.ts');

const ORG = 'org-1';
const REQUESTER = 'Practitioner/doc-1';

/**
 * The step tooling the pass uses, run straight through.
 * @returns A step object that executes everything inline.
 */
function fakeStep(): any {
  return {
    run: async (_id: string, body: () => Promise<unknown>) => body(),
    sleepUntil: async () => undefined,
    sendEvent: async (_id: string, events: SentEvent | SentEvent[]) => {
      h.store.sent.push(...(Array.isArray(events) ? events : [events]));
    },
  };
}

/**
 * Give the clinic a credential record with these discovery settings.
 * @param config - Field name to stored value.
 * @param organizationId - The clinic.
 */
function configure(config: Record<string, string>, organizationId = ORG): void {
  h.store.basics.push({
    resourceType: 'Basic',
    id: `cred-${organizationId}`,
    identifier: [{ system: INTEGRATION_SYSTEM, value: 'drchrono' }],
    subject: { reference: `Organization/${organizationId}` },
    extension: Object.entries(config).map(([name, valueString]) => ({
      url: `${INTEGRATION_SYSTEM}/config/${name}`,
      valueString,
    })),
  });
}

/**
 * Run one clinic's pass.
 * @param organizationId - The clinic.
 * @returns Whatever the pass returned.
 */
async function runPass(organizationId = ORG): Promise<any> {
  return registered['onboarding-discovery'].handler({
    event: { data: { organizationId, reason: 'test' } },
    step: fakeStep(),
    runId: `run-${h.store.nextId++}`,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
}

/**
 * The chart imports the pass asked for.
 * @returns The DrChrono ids it queued.
 */
function queuedPatientIds(): string[] {
  return h.store.sent
    .filter((e) => e.name === 'lyfe/chart.import.requested')
    .map((e) => String(e.data.drchronoPatientId));
}

/**
 * The pass's own Task.
 * @returns The Task, when one was opened.
 */
function discoveryTask(): Record<string, any> | undefined {
  return h.store.tasks.find((t) => t.code?.text === 'onboarding-discovery');
}

beforeEach(() => {
  h.store.basics = [];
  h.store.memberships = [
    {
      resourceType: 'ProjectMembership',
      profile: { reference: REQUESTER },
      access: [{ parameter: [{ name: 'organization', valueReference: { reference: `Organization/${ORG}` } }] }],
    },
  ];
  h.store.patients = [];
  h.store.tasks = [];
  h.store.appointments = [];
  h.store.disabledOffices = [];
  h.store.disabledDoctors = [];
  h.store.previewError = undefined;
  h.store.sent = [];
  h.store.nextId = 1;
});

describe('a clinic that has not switched it on', () => {
  test('is not touched at all', async () => {
    configure({ discoveryRequester: REQUESTER });
    h.store.appointments = [{ patient: 1, status: 'Confirmed', reason: 'new patient' }];

    const result = await runPass();

    expect(result).toMatchObject({ skipped: 'disabled' });
    expect(h.store.sent).toStrictEqual([]);
    // Not even a row on its Imports page. A clinic that has not opted in should
    // not find evidence of a job it never asked for.
    expect(h.store.tasks).toStrictEqual([]);
  });

  test('is not asked to run by the schedule either', async () => {
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER }, 'org-on');
    configure({ discoveryRequester: REQUESTER }, 'org-off');
    configure({ discoveryEnabled: 'yes', discoveryRequester: REQUESTER }, 'org-ambiguous');

    await registered['onboarding-discovery-schedule'].handler({
      step: fakeStep(),
      logger: { info: () => undefined },
    });

    expect(h.store.sent.map((e) => e.data.organizationId)).toStrictEqual(['org-on']);
  });
});

describe('an enabled clinic', () => {
  beforeEach(() => {
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER });
  });

  test('queues everyone with an active appointment, whatever the reason says', async () => {
    // No reason filter by default. The chart has to be there when the patient
    // is in the room, and whether the booking staff typed "new patient" is not
    // a safe thing to hang that on.
    h.store.appointments = [
      { patient: 11, status: 'Confirmed', reason: 'New Patient Consult' },
      { patient: 22, status: 'Confirmed', reason: 'follow up' },
      { patient: 33, status: 'Confirmed' },
    ];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual(['11', '22', '33']);
  });

  test('asks for the import with the event the Import button already sends', async () => {
    // The whole point of emitting this rather than building a path: the chart,
    // the network record, the document index and the summary all follow from
    // it, and an automated import is the same import as a manual one.
    h.store.appointments = [{ patient: 11, status: 'Confirmed', reason: 'new patient' }];

    await runPass();

    expect(h.store.sent).toHaveLength(1);
    expect(h.store.sent[0]).toMatchObject({
      name: 'lyfe/chart.import.requested',
      data: { organizationId: ORG, requester: REQUESTER, drchronoPatientId: '11' },
    });
  });

  test('does not queue a cancelled new patient', async () => {
    h.store.appointments = [{ patient: 11, status: 'Cancelled', reason: 'new patient' }];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual([]);
  });

  test('does not queue a new patient at a switched-off office', async () => {
    h.store.appointments = [{ patient: 11, status: 'Confirmed', office: 99, reason: 'new patient' }];
    h.store.disabledOffices = ['99'];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual([]);
  });

  test('does not import a patient who is already in Medplum', async () => {
    h.store.patients = [
      {
        resourceType: 'Patient',
        id: 'p-11',
        meta: { account: { reference: `Organization/${ORG}` } },
        identifier: [{ system: DRCHRONO_PATIENT_SYSTEM, value: '11' }],
      },
    ];
    h.store.appointments = [
      { patient: 11, status: 'Confirmed', reason: 'new patient' },
      { patient: 12, status: 'Confirmed', reason: 'new patient' },
    ];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual(['12']);
  });

  test('running twice does not queue the same patient twice', async () => {
    h.store.appointments = [{ patient: 11, status: 'Confirmed', reason: 'new patient' }];

    await runPass();
    await runPass();

    expect(queuedPatientIds()).toStrictEqual(['11']);
  });

  test('never removes anything when an appointment is cancelled', async () => {
    // The riskiest line in the parent scope, and the answer is no. A patient
    // whose only appointment in the window was cancelled keeps their chart.
    h.store.patients = [
      {
        resourceType: 'Patient',
        id: 'p-11',
        meta: { account: { reference: `Organization/${ORG}` } },
        identifier: [{ system: DRCHRONO_PATIENT_SYSTEM, value: '11' }],
      },
    ];
    h.store.appointments = [{ patient: 11, status: 'Cancelled', reason: 'new patient' }];

    await runPass();

    expect(h.store.patients).toHaveLength(1);
    expect(h.store.patients[0].active).toBeUndefined();
  });
});

describe('the clinic decides the phrase', () => {
  test('a practice that writes "NP" changes a setting, not the code', async () => {
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER, discoveryReason: 'NP' });
    h.store.appointments = [
      { patient: 11, status: 'Confirmed', reason: 'NP eval' },
      { patient: 22, status: 'Confirmed', reason: 'new patient' },
    ];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual(['11']);
  });

  test('a clinic that saved no phrase onboards its whole active schedule', async () => {
    // Including the appointment with no reason at all. An absent Reason is the
    // commonest kind, and a patient whose chart is missing because nobody
    // filled in a free-text box is the failure this exists to prevent.
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER });
    h.store.appointments = [
      { patient: 11, status: 'Confirmed', reason: 'new patient' },
      { patient: 22, status: 'Confirmed', reason: 'annual physical' },
      { patient: 33, status: 'Confirmed' },
    ];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual(['11', '22', '33']);
  });

  test('a clinic that wants to narrow it still can', async () => {
    // The phrase remains available for a clinic that genuinely only wants a
    // subset. It is opt-in now rather than the default.
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER, discoveryReason: 'new patient' });
    h.store.appointments = [
      { patient: 11, status: 'Confirmed', reason: 'New Patient Consult' },
      { patient: 22, status: 'Confirmed', reason: 'follow up' },
    ];

    await runPass();

    expect(queuedPatientIds()).toStrictEqual(['11']);
  });
});

describe('what the run leaves behind', () => {
  test('a pass that finds nobody says so rather than failing', async () => {
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER });
    // Everybody on the day is already in Medplum, so there is nothing to do.
    h.store.appointments = [
      { patient: 11, status: 'Confirmed', reason: 'follow up' },
      { patient: 22, status: 'Confirmed', reason: 'annual physical' },
    ];
    h.store.patients = ['11', '22'].map((value) => ({
      resourceType: 'Patient',
      id: `p-${value}`,
      meta: { account: { reference: `Organization/${ORG}` } },
      identifier: [{ system: DRCHRONO_PATIENT_SYSTEM, value }],
    }));

    await runPass();

    const task = discoveryTask();
    expect(task?.status).toBe('completed');
    // "queued 0" has to be on the row. A Task that merely says "complete" is
    // indistinguishable from a run that never looked at all.
    expect(task?.businessStatus?.text).toContain('queued 0');
    expect(task?.businessStatus?.text).toContain('scanned 2');
    expect(task?.businessStatus?.text).toContain('already imported 2');
    // No phrase was set, so none is claimed. Printing `reason "" excluded 0`
    // would send the reader hunting for a filter that is not there.
    expect(task?.businessStatus?.text).not.toContain('reason "');
  });

  test('a clinic whose DrChrono refuses is reported as failed, not as a quiet day', async () => {
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER });
    h.store.previewError = 'DrChrono appointments 401: token expired';

    await expect(runPass()).rejects.toThrow(/token expired/);

    const task = discoveryTask();
    expect(task?.status).toBe('failed');
    expect(task?.statusReason?.coding?.[0]?.code).toBe('auth-expired');
    expect(h.store.sent).toStrictEqual([]);
  });

  test('the cap bounds what one unattended pass can queue, and the Task says what is left', async () => {
    configure({ discoveryEnabled: 'true', discoveryRequester: REQUESTER, discoveryMaxPatients: '2' });
    h.store.appointments = [11, 22, 33].map((patient) => ({ patient, status: 'Confirmed', reason: 'new patient' }));

    await runPass();

    expect(queuedPatientIds()).toHaveLength(2);
    expect(discoveryTask()?.businessStatus?.text).toContain('1 left for the next pass');
  });
});

describe('the profile an unattended run acts as', () => {
  test('is refused when it belongs to another clinic', async () => {
    // Config is written by an authenticated admin *of some clinic*. Without
    // this, an admin of A could name a practitioner of B and have A's
    // appointments imported into B's chart.
    configure({ discoveryEnabled: 'true', discoveryRequester: 'Practitioner/other-clinic-doc' });
    h.store.memberships.push({
      resourceType: 'ProjectMembership',
      profile: { reference: 'Practitioner/other-clinic-doc' },
      access: [{ parameter: [{ name: 'organization', valueReference: { reference: 'Organization/org-2' } }] }],
    });
    h.store.appointments = [{ patient: 11, status: 'Confirmed', reason: 'new patient' }];

    await expect(runPass()).rejects.toThrow(/org-2/);
    expect(h.store.sent).toStrictEqual([]);
  });

  test('is required, and its absence stops the pass before it opens a Task', async () => {
    configure({ discoveryEnabled: 'true' });

    await expect(runPass()).rejects.toThrow(/discoveryRequester/);
    expect(h.store.tasks).toStrictEqual([]);
  });
});

describe('the schedule', () => {
  test('is a cron, and runs in the clinic day rather than in UTC', () => {
    // Asserted on the declaration because a cron trigger is never executed in
    // process. A UTC schedule wanders by an hour twice a year and can land on
    // the wrong calendar day entirely.
    expect(registered['onboarding-discovery-schedule'].trigger).toMatchObject({
      cron: expect.stringContaining('TZ='),
    });
  });

  test('sends nothing at all when no clinic has opted in', async () => {
    const result = await registered['onboarding-discovery-schedule'].handler({
      step: fakeStep(),
      logger: { info: () => undefined },
    });

    expect(result).toStrictEqual({ clinics: 0 });
    expect(h.store.sent).toStrictEqual([]);
  });
});
