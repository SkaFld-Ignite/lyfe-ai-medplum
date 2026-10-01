// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Button, Text } from '@mantine/core';
import { IconArrowUpRight, IconCalendarPlus } from '@tabler/icons-react';
import type { JSX } from 'react';
import { daysBetween } from '../../utils/patient-overview';
import classes from './PatientOverview.module.css';

function formatDay(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export interface VisitTimelineProps {
  lastVisit?: { date: Date; reason?: string };
  nextVisit?: { date: Date; reason?: string };
  now?: Date;
  onSchedule?: () => void;
}

/**
 * Lyfe "Visit Timeline": the last visit and the next one, with how long ago / how soon.
 * @param props - The visits.
 * @returns The two visit boxes with a connector.
 */
export function VisitTimeline(props: VisitTimelineProps): JSX.Element {
  const { lastVisit, nextVisit, onSchedule } = props;
  const now = props.now ?? new Date();

  const ago = lastVisit ? daysBetween(lastVisit.date, now) : 0;
  const until = nextVisit ? daysBetween(now, nextVisit.date) : 0;
  let nextState: 'none' | 'soon' | 'later' = 'none';
  if (nextVisit) {
    nextState = until <= 7 ? 'soon' : 'later';
  }
  let soon = `In ${until}d`;
  if (until === 0) {
    soon = 'Today';
  } else if (until === 1) {
    soon = 'Tomorrow';
  }

  return (
    <div className={classes.visits}>
      <Box className={classes.visitBox}>
        <Text className={classes.visitEyebrow}>Last Visit</Text>
        {lastVisit ? (
          <>
            <Text className={classes.visitDate}>{formatDay(lastVisit.date)}</Text>
            <Text className={classes.visitMeta}>
              {ago}d ago{lastVisit.reason ? ` · ${lastVisit.reason}` : ''}
            </Text>
          </>
        ) : (
          <Text className={classes.visitMeta}>No visits recorded</Text>
        )}
      </Box>
      <div className={classes.visitConnector} aria-hidden>
        <span className={classes.visitConnectorIcon}>
          <IconArrowUpRight size={12} />
        </span>
      </div>
      <Box className={classes.visitBox} data-next={nextState}>
        <Text className={classes.visitEyebrow}>
          Next Visit {nextVisit && <span className={classes.visitPill}>{soon}</span>}
        </Text>
        {nextVisit ? (
          <>
            <Text className={classes.visitDate}>{formatDay(nextVisit.date)}</Text>
            <Text className={classes.visitMeta}>{nextVisit.reason ?? 'No reason recorded'}</Text>
          </>
        ) : (
          <>
            <Text className={classes.visitMeta}>Not scheduled</Text>
            {onSchedule && (
              <Button
                size="compact-xs"
                variant="default"
                mt={6}
                leftSection={<IconCalendarPlus size={12} />}
                onClick={onSchedule}
              >
                Schedule
              </Button>
            )}
          </>
        )}
      </Box>
    </div>
  );
}
