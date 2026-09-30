// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Attachment } from '@medplum/fhirtypes';
import { withMedplum429Retry } from './batch.ts';
import { fileNameFor, resolveContentType } from './file-type.ts';

/**
 * Copying source-system files into Medplum.
 *
 * Both importers bring over documents whose file lives on the source system:
 * DrChrono's behind short-lived presigned S3 links, Zus's behind its own
 * authenticated FHIR Binary endpoint. The browser can reach neither, so a
 * DocumentReference that keeps the source link can be listed but never opened.
 * Each file is therefore downloaded by the bot, typed from its bytes, and
 * stored as a Medplum Binary the app can preview.
 */

/**
 * Run an async mapper over a list with a bounded number of in-flight calls.
 *
 * Unbounded `Promise.all` over a few hundred multi-megabyte files exhausts
 * sockets and memory; fully sequential is too slow for the bot's timeout.
 * @param items - What to process.
 * @param limit - Maximum concurrent calls.
 * @param worker - Applied to each item.
 * @returns Results, index-aligned to `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor++;
      out[index] = await worker(items[index]);
    }
  };

  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, () => runner()));
  return out;
}

/**
 * The `Binary/<id>` reference for an attachment URL that already points at this
 * Medplum server, in any of the forms the server hands out (reference, FHIR
 * URL, or presigned storage URL).
 * @param url - The attachment URL.
 * @param baseUrl - The Medplum base URL, ending in a slash.
 * @returns The Binary reference, or undefined for URLs on other hosts.
 */
export function storedBinaryReference(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) {
    return undefined;
  }
  let rest: string | undefined;
  if (url.startsWith(`${baseUrl}fhir/R4/Binary/`)) {
    rest = url.slice(`${baseUrl}fhir/R4/Binary/`.length);
  } else if (url.startsWith(`${baseUrl}storage/`)) {
    rest = url.slice(`${baseUrl}storage/`.length);
  }
  const id = rest?.split(/[/?#]/)[0];
  return id ? `Binary/${id}` : undefined;
}

/**
 * Store downloaded bytes as a Medplum Binary.
 * @param medplum - Bot-scoped Medplum client.
 * @param data - The file contents.
 * @param headerType - The source response's `Content-Type`, if any.
 * @param names - File names, titles or URLs that may reveal the type, most trustworthy first.
 * @param fileBase - Storage file name without extension.
 * @returns The attachment fields that point at the stored file.
 */
export async function storeFile(
  medplum: MedplumClient,
  data: Uint8Array,
  headerType: string | null | undefined,
  names: (string | undefined)[],
  fileBase: string
): Promise<Pick<Attachment, 'contentType' | 'url' | 'size'>> {
  const contentType = resolveContentType(data, headerType, names);
  const binary = await withMedplum429Retry(
    () => medplum.createBinary({ data, filename: fileNameFor(fileBase, contentType), contentType }),
    `createBinary(${fileBase})`
  );
  return { contentType, url: binary.url, size: data.byteLength };
}
