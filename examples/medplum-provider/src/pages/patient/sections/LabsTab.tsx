// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Anchor, Box, Group, ScrollArea, Text } from '@mantine/core';
import { IconAlertTriangle, IconFlask } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Sparkline } from '../../../components/patient-overview/Sparkline';
import { CategorySection } from '../../../components/patient-shell/CategorySection';
import type { RecordTone } from '../../../components/patient-shell/PatientRecordRow';
import { ToneBadge } from '../../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../../components/patient-shell/PatientTabShell';
import type { ShellView } from '../../../components/patient-shell/ShellToolbar';
import { ShellToolbar } from '../../../components/patient-shell/ShellToolbar';
import { useClinicTimeZone } from '../../../hooks/useClinicTimeZone';
import { usePatientResources } from '../../../hooks/usePatientResources';
import { formatFhirDate } from '../../../utils/clinic-time';
import type { LabFlag, LabResult } from '../../../utils/labs';
import { buildLabsModel } from '../../../utils/labs';
import { humanize, matchesQuery } from './section-utils';
import classes from './Sections.module.css';

const FLAG_LABEL: Record<LabFlag, string> = { H: 'High', L: 'Low', A: 'Abnormal' };
const FLAG_COLOR: Record<LabFlag, string> = { H: '#e11d48', L: '#2563eb', A: '#d97706' };
const FLAG_TONE: Record<LabFlag, RecordTone> = { H: 'rose', L: 'blue', A: 'amber' };
const REPORT_PARAMS = { _sort: '-date' };
const OBSERVATION_PARAMS = { category: 'laboratory', _sort: '-date' };

/**
 * The Lyfe "Labs" section: the patient's DrChrono lab results as panels with flags, reference
 * ranges and trends, and a strip of the latest abnormal results. Each panel opens its Medplum report.
 * @returns The labs tab.
 */
