// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { CarePlanActivity, CodeableConcept } from '@medplum/fhirtypes';
import { formatFhirDate } from '../../utils/clinic-time';

export interface CarePlanActivityRow {
  key: string;
  title: string;
  kind?: string;
  status?: string;
  when?: string;
  performer?: string;
  location?: string;
  description?: string;
}

function conceptText(concept: CodeableConcept | undefined): string | undefined {
  return concept?.text ?? concept?.coding?.find((c) => c.display)?.display ?? concept?.coding?.[0]?.code;
}

/**
 * Formats a date that may arrive as FHIR (`2026-08-17`, an instant) or as a compact `YYYYMMDD`
 * string, which Zus sends in `scheduledString`.
 * @param value - The date text.
 * @param timeZone - The clinic's IANA zone.
 * @returns The formatted date, or the text as given when it is not a date.
 */
export function formatLooseDate(value: string | undefined, timeZone: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  const normalized = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value;
  return formatFhirDate(normalized, timeZone) ?? value;
}

/**
 * Flattens a care plan activity into what the Lyfe card shows.
 * @param activity - The activity.
 * @param index - Its position, for a stable key.
 * @param timeZone - The clinic's IANA zone.
 * @returns The row.
 */
export function toActivityRow(activity: CarePlanActivity, index: number, timeZone: string): CarePlanActivityRow {
  const detail = activity.detail;
  const period = detail?.scheduledPeriod;
  let when = formatLooseDate(detail?.scheduledString, timeZone);
  if (!when && period?.start) {
    const start = formatFhirDate(period.start, timeZone);
    const end = formatFhirDate(period.end, timeZone);
    when = end && end !== start ? `${start} – ${end}` : start;
  }
  when ??= formatFhirDate(detail?.scheduledTiming?.event?.[0], timeZone);

  return {
    key: `${index}`,
    title:
      conceptText(detail?.code) ??
      detail?.description ??
      activity.reference?.display ??
      conceptText(activity.outcomeCodeableConcept?.[0]) ??
      'Activity',
    kind: detail?.kind,
    status: detail?.status,
    when,
    performer:
      detail?.performer
        ?.map((p) => p.display)
        .filter(Boolean)
        .join(', ') || undefined,
    location: detail?.location?.display,
    description: detail?.code && detail.description ? detail.description : undefined,
  };
}
