// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Box, Button, Group, Loader, Skeleton, Stack, Text, Tooltip } from '@mantine/core';
import { formatDateTime } from '@medplum/core';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconExternalLink,
  IconRefresh,
  IconRobot,
  IconShieldCheck,
  IconTarget,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { usePatientAiSummary } from '../../hooks/usePatientAiSummary';
import type { SummaryCitation } from '../../utils/patient-ai-summary';
import classes from './AiSummary.module.css';
import { AlertRowView, CareGapRowView, CitedText, FocusRowView, RiskRowView, SummaryBlock } from './AiSummaryParts';
import { OverviewSection } from './OverviewSection';

export interface AiSummaryCardProps {
  patientId: string;
}

type SummaryState = 'generating' | 'stale' | 'fresh' | 'cached';

/**
 * Which of the four header/footer states the card is in.
 *
 * `stale` beats `fresh` and `cached` because it is the only one that tells the
 * provider something actionable: the chart moved after this text was written.
 * @param props - What the card knows.
 * @param props.generating - The bot is running right now.
 * @param props.stale - `Composition.status` is `preliminary`.
 * @param props.regeneratedHere - This session asked for the summary on screen.
 * @returns The state name, used as a `data-state` attribute.
 */
function summaryState(props: { generating: boolean; stale: boolean; regeneratedHere: boolean }): SummaryState {
  if (props.generating) {
    return 'generating';
  }
  if (props.stale) {
    return 'stale';
  }
  return props.regeneratedHere ? 'fresh' : 'cached';
}

/**
 * The footer's one-line status, which says the same thing as the header badge in words.
 * @param props - The state and the generation time.
 * @param props.state - From {@link summaryState}.
 * @param props.generatedAt - `Composition.date`.
 * @returns The footer text.
 */
function footerText(props: { state: SummaryState; generatedAt?: string }): string {
  const written = formatDateTime(props.generatedAt);
  switch (props.state) {
    case 'generating':
      return 'Regenerating — writing summary…';
    case 'stale':
      return `Stale since the chart changed · written ${written}`;
    case 'fresh':
      return `Generated ${written}`;
    default:
      return `Cached ${written}`;
  }
}

/**
 * The AI patient summary card.
 *
 * A rebuild of lyfe-provider-ui's `AIPatientSummaryCard` on Mantine: the same
 * quote-style narrative, the same four tinted blocks in a two-column grid, the
 * same citation chips and sources footer. Two things from prod have no
 * counterpart here and are left out rather than faked — the document-extraction
 * progress bar (no extraction pipeline in this repo) and the thumbs-up/down
 * feedback widget (no `AIFeedbackWidget` equivalent yet).
 * @param props - The patient to summarise.
 * @returns The card.
 */
