// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Attachment } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import { isMedplumHosted } from '../utils/open-attachment';

/** Why a text attachment could not be read. */
export type AttachmentTextError = 'unavailable' | 'unreachable';

function decodeBase64(data: string): string {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads a text attachment (e.g. a C-CDA XML document) for display.
 *
 * Inline `data` is decoded directly. A Medplum-hosted file is downloaded with the client. Any other
 * URL is fetched without credentials, which works only if that host allows it.
 * @param attachment - The attachment.
 * @param url - The URL to read, e.g. a presigned URL for the attachment; defaults to `attachment.url`.
 * @returns The text, whether it is loading, and why it could not be read: `unavailable` when the file
 *   is not in Medplum, `unreachable` when an external host refused.
 */
export function useAttachmentText(
  attachment: Attachment | undefined,
  url: string | undefined
): { text?: string; loading: boolean; error?: AttachmentTextError } {
  const medplum = useMedplum();
  const inline = attachment?.data;
  const source = inline ? undefined : (url ?? attachment?.url);
  const [settled, setSettled] = useState<{ source?: string; text?: string; error?: AttachmentTextError }>({});

  useEffect(() => {
    if (!source) {
      return undefined;
    }
    let active = true;
    const hosted = isMedplumHosted(medplum, source);
    const request = hosted ? medplum.downloadResponse(source) : fetch(source, { credentials: 'omit' });
    request
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const text = await response.text();
        if (active) {
          setSettled({ source, text });
        }
      })
      .catch(() => {
        if (active) {
          setSettled({ source, error: hosted ? 'unavailable' : 'unreachable' });
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, source]);

  if (inline) {
    try {
      return { text: decodeBase64(inline), loading: false };
    } catch {
      return { loading: false, error: 'unavailable' };
    }
  }
  if (!source) {
    return { loading: false, error: 'unavailable' };
  }
  return settled.source === source ? { text: settled.text, error: settled.error, loading: false } : { loading: true };
}
