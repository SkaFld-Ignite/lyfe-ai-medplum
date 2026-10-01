// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  Alert,
  Badge,
  Button,
  Code,
  Drawer,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { formatDateTime } from '@medplum/core';
import { IconAlertCircle, IconCheck, IconEdit, IconRefresh, IconSend, IconSparkles, IconX } from '@tabler/icons-react';
import type { JSX } from 'react';
import { useState } from 'react';
import { useSoapNote } from '../../hooks/useSoapNote';
import type { SoapNarratives } from '../../utils/soap-note';
import { toDrChronoFields } from '../../utils/soap-note';

export interface SoapNoteDrawerProps {
  encounterId: string;
  patientName: string;
  encounterDate?: string;
  opened: boolean;
  onClose: () => void;
}

/** Each editable block, in reading order, with the label the drawer shows. */
const BLOCKS: { key: keyof SoapNarratives; label: string; single?: boolean }[] = [
  { key: 'chiefComplaint', label: 'Chief Complaint', single: true },
  { key: 'subjective', label: 'Subjective' },
  { key: 'objective', label: 'Objective' },
  { key: 'assessment', label: 'Assessment' },
  { key: 'plan', label: 'Plan' },
];

const EMPTY: SoapNarratives = {
  chiefComplaint: '',
  subjective: '',
  objective: '',
  assessment: '',
  plan: '',
};

/**
 * The SOAP note review panel.
 *
 * A rebuild of lyfe-provider-ui's `SOAPReviewPanel` on Mantine: its shadcn
 * `Sheet` is a right-hand `Drawer`, its `Card`s are `Paper`s, and its
 * hand-rolled `fixed inset-0` confirmation overlay — a div with a backdrop and
 * no focus trap or escape handling — is a real `Modal`.
 *
 * The one deliberate difference in substance: prod edited the *structured*
 * draft, a textarea per field plus one per diagnosis and plan item, and
 * re-rendered the DrChrono payload from it on submit. Here the stored form **is**
 * the rendered text, so the provider edits the five blocks that will be
 * transmitted. That is why the submit preview can be computed locally and is
 * guaranteed to be what DrChrono receives, rather than a second rendering that
 * might disagree with the first.
 *
 * The body is a child component so that Mantine's default `keepMounted={false}`
 * unmounts it on close. That is what resets a half-finished edit, and it also
 * keeps the drawer from reading the note — two searches — for every encounter the
 * provider merely opens the chart of.
 * @param props - The encounter to review.
 * @returns The drawer.
 */
export function SoapNoteDrawer(props: SoapNoteDrawerProps): JSX.Element {
  const { encounterId, patientName, encounterDate, opened, onClose } = props;
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        <Stack gap={2}>
          <Title order={4}>SOAP Note</Title>
          <Text size="sm" c="dimmed">
            {patientName}
            {encounterDate ? ` — ${formatDateTime(encounterDate)}` : ''}
          </Text>
        </Stack>
      }
    >
      <SoapNoteBody encounterId={encounterId} />
    </Drawer>
  );
}

/**
 * The drawer's contents: the note, the action bar and the submit confirmation.
 * @param props - The encounter to review.
 * @param props.encounterId - The encounter the note documents.
 * @returns The body.
 */
