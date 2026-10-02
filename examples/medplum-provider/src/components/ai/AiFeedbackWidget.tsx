// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Button, Group, Text, Textarea, Tooltip } from '@mantine/core';
import { IconCheck, IconMessage, IconPencil, IconThumbDown, IconThumbUp, IconX } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { useAiFeedback } from '../../hooks/useAiFeedback';
import type { AiFeedbackTarget, FeedbackRating } from '../../utils/ai-feedback';
import classes from './AiFeedbackWidget.module.css';

export interface AiFeedbackWidgetProps {
  /**
   * Who is rating what. `undefined` while the rated document is still loading,
   * or when the session has no profile to credit — the widget renders nothing
   * rather than offering a control that cannot save.
   */
  target: AiFeedbackTarget | undefined;
  /**
   * The AI text on screen, used to seed the correction editor so the clinician
   * edits rather than retypes. Optional: with nothing to seed, the editor opens
   * empty and still saves.
   */
  originalContent?: string;
  /**
   * Called with the clinician's corrected text once it is saved, so the card can
   * show their version in place of the model's.
   */
  onContentEdited?: (text: string) => void;
  /** Rating only — no comment or correction. For tight footers. */
  compact?: boolean;
}

type Panel = 'none' | 'comment' | 'correction';

/**
 * Thumbs up/down, a comment and a correction on an AI-generated document.
 *
 * A Mantine rebuild of lyfe-provider-ui's `AIFeedbackWidget`: the same inline
 * row of four ghost icon buttons with tinted active states, the same two
 * mutually exclusive panels beneath, the same "Feedback saved" confirmation.
 * What it writes is a FHIR `Communication` rather than an `ai_feedback` row —
 * see `src/utils/ai-feedback.ts` for why that resource and not `Provenance`.
 * @param props - The target and the text being rated.
 * @returns The widget, or nothing when there is no target to rate.
 */
