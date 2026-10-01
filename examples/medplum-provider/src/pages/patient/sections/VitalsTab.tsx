// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Box, Group, ScrollArea, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconActivity,
  IconAlertTriangle,
  IconHeart,
  IconRuler,
  IconScale,
  IconTemperature,
  IconWind,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo } from 'react';
import { useParams } from 'react-router';
import { PatientTabShell } from '../../../components/patient-shell/PatientTabShell';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatientResources } from '../../../hooks/usePatientResources';
import { formatDayKey } from '../../../utils/clinic-time';
import type { VitalRowKey } from '../../../utils/vitals-matrix';
import { buildVitalsMatrix } from '../../../utils/vitals-matrix';
import classes from './Sections.module.css';

const ROW_STYLE: Record<VitalRowKey, { icon: Icon; color: string }> = {
  bp: { icon: IconHeart, color: '#f43f5e' },
  pulse: { icon: IconActivity, color: '#ec4899' },
  temp: { icon: IconTemperature, color: '#f97316' },
  resp: { icon: IconWind, color: '#10b981' },
  spo2: { icon: IconWind, color: '#14b8a6' },
  height: { icon: IconRuler, color: '#7c3aed' },
  weight: { icon: IconScale, color: '#0284c7' },
  bmi: { icon: IconScale, color: '#2563eb' },
};

/**
 * The Lyfe "Patient Vitals" section: every vital sign by date, newest first, coloured by range.
 * @returns The vitals tab.
 */
export function VitalsTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const timeZone = useClinicTimeZone();
  const { items, loading, error } = usePatientResources('Observation', patientId, {
    category: 'vital-signs',
    _sort: '-date',
  });
  const matrix = useMemo(() => buildVitalsMatrix(items, timeZone), [items, timeZone]);

  return (
    <PatientTabShell
      icon={<IconActivity size={20} />}
      title="Patient Vitals"
      count={loading ? undefined : matrix.days.length}
      description="Vital signs recorded at each visit"
      loading={loading}
      empty={
        !error && matrix.rows.length === 0
          ? { icon: <IconActivity size={28} />, title: 'No vital signs recorded yet' }
          : undefined
      }
    >
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} m="md">
          {error}
        </Alert>
      )}
      <Group justify="space-between" className={classes.matrixHeader}>
        <Box>
          <Text className={classes.matrixTitle}>Vital signs history</Text>
          <Text className={classes.matrixSubtitle}>Every reading by visit date, most recent first</Text>
        </Box>
        <Group gap="md" className={classes.legend}>
          <span data-level="normal">Normal</span>
          <span data-level="watch">Watch</span>
          <span data-level="abnormal">Abnormal</span>
        </Group>
      </Group>
      <ScrollArea type="auto">
        <table className={classes.matrix}>
          <thead>
            <tr>
              <th className={classes.stickyCol}>Vital · Unit</th>
              {matrix.days.map((day, i) => (
                <th key={day} data-latest={i === 0 || undefined}>
                  <span className={classes.dayLabel}>{formatDayKey(day, { month: 'short', day: 'numeric' })}</span>
                  <span className={classes.yearLabel}>
                    {formatDayKey(day, { year: 'numeric' })}
                    {i === 0 && <span className={classes.latestPill}>Latest</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const style = ROW_STYLE[row.key];
              const RowIcon = style.icon;
              return (
                <tr key={row.key}>
                  <th scope="row" className={classes.stickyCol}>
                    <Group gap={10} wrap="nowrap">
                      <Box className={classes.rowTile} style={{ color: style.color }}>
                        <RowIcon size={16} />
                      </Box>
                      <Box>
                        <Text size="sm" fw={600}>
                          {row.label}
                        </Text>
                        {row.unit && <Text className={classes.unit}>{row.unit}</Text>}
                      </Box>
                    </Group>
                  </th>
                  {matrix.days.map((day, i) => {
                    const cell = row.cells[day];
                    return (
                      <td key={day} data-latest={i === 0 || undefined}>
                        {cell ? (
                          <span className={classes.reading} data-level={cell.level}>
                            {cell.display}
                          </span>
                        ) : (
                          <span className={classes.emptyCell}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollArea>
    </PatientTabShell>
  );
}
