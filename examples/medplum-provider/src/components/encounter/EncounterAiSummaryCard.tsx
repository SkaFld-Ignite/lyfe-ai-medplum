// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Group, Loader, Skeleton, Stack, Text, Tooltip } from '@mantine/core';
import { formatDateTime } from '@medplum/core';
import {
  IconAlertTriangle,
  IconBrain,
  IconCalendar,
  IconCircleCheck,
  IconClipboardList,
  IconClock,
  IconFileText,
  IconListCheck,
  IconPill,
  IconRefresh,
  IconStethoscope,
} from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';
import { useEncounterAiSummary } from '../../hooks/useEncounterAiSummary';
import type { EncounterSummaryRow, SummaryKind } from '../../utils/encounter-ai-summary';
import { COMPOSITION_TITLES, formatPostVisitSummaryForNote } from '../../utils/encounter-ai-summary';
import type { SummaryCitation } from '../../utils/patient-ai-summary';
import aiClasses from '../patient-overview/AiSummary.module.css';
import type { BlockTone } from '../patient-overview/AiSummaryParts';
import { CitedText, SummaryBlock } from '../patient-overview/AiSummaryParts';
import { OverviewSection } from '../patient-overview/OverviewSection';
import classes from './EncounterAiSummary.module.css';

export interface EncounterAiSummaryCardProps {
  encounterId: string | undefined;
  patientId: string;
  /** Which summary this encounter gets, from `inferSummaryKind`. */
  kind: SummaryKind;
  /**
   * Append the rendered post-visit prose to the encounter's chart note. Omitted
   * when there is nothing to pull into (no `ClinicalImpression`) or the note is
   * signed and locked, and the button is then not rendered at all.
   */
  onPullIntoNote?: (text: string) => Promise<void>;
}

/** How each block is titled, tinted and iconed. Prod's per-section `h4` icons, one for one. */
const BLOCK_STYLE: Record<string, { tone: BlockTone; icon: ReactNode }> = {
  'relevant-history': { tone: 'sky', icon: <IconClipboardList size={12} /> },
  'recent-changes': { tone: 'amber', icon: <IconClock size={12} /> },
  'current-medications': { tone: 'emerald', icon: <IconPill size={12} /> },
  'prep-items': { tone: 'rose', icon: <IconListCheck size={12} /> },
  'key-findings': { tone: 'rose', icon: <IconStethoscope size={12} /> },
  'decisions-made': { tone: 'emerald', icon: <IconCircleCheck size={12} /> },
  'follow-up-plan': { tone: 'sky', icon: <IconCalendar size={12} /> },
  'unresolved-items': { tone: 'amber', icon: <IconAlertTriangle size={12} /> },
};

/** The two blocks prod coloured per item, and under which attribute. */
const TINTED_BLOCKS = new Set(['prep-items', 'key-findings']);

interface RowProps {
  row: EncounterSummaryRow;
  code: string;
  onOpen: (citation: SummaryCitation) => void;
}

/**
 * The right-hand badge a row carries, for the two blocks prod gave one.
 *
 * Recent changes get their significance as a filled pill (prod's `destructive` /
 * `secondary` Badge); follow-up items get their timeframe as an outline pill.
 * @param row - The row.
 * @param code - Its block code.
 * @returns The badge, or nothing.
 */
function rowPill(row: EncounterSummaryRow, code: string): JSX.Element | undefined {
  if (code === 'recent-changes' && row.qualifier) {
    return (
      <span className={`${classes.pill} ${classes.changePill}`} data-tone={row.qualifier}>
        {row.qualifier}
      </span>
    );
  }
  if (code === 'follow-up-plan' && row.detail) {
    return <span className={`${classes.pill} ${classes.timeframePill}`}>{row.detail}</span>;
  }
  return undefined;
}

/**
 * One row of a block.
 *
 * Four shapes, chosen by block code, which is exactly the four prod wrote by
 * hand: a tinted bar for prep items and key findings, a right-hand pill for
 * recent changes and follow-up timeframes, an amber card for unresolved items,
 * and a plain headline-plus-detail row for the rest.
 * @param props - The row, its block code and the citation click handler.
 * @returns The row.
 */
function SummaryRowView(props: RowProps): JSX.Element {
  const { row, code } = props;
  const tinted = TINTED_BLOCKS.has(code) && row.qualifier;
  const pill = rowPill(row, code);

  // The timeframe is the pill, so it must not also be printed as the detail line.
  const detail = code === 'follow-up-plan' ? undefined : row.detail;

  const className = [aiClasses.row, tinted ? classes.tinted : '', code === 'unresolved-items' ? classes.amber : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} {...(tinted && { 'data-tone': row.qualifier })}>
      <div className={pill ? aiClasses.riskRow : aiClasses.rowInner}>
        <div className={aiClasses.rowMain}>
          <Text component="p" className={aiClasses.rowTitleStrong}>
            <CitedText text={row.headline} citations={row.citations} onOpen={props.onOpen} />
          </Text>
          {detail && <p className={aiClasses.rowDetailPlain}>{detail}</p>}
        </div>
        {pill}
      </div>
    </div>
  );
}

