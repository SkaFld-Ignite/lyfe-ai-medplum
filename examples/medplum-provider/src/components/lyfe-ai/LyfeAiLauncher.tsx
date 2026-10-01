// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Affix, Box, Paper, Text, Transition } from '@mantine/core';
import { getDisplayString } from '@medplum/core';
import type { Communication, Patient, Reference } from '@medplum/fhirtypes';
import { useResource } from '@medplum/react';
import {
  IconChevronDown,
  IconMaximize,
  IconMessageCircle,
  IconMinimize,
  IconPlus,
  IconSparkles,
} from '@tabler/icons-react';
import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { formatPatientPageTabUrl, PatientPageTabs } from '../../pages/patient/PatientPage.utils';
import { SpacesInbox } from '../spaces/SpacesInbox';
import { onSwitchTab } from './citations';
import classes from './LyfeAiLauncher.module.css';
import { patientIdFromPathname } from './patient-route';

/** Starter questions, verbatim from the production Lyfe chat. */
const PATIENT_STARTER_QUESTIONS = [
  'Summarize this patient in 3 sentences',
  'What active conditions and medications does this patient have?',
  'Have they had any recent imaging or procedures?',
  'What were their most recent lab values?',
];

const GLOBAL_STARTER_QUESTIONS = [
  'Show me all my patients for this week',
  'Which patients have the highest comorbid conditions?',
  'Prep me for my next patient',
  'Audit chart for data quality issues',
];

/** Routes that already are the assistant, or where there is nothing to assist with. */
const HIDDEN_PATH_PREFIXES = ['/Spaces/', '/signin', '/register'];

/**
 * Lyfe AI — the floating assistant, mounted once for the whole app.
 *
 * One component in two modes, switched by whether a patient chart is open: with a patient it
 * pre-selects them in the composer (which is all "patient mode" is — `processMessage` already
 * sends a system message for a pre-selected patient) and offers chart-shaped starter questions.
 * Without one it asks about the panel. The chat itself is the same `SpacesInbox` that fills
 * `/Spaces/Communication`, in its `panel` variant.
 * @returns The launcher pill and its panel, or nothing on a route that hides them.
 */
