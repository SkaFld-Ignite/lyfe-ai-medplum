// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconShieldHalf, IconSparkles } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useClinicalDecision } from '../../hooks/useClinicalDecision';
import { INTERACTION_SEVERITY_LABELS, INTERACTION_SEVERITY_TONES } from '../../utils/clinical-decision';
import classes from './ClinicalDecision.module.css';

export interface DrugInteractionsCardProps {
  patientId: string;
}

/**
 * AI drug interaction review of the patient's active medication list.
 *
 * A rebuild of lyfe-provider-ui's interaction panel, with two differences that
 * are the reason this feature was portable at all.
 *
 * First, it runs against the patient's **real** active `MedicationRequest`
 * list, and the bot drops any interaction naming a drug that is not on it — prod
 * had the same intent but no such check, so a model naming a drug the patient
 * had stopped would have been rendered as a live warning.
 *
 * Second, there is no overall-risk headline. Prod's `calculateOverallRisk`
 * rolled the severities up into "CRITICAL" / "HIGH"; it was deterministic and so
 * invented nothing, but it added no information to the per-row severities while
 * reading like a validated score.
 *
 * Prod's four-pair `KNOWN_INTERACTIONS` table is not ported either — see the
 * header of `bots/shared/clinical-decision.ts`.
 * @param props - The patient whose medications to review.
 * @returns The card.
 */
export function DrugInteractionsCard(props: DrugInteractionsCardProps): JSX.Element {
  const { result, running, error, run } = useClinicalDecision({
    action: 'drug-interactions',
    patientId: props.patientId,
  });

  const medications = result?.medications ?? [];
  const interactions = result?.interactions ?? [];
  const tooFew = Boolean(result) && medications.length < 2;

  return (
    <Card withBorder shadow="sm" p="md">
      <Group justify="space-between" align="center" wrap="nowrap" mb="xs">
        <Group gap={8} wrap="nowrap">
          <IconShieldHalf size={18} />
          <Title order={5}>Interaction review</Title>
          <Badge size="sm" variant="light" leftSection={<IconSparkles size={10} />}>
            AI · advisory
          </Badge>
        </Group>
        <Button variant="default" size="compact-sm" onClick={run} loading={running} disabled={running}>
          {result ? 'Review again' : 'Check interactions'}
        </Button>
      </Group>

      {error && (
        <Alert color="red" icon={<IconAlertTriangle />} mb="xs">
          {error}
        </Alert>
      )}

      {!result && !running && !error && (
        <Text fz="sm" c="dimmed">
          Reviews this patient&rsquo;s active medications for interactions. Advisory only — not a substitute for a drug
          interaction database, and it will not catch everything.
        </Text>
      )}

      {result && (
        <Stack gap="xs">
          {medications.length > 0 && (
            <div>
              <Text fz={10} fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.12em' }} mb={4}>
                Reviewed · {medications.length} active medication{medications.length === 1 ? '' : 's'}
              </Text>
              <Group gap={4}>
                {medications.map((medication) => (
                  <Badge key={medication} size="sm" variant="outline" radius="sm">
                    {medication}
                  </Badge>
                ))}
              </Group>
            </div>
          )}

          {medications.length === 0 && (
            <Text fz="sm" c="dimmed">
              This patient has no active medications on the chart, so there is nothing to review.
            </Text>
          )}

          {tooFew && medications.length === 1 && (
            <Text fz="sm" c="dimmed">
              One active medication. An interaction needs two, so no review was run.
            </Text>
          )}

          {!tooFew && interactions.length === 0 && (
            <Group gap={6} wrap="nowrap">
              <IconCircleCheck size={14} />
              <Text fz="sm">No clinically significant interaction was identified between these medications.</Text>
            </Group>
          )}

          {interactions.map((interaction) => (
            <div
              key={interaction.drugs.join('||')}
              className={classes.row}
              data-tone={INTERACTION_SEVERITY_TONES[interaction.severity]}
            >
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Text fz="sm" fw={600}>
                  {interaction.drugs.join(' + ')}
                </Text>
                <Badge
                  size="sm"
                  radius="sm"
                  variant={interaction.severity === 'unknown' ? 'outline' : 'light'}
                  color={INTERACTION_SEVERITY_TONES[interaction.severity] === 'rose' ? 'red' : 'yellow'}
                >
                  {INTERACTION_SEVERITY_LABELS[interaction.severity]}
                </Badge>
              </Group>
              <Text fz="sm">{interaction.effect}</Text>
              {interaction.management && (
                <Text fz={11} c="dimmed">
                  Management: {interaction.management}
                </Text>
              )}
            </div>
          ))}

          <Text fz={10} c="dimmed">
            AI-generated and advisory. Every pair named above is on this patient&rsquo;s active medication list;
            anything the model named that is not has been discarded. Confirm against a drug interaction reference before
            acting.
          </Text>
        </Stack>
      )}
    </Card>
  );
}
