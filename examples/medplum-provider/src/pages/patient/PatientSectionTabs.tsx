// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, ScrollArea, Tabs, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconChecklist,
  IconDeviceWatch,
  IconDownload,
  IconFileText,
  IconFlask,
  IconHeartbeat,
  IconLayoutList,
  IconMessages,
  IconPill,
  IconPrescription,
  IconStethoscope,
  IconTimeline,
  IconUserEdit,
} from '@tabler/icons-react';
import type { JSX, MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import classes from './PatientSectionTabs.module.css';

export interface PatientSectionTab {
  /** Tab id from `PatientPageTabs`, used to pick the icon. */
  id: string;
  label: string;
  /** Path (and optional query) relative to the patient URL. */
  value: string;
}

export interface PatientSectionTabsProps {
  /** The patient URL prefix, e.g. `/Patient/123`. */
  baseUrl: string;
  tabs: PatientSectionTab[];
}

const TAB_ICONS: Record<string, Icon> = {
  timeline: IconTimeline,
  edit: IconUserEdit,
  encounter: IconStethoscope,
  tasks: IconChecklist,
  meds: IconPill,
  dosespot: IconPrescription,
  scriptsure: IconPrescription,
  orders: IconFlask,
  devices: IconDeviceWatch,
  documentreference: IconFileText,
  careplan: IconHeartbeat,
  message: IconMessages,
  export: IconDownload,
};

function tabPath(value: string): string {
  return value.split(/[?#]/)[0].toLowerCase();
}

/**
 * Lyfe-style section navigation for the patient chart: icon + label pills with a highlighted
 * active tab. Tabs link to the same URLs as Medplum's `LinkTabs`; the active tab is the one whose
 * path matches the first URL segment after the patient, falling back to the first tab.
 * @param props - The tabs and the patient URL prefix.
 * @returns The tab bar.
 */
export function PatientSectionTabs(props: PatientSectionTabsProps): JSX.Element {
  const { baseUrl, tabs } = props;
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const segment = pathname.slice(baseUrl.length).split('/').find(Boolean)?.toLowerCase();
  const active = tabs.find((t) => segment !== undefined && tabPath(t.value) === segment) ?? tabs[0];

  function onChange(value: string | null): void {
    navigate(`${baseUrl}/${value || tabs[0].value}`)?.catch(console.error);
  }

  function onLinkClick(e: MouseEvent): void {
    // Let modified and middle clicks open the tab in a new window; plain clicks go through the tabs.
    if (!(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
    }
  }

  return (
    <div className={classes.bar}>
      <Text className={classes.heading} aria-hidden>
        Patient Details
      </Text>
      <ScrollArea type="scroll" scrollbarSize={4} className={classes.scroll}>
        <Tabs value={active?.value} onChange={onChange} variant="unstyled">
          <Tabs.List className={classes.list} aria-label="Patient details">
            {tabs.map((t) => {
              const TabIcon = TAB_ICONS[t.id] ?? IconLayoutList;
              return (
                <Tabs.Tab
                  key={t.value}
                  value={t.value}
                  className={classes.tab}
                  leftSection={<TabIcon size={15} stroke={1.8} className={classes.icon} />}
                >
                  <Anchor className={classes.link} href={`${baseUrl}/${t.value}`} onClick={onLinkClick}>
                    {t.label}
                  </Anchor>
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </Tabs>
      </ScrollArea>
    </div>
  );
}
