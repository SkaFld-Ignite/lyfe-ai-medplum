// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';
import type { Binary, DocumentReference } from '@medplum/fhirtypes';
import { storedBinaryReference } from '../../../../examples/medplum-provider/bots/shared/files.ts';
import { getMedplum } from '../medplum.ts';

/**
 * Find the documents the charts already claim and cannot produce.
 *
 * The importer fix stops new phantoms being created. It does nothing about the
 * ones already written, and there is no way to know how many there are without
 * looking: a `DocumentReference` whose `content[].attachment.url` points at a
 * `Binary` that was never created is indistinguishable from a working one
 * until something tries to open it. On the patient this was found on, 19 of
 * 175 were phantoms.
 *
 * **This script is read-only and must stay that way.** It issues `GET`
 * searches and nothing else — no `createResource`, no `updateResource`, no
 * `deleteResource`, not even a `Binary` content fetch. Deleting a dangling
 * `DocumentReference` would destroy the only surviving record that the
 * document exists upstream, which is a decision for a person holding the
 * output of this script, not for the script.
 *
 * Checking is cheap because it never downloads anything. Every attachment URL
 * is reduced to a `Binary` id, and the whole batch is resolved with one
 * `Binary?_id=a,b,c&_elements=id` search per hundred ids — which returns the
 * ids that exist and says nothing about the ones that do not. What is missing
 * from the response is the answer.
 *
 * Usage, from the repository root:
 *
 * ```
 *   npx tsx --env-file services/lyfe-worker/.env \
 *     services/lyfe-worker/src/scripts/find-dangling-documents.ts --patient <id> [--patient <id>…]
 *
 *   # or sweep every patient that has imported documents:
 *   npx tsx --env-file services/lyfe-worker/.env \
 *     services/lyfe-worker/src/scripts/find-dangling-documents.ts --all [--limit 200]
 *
 *   # machine-readable, for piping into a spreadsheet or an issue:
 *   … --all --json
 * ```
 *
 * `--all` is a wide read against whatever server `MEDPLUM_BASE_URL` names. It
 * reads a lot and writes nothing, but point it at a non-production server
 * first and satisfy yourself that it is doing what this comment says before
 * running it anywhere real.
 */

/** One attachment whose bytes are not on this server. */
export interface DanglingAttachment {
  /** The DocumentReference id. */
  readonly documentId: string;
  /** Index within `DocumentReference.content`. */
  readonly index: number;
  /** The URL as stored. */
  readonly url?: string;
  /**
   * `missing-binary` — names a Binary on this server that does not exist. This
   * is the phantom: the chart offers the document and the open 404s.
   * `foreign-host` — points at a host the browser cannot authenticate to, so it
   * will not open either, but at least it is honest about living elsewhere.
   * `no-url` — claims a file with inline data only, or nothing at all.
   */
  readonly kind: 'missing-binary' | 'foreign-host' | 'no-url';
  /** The provenance tags on the document, which say which network it came from. */
  readonly source: string;
}

/** What one patient's documents look like. */
export interface PatientDocumentAudit {
  readonly patientId: string;
  /** DocumentReferences the chart holds. */
  readonly documents: number;
  /** Documents with at least one dangling attachment. */
  readonly broken: number;
  /** Broken counts by source network / repository. */
  readonly bySource: Record<string, number>;
  /** Every dangling attachment, for the detail listing. */
  readonly dangling: readonly DanglingAttachment[];
}

/**
 * The `Binary` id an attachment URL names on this server.
 *
 * Accepts the absolute FHIR URL, the presigned storage URL and the bare
 * relative `Binary/<id>` reference. The relative form is the one that matters
 * most here: it is what the broken documents carry, because Zus hands its own
 * ids over in that shape and the importer stored them verbatim. A relative
 * reference has no host, so it resolves against whichever server holds the
 * resource — which is why a Zus id stored on our server reads as a claim about
 * a Medplum Binary.
 * @param url - The attachment URL.
 * @param baseUrl - This Medplum server's base URL, ending in a slash.
 * @returns The Binary id, or undefined when the URL names no Binary here.
 */
