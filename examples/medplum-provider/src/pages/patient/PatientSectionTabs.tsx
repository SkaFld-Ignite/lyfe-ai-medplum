// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ActionIcon, Anchor, ScrollArea, Tabs, Text } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconActivity,
  IconAlertTriangle,
  IconChecklist,
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFileText,
  IconFlask,
  IconHeart,
  IconHeartbeat,
  IconId,
  IconLayoutDashboard,
  IconLayoutList,
  IconMicroscope,
  IconPill,
  IconPrescription,
  IconShield,
  IconStethoscope,
  IconTimeline,
  IconUserEdit,
} from '@tabler/icons-react';
import type { JSX, MouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import classes from './PatientSectionTabs.module.css';

export interface PatientSectionTab {
  /** Tab id from `PatientPageTabs`, used to pick the icon. */
  id: string;
  label: string;
  /** Path (and optional query) relative to the patient URL. */
  value: string;
  /** Other first path segments that belong to this tab, compared case-insensitively. */
  aliases?: string[];
}

export interface PatientSectionTabsProps {
  /** The patient URL prefix, e.g. `/Patient/123`. */
  baseUrl: string;
  tabs: PatientSectionTab[];
  /**
   * `vertical` is the Lyfe sidebar menu; `horizontal` (the default) is a scrolling bar, used on
   * narrow screens.
   */
  orientation?: 'horizontal' | 'vertical';
}

const TAB_ICONS: Record<string, Icon> = {
  overview: IconLayoutDashboard,
  demographics: IconId,
  conditions: IconHeart,
  vitals: IconActivity,
  allergies: IconAlertTriangle,
  immunizations: IconShield,
  timeline: IconTimeline,
  edit: IconUserEdit,
  encounter: IconStethoscope,
  tasks: IconChecklist,
  meds: IconPill,
  dosespot: IconPrescription,
  scriptsure: IconPrescription,
  labs: IconMicroscope,
  orders: IconFlask,
  documentreference: IconFileText,
  careplan: IconHeartbeat,
  export: IconDownload,
};

/** Share of the visible width scrolled by the arrow buttons. */
const SCROLL_STEP = 0.7;

function tabPath(value: string): string {
  return value.split(/[?#]/)[0].toLowerCase();
}

/**
 * Lyfe-style section navigation for the patient chart: icon + label items with a highlighted
 * active section, as a vertical sidebar menu or a horizontal bar. Tabs link to the same URLs as Medplum's `LinkTabs`; the active tab is the one whose
 * path matches the first URL segment after the patient, falling back to the first tab.
 * @param props - The tabs and the patient URL prefix.
 * @returns The tab bar.
 */
export function PatientSectionTabs(props: PatientSectionTabsProps): JSX.Element {
  const { baseUrl, tabs, orientation = 'horizontal' } = props;
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const segment = pathname.slice(baseUrl.length).split('/').find(Boolean)?.toLowerCase();
  const active =
    tabs.find(
      (t) =>
        segment !== undefined &&
        (tabPath(t.value) === segment || t.aliases?.some((alias) => alias.toLowerCase() === segment))
    ) ?? tabs[0];

  // Which edges have more tabs beyond them; drives the edge fades and arrow buttons.
  const viewportRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  const measure = useCallback(() => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Keep the selected tab fully visible, e.g. after opening Messages from a link.
  const activeValue = active?.value;
  useEffect(() => {
    viewportRef.current?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  }, [activeValue]);

  function scrollBy(direction: 1 | -1): void {
    const el = viewportRef.current;
    el?.scrollBy({ left: direction * el.clientWidth * SCROLL_STEP, behavior: 'smooth' });
  }

  function onChange(value: string | null): void {
    navigate(`${baseUrl}/${value || tabs[0].value}`)?.catch(console.error);
  }

  function onLinkClick(e: MouseEvent): void {
    // Let modified and middle clicks open the tab in a new window; plain clicks go through the tabs.
    if (!(e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) {
      e.preventDefault();
    }
  }

  const renderTabs = (): JSX.Element[] =>
    tabs.map((t) => {
      const TabIcon = TAB_ICONS[t.id] ?? IconLayoutList;
      return (
        <Tabs.Tab
          key={t.value}
          value={t.value}
          className={classes.tab}
          leftSection={<TabIcon size={orientation === 'vertical' ? 16 : 15} stroke={1.8} className={classes.icon} />}
        >
          <Anchor className={classes.link} href={`${baseUrl}/${t.value}`} onClick={onLinkClick}>
            {t.label}
          </Anchor>
        </Tabs.Tab>
      );
    });

  if (orientation === 'vertical') {
    return (
      <nav className={classes.sideNav} aria-label="Patient sections">
        <Text className={classes.sideHeading} aria-hidden>
          Patient Details
        </Text>
        <Tabs
          value={activeValue}
          onChange={onChange}
          variant="unstyled"
          orientation="vertical"
          className={classes.sideTabs}
        >
          <Tabs.List className={classes.sideList} aria-label="Patient details">
            {renderTabs()}
          </Tabs.List>
        </Tabs>
      </nav>
    );
  }

  return (
    <div className={classes.bar}>
      <Text className={classes.heading} aria-hidden>
        Patient Details
      </Text>
      {overflow.start && (
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Scroll tabs left" onClick={() => scrollBy(-1)}>
          <IconChevronLeft size={16} />
        </ActionIcon>
      )}
      <ScrollArea
        type="never"
        viewportRef={viewportRef}
        onScrollPositionChange={measure}
        className={classes.scroll}
        data-fade-start={overflow.start || undefined}
        data-fade-end={overflow.end || undefined}
      >
        <Tabs value={activeValue} onChange={onChange} variant="unstyled">
          <Tabs.List className={classes.list} aria-label="Patient details">
            {renderTabs()}
          </Tabs.List>
        </Tabs>
      </ScrollArea>
      {overflow.end && (
        <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Scroll tabs right" onClick={() => scrollBy(1)}>
          <IconChevronRight size={16} />
        </ActionIcon>
      )}
    </div>
  );
}
