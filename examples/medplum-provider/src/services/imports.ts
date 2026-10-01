// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading import activity back out of Medplum.
 *
 * Every import opens a FHIR `Task` and keeps it up to date as it runs, so
 * there is nothing to read here but ordinary FHIR. A live view is a plain
 * `Task` search sorted by last-modified; "what has already been pulled" is a
 * `_summary=count` per resource type. No job table, no status endpoint, and
 * nothing that can disagree with the data it describes.
 *
 * The one thing worth stating plainly: counts come from the resources
 * themselves, not from what an importer claimed it wrote. If a run reports 40
 * observations and 38 are on the server, this shows 38.
 */
import type { MedplumClient } from '@medplum/core';
import type { Patient, Task } from '@medplum/fhirtypes';
import { LYFE_SOURCE_TAG_SYSTEM } from '../utils/data-source';

/**
 * Where an imported resource came from.
 *
 * These are wire values, not labels: `zus` is the literal `meta.tag` code the
 * importers stamp and the stem of the `Task` code below, so it is what the
 * `_tag` searches in this module match on. The product calls it Lyfe — use
 * {@link SOURCE_LABELS} for anything a person reads.
 */
export type ImportSource = 'drchrono' | 'zus';

/**
 * What each source is called in the product.
 *
 * There are two sources, Lyfe and DrChrono. `zus` is the Lyfe Data Network's
 * vendor name and stays in the data as a truthful record of provenance; it is
 * never shown.
 */
export const SOURCE_LABELS: Record<ImportSource, string> = {
  drchrono: 'DrChrono',
  zus: 'Lyfe',
};

/** Coding system the bots use for a failure reason. */
const IMPORT_ERROR_SYSTEM = 'https://lyfe.com/import-error';

/** Identifier carrying the source-system id, on a run with no patient yet. */
const SOURCE_ID_IDENTIFIER = 'https://lyfe.com/source-id';

/** Task codes the two importers write. */
const TASK_CODES: Record<ImportSource, string> = {
  drchrono: 'drchrono-import',
  zus: 'zus-import',
};

/** One import run, as the monitor lists it. */
export interface ImportRun {
  readonly id: string;
  readonly source: ImportSource;
  /** FHIR Task status: in-progress, completed, failed… */
  readonly status: string;
  /** Live phase, e.g. "6 of 11 · allergies, medications, problems". */
  readonly phase?: string;
  readonly patientReference?: string;
  readonly patientName?: string;
  /**
   * The id in the source system, when there is no Medplum patient to show.
   *
   * A chart import opens its Task before it knows the patient — the importer
   * finds or creates one — so a run that fails early never gets a `for`. The
   * row would read "—", which is exactly the run someone needs to identify.
   */
  readonly sourceId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Wall-clock duration in ms, from the execution period or the run's own report. */
  readonly durationMs?: number;
  /** Resources written, by resource type. */
  readonly counts: Record<string, number>;
  /** Total resources written. */
  readonly total: number;
  /** Coded failure reason, when the run failed. */
  readonly errorReason?: string;
  /** The failure message itself. */
  readonly errorMessage?: string;
  /** Per-type reasons a phase finished short without failing the run. */
  readonly incomplete: Record<string, string>;
}

/**
 * Read the integer or string value off a Task output entry.
 * @param entry - One Task.output entry.
 * @param entry.valueInteger - The numeric form, used for counts.
 * @param entry.valueString - The text form, used for messages.
 * @returns The value, preferring the integer form.
 */
function outputValue(entry: { valueInteger?: number; valueString?: string }): number | string | undefined {
  return entry.valueInteger ?? entry.valueString;
}

/**
 * Map a Task onto the shape the monitor renders.
 * @param task - The import Task.
 * @returns The run, or undefined when the Task is not an import.
 */
