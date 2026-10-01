// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { SimpleGrid, Skeleton, Text } from '@mantine/core';
import { useSearch } from '@medplum/react';
import type { Icon } from '@tabler/icons-react';
import { IconActivity, IconBrain, IconHeartbeat, IconUsers } from '@tabler/icons-react';
import type { JSX } from 'react';
import type { SpecialtyDefinition } from '../../utils/dashboard';
import {
  DASHBOARD_SPECIALTIES,
  PATIENT_COUNT_QUERY,
  patientsWithConditionQuery,
  percentOf,
} from '../../utils/dashboard';
import classes from './Dashboard.module.css';

const ALL_SPECIALTIES_QUERY = patientsWithConditionQuery(DASHBOARD_SPECIALTIES.flatMap((s) => s.terms));
const SPECIALTY_QUERIES = Object.fromEntries(
  DASHBOARD_SPECIALTIES.map((s) => [s.key, patientsWithConditionQuery(s.terms)])
);

const SPECIALTY_STYLE: Record<SpecialtyDefinition['key'], { icon: Icon; tone: string }> = {
  gastroenterology: { icon: IconHeartbeat, tone: 'teal' },
  oncology: { icon: IconActivity, tone: 'rose' },
  psychiatry: { icon: IconBrain, tone: 'indigo' },
};

interface StatCardProps {
  label: string;
  value: number | undefined;
  hint: string;
  icon: Icon;
  tone: string;
  /** Share of all patients; shown as a bar. Omitted for the total. */
  percent?: number;
}

function StatCard(props: StatCardProps): JSX.Element {
  const { label, value, hint, icon: StatIcon, tone, percent } = props;
  return (
    <div className={classes.stat} data-tone={tone}>
      <div className={classes.statTop}>
        <div>
          <Text className={classes.statLabel}>{label}</Text>
          {value === undefined ? (
            <Skeleton h={30} w={72} mt={8} radius="sm" />
          ) : (
            <Text className={classes.statValue}>{value.toLocaleString()}</Text>
          )}
          <Text className={classes.muted} fz={12}>
            {hint}
          </Text>
        </div>
        <span className={classes.statIcon}>
          <StatIcon size={18} />
        </span>
      </div>
      <div className={classes.statFoot}>
        {percent === undefined ? (
          <>
            <span className={classes.tracking}>
              <span className={classes.liveDot} />
              Tracking
            </span>
            <span>All</span>
          </>
        ) : (
          <>
            <span className={classes.bar}>
              <span style={{ width: `${percent}%` }} />
            </span>
            <span>{percent}% of total</span>
          </>
        )}
      </div>
    </div>
  );
}

function SpecialtyCard({
  specialty,
  total,
}: {
  specialty: SpecialtyDefinition;
  total: number | undefined;
}): JSX.Element {
  const [bundle] = useSearch('Patient', SPECIALTY_QUERIES[specialty.key]);
  const style = SPECIALTY_STYLE[specialty.key];
  return (
    <StatCard
      label={specialty.label}
      value={bundle?.total}
      hint={specialty.hint}
      icon={style.icon}
      tone={style.tone}
      percent={percentOf(bundle?.total, total)}
    />
  );
}

/**
 * The patient count cards: everyone, then patients by specialty. Each is a `_summary=count` search,
 * so the server counts and nothing else is downloaded.
 * @returns The stat cards.
 */
export function PatientStats(): JSX.Element {
  const [totalBundle] = useSearch('Patient', PATIENT_COUNT_QUERY);
  const [specialtyBundle] = useSearch('Patient', ALL_SPECIALTIES_QUERY);
  const total = totalBundle?.total;
  const specialtyTotal = specialtyBundle?.total;

  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md" aria-label="Patient statistics">
      <StatCard
        label="Total patients"
        value={total}
        hint={specialtyTotal === undefined ? 'Counting specialty patients…' : `${specialtyTotal} specialty patients`}
        icon={IconUsers}
        tone="blue"
      />
      {DASHBOARD_SPECIALTIES.map((specialty) => (
        <SpecialtyCard key={specialty.key} specialty={specialty} total={total} />
      ))}
    </SimpleGrid>
  );
}
