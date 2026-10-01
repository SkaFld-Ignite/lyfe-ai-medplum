// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';

/**
 * The patient a path belongs to, for `/Patient/<id>` and its sub-pages.
 * @param pathname - The current path.
 * @returns The patient id, or undefined outside a patient chart (including `/Patient/new`).
 */
export function patientIdFromPath(pathname: string): string | undefined {
  const id = /^\/Patient\/([^/?#]+)/.exec(pathname)?.[1];
  return id && id !== 'new' ? id : undefined;
}

/**
 * State for the app's main navigation menu. Opening a patient's chart closes the menu so the
 * chart, which has its own sidebar, gets the full width; the user can reopen it with the toggle.
 * Elsewhere the user's choice stands, starting from the one remembered by the app shell.
 * @param pathname - The current path.
 * @returns Whether the menu is open, and a setter for the user's toggles.
 */
export function useNavbarState(pathname: string): { navbarOpen: boolean; setNavbarOpen: (open: boolean) => void } {
  const patientId = patientIdFromPath(pathname);
  const [navbarOpen, setNavbarOpen] = useState(() => !patientId && localStorage['navbarOpen'] === 'true');
  const [lastPatientId, setLastPatientId] = useState(patientId);

  // Adjust state while rendering when a different patient's chart opens, rather than in an effect,
  // so the chart never paints once with the menu open.
  if (patientId !== lastPatientId) {
    setLastPatientId(patientId);
    if (patientId) {
      setNavbarOpen(false);
    }
  }

  return { navbarOpen, setNavbarOpen };
}
