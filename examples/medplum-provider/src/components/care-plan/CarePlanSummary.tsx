// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Group, Stack, Text } from '@mantine/core';
import type { CarePlan } from '@medplum/fhirtypes';
import { IconCalendarEvent, IconListCheck, IconMapPin, IconUser } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import { humanize } from '../../pages/patient/sections/section-utils';
import { formatFhirDate } from '../../utils/clinic-time';
import type { RecordTone } from '../patient-shell/PatientRecordRow';
import { ToneBadge } from '../patient-shell/PatientRecordRow';
import { toActivityRow } from './care-plan-utils';
import classes from './CarePlanSummary.module.css';

const ACTIVITY_TONES: Record<string, RecordTone> = {
  scheduled: 'blue',
  'in-progress': 'amber',
  'on-hold': 'orange',
  completed: 'emerald',
  cancelled: 'slate',
  stopped: 'slate',
  'not-started': 'slate',
};

/**
 * The Lyfe summary of a care plan: key facts, its description and categories, and one card per
 * activity. The full Medplum record is shown below it.
 * @param props - The care plan.
 * @param props.carePlan - The care plan to summarise.
 * @returns The summary.
 */
export function CarePlanSummary({ carePlan }: { carePlan: CarePlan }): JSX.Element {
  const timeZone = useClinicTimeZone();
  const start = formatFhirDate(carePlan.period?.start, timeZone);
  const end = formatFhirDate(carePlan.period?.end, timeZone);
  const activities = (carePlan.activity ?? []).map((a, i) => toActivityRow(a, i, timeZone));
  const categories = (carePlan.category ?? [])
    .map((c) => c.text ?? c.coding?.find((x) => x.display)?.display)
    .filter((c): c is string => Boolean(c));
  const addresses = (carePlan.addresses ?? []).map((a) => a.display).filter((a): a is string => Boolean(a));

  const facts: [string, string][] = [
    ['Status', humanize(carePlan.status) ?? '—'],
    ['Intent', humanize(carePlan.intent) ?? '—'],
    ['Period', start ? `${start} – ${end ?? 'ongoing'}` : '—'],
    ['Created', formatFhirDate(carePlan.created, timeZone) ?? '—'],
  ];

  return (
    <Stack gap="md" className={classes.summary}>
      <div className={classes.facts}>
        {facts.map(([label, value]) => (
          <div key={label} className={classes.fact}>
            <Text className={classes.factLabel}>{label}</Text>
            <Text className={classes.factValue}>{value}</Text>
          </div>
        ))}
      </div>

      {(carePlan.description || categories.length > 0 || addresses.length > 0) && (
        <Stack gap={8}>
          {carePlan.description && <Text size="sm">{carePlan.description}</Text>}
          {(categories.length > 0 || addresses.length > 0) && (
            <Group gap={6}>
              {categories.map((c) => (
                <ToneBadge key={c} label={c} tone="indigo" />
              ))}
              {addresses.map((a) => (
                <ToneBadge key={a} label={`Addresses: ${a}`} tone="rose" />
              ))}
            </Group>
          )}
        </Stack>
      )}

      <section aria-label="Activities">
        <Group gap={8} mb={8}>
          <IconListCheck size={16} className={classes.sectionIcon} />
          <Text className={classes.sectionTitle}>Activities</Text>
          <span className={classes.count}>{activities.length}</span>
        </Group>
        {activities.length === 0 ? (
          <Text size="sm" c="dimmed">
            No activities on this care plan.
          </Text>
        ) : (
          <div className={classes.activities}>
            {activities.map((a) => (
              <div key={a.key} className={classes.activity}>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
                  <Text fw={600} size="sm" className={classes.activityTitle}>
                    {a.title}
                  </Text>
                  {a.status && (
                    <ToneBadge label={humanize(a.status) ?? a.status} tone={ACTIVITY_TONES[a.status] ?? 'slate'} />
                  )}
                </Group>
                {a.description && (
                  <Text size="xs" c="dimmed" mt={4}>
                    {a.description}
                  </Text>
                )}
                <Group gap={12} mt={8} className={classes.meta}>
                  {a.kind && <span>{humanize(a.kind)}</span>}
                  {a.when && (
                    <span>
                      <IconCalendarEvent size={12} /> {a.when}
                    </span>
                  )}
                  {a.performer && (
                    <span>
                      <IconUser size={12} /> {a.performer}
                    </span>
                  )}
                  {a.location && (
                    <span>
                      <IconMapPin size={12} /> {a.location}
                    </span>
                  )}
                </Group>
              </div>
            ))}
          </div>
        )}
      </section>
    </Stack>
  );
}
