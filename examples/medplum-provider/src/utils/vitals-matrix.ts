// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { CodeableConcept, Observation } from '@medplum/fhirtypes';
import { toClinicIsoDate } from './clinic-time';
import { classifyBloodPressure, classifyHeartRate, classifySpo2 } from './patient-overview';

/** How a reading compares with the normal range, for cell colour. */
export type VitalLevel = 'normal' | 'watch' | 'abnormal' | 'none';

export type VitalRowKey = 'bp' | 'pulse' | 'temp' | 'resp' | 'spo2' | 'height' | 'weight' | 'bmi';

export interface VitalCell {
  display: string;
  level: VitalLevel;
}

export interface VitalRow {
  key: VitalRowKey;
  label: string;
  unit?: string;
  /** Day key (clinic calendar day) to the latest reading that day. */
  cells: Record<string, VitalCell>;
}

export interface VitalsMatrix {
  /** Clinic calendar days with any reading, newest first. */
  days: string[];
  rows: VitalRow[];
}

const ROWS: { key: VitalRowKey; label: string; codes: string[]; text: RegExp }[] = [
  { key: 'bp', label: 'Blood Pressure', codes: ['85354-6', '55284-4'], text: /blood pressure/i },
  { key: 'pulse', label: 'Pulse', codes: ['8867-4'], text: /heart rate|pulse/i },
  { key: 'temp', label: 'Temperature', codes: ['8310-5', '8331-1'], text: /temperature/i },
  { key: 'resp', label: 'Respiratory Rate', codes: ['9279-1'], text: /respiratory rate/i },
  { key: 'spo2', label: 'O₂ Saturation', codes: ['59408-5', '2708-6'], text: /oxygen saturation|spo2|o2 sat/i },
  { key: 'height', label: 'Height/Length', codes: ['8302-2', '8306-3'], text: /height|length/i },
  { key: 'weight', label: 'Weight', codes: ['29463-7', '3141-9'], text: /weight/i },
  { key: 'bmi', label: 'BMI', codes: ['39156-5'], text: /bmi|body mass/i },
];

function matches(concept: CodeableConcept | undefined, codes: string[], text: RegExp): boolean {
  if (concept?.coding?.some((c) => c.code && codes.includes(c.code))) {
    return true;
  }
  return text.test(concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? '');
}

function levelOf(severity: string): VitalLevel {
  if (severity === 'normal' || severity === 'info') {
    return 'normal';
  }
  return severity === 'watch' ? 'watch' : 'abnormal';
}

function temperatureLevel(value: number, unit: string | undefined): VitalLevel {
  const celsius = /f/i.test(unit ?? '') ? ((value - 32) * 5) / 9 : value;
  if (celsius >= 38 || celsius < 35) {
    return 'abnormal';
  }
  return celsius >= 37.5 ? 'watch' : 'normal';
}

function respLevel(value: number): VitalLevel {
  if (value < 10 || value > 24) {
    return 'abnormal';
  }
  return value > 20 || value < 12 ? 'watch' : 'normal';
}

function cellFor(key: VitalRowKey, obs: Observation): VitalCell | undefined {
  if (key === 'bp') {
    const part = (codes: string[], text: RegExp): number | undefined =>
      obs.component?.find((c) => matches(c.code, codes, text))?.valueQuantity?.value;
    const systolic = part(['8480-6'], /systolic/i);
    const diastolic = part(['8462-4'], /diastolic/i);
    if (systolic === undefined) {
      return undefined;
    }
    return {
      display: `${systolic}/${diastolic ?? '—'}`,
      level: levelOf(classifyBloodPressure(systolic, diastolic ?? 0).severity),
    };
  }
  const value = obs.valueQuantity?.value;
  if (value === undefined) {
    return undefined;
  }
  const unit = obs.valueQuantity?.unit ?? obs.valueQuantity?.code;
  const display = String(value);
  switch (key) {
    case 'pulse':
      return { display, level: levelOf(classifyHeartRate(value).severity) };
    case 'spo2':
      return { display, level: levelOf(classifySpo2(value).severity) };
    case 'temp':
      return { display, level: temperatureLevel(value, unit) };
    case 'resp':
      return { display, level: respLevel(value) };
    case 'bmi':
      return { display, level: value >= 30 || value < 18.5 ? 'watch' : 'normal' };
    default:
      return { display, level: 'none' };
  }
}

/**
 * Lays vital-sign Observations out as Lyfe's history matrix: a row per vital, a column per clinic
 * day, newest first, keeping the latest reading of each vital per day.
 * @param observations - Vital-sign Observations.
 * @param timeZone - The clinic's IANA zone, which decides each reading's day.
 * @returns The matrix; rows without any reading are left out.
 */
export function buildVitalsMatrix(observations: Observation[], timeZone: string): VitalsMatrix {
  const rows: VitalRow[] = ROWS.map(({ key, label }) => ({ key, label, cells: {} }));
  const latestAt = new Map<string, number>();
  for (const obs of observations) {
    const when = obs.effectiveDateTime ?? obs.effectivePeriod?.start ?? obs.issued;
    const time = when ? new Date(when).getTime() : Number.NaN;
    if (Number.isNaN(time) || obs.status === 'entered-in-error') {
      continue;
    }
    const day = toClinicIsoDate(new Date(time), timeZone);
    const index = ROWS.findIndex((r) =>
      r.key === 'bp'
        ? obs.component?.some((c) => matches(c.code, ['8480-6'], /systolic/i))
        : matches(obs.code, r.codes, r.text)
    );
    if (index < 0) {
      continue;
    }
    const row = rows[index];
    const cell = cellFor(row.key, obs);
    const slot = `${row.key}|${day}`;
    if (!cell || (latestAt.get(slot) ?? -Infinity) > time) {
      continue;
    }
    latestAt.set(slot, time);
    row.cells[day] = cell;
    row.unit ??= row.key === 'bp' ? 'mmHg' : (obs.valueQuantity?.unit ?? obs.valueQuantity?.code);
  }
  const filled = rows.filter((r) => Object.keys(r.cells).length > 0);
  const days = [...new Set(filled.flatMap((r) => Object.keys(r.cells)))].sort().reverse();
  return { days, rows: filled };
}
