// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { JSX, ReactNode } from 'react';
import type { LyfePageHeaderProps } from './LyfePageHeader';
import { LyfePageHeader } from './LyfePageHeader';
import classes from './LyfeWorkspacePage.module.css';

export interface LyfeWorkspacePageProps extends LyfePageHeaderProps {
  /** The workspace, e.g. a list/detail board. It fills the card below the header. */
  readonly children: ReactNode;
}

/**
 * A full-height Lyfe page for inbox-style workspaces (Messages, Tasks, Faxes): the page header on
 * top, and the workspace in a bordered card that takes the remaining height and scrolls inside.
 * @param props - The header props and the workspace.
 * @returns The page.
 */
export function LyfeWorkspacePage(props: LyfeWorkspacePageProps): JSX.Element {
  const { children, ...header } = props;
  return (
    <div className={classes.page}>
      <LyfePageHeader {...header} />
      <div className={classes.card}>{children}</div>
    </div>
  );
}
