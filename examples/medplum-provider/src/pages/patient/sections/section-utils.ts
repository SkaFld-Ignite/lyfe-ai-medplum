// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { CodeableConcept, Resource } from '@medplum/fhirtypes';
import { DOCUMENT_SOURCES } from '../../../components/patient-documents/documents-config';
import type { RecordBadge, RecordTone } from '../../../components/patient-shell/PatientRecordRow';
import type { DataSource } from '../../../utils/patient-timeline';
import { getDataSource } from '../../../utils/patient-timeline';

const SOURCE_TONES: Record<DataSource, RecordTone> = { drchrono: 'emerald', zus: 'blue', other: 'violet' };

/**
 * A concept's display text: its text, else the first coding's display, else its code.
 * @param concept - The concept.
 * @returns The label, or undefined.
 */
export function conceptLabel(concept: CodeableConcept | undefined): string | undefined {
  return concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? concept?.coding?.[0]?.code;
}

/**
 * The first coding code of a concept, e.g. an ICD-10 or LOINC code.
 * @param concept - The concept.
 * @returns The code, or undefined.
 */
export function conceptCode(concept: CodeableConcept | undefined): string | undefined {
  return concept?.coding?.find((c) => c.code)?.code;
}

/**
 * Title-cases a FHIR code such as `entered-in-error` for display.
 * @param code - The code.
 * @returns e.g. "Entered in error".
 */
export function humanize(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  const words = code.replace(/[-_]/g, ' ');
  return words[0].toUpperCase() + words.slice(1);
}

/**
 * Lyfe's badge colour for a clinical status: active amber, resolved green, other slate.
 * @param code - The status code.
 * @returns The tone.
 */
export function clinicalStatusTone(code: string | undefined): RecordTone {
  if (!code || ['active', 'recurrence', 'relapse', 'in-progress'].includes(code)) {
    return 'amber';
  }
  if (['resolved', 'remission', 'completed'].includes(code)) {
    return 'emerald';
  }
  return 'slate';
}

/**
 * Lyfe's severity badge colour.
 * @param severity - e.g. "Severe", "moderate".
 * @returns The tone.
 */
export function severityTone(severity: string | undefined): RecordTone {
  const s = severity?.toLowerCase() ?? '';
  if (s.includes('severe') || s === 'high') {
    return 'rose';
  }
  if (s.includes('moderate')) {
    return 'amber';
  }
  return 'emerald';
}

/**
 * Case-insensitive match of a search query against any of the given texts.
 * @param query - The query; empty matches everything.
 * @param texts - Texts to search.
 * @returns True when every word of the query appears in the texts.
 */
export function matchesQuery(query: string, texts: (string | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = texts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/**
 * The "From DrChrono" / "From Zus/HIE" / "Added in Lyfe" badge for a record, as on Documents.
 * @param resource - The record.
 * @returns The badge.
 */
export function sourceBadge(resource: Resource): RecordBadge {
  const source = getDataSource(resource);
  const label = DOCUMENT_SOURCES.find((s) => s.source === source)?.badge ?? 'Added in Lyfe';
  return { label, tone: SOURCE_TONES[source] };
}