/**
 * The pre-visit / post-visit encounter summary card.
 *
 * A rebuild of lyfe-provider-ui's `PreVisitSummaryView` and
 * `PostVisitSummaryView` (`components/patients/core/encounter-card.tsx`) on
 * Mantine: the same headline paragraph, the same four blocks in a two-column
 * grid, the same per-item colour coding, the same "Pull into note" action. Two
 * things from prod have no counterpart here and are left out rather than faked —
 * the thumbs-up/down `AIFeedbackWidget`, and the per-row click-through to a
 * patient tab, which has no equivalent route (the citation chips go to the actual
 * cited resource instead, which is strictly better than prod's "open the
 * conditions tab").
 * @param props - The encounter to summarise.
 * @returns The card.
 */
export function EncounterAiSummaryCard(props: EncounterAiSummaryCardProps): JSX.Element {
  const navigate = useNavigate();
  const { summary, loading, generating, error, reload, generate } = useEncounterAiSummary(
    props.encounterId,
    props.kind
  );
  const [pulling, setPulling] = useState(false);
  const [pullMessage, setPullMessage] = useState<string | undefined>(undefined);

  const openCitation = useCallback(
    (citation: SummaryCitation) => {
      if (citation.reference) {
        navigate(`/Patient/${props.patientId}/${citation.reference}`)?.catch(console.error);
      }
    },
    [navigate, props.patientId]
  );

  const onPull = useCallback(() => {
    if (!summary || !props.onPullIntoNote) {
      return;
    }
    setPulling(true);
    setPullMessage(undefined);
    props
      .onPullIntoNote(formatPostVisitSummaryForNote(summary))
      .then(() => setPullMessage('Summary added to the chart note'))
      .catch((err: unknown) => setPullMessage(err instanceof Error ? err.message : String(err)))
      .finally(() => setPulling(false));
  }, [props, summary]);

  const canPull = props.kind === 'post-visit' && Boolean(props.onPullIntoNote) && Boolean(summary);

  return (
    <OverviewSection
      icon={<IconBrain size={16} />}
      tone="indigo"
      title={COMPOSITION_TITLES[props.kind]}
      subtitle="Clinical intelligence"
      right={
        <div className={aiClasses.headerActions}>
          {generating && (
            <span className={aiClasses.badge} data-state="generating">
              <Loader size={8} color="violet" />
              Generating
            </span>
          )}
          {!generating && summary?.stale && (
            <Tooltip
              label="The encounter changed after this summary was written. Regenerate it."
              position="bottom"
              withArrow
              multiline
              maw={260}
            >
              <span className={aiClasses.badge} data-state="stale">
                <span className={aiClasses.badgeDot} />
                Stale
              </span>
            </Tooltip>
          )}
          {summary && (
            <Tooltip label="Regenerate summary" position="bottom" withArrow>
              <Button
                variant="subtle"
                color="gray"
                size="compact-xs"
                leftSection={<IconRefresh size={12} />}
                onClick={generate}
                disabled={loading || generating}
              >
                Regenerate
              </Button>
            </Tooltip>
          )}
        </div>
      }
    >
      {loading && !summary && (
        <Stack gap={8} p="md" aria-busy="true" aria-label="Loading encounter summary">
          <Skeleton h={48} radius={12} />
          <Skeleton h={110} radius={12} />
        </Stack>
      )}

      {!loading && !summary && (
        <div className={aiClasses.placeholder}>
          <Text className={aiClasses.placeholderText}>
            {error ??
              (props.kind === 'pre-visit'
                ? 'No briefing yet. Generate one to see the reason for the visit, relevant history and what to have ready.'
                : 'No summary yet. Generate one to see this visit’s findings, decisions and follow-up.')}
          </Text>
          <Group gap={8}>
            <Button
              variant="default"
              size="compact-sm"
              leftSection={<IconBrain size={14} />}
              onClick={generate}
              loading={generating}
              disabled={!props.encounterId}
            >
              Generate {COMPOSITION_TITLES[props.kind]}
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
        <div className={aiClasses.body} data-busy={generating}>
          {error && <Text className={aiClasses.placeholderText}>{error}</Text>}

          <div className={aiClasses.narrative}>
            <span aria-hidden className={aiClasses.narrativeBar} />
            <Text component="p" className={aiClasses.narrativeText}>
              <CitedText
                text={summary.headline.headline}
                citations={summary.headline.citations}
                onOpen={openCitation}
              />
            </Text>
          </div>

          <div className={aiClasses.blocks}>
            {summary.blocks.map((block) => (
              <SummaryBlock
                key={block.code}
                icon={BLOCK_STYLE[block.code]?.icon}
                tone={BLOCK_STYLE[block.code]?.tone ?? 'sky'}
                title={block.title}
                count={block.rows.length}
              >
                {block.rows.map((row, i) => (
                  <SummaryRowView key={i} row={row} code={block.code} onOpen={openCitation} />
                ))}
              </SummaryBlock>
            ))}
          </div>

          <div className={`${aiClasses.footer} ${classes.footerRow}`}>
            {canPull ? (
              <Group gap={8}>
                <Button
                  variant="subtle"
                  color="violet"
                  size="compact-sm"
                  leftSection={<IconFileText size={12} />}
                  onClick={onPull}
                  loading={pulling}
                >
                  Pull into note
                </Button>
                {pullMessage && <Text className={aiClasses.placeholderText}>{pullMessage}</Text>}
              </Group>
            ) : (
              <Box />
            )}
            <p className={aiClasses.footerMeta}>
              <span className={aiClasses.footerDot} data-state={generating ? 'generating' : 'fresh'} />
              Generated {formatDateTime(summary.generatedAt)}
            </p>
          </div>
        </div>
      )}
    </OverviewSection>
  );
}
