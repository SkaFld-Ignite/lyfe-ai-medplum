// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Patient, ProjectMembership } from '@medplum/fhirtypes';
import { hasDoseSpotIdentifier, hasScriptSureIdentifier } from '../../components/utils';

export function patientPathPrefix(patientId: string): string {
  return `/Patient/${patientId}`;
}

export function prependPatientPath(patient: Patient | undefined, path: string): string {
  if (patient?.id) {
    return `${patientPathPrefix(patient.id)}${!path.startsWith('/') ? '/' : ''}${path}`;
  }

  return path;
}

export function formatPatientPageTabUrl(patientId: string, tab: PatientPageTabInfo): string {
  return `${patientPathPrefix(patientId)}/${tab.url.replace('%patient.id', patientId)}`;
}

export type PatientPageTabInfo = {
  id: string;
  url: string;
  label: string;
  /** Kept routable but left out of the section menu. */
  hidden?: boolean;
  /** Other first path segments that belong to this section, e.g. `edit` for Demographics. */
  aliases?: string[];
};

export function getPatientPageTabOrThrow(tabId: string): PatientPageTabInfo {
  const result = PatientPageTabs.find((tab) => tab.id === tabId);

  if (!result) {
    throw new Error(`Could not find patient page tab with id ${tabId}`);
  }
  return result;
}

/**
 * Returns the patient page tabs filtered based on user permissions.
 * Filters out e-prescribing tabs if the user doesn't have the corresponding integration access.
 *
 * @param membership - The current user's project membership.
 * @param options - Optional overrides for tab visibility checks.
 * @param options.hasDoseSpotAccess - When provided, controls DoseSpot tab visibility directly
 *   (supports self-enrollment via PractitionerRole in addition to existing identifiers).
 *   When omitted, falls back to checking the membership for a DoseSpot identifier.
 * @returns Filtered array of patient page tabs.
 */
export function getPatientPageTabs(
  membership: ProjectMembership | undefined,
  options?: { hasDoseSpotAccess?: boolean }
): PatientPageTabInfo[] {
  const hasDoseSpot = options?.hasDoseSpotAccess ?? hasDoseSpotIdentifier(membership);
  const hasScriptSure = hasScriptSureIdentifier(membership);
  return PatientPageTabs.filter((tab) => {
    if (tab.hidden) {
      return false;
    }
    if (tab.id === 'dosespot') {
      return hasDoseSpot;
    }
    if (tab.id === 'scriptsure') {
      return hasScriptSure;
    }
    return true;
  });
}

// Ordered like the Lyfe patient menu, with Medplum's own sections after the clinical ones.
export const PatientPageTabs: PatientPageTabInfo[] = [
  { id: 'overview', url: 'overview', label: 'Overview' },
  { id: 'demographics', url: 'demographics', label: 'Demographics', aliases: ['edit'] },
  { id: 'timeline', url: '', label: 'Timeline' },
  { id: 'labs', url: 'labs', label: 'Labs' },
  {
    id: 'orders',
    url: 'DiagnosticReport',
    label: 'Orders',
    aliases: ['servicerequest'],
  },
  { id: 'conditions', url: 'conditions', label: 'Conditions', aliases: ['condition'] },
  {
    id: 'meds',
    url: 'MedicationRequest?_fields=medication[x],intent,status&_offset=0&_sort=-_lastUpdated&patient=%patient.id',
    label: 'Medications',
  },
  { id: 'vitals', url: 'vitals', label: 'Vitals' },
  { id: 'allergies', url: 'allergies', label: 'Allergies', aliases: ['allergyintolerance'] },
  { id: 'immunizations', url: 'immunizations', label: 'Immunizations', aliases: ['immunization'] },
  {
    id: 'documentreference',
    url: 'DocumentReference',
    label: 'Documents',
  },
  {
    id: 'encounter',
    url: 'Encounter',
    label: 'Encounters/Notes',
  },
  {
    id: 'tasks',
    url: 'Task',
    label: 'Tasks',
  },
  // Lyfe list; Medplum's records (and its search page) stay at /CarePlan.
  { id: 'careplan', url: 'careplans', label: 'Care Plans', aliases: ['careplan'] },
  { id: 'dosespot', url: 'dosespot', label: 'DoseSpot' },
  { id: 'scriptsure', url: 'scriptsure', label: 'ScriptSure' },
  { id: 'export', url: 'export', label: 'Export' },
  // Medplum's edit form, reached from Demographics ("Edit details").
  { id: 'edit', url: 'edit', label: 'Edit', hidden: true },
];
