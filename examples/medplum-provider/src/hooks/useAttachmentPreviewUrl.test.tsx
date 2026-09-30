// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { MockClient } from '@medplum/mock';
import { MedplumProvider } from '@medplum/react';
import { renderHook, waitFor } from '@testing-library/react';
import type { JSX, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { isMedplumHosted } from '../utils/open-attachment';
import { useAttachmentPreviewUrl } from './useAttachmentPreviewUrl';

describe('useAttachmentPreviewUrl', () => {
  let medplum: MockClient;
  const createObjectURL = vi.fn(() => 'blob:preview');
  const revokeObjectURL = vi.fn();

  function wrapper({ children }: { children: ReactNode }): JSX.Element {
    return <MedplumProvider medplum={medplum}>{children}</MedplumProvider>;
  }

  beforeEach(() => {
    medplum = new MockClient();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('recognises Medplum-hosted URLs only', () => {
    expect(isMedplumHosted(medplum, 'Binary/123')).toBe(true);
    expect(isMedplumHosted(medplum, `${medplum.getBaseUrl()}storage/123/456?Signature=x`)).toBe(true);
    expect(isMedplumHosted(medplum, 'https://drchrono-uploads.s3.amazonaws.com/doc.pdf?X-Amz-Signature=1')).toBe(false);
  });

  test('shows a Medplum-hosted file from a blob of the given type, and revokes it', async () => {
    const download = vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('%PDF-1.4'));
    const url = `${medplum.getBaseUrl()}storage/abc`;
    const { result, unmount } = renderHook(() => useAttachmentPreviewUrl(url, 'application/pdf'), { wrapper });

    expect(result.current).toEqual({ loading: true });
    await waitFor(() => expect(result.current.previewUrl).toBe('blob:preview'));
    expect(download).toHaveBeenCalledWith(url);
    expect((createObjectURL.mock.calls[0] as unknown as [Blob])[0].type).toBe('application/pdf');

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  test('never downloads external URLs with the Medplum client', () => {
    const download = vi.spyOn(medplum, 'downloadResponse');
    const url = 'https://drchrono-uploads.s3.amazonaws.com/doc.pdf';
    const { result } = renderHook(() => useAttachmentPreviewUrl(url, 'application/pdf'), { wrapper });

    expect(result.current).toEqual({ previewUrl: url, loading: false });
    expect(download).not.toHaveBeenCalled();
  });

  test('reports a download that failed outright', async () => {
    vi.spyOn(medplum, 'downloadResponse').mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useAttachmentPreviewUrl('Binary/123', 'application/pdf'), { wrapper });

    await waitFor(() => expect(result.current.error).toBe('unavailable'));
  });

  test('reports a file that could not be downloaded, e.g. a source-system link never copied in', async () => {
    vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('{}', { status: 404 }));
    const { result } = renderHook(() => useAttachmentPreviewUrl('Binary/zus-123', 'application/pdf'), { wrapper });

    await waitFor(() => expect(result.current.error).toBe('unavailable'));
    expect(result.current.previewUrl).toBeUndefined();
  });

  test('reports a "PDF" whose bytes are not a PDF', async () => {
    vi.spyOn(medplum, 'downloadResponse').mockResolvedValue(new Response('{"resourceType":"OperationOutcome"}'));
    const { result } = renderHook(() => useAttachmentPreviewUrl('Binary/123', 'application/pdf'), { wrapper });

    await waitFor(() => expect(result.current.error).toBe('invalid'));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  test('does nothing without a URL', () => {
    const { result } = renderHook(() => useAttachmentPreviewUrl(undefined, undefined), { wrapper });
    expect(result.current).toEqual({ loading: false });
  });
});
