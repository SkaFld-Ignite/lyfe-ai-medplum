// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { DiagnosticReport, Observation, ObservationReferenceRange } from '@medplum/fhirtypes';

/** Lyfe's result flags: High, Low, Abnormal (no direction). */
export type LabFlag = 'H' | 'L' | 'A';

export interface LabResult {
  id: string;
  observation: Observation;
  label: string;
  /** Groups the same analyte across panels and dates: its LOINC code, else its name. */
  analyteKey: string;
  display: string;
  value?: number;
  unit?: string;
  flag?: LabFlag;
  range?: string;
  date?: Date;
}

export interface LabPanel {
  id: string;
  title: string;
  report?: DiagnosticReport;
  date?: Date;
  performer?: string;
  status?: string;
  results: LabResult[];
}

export interface LabsModel {
  panels: LabPanel[];
  /** Analyte key to its results, oldest first. */
  history: Map<string, LabResult[]>;
  /** The latest result of each analyte, when that result is flagged; newest first. */
  latestAbnormals: LabResult[];
  /** Distinct result dates as clinic day keys are computed by the caller; here, all results. */
  results: LabResult[];
}

const INTERPRETATION_FLAGS: Record<string, LabFlag> = {
  H: 'H',
  HH: 'H',
  HU: 'H',
  '>': 'H',
  L: 'L',
  LL: 'L',
  LU: 'L',
  '<': 'L',
  A: 'A',
  AA: 'A',
};

function dateOf(obs: Observation): Date | undefined {
  const value = obs.effectiveDateTime ?? obs.effectivePeriod?.start ?? obs.issued;
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function rangeText(range: ObservationReferenceRange | undefined): string | undefined {
  if (!range) {
    return undefined;
  }
  if (range.text) {
    return range.text;
  }
  const low = range.low?.value;
  const high = range.high?.value;
  if (low !== undefined && high !== undefined) {
    return `${low}–${high}`;
  }
  if (low !== undefined) {
    return `≥ ${low}`;
  }
  return high !== undefined ? `≤ ${high}` : undefined;
}

/**
 * The flag for a result: its interpretation code, else a comparison with its reference range.
 * @param obs - The lab Observation.
 * @returns H, L or A, or undefined when normal or unknown.
 */
export function labFlag(obs: Observation): LabFlag | undefined {
  for (const coding of obs.interpretation?.flatMap((i) => i.coding ?? []) ?? []) {
    const flag = coding.code ? INTERPRETATION_FLAGS[coding.code.toUpperCase()] : undefined;
    if (flag) {
      return flag;
    }
  }
  const value = obs.valueQuantity?.value;
  const range = obs.referenceRange?.[0];
  if (value === undefined || !range) {
    return undefined;
  }
  if (range.high?.value !== undefined && value > range.high.value) {
    return 'H';
  }
  if (range.low?.value !== undefined && value < range.low.value) {
    return 'L';
  }
  return undefined;
}

/**
 * Turns a lab Observation into a display row.
 * @param obs - The lab Observation.
 * @returns The result.
 */
export function toLabResult(obs: Observation): LabResult {
  const coding = obs.code?.coding?.find((c) => c.code);
  const label = obs.code?.text ?? coding?.display ?? coding?.code ?? 'Result';
  const quantity = obs.valueQuantity;
  let display =
    obs.valueString ?? obs.valueCodeableConcept?.text ?? obs.valueCodeableConcept?.coding?.[0]?.display ?? '—';
  if (quantity?.value !== undefined) {
    display = `${quantity.comparator ?? ''}${quantity.value}`;
  }
  return {
    id: obs.id ?? label,
    observation: obs,
    label,
    analyteKey: coding?.code ?? label.trim().toLowerCase(),
    display,
    value: quantity?.value,
    unit: quantity?.unit ?? quantity?.code,
    flag: labFlag(obs),
    range: rangeText(obs.referenceRange?.[0]),
    date: dateOf(obs),
  };
}

function reportDate(report: DiagnosticReport): Date | undefined {
  const value = report.effectiveDateTime ?? report.effectivePeriod?.start ?? report.issued;
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/**
 * Builds Lyfe's labs view: panels from DiagnosticReports (results not in any report collected in one
 * "Other results" panel), each analyte's history, and the latest abnormal results.
 * @param reports - Lab DiagnosticReports.
 * @param observations - Lab Observations.
 * @returns The labs model, panels newest first.
 */
export function buildLabsModel(reports: DiagnosticReport[], observations: Observation[]): LabsModel {
  const usable = observations.filter((o) => o.status !== 'entered-in-error' && o.status !== 'cancelled');
  const byId = new Map(usable.map((o) => [o.id, o]));
  const claimed = new Set<string>();

  const panels: LabPanel[] = reports
    .filter((r) => r.status !== 'entered-in-error' && r.status !== 'cancelled')
    .map((report) => {
      const results = (report.result ?? [])
        .map((ref) => byId.get(ref.reference?.split('/')[1]))
        .filter((o): o is Observation => Boolean(o))
        .map((o) => {
          claimed.add(o.id as string);
          return toLabResult(o);
        });
      return {
        id: report.id ?? 'report',
        title: report.code?.text ?? report.code?.coding?.[0]?.display ?? 'Lab report',
        report,
        date: reportDate(report),
        performer: report.performer?.[0]?.display,
        status: report.status,
        results,
      };
    });

  const loose = usable.filter((o) => !claimed.has(o.id as string)).map(toLabResult);
  if (loose.length > 0) {
    const dates = loose.map((r) => r.date?.getTime()).filter((t): t is number => t !== undefined);
    panels.push({
      id: 'other-results',
      title: 'Other results',
      date: dates.length ? new Date(Math.max(...dates)) : undefined,
      results: loose,
    });
  }
  panels.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));

  const results = usable.map(toLabResult);
  const history = new Map<string, LabResult[]>();
  for (const result of results) {
    history.set(result.analyteKey, [...(history.get(result.analyteKey) ?? []), result]);
  }
  for (const list of history.values()) {
    list.sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  }
  const latestAbnormals = [...history.values()]
    .map((list) => list[list.length - 1])
    .filter((r) => r.flag)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));

  return { panels, history, latestAbnormals, results };
}
