// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DocumentReference, Resource } from '@medplum/fhirtypes';
import { describe, expect, test } from 'vitest';
import {
  describeNetworks,
  describeRunOutcome,
  describeWithheldDocuments,
  partitionBackedDocuments,
  sourceNetworkLabel,
} from './document-files';

const BASE = 'https://medplum.example.com/';
const LYFE_TAG = { system: 'https://lyfe.com/source', code: 'zus' };
const COMMONWELL = { system: 'https://zusapi.com/network', code: 'commonwell' };
const CAREQUALITY = { system: 'https://zusapi.com/network', code: 'carequality' };
const REPOSITORY = { system: 'https://zusapi.com/repository-id', code: 'urn:oid:2.16.840.1.113883.3.688884.100' };

/**
 * Build one prepared write entry, in the shape the importer hands to the
 * partition: the resource as it will be written, plus its Zus id.
 * @param props - What the document should look like.
 * @param props.zusId - The Zus resource id.
 * @param props.url - The attachment URL as it stands after the copy pass.
 * @param props.tags - Provenance tags, as Zus stamped them.
 * @returns The entry.
 */
function doc(props: { zusId: string; url?: string; tags?: { system: string; code: string }[] }): {
  resource: Resource;
  value: string;
} {
  const resource: DocumentReference = {
    resourceType: 'DocumentReference',
    status: 'current',
    content: [{ attachment: { contentType: 'application/pdf', ...(props.url ? { url: props.url } : {}) } }],
    meta: { tag: [LYFE_TAG, ...(props.tags ?? [])] },
  };
  return { resource: resource, value: props.zusId };
}

describe('partitionBackedDocuments', () => {
  test('a document whose file was stored is written', () => {
    const entries = [doc({ zusId: 'a', url: `${BASE}fhir/R4/Binary/stored-a` })];

    const { writable, report } = partitionBackedDocuments({ entries, baseUrl: BASE });

    expect(writable.map((e) => e.value)).toEqual(['a']);
    expect(report.withheld).toEqual([]);
  });

  test('a document still pointing at Zus is NOT written — this is the phantom', () => {
    // Exactly the shape found on Yolanda Sanchez: Zus hands the attachment
    // over as a relative `Binary/<zus-uuid>`, the download failed, and the URL
    // was left alone. Stored on our server that reference resolves here, where
    // the id does not exist, so the chart offers a document that 404s.
    const entries = [
      doc({ zusId: 'good', url: `${BASE}fhir/R4/Binary/stored` }),
      doc({ zusId: 'phantom', url: 'Binary/08062535-d279-49f0-8615-738a0222d8ab', tags: [COMMONWELL] }),
    ];

    const { writable, report } = partitionBackedDocuments({
      entries,
      baseUrl: BASE,
      reasons: new Map([['phantom', 'Zus returned HTTP 404 for the file']]),
    });

    expect(writable.map((e) => e.value)).toEqual(['good']);
    expect(report.withheld).toEqual([
      { zusId: 'phantom', network: 'commonwell', reason: 'Zus returned HTTP 404 for the file' },
    ]);
  });

  test('a presigned storage URL from this server counts as stored', () => {
    const entries = [doc({ zusId: 'a', url: `${BASE}storage/stored-a/v1?Signature=x` })];

    expect(partitionBackedDocuments({ entries, baseUrl: BASE }).writable).toHaveLength(1);
  });

  test('a URL on a third-party host is withheld — the browser cannot open it either', () => {
    const entries = [doc({ zusId: 'a', url: 'https://api.zusapi.com/fhir/Binary/abc' })];

    const { writable, report } = partitionBackedDocuments({ entries, baseUrl: BASE });

    expect(writable).toEqual([]);
    expect(report.withheld[0].reason).toBe('no file stored in Medplum');
  });

  test('a document that claims no file at all is left alone', () => {
    // Not a phantom: it offers nothing, so there is nothing to fail to open.
    const entries = [doc({ zusId: 'a' })];

    expect(partitionBackedDocuments({ entries, baseUrl: BASE }).writable).toHaveLength(1);
  });

  test('inline bytes with no URL are kept — the document opens without reaching for anything', () => {
    // Zus sends C-CDA XML inline. If the copy into a Binary failed but the
    // content is still in hand, withholding would discard a document that
    // works.
    const entry = doc({ zusId: 'a' });
    (entry.resource as DocumentReference).content = [{ attachment: { contentType: 'text/xml', data: 'PHhtbC8+' } }];

    expect(partitionBackedDocuments({ entries: [entry], baseUrl: BASE }).writable).toHaveLength(1);
  });

  test('a wrong URL withholds the document even with data beside it — the viewer follows the URL', () => {
    const entry = doc({ zusId: 'a' });
    (entry.resource as DocumentReference).content = [{ attachment: { url: 'Binary/zus-only', data: 'PHhtbC8+' } }];

    expect(partitionBackedDocuments({ entries: [entry], baseUrl: BASE }).writable).toEqual([]);
  });

  test('one unbacked attachment withholds the whole document', () => {
    const entry = doc({ zusId: 'a', url: `${BASE}fhir/R4/Binary/stored` });
    (entry.resource as DocumentReference).content?.push({ attachment: { url: 'Binary/zus-only' } });

    expect(partitionBackedDocuments({ entries: [entry], baseUrl: BASE }).writable).toEqual([]);
  });

  test('separates a network that lost everything from one that delivered', () => {
    const entries = [
      doc({ zusId: 'c1', url: 'Binary/zus-1', tags: [COMMONWELL] }),
      doc({ zusId: 'c2', url: 'Binary/zus-2', tags: [COMMONWELL] }),
      doc({ zusId: 'q1', url: `${BASE}fhir/R4/Binary/ok-1`, tags: [CAREQUALITY, REPOSITORY] }),
      doc({ zusId: 'q2', url: `${BASE}fhir/R4/Binary/ok-2`, tags: [CAREQUALITY, REPOSITORY] }),
      doc({ zusId: 'q3', url: 'Binary/zus-3', tags: [CAREQUALITY, REPOSITORY] }),
    ];

    const { report } = partitionBackedDocuments({ entries, baseUrl: BASE });

    expect(report.networks).toEqual([
      { label: 'commonwell', offered: 2, stored: 0, status: 'unavailable' },
      {
        label: 'carequality / urn:oid:2.16.840.1.113883.3.688884.100',
        offered: 3,
        stored: 2,
        status: 'partial',
      },
    ]);
  });

  test('a network that delivered everything reads as complete', () => {
    const entries = [doc({ zusId: 'a', url: `${BASE}fhir/R4/Binary/ok`, tags: [CAREQUALITY] })];

    expect(partitionBackedDocuments({ entries, baseUrl: BASE }).report.networks).toEqual([
      { label: 'carequality', offered: 1, stored: 1, status: 'complete' },
    ]);
  });
});