export function binaryIdFor(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) {
    return undefined;
  }
  if (url.startsWith('Binary/')) {
    const id = url.slice('Binary/'.length).split(/[/?#]/)[0];
    return id || undefined;
  }
  return storedBinaryReference(url, baseUrl)?.slice('Binary/'.length);
}

/**
 * Which network or repository a document came from, from its `meta.tag`.
 * @param doc - The DocumentReference.
 * @returns A label, or `untagged`.
 */
function sourceOf(doc: DocumentReference): string {
  const parts = (doc.meta?.tag ?? []).map((tag) => tag.code ?? tag.display).filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(' / ') : 'untagged';
}

/**
 * Audit one patient's documents against the Binaries that actually exist.
 *
 * Pure, so the classification can be tested without a server: the caller
 * supplies the documents and the set of Binary ids the server confirmed.
 * @param props - The audit inputs.
 * @param props.patientId - The patient being audited.
 * @param props.documents - Their DocumentReferences.
 * @param props.baseUrl - This Medplum server's base URL, ending in a slash.
 * @param props.existingBinaryIds - Binary ids confirmed present on the server.
 * @returns The per-patient audit.
 */
export function auditPatientDocuments(props: {
  patientId: string;
  documents: readonly DocumentReference[];
  baseUrl: string;
  existingBinaryIds: ReadonlySet<string>;
}): PatientDocumentAudit {
  const dangling: DanglingAttachment[] = [];
  const bySource: Record<string, number> = {};
  let broken = 0;

  for (const doc of props.documents) {
    const source = sourceOf(doc);
    const found: DanglingAttachment[] = [];
    (doc.content ?? []).forEach(({ attachment }, index) => {
      const url = attachment?.url;
      const binaryId = binaryIdFor(url, props.baseUrl);
      if (binaryId) {
        if (!props.existingBinaryIds.has(binaryId)) {
          found.push({ documentId: doc.id as string, index, url, kind: 'missing-binary', source });
        }
        return;
      }
      if (url) {
        found.push({ documentId: doc.id as string, index, url, kind: 'foreign-host', source });
      } else if (!attachment?.data) {
        found.push({ documentId: doc.id as string, index, kind: 'no-url', source });
      }
    });
    if (found.length > 0) {
      broken++;
      bySource[source] = (bySource[source] ?? 0) + 1;
      dangling.push(...found);
    }
  }

  return { patientId: props.patientId, documents: props.documents.length, broken, bySource, dangling };
}

/** Binary ids per `_id` search; keeps the query string under any sane limit. */
const BINARY_BATCH = 100;

/**
 * Ask the server which of these Binary ids exist.
 *
 * `_elements=id` so no content is transferred — the point is existence, and a
 * chart's worth of radiology PDFs is not something to pull down to find out.
 * @param medplum - Authenticated Medplum client.
 * @param ids - Binary ids to check.
 * @returns The subset that exists.
 */
async function existingBinaries(medplum: MedplumClient, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += BINARY_BATCH) {
    const batch = ids.slice(i, i + BINARY_BATCH);
    const page = await medplum.searchResources('Binary', {
      _id: batch.join(','),
      _elements: 'id',
      _count: String(batch.length),
    });
    for (const binary of page as Binary[]) {
      if (binary.id) {
        found.add(binary.id);
      }
    }
  }
  return found;
}

/**
 * Audit one patient against the live server.
 * @param medplum - Authenticated Medplum client.
 * @param patientId - The Medplum patient id.
 * @returns The audit.
 */
