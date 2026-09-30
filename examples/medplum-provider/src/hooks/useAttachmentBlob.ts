// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useMedplum } from '@medplum/react';
import { useEffect, useState } from 'react';
import { isMedplumHosted } from '../utils/open-attachment';

/**
 * A document's file, downloaded into memory.
 *
 * The Word, Excel and TIFF previews decode bytes in the page, so unlike the
 * framed previews they need the file itself rather than a URL. A Medplum-hosted
 * file needs the user's access token, which only the client attaches, so it is
 * fetched through the client rather than by the decoder.
 * @param url - The attachment URL, or undefined when nothing should load.
 * @returns The file, plus loading and error state.
 */
export function useAttachmentBlob(url: string | undefined): {
  blob?: Blob;
  loading: boolean;
  error?: boolean;
} {
  const medplum = useMedplum();
  const [settled, setSettled] = useState<{ source?: string; blob?: Blob; error?: boolean }>({});

  useEffect(() => {
    if (!url) {
      return undefined;
    }
    let active = true;
    const load = async (): Promise<Blob> => {
      // A file on another host cannot be read with the client's token, and a
      // cross-origin fetch would be blocked anyway.
      if (!isMedplumHosted(medplum, url)) {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`fetch failed: ${response.status}`);
        }
        return response.blob();
      }
      const response = await medplum.downloadResponse(url);
      if (!response.ok) {
        throw new Error(`download failed: ${response.status}`);
      }
      return response.blob();
    };

    load()
      .then((blob) => {
        if (active) {
          setSettled({ source: url, blob });
        }
        return blob;
      })
      .catch(() => {
        if (active) {
          setSettled({ source: url, error: true });
        }
      });

    return () => {
      active = false;
    };
  }, [medplum, url]);

  if (!url) {
    return { loading: false };
  }
  return settled.source === url ? { blob: settled.blob, error: settled.error, loading: false } : { loading: true };
}