function toRun(task: Task): ImportRun | undefined {
  const code = task.code?.text;
  const source = (Object.keys(TASK_CODES) as ImportSource[]).find((s) => TASK_CODES[s] === code);
  if (!source || !task.id) {
    return undefined;
  }

  const counts: Record<string, number> = {};
  const incomplete: Record<string, string> = {};
  let durationMs: number | undefined;
  let errorMessage: string | undefined;
  let outputPatientId: string | undefined;

  for (const entry of task.output ?? []) {
    const label = entry.type?.text;
    const value = outputValue(entry);
    if (!label || value === undefined) {
      continue;
    }
    if (label === 'counts' && typeof value === 'string') {
      // Runs from before per-type outputs wrote one JSON blob. Parsed rather
      // than ignored so historic runs still show what they pulled.
      try {
        for (const [type, n] of Object.entries(JSON.parse(value) as Record<string, number>)) {
          if (typeof n === 'number' && n > 0) {
            counts[type] = n;
          }
        }
      } catch {
        // A malformed blob is not worth failing the row over.
      }
    } else if (label === 'durationMs') {
      durationMs = typeof value === 'number' ? value : Number(value);
    } else if (label === 'error') {
      errorMessage = String(value);
    } else if (label.startsWith('incomplete:')) {
      incomplete[label.slice('incomplete:'.length)] = String(value);
    } else if (label === 'medplumPatientId') {
      outputPatientId = String(value);
    } else if (label === 'total') {
      // Recomputed below from the per-type counts.
      continue;
    } else if (typeof value === 'number') {
      counts[label] = value;
    }
  }

  const start = task.executionPeriod?.start ?? task.authoredOn;
  const end = task.executionPeriod?.end;
  if (durationMs === undefined && start && end) {
    durationMs = new Date(end).getTime() - new Date(start).getTime();
  }

  const errorCoding = task.statusReason?.coding?.find((c) => c.system === IMPORT_ERROR_SYSTEM);

  // `Task.for` is the right place for this and is what current runs set. The
  // output fallback exists for runs written before the chart importer kept
  // `for` through its closing update — they still recorded the patient id in
  // their output, so the name is recoverable without rewriting history.
  const patientReference = task.for?.reference ?? (outputPatientId ? `Patient/${outputPatientId}` : undefined);

  return {
    id: task.id,
    source,
    status: task.status,
    phase: task.businessStatus?.text,
    patientReference,
    patientName: task.for?.display,
    sourceId: task.identifier?.find((i) => i.system === SOURCE_ID_IDENTIFIER)?.value,
    startedAt: start,
    endedAt: end,
    durationMs,
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    errorReason: errorCoding?.display ?? errorCoding?.code,
    errorMessage: task.statusReason?.text ?? errorMessage,
    incomplete,
  };
}

/**
 * Recent import runs, newest activity first.
 *
 * Sorted by `_lastUpdated` rather than start time on purpose: a run that is
 * actively reporting progress should rise to the top, which is what makes
 * this readable as a live feed.
 * @param medplum - Authenticated Medplum client.
 * @param count - How many runs to return.
 * @returns The runs, newest first.
 */
export async function listImportRuns(medplum: MedplumClient, count = 50): Promise<ImportRun[]> {
  const tasks = await medplum.searchResources('Task', {
    _sort: '-_lastUpdated',
    _count: String(count),
  });
  return tasks.map(toRun).filter((run): run is ImportRun => run !== undefined);
}

/**
 * Resolve display names for the patients a set of runs refers to.
 *
 * One search rather than N: FHIR treats comma-separated ids as OR, so a
 * page of runs costs a single request however many distinct patients it
 * mentions.
 * @param medplum - Authenticated Medplum client.
 * @param runs - The runs whose patients to name.
 * @returns Patient reference to display name.
 */
export async function resolvePatientNames(medplum: MedplumClient, runs: ImportRun[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      runs
        .map((r) => r.patientReference)
        .filter((ref): ref is string => Boolean(ref?.startsWith('Patient/')))
        .map((ref) => ref.slice('Patient/'.length))
    ),
  ];
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }
  const patients = await medplum.searchResources('Patient', {
    _id: ids.join(','),
    _count: String(ids.length),
  });
  for (const patient of patients) {
    if (patient.id) {
      names.set(`Patient/${patient.id}`, formatPatientName(patient));
    }
  }
  return names;
}