export async function auditPatient(medplum: MedplumClient, patientId: string): Promise<PatientDocumentAudit> {
  const documents: DocumentReference[] = [];
  for await (const page of medplum.searchResourcePages('DocumentReference', {
    patient: `Patient/${patientId}`,
    _elements: 'id,meta,content',
    _count: '200',
  })) {
    documents.push(...page);
  }
  const baseUrl = medplum.getBaseUrl();
  const ids = [
    ...new Set(
      documents
        .flatMap((doc) => doc.content ?? [])
        .map(({ attachment }) => binaryIdFor(attachment?.url, baseUrl))
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const existing = await existingBinaries(medplum, ids);
  return auditPatientDocuments({ patientId, documents, baseUrl, existingBinaryIds: existing });
}

/**
 * Every patient that has at least one DocumentReference.
 * @param medplum - Authenticated Medplum client.
 * @param limit - Stop after this many patients.
 * @returns Patient ids, in no particular order.
 */
async function patientsWithDocuments(medplum: MedplumClient, limit: number): Promise<string[]> {
  const ids = new Set<string>();
  for await (const page of medplum.searchResourcePages('DocumentReference', {
    _elements: 'subject',
    _count: '500',
  })) {
    for (const doc of page) {
      const ref = doc.subject?.reference;
      if (ref?.startsWith('Patient/')) {
        ids.add(ref.slice('Patient/'.length));
      }
    }
    if (ids.size >= limit) {
      break;
    }
  }
  return [...ids].slice(0, limit);
}

/**
 * Render one patient's audit for a terminal.
 * @param audit - The audit.
 * @returns The lines to print.
 */
export function formatAudit(audit: PatientDocumentAudit): string {
  if (audit.broken === 0) {
    return `Patient/${audit.patientId}: ${audit.documents} document(s), all openable`;
  }
  const sources = Object.entries(audit.bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `    ${n}  ${label}`)
    .join('\n');
  const detail = audit.dangling
    .slice(0, 50)
    .map((d) => `    ${d.kind}  DocumentReference/${d.documentId} [${d.index}]  ${d.url ?? '(no url)'}`)
    .join('\n');
  const more = audit.dangling.length > 50 ? `\n    … and ${audit.dangling.length - 50} more` : '';
  return (
    `Patient/${audit.patientId}: ${audit.broken} of ${audit.documents} document(s) cannot be opened\n` +
    `${sources}\n${detail}${more}`
  );
}

/**
 * CLI entry point.
 * @returns Resolves once the report has been printed.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const patients = argv.flatMap((arg, i) => (arg === '--patient' ? [argv[i + 1]] : [])).filter(Boolean);
  const all = argv.includes('--all');
  const json = argv.includes('--json');
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1]) : 500;

  if (patients.length === 0 && !all) {
    console.error('Usage: find-dangling-documents.ts --patient <id> [--patient <id>…] | --all [--limit N] [--json]');
    process.exitCode = 2;
    return;
  }

  const medplum = await getMedplum();
  const targets = patients.length > 0 ? patients : await patientsWithDocuments(medplum, limit);
  console.error(`Auditing ${targets.length} patient(s) against ${medplum.getBaseUrl()} (read-only)`);

  const audits: PatientDocumentAudit[] = [];
  for (const patientId of targets) {
    try {
      audits.push(await auditPatient(medplum, patientId));
    } catch (err) {
      console.error(`Patient/${patientId}: could not audit — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (json) {
    console.log(JSON.stringify(audits, null, 2));
    return;
  }

  const affected = audits.filter((a) => a.broken > 0);
  for (const audit of affected) {
    console.log(formatAudit(audit));
  }
  const totalDocs = audits.reduce((sum, a) => sum + a.documents, 0);
  const totalBroken = audits.reduce((sum, a) => sum + a.broken, 0);
  console.log(
    `\n${totalBroken} of ${totalDocs} document(s) across ${affected.length} of ${audits.length} patient(s) ` +
      'point at bytes this server does not hold. Nothing was changed.'
  );
}

// Run only when invoked directly, so the functions above stay importable.
if (process.argv[1]?.endsWith('find-dangling-documents.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