function SoapNoteBody({ encounterId }: { encounterId: string }): JSX.Element {
  const { note, loading, busy, error, drChronoNoteId, generate, save, approve, revert, push } =
    useSoapNote(encounterId);

  const [edits, setEdits] = useState<SoapNarratives | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const editing = Boolean(edits);
  const narratives = edits ?? note?.narratives ?? EMPTY;
  const preview = toDrChronoFields(note?.narratives ?? EMPTY);

  const saveEdit = (): void => {
    if (edits) {
      save(edits);
      setEdits(undefined);
    }
  };

  return (
    <Stack gap="md">
      {note && (
        <Group gap="xs">
          <Badge variant="light" color={note.approved ? 'green' : 'yellow'}>
            {note.approved ? 'Approved' : 'Draft'}
          </Badge>
          {drChronoNoteId && (
            <Badge variant="light" color="blue">
              In DrChrono · note {drChronoNoteId}
            </Badge>
          )}
          {note.generatedAt && (
            <Text size="xs" c="dimmed">
              Generated {formatDateTime(note.generatedAt)}
            </Text>
          )}
        </Group>
      )}

      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />} title="That didn't work">
          {error}
        </Alert>
      )}

      {loading && (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      )}

      {!loading && !note && (
        <Stack align="center" gap="sm" py="xl">
          <IconSparkles size={32} opacity={0.4} />
          <Text fw={500}>No SOAP draft yet</Text>
          <Text size="sm" c="dimmed" ta="center">
            Draft a SOAP note from this encounter&apos;s chart notes, diagnoses, vitals and labs.
          </Text>
          <Button leftSection={<IconSparkles size={16} />} loading={busy === 'generate'} onClick={generate}>
            Generate SOAP Draft
          </Button>
        </Stack>
      )}

      {!loading && note && (
        <>
          <Group gap="xs">
            {!note.approved && !editing && (
              <>
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconEdit size={14} />}
                  onClick={() => setEdits(note.narratives)}
                  disabled={Boolean(busy)}
                >
                  Edit
                </Button>
                <Button size="xs" leftSection={<IconCheck size={14} />} loading={busy === 'approve'} onClick={approve}>
                  Approve
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconRefresh size={14} />}
                  loading={busy === 'generate'}
                  onClick={generate}
                >
                  Regenerate
                </Button>
              </>
            )}

            {editing && (
              <>
                <Button size="xs" leftSection={<IconCheck size={14} />} loading={busy === 'save'} onClick={saveEdit}>
                  Save Changes
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconX size={14} />}
                  onClick={() => setEdits(undefined)}
                >
                  Cancel
                </Button>
              </>
            )}

            {note.approved && !editing && (
              <>
                <Button
                  size="xs"
                  variant="default"
                  loading={busy === 'revert'}
                  onClick={revert}
                  disabled={Boolean(busy)}
                >
                  Revert to Draft
                </Button>
                <Button
                  size="xs"
                  leftSection={<IconSend size={14} />}
                  onClick={() => setConfirming(true)}
                  disabled={Boolean(busy)}
                >
                  {drChronoNoteId ? 'Re-send to DrChrono' : 'Submit to DrChrono'}
                </Button>
              </>
            )}
          </Group>

          {BLOCKS.filter((block) => editing || narratives[block.key]).map((block) => (
            <Paper key={block.key} withBorder p="md">
              <Stack gap="xs">
                <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                  {block.label}
                </Text>
                {editing ? (
                  <Textarea
                    aria-label={block.label}
                    value={narratives[block.key]}
                    onChange={(event) => setEdits({ ...narratives, [block.key]: event.currentTarget.value })}
                    autosize
                    minRows={block.single ? 1 : 4}
                    maxRows={16}
                  />
                ) : (
                  // `pre-wrap`, not a paragraph: the text is the DrChrono payload
                  // and its blank lines and indentation are part of it.
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                    {narratives[block.key]}
                  </Text>
                )}
              </Stack>
            </Paper>
          ))}

          {note.sources.length > 0 && (
            <Paper withBorder p="md">
              <Stack gap="xs">
                <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                  Linked Conditions
                </Text>
                <Group gap="xs">
                  {note.sources.map((source) => (
                    <Badge key={source.reference} variant="light" color="gray">
                      {source.label}
                    </Badge>
                  ))}
                </Group>
              </Stack>
            </Paper>
          )}
        </>
      )}

      <Modal opened={confirming} onClose={() => setConfirming(false)} title="Submit to DrChrono" size="lg">
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            This writes the text below to the DrChrono clinical note for this appointment. Review it — it enters the
            patient&apos;s chart in DrChrono exactly as shown.
          </Text>
          {(
            [
              ['Chief Complaint', preview.chief_complaint],
              ['History of Present Illness', preview.history_of_present_illness],
              ['Assessment & Plan', preview.assessment_and_plan],
            ] as const
          ).map(([label, value]) => (
            <Stack key={label} gap={4}>
              <Text size="xs" fw={600} tt="uppercase" c="dimmed">
                {label}
              </Text>
              <Code block style={{ whiteSpace: 'pre-wrap' }}>
                {value || '(empty)'}
              </Code>
            </Stack>
          ))}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              leftSection={<IconSend size={16} />}
              loading={busy === 'push'}
              onClick={() => {
                setConfirming(false);
                push();
              }}
            >
              Confirm &amp; Submit
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
