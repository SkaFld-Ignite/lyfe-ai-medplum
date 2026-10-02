// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Bundle, BundleEntry, Condition, Patient, Reference, Resource } from '@medplum/fhirtypes';
import { beforeEach, describe, expect, test } from 'vitest';
import type { UpsertEntry } from './batch.ts';
import { upsertBatch } from './batch.ts';
import type { DeclineTally } from './local-edits.ts';
import { selectWritable } from './local-edits.ts';

/**
 * Pulling the same patient twice.
 *
 * This is the test the manual re-sync exists for, and it is deliberately not a
 * test of either half on its own. It runs the **real** guard
 * (`selectWritable`) feeding the **real** batched writer (`upsertBatch`) into a
 * server that implements FHIR's conditional-update-by-identifier contract — no
 * match creates, exactly one match updates in place, more than one is 412 — and
 * stamps `meta.author` from whoever is writing, which is what Medplum's own
 * repository does (`packages/server/src/fhir/repo.ts`, `getAuthor`).
 *
 * What is asserted is the state of the chart afterwards: how many resources
 * there are, and whether the words a clinician typed are still in them.
 * Nothing asserts which function called which.
 *
 * ## What this proves and what it does not
 *
 * The store below is faithful to the contract, not to Medplum. It cannot show
 * that Medplum's server implements that contract — Medplum's own tests do
 * that — and it cannot show anything about concurrency, because it is
 * single-threaded. Two runs racing each other is handled a layer up, by the
 * per-patient concurrency key on the Inngest function, and is asserted there.
 *
 * The last case in this file is the control: it runs the same two pulls with
 * the guard taken out, and the clinician's edit is gone. That is the
 * regression every other case here is standing in front of.
 */

const SYSTEM = 'https://zusapi.com/fhir/Condition';
const PATIENT: Reference<Patient> = { reference: 'Patient/p1' };
const IMPORTER = 'ClientApplication/lyfe-worker';
const CLINICIAN = 'Practitioner/dr-who';

/**
 * A FHIR server that implements conditional update by business identifier.
 *
 * Small enough to read in one go, which matters: if the contract it enforces
 * were buried, a test passing here would mean nothing.
 */
class ContractStore {
  private readonly resources = new Map<string, Resource>();
  private nextId = 1;
  /** Who the next write is attributed to, as a session would be. */
  public author = IMPORTER;

  /**
   * Put a resource in directly, as an earlier run would have left it.
   * @param props - The seed.
   * @param props.sourceId - Source system id to key it on, if any.
   * @param props.text - Human-visible content, used to detect an overwrite.
   * @param props.author - Who last wrote it.
   * @param props.hideAuthor - Omit `meta.author`, as a non-extended read would.
   * @returns The Medplum id it was stored under.
   */
  seed(props: { sourceId?: string; text: string; author: string; hideAuthor?: boolean }): string {
    const id = `local-${this.nextId++}`;
    this.resources.set(id, {
      resourceType: 'Condition',
      id,
      subject: PATIENT,
      code: { text: props.text },
      ...(props.sourceId ? { identifier: [{ system: SYSTEM, value: props.sourceId }] } : {}),
      meta: props.hideAuthor ? {} : { author: { reference: props.author } },
    });
    return id;
  }

  /** @returns Every resource currently stored. */
  all(): Condition[] {
    return [...this.resources.values()] as Condition[];
  }

  /**
   * @param id - Medplum id.
   * @returns That resource.
   */
  get(id: string): Condition {
    return this.resources.get(id) as Condition;
  }

  /**
   * Edit a resource as a person would, through the app.
   * @param id - Medplum id.
   * @param text - The new content.
   */
  editAsClinician(id: string, text: string): void {
    const existing = this.get(id);
    this.resources.set(id, {
      ...existing,
      code: { text },
      meta: { ...existing.meta, author: { reference: CLINICIAN } },
    });
  }

  /**
   * Resolve a conditional URL to the ids it matches.
   * @param url - e.g. `Condition?identifier=sys%7Cvalue`.
   * @returns Matching Medplum ids.
   */
  private matches(url: string): string[] {
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const [system, value] = (query.get('identifier') ?? '').split('|');
    return this.all()
      .filter((r) => r.identifier?.some((i) => i.system === system && i.value === value))
      .map((r) => r.id as string);
  }

