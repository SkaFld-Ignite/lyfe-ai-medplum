// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import { isMedplumHosted } from '../utils/open-attachment';

/** Why a Medplum-hosted file could not be previewed. */
export type PreviewError = 'unavailable' | 'invalid';

/**
 * Checks that a downloaded file really is the type it claims, where that can be told from its
 * first bytes. An importer that stored an error page or a source-system response as the file
 * would otherwise surface as the browser's own opaque "Failed to load PDF document".
 * @param blob - The downloaded file.
 * @param contentType - The type it is shown as.
 * @returns True unless the bytes contradict the type.
 */
async function matchesContentType(blob: Blob, contentType: string | undefined): Promise<boolean> {
  if (contentType !== 'application/pdf') {
    return true;
  }
  const head = await blob.slice(0, 1024).text();
  return head.includes('%PDF-');
}

/**
 * A URL a document preview frame can display.
 *
 * The Medplum server sends `frame-ancestors 'none'` on every response, so a file it hosts cannot
 * be shown in an iframe directly, and files it stored without a type arrive as
 * `application/octet-stream`, which the browser downloads instead of showing. Medplum-hosted files
 * are therefore downloaded and shown from a same-origin blob URL of the given type. Other URLs
 * (e.g. a DrChrono link) are returned as they are.
 * @param url - The attachment URL, or undefined when nothing should be previewed.
 * @param contentType - The type to show the file as.
 * @returns The URL to preview; `error` when the file could not be downloaded (`unavailable`, e.g. a
 *   source-system link that was never copied into Medplum) or is not the type it claims (`invalid`).
 */
export function useAttachmentPreviewUrl(
  url: string | undefined,
  contentType: string | undefined
): { previewUrl?: string; loading: boolean; error?: PreviewError } {
  const medplum = useMedplum();
  const hosted = Boolean(url) && isMedplumHosted(medplum, url as string);
  const [settled, setSettled] = useState<{ source?: string; previewUrl?: string; error?: PreviewError }>({});

  useEffect(() => {
    if (!url || !hosted) {
      return undefined;
    }
    let active = true;
    let objectUrl: string | undefined;
    medplum
      .downloadResponse(url)
      .then(async (response) => {
        // A missing Binary answers 404 with an OperationOutcome body, which must not be shown as the file.
        if (!response.ok) {
          if (active) {
            setSettled({ source: url, error: 'unavailable' });
          }
          return;
        }
        const blob = await response.blob();
        const valid = await matchesContentType(blob, contentType);
        if (!active) {
          return;
        }
        if (!valid) {
          setSettled({ source: url, error: 'invalid' });
          return;
        }
        objectUrl = URL.createObjectURL(contentType ? new Blob([blob], { type: contentType }) : blob);
        setSettled({ source: url, previewUrl: objectUrl });
      })
      .catch(() => {
        if (active) {
          setSettled({ source: url, error: 'unavailable' });
        }
      });
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [medplum, url, hosted, contentType]);

  if (!url) {
    return { loading: false };
  }
  if (!hosted) {
    return { previewUrl: url, loading: false };
  }
  return settled.source === url
    ? { previewUrl: settled.previewUrl, error: settled.error, loading: false }
    : { loading: true };
}
