// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import type { WithId } from '@medplum/core';
import { formatDate } from '@medplum/core';
import type { Attachment, DocumentReference } from '@medplum/fhirtypes';
import { HomerSimpson, MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DocumentDetailPanel } from './DocumentDetailPanel';

const PDF_URL = 'http://example.com/binary/summary.pdf';
const PNG_URL = 'http://example.com/binary/scan.png';
const MP4_URL = 'http://example.com/binary/exam.mp4';

function createDocument(overrides: Partial<DocumentReference> = {}): WithId<DocumentReference> {
  return {
    resourceType: 'DocumentReference',
    id: 'doc-1',
    status: 'current',
    subject: { reference: `Patient/${HomerSimpson.id}` },
    content: [{ attachment: { contentType: 'application/pdf', url: PDF_URL, title: 'summary.pdf' } }],
    ...overrides,
  };
}

function withAttachment(
  attachment: Attachment | undefined,
  overrides: Partial<DocumentReference> = {}
): WithId<DocumentReference> {
  return createDocument({ content: attachment ? [{ attachment }] : [], ...overrides });
}

describe('DocumentDetailPanel', () => {
  let medplum: MockClient;
  const onDocumentChange = vi.fn();
  const onDocumentDeleted = vi.fn();

  beforeEach(() => {
    medplum = new MockClient();
    vi.clearAllMocks();
  });

  // The header actions are icon-only buttons whose label lives in a Mantine Tooltip, which is not
  // an accessible name — so they are addressed by their Tabler icon.
  function iconButton(icon: 'edit-circle' | 'browser-share' | 'printer'): HTMLElement {
    const button = document.querySelector(`.tabler-icon-${icon}`)?.closest('button');
    if (!button) {
      throw new Error(`Expected a ${icon} button`);
    }
    return button;
  }

  function setup(item: WithId<DocumentReference> = createDocument()): ReturnType<typeof render> {
    return render(
      <MemoryRouter>
        <MedplumProvider medplum={medplum}>
          <MantineProvider>
            <Notifications />
            <DocumentDetailPanel
              item={item}
              patientRef={{ reference: `Patient/${HomerSimpson.id}` }}
              onDocumentChange={onDocumentChange}
              onDocumentDeleted={onDocumentDeleted}
            />
          </MantineProvider>
        </MedplumProvider>
      </MemoryRouter>
    );
  }

  describe('Header', () => {
    test('Names the document by its description', () => {
      setup(createDocument({ description: 'Discharge summary' }));

      expect(screen.getByText('Discharge summary')).toBeInTheDocument();
    });

    test('Falls back to "Untitled Document" when the resource has no display name', () => {
      setup();

      expect(screen.getByText('Untitled Document')).toBeInTheDocument();
    });

    test('Opens the attachment in a new browser tab', () => {
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      setup();

      fireEvent.click(iconButton('browser-share'));

      expect(openSpy).toHaveBeenCalledWith(PDF_URL, '_blank', 'noopener,noreferrer');
    });

    // A bare `Binary/<id>` used to be handed to window.open, which resolved it against the app route
    // and opened a blank page.
    test('Opens a Medplum-hosted file through the client as a blob', async () => {
      const tab = { location: { href: '' }, close: vi.fn() };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('%PDF-1.7'));
      const createObjectURL = vi.fn(() => 'blob:file');
      vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
      setup(withAttachment({ contentType: 'image/png', url: 'Binary/stored' }));

      fireEvent.click(iconButton('browser-share'));

      expect(openSpy).toHaveBeenCalledWith('', '_blank');
      await waitFor(() => expect(tab.location.href).toBe('blob:file'));
    });

    test('Explains, instead of opening a blank page, when the file is not in Medplum', async () => {
      const tab = { location: { href: '' }, close: vi.fn() };
      vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('{}', { status: 404 }));
      setup(withAttachment({ contentType: 'image/png', url: 'Binary/zus-only' }));

      fireEvent.click(iconButton('browser-share'));

      expect(
        await screen.findByText("This file hasn't been copied into Lyfe yet. Re-import the patient to fetch it.")
      ).toBeInTheDocument();
      expect(tab.close).toHaveBeenCalled();
    });

    test('Hides the open-in-browser action when the attachment has no url', () => {
      setup(withAttachment({ contentType: 'application/pdf' }));

      expect(document.querySelector('.tabler-icon-browser-share')).not.toBeInTheDocument();
      // Edit and fax remain available even without a downloadable attachment.
      expect(iconButton('edit-circle')).toBeInTheDocument();
      expect(iconButton('printer')).toBeInTheDocument();
    });

    test('Opens the edit details modal', async () => {
      setup();

      expect(screen.queryByText('Edit Document Details')).not.toBeInTheDocument();
      fireEvent.click(iconButton('edit-circle'));

      expect(await screen.findByText('Edit Document Details')).toBeInTheDocument();
    });

    test('Opens the send fax modal seeded with the attachment', async () => {
      setup();

      expect(screen.queryByRole('button', { name: 'Send Fax' })).not.toBeInTheDocument();
      fireEvent.click(iconButton('printer'));

      expect(await screen.findByRole('button', { name: 'Send Fax' })).toBeInTheDocument();
      // The attachment comes from the document, so the modal skips its own file picker.
      expect(screen.queryByText('Drag a file here or click to browse')).not.toBeInTheDocument();
    });
  });

  describe('Preview', () => {
    test('Renders a PDF in an iframe with the pdf viewer panes hidden', () => {
      setup();

      const iframe = screen.getByTitle('Attachment');
      expect(iframe).toHaveAttribute('src', `${PDF_URL}#navpanes=0`);
    });

    test.each(['application/json', 'text/plain'])('Renders %s in the pdf-style iframe', (contentType) => {
      setup(withAttachment({ contentType, url: PDF_URL }));

      expect(screen.getByTitle('Attachment')).toBeInTheDocument();
    });

    test('Renders an image preview titled by the attachment', () => {
      setup(withAttachment({ contentType: 'image/png', url: PNG_URL, title: 'scan.png' }));

      const img = screen.getByAltText('scan.png');
      expect(img).toHaveAttribute('src', PNG_URL);
      expect(screen.queryByTitle('Attachment')).not.toBeInTheDocument();
    });

    test('Falls back to a generic image alt text', () => {
      setup(withAttachment({ contentType: 'image/png', url: PNG_URL }));

      expect(screen.getByAltText('Attachment')).toBeInTheDocument();
    });

    test('Renders a video preview', () => {
      const { container } = setup(withAttachment({ contentType: 'video/mp4', url: MP4_URL }));

      const source = container.querySelector('video source');
      expect(source).toHaveAttribute('src', MP4_URL);
      expect(source).toHaveAttribute('type', 'video/mp4');
    });

    test('Reports no preview when the document has no attachment', () => {
      setup(withAttachment(undefined));

      expect(screen.getByText('No preview available for this document')).toBeInTheDocument();
    });

    test('Reports no preview when the attachment has no url', () => {
      setup(withAttachment({ contentType: 'image/png' }));

      expect(screen.getByText('No preview available for this document')).toBeInTheDocument();
    });

    test('Reports an unsupported file type for a non-previewable attachment', () => {
      setup(withAttachment({ contentType: 'application/zip', url: 'http://example.com/binary/archive.zip' }));

      expect(screen.getByText('No preview available for this file type')).toBeInTheDocument();
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      fireEvent.click(screen.getByRole('button', { name: /Open file/ }));
      expect(openSpy).toHaveBeenCalledWith('http://example.com/binary/archive.zip', '_blank', 'noopener,noreferrer');
    });

    test('Explains a Medplum-hosted PDF that is not really a PDF', async () => {
      vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('<html>Access denied</html>'));
      setup(withAttachment({ contentType: 'application/pdf', url: 'Binary/bad' }));

      expect(
        await screen.findByText("This file is damaged or isn't a real PDF, so it can't be previewed.")
      ).toBeInTheDocument();
      expect(screen.queryByTitle('Attachment')).not.toBeInTheDocument();
    });

    test('Explains a file that was never copied into Medplum', async () => {
      vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('{}', { status: 404 }));
      setup(withAttachment({ contentType: 'application/pdf', url: 'Binary/zus-only' }));

      expect(
        await screen.findByText("This file hasn't been copied into Lyfe yet. Re-import the patient to fetch it.")
      ).toBeInTheDocument();
    });

    // Documents imported before the importer typed its files carry only a link and a name.
    test('Previews an untyped PDF named by its document description', () => {
      const url = 'http://example.com/binary/abc123';
      setup(withAttachment({ url, title: 'Document' }, { description: '08172026 LABCORP RESULTS .pdf' }));

      expect(screen.getByTitle('Attachment')).toHaveAttribute('src', `${url}#navpanes=0`);
      // The metadata still reports what is stored, not the guess.
      expect(screen.queryByText('Content type')).not.toBeInTheDocument();
    });

    test('Previews an untyped image named by its attachment title', () => {
      setup(withAttachment({ url: 'http://example.com/binary/xyz', title: 'wound photo.JPG' }));

      expect(screen.getByRole('img', { name: 'wound photo.JPG' })).toHaveAttribute(
        'src',
        'http://example.com/binary/xyz'
      );
    });

    test('Offers to open a file whose type cannot be determined', () => {
      setup(withAttachment({ url: 'http://example.com/binary/unknown', title: 'MONARCH ELIGIBILITY' }));

      expect(screen.getByText("This file type can't be previewed here")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Open file/ })).toBeInTheDocument();
    });
  });

  describe('Metadata', () => {
    test('Renders type, category, content type, and author', () => {
      setup(
        createDocument({
          type: { coding: [{ display: 'Discharge summary' }] },
          category: [{ coding: [{ display: 'Clinical Note' }] }, { text: 'Referral' }],
          author: [{ reference: 'Practitioner/dr-nick', display: 'Dr. Nick Riviera' }],
        })
      );

      expect(screen.getByText('Type')).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Clinical Note, Referral')).toBeInTheDocument();
      expect(screen.getByText('Content type')).toBeInTheDocument();
      expect(screen.getByText('application/pdf')).toBeInTheDocument();
      expect(screen.getByText('Dr. Nick Riviera')).toBeInTheDocument();
    });

    test('Omits type, category, and content type rows when they are absent', () => {
      setup(withAttachment({ url: PDF_URL }));

      expect(screen.queryByText('Type')).not.toBeInTheDocument();
      expect(screen.queryByText('Category')).not.toBeInTheDocument();
      expect(screen.queryByText('Content type')).not.toBeInTheDocument();
    });

    test('Falls back to the author reference when it has no display', () => {
      setup(createDocument({ author: [{ reference: 'Practitioner/dr-nick' }] }));

      expect(screen.getByText('Practitioner/dr-nick')).toBeInTheDocument();
    });

    test('Notes when no author is attributed', () => {
      setup();

      expect(screen.getByText('No author attributed')).toBeInTheDocument();
    });

    test('Attributes the last update to the audit author', () => {
      setup(
        createDocument({
          date: '2026-03-01T10:00:00Z',
          meta: {
            lastUpdated: '2026-03-04T15:30:00Z',
            author: { reference: 'Practitioner/dr-hibbert', display: 'Dr. Hibbert' },
          },
        })
      );

      expect(screen.getByText('Added')).toBeInTheDocument();
      expect(screen.getByText(formatDate('2026-03-01T10:00:00Z'))).toBeInTheDocument();
      expect(screen.getByText('Last updated')).toBeInTheDocument();
      expect(screen.getByText('by Dr. Hibbert')).toBeInTheDocument();
    });

    test('Dates the document from meta.lastUpdated when it has no date', () => {
      setup(createDocument({ meta: { lastUpdated: '2026-03-04T15:30:00Z' } }));

      // Both "Added" and "Last updated" fall back to the same timestamp.
      expect(screen.getAllByText(formatDate('2026-03-04T15:30:00Z'))).toHaveLength(2);
    });

    test('Omits the date rows when the document has no timestamps', () => {
      setup();

      expect(screen.queryByText('Added')).not.toBeInTheDocument();
      expect(screen.queryByText('Last updated')).not.toBeInTheDocument();
    });
  });
});
