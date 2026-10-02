// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge, Box, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import cx from 'clsx';
import type { JSX, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Markdown } from '../spaces/Markdown';
import { ResourceBox } from '../spaces/ResourceBox';
import type { CitationMatch } from './citations';
import { citationElementId, citedSources, dispatchSwitchTab, findCitationMatches } from './citations';
import classes from './CitedMarkdown.module.css';

/** How long a source card stays flashed after its pill is clicked. */
const FLASH_MS = 1600;

/**
 * Replaces the citation tokens in one string with pill buttons, leaving the rest of the
 * text alone.
 * @param text - One text leaf out of the rendered markdown.
 * @param nextKey - Supplies a React key unique within the message.
 * @param onDocClick - Called with the `Sn` label when a source pill is clicked.
 * @returns The string unchanged when it carries no citations, so the common case costs nothing;
 *   otherwise the text split around pill elements.
 */
function transformString(text: string, nextKey: () => number, onDocClick: (label: string) => void): ReactNode {
  const matches = findCitationMatches(text);
  if (matches.length === 0) {
    return text;
  }

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      parts.push(text.slice(cursor, match.index));
    }
    parts.push(renderPill(match, nextKey(), onDocClick));
    cursor = match.index + match.length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

function renderPill(match: CitationMatch, key: number, onDocClick: (label: string) => void): JSX.Element {
  if (match.kind === 'doc') {
    return (
      <button
        key={`doc-${key}`}
        type="button"
        title={`Source ${match.label}`}
        className={cx(classes.pill, classes.docPill)}
        onClick={() => onDocClick(match.label)}
      >
        {match.label}
      </button>
    );
  }
  return (
    <button
      key={`tab-${key}`}
      type="button"
      title={`Open ${match.label}`}
      className={cx(classes.pill, classes.tabPill)}
      onClick={() => dispatchSwitchTab(match.tab)}
    >
      {match.label}
    </button>
  );
}

interface CitedAssistantMessageProps {
  content: string;
  /** Resource references the message came back with; `[doc:Sn]` indexes into this list. */
  resources?: string[];
  /** Class for the message bubble, so the bubble styling stays with `SpacesInbox`. */
  bubbleClassName?: string;
  /** Opens a resource — the same handler the inline resource boxes use. */
  onSelectResource?: (reference: string) => void;
  /**
   * Put the source cards behind a collapsed `Sources (n)` line instead of listing them.
   *
   * On for the floating panel, off for the full-page chat. A week of appointments cites dozens of
   * resources, and in a 440px panel that strip is longer than the answer it supports; the page has
   * the column width to show them and a reader who came to the page came for the detail.
   */
  collapsibleSources?: boolean;
}

/**
 * An assistant message whose prose carries inline citations: a bubble of markdown with
 * clickable pills, and below it the strip of source cards the `[doc:Sn]` pills point at.
 * A `[meds]`-style pill instead asks the host to switch the chart section.
 *
 * ## Why the strip has its own control rather than folding into `Sources consulted`
 *
 * `SpacesInbox`'s `Sources consulted (n)` is a *row* built by `buildRenderRows` out of the turn's
 * tool-call messages, and it answers "what did it ask the server?". This strip belongs to one
 * assistant message and answers "what is this sentence based on?" — a different question, and one
 * that still has an answer for a turn that made no tool calls at all (a replayed conversation),
 * where no sources row is emitted. Folding them would also put the cards in a component that
 * `CitedAssistantMessage` does not own, so an inline pill could no longer open the disclosure it
 * needs to scroll to. Two controls, one line each, in the order the reader cares about them.
 * @param props - The message content, its resources, and how to open one.
 * @returns The rendered message.
 */
export function CitedAssistantMessage(props: CitedAssistantMessageProps): JSX.Element {
  const { content, resources, bubbleClassName, onSelectResource, collapsibleSources } = props;
  const [flashedLabel, setFlashedLabel] = useState<string | undefined>();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => clearTimeout(flashTimer.current);
  }, []);

  const sources = citedSources(content, resources);
  const sourcesVisible = !collapsibleSources || sourcesOpen;

  const handleDocClick = useCallback(
    (label: string): void => {
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlashedLabel(undefined), FLASH_MS);

      // A pill is a promise that the card it names can be reached, so clicking one opens the
      // strip. It never closes it: two pills in a row would otherwise toggle it shut.
      //
      // `flushSync` because a collapsed strip has no cards in the DOM at all — there is nothing to
      // scroll to until this state has been committed and rendered. Scrolling first would silently
      // do nothing, which looks to the reader like a pill that does not work.
      flushSync(() => {
        setFlashedLabel(label);
        setSourcesOpen(true);
      });
      document.getElementById(citationElementId(label))?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      const match = sources.find((s) => s.label === label);
      if (match && onSelectResource) {
        onSelectResource(match.reference);
      }
    },
    [onSelectResource, sources]
  );

  // A fresh counter per render keeps the pill keys stable and unique within the message.
  const transform = useCallback(
    (children: ReactNode): ReactNode => {
      let key = 0;
      const nextKey = (): number => key++;
      const walk = (node: ReactNode): ReactNode => {
        if (typeof node === 'string') {
          return transformString(node, nextKey, handleDocClick);
        }
        if (Array.isArray(node)) {
          return node.map(walk);
        }
        return node;
      };
      return walk(children);
    },
    [handleDocClick]
  );

  return (
    <>
      <div className={bubbleClassName}>
        <Markdown transform={transform}>{content}</Markdown>
      </div>
      {sources.length > 0 && (
        <Stack gap={6} mt="sm" w={300} maw="100%">
          {collapsibleSources ? (
            <UnstyledButton
              className={classes.stripToggle}
              onClick={() => setSourcesOpen((v) => !v)}
              aria-expanded={sourcesOpen}
              data-open={sourcesOpen ? 'true' : undefined}
            >
              <span className={classes.stripHeading}>Sources ({sources.length})</span>
              <IconChevronDown size={13} stroke={2.5} className={classes.stripChevron} />
            </UnstyledButton>
          ) : (
            <Text className={classes.stripHeading}>Sources</Text>
          )}
          {/* Rendered only when open, never hidden with CSS: a collapsed strip genuinely has no
              source cards in the DOM, and none of their `ResourceBox` reads are issued. */}
          {sourcesVisible &&
            sources.map(({ label, reference }) => (
              <div
                key={label}
                id={citationElementId(label)}
                className={classes.card}
                data-flashed={flashedLabel === label ? 'true' : undefined}
              >
                <Badge size="sm" variant="light" color="violet" className={classes.cardBadge}>
                  {label}
                </Badge>
                <Box className={classes.cardBody}>
                  <ResourceBox resourceReference={reference} onClick={(ref) => onSelectResource?.(ref)} />
                </Box>
              </div>
            ))}
        </Stack>
      )}
    </>
  );
}
