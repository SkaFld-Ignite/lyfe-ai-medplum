// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads the patient whose chart is on screen out of the URL. Every patient section is a route
 * under `/Patient/:patientId`, so the path is the whole of the assistant's patient context.
 * `/Patient/new` is the create form, not a chart, so it has no patient to pre-select.
 * @param pathname - The current location pathname.
 * @returns The patient id, or undefined when the route is not a patient chart.
 */
export function patientIdFromPathname(pathname: string): string | undefined {
  const id = /^\/Patient\/([^/]+)/.exec(pathname)?.[1];
  return id && id !== 'new' ? id : undefined;
}