  /**
   * Run one `Bundle type=batch` of conditional updates.
   * @param bundle - The batch.
   * @returns The response bundle, index-aligned to the request.
   */
  private runBatch(bundle: Bundle): Bundle {
    const entry: BundleEntry[] = [];
    for (const e of bundle.entry ?? []) {
      const ids = this.matches(e.request?.url as string);
      if (ids.length > 1) {
        // FHIR's answer to an ambiguous conditional update. The server does
        // not pick one, and neither does anything downstream of it.
        entry.push({ response: { status: '412' } });
        continue;
      }
      const id = ids[0] ?? `local-${this.nextId++}`;
      const written = {
        ...(e.resource as Resource),
        id,
        meta: { ...(e.resource as Resource).meta, author: { reference: this.author } },
      } as Resource;
      this.resources.set(id, written);
      entry.push({ resource: written, response: { status: ids[0] ? '200' : '201' } });
    }
    return { resourceType: 'Bundle', type: 'batch-response', entry };
  }

  /** @returns A client exposing only what the importer uses. */
  client(): MedplumClient {
    const all = (): Condition[] => this.all();
    return {
      searchResourcePages: function* () {
        yield all();
      },
      executeBatch: (bundle: Bundle): Promise<Bundle> => Promise.resolve(this.runBatch(bundle)),
    } as unknown as MedplumClient;
  }
}

/** One Zus resource as the importer would have prepared it for writing. */
interface Incoming {
  sourceId: string;
  text: string;
}

/**
 * Turn incoming resources into the shape the batch writer takes.
 * @param items - What the source returned.
 * @returns Upsert entries.
 */
function entriesFor(items: readonly { sourceId: string; value: Resource }[]): UpsertEntry[] {
  return items.map((item) => ({
    resourceType: 'Condition',
    resource: item.value,
    system: SYSTEM,
    value: item.sourceId,
  }));
}

/**
 * A resource body as the importer re-anchors it.
 * @param incoming - What the source returned.
 * @returns The resource to write.
 */
function prepared(incoming: Incoming): Resource {
  return {
    resourceType: 'Condition',
    subject: PATIENT,
    code: { text: incoming.text },
    identifier: [{ system: SYSTEM, value: incoming.sourceId }],
  };
}

/**
 * One guarded pull of one resource type — exactly what `importResourceType`
 * does, minus the network.
 * @param store - The server.
 * @param incoming - What the source returned this time.
 * @returns How many were written and what was declined.
 */
async function pull(
  store: ContractStore,
  incoming: readonly Incoming[]
): Promise<{ wrote: number; declined: DeclineTally }> {
  const selection = await selectWritable({
    medplum: store.client(),
    resourceType: 'Condition',
    patient: PATIENT,
    system: SYSTEM,
    items: incoming.map((i) => ({ sourceId: i.sourceId, value: prepared(i) })),
  });
  const result = await upsertBatch(store.client(), entriesFor(selection.writable), {
    interChunkDelayMs: 0,
    logger: { warn: () => undefined },
  });
  return { wrote: result.wrote, declined: selection.declined };
}

/**
 * The same pull with no guard at all — what the importer did before this change.
 * @param store - The server.
 * @param incoming - What the source returned this time.
 */
async function unguardedPull(store: ContractStore, incoming: readonly Incoming[]): Promise<void> {
  await upsertBatch(store.client(), entriesFor(incoming.map((i) => ({ sourceId: i.sourceId, value: prepared(i) }))), {
    interChunkDelayMs: 0,
    logger: { warn: () => undefined },
  });
}

const FIRST_PULL: Incoming[] = [
  { sourceId: 'zus-1', text: 'Type 2 diabetes mellitus' },
  { sourceId: 'zus-2', text: 'Essential hypertension' },
  { sourceId: 'zus-3', text: 'Hyperlipidemia' },
];

