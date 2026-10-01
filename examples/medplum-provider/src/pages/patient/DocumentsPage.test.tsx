// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import type { WithId } from '@medplum/core';
import type { DocumentReference } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DOCUMENTS_PER_PAGE } from '../../components/patient-documents/documents-config';
import { DocumentsPage } from './DocumentsPage';

vi.mock('../../utils/notifications');

const patientId = HomerSimpson.id as string;
const tag = (code: string): DocumentReference['meta'] => ({ tag: [{ system: 'https://lyfe.com/source', code }] });

describe('DocumentsPage', () => {
  let medplum: MockClient;

  beforeEach(() => {
    medplum = new MockClient();
    vi.clearAllMocks();
  });

  const createDocument = (overrides: Partial<DocumentReference> = {}): Promise<WithId<DocumentReference>> =>
    medplum.createResource<DocumentReference>({
      resourceType: 'DocumentReference',
      status: 'current',
      subject: { reference: `Patient/${patientId}` },
      content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/example', title: 'file.pdf' } }],
      ...overrides,
    });

  const setup = (path = `/Patient/${patientId}/DocumentReference`): ReturnType<typeof createMemoryRouter> => {
    const router = createMemoryRouter(
      [
        { path: '/Patient/:patientId/DocumentReference', element: <DocumentsPage /> },
        { path: '/Patient/:patientId/DocumentReference/:documentId', element: <DocumentsPage /> },
      ],
      { initialEntries: [path] }
    );
    render(
      <MedplumProvider medplum={medplum}>
        <MantineProvider>
          <RouterProvider router={router} />
        </MantineProvider>
      </MedplumProvider>
    );
    return router;
  };

  const rows = (): HTMLElement[] => screen.queryAllByTestId('document-row');

  test('lists documents with their source, type, dates and categories', async () => {
    await createDocument({
      description: 'LABCORP FINAL LABS',
      meta: tag('drchrono'),
      date: '2025-12-17T10:00:00Z',
      type: { text: 'Laboratory report' },
      category: [{ text: 'Labs, Results' }],
    });
    await createDocument({ description: 'Clinical Summary', meta: tag('zus'), date: '2026-09-15T10:00:00Z' });
    setup();

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByText('2 of 2 documents • 1 from DrChrono')).toBeInTheDocument();

    const lab = rows()[1];
    expect(within(lab).getByText('LABCORP FINAL LABS')).toBeInTheDocument();
    expect(within(lab).getByText('From DrChrono')).toBeInTheDocument();
    expect(within(lab).getByText(/Laboratory report · Dated/)).toBeInTheDocument();
    expect(within(lab).getByText('Labs')).toBeInTheDocument();
    expect(within(lab).getByText('Results')).toBeInTheDocument();
    // Newest first by default.
    expect(within(rows()[0]).getByText('From Lyfe')).toBeInTheDocument();
  });

  test('shows the empty state and hides soft-deleted documents', async () => {
    await createDocument({ description: 'Deleted', status: 'entered-in-error' });
    setup();

    expect(await screen.findByText('No documents yet')).toBeInTheDocument();
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  describe('search, filters and sort', () => {
    beforeEach(async () => {
      await createDocument({ description: 'Beta note', meta: tag('drchrono'), category: [{ text: 'Notes' }] });
      await createDocument({ description: 'Alpha labs', meta: tag('drchrono'), category: [{ text: 'Labs' }] });
      await createDocument({ description: 'Network summary', meta: tag('zus') });
    });

    test('searches', async () => {
      setup();
      await waitFor(() => expect(rows()).toHaveLength(3));

      fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'labs' } });
      await waitFor(() => expect(rows()).toHaveLength(1));
      fireEvent.click(screen.getByRole('button', { name: 'Clear search text' }));
      await waitFor(() => expect(rows()).toHaveLength(3));
    });

    test('filters by source', async () => {
      // An untagged document was created in Lyfe; the one tagged with the Lyfe
      // Data Network's vendor name arrived over the network. The filter has two
      // chips, Lyfe and DrChrono, and Lyfe covers both of these.
      await createDocument({ description: 'Uploaded scan' });
      setup();
      await waitFor(() => expect(rows()).toHaveLength(4));

      // Nothing on the page says Zus.
      expect(screen.queryByText(/Zus/i)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Lyfe (2 documents)' }));
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(screen.getByText('Network summary')).toBeInTheDocument();
      expect(screen.getByText('Uploaded scan')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'DrChrono (2 documents)' }));
      await waitFor(() => expect(rows()).toHaveLength(2));

      fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
      await waitFor(() => expect(rows()).toHaveLength(4));
    });

    test('sorts by name', async () => {
      const user = userEvent.setup();
      setup();
      await waitFor(() => expect(rows()).toHaveLength(3));

      await user.click(screen.getByRole('button', { name: /Sort:/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Name (A–Z)' }));
      await waitFor(() => expect(within(rows()[0]).getByText('Alpha labs')).toBeInTheDocument());
    });

    test('filters by category', async () => {
      const user = userEvent.setup();
      setup();
      await waitFor(() => expect(rows()).toHaveLength(3));

      await user.click(screen.getByRole('button', { name: 'Filter by categories' }));
      await user.click(await screen.findByRole('checkbox', { name: 'Notes (1)' }));
      await waitFor(() => expect(rows()).toHaveLength(1));
      expect(screen.getByText('Beta note')).toBeInTheDocument();
    });
  });

  test('opens a document preview from the list and closes it', async () => {
    const user = userEvent.setup();
    const doc = await createDocument({ description: 'Referral letter', type: { text: 'Referral' } });
    const router = setup();

    await user.click(await screen.findByRole('button', { name: 'Preview Referral letter' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/Patient/${patientId}/DocumentReference/${doc.id}`)
    );

    const dialog = await screen.findByRole('dialog');
    // The detail panel's metadata.
    expect(within(dialog).getByText('Author')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/Patient/${patientId}/DocumentReference`));
  });

  test('opens the preview from a deep link', async () => {
    const doc = await createDocument({ description: 'Deep linked' });
    setup(`/Patient/${patientId}/DocumentReference/${doc.id}`);

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Deep linked')).toBeInTheDocument();
  });

  test('pages long lists', async () => {
    const user = userEvent.setup();
    for (let i = 0; i < DOCUMENTS_PER_PAGE + 3; i++) {
      await createDocument({
        description: `Doc ${String(i).padStart(2, '0')}`,
        date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      });
    }
    setup();

    await waitFor(() => expect(rows()).toHaveLength(DOCUMENTS_PER_PAGE));
    await user.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  test('opens the upload modal', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  test('shows an error when documents cannot be loaded', async () => {
    vi.spyOn(medplum, 'search').mockRejectedValue(new Error('Server unavailable'));
    setup();

    expect(await screen.findByText('Could not load documents')).toBeInTheDocument();
    expect(screen.getByText('Server unavailable')).toBeInTheDocument();
  });
});