export function AiSummaryCard(props: AiSummaryCardProps): JSX.Element {
  const navigate = useNavigate();
  const { summary, loading, generating, error, reload, regenerate } = usePatientAiSummary(props.patientId);
  // Prod distinguished a summary it had just generated from one the server had
  // cached. Here the equivalent is whether this session asked for it — and only
  // if that ask succeeded, so a failed regenerate does not label the old summary
  // on screen as freshly written.
  const [requested, setRequested] = useState(false);
  const regeneratedHere = requested && !error;

  const onRegenerate = useCallback(() => {
    setRequested(true);
    regenerate();
  }, [regenerate]);

  const openCitation = useCallback(
    (citation: SummaryCitation) => {
      if (citation.reference) {
        navigate(`/Patient/${props.patientId}/${citation.reference}`)?.catch(console.error);
      }
    },
    [navigate, props.patientId]
  );

  const state = summaryState({ generating, stale: Boolean(summary?.stale), regeneratedHere });

  return (
    <OverviewSection
      icon={<IconRobot size={16} />}
      tone="indigo"
      title="AI Patient Summary"
      subtitle="Clinical intelligence"
      right={
        <div className={classes.headerActions}>
          {generating && (
            <span className={classes.badge} data-state="generating">
              <Loader size={8} color="violet" />
              Generating
            </span>
          )}
          {!generating && summary?.stale && (
            <Tooltip
              label="The chart changed after this summary was written. Refresh to regenerate it."
              position="bottom"
              withArrow
              multiline
              maw={260}
            >
              <span className={classes.badge} data-state="stale">
                <span className={classes.badgeDot} />
                Stale
              </span>
            </Tooltip>
          )}
          {!generating && summary && !summary.stale && (
            <Box
              component="span"
              className={classes.badge}
              data-state={regeneratedHere ? 'fresh' : 'cached'}
              visibleFrom="sm"
            >
              <span className={classes.badgeDot} />
              {regeneratedHere ? 'Fresh' : 'Cached'}
            </Box>
          )}
          <Tooltip label="Regenerate summary" position="bottom" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              radius="md"
              onClick={onRegenerate}
              disabled={loading || generating}
              aria-label="Regenerate summary"
            >
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        </div>
      }
    >
      {loading && !summary && (
        <Stack gap={8} p="md" aria-busy="true" aria-label="Loading AI summary">
          <Skeleton h={54} radius={12} />
          <Skeleton h={120} radius={12} />
        </Stack>
      )}

      {!loading && !summary && (
        <div className={classes.placeholder}>
          <Text className={classes.placeholderText}>
            {error ?? 'No summary yet. Generate one to see the narrative, alerts, risks and care gaps for this chart.'}
          </Text>
          <Group gap={8}>
            <Button variant="default" size="compact-sm" onClick={onRegenerate} loading={generating}>
              Generate now
            </Button>
            {error && (
              <Button variant="subtle" color="gray" size="compact-sm" onClick={reload}>
                Try again
              </Button>
            )}
          </Group>
        </div>
      )}

      {summary && (
        <div className={classes.body} data-busy={generating}>
          {error && <Text className={classes.placeholderText}>{error}</Text>}

          <div className={classes.narrative}>
            <span aria-hidden className={classes.narrativeBar} />
            <Text component="p" className={classes.narrativeText}>
              <CitedText
                text={summary.narrative.headline}
                citations={summary.narrative.citations}
                onOpen={openCitation}
              />
            </Text>
          </div>

          <div className={classes.blocks}>
            {summary.alerts.length > 0 && (
              <SummaryBlock
                icon={<IconAlertCircle size={12} />}
                tone="rose"
                title="Alerts"
                count={summary.alerts.length}
              >
                {summary.alerts.map((alert, i) => (
                  <AlertRowView key={i} alert={alert} icon={<IconAlertCircle size={12} />} onOpen={openCitation} />
                ))}
              </SummaryBlock>
            )}

            {summary.risks.length > 0 && (
              <SummaryBlock
                icon={<IconAlertTriangle size={12} />}
                tone="amber"
                title="Risk Factors"
                count={summary.risks.length}
              >
                {summary.risks.map((risk, i) => (
                  <RiskRowView key={i} risk={risk} onOpen={openCitation} />
                ))}
              </SummaryBlock>
            )}

            {summary.focusAreas.length > 0 && (
              <SummaryBlock
                icon={<IconTarget size={12} />}
                tone="emerald"
                title="Next Visit Focus"
                count={summary.focusAreas.length}
              >
                {summary.focusAreas.map((area, i) => (
                  <FocusRowView key={i} area={area} ordinal={i + 1} onOpen={openCitation} />
                ))}
              </SummaryBlock>
            )}

            {summary.careGaps.length > 0 && (
              <SummaryBlock
                icon={<IconShieldCheck size={12} />}
                tone="sky"
                title="Care Gaps"
                count={summary.careGaps.length}
              >
                {summary.careGaps.map((gap, i) => (
                  <CareGapRowView key={i} gap={gap} onOpen={openCitation} />
                ))}
              </SummaryBlock>
            )}
          </div>

          {summary.sources.length > 0 && (
            <div className={classes.sources}>
              <div className={classes.sourcesHeader}>
                <IconExternalLink size={12} />
                Sources · {summary.sources.length}
              </div>
              <div className={classes.sourcesChips}>
                {summary.sources.map((citation) => (
                  <Tooltip
                    key={citation.reference}
                    label={`${citation.resourceType} · ${citation.label}`}
                    position="bottom"
                    withArrow
                    multiline
                    maw={280}
                  >
                    <button
                      type="button"
                      className={classes.sourceChip}
                      data-kind={citation.kind}
                      onClick={() => openCitation(citation)}
                    >
                      <span className={classes.sourceChipLabel}>{citation.label}</span>
                      <IconExternalLink size={9} />
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}

          <div className={classes.footer}>
            <p className={classes.footerMeta}>
              <span className={classes.footerDot} data-state={state} />
              {footerText({ state, generatedAt: summary.generatedAt })}
            </p>
          </div>
        </div>
      )}
    </OverviewSection>
  );
}