export function LabsTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const timeZone = useClinicTimeZone();
  const reports = usePatientResources('DiagnosticReport', patientId, REPORT_PARAMS);
  const observations = usePatientResources('Observation', patientId, OBSERVATION_PARAMS);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<ShellView>('grouped');

  const loading = reports.loading || observations.loading;
  const error = reports.error ?? observations.error;
  const model = useMemo(() => buildLabsModel(reports.items, observations.items), [reports.items, observations.items]);

  const panels = useMemo(
    () =>
      model.panels
        .map((panel) =>
          matchesQuery(query, [panel.title])
            ? panel
            : { ...panel, results: panel.results.filter((r) => matchesQuery(query, [r.label])) }
        )
        .filter((panel) => panel.results.length > 0 || (panel.report && matchesQuery(query, [panel.title]))),
    [model.panels, query]
  );
  const flat = useMemo(
    () => panels.flatMap((p) => p.results).sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0)),
    [panels]
  );

  const resultTable = (results: LabResult[], showDate: boolean): JSX.Element => (
    <ScrollArea type="auto">
      <table className={classes.labTable}>
        <thead>
          <tr>
            <th>Test</th>
            <th>Result</th>
            <th>Flag</th>
            <th>Reference range</th>
            {showDate && <th>Date</th>}
            <th>Trend</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const history = (model.history.get(r.analyteKey) ?? [])
              .map((h) => h.value)
              .filter((v): v is number => v !== undefined);
            return (
              <tr key={r.id} data-flag={r.flag}>
                <th scope="row">{r.label}</th>
                <td>
                  <span className={classes.labValue}>{r.display}</span>
                  {r.unit && <span className={classes.unit}> {r.unit}</span>}
                </td>
                <td>
                  {r.flag ? (
                    <ToneBadge label={FLAG_LABEL[r.flag]} tone={FLAG_TONE[r.flag]} />
                  ) : (
                    <span className={classes.emptyCell}>—</span>
                  )}
                </td>
                <td className={classes.unit}>{r.range ?? '—'}</td>
                {showDate && <td className={classes.unit}>{formatFhirDate(r.date?.toISOString(), timeZone) ?? '—'}</td>}
                <td className={classes.trendCell}>
                  {history.length > 1 ? (
                    <Sparkline
                      values={history}
                      color={r.flag ? FLAG_COLOR[r.flag] : '#10b981'}
                      width={96}
                      height={24}
                    />
                  ) : (
                    <span className={classes.emptyCell}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollArea>
  );

  return (
    <PatientTabShell
      icon={<IconFlask size={20} />}
      title="Lab Results"
      count={loading ? undefined : model.panels.length}
      description={
        loading
          ? 'Loading…'
          : `Lab panels from DrChrono (${model.results.length} results, ${model.latestAbnormals.length} abnormal)`
      }
      loading={loading}
      toolbar={
        <ShellToolbar
          search={{ value: query, onChange: setQuery, placeholder: 'Search panels or tests...' }}
          view={{ value: view, onChange: setView }}
        />
      }
      empty={
        panels.length === 0
          ? {
              icon: <IconFlask size={28} />,
              title: model.panels.length === 0 ? 'No lab results on record' : 'No results match',
              description:
                model.panels.length === 0
                  ? 'Lab results imported from DrChrono will appear here.'
                  : 'Try another search.',
            }
          : undefined
      }
    >
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} m="md">
          {error}
        </Alert>
      )}
      {model.latestAbnormals.length > 0 && !query && (
        <Box className={classes.abnormalStrip} component="section" aria-label="Latest abnormals">
          <Group gap={6} mb={8}>
            <IconAlertTriangle size={14} color="#e11d48" />
            <Text className={classes.matrixTitle} c="#be123c">
              Latest abnormals
            </Text>
          </Group>
          <div className={classes.abnormalGrid}>
            {model.latestAbnormals.slice(0, 8).map((r) => (
              <div key={r.id} className={classes.abnormalCard} data-flag={r.flag}>
                <Text fz={11.5} fw={600} c="dimmed" truncate>
                  {r.label}
                </Text>
                <Group gap={4} align="baseline" wrap="nowrap">
                  <Text fz={17} fw={700} c={r.flag ? FLAG_COLOR[r.flag] : undefined}>
                    {r.display}
                  </Text>
                  {r.unit && <span className={classes.unit}>{r.unit}</span>}
                  {r.flag && <span className={classes.unit}>({r.flag})</span>}
                </Group>
                <Text fz={10.5} c="dimmed">
                  {formatFhirDate(r.date?.toISOString(), timeZone)}
                  {r.range && ` · Ref ${r.range}`}
                </Text>
              </div>
            ))}
          </div>
        </Box>
      )}
      {view === 'grouped'
        ? panels.map((panel) => {
            const abnormal = panel.results.filter((r) => r.flag).length;
            const date = formatFhirDate(panel.date?.toISOString(), timeZone);
            return (
              <CategorySection
                key={panel.id}
                title={panel.title}
                count={panel.results.length}
                pills={
                  <>
                    {abnormal > 0 && <ToneBadge label={`${abnormal} abnormal`} tone="rose" />}
                    {panel.status && <ToneBadge label={humanize(panel.status) ?? panel.status} tone="slate" />}
                    {date && <span className={classes.unit}>{date}</span>}
                    {panel.performer && <span className={classes.unit}>· {panel.performer}</span>}
                  </>
                }
              >
                {panel.report && (
                  <Group justify="flex-end" px="md" pt={8}>
                    <Anchor
                      component={Link}
                      to={`/Patient/${patientId}/DiagnosticReport/${panel.report.id}`}
                      fz={12}
                      fw={600}
                    >
                      View report
                    </Anchor>
                  </Group>
                )}
                {panel.results.length > 0 ? (
                  resultTable(panel.results, false)
                ) : (
                  <Text fz="sm" c="dimmed" p="md">
                    No structured results in this report.
                  </Text>
                )}
              </CategorySection>
            );
          })
        : flat.length > 0 && resultTable(flat, true)}
    </PatientTabShell>
  );
}
