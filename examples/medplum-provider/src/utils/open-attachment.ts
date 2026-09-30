// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

/** Shown when a document's file is not in Medplum, e.g. a source-system link an import never copied. */
export const FILE_NOT_COPIED_MESSAGE = "This file hasn't been copied into Lyfe yet. Re-import the patient to fetch it.";

/** How long a blob URL handed to a new tab or a download stays valid. */
const OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Whether a URL is served by this Medplum server (a `Binary/` reference or a URL under its base).
 * Only these are fetched with the client, because the client attaches the user's access token.
 * @param medplum - The Medplum client.
 * @param url - The attachment URL.
 * @returns True for Medplum-hosted files.
 */
export function isMedplumHosted(medplum: MedplumClient, url: string): boolean {
  return url.startsWith('Binary/') || url.startsWith(medplum.getBaseUrl());
}

export interface OpenAttachmentOptions {
  /** The type to give the file, e.g. when it was stored without one. */
  contentType?: string;
  /** Save the file instead of opening it in a new tab. */
  download?: boolean;
  /** File name for a download. */
  filename?: string;
}

/**
 * Opens or downloads a document's file.
 *
 * A Medplum-hosted URL cannot be handed to the browser as is: a `Binary/<id>` reference would
 * resolve against the current page (an app route that renders nothing), and the file itself needs
 * the user's access token. So it is fetched with the client and handed over as a blob URL. The new
 * tab is opened before the fetch, while the click still counts as a user gesture, so popup blockers
 * allow it. Other URLs are opened directly.
 * @param medplum - The Medplum client.
 * @param url - The attachment URL.
 * @param options - Content type, download mode and file name.
 * @returns Resolves once the file is opened; rejects with {@link FILE_NOT_COPIED_MESSAGE} when the
 *   file is not in Medplum.
 */
export async function openAttachment(
  medplum: MedplumClient,
  url: string,
  options: OpenAttachmentOptions = {}
): Promise<void> {
  if (!isMedplumHosted(medplum, url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }

  const tab = options.download ? null : window.open('', '_blank');
  try {
    const response = await medplum.downloadResponse(url);
    if (!response.ok) {
      throw new Error(FILE_NOT_COPIED_MESSAGE);
    }
    const blob = await response.blob();
    const typed = options.contentType ? new Blob([blob], { type: options.contentType }) : blob;
    const objectUrl = URL.createObjectURL(typed);
    setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_LIFETIME_MS);

    if (options.download) {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = options.filename ?? 'document';
      link.click();
    } else if (tab) {
      tab.location.href = objectUrl;
    } else {
      window.open(objectUrl, '_blank');
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}