/**
 * Display name for a patient.
 * @param patient - The patient.
 * @returns Given and family joined, falling back to the id.
 */
export function formatPatientName(patient: Patient): string {
  const name = patient.name?.[0];
  const joined = [name?.given?.join(' '), name?.family].filter(Boolean).join(' ').trim();
  return joined || patient.id || 'Unknown patient';
}

/** The clinical domains the matrix reports, in the order a chart reads. */
export const IMPORT_DOMAINS: { readonly key: string; readonly label: string; readonly resourceType: string }[] = [
  { key: 'encounters', label: 'Encounters / visits', resourceType: 'Encounter' },
  { key: 'conditions', label: 'Conditions', resourceType: 'Condition' },
  { key: 'medications', label: 'Medications', resourceType: 'MedicationRequest' },
  { key: 'medicationStatements', label: 'Medication history', resourceType: 'MedicationStatement' },
  { key: 'allergies', label: 'Allergies', resourceType: 'AllergyIntolerance' },
  { key: 'immunizations', label: 'Immunizations', resourceType: 'Immunization' },
  { key: 'observations', label: 'Observations / vitals', resourceType: 'Observation' },
  { key: 'diagnosticReports', label: 'Diagnostic reports', resourceType: 'DiagnosticReport' },
  { key: 'procedures', label: 'Procedures', resourceType: 'Procedure' },
  { key: 'documents', label: 'Documents', resourceType: 'DocumentReference' },
  { key: 'coverage', label: 'Coverage', resourceType: 'Coverage' },
  { key: 'carePlans', label: 'Care plans', resourceType: 'CarePlan' },
  { key: 'familyHistory', label: 'Family history', resourceType: 'FamilyMemberHistory' },
];

/** What one domain holds, per source. */
export interface DomainCounts {
  readonly key: string;
  readonly label: string;
  readonly drchrono: number;
  readonly zus: number;
}

/**
 * Count what is actually on the server for a patient, by domain and source.
 *
 * Reads the resources rather than the importers' own claims, so this stays
 * honest about what landed. Every count is a `_summary=count` search, which
 * returns a total without transferring the resources.
 * @param medplum - Authenticated Medplum client.
 * @param patientId - The Medplum patient id.
 * @returns One row per domain.
 */
export async function countPatientDomains(medplum: MedplumClient, patientId: string): Promise<DomainCounts[]> {
  const rows: DomainCounts[] = [];
  for (const domain of IMPORT_DOMAINS) {
    const [drchrono, zus] = await Promise.all([
      countOne(medplum, domain.resourceType, patientId, 'drchrono'),
      countOne(medplum, domain.resourceType, patientId, 'zus'),
    ]);
    rows.push({ key: domain.key, label: domain.label, drchrono, zus });
  }
  return rows;
}

/**
 * Count one resource type for one patient from one source.
 * @param medplum - Authenticated Medplum client.
 * @param resourceType - The FHIR resource type to count.
 * @param patientId - The Medplum patient id.
 * @param source - Which importer wrote it.
 * @returns The count, or 0 when the search is not supported for that type.
 */
async function countOne(
  medplum: MedplumClient,
  resourceType: string,
  patientId: string,
  source: ImportSource
): Promise<number> {
  try {
    const bundle = await medplum.search(
      resourceType as 'Observation',
      {
        patient: `Patient/${patientId}`,
        _tag: `${LYFE_SOURCE_TAG_SYSTEM}|${source}`,
        _summary: 'count',
      },
      { cache: 'no-cache' }
    );
    return bundle.total ?? 0;
  } catch {
    // A resource type without a `patient` search parameter is not an error
    // worth surfacing here; it simply has nothing to report.
    return 0;
  }
}