describe('pulling the same record twice', () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
  });

  test('writes nothing new the second time', async () => {
    await pull(store, FIRST_PULL);
    expect(store.all()).toHaveLength(3);

    await pull(store, FIRST_PULL);
    // The property that matters: three conditions, not six. The conditional
    // update matched each one on its Zus id and replaced it in place.
    expect(store.all()).toHaveLength(3);
  });

  test('adds what is new without touching what is already here', async () => {
    await pull(store, FIRST_PULL);
    const before = store.all().map((c) => c.id);

    await pull(store, [...FIRST_PULL, { sourceId: 'zus-4', text: 'Chronic kidney disease, stage 3' }]);

    expect(store.all()).toHaveLength(4);
    // The three that were here kept their Medplum ids, so every reference,
    // every note and every link pointing at them still resolves.
    expect(store.all().map((c) => c.id)).toEqual(expect.arrayContaining(before));
  });

  test('a resource with no source id is never written, so it cannot be duplicated', async () => {
    // The importer drops these before they reach the guard — there would be
    // nothing to key the next run on, so every run would write another copy.
    await pull(store, FIRST_PULL);
    await pull(store, FIRST_PULL);
    expect(store.all().filter((c) => !c.identifier?.length)).toHaveLength(0);
  });
});

describe('a clinician’s edit', () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
  });

  test('survives the next pull', async () => {
    await pull(store, FIRST_PULL);
    const edited = store.all().find((c) => c.identifier?.[0]?.value === 'zus-2')?.id as string;
    store.editAsClinician(edited, 'Essential hypertension — resolved, off medication since March');

    const result = await pull(store, FIRST_PULL);

    expect(store.get(edited).code?.text).toBe('Essential hypertension — resolved, off medication since March');
    expect(result.declined).toEqual({ 'clinician-edited': 1 });
    // The other two were still refreshed. Protecting one resource must not
    // stop the rest of the chart from being brought up to date.
    expect(result.wrote).toBe(2);
  });

  test('is reported, not silently skipped', async () => {
    await pull(store, FIRST_PULL);
    const edited = store.all()[0].id as string;
    store.editAsClinician(edited, 'edited');

    const result = await pull(store, FIRST_PULL);
    expect(result.declined['clinician-edited']).toBe(1);
  });

  test('is lost without the guard — the regression these tests stand in front of', async () => {
    await pull(store, FIRST_PULL);
    const edited = store.all().find((c) => c.identifier?.[0]?.value === 'zus-2')?.id as string;
    store.editAsClinician(edited, 'Essential hypertension — resolved, off medication since March');

    await unguardedPull(store, FIRST_PULL);

    // Still exactly three resources — the conditional update never duplicated
    // anything, which is why this failure was invisible. What it did was
    // overwrite a clinician's words with the network's.
    expect(store.all()).toHaveLength(3);
    expect(store.get(edited).code?.text).toBe('Essential hypertension');
  });
});

describe('an ambiguous match', () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
  });

  test('declines rather than guessing which copy to keep', async () => {
    // Two local resources answering to one Zus id. However it happened — a
    // concurrent run before the per-patient lock, a hand-merged chart — there
    // is no safe way to choose.
    const a = store.seed({ sourceId: 'zus-1', text: 'copy A', author: IMPORTER });
    const b = store.seed({ sourceId: 'zus-1', text: 'copy B', author: IMPORTER });

    const result = await pull(store, [{ sourceId: 'zus-1', text: 'from the network' }]);

    expect(result.declined).toEqual({ 'ambiguous-match': 1 });
    expect(result.wrote).toBe(0);
    // Neither copy was touched, and no third one was created.
    expect(store.get(a).code?.text).toBe('copy A');
    expect(store.get(b).code?.text).toBe('copy B');
    expect(store.all()).toHaveLength(2);
  });
});

describe('when the guard cannot see who wrote a resource', () => {
  let store: ContractStore;

  beforeEach(() => {
    store = new ContractStore();
  });

  test('existing resources are left alone and new ones still land', async () => {
    // `meta.author` is stripped outside Medplum's extended mode. An edited
    // resource and an untouched one are indistinguishable, so neither is
    // written over.
    const existing = store.seed({ sourceId: 'zus-1', text: 'as it stands', author: IMPORTER, hideAuthor: true });

    const result = await pull(store, [
      { sourceId: 'zus-1', text: 'from the network' },
      { sourceId: 'zus-9', text: 'brand new' },
    ]);

    expect(result.declined).toEqual({ 'author-unreadable': 1 });
    expect(store.get(existing).code?.text).toBe('as it stands');
    expect(store.all()).toHaveLength(2);
  });
});
