// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import { describe, expect, test, vi } from 'vitest';
import { mapWithConcurrency, storeFile, storedBinaryReference } from './files';

const BASE = 'https://medplum.example.com/';

describe('storedBinaryReference', () => {
  test('recognises FHIR and presigned storage URLs on this server', () => {
    expect(storedBinaryReference(`${BASE}fhir/R4/Binary/abc`, BASE)).toBe('Binary/abc');
    expect(storedBinaryReference(`${BASE}storage/abc/v1?Signature=x`, BASE)).toBe('Binary/abc');
  });

  test('ignores other hosts and relative references, which may name a source-system Binary', () => {
    expect(storedBinaryReference('https://api.zusapi.com/fhir/Binary/abc', BASE)).toBeUndefined();
    expect(storedBinaryReference('Binary/abc', BASE)).toBeUndefined();
    expect(storedBinaryReference(undefined, BASE)).toBeUndefined();
  });
});

describe('mapWithConcurrency', () => {
  test('keeps results aligned and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});

describe('storeFile', () => {
  test('stores the bytes with the sniffed type and a matching file name', async () => {
    const createBinary = vi.fn().mockResolvedValue({ url: `${BASE}fhir/R4/Binary/new` });
    const medplum = { createBinary } as unknown as MedplumClient;
    const data = new TextEncoder().encode('%PDF-1.7 body');

    const stored = await storeFile(medplum, data, 'application/octet-stream', ['Untitled'], 'zus-document-1');

    expect(stored).toEqual({ contentType: 'application/pdf', url: `${BASE}fhir/R4/Binary/new`, size: data.byteLength });
    expect(createBinary).toHaveBeenCalledWith({ data, filename: 'zus-document-1.pdf', contentType: 'application/pdf' });
  });
});
