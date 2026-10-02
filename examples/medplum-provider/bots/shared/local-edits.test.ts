// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Condition, Patient, Reference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import type { LocalIndex } from './local-edits.ts';
import { decideWrite, isHumanAuthor, loadLocalIndex, selectWritable } from './local-edits.ts';

/**
 * What a re-pull is allowed to overwrite.
 *
 * These are the rules a manual re-sync stands on. The import has always been
 * safe against *duplication* — every write is a conditional update keyed on the
 * source's own id — but a conditional update replaces the whole resource, so
 * running it again over a chart somebody has edited is a different question
 * with a different answer.
 *
 * Every case here is written as "what is already on the server, and what does
 * the next pull do about it". Nothing asserts which internal function was
 * called or in what order: the property under test is that an edited resource
 * is still there afterwards.
 */

const SYSTEM = 'https://zusapi.com/fhir/Condition';
const PATIENT: Reference<Patient> = { reference: 'Patient/p1' };

/**
 * A Condition as the server would return it from a search.
 * @param props - What to vary.
 * @param props.id - Medplum resource id.
 * @param props.sourceId - The source system's id, carried as a business identifier.
 * @param props.author - `meta.author.reference`, or undefined to omit it entirely.
 * @returns The resource.
 */
function stored(props: { id: string; sourceId?: string; author?: string }): Condition {
  return {
    resourceType: 'Condition',
    id: props.id,
    subject: PATIENT,
    ...(props.sourceId ? { identifier: [{ system: SYSTEM, value: props.sourceId }] } : {}),
    meta: props.author ? { author: { reference: props.author } } : {},
  };
}

/**
 * A client whose search returns a fixed set of resources, one page.
 * @param resources - What the search answers with.
 * @returns A client with just enough surface for the guard.
 */
function clientWith(resources: Condition[]): MedplumClient {
  return {
    searchResourcePages: async function* () {
      yield resources;
    },
  } as unknown as MedplumClient;
}

describe('isHumanAuthor', () => {
  test('a clinician, a patient and a portal user are people', () => {
    expect(isHumanAuthor('Practitioner/dr-who')).toBe(true);
    expect(isHumanAuthor('PractitionerRole/pr-1')).toBe(true);
    expect(isHumanAuthor('Patient/p1')).toBe(true);
    expect(isHumanAuthor('RelatedPerson/rp-1')).toBe(true);
  });

  test('the importer, a bot and the server are not', () => {
    // The worker authenticates as a ClientApplication; a Medplum-hosted bot
    // run is authored by the Bot. Both must stay writable, or a re-sync
    // becomes a no-op the first time it is asked for.
    expect(isHumanAuthor('ClientApplication/worker')).toBe(false);
    expect(isHumanAuthor('Bot/zus-import')).toBe(false);
    expect(isHumanAuthor('system')).toBe(false);
    expect(isHumanAuthor(undefined)).toBe(false);
  });
});

describe('loadLocalIndex', () => {
  test('keys what is here on the source id, ignoring resources from elsewhere', async () => {
    const index = await loadLocalIndex({
      medplum: clientWith([
        stored({ id: 'local-1', sourceId: 'zus-1', author: 'ClientApplication/worker' }),
        // Hand-entered in the app: no source identifier at all. It is not part
        // of the mirror and the guard has no opinion about it.
        stored({ id: 'local-2', author: 'Practitioner/dr-who' }),
      ]),
      resourceType: 'Condition',
      patient: PATIENT,
      system: SYSTEM,
    });
    expect([...index.bySourceId.keys()]).toEqual(['zus-1']);
    expect(index.bySourceId.get('zus-1')?.id).toBe('local-1');
    expect(index.ambiguous.size).toBe(0);
    expect(index.authorReadable).toBe(true);
  });

  test('records a source id claimed by two local resources as ambiguous', async () => {
    const index = await loadLocalIndex({
      medplum: clientWith([
        stored({ id: 'local-1', sourceId: 'zus-1', author: 'ClientApplication/worker' }),
        stored({ id: 'local-2', sourceId: 'zus-1', author: 'ClientApplication/worker' }),
      ]),
      resourceType: 'Condition',
      patient: PATIENT,
      system: SYSTEM,
    });
    expect(index.ambiguous.has('zus-1')).toBe(true);
  });

  test('reports the author as unreadable when nothing came back with one', async () => {
    // Medplum strips meta.author outside extended mode, and an AccessPolicy can
    // hide it. Either way the guard cannot tell edited from untouched.
    const index = await loadLocalIndex({
      medplum: clientWith([stored({ id: 'local-1', sourceId: 'zus-1' })]),
      resourceType: 'Condition',
      patient: PATIENT,
      system: SYSTEM,
    });
    expect(index.authorReadable).toBe(false);
  });

  test('an empty chart is not an unreadable one', async () => {
    const index = await loadLocalIndex({
      medplum: clientWith([]),
      resourceType: 'Condition',
      patient: PATIENT,
      system: SYSTEM,
    });
    // Nothing here to protect, so the first import must not be blocked.
    expect(index.authorReadable).toBe(true);
  });
});

