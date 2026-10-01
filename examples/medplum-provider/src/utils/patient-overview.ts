// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type {
  AllergyIntolerance,
  Appointment,
  CodeableConcept,
  Condition,
  Encounter,
  MedicationRequest,
  MedicationStatement,
  Observation,
} from '@medplum/fhirtypes';

/** How worrying a reading or flag is, from fine to urgent. */
export type Severity = 'normal' | 'info' | 'watch' | 'alert' | 'critical' | 'unknown';

export type VitalKey = 'bp' | 'hr' | 'spo2' | 'weight';

export interface VitalPoint {
  date: Date;
  /** The plotted value: systolic for blood pressure, pounds for weight. */
  value: number;
}

export interface VitalSummary {
  key: VitalKey;
  /** The latest reading as shown, e.g. "128/82" or "185.6". */
  display?: string;
  unit: string;
  date?: Date;
  status: string;
  severity: Severity;
  /** Oldest first. */
  history: VitalPoint[];
}

export interface ProfileItem {
  label: string;
  severity?: Severity;
}

export interface ClinicalFlag {
  label: string;
  severity: Severity;
  icon: 'allergy' | 'bp' | 'spo2' | 'meds' | 'conditions' | 'visit';
}

export interface PatientOverview {
  vitals: Record<VitalKey, VitalSummary>;
  /** When the most recent vital in any of the four cards was recorded. */
  vitalsDate?: Date;
  conditions: ProfileItem[];
  medications: ProfileItem[];
  allergies: ProfileItem[];
  severeAllergyCount: number;
  lastVisit?: { date: Date; reason?: string };
  nextVisit?: { date: Date; reason?: string };
  flags: ClinicalFlag[];
}

export interface OverviewSources {
  conditions: Condition[];
  medicationRequests: MedicationRequest[];
  medicationStatements: MedicationStatement[];
  allergies: AllergyIntolerance[];
  vitals: Observation[];
  encounters: Encounter[];
  appointments: Appointment[];
}

/** More active medications than this is flagged as polypharmacy. */
export const POLYPHARMACY_THRESHOLD = 10;
/** This many active conditions or more is flagged for review. */
export const CONDITIONS_WATCH_THRESHOLD = 3;
/** A last visit older than this many days is flagged. */
export const VISIT_GAP_DAYS = 180;

const LB_PER_KG = 2.20462;
const DAY_MS = 86_400_000;

const LOINC = {
  bpPanel: ['85354-6', '55284-4'],
  systolic: ['8480-6'],
  diastolic: ['8462-4'],
  hr: ['8867-4'],
  spo2: ['59408-5', '2708-6'],
  weight: ['29463-7', '3141-9'],
};

function hasCode(concept: CodeableConcept | undefined, codes: string[], text: RegExp): boolean {
  if (concept?.coding?.some((c) => c.code && codes.includes(c.code))) {
    return true;
  }
  const label = concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? '';
  return text.test(label);
}