export function AiFeedbackWidget(props: AiFeedbackWidgetProps): JSX.Element | null {
  const { feedback, loading, saving, error, saved, submit } = useAiFeedback(props.target);
  const [panel, setPanel] = useState<Panel>('none');
  // `undefined` means "nothing typed in this session", so the field shows what
  // is stored. Derived rather than seeded by an effect: the stored record
  // arrives after the first render, and copying it into state there would be a
  // synchronous setState inside an effect — a cascading render, and what
  // `react-hooks/set-state-in-effect` exists to catch. A save clears the draft
  // back to `undefined` so the field re-derives from what was actually stored.
  const [draftComment, setDraftComment] = useState<string | undefined>(undefined);
  const [draftCorrection, setDraftCorrection] = useState<string | undefined>(undefined);
  const commentValue = draftComment ?? feedback.comment ?? '';
  const correctionValue = draftCorrection ?? feedback.correction ?? '';

  const rate = useCallback(
    (rating: FeedbackRating) => {
      // A second click on the active thumb clears the rating. Prod's widget
      // appeared to do this but did not: it sent `undefined`, which its server
      // action read as "leave it alone", so the vote stayed in the database
      // while the UI showed none. Clearing here is explicit and does persist.
      submit({ rating: feedback.rating === rating ? undefined : rating });
    },
    [feedback.rating, submit]
  );

  const openPanel = useCallback(
    (next: Panel) => {
      setPanel((current) => (current === next ? 'none' : next));
      // Seed the editor with the text on screen, so the clinician corrects it
      // rather than retyping it. Only when there is nothing of theirs to lose.
      if (next === 'correction' && !correctionValue && props.originalContent) {
        setDraftCorrection(props.originalContent);
      }
    },
    [correctionValue, props.originalContent]
  );

  const saveComment = useCallback(() => {
    submit({ comment: commentValue.trim() || undefined });
    setDraftComment(undefined);
    setPanel('none');
  }, [commentValue, submit]);

  const saveCorrection = useCallback(() => {
    const text = correctionValue.trim();
    submit({ correction: text || undefined });
    setDraftCorrection(undefined);
    setPanel('none');
    if (text) {
      props.onContentEdited?.(text);
    }
  }, [correctionValue, props, submit]);

  if (!props.target) {
    return null;
  }

  const busy = loading || saving;

  return (
    <div className={classes.root}>
      <Group gap={2} wrap="nowrap">
        <Tooltip label="Helpful" position="top" withArrow>
          <ActionIcon
            variant="subtle"
            size="md"
            radius="md"
            className={classes.action}
            data-active={feedback.rating === 'thumbs-up' || undefined}
            data-tone="up"
            disabled={busy}
            aria-label="Helpful"
            aria-pressed={feedback.rating === 'thumbs-up'}
            onClick={() => rate('thumbs-up')}
          >
            <IconThumbUp size={14} />
          </ActionIcon>
        </Tooltip>

        <Tooltip label="Not helpful" position="top" withArrow>
          <ActionIcon
            variant="subtle"
            size="md"
            radius="md"
            className={classes.action}
            data-active={feedback.rating === 'thumbs-down' || undefined}
            data-tone="down"
            disabled={busy}
            aria-label="Not helpful"
            aria-pressed={feedback.rating === 'thumbs-down'}
            onClick={() => rate('thumbs-down')}
          >
            <IconThumbDown size={14} />
          </ActionIcon>
        </Tooltip>

        {!props.compact && (
          <>
            <span aria-hidden className={classes.divider} />

            <Tooltip label="Add comment" position="top" withArrow>
              <ActionIcon
                variant="subtle"
                size="md"
                radius="md"
                className={classes.action}
                data-active={panel === 'comment' || Boolean(feedback.comment) || undefined}
                data-tone="comment"
                disabled={busy}
                aria-label="Add comment"
                aria-expanded={panel === 'comment'}
                onClick={() => openPanel('comment')}
              >
                <IconMessage size={14} />
              </ActionIcon>
            </Tooltip>

            <Tooltip label="Edit & correct" position="top" withArrow>
              <ActionIcon
                variant="subtle"
                size="md"
                radius="md"
                className={classes.action}
                data-active={panel === 'correction' || Boolean(feedback.correction) || undefined}
                data-tone="correction"
                disabled={busy}
                aria-label="Edit and correct"
                aria-expanded={panel === 'correction'}
                onClick={() => openPanel('correction')}
              >
                <IconPencil size={14} />
              </ActionIcon>
            </Tooltip>
          </>
        )}

        {saved && !saving && (
          <span className={classes.savedNote}>
            <IconCheck size={11} />
            Feedback saved
          </span>
        )}
        {error && <Text className={classes.errorNote}>{error}</Text>}
      </Group>

      {panel === 'comment' && (
        <div className={classes.panel}>
          <Textarea
            autosize
            minRows={2}
            maxRows={6}
            value={commentValue}
            onChange={(event) => setDraftComment(event.currentTarget.value)}
            placeholder="What could be improved? Any inaccuracies?"
            aria-label="Feedback comment"
          />
          <Group gap={6} justify="flex-end">
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              leftSection={<IconX size={11} />}
              onClick={() => {
                setDraftComment(undefined);
                setPanel('none');
              }}
            >
              Cancel
            </Button>
            <Button
              size="compact-xs"
              leftSection={<IconCheck size={11} />}
              onClick={saveComment}
              disabled={saving || !commentValue.trim()}
            >
              Save comment
            </Button>
          </Group>
        </div>
      )}

      {panel === 'correction' && (
        <div className={`${classes.panel} ${classes.correctionPanel}`}>
          <Text className={classes.panelHint}>
            Correct the text as it should read. Your version is stored on the chart alongside the model&rsquo;s.
          </Text>
          <Textarea
            autosize
            minRows={3}
            maxRows={14}
            value={correctionValue}
            onChange={(event) => setDraftCorrection(event.currentTarget.value)}
            placeholder="The corrected text"
            aria-label="Corrected text"
          />
          <Group gap={6} justify="flex-end">
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              leftSection={<IconX size={11} />}
              onClick={() => {
                setDraftCorrection(undefined);
                setPanel('none');
              }}
            >
              Cancel
            </Button>
            <Button
              size="compact-xs"
              color="violet"
              leftSection={<IconCheck size={11} />}
              onClick={saveCorrection}
              disabled={saving || !correctionValue.trim()}
            >
              Save correction
            </Button>
          </Group>
        </div>
      )}
    </div>
  );
}
