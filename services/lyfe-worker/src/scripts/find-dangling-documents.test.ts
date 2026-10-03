// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DocumentReference } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import { auditPatientDocuments, binaryIdFor, formatAudit } from './find-dangling-documents.ts';

const BASE = 'https://medplum.example.com/';

/**
 * One stored DocumentReference.
 * @param id - The resource id.
 * @param url - The attachment URL as stored.
 * @param network - The provenance tag code.
 * @returns The document.
 */
function stored(id: string, url: string | undefined, network = 'zus'): DocumentReference {
  return {
    resourceType: 'DocumentReference',
    id,
    status: 'current',
    meta: { tag: [{ system: 'https://zusapi.com/network', code: network }] },
    content: [{ attachment: url ? { url } : {} }],
  };
}

describe('binaryIdFor', () => {
  test('resolves every shape a Binary URL can take on this server', () => {
    expect(binaryIdFor(`${BASE}fhir/R4/Binary/abc`, BASE)).toBe('abc');
    expect(binaryIdFor(`${BASE}storage/abc/v1?Signature=x`, BASE)).toBe('abc');
    // The relative form is the one the broken documents carry. It names a
    // Binary on whichever server holds it, which is us.
    expect(binaryIdFor('Binary/08062535-d279-49f0-8615-738a0222d8ab', BASE)).toBe(
      '08062535-d279-49f0-8615-738a0222d8ab'
    );
  });

  test('a third-party URL names no Binary here', () => {
    expect(binaryIdFor('https://api.zusapi.com/fhir/Binary/abc', BASE)).toBeUndefined();
    expect(binaryIdFor(undefined, BASE)).toBeUndefined();
  });
});

describe('auditPatientDocuments', () => {
  test('reports the documents whose Binary does not exist, grouped by source', () => {
    const documents = [
      stored('d1', `${BASE}fhir/R4/Binary/present`, 'drchrono'),
      stored('d2', 'Binary/08062535-d279-49f0-8615-738a0222d8ab', 'commonwell'),
      stored('d3', 'Binary/359c4dcc-b294-41fd-91b9-a60d4f44e64a', 'commonwell'),
      stored('d4', 'Binary/06b20cb2-c041-406b-bad8-04aab687082d', 'carequality'),
    ];

    const audit = auditPatientDocuments({
      patientId: 'p1',
      documents,
      baseUrl: BASE,
      existingBinaryIds: new Set(['present']),
    });

    expect(audit.documents).toBe(4);
    expect(audit.broken).toBe(3);
    expect(audit.bySource).toEqual({ commonwell: 2, carequality: 1 });
    expect(audit.dangling.every((d) => d.kind === 'missing-binary')).toBe(true);
  });

  test('a chart with every file present reports nothing to fix', () => {
    const audit = auditPatientDocuments({
      patientId: 'p1',
      documents: [stored('d1', `${BASE}fhir/R4/Binary/present`)],
      baseUrl: BASE,
      existingBinaryIds: new Set(['present']),
    });

    expect(audit.broken).toBe(0);
    expect(formatAudit(audit)).toBe('Patient/p1: 1 document(s), all openable');
  });

  test('a third-party URL is reported separately from a phantom', () => {
    // Both are unopenable, but only one is a claim about a file we were
    // supposed to be holding. Collapsing them would misattribute the cause.
    const audit = auditPatientDocuments({
      patientId: 'p1',
      documents: [stored('d1', 'https://commonwell.example/doc/1'), stored('d2', undefined)],
      baseUrl: BASE,
      existingBinaryIds: new Set(),
    });

    expect(audit.dangling.map((d) => d.kind)).toEqual(['foreign-host', 'no-url']);
  });

  test('the printed report names the patient, the count and each broken document', () => {
    const audit = auditPatientDocuments({
      patientId: '45c07b01-2752-4535-bbe0-7fd642a12b62',
      documents: [stored('d1', 'Binary/missing', 'commonwell'), stored('d2', `${BASE}fhir/R4/Binary/present`)],
      baseUrl: BASE,
      existingBinaryIds: new Set(['present']),
    });

    const text = formatAudit(audit);
    expect(text).toContain('Patient/45c07b01-2752-4535-bbe0-7fd642a12b62: 1 of 2 document(s) cannot be opened');
    expect(text).toContain('1  commonwell');
    expect(text).toContain('missing-binary  DocumentReference/d1 [0]  Binary/missing');
  });
});