describe('sourceNetworkLabel', () => {
  test('reads provenance off meta.tag and drops our own source tag', () => {
    const resource = { resourceType: 'DocumentReference', meta: { tag: [LYFE_TAG, COMMONWELL] } } as Resource;

    expect(sourceNetworkLabel(resource)).toBe('commonwell');
  });

  test('keeps repository granularity, because the failure is per repository', () => {
    const resource = {
      resourceType: 'DocumentReference',
      meta: { tag: [LYFE_TAG, CAREQUALITY, REPOSITORY] },
    } as Resource;

    expect(sourceNetworkLabel(resource)).toBe('carequality / urn:oid:2.16.840.1.113883.3.688884.100');
  });

  test('an untagged resource is named rather than silently grouped with a real network', () => {
    expect(sourceNetworkLabel({ resourceType: 'DocumentReference', meta: { tag: [LYFE_TAG] } } as Resource)).toBe(
      'unknown source'
    );
  });
});

describe('describeWithheldDocuments', () => {
  test('says nothing when nothing was withheld', () => {
    expect(describeWithheldDocuments({ withheld: [], networks: [] })).toBeUndefined();
  });

  test('names the count, the network and the HTTP status', () => {
    const sentence = describeWithheldDocuments({
      withheld: [
        { zusId: 'a', network: 'commonwell', reason: 'Zus returned HTTP 404 for the file' },
        { zusId: 'b', network: 'commonwell', reason: 'Zus returned HTTP 404 for the file' },
        { zusId: 'c', network: 'carequality / urn:oid:…1056', reason: 'Zus returned HTTP 404 for the file' },
      ],
      networks: [],
    }) as string;

    expect(sentence).toContain('3 document(s) not written');
    expect(sentence).toContain('commonwell 2 (Zus returned HTTP 404 for the file)');
    expect(sentence).toContain('carequality / urn:oid:…1056 1');
    expect(sentence).toContain('next sync retries');
  });
});

describe('describeNetworks', () => {
  test('says nothing when every network delivered in full', () => {
    expect(
      describeNetworks({
        withheld: [],
        networks: [{ label: 'carequality', offered: 5, stored: 5, status: 'complete' }],
      })
    ).toBeUndefined();
  });

  test('a network that delivered nothing is distinguishable from one that delivered', () => {
    const sentence = describeNetworks({
      withheld: [],
      networks: [
        { label: 'commonwell', offered: 18, stored: 0, status: 'unavailable' },
        { label: 'carequality', offered: 55, stored: 55, status: 'complete' },
      ],
    }) as string;

    expect(sentence).toBe('commonwell: 0 of 18 file(s) retrieved; carequality: all 55 file(s) retrieved');
  });
});

describe('describeRunOutcome', () => {
  test('a clean run is complete', () => {
    expect(describeRunOutcome({ status: 'completed', incomplete: {} })).toBe('complete');
  });

  test('a failed run is failed, whatever else it holds', () => {
    expect(describeRunOutcome({ status: 'failed', incomplete: { DocumentReference: 'boom' } })).toBe('failed');
  });

  test('a run that lost a network reads as partial, not complete', () => {
    // This is the whole point of the ported behaviour: the run finished, the
    // chart was written, and a known gap must not be reported as a clean sync.
    const text = describeRunOutcome({
      status: 'completed',
      incomplete: { 'documents-unavailable': '19 document(s) not written…' },
      report: {
        withheld: Array.from({ length: 19 }, (_, i) => ({ zusId: `z${i}`, network: 'commonwell', reason: 'HTTP 404' })),
        networks: [
          { label: 'commonwell', offered: 18, stored: 0, status: 'unavailable' },
          { label: 'carequality', offered: 56, stored: 55, status: 'partial' },
          { label: 'drchrono', offered: 56, stored: 56, status: 'complete' },
        ],
      },
    });

    expect(text).toBe('partial — 19 document(s) not retrievable from 2 source(s)');
    expect(text).not.toBe('complete');
  });

  test('a gap that is not about documents still reads as partial', () => {
    expect(describeRunOutcome({ status: 'completed', incomplete: { enrolment: 'pending' } })).toBe(
      'partial — 1 gap(s): enrolment'
    );
  });
});
