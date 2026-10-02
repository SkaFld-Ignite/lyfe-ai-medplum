// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import {
  IconAlertTriangle,
  IconFileText,
  IconInfoCircle,
  IconSearch,
  IconSparkles,
  IconZoomQuestion,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CategorySection } from '../../components/patient-shell/CategorySection';
import { PatientRecordRow } from '../../components/patient-shell/PatientRecordRow';
import { PatientTabShell } from '../../components/patient-shell/PatientTabShell';
import { useChartSearch } from '../../hooks/useChartSearch';
import { useClinicTimeZone } from '../../hooks/useClinicTimeZone';
import type { ChartSearchHit } from '../../utils/chart-search';
import { groupHitsByKind, SEARCH_KIND_LABELS } from '../../utils/chart-search';
import { formatFhirDate } from '../../utils/clinic-time';

/** Example questions, shown before the first search. Phrased to show the expansion. */
const EXAMPLES = [
  'Any history of HTN?',
  'Is he on a blood thinner?',
  'Recent kidney function',
  'Anything about a GI bleed in the notes?',
];

/**
 * Natural-language search over one patient's chart.
 *
 * Replaces lyfe-provider-ui's `unified-search-service` / `ai-search-service`
 * pair. The model is used for one thing — turning the question into record types
 * and synonym-expanded terms — and every row on screen came out of a real query:
 * a FHIR `:text` search run by `bots/chart-search.ts`, or the pgvector document
 * index run by the worker. Prod's document and procedure legs returned hardcoded
 * mock arrays and are not ported; see `bots/shared/chart-search.ts`.
 *
 * There is no confidence score on this screen. Prod's schema had one and its
 * siblings filled the same field with a hardcoded number. What the clinician
 * gets instead is the interpretation and the exact terms searched, both of which
 * can be checked against the results.
 * @returns The chart search tab.
 */
export function ChartSearchTab(): JSX.Element {
  const { patientId = '' } = useParams();
  const navigate = useNavigate();
  const timeZone = useClinicTimeZone();
  const { answer, searching, error, search } = useChartSearch(patientId);
  const [query, setQuery] = useState('');

  const run = (text?: string): void => {
    const next = text ?? query;
    if (text !== undefined) {
      setQuery(text);
    }
    search(next);
  };

  const row = (hit: ChartSearchHit): JSX.Element => (
    <PatientRecordRow
      key={`${hit.reference}-${hit.kind}`}
      icon={hit.kind === 'document' ? <IconFileText size={20} /> : <IconSearch size={20} />}
      title={hit.title}
      badges={hit.detail ? [{ label: hit.detail, tone: 'slate' }] : undefined}
      meta={[formatFhirDate(hit.date, timeZone), hit.resourceType]}
      // The document rows carry the matched excerpt; the structured rows carry
      // their status or value in the badge, so there is nothing to repeat here.
      description={hit.kind === 'document' ? hit.detail : undefined}
      actionLabel="Open"
      onAction={() => navigate(`/Patient/${patientId}/${hit.reference}`)?.catch(console.error)}
    />
  );

  const groups = answer ? groupHitsByKind({ hits: answer.hits, kinds: answer.kinds }) : [];
  const noTerms = answer?.terms.length === 0;

  return (
    <PatientTabShell
      icon={<IconZoomQuestion size={20} />}
      title="Chart Search"
      count={answer && !noTerms ? answer.hits.length : undefined}
      description={
        answer
          ? `Results for “${answer.query}”`
          : 'Ask a question in plain language. Abbreviations and brand names are expanded before the chart is searched.'
      }
      loading={searching}
      toolbar={
        <Group gap={8} p="md" wrap="nowrap">
          <TextInput
            flex={1}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                run();
              }
            }}
            leftSection={<IconSearch size={16} />}
            placeholder="e.g. any history of HTN?"
            aria-label="Chart search question"
            disabled={searching}
          />
          <Button onClick={() => run()} loading={searching} disabled={!query.trim()}>
            Search
          </Button>
        </Group>
      }
      empty={
        !answer && !searching && !error
          ? {
              icon: <IconZoomQuestion size={28} />,
              title: 'Ask about this chart',
              description: 'Conditions, medications, allergies, labs, vitals, encounters, procedures and documents.',
            }
          : undefined
      }
    >
      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} m="md">
          {error}
        </Alert>
      )}

      {!answer && !searching && !error && (
        <Group gap={6} px="md" pb="md">
          {EXAMPLES.map((example) => (
            <Button key={example} variant="default" size="compact-xs" onClick={() => run(example)}>
              {example}
            </Button>
          ))}
        </Group>
      )}

      {answer && (
        <Stack gap="md" p="md">
          <Paper withBorder radius="md" p="sm">
            <Stack gap={6}>
              <Group gap={6} wrap="nowrap">
                <IconSparkles size={13} />
                <Text fz={10} fw={700} tt="uppercase" style={{ letterSpacing: '0.12em' }}>
                  AI-interpreted search · advisory
                </Text>
              </Group>
              {answer.interpretation && <Text fz="sm">{answer.interpretation}</Text>}
              {answer.terms.length > 0 && (
                <Group gap={4}>
                  <Text fz={11} c="dimmed">
                    Searched for:
                  </Text>
                  {answer.terms.map((term) => (
                    <Badge key={term} size="sm" variant="light" radius="sm">
                      {term}
                    </Badge>
                  ))}
                </Group>
              )}
              <Text fz={10} c="dimmed">
                An AI model chose these terms and which parts of the chart to search. Every result below is a real
                record returned by that search — nothing on this screen is model-written.
              </Text>
            </Stack>
          </Paper>

          {noTerms && (
            <Alert color="yellow" icon={<IconInfoCircle />}>
              That question names no clinical concept to search for. Try naming a condition, a drug, a lab or a
              procedure.
            </Alert>
          )}

          {answer.documentNote && (
            <Alert color="yellow" icon={<IconInfoCircle />} title="Documents were not searched">
              {answer.documentNote}
            </Alert>
          )}

          {!noTerms &&
            groups.map((group) =>
              // A searched kind with no matches is shown, not hidden. "Nothing in
              // medications" and "medications were not searched" are different
              // answers to a clinical question.
              group.hits.length === 0 ? (
                <CategorySection key={group.kind} title={SEARCH_KIND_LABELS[group.kind]} count={0} defaultOpen={false}>
                  <Text fz="sm" c="dimmed" p="sm">
                    No {SEARCH_KIND_LABELS[group.kind].toLowerCase()} matched these terms.
                  </Text>
                </CategorySection>
              ) : (
                <CategorySection
                  key={group.kind}
                  title={SEARCH_KIND_LABELS[group.kind]}
                  count={group.hits.length}
                  activeCount={group.hits.length}
                >
                  {group.hits.map(row)}
                </CategorySection>
              )
            )}
        </Stack>
      )}
    </PatientTabShell>
  );
}