function observedAt(obs: Observation): Date | undefined {
  const value = obs.effectiveDateTime ?? obs.effectivePeriod?.start ?? obs.issued;
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Blood pressure category per the AHA adult guideline.
 * @param systolic - Systolic mmHg.
 * @param diastolic - Diastolic mmHg.
 * @returns Label and severity.
 */
export function classifyBloodPressure(systolic: number, diastolic: number): { status: string; severity: Severity } {
  if (systolic > 180 || diastolic > 120) {
    return { status: 'Crisis', severity: 'critical' };
  }
  if (systolic >= 140 || diastolic >= 90) {
    return { status: 'Stage 2', severity: 'alert' };
  }
  if (systolic >= 130 || diastolic >= 80) {
    return { status: 'Stage 1', severity: 'watch' };
  }
  if (systolic >= 120) {
    return { status: 'Elevated', severity: 'info' };
  }
  return { status: 'Normal', severity: 'normal' };
}

/**
 * Resting adult heart rate category.
 * @param bpm - Beats per minute.
 * @returns Label and severity.
 */
export function classifyHeartRate(bpm: number): { status: string; severity: Severity } {
  if (bpm < 50) {
    return { status: 'Brady', severity: 'alert' };
  }
  if (bpm > 110) {
    return { status: 'Tachy', severity: 'alert' };
  }
  if (bpm < 60 || bpm > 100) {
    return { status: 'Borderline', severity: 'watch' };
  }
  return { status: 'Normal', severity: 'normal' };
}

/**
 * Oxygen saturation category.
 * @param percent - SpO2 percent.
 * @returns Label and severity.
 */
export function classifySpo2(percent: number): { status: string; severity: Severity } {
  if (percent < 88) {
    return { status: 'Hypoxic', severity: 'critical' };
  }
  if (percent < 92) {
    return { status: 'Low', severity: 'alert' };
  }
  if (percent < 95) {
    return { status: 'Borderline', severity: 'watch' };
  }
  return { status: 'Normal', severity: 'normal' };
}

function bloodPressureOf(obs: Observation): { systolic: number; diastolic?: number } | undefined {
  const part = (codes: string[], text: RegExp): number | undefined =>
    obs.component?.find((c) => hasCode(c.code, codes, text))?.valueQuantity?.value;
  const systolic = part(LOINC.systolic, /systolic/i);
  if (systolic !== undefined) {
    return { systolic, diastolic: part(LOINC.diastolic, /diastolic/i) };
  }
  if (hasCode(obs.code, LOINC.systolic, /^systolic/i) && obs.valueQuantity?.value !== undefined) {
    return { systolic: obs.valueQuantity.value };
  }
  return undefined;
}

function toPounds(value: number, unit: string | undefined): number {
  return /^(kg|kilogram)/i.test(unit ?? 'kg') ? value * LB_PER_KG : value;
}

/**
 * Picks the four headline vitals (blood pressure, heart rate, SpO2, weight) out of vital-sign
 * Observations, with their history for the trend line.
 * @param observations - Vital-sign Observations in any order.
 * @returns The four vital summaries.
 */
export function summarizeVitals(observations: Observation[]): Record<VitalKey, VitalSummary> {
  const series: Record<VitalKey, { date: Date; value: number; diastolic?: number }[]> = {
    bp: [],
    hr: [],
    spo2: [],
    weight: [],
  };
  for (const obs of observations) {
    const date = observedAt(obs);
    if (!date || obs.status === 'entered-in-error') {
      continue;
    }
    const bp = bloodPressureOf(obs);
    const quantity = obs.valueQuantity;
    if (bp) {
      series.bp.push({ date, value: bp.systolic, diastolic: bp.diastolic });
    } else if (quantity?.value !== undefined && hasCode(obs.code, LOINC.hr, /heart rate|pulse/i)) {
      series.hr.push({ date, value: quantity.value });
    } else if (quantity?.value !== undefined && hasCode(obs.code, LOINC.spo2, /oxygen saturation|spo2|o2 sat/i)) {
      series.spo2.push({ date, value: quantity.value });
    } else if (quantity?.value !== undefined && hasCode(obs.code, LOINC.weight, /body weight|^weight/i)) {
      series.weight.push({ date, value: round(toPounds(quantity.value, quantity.unit ?? quantity.code)) });
    }
  }
  for (const key of Object.keys(series) as VitalKey[]) {
    series[key].sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  const latest = <T>(list: T[]): T | undefined => list[list.length - 1];
  const history = (key: VitalKey): VitalPoint[] => series[key].map(({ date, value }) => ({ date, value }));

  const bp = latest(series.bp);
  const bpClass = bp ? classifyBloodPressure(bp.value, bp.diastolic ?? 0) : undefined;
  const hr = latest(series.hr);
  const hrClass = hr ? classifyHeartRate(hr.value) : undefined;
  const spo2 = latest(series.spo2);
  const spo2Class = spo2 ? classifySpo2(spo2.value) : undefined;
  const weight = latest(series.weight);

  const none = { status: 'No data', severity: 'unknown' as Severity };
  return {
    bp: {
      key: 'bp',
      unit: 'mmHg',
      display: bp ? `${bp.value}/${bp.diastolic ?? '—'}` : undefined,
      date: bp?.date,
      ...(bpClass ?? none),
      history: history('bp'),
    },
    hr: {
      key: 'hr',
      unit: 'bpm',
      display: hr ? String(hr.value) : undefined,
      date: hr?.date,
      ...(hrClass ?? none),
      history: history('hr'),
    },
    spo2: {
      key: 'spo2',
      unit: '%',
      display: spo2 ? String(spo2.value) : undefined,
      date: spo2?.date,
      ...(spo2Class ?? none),
      history: history('spo2'),
    },
    weight: {
      key: 'weight',
      unit: 'lbs',
      display: weight ? String(weight.value) : undefined,
      date: weight?.date,
      ...(weight ? { status: 'Tracking', severity: 'info' } : none),
      history: history('weight'),
    },
  };
}

function isActiveClinicalStatus(concept: CodeableConcept | undefined): boolean {
  const code = concept?.coding?.[0]?.code;
  return !code || code === 'active' || code === 'recurrence' || code === 'relapse';
}

function conceptLabel(concept: CodeableConcept | undefined): string | undefined {
  return concept?.text ?? concept?.coding?.find((c) => c.display)?.display;
}

function uniqueByLabel(items: ProfileItem[]): ProfileItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.label.trim().toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isSevereAllergy(allergy: AllergyIntolerance): boolean {
  return allergy.criticality === 'high' || Boolean(allergy.reaction?.some((r) => r.severity === 'severe'));
}

function dateOf(value: string | undefined): Date | undefined {
  const date = value ? new Date(value) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/**
 * Builds the overview: headline vitals, the active clinical profile, last/next visit and the
 * clinical flags shown in the risk banner.
 * @param sources - The patient's resources.
 * @param now - The current time.
 * @returns The overview.
 */
export function buildPatientOverview(sources: OverviewSources, now = new Date()): PatientOverview {
  const vitals = summarizeVitals(sources.vitals);
  const vitalDates = Object.values(vitals)
    .map((v) => v.date?.getTime())
    .filter((t): t is number => t !== undefined);

  const conditions = uniqueByLabel(
    sources.conditions
      .filter(
        (c) =>
          isActiveClinicalStatus(c.clinicalStatus) && c.verificationStatus?.coding?.[0]?.code !== 'entered-in-error'
      )
      .map((c) => ({ label: conceptLabel(c.code) ?? 'Unnamed condition' }))
  );

  const medications = uniqueByLabel([
    ...sources.medicationRequests
      .filter((m) => m.status === 'active' || m.status === 'on-hold')
      .map((m) => ({ label: conceptLabel(m.medicationCodeableConcept) ?? m.medicationReference?.display ?? '' })),
    ...sources.medicationStatements
      .filter((m) => m.status === 'active' || m.status === 'intended')
      .map((m) => ({ label: conceptLabel(m.medicationCodeableConcept) ?? m.medicationReference?.display ?? '' })),
  ]);

  const activeAllergies = sources.allergies.filter(
    (a) => isActiveClinicalStatus(a.clinicalStatus) && a.verificationStatus?.coding?.[0]?.code !== 'entered-in-error'
  );
  const allergies = uniqueByLabel(
    activeAllergies.map((a) => ({
      label: conceptLabel(a.code) ?? 'Unnamed allergy',
      severity: isSevereAllergy(a) ? 'critical' : 'watch',
    }))
  );
  const severeAllergyCount = allergies.filter((a) => a.severity === 'critical').length;

  const pastVisits = sources.encounters
    .map((e) => ({
      date: dateOf(e.period?.start),
      reason: conceptLabel(e.reasonCode?.[0]) ?? conceptLabel(e.type?.[0]),
    }))
    .filter((v): v is { date: Date; reason: string | undefined } => Boolean(v.date && v.date <= now))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
  const upcoming = sources.appointments
    .filter((a) => a.status !== 'cancelled' && a.status !== 'noshow' && a.status !== 'entered-in-error')
    .map((a) => ({
      date: dateOf(a.start),
      reason: a.description ?? conceptLabel(a.appointmentType) ?? conceptLabel(a.serviceType?.[0]),
    }))
    .filter((v): v is { date: Date; reason: string | undefined } => Boolean(v.date && v.date >= now))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const lastVisit = pastVisits[0];
  const flags: ClinicalFlag[] = [];
  if (severeAllergyCount > 0) {
    flags.push({
      label: `${severeAllergyCount} severe ${severeAllergyCount === 1 ? 'allergy' : 'allergies'}`,
      severity: 'critical',
      icon: 'allergy',
    });
  }
  if (['watch', 'alert', 'critical'].includes(vitals.bp.severity)) {
    flags.push({ label: `BP ${vitals.bp.status}`, severity: vitals.bp.severity, icon: 'bp' });
  }
  if (['alert', 'critical'].includes(vitals.spo2.severity)) {
    flags.push({ label: `SpO₂ ${vitals.spo2.status}`, severity: vitals.spo2.severity, icon: 'spo2' });
  }
  if (medications.length > POLYPHARMACY_THRESHOLD) {
    flags.push({ label: 'Polypharmacy', severity: 'watch', icon: 'meds' });
  }
  if (conditions.length >= CONDITIONS_WATCH_THRESHOLD) {
    flags.push({ label: `${conditions.length} chronic conditions`, severity: 'watch', icon: 'conditions' });
  }
  if (lastVisit) {
    const days = Math.floor((now.getTime() - lastVisit.date.getTime()) / DAY_MS);
    if (days > VISIT_GAP_DAYS) {
      flags.push({ label: `${days}d since last visit`, severity: 'watch', icon: 'visit' });
    }
  }

  return {
    vitals,
    vitalsDate: vitalDates.length ? new Date(Math.max(...vitalDates)) : undefined,
    conditions,
    medications,
    allergies,
    severeAllergyCount,
    lastVisit,
    nextVisit: upcoming[0],
    flags,
  };
}

/**
 * Days between two dates, rounded down, ignoring the time of day.
 * @param from - The earlier date.
 * @param to - The later date.
 * @returns Whole calendar days.
 */
export function daysBetween(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((end - start) / DAY_MS);
}
