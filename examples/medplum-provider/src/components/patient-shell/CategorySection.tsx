// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Box, Group, UnstyledButton } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import type { JSX, ReactNode } from 'react';
import { useState } from 'react';
import classes from './PatientShell.module.css';

export interface CategorySectionProps {
  title: ReactNode;
  count: number;
  /** Shown as a green "{n} active" pill when set. */
  activeCount?: number;
  /** Extra header pills. */
  pills?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A Lyfe collapsible group inside a list card: grey header with chevron, title, count and pills.
 * @param props - The section props.
 * @returns The section.
 */
export function CategorySection(props: CategorySectionProps): JSX.Element {
  const { title, count, activeCount, pills, defaultOpen = true, children } = props;
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box component="section" aria-label={typeof title === 'string' ? title : undefined}>
      <UnstyledButton className={classes.category} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Group gap="sm" wrap="nowrap">
          <span className={classes.categoryChevron} data-collapsed={!open || undefined}>
            <IconChevronDown size={14} />
          </span>
          <span className={classes.categoryTitle}>{title}</span>
          <span className={classes.categoryCount}>{count}</span>
          {activeCount !== undefined && activeCount > 0 && (
            <span className={classes.categoryActive}>
              <span className={classes.dot} />
              {activeCount} active
            </span>
          )}
          {pills}
        </Group>
      </UnstyledButton>
      {open && <div className={classes.categoryBody}>{children}</div>}
    </Box>
  );
}
