// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Badge, Button, Card, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCode, IconInfoCircle, IconShieldCheck, IconSparkles } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useClinicalDecision } from '../../hooks/useClinicalDecision';
import classes from './ClinicalDecision.module.css';

export interface IcdSuggestionsCardProps {
  encounterId: string | undefined;
}

/**
 * AI-suggested ICD-10-CM codes for an encounter.
 *
 * A rebuild of the ICD tab of lyfe-provider-ui's `clinical-documentation.tsx`,
 * which was exported and never mounted. Two things from that UI are deliberately
 * not here:
 *
 * - its **"95% confidence" chip**, because `suggestICDCodes` had no way to
 *   compute one and its fallback path returned four canned oncology codes with
 *   hardcoded confidences of 0.95 / 0.9 / 0.88 / 0.75. What replaces it is the
 *   `basis` line — the documented finding each code was drawn from — and a
 *   verified badge set by the terminology server;
 * - its **"Add" button**, which had no `onClick`. A code is added as a
 *   `Condition` through the diagnosis list beside this card, which is the
 *   surface that already writes one.
 * @param props - The encounter to code.
 * @returns The card.
 */
export function IcdSuggestionsCard(props: IcdSuggestionsCardProps): JSX.Element {
  const { result, running, error, run } = useClinicalDecision({
    action: 'icd-codes',
    encounterId: props.encounterId,
  });

  const suggestions = result?.suggestions ?? [];
  const unverified = result?.terminologyAvailable === false;

  return (
    <Card withBorder shadow="sm" p="md">
      <Group justify="space-between" align="center" wrap="nowrap" mb="xs">
        <Group gap={8} wrap="nowrap">
          <IconCode size={18} />
          <Title order={5}>Coding suggestions</Title>
          <Badge size="sm" variant="light" leftSection={<IconSparkles size={10} />}>
            AI · advisory
          </Badge>
        </Group>
        <Button
          variant="default"
          size="compact-sm"
          onClick={run}
          loading={running}
          disabled={!props.encounterId || running}
        >
          {result ? 'Run again' : 'Suggest codes'}
        </Button>
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} mb="xs">
          {error}
        </Alert>
      )}

      {!result && !running && !error && (
        <Text fz="sm" c="dimmed">
          Suggests ICD-10-CM codes from the conditions and the chart note this encounter already documents. Every code
          is checked against ICD-10-CM before it is shown, and none is added to the chart — verify before billing.
        </Text>
      )}

      {result && (
        <Stack gap="xs">
          {unverified && (
            <Alert color="yellow" icon={<IconInfoCircle />} title="Codes were not checked against ICD-10-CM">
              The <code>icd-10-cm</code> code system is not loaded in this project, so these codes could not be verified
              to exist. Check each one against your coding reference before use.
            </Alert>
          )}

          {suggestions.length === 0 && (
            <Text fz="sm" c="dimmed">
              No additional code is supported by what this encounter documents.
              {result.documented && result.documented.length > 0 && ' The diagnoses already coded are listed below.'}
            </Text>
          )}

          {suggestions.map((suggestion) => (
            <div key={suggestion.code} className={classes.row}>
              <Group gap={8} wrap="nowrap" align="flex-start">
                <code className={classes.code}>{suggestion.code}</code>
                {suggestion.verified ? (
                  <Tooltip label="This code exists in ICD-10-CM" position="top" withArrow>
                    <Badge size="xs" variant="light" color="teal" leftSection={<IconShieldCheck size={9} />}>
                      Verified
                    </Badge>
                  </Tooltip>
                ) : (
                  <Badge size="xs" variant="light" color="gray">
                    Unverified
                  </Badge>
                )}
              </Group>
              <Text fz="sm" fw={500}>
                {suggestion.description}
              </Text>
              {/* The audit line. Prod showed a confidence percentage here; this
                  says where the code came from, which a coder can check. */}
              <Text fz={11} c="dimmed">
                From: {suggestion.basis}
              </Text>
            </div>
          ))}

          {result.documented && result.documented.length > 0 && (
            <div>
              <Text fz={10} fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.12em' }} mb={4}>
                Already coded on this chart
              </Text>
              <Group gap={4}>
                {result.documented.map((coding) => (
                  <Tooltip key={coding.code} label={coding.display ?? coding.code} position="top" withArrow>
                    <Badge size="sm" variant="outline" radius="sm">
                      {coding.code}
                    </Badge>
                  </Tooltip>
                ))}
              </Group>
            </div>
          )}

          <Text fz={10} c="dimmed">
            AI-generated suggestions based only on this encounter&rsquo;s own documentation. Nothing here has been added
            to the chart. Verify accuracy before billing submission.
          </Text>
        </Stack>
      )}
    </Card>
  );
}
