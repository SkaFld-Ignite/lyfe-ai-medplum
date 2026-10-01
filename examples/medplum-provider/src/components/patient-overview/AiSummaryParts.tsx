// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconArrowRight, IconShieldCheck } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import type { AlertRow, RiskRow, SummaryCitation, SummaryRow } from '../../utils/patient-ai-summary';
import classes from './AiSummary.module.css';

export type BlockTone = 'rose' | 'amber' | 'emerald' | 'sky';

/** The citation markers the bot writes: an index into the section's own `entry[]`. */
const MARKER_SPLIT = /(\[\d{1,3}\])/g;

export interface CitedTextProps {
  text: string;
  citations: SummaryCitation[];
  onOpen: (citation: SummaryCitation) => void;
}

/**
 * Render text with its `[n]` markers as clickable citation chips.
 *
 * The chip's tooltip and colour come from the citation itself — `Reference.display`
 * for the label, the referenced resource type for the tint — so no second read is
 * needed to show a provider what a number means. A marker with no matching
 * citation is left as plain text rather than rendered as a dead chip.
 * @param props - The text, its citations and the click handler.
 * @returns The text with chips inline.
 */
export function CitedText(props: CitedTextProps): JSX.Element {
  const byIndex = new Map(props.citations.map((citation) => [citation.index, citation]));
  return (
    <>
      {props.text.split(MARKER_SPLIT).map((part, i) => {
        const match = /^\[(\d{1,3})\]$/.exec(part);
        const citation = match ? byIndex.get(Number(match[1])) : undefined;
        if (!citation) {
          return <span key={i}>{part}</span>;
        }
        return (
          <Tooltip key={i} label={citation.label} position="top" withArrow multiline maw={280}>
            <UnstyledButton
              className={classes.citation}
              data-kind={citation.kind}
              onClick={() => props.onOpen(citation)}
              aria-label={`Open ${citation.label}`}
            >
              {part}
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </>
  );
}

export interface SummaryBlockProps {
  icon: ReactNode;
  tone: BlockTone;
  title: string;
  count: number;
  children: ReactNode;
}

/**
 * One of the four structured blocks: tinted icon tile, uppercase title, count pill.
 * The equivalent of prod's `SectionShell`.
 * @param props - The block props.
 * @returns The block card.
 */
export function SummaryBlock(props: SummaryBlockProps): JSX.Element {
  return (
    <Box component="section" aria-label={props.title} className={classes.block}>
      <div className={classes.blockHeader}>
        <h4 className={classes.blockTitle}>
          <span className={classes.blockTile} data-tone={props.tone}>
            {props.icon}
          </span>
          {props.title}
        </h4>
        <span className={classes.blockCount} data-tone={props.tone}>
          {props.count}
        </span>
      </div>
      <div className={classes.blockBody}>{props.children}</div>
    </Box>
  );
}

export interface RowProps {
  onOpen: (citation: SummaryCitation) => void;
}

/**
 * An alert: severity bar down the left, severity-tinted icon tile, the message
 * with its citations, then the recommended action.
 * @param props - The alert and the citation click handler.
 * @param props.alert - The alert row.
 * @param props.icon - The severity icon.
 * @returns The alert row.
 */
export function AlertRowView(props: RowProps & { alert: AlertRow; icon: ReactNode }): JSX.Element {
  const { alert } = props;
  return (
    <div className={classes.row}>
      <span aria-hidden className={classes.rowBar} data-severity={alert.severity} />
      <div className={`${classes.rowInner} ${classes.rowInset}`}>
        <span className={classes.rowTile} data-severity={alert.severity}>
          {props.icon}
        </span>
        <div className={classes.rowMain}>
          <Text component="p" className={classes.rowTitle}>
            <CitedText text={alert.headline} citations={alert.citations} onOpen={props.onOpen} />
          </Text>
          {alert.detail && (
            <p className={classes.rowDetail}>
              <IconArrowRight size={12} className={classes.rowDetailIcon} />
              <span>{alert.detail}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A risk factor: name and basis on the left, level badge on the right.
 * @param props - The risk and the citation click handler.
 * @param props.risk - The risk row.
 * @returns The risk row.
 */
export function RiskRowView(props: RowProps & { risk: RiskRow }): JSX.Element {
  const { risk } = props;
  return (
    <div className={classes.row}>
      <div className={classes.riskRow}>
        <div className={classes.rowMain}>
          <Text component="p" className={classes.rowTitleStrong}>
            <CitedText text={risk.headline} citations={risk.citations} onOpen={props.onOpen} />
          </Text>
          {risk.detail && <p className={classes.rowDetailPlain}>{risk.detail}</p>}
        </div>
        <span className={classes.levelBadge} data-level={risk.level}>
          <span className={classes.levelDot} />
          {risk.level}
        </span>
      </div>
    </div>
  );
}

/**
 * A next-visit focus area, numbered in the order the model ranked it.
 * @param props - The focus area, its ordinal and the citation click handler.
 * @param props.area - The focus-area row.
 * @param props.ordinal - 1-based position in the list.
 * @returns The focus-area row.
 */
export function FocusRowView(props: RowProps & { area: SummaryRow; ordinal: number }): JSX.Element {
  const { area } = props;
  return (
    <div className={classes.row}>
      <div className={classes.rowInner}>
        <span className={classes.focusNumber}>{props.ordinal}</span>
        <div className={classes.rowMain}>
          <Text component="p" className={classes.rowTitleStrong}>
            <CitedText text={area.headline} citations={area.citations} onOpen={props.onOpen} />
          </Text>
          {area.detail && <p className={classes.rowDetailPlain}>{area.detail}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * A care gap: what is missing, and how to close it.
 * @param props - The care gap and the citation click handler.
 * @param props.gap - The care-gap row.
 * @returns The care-gap row.
 */
export function CareGapRowView(props: RowProps & { gap: SummaryRow }): JSX.Element {
  const { gap } = props;
  return (
    <div className={classes.row}>
      <div className={classes.rowInner}>
        <span className={classes.rowTile} data-tone="amber">
          <IconShieldCheck size={12} />
        </span>
        <div className={classes.rowMain}>
          <Text component="p" className={classes.rowTitleStrong}>
            <CitedText text={gap.headline} citations={gap.citations} onOpen={props.onOpen} />
          </Text>
          {gap.detail && (
            <p className={classes.rowDetail}>
              <IconArrowRight size={12} className={classes.rowDetailIcon} data-tone="amber" />
              <span>{gap.detail}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
