// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Dictate into a text field.
 *
 * lyfe-provider-ui's voice input was a mock: `processVoiceInput` in
 * `app/actions/patient-portal-ai-actions.ts` waited 1500ms on a `setTimeout` and
 * returned one of four canned transcripts with `confidence: 0.95`. None of that
 * is ported. Instead this wraps Medplum's own `useWhisper`, which streams real
 * microphone PCM to `packages/server/src/ws/ai-realtime.ts` and renders the
 * transcription events the upstream model sends back — so the text in the note
 * is what the clinician said, and if nothing can be transcribed the field stays
 * empty rather than filling with someone else's sentence.
 *
 * WHAT IT NEEDS TO WORK, AND WHAT HAPPENS WHEN THAT IS ABSENT
 * ----------------------------------------------------------
 * Three things, none of which this component can supply:
 *
 *  1. the `ai-realtime` **project feature**, which `handleAiRealtimeConnection`
 *     checks before it will proxy anything;
 *  2. an `OPENAI_API_KEY` **project secret** — the realtime transcription socket
 *     is OpenAI's own, so this is a real OpenAI key and NOT the LiteLLM base URL
 *     the `$ai` operation is pointed at for Bedrock;
 *  3. `aiRealtimeTranscriptionUrl` in the **server config**, which is the
 *     upstream the proxy dials.
 *
 * The feature flag is the one the browser can see, so it is the gate here —
 * exactly as `PromptComposer` gates its mic, with the same wording, because two
 * different explanations for one missing flag is worse than one. Without it the
 * control is rendered disabled with the reason in its tooltip rather than hidden
 * or, worse, enabled and silent.
 */
import { ActionIcon, Button, Group, Text, Tooltip } from '@mantine/core';
import { useMedplum, useWhisper } from '@medplum/react';
import { IconMicrophone, IconPlayerStopFilled } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import classes from './DictationButton.module.css';

export interface DictationButtonProps {
  /**
   * Called with each completed utterance, as the model finalises it.
   *
   * One call per utterance rather than one call at the end: the server's VAD
   * segments on silence, so this is how the text appears while the clinician is
   * still speaking. The caller appends — it owns the field's value and is the
   * only thing that knows where the caret is.
   */
  onTranscript: (text: string) => void;
  /** The field is read-only (for instance a signed and locked note). */
  disabled?: boolean;
  /** What is being dictated into, for the tooltip and the aria label. */
  target?: string;
}

/** Matches `PromptComposer`, so one deployment does not transcribe two ways. */
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

/** `PromptComposer`'s wording, verbatim. */
const DISABLED_TOOLTIP = 'Voice input is not enabled. Add the "ai-realtime" feature to enable it.';

/**
 * A microphone button that appends what it hears to a text field.
 * @param props - The transcript sink and the field's state.
 * @returns The control.
 */
export function DictationButton(props: DictationButtonProps): JSX.Element {
  const medplum = useMedplum();
  const enabled = medplum.getProject()?.features?.includes('ai-realtime') ?? false;
  const [startError, setStartError] = useState<string | undefined>(undefined);

  const { start, stop, status } = useWhisper({
    model: TRANSCRIBE_MODEL,
    onTranscript: (text) => {
      const trimmed = text.trim();
      if (trimmed) {
        props.onTranscript(trimmed);
      }
    },
  });

  const connecting = status === 'requesting_microphone' || status === 'connecting' || status === 'connected';
  const listening = status === 'listening' || status === 'speech_started' || status === 'speech_stopped';
  const active = connecting || listening;

  const onStart = useCallback(() => {
    setStartError(undefined);
    // `start` rejects when the browser refuses the microphone, which is the one
    // failure the clinician can fix themselves — so it is shown rather than only
    // logged.
    start().catch((err: unknown) => setStartError(err instanceof Error ? err.message : String(err)));
  }, [start]);

  const target = props.target ?? 'note';

  if (active) {
    return (
      <Group gap={8} wrap="nowrap">
        <span className={classes.indicator} data-state={listening ? 'listening' : 'connecting'}>
          <span aria-hidden className={classes.dot} />
          {listening ? 'Listening…' : 'Connecting…'}
        </span>
        <Button
          variant="light"
          color="red"
          size="compact-sm"
          leftSection={<IconPlayerStopFilled size={12} />}
          onClick={stop}
        >
          Stop dictation
        </Button>
      </Group>
    );
  }

  return (
    <Group gap={8} wrap="nowrap">
      <Tooltip label={enabled ? `Dictate into the ${target}` : DISABLED_TOOLTIP} position="top" withArrow multiline>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="lg"
          radius="md"
          onClick={onStart}
          disabled={!enabled || props.disabled}
          // Mantine removes pointer events from a disabled control, which would
          // also remove the tooltip that explains why it is disabled.
          style={!enabled ? { pointerEvents: 'auto' } : undefined}
          data-disabled={!enabled || undefined}
          aria-label={`Dictate into the ${target}`}
        >
          <IconMicrophone size={16} />
        </ActionIcon>
      </Tooltip>
      {status === 'error' && (
        <Text className={classes.error}>Dictation failed. Check the microphone permission and try again.</Text>
      )}
      {startError && <Text className={classes.error}>{startError}</Text>}
    </Group>
  );
}