describe('decideWrite', () => {
  /**
   * Build an index over the given stored resources.
   * @param resources - What is already on the server.
   * @returns The index.
   */
  async function indexOf(resources: Condition[]): Promise<LocalIndex> {
    return loadLocalIndex({
      medplum: clientWith(resources),
      resourceType: 'Condition',
      patient: PATIENT,
      system: SYSTEM,
    });
  }

  test('writes a resource that is not here yet', async () => {
    const index = await indexOf([]);
    expect(decideWrite({ index, sourceId: 'zus-1' })).toEqual({ write: true });
  });

  test('writes over a resource the importer itself last wrote', async () => {
    const index = await indexOf([stored({ id: 'l1', sourceId: 'zus-1', author: 'ClientApplication/worker' })]);
    expect(decideWrite({ index, sourceId: 'zus-1' })).toEqual({ write: true });
  });

  test('refuses to write over a resource a clinician last wrote', async () => {
    const index = await indexOf([stored({ id: 'l1', sourceId: 'zus-1', author: 'Practitioner/dr-who' })]);
    const decision = decideWrite({ index, sourceId: 'zus-1' });
    expect(decision.write).toBe(false);
    expect(decision).toMatchObject({ reason: 'clinician-edited' });
  });

  test('refuses an ambiguous match rather than picking one', async () => {
    const index = await indexOf([
      stored({ id: 'l1', sourceId: 'zus-1', author: 'ClientApplication/worker' }),
      stored({ id: 'l2', sourceId: 'zus-1', author: 'ClientApplication/worker' }),
    ]);
    const decision = decideWrite({ index, sourceId: 'zus-1' });
    expect(decision.write).toBe(false);
    expect(decision).toMatchObject({ reason: 'ambiguous-match' });
  });

  test('refuses every existing resource when the author cannot be read', async () => {
    const index = await indexOf([stored({ id: 'l1', sourceId: 'zus-1' })]);
    expect(decideWrite({ index, sourceId: 'zus-1' })).toMatchObject({
      write: false,
      reason: 'author-unreadable',
    });
    // A resource that is not here cannot carry an edit, so it still writes —
    // otherwise an unreadable author would freeze the chart entirely.
    expect(decideWrite({ index, sourceId: 'zus-new' })).toEqual({ write: true });
  });
});

describe('selectWritable', () => {
  test('hands back only what may be written, with the rest counted', async () => {
    const selection = await selectWritable({
      medplum: clientWith([
        stored({ id: 'l1', sourceId: 'zus-1', author: 'ClientApplication/worker' }),
        stored({ id: 'l2', sourceId: 'zus-2', author: 'Practitioner/dr-who' }),
        stored({ id: 'l3', sourceId: 'zus-3', author: 'ClientApplication/worker' }),
        stored({ id: 'l4', sourceId: 'zus-3', author: 'ClientApplication/worker' }),
      ]),
      resourceType: 'Condition',
      patient: PATIENT,
      system: SYSTEM,
      items: [
        { sourceId: 'zus-1', value: 'a' },
        { sourceId: 'zus-2', value: 'b' },
        { sourceId: 'zus-3', value: 'c' },
        { sourceId: 'zus-4', value: 'd' },
      ],
    });
    expect(selection.writable.map((w) => w.sourceId)).toEqual(['zus-1', 'zus-4']);
    expect(selection.declined).toEqual({ 'clinician-edited': 1, 'ambiguous-match': 1 });
    // The ids of what is already here are reported for every candidate that
    // has one, declined or not, so references can be repointed at the copy
    // that was kept.
    expect(selection.existingIds.get('zus-2')).toBe('l2');
  });

  test('a failed read of what is here takes the whole type with it', async () => {
    const medplum = {
      // eslint-disable-next-line require-yield
      searchResourcePages: async function* () {
        throw new Error('search failed');
      },
    } as unknown as MedplumClient;
    // Fail closed. The alternative — carrying on with an empty index — writes
    // over everything, which is the exact outcome the guard exists to stop.
    await expect(
      selectWritable({
        medplum,
        resourceType: 'Condition',
        patient: PATIENT,
        system: SYSTEM,
        items: [{ sourceId: 'zus-1', value: 'a' }],
      })
    ).rejects.toThrow('search failed');
  });
});
