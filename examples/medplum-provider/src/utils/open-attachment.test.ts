// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MockClient } from '@medplum/mock';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FILE_NOT_COPIED_MESSAGE, isMedplumHosted, openAttachment } from './open-attachment';

describe('openAttachment', () => {
  let medplum: MockClient;
  const createObjectURL = vi.fn(() => 'blob:file');

  beforeEach(() => {
    medplum = new MockClient();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    createObjectURL.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('recognises Medplum-hosted URLs', () => {
    expect(isMedplumHosted(medplum, 'Binary/1')).toBe(true);
    expect(isMedplumHosted(medplum, `${medplum.getBaseUrl()}storage/1`)).toBe(true);
    expect(isMedplumHosted(medplum, 'https://s3.example.org/f.pdf')).toBe(false);
  });

  test('opens external URLs directly, without the client', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const download = vi.spyOn(medplum, 'downloadResponse');
    await openAttachment(medplum, 'https://s3.example.org/f.pdf');
    expect(open).toHaveBeenCalledWith('https://s3.example.org/f.pdf', '_blank', 'noopener,noreferrer');
    expect(download).not.toHaveBeenCalled();
  });

  test('downloads a Medplum file with its type and a file name', async () => {
    vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('%PDF-1.7'));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await openAttachment(medplum, 'Binary/1', { download: true, contentType: 'application/pdf', filename: 'labs.pdf' });

    expect((createObjectURL.mock.calls[0] as unknown as [Blob])[0].type).toBe('application/pdf');
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe('labs.pdf');
    expect(link.href).toBe('blob:file');
  });

  test('rejects with a clear message when the file is not in Medplum', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('{}', { status: 404 }));

    await expect(openAttachment(medplum, 'Binary/missing')).rejects.toThrow(FILE_NOT_COPIED_MESSAGE);
    expect(tab.close).toHaveBeenCalled();
  });
});