export function LyfeAiLauncher(): JSX.Element | null {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [topic, setTopic] = useState<Communication | undefined>();

  const patientId = patientIdFromPathname(pathname);
  const patientRef = useMemo<Reference<Patient> | undefined>(
    () => (patientId ? { reference: `Patient/${patientId}` } : undefined),
    [patientId]
  );
  const patient = useResource(patientRef);
  const preselectedPatients = useMemo(() => (patientRef ? [patientRef] : []), [patientRef]);

  // A `[meds]`-style citation pill asks for a chart section; take the chart there.
  useEffect(() => {
    return onSwitchTab((tabId) => {
      const tab = PatientPageTabs.find((t) => t.id === tabId);
      if (patientId && tab) {
        navigate(formatPatientPageTabUrl(patientId, tab))?.catch(console.error);
      }
    });
  }, [navigate, patientId]);

  // Escape closes the panel, as it would any dialog.
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const startNewConversation = useCallback((): void => setTopic(undefined), []);

  if (HIDDEN_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return null;
  }

  const isPatientMode = !!patientId;
  const patientName = patient ? getDisplayString(patient) : undefined;

  let subtitle = 'Clinical data at your fingertips';
  if (isPatientMode) {
    subtitle = patientName
      ? `Reads ${patientName}'s chart, meds, labs, docs`
      : "Reads this patient's chart, meds, labs, docs";
  }

  const footerText = isPatientMode
    ? 'AI reads chart, meds, labs, vitals, docs · always verify'
    : 'AI responses are informational only. Always verify clinical data.';

  return (
    <Box className={classes.root}>
      {!open && (
        <Affix position={{ bottom: 24, right: 24 }}>
          <button type="button" className={classes.launcher} onClick={() => setOpen(true)} aria-label="Open Lyfe AI">
            <IconSparkles size={20} stroke={2} />
            <span className={classes.launcherLabel}>Lyfe AI</span>
          </button>
        </Affix>
      )}

      <Affix position={expanded ? { bottom: 16, right: 16 } : { bottom: 24, right: 24 }}>
        <Transition
          mounted={open}
          duration={200}
          timingFunction="ease-out"
          transition={{
            transitionProperty: 'opacity, transform',
            common: { transformOrigin: 'bottom right' },
            in: { opacity: 1, transform: 'translateY(0)' },
            out: { opacity: 0, transform: 'translateY(12px)' },
          }}
        >
          {(style) => (
            <Paper
              withBorder
              shadow="xl"
              className={classes.panel}
              data-expanded={expanded ? 'true' : undefined}
              style={style}
              role="dialog"
              aria-label="Lyfe AI"
            >
              <div className={classes.body}>
                <SpacesInbox
                  /* Switching charts starts the conversation over with the new patient
                     pre-selected, the way the production chat remounts per patient page. */
                  key={patientId ?? 'panel'}
                  variant="panel"
                  topic={topic}
                  onNewTopic={setTopic}
                  /* No URL: the panel has no route of its own, so picking a past conversation
                     loads it inside the panel rather than navigating off the current page. */
                  onSelectedItem={() => ''}
                  onAdd={startNewConversation}
                  preselectedPatients={preselectedPatients}
                  renderHeader={({ toggleSidebar }) => (
                    <div className={classes.header}>
                      <div className={classes.headerIdentity}>
                        <div className={classes.tile}>
                          <IconSparkles size={16} stroke={2} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <Text className={classes.headerTitle} truncate>
                            Lyfe AI
                          </Text>
                          <Text className={classes.headerSubtitle} truncate>
                            {subtitle}
                          </Text>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size={28}
                          onClick={toggleSidebar}
                          aria-label="Conversations"
                        >
                          <IconMessageCircle size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size={28}
                          onClick={startNewConversation}
                          aria-label="New conversation"
                        >
                          <IconPlus size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size={28}
                          onClick={() => setExpanded((v) => !v)}
                          aria-label={expanded ? 'Collapse Lyfe AI' : 'Expand Lyfe AI'}
                        >
                          {expanded ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size={28}
                          onClick={() => setOpen(false)}
                          aria-label="Close Lyfe AI"
                        >
                          <IconChevronDown size={16} />
                        </ActionIcon>
                      </div>
                    </div>
                  )}
                  renderEmptyState={(send) => <LyfeAiEmptyState isPatientMode={isPatientMode} onStarter={send} />}
                />
              </div>
              <div className={classes.footer}>
                <IconMessageCircle size={12} />
                <span>{footerText}</span>
              </div>
            </Paper>
          )}
        </Transition>
      </Affix>
    </Box>
  );
}

function LyfeAiEmptyState({
  isPatientMode,
  onStarter,
}: {
  isPatientMode: boolean;
  onStarter: (question: string) => void;
}): JSX.Element {
  const heading = isPatientMode ? 'Ask anything about this patient' : 'Ask anything about your patients';
  const body = isPatientMode
    ? "I can read this patient's active meds, conditions, allergies, vitals, labs, encounters, and documents. Every claim is cited."
    : 'I can check your schedule, search your patient panel, find patients by condition, and analyze population trends.';
  const starters = isPatientMode ? PATIENT_STARTER_QUESTIONS : GLOBAL_STARTER_QUESTIONS;

  return (
    <div className={classes.emptyState}>
      <div className={classes.orbWrapper}>
        <div className={classes.orb} aria-hidden />
        <div className={classes.bigTile}>
          <IconSparkles size={28} stroke={2} />
        </div>
      </div>
      <div>
        <Text size="sm" fw={600}>
          {heading}
        </Text>
        <Text size="xs" c="dimmed" maw={280} mt={4}>
          {body}
        </Text>
      </div>
      <div className={classes.starters}>
        {starters.map((question) => (
          <button key={question} type="button" className={classes.starter} onClick={() => onStarter(question)}>
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}
