// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Bundle } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { DOCUMENTS_PAGE_SIZE, fetchPatientDocuments, usePatientDocuments } from './usePatientDocuments';

function wrapperFor(medplum: MockClient) {
  return function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <MedplumProvider medplum={medplum}>{children}</MedplumProvider>;
  };
}

describe('fetchPatientDocuments', () => {
  test('searches the patient documents, excluding soft-deleted ones, and reports more pages', async () => {
    const medplum = new MockClient();
    const bundle: Bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      entry: [{ resource: { resourceType: 'DocumentReference', id: 'd1', status: 'current', content: [] } }],
      link: [{ relation: 'next', url: 'https://example.com/next' }],
    };
    const search = vi.spyOn(medplum, 'search').mockResolvedValue(bundle as never);

    const { rows, truncated } = await fetchPatientDocuments(medplum, 'p1');

    expect(search).toHaveBeenCalledWith(
      'DocumentReference',
      { subject: 'Patient/p1', 'status:not': 'entered-in-error', _sort: '-date', _count: String(DOCUMENTS_PAGE_SIZE) },
      { cache: 'no-cache' }
    );
    expect(rows.map((r) => r.id)).toEqual(['d1']);
    expect(truncated).toBe(true);
  });
});

describe('usePatientDocuments', () => {
  test('loads, reports errors and reloads', async () => {
    const medplum = new MockClient();
    await medplum.createResource({
      resourceType: 'DocumentReference',
      status: 'current',
      subject: { reference: `Patient/${HomerSimpson.id}` },
      description: 'Hook test document',
      content: [{ attachment: { url: 'Binary/x' } }],
    });

    const { result, rerender } = renderHook(({ key }) => usePatientDocuments(HomerSimpson.id as string, key), {
      wrapper: wrapperFor(medplum),
      initialProps: { key: 0 },
    });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows.map((r) => r.title)).toContain('Hook test document');

    vi.spyOn(medplum, 'search').mockRejectedValue(new Error('Boom'));
    rerender({ key: 1 });
    await waitFor(() => expect(result.current.error).toBe('Boom'));
    // The last good list stays on screen.
    expect(result.current.rows.length).toBeGreaterThan(0);
  });
});
