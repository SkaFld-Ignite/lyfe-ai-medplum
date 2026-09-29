// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { createReference } from '@medplum/core';
import type { Bundle } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DRCHRONO_SOURCE_TAG, LYFE_SOURCE_TAG_SYSTEM } from '../utils/data-source';
import { fetchTimelineSources, TIMELINE_PAGE_SIZE, usePatientTimelineData } from './usePatientTimelineData';

function wrapperFor(medplum: MockClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <MedplumProvider medplum={medplum}>{children}</MedplumProvider>;
  };
}

describe('usePatientTimelineData', () => {
  test('does nothing without a patient id', () => {
    const medplum = new MockClient();
    const search = vi.spyOn(medplum, 'search');
    const { result } = renderHook(() => usePatientTimelineData(undefined), { wrapper: wrapperFor(medplum) });
    expect(result.current.loading).toBe(false);
    expect(result.current.timeline).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });

  test("loads and builds the patient's timeline", async () => {
    const medplum = new MockClient();
    const patient = createReference(HomerSimpson);
    const encounter = await medplum.createResource({
      resourceType: 'Encounter',
      meta: { tag: [{ system: LYFE_SOURCE_TAG_SYSTEM, code: 'drchrono' }] },
      status: 'finished',
      class: { code: 'AMB' },
      subject: patient,
      period: { start: '2026-09-14T09:30:00Z' },
      type: [{ text: 'Timeline test visit' }],
    });
    await medplum.createResource({
      resourceType: 'Observation',
      meta: { tag: [{ system: LYFE_SOURCE_TAG_SYSTEM, code: 'drchrono' }] },
      status: 'final',
      code: { text: 'Timeline test pulse' },
      subject: patient,
      encounter: createReference(encounter),
      effectiveDateTime: '2026-09-14T09:40:00Z',
    });

    const { result } = renderHook(() => usePatientTimelineData(HomerSimpson.id), { wrapper: wrapperFor(medplum) });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    const visit = result.current.timeline?.events.find((e) => e.type === 'visit' && e.title === 'Timeline test visit');
    expect(visit).toBeDefined();
    expect(visit?.type === 'visit' && visit.records.map((r) => r.title)).toEqual(['Timeline test pulse']);
    expect(result.current.error).toBeUndefined();
  });

  test('reports errors', async () => {
    const medplum = new MockClient();
    vi.spyOn(medplum, 'search').mockRejectedValue(new Error('Boom'));
    const { result } = renderHook(() => usePatientTimelineData(HomerSimpson.id), { wrapper: wrapperFor(medplum) });
    await waitFor(() => expect(result.current.error).toBe('Boom'));
    expect(result.current.loading).toBe(false);
  });

  test('reload refetches', async () => {
    const medplum = new MockClient();
    const search = vi.spyOn(medplum, 'search');
    const { result } = renderHook(() => usePatientTimelineData(HomerSimpson.id), { wrapper: wrapperFor(medplum) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const calls = search.mock.calls.length;

    result.current.reload();

    await waitFor(() => expect(search.mock.calls.length).toBeGreaterThan(calls));
  });
});

describe('fetchTimelineSources', () => {
  test('searches every type by patient and DrChrono tag, and reports types with more pages', async () => {
    const medplum = new MockClient();
    const empty: Bundle = { resourceType: 'Bundle', type: 'searchset', entry: [] };
    const search = vi
      .spyOn(medplum, 'search')
      .mockImplementation(((resourceType: string) =>
        Promise.resolve(
          resourceType === 'Observation'
            ? { ...empty, link: [{ relation: 'next', url: 'https://example.com/next' }] }
            : empty
        )) as unknown as MockClient['search']);

    const { truncatedTypes } = await fetchTimelineSources(medplum, 'p1');

    expect(search).toHaveBeenCalledTimes(11);
    expect(search).toHaveBeenCalledWith(
      'Encounter',
      { patient: 'Patient/p1', _tag: DRCHRONO_SOURCE_TAG, _count: String(TIMELINE_PAGE_SIZE) },
      { cache: 'no-cache' }
    );
    expect(truncatedTypes).toEqual(['Observation']);
  });
});
